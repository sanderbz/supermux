#!/usr/bin/env python3
"""iCloud Mail — a lean, stdlib-only MCP server (stdio transport).

The first AGENT-AUTHORED supermux connector (connector-store spec §10): iCloud
has no ready-made MCP, so this small server exposes three tools —
`list_inbox` / `read_message` / `send_message` — over IMAP+SMTP:

  * IMAP  imap.mail.me.com:993   (implicit SSL)
  * SMTP  smtp.mail.me.com:587   (STARTTLS)

Auth is an APP-SPECIFIC PASSWORD (appleid.apple.com → Sign-In & Security →
App-Specific Passwords), NOT the Apple ID password. Credentials arrive ONLY as
environment variables the supermux vault injects into this process at launch:

    ICLOUD_EMAIL   the iCloud address (also the IMAP/SMTP username)
    ICLOUD_APP_PW  the app-specific password

They are never passed as arguments, never logged, and never echoed back to the
agent. A missing/blank credential yields a tool error, not a crash.

Transport: MCP stdio — newline-delimited JSON-RPC 2.0. One message per line on
stdin; one JSON object per line on stdout. Nothing but protocol JSON is ever
written to stdout (diagnostics go to stderr), so the framing stays clean.

Dependencies: Python 3 standard library only (imaplib, smtplib, email, ssl,
json, os, sys). No pip install, no network at build time — deliberately lean so
the connector ships as one embedded file.
"""

import email
import email.header
import email.utils
import imaplib
import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage

IMAP_HOST = "imap.mail.me.com"
IMAP_PORT = 993
SMTP_HOST = "smtp.mail.me.com"
SMTP_PORT = 587

SERVER_NAME = "icloud-mail"
SERVER_VERSION = "1.0.0"
DEFAULT_PROTOCOL = "2025-06-18"

# Cap how much of a body we return so a huge message can't blow the transport.
MAX_BODY_CHARS = 20000
# Default / hard cap on how many inbox rows a single list returns.
DEFAULT_LIMIT = 20
MAX_LIMIT = 100


# ── credential access (env only) ──────────────────────────────────────────────
def _credentials():
    """Return (email, app_password) from the vault-injected env, or raise a
    clear ValueError the tool layer turns into an MCP error. The values are read
    fresh per call and never retained beyond it."""
    addr = (os.environ.get("ICLOUD_EMAIL") or "").strip()
    pw = os.environ.get("ICLOUD_APP_PW") or ""
    if not addr:
        raise ValueError(
            "ICLOUD_EMAIL is not set — grant the icloud-mail connector and store "
            "a credential so the vault injects it."
        )
    if not pw:
        raise ValueError(
            "ICLOUD_APP_PW is not set — store an app-specific password (NOT your "
            "Apple ID password) in the connector credential."
        )
    return addr, pw


# ── header helpers ────────────────────────────────────────────────────────────
def _decode_header(raw):
    """Decode a possibly RFC 2047-encoded header into a plain str."""
    if raw is None:
        return ""
    parts = email.header.decode_header(raw)
    out = []
    for text, enc in parts:
        if isinstance(text, bytes):
            try:
                out.append(text.decode(enc or "utf-8", errors="replace"))
            except (LookupError, ValueError):
                out.append(text.decode("utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def _best_body(msg):
    """Extract a readable body: prefer text/plain, fall back to text/html
    stripped to text. Skips attachments. Truncates to MAX_BODY_CHARS."""
    plain = None
    html = None
    if msg.is_multipart():
        for part in msg.walk():
            if part.is_multipart():
                continue
            disp = str(part.get("Content-Disposition") or "")
            if "attachment" in disp.lower():
                continue
            ctype = part.get_content_type()
            if ctype == "text/plain" and plain is None:
                plain = _part_text(part)
            elif ctype == "text/html" and html is None:
                html = _part_text(part)
    else:
        if msg.get_content_type() == "text/html":
            html = _part_text(msg)
        else:
            plain = _part_text(msg)

    body = plain if plain else _strip_html(html or "")
    if len(body) > MAX_BODY_CHARS:
        body = body[:MAX_BODY_CHARS] + "\n… [truncated]"
    return body


def _part_text(part):
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except (LookupError, ValueError):
        return payload.decode("utf-8", errors="replace")


def _strip_html(html):
    """Very small HTML → text: drop tags. Good enough for a readable preview
    without pulling in a parser dependency."""
    out = []
    depth = 0
    for ch in html:
        if ch == "<":
            depth += 1
        elif ch == ">":
            if depth > 0:
                depth -= 1
        elif depth == 0:
            out.append(ch)
    return "".join(out).strip()


# ── tool implementations ──────────────────────────────────────────────────────
def tool_list_inbox(args):
    limit = args.get("limit")
    try:
        limit = int(limit) if limit is not None else DEFAULT_LIMIT
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    limit = max(1, min(limit, MAX_LIMIT))
    mailbox = str(args.get("mailbox") or "INBOX")

    addr, pw = _credentials()
    imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    try:
        imap.login(addr, pw)
        # Read-only select so listing never marks messages seen.
        imap.select(_imap_mailbox(mailbox), readonly=True)
        typ, data = imap.uid("SEARCH", None, "ALL")
        if typ != "OK":
            raise RuntimeError(f"IMAP SEARCH failed: {typ}")
        uids = data[0].split() if data and data[0] else []
        uids = uids[-limit:]
        uids.reverse()  # newest first
        messages = []
        for uid in uids:
            typ, mdata = imap.uid(
                "FETCH",
                uid,
                "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])",
            )
            if typ != "OK" or not mdata or mdata[0] is None:
                continue
            header_bytes = mdata[0][1]
            hmsg = email.message_from_bytes(header_bytes)
            messages.append(
                {
                    "uid": uid.decode("ascii", "replace"),
                    "from": _decode_header(hmsg.get("From")),
                    "subject": _decode_header(hmsg.get("Subject")),
                    "date": _decode_header(hmsg.get("Date")),
                }
            )
        return {
            "mailbox": mailbox,
            "count": len(messages),
            "messages": messages,
        }
    finally:
        _imap_logout(imap)


def tool_read_message(args):
    uid = str(args.get("uid") or "").strip()
    if not uid:
        raise ValueError("read_message requires a 'uid' (from list_inbox).")
    mailbox = str(args.get("mailbox") or "INBOX")

    addr, pw = _credentials()
    imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    try:
        imap.login(addr, pw)
        imap.select(_imap_mailbox(mailbox), readonly=True)
        typ, data = imap.uid("FETCH", uid.encode("ascii"), "(RFC822)")
        if typ != "OK" or not data or data[0] is None:
            raise RuntimeError(f"message uid {uid} not found in {mailbox}")
        raw = data[0][1]
        msg = email.message_from_bytes(raw)
        return {
            "uid": uid,
            "mailbox": mailbox,
            "from": _decode_header(msg.get("From")),
            "to": _decode_header(msg.get("To")),
            "cc": _decode_header(msg.get("Cc")),
            "subject": _decode_header(msg.get("Subject")),
            "date": _decode_header(msg.get("Date")),
            "body": _best_body(msg),
        }
    finally:
        _imap_logout(imap)


def tool_send_message(args):
    to = args.get("to")
    subject = str(args.get("subject") or "")
    body = str(args.get("body") or "")
    cc = args.get("cc")
    if not to:
        raise ValueError("send_message requires 'to' (an address or list).")

    to_list = _addr_list(to)
    cc_list = _addr_list(cc) if cc else []
    if not to_list:
        raise ValueError("send_message 'to' produced no valid recipients.")

    addr, pw = _credentials()
    msg = EmailMessage()
    msg["From"] = addr
    msg["To"] = ", ".join(to_list)
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    msg["Subject"] = subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain=addr.split("@")[-1])
    msg.set_content(body)

    context = ssl.create_default_context()
    smtp = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30)
    try:
        smtp.ehlo()
        smtp.starttls(context=context)
        smtp.ehlo()
        smtp.login(addr, pw)
        smtp.send_message(msg, from_addr=addr, to_addrs=to_list + cc_list)
        return {
            "sent": True,
            "to": to_list,
            "cc": cc_list,
            "subject": subject,
        }
    finally:
        try:
            smtp.quit()
        except Exception:
            pass


def _addr_list(value):
    if isinstance(value, list):
        items = [str(v).strip() for v in value]
    else:
        items = [p.strip() for p in str(value).split(",")]
    return [a for a in items if a]


def _imap_mailbox(name):
    """IMAP mailbox names with spaces/specials must be quoted."""
    if name == "INBOX":
        return name
    return '"' + name.replace('"', '\\"') + '"'


def _imap_logout(imap):
    try:
        imap.logout()
    except Exception:
        pass


TOOLS = [
    {
        "name": "list_inbox",
        "description": "List recent messages in an iCloud mailbox (newest first). "
        "Returns each message's uid, from, subject and date. Read-only — does not "
        "mark anything seen.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": f"How many recent messages to return (1-{MAX_LIMIT}, default {DEFAULT_LIMIT}).",
                },
                "mailbox": {
                    "type": "string",
                    "description": "Mailbox/folder to list (default INBOX).",
                },
            },
        },
    },
    {
        "name": "read_message",
        "description": "Read one iCloud message by its uid (from list_inbox), "
        "returning headers and a plain-text body.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "uid": {"type": "string", "description": "The message uid from list_inbox."},
                "mailbox": {
                    "type": "string",
                    "description": "Mailbox the uid belongs to (default INBOX).",
                },
            },
            "required": ["uid"],
        },
    },
    {
        "name": "send_message",
        "description": "Send an email from the connected iCloud account via SMTP.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {
                    "type": ["string", "array"],
                    "items": {"type": "string"},
                    "description": "Recipient address(es) — a string (comma-separated ok) or a list.",
                },
                "subject": {"type": "string", "description": "Subject line."},
                "body": {"type": "string", "description": "Plain-text message body."},
                "cc": {
                    "type": ["string", "array"],
                    "items": {"type": "string"},
                    "description": "Optional Cc address(es).",
                },
            },
            "required": ["to", "subject", "body"],
        },
    },
]

TOOL_FUNCS = {
    "list_inbox": tool_list_inbox,
    "read_message": tool_read_message,
    "send_message": tool_send_message,
}


# ── JSON-RPC / MCP plumbing ───────────────────────────────────────────────────
def _send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _result(req_id, result):
    _send({"jsonrpc": "2.0", "id": req_id, "result": result})


def _error(req_id, code, message):
    _send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def _handle(msg):
    method = msg.get("method")
    req_id = msg.get("id")
    is_notification = "id" not in msg

    if method == "initialize":
        params = msg.get("params") or {}
        proto = params.get("protocolVersion") or DEFAULT_PROTOCOL
        _result(
            req_id,
            {
                "protocolVersion": proto,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        )
        return
    if method in ("notifications/initialized", "initialized"):
        return  # notification — no response
    if method == "ping":
        _result(req_id, {})
        return
    if method == "tools/list":
        _result(req_id, {"tools": TOOLS})
        return
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        func = TOOL_FUNCS.get(name)
        if func is None:
            _error(req_id, -32602, f"unknown tool: {name}")
            return
        try:
            payload = func(args)
            text = json.dumps(payload, indent=2, ensure_ascii=False)
            _result(req_id, {"content": [{"type": "text", "text": text}]})
        except Exception as exc:  # tool errors are reported, never crash the server
            _result(
                req_id,
                {
                    "content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}],
                    "isError": True,
                },
            )
        return

    if is_notification:
        return
    _error(req_id, -32601, f"method not found: {method}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            _handle(msg)
        except Exception as exc:  # never let a handler bug kill the loop
            sys.stderr.write(f"icloud-mail handler error: {exc}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()

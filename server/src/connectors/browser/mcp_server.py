#!/usr/bin/env python3
"""shared-browser — the agent's half of the Shared Browser connector.

A tiny, credential-free, stdlib-only MCP stdio server. It owns NO browser: the
Rust server does. Every acting tool here is a thin forward to ONE local supermux
endpoint (`POST $SUPERMUX_URL/api/hook/browser/tool`), authenticated with the
pane's own per-session `$SUPERMUX_HOOK_TOKEN` and scoped to `$SUPERMUX_SESSION`.

WHY THE SERVER OWNS THE BROWSER. The AGENT⇄HUMAN drive lock
(`connectors::browser::lock`) is what makes "the human takes the wheel" real: a
human takeover flips the lock, and every agent-initiated CDP call is refused
while it is flipped. If this process drove chrome directly, the lock would be
advisory. Forwarding to the server means the gate is on the ONLY path that
reaches the page — an agent cannot route around it.

WHY THE HOOK TOKEN. It is the same per-session secret the status hook, the
board hook and the `$EDITOR` bridge use: session A's token authenticates ONLY
session A (the server compares it against that session's `session_runtime` row).
So bot A can never drive bot B's browser context, even though both run the same
server binary. The dashboard bearer token is NEVER handed to an agent.

TOOLS
  browser_navigate(url)                    → go there, wait for load, report URL/title
  browser_click(selector | x,y)            → a real CDP mouse click
  browser_read(selector?, max_chars?)      → the page's (or an element's) text
  browser_screenshot()                     → a JPEG of the viewport, as an MCP image
  request_human_takeover(reason, …)        → hand the wheel to the human, and PARK

`request_human_takeover` carries the `anthropic/requiresUserInteraction` marker,
exactly like the store's `connect` tool: Claude routes it to the human instead of
auto-running it, and supermux's PreToolUse detector turns it into the in-chat
"take the wheel" card that opens the takeover panel on the human's phone.

Transport: MCP stdio — newline-delimited JSON-RPC 2.0, one message per line.
Nothing but protocol JSON goes to stdout (diagnostics go to stderr).

Dependencies: Python 3 standard library only (json, os, sys, urllib).
"""

import json
import os
import sys
import urllib.error
import urllib.request

SERVER_NAME = "browser"
SERVER_VERSION = "1.0.0"
DEFAULT_PROTOCOL = "2025-06-18"

# Kept BYTE-IDENTICAL to the Rust constant
# `connectors::REQUIRES_USER_INTERACTION_META` so the host, this server, the
# PreToolUse detector and the web card all agree on the marker.
REQUIRES_USER_INTERACTION_META = "anthropic/requiresUserInteraction"

# The one endpoint every acting tool forwards to. Session-scoped + hook-token
# authenticated on the server side.
TOOL_PATH = "/api/hook/browser/tool"

# A takeover park longer than this is refused up front: the human hand-back wakes
# the parked call the moment it happens, so a long ceiling only matters when
# nobody comes — and then the honest answer is "nobody took the wheel", not an
# hour-long hang.
MAX_PARK_SECONDS = 600
DEFAULT_PARK_SECONDS = 120
# Every non-parking tool: generous enough for a slow page, short enough that a
# wedged call surfaces as an error instead of a hung turn.
ACT_TIMEOUT_SECONDS = 90


def _env(name):
    """Read `name`, treating an UNEXPANDED `${VAR}` placeholder as absent.

    The connector's `mcpServers` entry passes these as `${VAR}` references that
    the host expands from the pane environment. If a host ever fails to expand
    one, we must not send the literal `${...}` as a credential — fall through to
    this process's own inherited environment instead (the MCP server is a child
    of the pane, so the real values are there either way)."""
    v = os.environ.get(name) or ""
    if v.startswith("${") and v.endswith("}"):
        return ""
    return v


def _base_url():
    return (_env("SUPERMUX_URL") or "http://127.0.0.1:8823").rstrip("/")


def _session():
    return _env("SUPERMUX_SESSION")


def _token():
    return _env("SUPERMUX_HOOK_TOKEN")


# ── tool descriptors ─────────────────────────────────────────────────────────
NAVIGATE_TOOL = {
    "name": "browser_navigate",
    "description": (
        "Navigate the shared browser to a URL and wait for it to load. The "
        "browser is a real, persistent Chrome the human can take over at any "
        "time (cookies and logins survive between your turns). Returns the "
        "final URL and page title."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Absolute URL to open."}
        },
        "required": ["url"],
    },
}

CLICK_TOOL = {
    "name": "browser_click",
    "description": (
        "Click in the shared browser: pass a CSS `selector` (preferred — it is "
        "resolved to the element's centre) or explicit viewport `x`/`y` "
        "coordinates. Refused while the human is driving."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector to click."},
            "x": {"type": "number", "description": "Viewport x (CSS px)."},
            "y": {"type": "number", "description": "Viewport y (CSS px)."},
        },
    },
}

READ_TOOL = {
    "name": "browser_read",
    "description": (
        "Read the shared browser's current page as text: the whole body, or one "
        "element's text when `selector` is given. Also returns the URL and "
        "title. Reading is always allowed, even while the human drives."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "selector": {
                "type": "string",
                "description": "CSS selector to read instead of the whole body.",
            },
            "max_chars": {
                "type": "integer",
                "description": "Cap on returned text (default 8000).",
            },
            "html": {
                "type": "boolean",
                "description": "Return outerHTML instead of visible text.",
            },
        },
    },
}

SCREENSHOT_TOOL = {
    "name": "browser_screenshot",
    "description": (
        "Take a screenshot of the shared browser's viewport. Returns a JPEG "
        "image you can look at — use it when the text read is not enough to "
        "tell what is on screen."
    ),
    "inputSchema": {"type": "object", "properties": {}},
}

TAKEOVER_TOOL = {
    "name": "request_human_takeover",
    "description": (
        "Hand the shared browser's wheel to the human and WAIT. Call this the "
        "moment you hit something only a person can do — a login, a 2FA code, a "
        "CAPTCHA, a payment confirmation, a consent screen. The human gets a "
        "card in chat that opens the live browser on their phone; they finish "
        "the step and hand control back, and this call then returns and you "
        "carry on from the page they left you on. NEVER ask for credentials in "
        "chat — ask for the takeover instead."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "description": (
                    "One short sentence the human reads on the card: what you "
                    "need them to do (e.g. 'sign in to bank.example and approve "
                    "the 2FA push')."
                ),
            },
            "timeout_seconds": {
                "type": "integer",
                "description": (
                    "How long to park waiting for the hand-back (default 120, "
                    "max 600). Call again to keep waiting."
                ),
            },
        },
        "required": ["reason"],
    },
    "_meta": {REQUIRES_USER_INTERACTION_META: True},
}

TOOLS = [NAVIGATE_TOOL, CLICK_TOOL, READ_TOOL, SCREENSHOT_TOOL, TAKEOVER_TOOL]


# ── the forward ──────────────────────────────────────────────────────────────
def _post_tool(tool, args, timeout):
    """POST one tool call to supermux. Returns (payload_dict, http_status).

    Never raises: a transport failure comes back as a payload the agent can
    read, because an MCP tool that throws is a dead end for the turn."""
    session = _session()
    token = _token()
    if not session or not token:
        return (
            {
                "ok": False,
                "error": (
                    "the shared browser is not wired into this session "
                    "(SUPERMUX_SESSION / SUPERMUX_HOOK_TOKEN missing)"
                ),
            },
            0,
        )
    body = json.dumps({"session": session, "tool": tool, "args": args}).encode("utf-8")
    req = urllib.request.Request(
        _base_url() + TOOL_PATH,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Supermux-Hook-Token": token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as e:  # 4xx/5xx still carry a JSON body
        raw = e.read().decode("utf-8", "replace") if e.fp else ""
        status = e.code
    except Exception as exc:  # transport / timeout
        return ({"ok": False, "error": f"supermux browser endpoint unreachable: {exc}"}, 0)
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        payload = {"ok": False, "error": f"unreadable response ({status})"}
    if not isinstance(payload, dict):
        payload = {"ok": False, "error": f"unexpected response ({status})"}
    return payload, status


def _text_result(payload):
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2, ensure_ascii=False)}]}


def _error_result(payload):
    out = _text_result(payload)
    out["isError"] = True
    return out


def _call(tool, args, timeout=ACT_TIMEOUT_SECONDS):
    payload, status = _post_tool(tool, args, timeout)
    if status == 409:
        # THE LOCK REFUSAL — expected, not exceptional. Say so in words the
        # agent can act on rather than a stack of HTTP nouns.
        return _error_result(
            {
                "refused": "human_driving",
                "message": payload.get("error")
                or "the human is driving the shared browser right now",
                "hint": (
                    "Wait for them to hand the wheel back, or call "
                    "request_human_takeover(reason=…) to park until they do."
                ),
            }
        )
    if status != 200 or payload.get("ok") is False:
        return _error_result(
            {"error": payload.get("error") or f"browser tool failed ({status})", "tool": tool}
        )
    return payload


def tool_navigate(args):
    url = (args.get("url") or "").strip()
    if not url:
        return _error_result({"error": "browser_navigate needs a `url`"})
    out = _call("navigate", {"url": url})
    return out if "content" in out else _text_result(out.get("result", out))


def tool_click(args):
    selector = (args.get("selector") or "").strip()
    payload = {}
    if selector:
        payload["selector"] = selector
    elif args.get("x") is not None and args.get("y") is not None:
        payload["x"] = args.get("x")
        payload["y"] = args.get("y")
    else:
        return _error_result({"error": "browser_click needs a `selector` or `x`+`y`"})
    out = _call("click", payload)
    return out if "content" in out else _text_result(out.get("result", out))


def tool_read(args):
    payload = {}
    if (args.get("selector") or "").strip():
        payload["selector"] = args["selector"].strip()
    if args.get("max_chars") is not None:
        payload["max_chars"] = args["max_chars"]
    if args.get("html"):
        payload["html"] = True
    out = _call("read", payload)
    return out if "content" in out else _text_result(out.get("result", out))


def tool_screenshot(_args):
    out = _call("screenshot", {})
    if "content" in out:
        return out
    result = out.get("result") or {}
    data = result.get("data") or ""
    if not data:
        return _error_result({"error": "screenshot returned no image data"})
    # An MCP image block — the agent SEES the page, it does not read base64.
    return {
        "content": [
            {"type": "image", "data": data, "mimeType": result.get("mime_type", "image/jpeg")},
            {
                "type": "text",
                "text": json.dumps(
                    {"url": result.get("url"), "bytes": result.get("bytes")},
                    ensure_ascii=False,
                ),
            },
        ]
    }


def tool_takeover(args):
    reason = (args.get("reason") or "").strip()
    if not reason:
        return _error_result(
            {"error": "request_human_takeover needs a one-sentence `reason` for the human"}
        )
    try:
        park = int(args.get("timeout_seconds") or DEFAULT_PARK_SECONDS)
    except (TypeError, ValueError):
        park = DEFAULT_PARK_SECONDS
    park = max(5, min(MAX_PARK_SECONDS, park))
    out = _call(
        "request_human_takeover",
        {"reason": reason, "timeout_seconds": park},
        timeout=park + 15,
    )
    return out if "content" in out else _text_result(out.get("result", out))


HANDLERS = {
    "browser_navigate": tool_navigate,
    "browser_click": tool_click,
    "browser_read": tool_read,
    "browser_screenshot": tool_screenshot,
    "request_human_takeover": tool_takeover,
}


# ── JSON-RPC / MCP plumbing (same shape as the connect + iCloud servers) ──────
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
        return
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
        handler = HANDLERS.get(name)
        if handler is None:
            _error(req_id, -32602, f"unknown tool: {name}")
            return
        _result(req_id, handler(args))
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
            sys.stderr.write(f"shared-browser handler error: {exc}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()

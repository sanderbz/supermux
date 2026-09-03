#!/usr/bin/env python3
"""connect — the store's one-tap credential affordance, as a lean MCP server.

The connector store (spec §8) gives every bot ONE extra tool, `connect(service)`.
When the bot calls it, supermux does NOT run a connection itself: the call is
allow-listed and returns immediately, while supermux's PreToolUse detector
(`sessions::connect_ask`) turns the same call into the inline Connect card in
chat. The human signs in / pastes an API key straight into the card, which POSTs
the credential to the supermux vault — it NEVER travels through this tool, this
process, or the transcript. The agent only ever names WHICH connector it wants;
the secret plane is entirely out of band.

**Why NO `anthropic/requiresUserInteraction` marker here.** That marker overrides
`--permission-mode bypassPermissions` and forces Claude Code's OWN permission
prompt into the TERMINAL — a prompt the chat renderer cannot answer (it only
classifies Bash/Edit/Write permission footers). A bot that called `connect` was
left parked for hours behind an invisible dialog while the chat card above it
said "Added". The card is raised by the PreToolUse detector, which does NOT need
the marker, so dropping it costs nothing and un-parks the bot. The `connect` tool
never grants anything by itself — the GRANT is still a human tap on the card —
so the human remains in the loop without stalling the terminal.
(The Shared Browser's `request_human_takeover` deliberately KEEPS the marker: its
drive-lock relies on the call stalling. See `browser/mcp_server.py`.)

This is the SERVER BINARY the store injects into every bot launch so a real agent
actually HAS a `connect` tool in its toolset (connector-store spec §8 step 2;
round-2 jury, claim 5 — the tool-exposure half). It is deliberately tiny: two
tools, no credentials, no network, stdlib only, so it ships as one embedded file
the way the agent-authored iCloud server does.

The second tool, `list_connectors` (P2d), is the CONCIERGE discovery half: a plain,
NON-interactive read of a secret-free, company-scoped catalog snapshot the launch
path drops next to this server (`python3 <server.py> <catalog.json>` → the snapshot
path arrives as `sys.argv[1]`). The bot calls it to learn WHICH connector id it
wants and HOW that connector signs in, explains it in plain language, and only
THEN calls `connect(<id>)` to raise the card.

Transport: MCP stdio — newline-delimited JSON-RPC 2.0. One message per line on
stdin; one JSON object per line on stdout. Nothing but protocol JSON is written
to stdout (diagnostics go to stderr), so the framing stays clean.

Dependencies: Python 3 standard library only (json, os, sys).
"""

import json
import os
import sys

SERVER_NAME = "connect"
SERVER_VERSION = "1.0.0"
DEFAULT_PROTOCOL = "2025-06-18"

# The interactive tool. Its shape mirrors `connect_tool_descriptor` in
# server/src/connectors/mod.rs: name `connect`, one required `service` string
# argument (the connector id), and — deliberately — NO `_meta`. The detector
# (`sessions::connect_ask::parse`) keys on exactly that pair (a tool whose name
# ends in `connect` AND a non-empty `service` argument), so the chat card is
# raised without an `anthropic/requiresUserInteraction` marker parking the bot
# behind Claude Code's own terminal prompt (see the module docstring).
CONNECT_TOOL = {
    "name": "connect",
    "description": (
        "Connect an external service so its tools become available to you. FIRST "
        "call `list_connectors` to find the right connector `id` and how it signs "
        "in, and explain it to the human in plain language. Then call `connect` "
        "with that id as `service` (e.g. 'pmcp-github', 'pmcp-notion', "
        "'icloud-mail'). This ASKS the human to approve it in a secure sign-in / "
        "API-key card; the credential is stored in the supermux vault and is NEVER "
        "shown to you. It returns immediately and does NOT wait for them — keep "
        "working. Once they approve, the connector's own tools (mcp__<service>__*) "
        "appear after the bot's next restart — retry your task then, and confirm it "
        "works. If nothing appears, say so in your reply rather than assuming. "
        "NOT every entry is card-connectable: an entry marked `builtin` (the "
        "Shared Browser, the company group chat) is granted by a different human "
        "act and this tool will tell you which — relay THAT, and never tell the "
        "human a card was sent unless the answer says `card_sent: true`."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "service": {
                "type": "string",
                "description": "The connector id to connect (from list_connectors).",
            }
        },
        "required": ["service"],
    },
    # NO `_meta`: see the module docstring. The marker would force Claude Code's
    # own terminal permission prompt, which the chat renderer cannot answer.
}

# P2d — the discovery half. A plain read that returns the injected, secret-free
# catalog snapshot: which connectors exist and HOW each one signs in. It raises no
# card at all (the detector only keys on `connect`).
LIST_TOOL = {
    "name": "list_connectors",
    "description": (
        "List the external services (connectors) you can connect for the human, and "
        "HOW each one signs in. Call this FIRST whenever the user wants their bot to "
        "use an outside service (email, GitHub, Slack, a database, …): find the right "
        "connector `id` and its sign-in method, explain it in plain language (there is "
        "a one-time app setup only where noted), THEN call connect(<id>) to show the "
        "sign-in card, and confirm it works afterwards. Each entry carries id, name, "
        "what it does, tool_count, auth_kind, ease, and a one-line how_to. Honest by "
        "lane: mcp_oauth signs in right in the bot's terminal (nothing to paste); "
        "oauth_device uses a short device code approved in a browser; api_key/form "
        "means paste a key/DSN (with a get-it link); none needs no sign-in. Read-only "
        "— this does NOT sign anything in or ask the human anything."
    ),
    "inputSchema": {"type": "object", "properties": {}},
}

TOOLS = [CONNECT_TOOL, LIST_TOOL]

# The honest fallback when no snapshot was injected (or it can't be read).
NO_CATALOG_NOTE = "No connector catalog was provided to this bot."


def _catalog():
    """The injected snapshot's `connectors` array, or [] on any miss."""
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            snap = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(snap, dict):
        return []
    entries = snap.get("connectors", [])
    return entries if isinstance(entries, list) else []


def _list_connectors_text():
    """Return the injected catalog snapshot's `connectors` array as pretty JSON.

    The snapshot path is `sys.argv[1]` (the launch runs `python3 <server.py>
    <catalog.json>`). It is read at CALL time (small file; picks up a snapshot
    written slightly after spawn). Any miss — no argv, missing file, bad JSON, an
    OSError — degrades to an empty list with a note and NEVER raises; the snapshot
    is secret-free, so nothing sensitive is ever surfaced here."""
    connectors = _catalog()
    if not connectors:
        return json.dumps(
            {"connectors": [], "note": NO_CATALOG_NOTE}, indent=2, ensure_ascii=False
        )
    return json.dumps({"connectors": connectors}, indent=2, ensure_ascii=False)


def _connect_result(service):
    """The tool's own return value — and it must never claim more than it did.

    Three answers, because there are three truths:

    * **no id** — nothing was asked of anyone;
    * **a BUILTIN id** (`shared-browser`, `group-chat`) — there is no credential
      to collect and therefore no card to raise. supermux marks these in the
      injected snapshot with `builtin: true` and a `connect_note` naming the act
      that DOES grant them (for the browser: the human lending a tab). Returning
      the optimistic card text here is what made a bot announce "I've sent you a
      connect card" for the Shared Browser while nothing ever rendered — the bug
      this branch exists to kill. Say the truth the server wrote instead;
    * **an ordinary id** — supermux was asked to raise the card. Even here we
      claim the ASK and not the outcome: nothing in this process can observe
      whether the human sees it or taps it.

    An id that is in no snapshot at all is not claimed as a card either: it is
    almost certainly a guess, and the honest answer is to go and look.
    No credential is ever touched here."""
    service = (service or "").strip()
    if not service:
        return {
            "connected": False,
            "message": (
                "No `service` given. Call connect with the connector id you want, "
                "e.g. connect(service='pmcp-notion')."
            ),
        }
    catalog = _catalog()
    entry = None
    for c in catalog:
        if isinstance(c, dict) and c.get("id") == service:
            entry = c
            break
    if entry is not None and entry.get("builtin"):
        return {
            "connected": False,
            "service": service,
            "card_sent": False,
            "message": entry.get("connect_note")
            or (
                f"'{service}' is built in to supermux and is not connected with a "
                "card. Ask the human how they want to grant it — do not tell them "
                "a card was sent, because none was."
            ),
        }
    if entry is None and catalog:
        known = ", ".join(
            str(c.get("id")) for c in catalog[:8] if isinstance(c, dict) and c.get("id")
        )
        return {
            "connected": False,
            "service": service,
            "card_sent": False,
            "message": (
                f"There is no connector called '{service}', so NO card was sent. "
                "Call list_connectors and use an id from it — do not tell the "
                f"human to approve a card. Some ids you do have: {known}."
            ),
        }
    return {
        "connected": False,
        "service": service,
        "card_sent": True,
        "message": (
            f"supermux has asked the human to approve '{service}' in a secure "
            "connect card. Nothing is connected yet, and this call did NOT wait "
            "for them: carry on with what you can do meanwhile. The credential "
            "goes straight to the supermux vault and is never shown to you. If "
            f"'{service}' tools (mcp__{service}__*) have not appeared after a "
            "while, say so plainly in your reply instead of assuming it worked."
        ),
    }


# ── JSON-RPC / MCP plumbing (same shape as the iCloud server) ─────────────────
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
        if name == "connect":
            payload = _connect_result(args.get("service"))
            text = json.dumps(payload, indent=2, ensure_ascii=False)
            _result(req_id, {"content": [{"type": "text", "text": text}]})
            return
        if name == "list_connectors":
            # A plain read: return the injected snapshot, never route to the human.
            _result(req_id, {"content": [{"type": "text", "text": _list_connectors_text()}]})
            return
        _error(req_id, -32602, f"unknown tool: {name}")
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
            sys.stderr.write(f"connect handler error: {exc}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()

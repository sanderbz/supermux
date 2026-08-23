#!/usr/bin/env python3
"""connect — the store's one-tap credential affordance, as a lean MCP server.

The connector store (spec §8) gives every bot ONE extra tool, `connect(service)`.
When the bot calls it, supermux does NOT run a connection itself: the tool's
descriptor carries the `anthropic/requiresUserInteraction` marker, so Claude Code
always routes the call to the human prompt instead of auto-running it, and
supermux's PreToolUse detector (`sessions::connect_ask`) turns that into the
inline Connect card. The human signs in / pastes an API key straight into the
card, which POSTs the credential to the supermux vault — it NEVER travels through
this tool, this process, or the transcript. The agent only ever names WHICH
connector it wants; the secret plane is entirely out of band.

This is the SERVER BINARY the store injects into every bot launch so a real agent
actually HAS a `connect` tool in its toolset (connector-store spec §8 step 2;
round-2 jury, claim 5 — the tool-exposure half). It is deliberately tiny: two
tools, no credentials, no network, stdlib only, so it ships as one embedded file
the way the agent-authored iCloud server does.

The second tool, `list_connectors` (P2d), is the CONCIERGE discovery half: a plain,
NON-interactive read of a secret-free, company-scoped catalog snapshot the launch
path drops next to this server (`python3 <server.py> <catalog.json>` → the snapshot
path arrives as `sys.argv[1]`). It carries NO `requiresUserInteraction` marker, so
it never routes to the human — the bot calls it to learn WHICH connector id it wants
and HOW that connector signs in, explains it in plain language, and only THEN calls
the interactive `connect(<id>)`.

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

# The `_meta` key that forces a tool to the human-in-the-loop prompt even when an
# allow-rule matches (Claude Code >= 2.1.199). Kept BYTE-IDENTICAL to the Rust
# constant `connectors::REQUIRES_USER_INTERACTION_META` so the future host, this
# server, the detector, and the web card all agree on the marker.
REQUIRES_USER_INTERACTION_META = "anthropic/requiresUserInteraction"

# The single tool. Its shape mirrors `connect_tool_descriptor` in
# server/src/connectors/mod.rs: name `connect`, one required `service` string
# argument (the connector id), and the interaction marker in `_meta`. The
# detector (`sessions::connect_ask::parse`) keys on exactly this pair — a tool
# whose name ends in `connect` AND a non-empty `service` argument.
CONNECT_TOOL = {
    "name": "connect",
    "description": (
        "Connect an external service so its tools become available to you. FIRST "
        "call `list_connectors` to find the right connector `id` and how it signs "
        "in, and explain it to the human in plain language. Then call `connect` "
        "with that id as `service` (e.g. 'pmcp-github', 'pmcp-notion', "
        "'icloud-mail'). This opens a secure sign-in / API-key card for the human: "
        "the credential is stored in the supermux vault and is NEVER shown to you. "
        "After they finish, the connector's own tools (mcp__<service>__*) appear on "
        "your next turn — retry your task then, and confirm it works."
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
    "_meta": {REQUIRES_USER_INTERACTION_META: True},
}

# P2d — the discovery half. A plain, NON-interactive read (NO interaction marker,
# so it never routes to the human) that returns the injected, secret-free catalog
# snapshot: which connectors exist and HOW each one signs in.
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
    # NO _meta: this is a normal read, never routed to the human.
}

TOOLS = [CONNECT_TOOL, LIST_TOOL]

# The honest fallback when no snapshot was injected (or it can't be read).
NO_CATALOG_NOTE = "No connector catalog was provided to this bot."


def _list_connectors_text():
    """Return the injected catalog snapshot's `connectors` array as pretty JSON.

    The snapshot path is `sys.argv[1]` (the launch runs `python3 <server.py>
    <catalog.json>`). It is read at CALL time (small file; picks up a snapshot
    written slightly after spawn). Any miss — no argv, missing file, bad JSON, an
    OSError — degrades to an empty list with a note and NEVER raises; the snapshot
    is secret-free, so nothing sensitive is ever surfaced here."""
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        return json.dumps(
            {"connectors": [], "note": NO_CATALOG_NOTE}, indent=2, ensure_ascii=False
        )
    try:
        with open(path, "r", encoding="utf-8") as f:
            snap = json.load(f)
        connectors = snap.get("connectors", []) if isinstance(snap, dict) else []
        return json.dumps({"connectors": connectors}, indent=2, ensure_ascii=False)
    except (OSError, ValueError):
        return json.dumps(
            {"connectors": [], "note": NO_CATALOG_NOTE}, indent=2, ensure_ascii=False
        )


def _connect_result(service):
    """The tool's own return value.

    In the normal flow the call is intercepted BEFORE it runs: the interaction
    marker stops the turn for the human, and supermux raises the inline Connect
    card. If Claude Code does run the tool (a host without the interaction gate,
    or the human approved it), this is the honest fallback: name what happened
    and tell the agent how to proceed. No credential is ever touched here."""
    service = (service or "").strip()
    if not service:
        return {
            "connected": False,
            "message": (
                "No `service` given. Call connect with the connector id you want, "
                "e.g. connect(service='pmcp-notion')."
            ),
        }
    return {
        "connected": False,
        "service": service,
        "message": (
            f"A secure connect card for '{service}' was shown to the human. The "
            "credential goes straight to the supermux vault and is never shown to "
            f"you. Once they complete it, '{service}' tools (mcp__{service}__*) "
            "become available — retry your task on your next turn."
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

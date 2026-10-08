#!/usr/bin/env python3
"""shared-browser — the agent's half of the Shared Browser connector.

A tiny, credential-free, stdlib-only MCP stdio server. It owns NO browser: the
Rust server owns the legacy browser; connected-tab tools relay to the human’s
extension through its active site-scoped lease. Every tool forwards to ONE local supermux
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

`request_human_takeover` carries the `anthropic/requiresUserInteraction` marker —
the ONLY supermux tool that still does. Claude parks the call instead of
auto-running it, and supermux's PreToolUse detector turns it into the in-chat
"take the wheel" card that opens the takeover panel on the human's phone. The
stall is the point: while the human drives, the agent must not act on the page.
The store's `connect` tool dropped the marker for exactly the opposite reason —
it has nothing to wait for, so parking it only hid the bot behind a terminal
dialog the chat renderer cannot answer.

Transport: MCP stdio — newline-delimited JSON-RPC 2.0, one message per line.
Nothing but protocol JSON goes to stdout (diagnostics go to stderr).

Dependencies: Python 3 standard library only (json, os, sys, urllib).
"""

import json
import os
import queue
import sys
import threading
import uuid
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
            "url": {"type": "string", "description": "Absolute URL to open."},
            "tab": {
                "type": "string",
                "description": (
                    "Optional. A shared tab id from browser_list_tabs (tb_...). "
                    "Omit to use your OWN throwaway browser. Given, this acts on "
                    "the human's already-signed-in tab — which requires that they "
                    "granted you that specific tab."
                ),
            },
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
            "tab": {
                "type": "string",
                "description": (
                    "Optional. A shared tab id from browser_list_tabs (tb_...). "
                    "Omit to use your OWN throwaway browser. Given, this acts on "
                    "the human's already-signed-in tab — which requires that they "
                    "granted you that specific tab."
                ),
            },
        },
    },
}

READ_TOOL = {
    "name": "browser_read",
    "description": (
        "Read the shared browser's current page as text: the whole body, or one "
        "element's text when `selector` is given. Also returns the URL and "
        "title. Reading is NOT free: it is refused while the human is driving "
        "(their login form is not yours to read), and on a shared tab it is "
        "refused if the page has drifted to a host outside that tab's allowlist."
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
            "tab": {
                "type": "string",
                "description": (
                    "Optional. A shared tab id from browser_list_tabs (tb_...). "
                    "Omit to use your OWN throwaway browser. Given, this acts on "
                    "the human's already-signed-in tab — which requires that they "
                    "granted you that specific tab."
                ),
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
    "inputSchema": {
        "type": "object",
        "properties": {
            "tab": {
                "type": "string",
                "description": (
                    "Optional. A shared tab id from browser_list_tabs (tb_...). "
                    "Omit to use your OWN throwaway browser. Given, this acts on "
                    "the human's already-signed-in tab — which requires that they "
                    "granted you that specific tab."
                ),
            },
        },
    },
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
            "tab": {
                "type": "string",
                "description": (
                    "Optional. A shared tab id from browser_list_tabs (tb_...). "
                    "Omit to use your OWN throwaway browser. Given, this acts on "
                    "the human's already-signed-in tab — which requires that they "
                    "granted you that specific tab."
                ),
            },
        },
        "required": ["reason"],
    },
    # KEEP the marker here — this is the one tool that WANTS to stall. The drive
    # lock hands the page to the human, and the agent must not act on it until they
    # hand it back; the parked call IS the lock. (The store's `connect` tool
    # deliberately dropped the marker: it has nothing to wait for, and the terminal
    # dialog the marker forces is one the chat renderer cannot answer, so it parked
    # bots for hours. Here the human is already being sent to the takeover panel.)
    "_meta": {REQUIRES_USER_INTERACTION_META: True},
}

LIST_TABS_TOOL = {
    "name": "browser_list_tabs",
    "description": (
        "List the human's shared browser tabs you are allowed to use. CALL THIS "
        "FIRST. Each entry has a `tab` id to pass to the other tools, the page "
        "title and URL, whether it is still signed in (`login_state`), and when "
        "that was last verified. An empty list means you have not been granted "
        "any shared tab — use your own browser instead (omit `tab`), or ask the "
        "human to lend you one. A tab whose `login_state` is `needs_login` will "
        "refuse your calls until the human signs in again; report that, do not "
        "try to log in yourself."
    ),
    "inputSchema": {"type": "object", "properties": {}},
}

CONNECTED_TABS_TOOL = {
    "name": "browser_connected_tabs",
    "description": "List this agent's human-enabled Chrome extension tabs. Use the returned target for browser_actions.",
    "inputSchema": {"type": "object", "properties": {}},
}
ACTIONS_TOOL = {
    "name": "browser_actions",
    "description": "Run up to 32 sequential actions in a connected Chrome tab. Snapshot returns compact element refs; screenshots only when requested. Never replay a batch with an unknown outcome.",
    "inputSchema": {
        "type": "object", "properties": {
            "target": {"type":"string", "description":"Opaque activation target from browser_connected_tabs."},
            "timeout_ms": {"type":"integer", "minimum":1, "maximum":30000},
            "steps": {"type":"array", "minItems":1, "maxItems":32, "items": {
                "type":"object", "properties": {
                    "action": {"type":"string", "enum":["snapshot","click","type","fill","key","scroll","navigate","back","reload","wait","evaluate","screenshot","dialog"]},
                    "ref":{"type":"string"}, "frame":{"type":"string"}, "button":{"type":"string","enum":["left","middle","right"]}, "click_count":{"type":"integer","minimum":1,"maximum":2}, "text":{"type":"string","maxLength":16384}, "clear":{"type":"boolean"},
                    "key":{"type":"string"}, "modifiers":{"type":"array","items":{"type":"string"}},
                    "x":{"type":"number"}, "y":{"type":"number"}, "url":{"type":"string"},
                    "expression":{"type":"string","maxLength":16384}, "accept":{"type":"boolean"}, "prompt_text":{"type":"string","maxLength":16384},
                    "selector":{"type":"string"}, "state":{"type":"string","enum":["visible","hidden","ready"]},
                    "timeout_ms":{"type":"integer"},
                }, "required":["action"],
            }},
        }, "required":["target","steps"],
    },
}

TOOLS = [
    CONNECTED_TABS_TOOL,
    ACTIONS_TOOL,
    LIST_TABS_TOOL,
    NAVIGATE_TOOL,
    CLICK_TOOL,
    READ_TOOL,
    SCREENSHOT_TOOL,
    TAKEOVER_TOOL,
]


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
        message = f"supermux browser endpoint unreachable: {exc}"
        if tool == "actions":
            message += "; the batch outcome may be unknown: inspect the page before trying again"
        return ({"ok": False, "error": message, "outcome_unknown": tool == "actions"}, 0)
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


def _tab_arg(args):
    """The optional shared-tab id, forwarded verbatim.

    Validation and — crucially — the per-tab GRANT check happen server-side, in
    `tools.rs`, before the call reaches a page. This script is a forwarder; it
    must never be the thing that decides what an agent may touch."""
    tab = (args.get("tab") or "").strip()
    return {"tab": tab} if tab else {}


def _control_call(tool, args):
    payload, status = _post_tool(tool, args, 35)
    if status != 200 or payload.get("ok") is False:
        return _error_result({"error":payload.get("error") or f"browser control failed ({status})", "tool":tool})
    return payload


def tool_connected_tabs(_args):
    out = _control_call("extension_list", {})
    return out if "content" in out else _text_result(out.get("result", out))


def tool_actions(args):
    out = _control_call("actions", args)
    if "content" in out:
        return out
    result = out.get("result", out)
    images = []
    for step in result.get("results", []):
        if isinstance(step, dict) and step.get("mime") == "image/png" and "data_base64" in step:
            images.append({"type":"image", "mimeType":"image/png", "data":step.pop("data_base64")})
    answer = {"content":[{"type":"text", "text":json.dumps(result, ensure_ascii=False, separators=(",", ":"))}] + images}
    if result.get("ok") is False:
        answer["isError"] = True
    return answer


def tool_list_tabs(_args):
    out = _call("list_tabs", {})
    return out if "content" in out else _text_result(out.get("result", out))


def tool_navigate(args):
    url = (args.get("url") or "").strip()
    if not url:
        return _error_result({"error": "browser_navigate needs a `url`"})
    out = _call("navigate", {"url": url, **_tab_arg(args)})
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
    payload.update(_tab_arg(args))
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
    payload.update(_tab_arg(args))
    out = _call("read", payload)
    return out if "content" in out else _text_result(out.get("result", out))


def tool_screenshot(args):
    out = _call("screenshot", _tab_arg(args))
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
        {"reason": reason, "timeout_seconds": park, **_tab_arg(args)},
        timeout=park + 15,
    )
    return out if "content" in out else _text_result(out.get("result", out))


HANDLERS = {
    "browser_list_tabs": tool_list_tabs,
    "browser_connected_tabs": tool_connected_tabs,
    "browser_actions": tool_actions,
    "browser_navigate": tool_navigate,
    "browser_click": tool_click,
    "browser_read": tool_read,
    "browser_screenshot": tool_screenshot,
    "request_human_takeover": tool_takeover,
}


# ── JSON-RPC / MCP plumbing (same shape as the connect + iCloud servers) ──────
_OUTPUT_LOCK = threading.Lock()
_CONTROL_LOCK = threading.Lock()
_CONTROL_CALLS = {}
_LEGACY_CALLS = queue.Queue(maxsize=16)


def _send(msg):
    with _OUTPUT_LOCK:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def _legacy_worker():
    # Keep legacy tool execution sequential while the protocol reader stays
    # available for extension cancellation during a parked human takeover.
    while True:
        req_id, name, args = _LEGACY_CALLS.get()
        try:
            _result(req_id, HANDLERS[name](args))
        except Exception as exc:
            _error(req_id, -32603, str(exc))
        finally:
            _LEGACY_CALLS.task_done()


def _start_control(req_id, name, args):
    wire = dict(args)
    if name == "browser_actions":
        wire["request_id"] = "mcp_" + uuid.uuid4().hex
    call = {"name":name, "args": wire, "cancelled": False}
    with _CONTROL_LOCK:
        if req_id in _CONTROL_CALLS or len(_CONTROL_CALLS) >= 8:
            _error(req_id, -32602, "Too many pending browser calls or duplicate request id")
            return
        _CONTROL_CALLS[req_id] = call
    def worker():
        try:
            _result(req_id, HANDLERS[name](wire))
        except Exception as exc:
            _error(req_id, -32603, str(exc))
        finally:
            with _CONTROL_LOCK:
                if _CONTROL_CALLS.get(req_id) is call:
                    _CONTROL_CALLS.pop(req_id, None)
    threading.Thread(target=worker, daemon=True).start()


def _cancel_actions(req_id):
    with _CONTROL_LOCK:
        call = _CONTROL_CALLS.get(req_id)
        if not call or call["name"] != "browser_actions" or call["cancelled"]:
            return
        call["cancelled"] = True
        args = {key:call["args"].get(key) for key in ("target", "request_id")}
    threading.Thread(target=lambda: _post_tool("cancel_actions", args, 5), daemon=True).start()


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
    if method == "notifications/cancelled":
        _cancel_actions((msg.get("params") or {}).get("requestId"))
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
        handler = HANDLERS.get(name) if any(tool["name"] == name for tool in TOOLS) else None
        if handler is None:
            _error(req_id, -32602, f"unknown tool: {name}")
            return
        if name in ("browser_actions", "browser_connected_tabs"):
            _start_control(req_id, name, args)
        else:
            try:
                _LEGACY_CALLS.put_nowait((req_id, name, args))
            except queue.Full:
                _error(req_id, -32602, "Too many queued browser calls")
        return

    if is_notification:
        return
    _error(req_id, -32601, f"method not found: {method}")


def main():
    threading.Thread(target=_legacy_worker, daemon=True).start()
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
    if "--control-only" in sys.argv[1:]:
        TOOLS = [tool for tool in TOOLS if tool["name"] in ("browser_connected_tabs", "browser_actions")]
    main()

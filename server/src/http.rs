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

use crate::auth;
use crate::board;
use crate::files;
use crate::public;
use crate::sessions;
use crate::state::AppState;

/// Build the application router from `state`.
pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(protected_router(state.clone()))
        // PUBLIC (no auth): `/api/health` plus the board iCal feed (§2.7).
        .merge(board::public_router_for(state.clone()))
        .merge(public::router_for(state))
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
        .layer(from_fn_with_state(state, auth::auth_middleware))
}

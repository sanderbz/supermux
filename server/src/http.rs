//! HTTP router registry.
//!
//! **Router-registry pattern** (TECH_PLAN §3.4). The top-level [`router`] is
//! composed from per-module `router_for(state) -> Router` functions. Each
//! backend milestone (M2 sessions, M6 board, M7 files, M8 scheduler, M9 agents)
//! adds exactly ONE module file and ONE `.merge(<module>::router_for(...))` line
//! here — so the "parallel" backend milestones never produce a 3-way merge
//! conflict on this file.
//!
//! M0 ships only the registry skeleton plus a hello-world root route. The
//! commented `.merge(...)` lines below are the insertion points; uncomment one
//! per milestone as each module lands. The auth middleware + public router
//! split (per §3.4) is wired in M1.

use axum::{routing::get, Router};

/// Build the application router.
///
/// In M1+ this takes `state: AppState` and threads it through each
/// `router_for(state.clone())`. For the M0 bootstrap there is no state yet.
pub fn router() -> Router {
    Router::new()
        .route("/", get(root))
    // ── backend milestones merge their sub-routers here ──
    // M2:  .merge(sessions::router_for(state.clone()))
    // M6:  .merge(board::router_for(state.clone()))
    // M7:  .merge(files::router_for(state.clone()))
    // M8:  .merge(scheduler::router_for(state.clone()))
    // M9:  .merge(agents::router_for(state.clone()))
    // M1:  .layer(auth::middleware(state.clone()))
    // M1:  .merge(public::router_for(state))   // manifest, sw, icons, /api/health — no auth
}

async fn root() -> &'static str {
    "amux v3"
}

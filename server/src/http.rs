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
//! NOT wrapped by it.

use axum::extract::State;
use axum::middleware::from_fn_with_state;
use axum::routing::get;
use axum::{Json, Router};

use crate::db;
use crate::error::AppError;
use crate::files;
use crate::public;
use crate::state::AppState;
use crate::{auth, db::sessions::Session};

/// Build the application router from `state`.
pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(protected_router(state.clone()))
        .merge(public::router_for(state))
}

/// All bearer-token-protected routes.
///
/// Backend milestones merge their sub-routers here before the `.layer(...)`:
/// ```ignore
/// .merge(sessions::router_for(state.clone()))   // M2
/// .merge(board::router_for(state.clone()))      // M6
/// .merge(files::router_for())                   // M7 (no build-time state)
/// .merge(scheduler::router_for(state.clone()))  // M8
/// .merge(agents::router_for(state.clone()))     // M9
/// ```
fn protected_router(state: AppState) -> Router {
    Router::new()
        // M1 ships a minimal `/api/sessions` so the auth layer is exercisable
        // end-to-end. M2 replaces this with `sessions::router_for(state)`.
        .route("/api/sessions", get(list_sessions))
        .merge(files::router_for()) // M7
        .layer(from_fn_with_state(state.clone(), auth::auth_middleware))
        .with_state(state)
}

/// `GET /api/sessions` — active sessions. Returns `[]` when none exist.
async fn list_sessions(State(state): State<AppState>) -> Result<Json<Vec<Session>>, AppError> {
    let sessions = db::sessions::list(&state.pool).await?;
    Ok(Json(sessions))
}

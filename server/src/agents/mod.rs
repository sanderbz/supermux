//! Agent-orchestration primitives (TECH_PLAN §3.7; M5b establishes the wait
//! primitive, M9 extends this module with delegate/skills/slash-commands).
//!
//! **Router-registry pattern (§3.4).** [`router_for`] returns this module's
//! sub-router; `http::router` merges it into the bearer-protected router. M9 adds
//! its routes here additively — no shared edits.

pub mod wait;

use axum::routing::get;
use axum::Router;

use crate::state::AppState;

/// Build the agents sub-router (bearer-protected; the layer is applied by
/// `http::router`).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/agents/{name}/wait", get(wait::wait))
        .with_state(state)
}

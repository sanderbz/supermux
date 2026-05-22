//! Agent-orchestration primitives (TECH_PLAN §3.7, §3.4; M5b establishes the
//! wait primitive, M9 adds delegate/skills/slash-commands).
//!
//! **Router-registry pattern (§3.4).** [`router_for`] returns this module's
//! sub-router; `http::router` merges it into the bearer-protected router. M9 adds
//! its routes here additively — no shared edits.

pub mod delegate;
pub mod skills;
pub mod wait;

use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

/// Build the agents sub-router (bearer-protected; the layer is applied by
/// `http::router`).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/agents/{name}/wait", get(wait::wait))
        // M9: cross-session delegation (§5.7) + the orchestration graph.
        .route("/api/agents/delegate", post(delegate::delegate))
        .route("/api/agents/delegations", get(delegate::delegations))
        // M9: skills CRUD + the merged slash-command list (§5.2–§5.4).
        .route("/api/skills", get(skills::list))
        .route(
            "/api/skills/{name}",
            get(skills::get).post(skills::upsert).delete(skills::delete),
        )
        .route("/api/slash-commands", get(skills::slash_commands))
        .with_state(state)
}

//! Agent-orchestration primitives: the wait primitive plus
//! delegate/skills/slash-commands.
//!
//! **Router-registry pattern.** [`router_for`] returns this module's
//! sub-router; `http::router` merges it into the bearer-protected router. New
//! routes are added here additively — no shared edits.

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
        // Cross-session delegation + the orchestration graph.
        .route("/api/agents/delegate", post(delegate::delegate))
        .route("/api/agents/delegations", get(delegate::delegations))
        // Skills CRUD + the merged slash-command list.
        .route("/api/skills", get(skills::list))
        .route(
            "/api/skills/{name}",
            get(skills::get).post(skills::upsert).delete(skills::delete),
        )
        .route("/api/slash-commands", get(skills::slash_commands))
        .with_state(state)
}

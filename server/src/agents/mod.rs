//! Agent-orchestration primitives: the wait primitive plus
//! delegate/skills/slash-commands.
//!
//! **Router-registry pattern.** [`router_for`] returns this module's
//! sub-router; `http::router` merges it into the bearer-protected router. New
//! routes are added here additively — no shared edits.

pub mod briefing;
pub mod delegate;
pub mod hook;
pub mod skills;
pub mod wait;

use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

/// The bot→app hook sub-router (`/api/hook/notify`, `/api/hook/delegate`) — NO
/// bearer layer; auth is the per-session `X-Supermux-Hook-Token`. Merged at the
/// top level of `http::router` beside the board + scheduler hook routers.
pub fn hook_router_for(state: AppState) -> Router {
    hook::router_for(state)
}

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

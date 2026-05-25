//! Claude Code **Agent Teams** detection (AT-B §3.2–§3.4).
//!
//! A LEAD Claude session spawns N TEAMMATE sessions as tmux split-panes inside
//! the lead's window on supermux's process-pinned socket. Claude Code writes the
//! team's truth to disk under `~/.claude` (`teams/<team>/config.json`,
//! `tasks/<team>/NN.json`, `teams/<team>/inboxes/<member>.json`) REGARDLESS of
//! supermux. Teammate panes are NOT supermux-created → they have no hook token /
//! DB row, so their status CANNOT come from supermux hooks (they'd 401) — it is
//! derived entirely from those files (§3.3/§3.4).
//!
//! This module:
//!   * [`model`] — the on-disk schema + the supermux [`Team`]/[`Member`]/
//!     [`TeamTask`] DTO (the SSE + `GET /api/teams` wire shape).
//!   * [`scan`] — the pure file→`Team` parser (+ `%id` validation helper).
//!   * [`watcher`] — the background loop: FS-watch + slow safety poll, `%id`
//!     re-validation each tick, lead→supermux mapping, SSE broadcast.
//!   * [`router_for`] — `GET /api/teams` for the initial load.

pub mod model;
pub mod scan;
pub mod watcher;

pub use model::{Member, MemberStatus, Team, TeamTask};
pub use watcher::{scan_and_enrich, spawn};

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::db;
use crate::error::AppError;
use crate::state::{AppState, SseEvent};

/// The teams sub-router (bearer-protected by `http::router`'s layer).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/teams", get(list_teams))
        // The single global experimental gate (§3.1). GET reads the current
        // value; PUT flips it. Default OFF (experimental + ~7× token cost).
        .route(
            "/api/settings/experimental/agent-teams",
            get(get_agent_teams).put(put_agent_teams),
        )
        .with_state(state)
}

/// `GET /api/teams` — the current detected-teams snapshot for the initial load
/// (the SSE `teams` event keeps it live thereafter). Same shape as the SSE
/// payload's `teams` array, wrapped in the dashboard's `{ ok, data }` envelope.
///
/// Performs a fresh scan + live `%id` validation so a hard reload never serves a
/// stale cached snapshot. Defensive: a scan that hits a malformed file skips
/// only that team (never errors the request).
async fn list_teams(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    let teams = scan_and_enrich(&state).await;
    Ok(Json(json!({ "ok": true, "data": teams })))
}

/// `PUT /api/settings/experimental/agent-teams` body — `{ "enabled": bool }`.
#[derive(Debug, Deserialize)]
struct AgentTeamsToggle {
    enabled: bool,
}

/// `GET /api/settings/experimental/agent-teams` — `{ ok, data: { enabled } }`.
/// Reads the persisted [`db::prefs::AGENT_TEAMS_PREF_KEY`] (default OFF).
async fn get_agent_teams(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let enabled = db::prefs::agent_teams_enabled(&state.pool).await;
    Ok(Json(json!({ "ok": true, "data": { "enabled": enabled } })))
}

/// `PUT /api/settings/experimental/agent-teams` — persist the global toggle.
/// Takes effect on the NEXT session start (the env var + `teammateMode` are
/// injected at launch; already-running sessions are unaffected). Broadcasts an
/// SSE `settings` event so other tabs reconcile live (no poll).
async fn put_agent_teams(
    State(state): State<AppState>,
    Json(input): Json<AgentTeamsToggle>,
) -> Result<Json<serde_json::Value>, AppError> {
    db::prefs::set_agent_teams_enabled(&state.pool, input.enabled).await?;
    let _ = state.sse_tx.send(SseEvent {
        event: "settings".to_string(),
        payload: json!({ "key": db::prefs::AGENT_TEAMS_PREF_KEY, "enabled": input.enabled }),
    });
    Ok(Json(json!({ "ok": true, "data": { "enabled": input.enabled } })))
}

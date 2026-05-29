//! Claude Code **Agent Teams** detection.
//!
//! A LEAD Claude session spawns N TEAMMATE sessions as tmux split-panes inside
//! the lead's window on supermux's process-pinned socket. Claude Code writes the
//! team's truth to disk under `~/.claude` (`teams/<team>/config.json`,
//! `tasks/<team>/NN.json`, `teams/<team>/inboxes/<member>.json`) REGARDLESS of
//! supermux. Teammate panes are NOT supermux-created → they have no hook token /
//! DB row, so their status CANNOT come from supermux hooks (they'd 401) — it is
//! derived entirely from those files.
//!
//! This module:
//!   * [`model`] — the on-disk schema + the supermux [`Team`]/[`Member`]/
//!     [`TeamTask`] DTO (the SSE + `GET /api/teams` wire shape).
//!   * [`scan`] — the pure file→`Team` parser (+ `%id` validation helper).
//!   * [`watcher`] — the background loop: FS-watch + slow safety poll, `%id`
//!     re-validation each tick, lead→supermux mapping, SSE broadcast.
//!   * [`router_for`] — `GET /api/teams` for the initial load.

pub mod board_sync;
pub mod model;
pub mod scan;
pub mod start;
pub mod watcher;

pub use model::{Member, MemberStatus, Team, TeamTask};
pub use start::{
    convert_to_team, start_team, ConvertToTeamInput, StartTeamInput, StartTeamResult,
};
pub use watcher::{scan_and_enrich, spawn};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
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
        // "Start a team": create + boot a Claude LEAD with Agent Teams
        // enabled for it + a seed prompt that forms the team. DISTINCT path from
        // `GET /api/teams` (the detected-teams list) so the two never collide.
        .route("/api/teams/start", post(start_team_handler))
        // Convert an EXISTING session into a team lead in
        // place. Distinct path from `/api/teams/start` so each endpoint has one
        // unambiguous contract (start = new lead row; convert = reuse a row).
        .route(
            "/api/teams/start-from-existing",
            post(convert_to_team_handler),
        )
        // The single global experimental gate. GET reads the current
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

/// `POST /api/teams/start` — create + boot a Claude LEAD session with
/// Agent Teams enabled for it and a seed prompt that instructs the lead to form a
/// team of N teammates working on the given goal. Returns 201 with the LEAD
/// `SessionView` so the UI can navigate to `/focus/<name>`; the TEAM CARD then
/// appears via detection once the lead has spawned its panes.
///
/// Body: `{ task, teammates?, model?, dir?, name? }` (see [`start::StartTeamInput`]).
/// `task` (the goal) is required; everything else is optional + defensively
/// clamped/sanitized in [`start::start_team`].
async fn start_team_handler(
    State(state): State<AppState>,
    Json(input): Json<start::StartTeamInput>,
) -> Result<impl IntoResponse, AppError> {
    let result = start::start_team(&state, input).await?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "data": result }))))
}

/// `POST /api/teams/start-from-existing` — turn the
/// EXISTING session named in the body into a team lead in place. Returns 201
/// with the LEAD `SessionView` (the same supermux name; conversation context is
/// fresh because the env+settings only take effect at process launch).
///
/// Body: `{ name, task, teammates?, model? }` (see [`start::ConvertToTeamInput`]).
/// `name` + `task` are required; everything else is optional + clamped. The
/// existing row's `dir` is authoritative — the body intentionally has no
/// `dir` field so the user can't accidentally move the session.
///
/// Errors:
///   * 404 — `name` does not exist.
///   * 409 — the session is already a team lead / archived.
///   * 400 — bad name / empty task / non-Claude provider.
async fn convert_to_team_handler(
    State(state): State<AppState>,
    Json(input): Json<start::ConvertToTeamInput>,
) -> Result<impl IntoResponse, AppError> {
    let result = start::convert_to_team(&state, input).await?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "data": result }))))
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

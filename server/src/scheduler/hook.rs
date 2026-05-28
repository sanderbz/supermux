//! Agent→scheduler hook endpoint (the agent-confirmed-finish tier).
//!
//! The reverse edge for schedules, mirroring `crate::board::hook`: a `tmux`
//! schedule created with `confirm_finish` injects a footer (see
//! `runner::confirm_footer`) teaching the agent to POST here when its scheduled
//! work is genuinely done. That makes completion AGENT-DECLARED — the only party
//! that truly knows the task is finished — rather than inferred from idle.
//!
//! **Auth (identical to the status + board hooks).** The request presents
//! `X-Supermux-Hook-Token`, constant-time compared against the session's stored
//! `session_runtime.hook_token`. A leaked dashboard bearer can't drive this (not
//! checked); session A's token can't authenticate as session B.
//!
//! **Scope rule.** Authentication proves *which session* you are; the schedule
//! you may complete is then constrained to one whose `session` equals the
//! authenticated session. So an agent can only confirm a schedule that targets
//! its own pane — never someone else's. Completion is idempotent with the watch
//! loop via the shared fire-guard in `watch` (no double `done_action`).

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db;
use crate::error::AppError;
use crate::state::AppState;

use super::watch;

/// Header the agent sets to its per-session `$SUPERMUX_HOOK_TOKEN`.
const HOOK_TOKEN_HEADER: &str = "X-Supermux-Hook-Token";

/// The agent→scheduler hook sub-router. Merged at the top level of `http::router`
/// (NO bearer layer — auth is the per-session hook token, validated per handler).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/hook/schedule/done", post(done_handler))
        .with_state(state)
}

/// Constant-time validate the presented hook token against `session`'s stored
/// token. 401 on any mismatch / missing row. Mirrors `board::hook::authenticate`.
async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    session: &str,
) -> Result<(), AppError> {
    let expected = db::sessions::runtime(&state.pool, session)
        .await?
        .map(|rt| rt.hook_token)
        .ok_or(AppError::Unauthorized)?;
    let presented = headers
        .get(HOOK_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if expected.is_empty()
        || !constant_time_eq::constant_time_eq(expected.as_bytes(), presented.as_bytes())
    {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct DoneBody {
    session: String,
    schedule_id: String,
}

/// `POST /api/hook/schedule/done` — the agent declares its scheduled task done.
/// Authenticates the session, scopes to a schedule the session actually targets,
/// then fires the schedule's `done_action` (deduped with the watch loop).
async fn done_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<DoneBody>,
) -> Result<Json<Value>, AppError> {
    authenticate(&state, &headers, &body.session).await?;

    let sched = db::schedules::get(&state.pool, &body.schedule_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("schedule '{}'", body.schedule_id)))?;

    // Scope: an agent may only confirm a schedule that targets its own session.
    // Mismatch is Unauthorized (not NotFound) — the schedule exists, the caller
    // simply isn't its owner.
    if sched.session != body.session {
        return Err(AppError::Unauthorized);
    }

    watch::confirm_done(&state, &sched).await;

    let _ = db::audit::log(
        &state.pool,
        &format!("agent:{}", body.session),
        "schedule.agent_confirmed",
        &sched.id,
        json!({ "session": body.session }),
    )
    .await;

    Ok(Json(json!({ "ok": true, "schedule": sched.id, "status": "done" })))
}

//! Claude `SettingsHook` ingestion endpoint (TECH_PLAN §3.6, §6.5; M5b).
//!
//! `POST /api/_internal/hook` is the inbound side of the status detector's apex
//! signal: Claude Code runs amux's `curl` hook (installed by
//! [`crate::claude_config`]) on every tool call / notification / turn end, and it
//! lands here. A valid event is recorded into [`AppState::record_hook`] and the
//! session's detector loop is woken so the status update surfaces well within the
//! §3.6 "1s" bound.
//!
//! **Auth model (§6.5) — per-session, NOT the dashboard bearer.** This route is
//! mounted OUTSIDE the bearer-token layer because the hook command never carries
//! the dashboard bearer (it must not be in the session env). Instead each request
//! presents `X-Amux-Hook-Token`, validated by a **constant-time** compare against
//! `session_runtime.hook_token WHERE name = body.session`. Consequences:
//!   * A leaked dashboard bearer cannot drive this endpoint (it isn't checked).
//!   * A leaked hook token of session A cannot mark session B — B's row holds a
//!     different token, so the compare fails → 401 (regression: `hook_auth_scope`).

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db;
use crate::error::AppError;
use crate::sessions::status::HookEvent;
use crate::state::AppState;

/// Header the hook command sets to its per-session `$AMUX_HOOK_TOKEN`.
const HOOK_TOKEN_HEADER: &str = "X-Amux-Hook-Token";

/// The hook sub-router. Merged at the top level of `http::router` (NO bearer
/// layer — auth is the per-session hook token, validated in [`hook_handler`]).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/_internal/hook", post(hook_handler))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct HookBody {
    /// The amux session name (`$AMUX_SESSION`); scopes the token check.
    session: String,
    /// The Claude event kind (`pre_tool` | `post_tool` | `notification` | `stop`
    /// | `subagent_stop`).
    event: String,
}

/// Ingest one hook event. 401 on any auth failure; 200 even for an unknown event
/// kind (a no-op) so a future Claude event type never trips a tool call.
async fn hook_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<HookBody>,
) -> Result<Json<Value>, AppError> {
    // The expected token is the session's own (DB is the source of truth, §6.5;
    // survives restart). A missing session row → 401 (no existence oracle).
    let expected = db::sessions::runtime(&state.pool, &body.session)
        .await?
        .map(|rt| rt.hook_token)
        .ok_or(AppError::Unauthorized)?;

    let presented = headers
        .get(HOOK_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // Empty stored token (session never started → no secret minted) can never be
    // authenticated; and the compare is constant-time (§6.5, no timing oracle).
    if expected.is_empty()
        || !constant_time_eq::constant_time_eq(expected.as_bytes(), presented.as_bytes())
    {
        return Err(AppError::Unauthorized);
    }

    // Authenticated. An unrecognised event is ignored (200) rather than 400.
    let Some(event) = HookEvent::from_event_str(&body.event) else {
        return Ok(Json(json!({ "ok": true, "ignored": true })));
    };

    state.record_hook(&body.session, event);
    // Re-tick the detector now so the status (e.g. Notification → waiting) is
    // broadcast within ~1s, not at the next 2s edge (§3.6).
    state.wake_detector(&body.session);

    Ok(Json(json!({ "ok": true })))
}

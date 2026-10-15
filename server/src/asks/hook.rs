//! `POST /api/_internal/ask` — the decision hook's long-poll.
//!
//! Claude Code runs supermux's `PermissionRequest` (and `Elicitation`) hook
//! command with the event's JSON on stdin; the command streams that JSON here
//! (`--data-binary @-`, so nothing is size-capped or shell-quoted) and prints
//! whatever this endpoint answers. The endpoint:
//!
//! 1. authenticates the per-session hook token (same rule as
//!    `/api/_internal/hook`: session A's token only authenticates A);
//! 2. ingests the event exactly like the observe-only hook does (status, live
//!    activity, notifications) — this hook REPLACES the observe-only entry for
//!    these events, so nothing the old one did is lost;
//! 3. opens (or finds) the ask and waits, up to the configured hold, for an API
//!    answer, a release (the ask closed some other way) or the client hanging
//!    up (Claude killed the hook because it cancelled the request).
//!
//! The answer is the response body, verbatim: a `hookSpecificOutput` decision,
//! or an EMPTY body for "no decision" — which Claude Code treats as "the hook
//! has nothing to say", leaving the terminal dialog exactly as it was. That is
//! the safety property: the body is non-empty only when a bearer-authenticated
//! client explicitly answered this ask through `POST /api/asks/{id}/answer`.
//!
//! The session name and pane ride as headers (`X-Supermux-Session`,
//! `X-Supermux-Pane`) and the event + retry counter as query params, because
//! the body IS Claude's payload.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde::Deserialize;
use serde_json::Value;

use super::{Detach, Outcome};
use crate::error::AppError;
use crate::state::AppState;

const SESSION_HEADER: &str = "X-Supermux-Session";
const PANE_HEADER: &str = "X-Supermux-Pane";

/// Claude's payload for a Write/Edit carries the whole file; allow it.
const BODY_LIMIT: usize = 16 * 1024 * 1024;

pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/_internal/ask", post(decide_handler))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct DecideQuery {
    /// The event token (`permission_request` / `elicitation`).
    event: String,
    /// 0 on the first try; >0 when the hook reconnects after the server went
    /// away (restart) or the connection dropped.
    #[serde(default)]
    attempt: u32,
}

/// Which events may wait for a decision, and for how long.
fn hold_for(state: &AppState, event: &str) -> Duration {
    let cfg = &state.asks.config;
    let secs = match event {
        "permission_request" | "PermissionRequest" => cfg.hold_secs,
        "elicitation" | "Elicitation" => cfg.elicitation_hold_secs,
        _ => 0,
    };
    Duration::from_secs(secs)
}

fn no_decision() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        "",
    )
        .into_response()
}

/// Detaches the waiter if the handler future is dropped before it finished —
/// which is what happens when the hook's connection closes mid-wait.
struct DetachGuard {
    state: AppState,
    session: String,
    id: String,
    gen: u64,
    why: Option<Detach>,
}

impl Drop for DetachGuard {
    fn drop(&mut self) {
        if let Some(why) = self.why {
            let state = self.state.clone();
            let session = std::mem::take(&mut self.session);
            let id = std::mem::take(&mut self.id);
            let gen = self.gen;
            tokio::spawn(async move { super::detach(&state, &session, &id, gen, why).await });
        }
    }
}

async fn decide_handler(
    State(state): State<AppState>,
    Query(q): Query<DecideQuery>,
    headers: HeaderMap,
    raw: Bytes,
) -> Result<Response, AppError> {
    let session = headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest(format!("{SESSION_HEADER} header is required")))?
        .to_string();
    crate::hooks::verify_hook_token(&state, &session, &headers).await?;
    let pane = headers
        .get(PANE_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // Lenient, like the observe hook: an unparseable payload still records the
    // event (status) and simply cannot be decided.
    let payload: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    if q.attempt > 0 {
        tracing::debug!(session = %session, event = %q.event, attempt = q.attempt, "decision hook reconnected");
    }

    let ask_id = crate::hooks::ingest(&state, &session, &pane, &q.event, payload.clone()).await;
    let hold = hold_for(&state, &q.event);
    let Some(id) = ask_id.filter(|_| !hold.is_zero()) else {
        return Ok(no_decision());
    };
    let Some((gen, rx)) = super::attach(&state, &session, &id, Arc::new(payload)).await else {
        return Ok(no_decision());
    };
    let mut guard = DetachGuard {
        state: state.clone(),
        session,
        id,
        gen,
        why: Some(Detach::Gone),
    };
    tokio::select! {
        outcome = rx => {
            // Answered or released: the sender already removed the waiter.
            guard.why = None;
            match outcome {
                Ok(Outcome::Decision(v)) => Ok((
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/json")],
                    v.to_string(),
                ).into_response()),
                Ok(Outcome::Release) | Err(_) => Ok(no_decision()),
            }
        }
        _ = tokio::time::sleep(hold) => {
            // The hold lapsed: the dialog stays the terminal's alone.
            guard.why = Some(Detach::Expired);
            Ok(no_decision())
        }
    }
}

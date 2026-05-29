//! The `wait` primitive.
//!
//! `GET /api/agents/{name}/wait?state=<s>&timeout=<secs>` long-polls until the
//! session reaches the requested status, or the timeout elapses:
//! `{ "reached": true, "status": "idle" }` / `{ "reached": false, "status": "active" }`.
//!
//! **Race-free by construction.** v1 used `Notify::notified()`, which
//! drops a transition that fires between reading the current status and
//! registering the waiter. v2 uses the per-session
//! [`watch::Sender`](tokio::sync::watch) seeded by the detector: we
//! `subscribe()` FIRST, then read the persisted baseline. Because the detector
//! writes the DB status *before* `send_replace` (see `auto_actions::tick`), a
//! waiter that subscribes late still observes the latest committed status as its
//! baseline, and one that subscribes early is woken by `changed()`. Either path
//! covers every interleaving — no transition is lost. Regression: `wait_race`.

use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::db;
use crate::error::AppError;
use crate::state::AppState;

/// Max long-poll a single request may hold — capped to fit under
/// Tailscale's 300s idle-connection kill.
const MAX_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Deserialize)]
pub struct WaitQuery {
    /// Target status: `active` | `waiting` | `idle` | `stopped`, or `done` (an
    /// alias for `idle` — matches the `supermux wait … --state done` CLI form).
    pub state: String,
    /// Long-poll seconds (default + cap 300).
    pub timeout: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct WaitResult {
    /// Did the session reach the requested status before the deadline?
    pub reached: bool,
    /// The session's status at return time.
    pub status: String,
}

/// Long-poll for `name` to reach `q.state`.
pub async fn wait(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<WaitQuery>,
) -> Result<Json<WaitResult>, AppError> {
    if !db::sessions::exists(&state.pool, &name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let want = parse_want(&q.state)?;
    let timeout = Duration::from_secs(q.timeout.unwrap_or(MAX_TIMEOUT_SECS).min(MAX_TIMEOUT_SECS));
    let deadline = tokio::time::Instant::now() + timeout;

    // Subscribe BEFORE the baseline read so nothing slips through the gap.
    let mut rx = state.status_watch_for(&name).subscribe();

    let baseline = current_status(&state, &name).await?;
    if baseline == want {
        return Ok(Json(WaitResult { reached: true, status: baseline }));
    }

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(Json(timed_out(&state, &name).await));
        }
        tokio::select! {
            changed = rx.changed() => {
                if changed.is_err() {
                    // Sender dropped (session deleted mid-wait): report not reached.
                    return Ok(Json(timed_out(&state, &name).await));
                }
                // `borrow_and_update` marks this value seen so `changed()` only
                // fires again on the NEXT transition.
                let status = rx.borrow_and_update().0.clone();
                if normalize(&status) == want {
                    return Ok(Json(WaitResult { reached: true, status: normalize(&status) }));
                }
            }
            _ = tokio::time::sleep(remaining) => {
                return Ok(Json(timed_out(&state, &name).await));
            }
        }
    }
}

/// Build the not-reached result, reading the freshest persisted status.
async fn timed_out(state: &AppState, name: &str) -> WaitResult {
    let status = current_status(state, name)
        .await
        .unwrap_or_else(|_| "stopped".to_string());
    WaitResult { reached: false, status }
}

/// Canonicalise the requested target status, accepting the `done`→`idle` alias.
fn parse_want(s: &str) -> Result<String, AppError> {
    let canonical = match s.trim().to_ascii_lowercase().as_str() {
        "done" | "idle" => "idle",
        "active" => "active",
        "waiting" => "waiting",
        "stopped" => "stopped",
        other => {
            return Err(AppError::BadRequest(format!(
                "invalid wait state '{other}' (want active|waiting|idle|stopped|done)"
            )))
        }
    };
    Ok(canonical.to_string())
}

/// The session's persisted status, mapped onto the API union (`unknown`→`stopped`,
/// matching `SessionView`).
async fn current_status(state: &AppState, name: &str) -> Result<String, AppError> {
    let raw = db::sessions::runtime(&state.pool, name)
        .await?
        .map(|rt| rt.last_status)
        .unwrap_or_else(|| "unknown".to_string());
    Ok(normalize(&raw))
}

/// Map a stored status onto the client union (an undetected `unknown` reads as
/// `stopped`, as in `sessions::view`). `starting` passes through verbatim so a
/// long-polling caller observing the BOOTING window sees the real state — it's
/// just not a valid target for `?state=` (boot is a one-way transient).
fn normalize(status: &str) -> String {
    match status {
        "active" | "waiting" | "idle" | "stopped" | "starting" => status.to_string(),
        _ => "stopped".to_string(),
    }
}

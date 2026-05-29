//! Cross-session delegation.
//!
//! `POST /api/agents/delegate {from, to, prompt}` lets one agent hand work to
//! another: it sends `prompt` to the `to` session via the same lifecycle path a
//! human `send` uses, then records a delegation edge so the UI can draw the
//! orchestration graph (`GET /api/agents/delegations?session=X`).
//!
//! **Audit.** A delegation is a side-effecting cross-session action, so it
//! writes an `audit_log` row with `actor=agent:<from>, action=session.delegate,
//! target=<to>`. The prompt text is NOT logged (it is application content, kept
//! out of the audit detail per the secret-hygiene rule).

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db;
use crate::db::runtime_state::Delegation;
use crate::error::AppError;
use crate::sessions::lifecycle;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct DelegateInput {
    /// The delegating session (graph source). Must exist.
    pub from: String,
    /// The receiving session (graph target). Must exist; receives the prompt.
    pub to: String,
    /// The prompt text sent to `to` (same path as a human `send`).
    pub prompt: String,
}

/// `POST /api/agents/delegate` — send `prompt` to `to`, record the edge.
pub async fn delegate(
    State(state): State<AppState>,
    Json(input): Json<DelegateInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let from = input.from.trim();
    let to = input.to.trim();
    if from.is_empty() || to.is_empty() {
        return Err(AppError::BadRequest("both 'from' and 'to' are required".into()));
    }
    if input.prompt.trim().is_empty() {
        return Err(AppError::BadRequest("'prompt' is required".into()));
    }
    if !db::sessions::exists(&state.pool, from).await? {
        return Err(AppError::NotFound(format!("session '{from}'")));
    }
    // `send_text` would also 404 a missing `to`, but check first so we never
    // record a half-valid edge (the FK would reject it anyway).
    if !db::sessions::exists(&state.pool, to).await? {
        return Err(AppError::NotFound(format!("session '{to}'")));
    }

    // Deliver the prompt (auto-wakes a stopped target).
    lifecycle::send_text(&state, to, &input.prompt).await?;

    // Record the edge for the graph view (indices idx_delegations_from/to).
    let id = db::audit::record_delegation(&state.pool, from, to, &input.prompt).await?;

    // Audit the cross-session action (prompt body intentionally omitted).
    db::audit::log(
        &state.pool,
        &format!("agent:{from}"),
        "session.delegate",
        to,
        json!({ "from": from }),
    )
    .await?;

    Ok(Json(json!({ "ok": true, "id": id })))
}

#[derive(Debug, Deserialize)]
pub struct DelegationsQuery {
    /// The session whose in/out edges to return.
    pub session: String,
}

/// One end of the delegation graph for a session.
#[derive(Debug, Serialize)]
pub struct DelegationsView {
    /// Edges this session created (it delegated to others).
    pub outgoing: Vec<Delegation>,
    /// Edges pointing at this session (others delegated to it).
    pub incoming: Vec<Delegation>,
}

/// `GET /api/agents/delegations?session=X` — the graph edges in/out of `X`.
pub async fn delegations(
    State(state): State<AppState>,
    Query(q): Query<DelegationsQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = q.session.trim();
    if session.is_empty() {
        return Err(AppError::BadRequest("'session' query param is required".into()));
    }
    let outgoing = db::audit::delegations_out(&state.pool, session).await?;
    let incoming = db::audit::delegations_in(&state.pool, session).await?;
    Ok(Json(json!({
        "ok": true,
        "data": DelegationsView { outgoing, incoming },
    })))
}

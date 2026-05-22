//! Audit-log read endpoint (TECH_PLAN §3.4, §6.4; M9).
//!
//! `GET /api/audit?limit=N` returns the most-recent audit rows for the Settings
//! audit viewer (§4 settings reference). Auth required — it is mounted under the
//! bearer layer (audit history is operator-only). The write side lives in
//! [`crate::db::audit`] and is called from every destructive handler.
//!
//! **Router-registry pattern (§3.4).** [`router_for`] returns this module's
//! sub-router; `http::router` merges it under the bearer layer additively.

use axum::extract::{Query, State};
use axum::Json;
use axum::Router;
use serde::Deserialize;
use serde_json::json;

use crate::db;
use crate::error::AppError;
use crate::state::AppState;

/// Default + maximum rows returned (a sane cap so a stray `limit=1e9` can't OOM
/// the response).
const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 1000;

/// Build the audit sub-router (no auth layer — applied by `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::get;
    Router::new()
        .route("/api/audit", get(audit_list))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct AuditQuery {
    #[serde(default)]
    limit: Option<i64>,
}

/// `GET /api/audit?limit=N` — last N audit rows, newest first (§3.4).
async fn audit_list(
    State(state): State<AppState>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let rows = db::audit::list(&state.pool, limit).await?;
    Ok(Json(json!({ "ok": true, "data": rows })))
}

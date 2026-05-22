//! Public (no-auth) routes (TECH_PLAN §3.4, §6.1).
//!
//! Mounted OUTSIDE the auth layer. M1 ships `/api/health` only; the PWA assets
//! (manifest, service worker, icons, base HTML) join here in the
//! frontend-embedding milestone.

use std::time::Instant;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use once_cell::sync::Lazy;
use serde_json::json;

use crate::state::AppState;

static START: Lazy<Instant> = Lazy::new(Instant::now);

/// Build the public sub-router (no auth middleware).
pub fn router_for(state: AppState) -> Router {
    Router::new().route("/api/health", get(health)).with_state(state)
}

/// `GET /api/health` — `{version, uptime_s, db_ok, tmux_ok}` (§3.4). Used by the
/// deploy-verification milestone. No auth.
async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let db_ok = sqlx::query("SELECT 1").fetch_one(&state.pool).await.is_ok();
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_s": START.elapsed().as_secs(),
        "db_ok": db_ok,
        "tmux_ok": which::which("tmux").is_ok(),
    }))
}

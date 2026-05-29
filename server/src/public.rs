//! Public (no-auth) routes.
//!
//! Mounted OUTSIDE the auth layer. Ships `/api/health`; the PWA assets
//! (manifest, service worker, icons, base HTML) join here in the
//! frontend-embedding layer.

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

/// `GET /api/health` — `{version, uptime_s, db_ok, tmux_ok}`. Used by
/// deploy verification. No auth.
async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let db_ok = sqlx::query("SELECT 1").fetch_one(&state.pool).await.is_ok();
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_s": START.elapsed().as_secs(),
        "db_ok": db_ok,
        "tmux_ok": which::which("tmux").is_ok(),
    }))
}

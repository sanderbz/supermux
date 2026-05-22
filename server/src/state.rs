//! Shared application state (TECH_PLAN §3.2.5).
//!
//! Cloned into every axum handler via `State<AppState>`. All fields are cheap to
//! clone (an `Arc`, a connection pool handle, or a broadcast sender).

use std::sync::Arc;

use dashmap::DashMap;
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, Mutex, Notify};

use crate::config::Config;

/// One server-sent event: `{ type, payload }` per §3.4.
///
/// The full producer set (sessions/board/schedules/alerts/status/ping) lands in
/// later milestones; M1 only establishes the channel so handlers can publish.
#[derive(Debug, Clone, Serialize)]
pub struct SseEvent {
    #[serde(rename = "type")]
    pub event: String,
    pub payload: serde_json::Value,
}

/// Default fan-out capacity for the SSE broadcast channel.
const SSE_CHANNEL_CAP: usize = 256;

#[derive(Clone)]
pub struct AppState {
    /// SQLite connection pool (WAL, FK on).
    pub pool: SqlitePool,
    /// Immutable runtime configuration.
    pub config: Arc<Config>,
    /// Per-session serialization locks. Added on first use; removed in
    /// `sessions::delete`/`archive` (Eng concurrency #5/#6) — see §3.2.5.
    pub session_locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    /// Wakes background consumers when session status may have changed.
    pub status_notify: Arc<Notify>,
    /// Broadcast channel feeding the SSE endpoint.
    pub sse_tx: broadcast::Sender<SseEvent>,
}

impl AppState {
    pub fn new(pool: SqlitePool, config: Config) -> Self {
        let (sse_tx, _rx) = broadcast::channel(SSE_CHANNEL_CAP);
        Self {
            pool,
            config: Arc::new(config),
            session_locks: Arc::new(DashMap::new()),
            status_notify: Arc::new(Notify::new()),
            sse_tx,
        }
    }

    /// Get (creating on first use) the per-session lock.
    pub fn lock_for(&self, name: &str) -> Arc<Mutex<()>> {
        self.session_locks
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

//! Shared application state (TECH_PLAN §3.2.5).
//!
//! Cloned into every axum handler via `State<AppState>`. All fields are cheap to
//! clone (an `Arc`, a connection pool handle, or a broadcast sender).

use std::sync::Arc;

use dashmap::DashMap;
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, watch, Mutex, Notify};

use crate::config::Config;
use crate::sessions::pty::PtyStream;
use crate::sessions::tmux::Tmux;
use crate::ws::streamer::PtyStreamer;

/// A per-session status snapshot pushed through [`AppState::status_watch`]:
/// `(status, version)`. M3 establishes the channel + version counter as the
/// multi-signal-status groundwork; M5a/M5b refine the status payload (the
/// golden-fixture-tested `Status` enum) and start sending updates from the 2s
/// detector loop. The `String` status is one of the `last_status` CHECK values.
pub type StatusUpdate = (String, u64);

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
    /// Per-session status watch channels (the wait-primitive seam, §3.2.8/§3.7).
    /// Empty until M5b drives the detector; M3 owns the map + the §3.2.5 cleanup
    /// so churn never leaks entries.
    pub status_watch: Arc<DashMap<String, watch::Sender<StatusUpdate>>>,
    /// Per-session hook-token cache (§6.5). Seeded on create + rotated on start;
    /// removed on delete. NEVER holds the dashboard bearer — only the narrow
    /// per-session `AMUX_HOOK_TOKEN`. M5b's `/api/_internal/hook` reads it.
    pub hook_tokens: Arc<DashMap<String, String>>,
    /// Wakes background consumers when session status may have changed.
    pub status_notify: Arc<Notify>,
    /// Broadcast channel feeding the SSE endpoint.
    pub sse_tx: broadcast::Sender<SseEvent>,
    /// Per-session live pty streams (M4). One FIFO reader + broadcast fan-out per
    /// session, created on first WS subscribe via [`AppState::pty_for`].
    pub pty: Arc<PtyStreamer>,
}

impl AppState {
    pub fn new(pool: SqlitePool, config: Config) -> Self {
        let (sse_tx, _rx) = broadcast::channel(SSE_CHANNEL_CAP);
        // Build the pty streamer before `config` is moved into the Arc.
        let pty = Arc::new(PtyStreamer::new(
            config.data_dir.join("logs"),
            config.ws.broadcast_capacity,
        ));
        Self {
            pool,
            config: Arc::new(config),
            session_locks: Arc::new(DashMap::new()),
            status_watch: Arc::new(DashMap::new()),
            hook_tokens: Arc::new(DashMap::new()),
            status_notify: Arc::new(Notify::new()),
            sse_tx,
            pty,
        }
    }

    /// Get (creating on first use) the per-session [`PtyStream`] and ensure its
    /// FIFO reader is running. Errors if the session's tmux pane is not live.
    pub async fn pty_for(&self, name: &str) -> anyhow::Result<Arc<PtyStream>> {
        let stream = self.pty.for_session(name);
        let tmux = Tmux::new(name);
        stream.ensure_started(&tmux).await?;
        Ok(stream)
    }

    /// Get (creating on first use) the per-session lock.
    pub fn lock_for(&self, name: &str) -> Arc<Mutex<()>> {
        self.session_locks
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Drop every per-session in-memory map entry for `name` (§3.2.5 cleanup
    /// rule). Called from `sessions::delete` so weeks of session churn don't leak
    /// `DashMap` entries.
    pub fn forget_session(&self, name: &str) {
        self.session_locks.remove(name);
        self.status_watch.remove(name);
        self.hook_tokens.remove(name);
        self.pty.forget(name);
    }

    /// Move every per-session in-memory map entry from `old` to `new` (used by
    /// `config_patch` rename so locks/tokens/watches survive a rename).
    pub fn rename_session(&self, old: &str, new: &str) {
        if let Some((_, v)) = self.session_locks.remove(old) {
            self.session_locks.insert(new.to_string(), v);
        }
        if let Some((_, v)) = self.status_watch.remove(old) {
            self.status_watch.insert(new.to_string(), v);
        }
        if let Some((_, v)) = self.hook_tokens.remove(old) {
            self.hook_tokens.insert(new.to_string(), v);
        }
        self.pty.rename(old, new);
    }
}

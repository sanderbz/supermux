//! Shared application state (TECH_PLAN §3.2.5).
//!
//! Cloned into every axum handler via `State<AppState>`. All fields are cheap to
//! clone (an `Arc`, a connection pool handle, or a broadcast sender).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, watch, Mutex, Notify};

use crate::config::Config;
use crate::sessions::pty::PtyStream;
use crate::sessions::status::HookEvent;
use crate::sessions::tmux::Tmux;
use crate::ws::streamer::PtyStreamer;

/// Cold-start PTY sentinel (§3.2.8): until M4's reader records a real byte for a
/// session, [`AppState::last_pty`] reports the last byte as 5 minutes ago, so a
/// freshly-booted server never reads `Active` off a stale heartbeat.
const COLD_START_PTY_IDLE: Duration = Duration::from_secs(300);

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
    /// per-session `SUPERMUX_HOOK_TOKEN`. M5b's `/api/_internal/hook` reads it.
    pub hook_tokens: Arc<DashMap<String, String>>,
    /// Per-session most-recent Claude `SettingsHook` event (§3.6, M5b). Written by
    /// `/api/_internal/hook`; read by the status detector's fusion rule, where a
    /// fresh (<3s) event outranks the regex bank + heartbeat. The `Instant` is the
    /// receive time, so freshness is judged server-side (clock-skew safe).
    pub last_hook: Arc<DashMap<String, (Instant, HookEvent)>>,
    /// Per-session detector wake (§3.6 — "within 1s of a real Claude
    /// notification"). The hook endpoint `notify_one`s this so the affected
    /// session's 2s detector loop re-ticks immediately instead of waiting out the
    /// interval; `notify_one` stores a permit so a wake is never lost to a
    /// not-yet-parked loop. One `Notify` per session keeps a `PreToolUse` storm on
    /// one agent from waking every other session's loop.
    pub detector_wake: Arc<DashMap<String, Arc<Notify>>>,
    /// Per-session PTY heartbeat: the [`Instant`] the live reader last saw bytes
    /// from this session's pane. The M5a status detector reads it for its
    /// heartbeat branch (bytes <1.5s → `Active`, silent ≥30s → `Idle`). **M4's
    /// reader writes `Instant::now()` here on each byte batch**; until then a
    /// missing entry reads as the cold-start sentinel (see [`Self::last_pty`]).
    pub pty_heartbeat: Arc<DashMap<String, Instant>>,
    /// Wakes background consumers when session status may have changed.
    pub status_notify: Arc<Notify>,
    /// Broadcast channel feeding the SSE endpoint.
    pub sse_tx: broadcast::Sender<SseEvent>,
    /// Per-session live pty streams (M4). One FIFO reader + broadcast fan-out per
    /// session, created on first WS subscribe via [`AppState::pty_for`].
    pub pty: Arc<PtyStreamer>,
    /// Per-session live background-task counter (R1-1/R1-2). Each per-session
    /// loop (the 2s status detector + the steering deliver loop) increments this
    /// when it spawns and decrements when it exits. `archive`/`delete` use it to
    /// run [`forget_session`](Self::forget_session) only AFTER every loop has
    /// stopped — otherwise a still-running loop's `or_insert_with` re-creates the
    /// very `DashMap` entries `forget_session` removed (R1-2).
    pub session_tasks: Arc<DashMap<String, Arc<AtomicUsize>>>,
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
            last_hook: Arc::new(DashMap::new()),
            detector_wake: Arc::new(DashMap::new()),
            pty_heartbeat: Arc::new(DashMap::new()),
            status_notify: Arc::new(Notify::new()),
            sse_tx,
            pty,
            session_tasks: Arc::new(DashMap::new()),
        }
    }

    /// Register the start of a per-session background loop, returning a guard
    /// that decrements the live-task count when dropped. While ANY guard for
    /// `name` is alive, [`forget_session`](Self::forget_session) must not run
    /// (the loop may still re-create map entries — R1-2).
    pub fn session_task_guard(&self, name: &str) -> SessionTaskGuard {
        let counter = self
            .session_tasks
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(AtomicUsize::new(0)))
            .clone();
        counter.fetch_add(1, Ordering::SeqCst);
        SessionTaskGuard {
            name: name.to_string(),
            counter,
        }
    }

    /// How many per-session background loops are currently running for `name`.
    /// `archive`/`delete` poll this to 0 before calling `forget_session`.
    pub fn live_session_tasks(&self, name: &str) -> usize {
        self.session_tasks
            .get(name)
            .map(|c| c.load(Ordering::SeqCst))
            .unwrap_or(0)
    }

    /// Get (creating on first use) the per-session [`PtyStream`] and ensure its
    /// FIFO reader is running. Errors if the session's tmux pane is not live.
    pub async fn pty_for(&self, name: &str) -> anyhow::Result<Arc<PtyStream>> {
        let stream = self.pty.for_session(name);
        let tmux = Tmux::new(name);
        stream.ensure_started(&tmux, &self.pool).await?;
        Ok(stream)
    }

    /// The instant this session's PTY last produced a byte, or the cold-start
    /// sentinel (`now − 5min`) when the reader (M4) has recorded nothing yet
    /// (§3.2.8). The status detector feeds this into `StatusDetector::detect`.
    pub fn last_pty(&self, name: &str) -> Instant {
        self.pty_heartbeat
            .get(name)
            .map(|e| *e.value())
            .unwrap_or_else(|| Instant::now() - COLD_START_PTY_IDLE)
    }

    /// Record a Claude `SettingsHook` event for `name` at the current instant
    /// (§3.6, M5b). Called by `/api/_internal/hook` after the per-session hook
    /// token validates. Overwrites any prior event — the detector only cares about
    /// the most recent one within the 3s freshness window.
    pub fn record_hook(&self, name: &str, event: HookEvent) {
        self.last_hook
            .insert(name.to_string(), (Instant::now(), event));
    }

    /// The most-recent hook event for `name`, if any (§3.6). Fed into
    /// `StatusDetector::detect` as the apex signal.
    pub fn last_hook_event(&self, name: &str) -> Option<(Instant, HookEvent)> {
        self.last_hook.get(name).map(|e| *e.value())
    }

    /// The per-session detector wake handle (get-or-create). The detector loop
    /// holds one end; the hook endpoint `notify_one`s it for sub-second status
    /// updates (§3.6 "within 1s").
    pub fn detector_wake_for(&self, name: &str) -> Arc<Notify> {
        self.detector_wake
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(Notify::new()))
            .clone()
    }

    /// Wake `name`'s detector loop so it re-ticks now rather than at its next 2s
    /// interval. `notify_one` parks a permit if the loop isn't currently waiting,
    /// so the wake survives the brief window between ticks (no lost notification).
    pub fn wake_detector(&self, name: &str) {
        self.detector_wake_for(name).notify_one();
    }

    /// The per-session status watch sender (get-or-create), seeded `("unknown", 0)`
    /// (§3.2.8/§3.7). The detector `send_replace`s `(status, ver+1)` on a status
    /// change; `agents::wait` subscribes for the long-poll. A single shared sender
    /// per session means every waiter and the detector rendezvous on one channel —
    /// the watch receiver always holds the latest value, so there is no
    /// notify-before-subscribe race (Eng P0 #2).
    pub fn status_watch_for(&self, name: &str) -> watch::Sender<StatusUpdate> {
        self.status_watch
            .entry(name.to_string())
            .or_insert_with(|| watch::channel(("unknown".to_string(), 0)).0)
            .clone()
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
        self.last_hook.remove(name);
        self.detector_wake.remove(name);
        self.pty_heartbeat.remove(name);
        self.session_tasks.remove(name);
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
        if let Some((_, v)) = self.last_hook.remove(old) {
            self.last_hook.insert(new.to_string(), v);
        }
        if let Some((_, v)) = self.detector_wake.remove(old) {
            self.detector_wake.insert(new.to_string(), v);
        }
        if let Some((_, v)) = self.pty_heartbeat.remove(old) {
            self.pty_heartbeat.insert(new.to_string(), v);
        }
        if let Some((_, v)) = self.session_tasks.remove(old) {
            self.session_tasks.insert(new.to_string(), v);
        }
        self.pty.rename(old, new);
    }
}

/// RAII guard for a per-session background loop (R1-1/R1-2). Increment happens
/// in [`AppState::session_task_guard`]; the decrement happens on drop, so the
/// live count is correct even if the loop panics. `archive`/`delete` wait for
/// the count to reach 0 before running `forget_session`.
pub struct SessionTaskGuard {
    name: String,
    counter: Arc<AtomicUsize>,
}

impl SessionTaskGuard {
    /// The session this guard belongs to.
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for SessionTaskGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
    }
}

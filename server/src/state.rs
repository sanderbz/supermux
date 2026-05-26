//! Shared application state (TECH_PLAN §3.2.5).
//!
//! Cloned into every axum handler via `State<AppState>`. All fields are cheap to
//! clone (an `Arc`, a connection pool handle, or a broadcast sender).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, watch, Mutex, Notify};

use crate::config::Config;
use crate::sessions::pty::PtyStream;
use crate::sessions::status::{HookEvent, Status, TurnState};
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

/// A per-session live "current activity" + last-error snapshot derived from
/// Claude hook PAYLOADS (hooks-10x TRACK 1). Held ONLY in memory — payloads are
/// NEVER written to disk/DB (spec §SECURITY) — and surfaced on `SessionView`.
///
/// * `activity` / `activity_kind` — the latest `PreToolUse`-derived label
///   (`✎ tile.tsx`) + its class (`edit`); cleared on `Stop`/`SessionEnd`. A
///   `PostToolUseFailure` sets a transient `✗ {tool} failed` (kind `failed`).
/// * `error` — the latest `StopFailure` `(type, message)`; cleared on the next
///   `UserPromptSubmit`/`SessionStart`.
#[derive(Debug, Clone, Default)]
pub struct SessionActivity {
    /// The display label, e.g. `⚡ npm test` / `✎ tile.tsx`. `None` = no activity.
    pub activity: Option<String>,
    /// The activity class (`bash`/`edit`/`read`/`search`/`web`/`task`/`mcp`/
    /// `tool`/`failed`) paired with `activity`; `None` whenever `activity` is.
    pub activity_kind: Option<String>,
    /// The latest unrecovered error `(type, message)` from a `StopFailure` hook.
    pub error: Option<(String, String)>,
}

impl SessionActivity {
    /// Is this snapshot entirely empty (nothing to surface)? Used to prune the
    /// map entry after a clear so an idle session leaks no entry.
    fn is_empty(&self) -> bool {
        self.activity.is_none() && self.activity_kind.is_none() && self.error.is_none()
    }
}

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

/// How many most-recently-active working/loading sessions get the 1s preview
/// tier (M-CADENCE — the user's "top 4"). The rest of the working/loading
/// sessions fall to the 2s tier.
pub const HOT_SET_SIZE: usize = 4;

/// One session's adaptive-cadence recency record (M-CADENCE). Updated by the
/// detector loop every tick. `last_active` is the most recent instant the
/// session was observed working/loading (active|starting); it is what the hot-set
/// ranking sorts by, so the freshest workers win the 1s tier.
#[derive(Debug, Clone, Copy)]
pub struct SessionRecency {
    /// The session's status as of its last detector tick.
    pub status: Status,
    /// The most recent instant the session was working/loading. Stays put while
    /// the session is idle/waiting so a recently-busy session keeps its place in
    /// the recency order versus an old one, but only working sessions are ever
    /// *eligible* for the hot set (the ranking filters on live status).
    pub last_active: Instant,
}

/// Pure hot-set membership test (M-CADENCE): is `name` among the top
/// [`HOT_SET_SIZE`] most-recently-active working/loading sessions in `map`?
///
/// Extracted from [`AppState::is_hot`] as a free function so the ranking is
/// unit-testable without a DB-backed `AppState`. Only sessions whose
/// last-recorded status is working/loading (active|starting) are eligible; the
/// order is `last_active` descending, ties broken by name ascending for
/// determinism. Runs O(n) over the live set with no allocation.
pub fn is_hot_in(map: &HashMap<String, SessionRecency>, name: &str) -> bool {
    let Some(me) = map.get(name) else {
        return false;
    };
    // Only working/loading sessions are eligible for the hot set.
    if !matches!(me.status, Status::Active | Status::Starting) {
        return false;
    }
    // Count how many OTHER working sessions rank strictly ahead of me. If fewer
    // than HOT_SET_SIZE are ahead, I'm in the top-4. A tie on `last_active` is
    // broken by name ascending, so the set is deterministic and exactly one
    // session occupies each rank.
    let mut ahead = 0usize;
    for (other_name, other) in map.iter() {
        if other_name == name {
            continue;
        }
        if !matches!(other.status, Status::Active | Status::Starting) {
            continue;
        }
        let more_recent = other.last_active > me.last_active
            || (other.last_active == me.last_active && other_name.as_str() < name);
        if more_recent {
            ahead += 1;
            if ahead >= HOT_SET_SIZE {
                return false;
            }
        }
    }
    true
}

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
    /// Per-session TURN STATE (§3.6; the "busy while thinking" fix). Written by
    /// `/api/_internal/hook` (folding each Claude `SettingsHook` event into the
    /// matching per-type timestamp via [`TurnState::apply`]); read by the status
    /// detector's turn state machine, which marks the session `Active` for the
    /// WHOLE turn (start → silent think → tool → … → Stop), not just within a 3s
    /// window of the last hook. Each timestamp is the server-side receive
    /// `Instant`, so freshness is judged locally (clock-skew safe).
    pub last_hook: Arc<DashMap<String, TurnState>>,
    /// Per-session "hooks are LIVE" flag. Set the moment ANY authenticated hook
    /// POST arrives from the session (`/api/_internal/hook`), so it goes true
    /// within the boot window — the `SessionStart` hook fires when Claude
    /// launches, before the user can submit (or even type) their first prompt.
    /// Read by the status detector: a hooked session is AUTHORITATIVE off the
    /// turn state machine + content bank, so the raw PTY-heartbeat "bytes ⇒
    /// Active" fallback is suppressed for it — typing at the prompt echoes bytes
    /// but must NOT read as "the agent is working" (the core fragility this fixes).
    /// `()` value = a presence set; cleared on session delete/rename.
    pub hooks_live: Arc<DashMap<String, ()>>,
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
    /// Adaptive-cadence recency tracker (M-CADENCE). Each per-session detector
    /// loop writes its CURRENT status + the instant it was last "active" (the
    /// last tick it read working/loading) here every tick; [`is_hot`](Self::is_hot)
    /// ranks the working/loading sessions by recency and returns true for the top
    /// 4 — the sessions that get the 1s preview tier. Kept tiny + in-memory (no
    /// per-tick DB scan); pruned on session stop/delete via `forget_session`.
    ///
    /// A `std::sync::Mutex` (not the tokio one used elsewhere) because the
    /// critical section is a tiny synchronous map read/write that is NEVER held
    /// across an `.await` — a blocking lock is correct and cheaper here.
    pub cadence_recency: Arc<std::sync::Mutex<HashMap<String, SessionRecency>>>,
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
    /// Per-session live "current activity" + last-error snapshot derived from
    /// Claude hook PAYLOADS (hooks-10x TRACK 1). IN-MEMORY ONLY (payloads are
    /// never persisted — spec §SECURITY); read by `SessionView`. Written by
    /// `/api/_internal/hook` as `PreToolUse`/`StopFailure`/… land; pruned to
    /// empty on `Stop`/`SessionEnd` and dropped on session delete/rename.
    pub session_activity: Arc<DashMap<String, SessionActivity>>,
    /// Per-session LIFECYCLE-forced status override (hooks-10x). A `SessionEnd`
    /// hook forces `Stopped`; the detector loop reads this each tick and
    /// `force`s it into its classifier (then clears it), so the lifecycle signal
    /// — which the capture classifier cannot infer — sticks instead of being
    /// re-derived to `active` on the next tick. `SessionStart` clears any pending
    /// override so the detector re-evaluates freely.
    pub forced_status: Arc<DashMap<String, Status>>,
    /// Per-session PER-LAUNCH "force Agent Teams ON" flag (AT-D "Start a team").
    /// AT-B's global `experimental.agent_teams` pref is the app-wide gate; this is
    /// a NARROWER, explicit per-session opt-in set by the `POST /api/teams/start`
    /// endpoint when a user spins up a team lead, so that ONE lead session gets
    /// `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `teammateMode:"tmux"` even while
    /// the global pref is OFF (explicit opt-in beats the conservative default).
    /// [`crate::sessions::lifecycle::start`] reads `global_pref OR this.contains`,
    /// so it never FIGHTS AT-B's gating — it only widens it for a flagged lead.
    /// `()` value = a presence set; persists across re-starts/wakes of that lead
    /// (a re-woken team lead should keep teams enabled), carried on rename, dropped
    /// on `forget_session`.
    pub force_agent_teams: Arc<DashMap<String, ()>>,
    /// Shared VAPID keypair for web push (PUSH milestone). Computed once at
    /// startup (loaded/generated from the data dir); the public half is served by
    /// `GET /api/push/key`, the private half signs every push. Cheap `Arc` clone.
    pub vapid: Arc<crate::push::Vapid>,
}

impl AppState {
    pub fn new(pool: SqlitePool, config: Config) -> Self {
        let (sse_tx, _rx) = broadcast::channel(SSE_CHANNEL_CAP);
        // Build the pty streamer before `config` is moved into the Arc.
        let pty = Arc::new(PtyStreamer::new(
            config.data_dir.join("logs"),
            config.data_dir.join("pty"),
            config.ws.broadcast_capacity,
        ));
        // Load (or first-run generate) the persisted VAPID keypair for web push
        // before `config` is moved into the Arc. Non-fatal on failure (push then
        // stays disabled; the rest of the server still boots).
        let vapid = crate::push::init_vapid(&config.data_dir);
        Self {
            pool,
            config: Arc::new(config),
            vapid,
            session_locks: Arc::new(DashMap::new()),
            status_watch: Arc::new(DashMap::new()),
            hook_tokens: Arc::new(DashMap::new()),
            last_hook: Arc::new(DashMap::new()),
            hooks_live: Arc::new(DashMap::new()),
            detector_wake: Arc::new(DashMap::new()),
            pty_heartbeat: Arc::new(DashMap::new()),
            cadence_recency: Arc::new(std::sync::Mutex::new(HashMap::new())),
            status_notify: Arc::new(Notify::new()),
            sse_tx,
            pty,
            session_tasks: Arc::new(DashMap::new()),
            session_activity: Arc::new(DashMap::new()),
            forced_status: Arc::new(DashMap::new()),
            force_agent_teams: Arc::new(DashMap::new()),
        }
    }

    /// Mark a session as a "Start a team" LEAD: its next (and subsequent) starts
    /// inject the Agent Teams env even when the global pref is OFF (AT-D). Idempotent.
    pub fn set_force_agent_teams(&self, name: &str) {
        self.force_agent_teams.insert(name.to_string(), ());
    }

    /// Was this session explicitly opted into Agent Teams via "Start a team"?
    pub fn force_agent_teams(&self, name: &str) -> bool {
        self.force_agent_teams.contains_key(name)
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
        // Hand the reader BOTH the heartbeat map (so it stamps freshness on every
        // byte batch) AND this session's detector wake (so a silent→active edge in
        // the byte flow re-ticks the detector immediately — STATLAT). The wake is
        // the SAME `Notify` the detector loop parks on, so a byte burst after an
        // idle/waiting lull surfaces `Active` within ~1s regardless of provider or
        // whether Claude hooks are wired, instead of waiting out the 4s/5s tier.
        // The reader derives its tmux target (session vs pane) from the stream
        // itself (Agent Teams §3.5), so no `Tmux` is passed in.
        stream
            .ensure_started(
                &self.pool,
                self.pty_heartbeat.clone(),
                self.detector_wake_for(name),
            )
            .await?;
        Ok(stream)
    }

    /// Get (creating on first use) the live pty stream for a teammate PANE (Agent
    /// Teams §3.5) and ensure its FIFO reader is running. `stream_key` is a
    /// pane-unique id (`%id` or `{lead}/{member}`) — it keys the registry AND the
    /// FIFO/log basenames so the teammate never clobbers the lead's. `pane_id` is
    /// the tmux `%id` the reader pipes. The caller MUST have already validated the
    /// pane still lives in the lead's window (pane ids are reused).
    pub async fn pty_for_pane(
        &self,
        stream_key: &str,
        pane_id: &str,
    ) -> anyhow::Result<Arc<PtyStream>> {
        let stream = self.pty.for_pane(stream_key, pane_id);
        stream
            .ensure_started(
                &self.pool,
                self.pty_heartbeat.clone(),
                self.detector_wake_for(stream_key),
            )
            .await?;
        Ok(stream)
    }

    /// Invalidate the cached live pty stream for `name` because its tmux pane was
    /// destroyed by a SESSION stop/restart. The next [`pty_for`](Self::pty_for)
    /// (a fresh WS attach) rebuilds the stream against the NEW pane, and any
    /// already-open WS reconnects onto it. A SERVER restart never calls this — it
    /// boots with an empty stream registry and rebuilds on first attach — so
    /// session-survival is untouched. See [`PtyStreamer::invalidate`].
    pub fn pty_invalidate(&self, name: &str) {
        self.pty.invalidate(name);
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

    /// Fold a Claude `SettingsHook` event for `name` into its per-session
    /// [`TurnState`] at the current instant (§3.6). Called by `/api/_internal/hook`
    /// after the per-session hook token validates. Unlike the old single-slot
    /// store, this bumps ONLY the matching event-type's newest timestamp, so a
    /// `PreToolUse` followed by a silent think still has a `turn_start` newer than
    /// any `turn_end` — keeping the turn `Active` (the "busy while thinking" fix).
    pub fn record_hook(&self, name: &str, event: HookEvent) {
        self.last_hook
            .entry(name.to_string())
            .or_default()
            .apply(Instant::now(), event);
    }

    /// The current per-session [`TurnState`] snapshot for `name` (§3.6). Fed into
    /// `StatusDetector::detect` as the apex signal; a never-seen session returns
    /// the empty default (non-decisive, so the bank/heartbeat decide).
    pub fn turn_state(&self, name: &str) -> TurnState {
        self.last_hook.get(name).map(|e| *e.value()).unwrap_or_default()
    }

    /// Mark `name`'s Claude hooks as LIVE — called by `/api/_internal/hook` on
    /// EVERY authenticated POST (any event kind, incl. `SessionStart`). Once set,
    /// the detector treats the turn state machine + content bank as authoritative
    /// and suppresses the raw PTY-heartbeat `Active` fallback for the session (so
    /// typing at the prompt can't flip the card to busy).
    pub fn mark_hooks_live(&self, name: &str) {
        self.hooks_live.entry(name.to_string()).or_insert(());
    }

    /// Does `name` have LIVE Claude hooks (we have seen ≥1 hook POST from it)?
    /// Read by the status detector to decide whether the heartbeat `Active`
    /// fallback applies. A never-hooked session (shell / codex / claude whose
    /// hooks failed to install or have not fired yet) returns `false` and keeps
    /// the heartbeat heuristic as its liveness fallback.
    pub fn has_hooks(&self, name: &str) -> bool {
        self.hooks_live.contains_key(name)
    }

    // ── hooks-10x: live activity + error (IN-MEMORY ONLY) ─────────────────────

    /// The current in-memory [`SessionActivity`] for `name` (hooks-10x), or
    /// `None` when the session has no activity/error to surface. Read by
    /// `SessionView`. Cheap clone of a tiny struct.
    pub fn session_activity(&self, name: &str) -> Option<SessionActivity> {
        self.session_activity.get(name).map(|e| e.value().clone())
    }

    /// Mutate `name`'s activity snapshot with `f`, then prune the entry if it is
    /// empty. Returns `true` IFF the snapshot actually changed — the endpoint
    /// broadcasts a `sessions` delta only on a real change (spec §4: "keep it
    /// cheap, only on change"). The whole op is a single short critical section.
    fn mutate_activity(&self, name: &str, f: impl FnOnce(&mut SessionActivity)) -> bool {
        let mut entry = self
            .session_activity
            .entry(name.to_string())
            .or_default();
        let before = entry.value().clone();
        f(entry.value_mut());
        let changed =
            entry.activity != before.activity || entry.activity_kind != before.activity_kind
                || entry.error != before.error;
        let empty = entry.is_empty();
        drop(entry);
        if empty {
            self.session_activity.remove(name);
        }
        changed
    }

    /// Set `name`'s live activity label + kind (from a `PreToolUse` payload).
    /// Returns whether it changed (for the change-only SSE broadcast).
    pub fn set_activity(&self, name: &str, label: String, kind: String) -> bool {
        self.mutate_activity(name, |a| {
            a.activity = Some(label);
            a.activity_kind = Some(kind);
        })
    }

    /// Clear `name`'s live activity (on `Stop`/`SessionEnd`). The error (if any)
    /// is left untouched. Returns whether it changed.
    pub fn clear_activity(&self, name: &str) -> bool {
        self.mutate_activity(name, |a| {
            a.activity = None;
            a.activity_kind = None;
        })
    }

    /// Set `name`'s last error `(type, message)` (from a `StopFailure` payload).
    /// Returns whether it changed.
    pub fn set_error(&self, name: &str, error_type: String, message: String) -> bool {
        self.mutate_activity(name, |a| {
            a.error = Some((error_type, message));
        })
    }

    /// Clear `name`'s last error (on the next `UserPromptSubmit`/`SessionStart`).
    /// Returns whether it changed.
    pub fn clear_error(&self, name: &str) -> bool {
        self.mutate_activity(name, |a| {
            a.error = None;
        })
    }

    /// Force `name`'s status via the lifecycle override (hooks-10x): the detector
    /// loop reads + applies this on its next tick (then clears it), so a
    /// `SessionEnd`-driven `Stopped` sticks instead of being re-derived. Wakes
    /// the loop so the change surfaces within ~1s, not at the next tier edge.
    pub fn set_forced_status(&self, name: &str, status: Status) {
        self.forced_status.insert(name.to_string(), status);
        self.wake_detector(name);
    }

    /// Take (consume) any pending lifecycle-forced status for `name`. Called by
    /// the detector loop each tick; `None` when nothing is pending.
    pub fn take_forced_status(&self, name: &str) -> Option<Status> {
        self.forced_status.remove(name).map(|(_, s)| s)
    }

    /// Clear any pending lifecycle-forced status (e.g. on `SessionStart`, so a
    /// stale `Stopped` doesn't override the re-evaluating detector).
    pub fn clear_forced_status(&self, name: &str) {
        self.forced_status.remove(name);
    }

    /// Record `name`'s current status for the adaptive-cadence hot-set
    /// (M-CADENCE). Called by the detector loop every tick. When the session is
    /// working/loading (active|starting) its `last_active` is bumped to now, so it
    /// rises in the recency order that [`is_hot`](Self::is_hot) ranks; for any
    /// other status the prior `last_active` is preserved (it stops climbing but
    /// keeps its place, and the status filter excludes it from the hot set
    /// anyway). Cheap O(1) map write under a short mutex — no DB.
    pub fn record_recency(&self, name: &str, status: Status) {
        let working = matches!(status, Status::Active | Status::Starting);
        let now = Instant::now();
        // A poisoned lock (a prior panic while holding it) is recovered, not
        // propagated — the recency map is a best-effort cadence hint, never a
        // correctness invariant, so a stale entry is far better than a panic.
        let mut map = self
            .cadence_recency
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(name.to_string()).or_insert(SessionRecency {
            status,
            last_active: now,
        });
        entry.status = status;
        if working {
            entry.last_active = now;
        }
    }

    /// Is `name` among the TOP-[`HOT_SET_SIZE`] most-recently-active
    /// working/loading sessions (M-CADENCE)? Membership earns the 1s preview
    /// tier. Ranking is over only the sessions whose LAST-RECORDED status is
    /// working/loading (active|starting), ordered by `last_active` descending; a
    /// session that is idle/waiting/stopped is never hot. O(n) over the live
    /// session set (a handful), no DB scan, no allocation beyond a small partial
    /// selection.
    pub fn is_hot(&self, name: &str) -> bool {
        let map = self
            .cadence_recency
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        is_hot_in(&map, name)
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

    /// The human-readable reason to put in a web-push notification body for
    /// `name` transitioning into `status` (PUSH milestone). Generic by design:
    /// a parallel worker (`feat/hooks-be`) is enriching a per-session blocked
    /// reason / `last_error` in this struct; when that lands, this is the single
    /// place to prefer it (e.g. `self.last_error.get(name)` / a blocked-reason
    /// map) before falling back to these generics — keeping the push wiring
    /// additive and the fallback always-present.
    pub fn push_reason_for(&self, _name: &str, status: Status) -> String {
        match status {
            Status::Waiting => "The agent is waiting for your input.".to_string(),
            Status::Stopped => "The agent stopped.".to_string(),
            _ => "The agent needs your attention.".to_string(),
        }
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
        self.hooks_live.remove(name);
        self.detector_wake.remove(name);
        self.pty_heartbeat.remove(name);
        self.session_tasks.remove(name);
        self.session_activity.remove(name);
        self.forced_status.remove(name);
        self.force_agent_teams.remove(name);
        self.cadence_recency
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(name);
        self.pty.forget(name);
    }

    /// Evict a teammate PANE stream (Agent Teams §3.5) keyed by its stream key
    /// (`{lead}/{member}`). Called when a team ends (the watcher's deregister
    /// path) so the per-pane [`PtyStream`] cached in the streamer DashMap — plus
    /// its heartbeat entry, which the reader records under the SAME key — does NOT
    /// linger forever once the team is gone. Without this the registry grows
    /// unbounded across many team starts (every `{lead}/{member}` slot is created
    /// on first attach but never removed; the session-cleanup `forget_session`
    /// only handles bare session keys). Best-effort + idempotent: an unknown key
    /// is a clean no-op, and this NEVER touches a bare session key.
    pub fn forget_teammate_stream(&self, stream_key: &str) {
        self.pty_heartbeat.remove(stream_key);
        self.detector_wake.remove(stream_key);
        self.pty.forget(stream_key);
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
        if let Some((_, v)) = self.hooks_live.remove(old) {
            self.hooks_live.insert(new.to_string(), v);
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
        if let Some((_, v)) = self.session_activity.remove(old) {
            self.session_activity.insert(new.to_string(), v);
        }
        if let Some((_, v)) = self.forced_status.remove(old) {
            self.forced_status.insert(new.to_string(), v);
        }
        if let Some((_, v)) = self.force_agent_teams.remove(old) {
            self.force_agent_teams.insert(new.to_string(), v);
        }
        {
            let mut rec = self.cadence_recency.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(v) = rec.remove(old) {
                rec.insert(new.to_string(), v);
            }
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

#[cfg(test)]
mod hot_set_tests {
    //! Adaptive-cadence hot-set ranking (M-CADENCE). Drives the pure
    //! [`is_hot_in`] over a hand-built recency map so the top-4-by-recency rule
    //! is pinned without a DB-backed `AppState`.

    use super::*;

    /// A recency record `secs_ago` seconds in the past with the given status.
    fn rec(status: Status, secs_ago: u64) -> SessionRecency {
        SessionRecency {
            status,
            last_active: Instant::now() - Duration::from_secs(secs_ago),
        }
    }

    #[test]
    fn top_four_working_sessions_are_hot_rest_are_not() {
        // Six working sessions; the four most-recently-active are hot, the two
        // oldest are not — the exact "top 4 most-recently-active" rule.
        let mut map = HashMap::new();
        map.insert("s0".to_string(), rec(Status::Active, 0)); // newest
        map.insert("s1".to_string(), rec(Status::Active, 1));
        map.insert("s2".to_string(), rec(Status::Starting, 2)); // loading counts
        map.insert("s3".to_string(), rec(Status::Active, 3));
        map.insert("s4".to_string(), rec(Status::Active, 4));
        map.insert("s5".to_string(), rec(Status::Active, 5)); // oldest

        for hot in ["s0", "s1", "s2", "s3"] {
            assert!(is_hot_in(&map, hot), "{hot} should be in the top-4 hot set");
        }
        for cold in ["s4", "s5"] {
            assert!(!is_hot_in(&map, cold), "{cold} should be below the top-4");
        }
    }

    #[test]
    fn only_working_sessions_are_eligible() {
        // Idle/waiting/stopped sessions are NEVER hot, even when they are the
        // most-recently-touched record in the map.
        let mut map = HashMap::new();
        map.insert("idle".to_string(), rec(Status::Idle, 0));
        map.insert("waiting".to_string(), rec(Status::Waiting, 0));
        map.insert("stopped".to_string(), rec(Status::Stopped, 0));
        map.insert("working".to_string(), rec(Status::Active, 10));

        assert!(!is_hot_in(&map, "idle"));
        assert!(!is_hot_in(&map, "waiting"));
        assert!(!is_hot_in(&map, "stopped"));
        // The lone working session is hot despite being the OLDEST record —
        // non-working records don't occupy a hot slot.
        assert!(is_hot_in(&map, "working"));
    }

    #[test]
    fn idle_sessions_do_not_consume_hot_slots() {
        // Many idle sessions newer than five working ones must not push a working
        // session out of the top-4: only working sessions count toward the cap.
        let mut map = HashMap::new();
        for i in 0..10 {
            map.insert(format!("idle{i}"), rec(Status::Idle, 0));
        }
        map.insert("w0".to_string(), rec(Status::Active, 5));
        map.insert("w1".to_string(), rec(Status::Active, 6));
        map.insert("w2".to_string(), rec(Status::Active, 7));
        map.insert("w3".to_string(), rec(Status::Active, 8));

        for w in ["w0", "w1", "w2", "w3"] {
            assert!(is_hot_in(&map, w), "{w} hot — idle sessions don't take slots");
        }
    }

    #[test]
    fn fewer_than_four_workers_all_hot() {
        let mut map = HashMap::new();
        map.insert("a".to_string(), rec(Status::Active, 0));
        map.insert("b".to_string(), rec(Status::Starting, 1));
        map.insert("c".to_string(), rec(Status::Active, 2));
        for w in ["a", "b", "c"] {
            assert!(is_hot_in(&map, w));
        }
    }

    #[test]
    fn ties_are_broken_deterministically_by_name() {
        // Five working sessions sharing the EXACT same last_active: the cap still
        // admits exactly four, broken by name ascending, so the result is stable.
        let t = Instant::now();
        let mut map = HashMap::new();
        for n in ["e", "d", "c", "b", "a"] {
            map.insert(n.to_string(), SessionRecency { status: Status::Active, last_active: t });
        }
        // a,b,c,d sort ahead → hot; e is the 5th → not hot.
        for hot in ["a", "b", "c", "d"] {
            assert!(is_hot_in(&map, hot), "{hot} hot under name tie-break");
        }
        assert!(!is_hot_in(&map, "e"), "e is the 5th by name → not hot");
    }

    #[test]
    fn unknown_session_is_not_hot() {
        let map = HashMap::new();
        assert!(!is_hot_in(&map, "ghost"));
    }
}

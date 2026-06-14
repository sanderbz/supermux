//! Shared application state.
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
use tokio::sync::{broadcast, oneshot, watch, Mutex, Notify};

use crate::config::Config;
use crate::sessions::host_pool::HostPool;
use crate::sessions::pty::PtyStream;
use crate::sessions::status::{HookEvent, Status, TurnState};
use crate::ws::streamer::PtyStreamer;

/// Cold-start PTY sentinel: until the live reader records a real byte for a
/// session, [`AppState::last_pty`] reports the last byte as 5 minutes ago, so a
/// freshly-booted server never reads `Active` off a stale heartbeat.
const COLD_START_PTY_IDLE: Duration = Duration::from_secs(300);

/// A per-session status snapshot pushed through [`AppState::status_watch`]:
/// `(status, version)`. The channel + version counter form the
/// multi-signal-status groundwork; the status payload is the
/// golden-fixture-tested `Status` enum, updated from the 2s detector loop.
/// The `String` status is one of the `last_status` CHECK values.
pub type StatusUpdate = (String, u64);

/// A per-session live "current activity" + last-error snapshot derived from
/// Claude hook PAYLOADS. Held ONLY in memory — payloads are
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
    /// Live count of outstanding Task sub-agents for the current turn (fed by
    /// `SubagentStart`/`SubagentStop`). DISPLAY-ONLY: it surfaces parallelism on
    /// the tile and gates the "finished" notification, but is NEVER read by the
    /// status classifier's turn boundary ([`super::sessions::status::TurnState`]
    /// `turn_end` = main `Stop` only), so it cannot regress the false-finished
    /// fix. Best-effort (subagents share the parent token, no per-subagent id):
    /// saturating, reset on a new prompt, force-0 on the main `Stop`.
    pub subagents: u32,
}

impl SessionActivity {
    /// Is this snapshot entirely empty (nothing to surface)? Used to prune the
    /// map entry after a clear so an idle session leaks no entry. `subagents == 0`
    /// counts as empty so a resting session leaks no map entry.
    fn is_empty(&self) -> bool {
        self.activity.is_none()
            && self.activity_kind.is_none()
            && self.error.is_none()
            && self.subagents == 0
    }
}

/// One server-sent event: `{ type, payload }`.
///
/// The full producer set (sessions/board/schedules/alerts/status/ping) lands in
/// later milestones; this only establishes the channel so handlers can publish.
#[derive(Debug, Clone, Serialize)]
pub struct SseEvent {
    #[serde(rename = "type")]
    pub event: String,
    pub payload: serde_json::Value,
}

/// Default fan-out capacity for the SSE broadcast channel.
const SSE_CHANNEL_CAP: usize = 256;

/// How many most-recently-active working/loading sessions get the 1s preview
/// tier (the user's "top 4"). The rest of the working/loading
/// sessions fall to the 2s tier.
pub const HOT_SET_SIZE: usize = 4;

/// One session's adaptive-cadence recency record. Updated by the
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

/// Pure hot-set membership test: is `name` among the top
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

/// One in-flight "edit in native editor" handoff.
///
/// When Claude's built-in `chat:externalEditor` (Ctrl+G) spawns the supermux
/// `$EDITOR` bridge, the bridge POSTs the temp-file buffer to
/// `/api/_internal/external-edit/open` (per-session hook-token auth) and then
/// long-polls `/result`. The open handler stores ONE of these per session and
/// blocks the result long-poll on `rx`; the dashboard's `/external-edit/submit`
/// (bearer auth) resolves `tx` with the edited text or a cancel. Claude itself
/// owns the serialize→edit→deserialize contract — supermux only relays the buffer
/// in and the edited text back, so there is no cell-scraping or keystroke replay.
///
/// One in-flight edit per session: Claude is BLOCKED on the child `$EDITOR`
/// process while editing, so a second legitimate open can't arrive. If one does
/// (a stale bridge, a racing retry) the prior pending edit is resolved
/// [`EditResult::Cancelled`] and replaced — the prior bridge then leaves its temp
/// file unchanged (a no-op), never corrupting Claude's buffer.
pub struct PendingEdit {
    /// The uuid minted by the open handler; only a `submit` carrying THIS id
    /// resolves the edit (a stale dashboard tab submitting an old id is ignored).
    pub request_id: String,
    /// The result channel `submit` resolves. `Some` until resolved; taken (→
    /// `None`) by the first `submit`/replace so it fires exactly once.
    pub tx: Option<oneshot::Sender<EditResult>>,
    /// The paired receiver the `/result` long-poll awaits. The open handler
    /// registers BOTH halves together (the bridge POSTs `open` then long-polls
    /// `result`, so the receiver must outlive the open call); `/result` `take`s it
    /// out and awaits it. `None` once taken — a second `/result` for the same id
    /// (the bridge never makes one) finds nothing to await.
    pub rx: Option<oneshot::Receiver<EditResult>>,
}

/// The outcome of an in-flight external edit, sent on [`PendingEdit::tx`].
#[derive(Debug)]
pub enum EditResult {
    /// The user saved — the new buffer text to write back into Claude's input.
    Text(String),
    /// The user dismissed the sheet (or the slot was superseded) — Claude's
    /// buffer is left unchanged (the bridge leaves the temp file as-is).
    Cancelled,
}

#[derive(Clone)]
pub struct AppState {
    /// SQLite connection pool (WAL, FK on).
    pub pool: SqlitePool,
    /// Immutable runtime configuration.
    pub config: Arc<Config>,
    /// Per-session serialization locks. Added on first use; removed in
    /// `sessions::delete`/`archive`.
    pub session_locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    /// Per-session status watch channels (the wait-primitive seam).
    /// Empty until the detector drives updates; the map + cleanup ensures
    /// churn never leaks entries.
    pub status_watch: Arc<DashMap<String, watch::Sender<StatusUpdate>>>,
    /// Per-session hook-token cache. Seeded on create + rotated on start;
    /// removed on delete. NEVER holds the dashboard bearer — only the narrow
    /// per-session `SUPERMUX_HOOK_TOKEN`. The `/api/_internal/hook` route reads it.
    pub hook_tokens: Arc<DashMap<String, String>>,
    /// Per-session TURN STATE (the "busy while thinking" fix). Written by
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
    /// Per-session detector wake — "within 1s of a real Claude
    /// notification". The hook endpoint `notify_one`s this so the affected
    /// session's 2s detector loop re-ticks immediately instead of waiting out the
    /// interval; `notify_one` stores a permit so a wake is never lost to a
    /// not-yet-parked loop. One `Notify` per session keeps a `PreToolUse` storm on
    /// one agent from waking every other session's loop.
    pub detector_wake: Arc<DashMap<String, Arc<Notify>>>,
    /// Per-session PTY heartbeat: the [`Instant`] the live reader last saw bytes
    /// from this session's pane. The status detector reads it for its
    /// heartbeat branch (bytes <1.5s → `Active`, silent ≥30s → `Idle`). **The
    /// reader writes `Instant::now()` here on each byte batch**; until then a
    /// missing entry reads as the cold-start sentinel (see [`Self::last_pty`]).
    pub pty_heartbeat: Arc<DashMap<String, Instant>>,
    /// Adaptive-cadence recency tracker. Each per-session detector
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
    /// Wakes the teams watcher when something happens that should re-publish
    /// the team list without waiting for the 30s safety poll — e.g. a lead
    /// session was archived (`teams_watcher` filters teams whose lead is
    /// archived, but it only re-runs on this notify or its own tick).
    pub teams_wake: Arc<Notify>,
    /// Broadcast channel feeding the SSE endpoint.
    pub sse_tx: broadcast::Sender<SseEvent>,
    /// Per-session live pty streams. One FIFO reader + broadcast fan-out per
    /// session, created on first WS subscribe via [`AppState::pty_for`].
    pub pty: Arc<PtyStreamer>,
    /// Per-session live background-task counter. Each per-session
    /// loop (the 2s status detector + the steering deliver loop) increments this
    /// when it spawns and decrements when it exits. `archive`/`delete` use it to
    /// run [`forget_session`](Self::forget_session) only AFTER every loop has
    /// stopped — otherwise a still-running loop's `or_insert_with` re-creates the
    /// very `DashMap` entries `forget_session` removed.
    pub session_tasks: Arc<DashMap<String, Arc<AtomicUsize>>>,
    /// Per-session live "current activity" + last-error snapshot derived from
    /// Claude hook PAYLOADS. IN-MEMORY ONLY (payloads are
    /// never persisted — spec §SECURITY); read by `SessionView`. Written by
    /// `/api/_internal/hook` as `PreToolUse`/`StopFailure`/… land; pruned to
    /// empty on `Stop`/`SessionEnd` and dropped on session delete/rename.
    pub session_activity: Arc<DashMap<String, SessionActivity>>,
    /// Per-session LIFECYCLE-forced status override. A `SessionEnd`
    /// hook forces `Stopped`; the detector loop reads this each tick and
    /// `force`s it into its classifier (then clears it), so the lifecycle signal
    /// — which the capture classifier cannot infer — sticks instead of being
    /// re-derived to `active` on the next tick. `SessionStart` clears any pending
    /// override so the detector re-evaluates freely.
    pub forced_status: Arc<DashMap<String, Status>>,
    /// Per-session PER-LAUNCH "force Agent Teams ON" flag ("Start a team").
    /// The global `experimental.agent_teams` pref is the app-wide gate; this is
    /// a NARROWER, explicit per-session opt-in set by the `POST /api/teams/start`
    /// endpoint when a user spins up a team lead, so that ONE lead session gets
    /// `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `teammateMode:"tmux"` even while
    /// the global pref is OFF (explicit opt-in beats the conservative default).
    /// [`crate::sessions::lifecycle::start`] reads `global_pref OR this.contains`,
    /// so it never FIGHTS the global gating — it only widens it for a flagged lead.
    /// `()` value = a presence set; persists across re-starts/wakes of that lead
    /// (a re-woken team lead should keep teams enabled), carried on rename, dropped
    /// on `forget_session`.
    pub force_agent_teams: Arc<DashMap<String, ()>>,
    /// Per-session in-flight "edit in native editor" handoff.
    /// At most one [`PendingEdit`] per session
    /// (Claude is blocked on the child `$EDITOR` while editing). The
    /// `/external-edit/open` handler inserts; `/result` awaits the oneshot;
    /// `/external-edit/submit` resolves + removes it. A `std::sync::Mutex` (not
    /// the tokio one) because every critical section is a tiny synchronous map
    /// op — insert/take a sender — never held across an `.await`.
    pub pending_edits: Arc<std::sync::Mutex<HashMap<String, PendingEdit>>>,
    /// Shared VAPID keypair for web push. Computed once at
    /// startup (loaded/generated from the data dir); the public half is served by
    /// `GET /api/push/key`, the private half signs every push. Cheap `Arc` clone.
    pub vapid: Arc<crate::push::Vapid>,
    /// In-memory bounded ring of recent `send_push` attempts. Exposed via
    /// `GET /api/push/attempts` and rendered as a "Recent activity" panel in
    /// Settings → Notifications — the diagnostic surface that answers "why
    /// didn't my phone ring?" without a log grep. Cheap `Arc` clone.
    pub push_attempts: Arc<crate::push::AttemptLog>,
    /// Per-session pending push debounce timers. On each notify-worthy
    /// status transition, `maybe_push_on_transition` cancels the prior handle
    /// for the session and starts a fresh one — the trailing-edge "wait for
    /// quiet" pattern. The timer task re-reads the session's current status
    /// when it expires, then sends only if the state still implies the same
    /// category. Collapses both the `Starting→Active→Idle` bootup flurry and
    /// the team-lead-bouncing-through-Idle pattern (a lead orchestrating
    /// teammates pulses Idle every few seconds) into one notification fired
    /// after the system actually settles. Inserting cancels the prior task
    /// via the abort handle stored alongside.
    pub pending_pushes: Arc<DashMap<String, tokio::task::AbortHandle>>,
    /// Persistent SSH ControlMaster pool. One master per
    /// remote host, shared by every `Transport::Ssh` shell-out; warmed on
    /// first use, reaped after 10min idle. Cheap `Arc` clone — actual state
    /// lives inside the [`HostPool`].
    pub host_pool: Arc<HostPool>,
    /// In-UI update mechanism (v0.3.0): cached latest GitHub release + the
    /// per-job broadcast registry the SSE progress endpoint subscribes to.
    /// Cheap `Arc` clone; created once in `new()` so every handler shares the
    /// SAME cache + registry (a `/start` writer + `/progress` subscriber must
    /// rendezvous on one channel — see `crate::updates`).
    pub updates: crate::updates::UpdatesState,
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
        let vapid = crate::push::init_vapid(&config.data_dir, config.push_sub.as_deref());
        // SSH ControlMaster pool. Cheap to build (an empty DashMap + a
        // mkdir of `<data_dir>/ssh-control`); the actual ssh work happens
        // lazily when `transport_for` is first called for a host.
        let host_pool = HostPool::new(pool.clone(), &config.data_dir);
        Self {
            pool,
            config: Arc::new(config),
            vapid,
            push_attempts: Arc::new(crate::push::AttemptLog::default()),
            pending_pushes: Arc::new(DashMap::new()),
            session_locks: Arc::new(DashMap::new()),
            status_watch: Arc::new(DashMap::new()),
            hook_tokens: Arc::new(DashMap::new()),
            last_hook: Arc::new(DashMap::new()),
            hooks_live: Arc::new(DashMap::new()),
            detector_wake: Arc::new(DashMap::new()),
            pty_heartbeat: Arc::new(DashMap::new()),
            cadence_recency: Arc::new(std::sync::Mutex::new(HashMap::new())),
            status_notify: Arc::new(Notify::new()),
            teams_wake: Arc::new(Notify::new()),
            sse_tx,
            pty,
            session_tasks: Arc::new(DashMap::new()),
            session_activity: Arc::new(DashMap::new()),
            forced_status: Arc::new(DashMap::new()),
            force_agent_teams: Arc::new(DashMap::new()),
            pending_edits: Arc::new(std::sync::Mutex::new(HashMap::new())),
            host_pool,
            updates: crate::updates::UpdatesState::new(),
        }
    }

    // ── external edit: in-flight native-editor handoff registry ───────────────

    /// Register a fresh [`PendingEdit`] for `session`.
    /// Stores BOTH channel halves so the receiver outlives the bridge's `open` call
    /// (the bridge then long-polls `/result`, which `take`s the receiver). If a
    /// prior edit is still in flight for this session it is resolved
    /// [`EditResult::Cancelled`] and replaced (one in-flight edit per session —
    /// Claude is blocked while editing, so a second open is a stale/racing bridge
    /// whose temp file we want left unchanged). Poisoned-lock recovery: the registry
    /// is a best-effort relay, never a correctness invariant, so a poisoned mutex is
    /// recovered, not panicked.
    pub fn register_edit(&self, session: &str, request_id: String) {
        let (tx, rx) = oneshot::channel();
        let mut map = self.pending_edits.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prev) = map.insert(
            session.to_string(),
            PendingEdit {
                request_id,
                tx: Some(tx),
                rx: Some(rx),
            },
        ) {
            // Supersede the prior in-flight edit so its bridge leaves the file as-is.
            if let Some(prev_tx) = prev.tx {
                let _ = prev_tx.send(EditResult::Cancelled);
            }
        }
    }

    /// Take the result RECEIVER for `session`'s in-flight edit so the `/result`
    /// long-poll can await it, IFF `request_id` matches.
    /// `None` for no/stale slot or an already-taken receiver (the bridge makes
    /// exactly one `/result` per `open`, so this is taken at most once) — the caller
    /// then answers a no-op `{cancelled}`. The slot stays in the map so a pending
    /// `submit` still finds the sender to resolve.
    pub fn take_edit_receiver(
        &self,
        session: &str,
        request_id: &str,
    ) -> Option<oneshot::Receiver<EditResult>> {
        let mut map = self.pending_edits.lock().unwrap_or_else(|e| e.into_inner());
        let pending = map.get_mut(session)?;
        if pending.request_id != request_id {
            return None;
        }
        pending.rx.take()
    }

    /// Resolve the in-flight edit for `session` IFF its `request_id` matches.
    /// Returns `true` when the matching pending edit
    /// was found + resolved (the slot is removed); `false` for no pending edit or a
    /// stale `request_id` (a stale dashboard tab submitting an old id) — the caller
    /// answers 409/410. Sending on the oneshot wakes the `/result` long-poll.
    pub fn resolve_edit(&self, session: &str, request_id: &str, result: EditResult) -> bool {
        let mut map = self.pending_edits.lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(session) {
            Some(pending) if pending.request_id == request_id => {
                if let Some(tx) = pending.tx.take() {
                    let _ = tx.send(result);
                }
                map.remove(session);
                true
            }
            _ => false,
        }
    }

    /// Drop the in-flight edit for `session` IFF its `request_id` still matches.
    /// Used by the `/result` long-poll on timeout so a
    /// later `submit` for the SAME id can't resolve a receiver that has already gone
    /// away (it would no-op anyway, but clearing keeps the registry tidy). A
    /// different id means a newer edit superseded this one — leave it intact.
    pub fn clear_edit_if(&self, session: &str, request_id: &str) {
        let mut map = self.pending_edits.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(session).map(|p| p.request_id == request_id).unwrap_or(false) {
            map.remove(session);
        }
    }

    /// Mark a session as a "Start a team" LEAD: its next (and subsequent) starts
    /// inject the Agent Teams env even when the global pref is OFF. Idempotent.
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
    /// (the loop may still re-create map entries).
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
        // the byte flow re-ticks the detector immediately). The wake is
        // the SAME `Notify` the detector loop parks on, so a byte burst after an
        // idle/waiting lull surfaces `Active` within ~1s regardless of provider or
        // whether Claude hooks are wired, instead of waiting out the 4s/5s tier.
        // The reader derives its tmux target (session vs pane) from the stream
        // itself, so no `Tmux` is passed in.
        //
        // Also hand the SSH ControlMaster pool so a session with
        // `host_id = Some(...)` builds the `SshPtyReader` variant instead of
        // the local FIFO reader; for `host_id = None` (legacy + every local
        // session) the host_pool is never touched.
        stream
            .ensure_started(
                &self.pool,
                self.host_pool.clone(),
                self.pty_heartbeat.clone(),
                self.detector_wake_for(name),
            )
            .await?;
        Ok(stream)
    }

    /// Get (creating, or replacing if dead/mis-targeted) the per-session stream
    /// PINNED to the LEAD's tmux pane id for a session that is currently
    /// hosting an Agent Team. The stream key stays the session `name` (so the
    /// FIFO/log/registry slot + heartbeat key + detector wake remain unchanged
    /// for that session), only the tmux TARGET differs — `Pane(lead_pane_id)`
    /// instead of `Session(name)`. See [`PtyStreamer::for_lead_session`] for
    /// the rebuild semantics and the bug history (the routing bug that lets a
    /// teammate `split-window` silently steal the lead's pipe/send-keys/capture).
    pub async fn pty_for_lead(
        &self,
        name: &str,
        lead_pane_id: &str,
    ) -> anyhow::Result<Arc<PtyStream>> {
        let stream = self.pty.for_lead_session(name, lead_pane_id);
        stream
            .ensure_started(
                &self.pool,
                self.host_pool.clone(),
                self.pty_heartbeat.clone(),
                self.detector_wake_for(name),
            )
            .await?;
        Ok(stream)
    }

    /// Get (creating on first use) the live pty stream for a teammate PANE
    /// and ensure its FIFO reader is running. `stream_key` is a
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
                self.host_pool.clone(),
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
    /// sentinel (`now − 5min`) when the reader has recorded nothing yet.
    /// The status detector feeds this into `StatusDetector::detect`.
    pub fn last_pty(&self, name: &str) -> Instant {
        self.pty_heartbeat
            .get(name)
            .map(|e| *e.value())
            .unwrap_or_else(|| Instant::now() - COLD_START_PTY_IDLE)
    }

    /// Fold a Claude `SettingsHook` event for `name` into its per-session
    /// [`TurnState`] at the current instant. Called by `/api/_internal/hook`
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

    /// The current per-session [`TurnState`] snapshot for `name`. Fed into
    /// `StatusDetector::detect` as the apex signal; a never-seen session returns
    /// the empty default (non-decisive, so the bank/heartbeat decide).
    pub fn turn_state(&self, name: &str) -> TurnState {
        self.last_hook.get(name).map(|e| *e.value()).unwrap_or_default()
    }

    /// Reset the per-session turn state machine to empty. Called on `SessionStart`
    /// (a brand-new Claude process must NOT inherit the previous one's in-progress
    /// turn) and `SessionEnd` (the turn is over). The in-memory `TurnState`
    /// otherwise survives a session restart (it's only dropped on delete), so a
    /// turn left with `turn_start > turn_end` (the old process was killed before a
    /// clean `Stop`, or a dangling `SubagentStop`) would pin the freshly-booted,
    /// idle session `Active` until the 15-min `TURN_SAFETY` bound. Dropping the
    /// entry makes [`turn_state`](Self::turn_state) return the empty default, so
    /// the detector classifies the new session from scratch (content + heartbeat).
    pub fn reset_turn_state(&self, name: &str) {
        self.last_hook.remove(name);
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

    // ── live activity + error (IN-MEMORY ONLY) ───────────────────────────────

    /// The current in-memory [`SessionActivity`] for `name`, or
    /// `None` when the session has no activity/error to surface. Read by
    /// `SessionView`. Cheap clone of a tiny struct.
    pub fn session_activity(&self, name: &str) -> Option<SessionActivity> {
        self.session_activity.get(name).map(|e| e.value().clone())
    }

    /// Mutate `name`'s activity snapshot with `f`, then prune the entry if it is
    /// empty. Returns `true` IFF the snapshot actually changed — the endpoint
    /// broadcasts a `sessions` delta only on a real change ("keep it
    /// cheap, only on change"). The whole op is a single short critical section.
    fn mutate_activity(&self, name: &str, f: impl FnOnce(&mut SessionActivity)) -> bool {
        let mut entry = self
            .session_activity
            .entry(name.to_string())
            .or_default();
        let before = entry.value().clone();
        f(entry.value_mut());
        let changed = entry.activity != before.activity
            || entry.activity_kind != before.activity_kind
            || entry.error != before.error
            || entry.subagents != before.subagents;
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

    /// A Task sub-agent started → bump the live outstanding count (display-only).
    /// Returns whether it changed (for the change-only SSE broadcast).
    pub fn inc_subagents(&self, name: &str) -> bool {
        self.mutate_activity(name, |a| {
            a.subagents = a.subagents.saturating_add(1);
        })
    }

    /// A Task sub-agent finished → decrement, saturating at 0 so more stops than
    /// starts (a missed/duplicated hook) can never underflow. Returns whether it
    /// changed.
    pub fn dec_subagents(&self, name: &str) -> bool {
        self.mutate_activity(name, |a| {
            a.subagents = a.subagents.saturating_sub(1);
        })
    }

    /// Reset the outstanding-subagent count to 0 — on a new prompt (a fresh turn)
    /// and force-applied on the main `Stop`/`SessionEnd` (the authoritative turn
    /// end, which bounds any drift to a single turn and makes the "finished"
    /// notification gate fail-safe). Returns whether it changed.
    pub fn reset_subagents(&self, name: &str) -> bool {
        self.mutate_activity(name, |a| {
            a.subagents = 0;
        })
    }

    /// The live outstanding-subagent count for `name` (0 when no entry).
    pub fn subagents(&self, name: &str) -> u32 {
        self.session_activity
            .get(name)
            .map(|e| e.subagents)
            .unwrap_or(0)
    }

    /// Force `name`'s status via the lifecycle override: the detector
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

    /// Record `name`'s current status for the adaptive-cadence hot-set.
    /// Called by the detector loop every tick. When the session is
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
    /// working/loading sessions? Membership earns the 1s preview
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
    /// updates ("within 1s").
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

    /// The per-session status watch sender (get-or-create), seeded `("unknown", 0)`.
    /// The detector `send_replace`s `(status, ver+1)` on a status
    /// change; `agents::wait` subscribes for the long-poll. A single shared sender
    /// per session means every waiter and the detector rendezvous on one channel —
    /// the watch receiver always holds the latest value, so there is no
    /// notify-before-subscribe race.
    pub fn status_watch_for(&self, name: &str) -> watch::Sender<StatusUpdate> {
        self.status_watch
            .entry(name.to_string())
            .or_insert_with(|| watch::channel(("unknown".to_string(), 0)).0)
            .clone()
    }

    /// The human-readable reason to put in a web-push notification body for
    /// `name` transitioning into `status`. Generic by design:
    /// a parallel worker is enriching a per-session blocked
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

    /// Drop every per-session in-memory map entry for `name` (cleanup
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
        // Abort any pending debounce timer so a deleted session can't fire a
        // push 2-15s later for a session row that no longer exists. The
        // timer task's own re-read would land `Ok(None)` and skip the send,
        // but the AbortHandle would still leak until process exit.
        if let Some((_, h)) = self.pending_pushes.remove(name) {
            h.abort();
        }
        self.cadence_recency
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(name);
        // Resolve + drop any in-flight external edit so its `/result` long-poll
        // wakes (Cancelled) instead of waiting out the server-side timeout
        // against a forgotten session.
        if let Some(pending) = self
            .pending_edits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(name)
        {
            if let Some(tx) = pending.tx {
                let _ = tx.send(EditResult::Cancelled);
            }
        }
        self.pty.forget(name);
    }

    /// Evict a teammate PANE stream keyed by its stream key
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
        // Carry the debounce handle across the rename: a rename mid-debounce
        // would otherwise leak the handle under `old` and never fire (the
        // task's own re-read uses the captured task_name, which is the old
        // name, and `db::sessions::runtime(old)` returns `None` after the
        // rename → silent drop). Moving the handle keeps the slot keyed to
        // the live row; the task itself still queries under the old name and
        // skips, but at least the slot doesn't leak.
        if let Some((_, v)) = self.pending_pushes.remove(old) {
            self.pending_pushes.insert(new.to_string(), v);
        }
        {
            let mut rec = self.cadence_recency.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(v) = rec.remove(old) {
                rec.insert(new.to_string(), v);
            }
        }
        {
            let mut edits = self.pending_edits.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(v) = edits.remove(old) {
                edits.insert(new.to_string(), v);
            }
        }
        self.pty.rename(old, new);
    }
}

/// RAII guard for a per-session background loop. Increment happens
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
    //! Adaptive-cadence hot-set ranking. Drives the pure
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

#[cfg(test)]
mod pending_edit_tests {
    //! The in-flight native-editor handoff registry.
    //! `register_edit`/`resolve_edit`/`clear_edit_if` are pure synchronous map ops
    //! over an in-memory `AppState` (a temp DB only because `new` needs a pool), so
    //! the request-id matching + one-in-flight-per-session + supersede rules are
    //! pinned without driving real HTTP or tmux.

    use super::*;
    use crate::config::Config;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-edit-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    #[tokio::test]
    async fn matching_submit_resolves_the_long_poll() {
        let (state, dir) = test_state().await;
        state.register_edit("w1", "req-1".into());
        // The `/result` long-poll takes the receiver to await.
        let mut rx = state.take_edit_receiver("w1", "req-1").expect("receiver");

        // A matching submit resolves the receiver with the edited text.
        assert!(state.resolve_edit("w1", "req-1", EditResult::Text("hello".into())));
        match rx.try_recv() {
            Ok(EditResult::Text(t)) => assert_eq!(t, "hello"),
            other => panic!("expected Text(hello), got {other:?}"),
        }
        // The slot is gone — a repeat submit is a no-op (stale, → 409 at the route).
        assert!(!state.resolve_edit("w1", "req-1", EditResult::Cancelled));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stale_request_id_does_not_resolve() {
        let (state, dir) = test_state().await;
        state.register_edit("w1", "req-1".into());
        let mut rx = state.take_edit_receiver("w1", "req-1").expect("receiver");
        // A stale id can't take the receiver either.
        assert!(state.take_edit_receiver("w1", "other-id").is_none());

        // A submit carrying the WRONG id (a stale dashboard tab) is ignored, and the
        // genuine receiver stays pending (not yet resolved).
        assert!(!state.resolve_edit("w1", "other-id", EditResult::Text("x".into())));
        assert!(matches!(rx.try_recv(), Err(oneshot::error::TryRecvError::Empty)));

        // The correct id still resolves it.
        assert!(state.resolve_edit("w1", "req-1", EditResult::Cancelled));
        assert!(matches!(rx.try_recv(), Ok(EditResult::Cancelled)));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn second_open_supersedes_the_prior_as_cancelled() {
        let (state, dir) = test_state().await;
        state.register_edit("w1", "req-1".into());
        let mut first = state.take_edit_receiver("w1", "req-1").expect("first receiver");
        // A second open for the same session supersedes the first (one in-flight
        // per session): the prior receiver resolves Cancelled, the new one is live.
        state.register_edit("w1", "req-2".into());
        let mut second = state.take_edit_receiver("w1", "req-2").expect("second receiver");
        assert!(matches!(first.try_recv(), Ok(EditResult::Cancelled)));

        // The OLD id can no longer resolve the new edit.
        assert!(!state.resolve_edit("w1", "req-1", EditResult::Text("late".into())));
        // The new id does.
        assert!(state.resolve_edit("w1", "req-2", EditResult::Text("new".into())));
        match second.try_recv() {
            Ok(EditResult::Text(t)) => assert_eq!(t, "new"),
            other => panic!("expected Text(new), got {other:?}"),
        }

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn clear_edit_if_only_clears_the_matching_id() {
        let (state, dir) = test_state().await;
        state.register_edit("w1", "req-1".into());
        // A timeout for a stale id must NOT clear a newer edit.
        state.clear_edit_if("w1", "old-id");
        assert!(state.resolve_edit("w1", "req-1", EditResult::Cancelled));

        // Re-register, then clear with the matching id → the slot is gone.
        state.register_edit("w1", "req-2".into());
        state.clear_edit_if("w1", "req-2");
        assert!(!state.resolve_edit("w1", "req-2", EditResult::Cancelled));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

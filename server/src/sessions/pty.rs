//! Per-session live pty stream (TECH_PLAN §3.2.7, REMOTE_PLAN §RT3).
//!
//! Each running session has one [`PtyStream`]. It drives a single reader that
//! fans pane output out to every WebSocket subscriber via a
//! `tokio::sync::broadcast` channel, while keeping a bounded replay buffer so a
//! freshly-connected (or reconnecting) client can be brought up to date
//! immediately.
//!
//! **Reader trait (RT3).** The reader half is now a [`PtyReader`] trait with
//! two implementations:
//!
//! * [`LocalPtyReader`] — today's logic verbatim: `mkfifo` on this host, attach
//!   `pipe-pane`, open the FIFO read end `O_RDONLY | O_NONBLOCK` via
//!   [`nix::fcntl::open`], wrap it in [`tokio::io::unix::AsyncFd`] (epoll
//!   readiness, never blocks a worker), and hold a second `O_WRONLY |
//!   O_NONBLOCK` keep-alive write fd so transient tmux-side writer closes
//!   don't surface as spurious EOFs (Linux pipe trick).
//! * [`SshPtyReader`] — the remote-host version: `mkfifo` on the remote via
//!   the host's SSH ControlMaster, attach `pipe-pane` over the same Transport,
//!   then spawn TWO long-lived `ssh` children that share the master — a
//!   `cat <fifo>` reader (whose stdout streams into the same `PtySink`) and a
//!   `sh -c 'exec 9> <fifo>; while sleep 60; do :; done'` keep-alive writer
//!   that holds the remote write fd open so the reader never sees a spurious
//!   EOF when tmux's tee momentarily closes. The same Linux pipe trick — just
//!   teleported across SSH.
//!
//! **Sink invariants.** Both readers feed the SAME [`PtySink`] (the existing
//! broadcast + replay + wake-on-edge triple), so everything downstream of the
//! sink — the WS fan-out, the 1013 lag-drop, the 32-subscriber cap, the
//! status-detector wake — is BYTE-FOR-BYTE identical regardless of where the
//! pane lives.
//!
//! **Spawn-once (Eng concurrency #1).** [`PtyStream::ensure_started`] is
//! idempotent and race-safe via [`tokio::sync::OnceCell`]: many concurrent
//! subscribers may call it, but only one mkfifos + `pipe-pane`s + spawns the
//! reader. When the reader exits (tmux gone), the stream is flagged dead so the
//! [`crate::ws::streamer::PtyStreamer`] rebuilds a fresh one on the next connect.

use std::collections::VecDeque;
use std::io::Read;
use std::os::fd::{FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use bytes::Bytes;
use dashmap::DashMap;
use nix::fcntl::OFlag;
use nix::sys::stat::Mode;
use once_cell::sync::Lazy;
use regex::Regex;
use sqlx::SqlitePool;
use tokio::io::unix::AsyncFd;
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::{broadcast, Notify, OnceCell};

use super::host_pool::HostPool;
use super::status::Status;
use super::tmux::{Tmux, TmuxTarget};
use super::transport::{HostId, Transport};

/// Replay buffer hard cap. Bounded ring buffer per session: the reader evicts
/// from the front to stay under this size, so steady-state memory is capped at
/// ~`REPLAY_CAP` per live session regardless of how much output a long-running
/// pane produces. Raised from the original 64 KB to 512 KB so a freshly-attached
/// client can scroll back through substantially more history. Because the replay
/// is a ONE-TIME send on connect (not part of steady-state fan-out), a larger
/// cap only affects the initial attach cost, not per-byte streaming overhead.
const REPLAY_CAP: usize = 512 * 1024;

/// Per-FIFO read chunk size.
const READ_CHUNK: usize = 8192;

/// STATLAT — silent→active edge threshold for the detector-wake. A byte batch
/// is treated as a "resume" edge (and wakes the detector loop to re-tick within
/// ~1s) only when the previous batch was at least this long ago — i.e. the pane
/// had genuinely gone quiet. Matched to the detector's `PTY_ACTIVE_WINDOW`
/// (1.5s, the window within which fresh bytes already read `Active`): below it
/// the detector would classify `Active` on its own next tick anyway, so an
/// extra wake would be redundant; at/above it the session has slowed to the
/// 2s/4s/5s tiers, so the wake is what restores the sub-second resume. Keeping
/// it equal to the detector window means we never wake for output the detector
/// already counts as live (no wake storm on a chatty pane).
const PTY_RESUME_EDGE: Duration = Duration::from_millis(1500);

/// SSH reader liveness poll interval. Same cadence as the local reader's
/// `tmux has-session` poll (every 3s): bounded by the per-call cost (one
/// sub-ms `ssh -O check` against the warm ControlMaster) and the maximum
/// stream-death detection latency (3s end-to-end). The local reader can get
/// away with a kernel pipe EOF wake-up; SSH cannot (the writer half is on
/// the remote), so we poll on a timer.
const SSH_LIVENESS_POLL: Duration = Duration::from_secs(3);

/// Maximum wall-clock we wait for the ControlMaster to come back up after the
/// SSH reader child dies. We poll [`HostPool::transport_for`] (which warms the
/// master if needed) every [`SSH_RESPAWN_POLL`] within this budget. 30s covers
/// a master that just needs a re-warm (sub-second on Tailscale) plus headroom
/// for a real network blip; longer than this we treat the stream as dead so
/// WS clients reconnect against a fresh attempt.
const SSH_RESPAWN_BUDGET: Duration = Duration::from_secs(30);

/// How often we re-poll `host_pool.transport_for` while waiting for the
/// ControlMaster to come back. 250ms keeps the warm path snappy (sub-second
/// reconnect on a healthy master) without spamming `-O check` during a real
/// outage.
const SSH_RESPAWN_POLL: Duration = Duration::from_millis(250);

type Replay = RwLock<VecDeque<Bytes>>;

/// One pane's live stream: reader + broadcast fan-out + replay buffer.
///
/// **Stream KEY vs tmux TARGET (Agent Teams §3.5).** `name` is the pane-unique
/// STREAM KEY: a bare session name for a supermux session, or a pane-unique id
/// (`%id` / `{lead}/{member}`) for an agent-team teammate pane. It keys the
/// registry, the FIFO/log filenames, and the heartbeat map. `target` is what tmux
/// actually addresses — `supermux-<name>` for a session, `%id` for a pane — so a
/// teammate stream can share the lead's window yet keep its OWN FIFO/log/registry
/// entry instead of clobbering the lead's.
pub struct PtyStream {
    /// Pane-unique STREAM KEY (NOT necessarily `supermux-` prefixed): a bare
    /// session name OR a teammate pane id / `{lead}/{member}`.
    pub name: String,
    /// What tmux addresses for this stream (`Session(name)` or `Pane(%id)`). The
    /// reader rebuilds its [`Tmux`] from this, so a pane stream pipes/captures the
    /// teammate pane, not `supermux-<name>`.
    pub target: TmuxTarget,
    /// FIFO path — pane-unique (derived from `name`) so a teammate never shares
    /// the lead's FIFO. On a remote session this path lives on the REMOTE host.
    pub fifo: PathBuf,
    /// Durable on-disk capture (tee target) — pane-unique (derived from `name`).
    /// On a remote session this path lives on the REMOTE host.
    pub log: PathBuf,
    /// Bounded replay snapshot (≤`REPLAY_CAP`), pushed by the reader, read on subscribe.
    pub replay: Arc<Replay>,
    /// Fan-out sender. Capacity is `config.ws.broadcast_capacity` (default 1024);
    /// a `send` with zero subscribers returns `Err` and is intentionally dropped.
    pub broadcast: broadcast::Sender<Bytes>,
    /// `false` once the reader task has exited (tmux gone / fatal read error) OR
    /// the stream was explicitly [`shutdown`](Self::shutdown) on a session
    /// restart. The streamer rebuilds a not-alive stream on the next attach.
    alive: Arc<AtomicBool>,
    /// Explicit shutdown signal for the reader loop. Fired by
    /// [`shutdown`](Self::shutdown) when a *session* stop/restart kills the old
    /// tmux pane: it makes the reader exit NOW (closing its broadcast so any
    /// already-open WS's `rx.recv()` returns `Closed` and the client reconnects)
    /// instead of waiting out the ≤3s liveness poll — and that poll wouldn't even
    /// fire here, because a restart recreates the SAME tmux session name, so
    /// `tmux has-session` keeps reporting `true` while the reader's `pipe-pane`
    /// stays bound to the now-dead ORIGINAL pane. The same `Notify` the reader
    /// loop parks on.
    shutdown: Arc<Notify>,
    /// Spawn-once gate for `ensure_started`.
    started: OnceCell<()>,
}

impl PtyStream {
    /// Construct an un-started SESSION stream (no FIFO/pipe-pane yet — that's
    /// `ensure_started`). The tmux target defaults to `Session(name)` so existing
    /// callers keep streaming `supermux-<name>` unchanged. `broadcast_capacity`
    /// comes from `config.ws`.
    pub fn new(name: String, fifo: PathBuf, log: PathBuf, broadcast_capacity: usize) -> Self {
        let target = TmuxTarget::Session(name.clone());
        Self::new_with_target(name, target, fifo, log, broadcast_capacity)
    }

    /// Construct an un-started stream against an explicit tmux `target` (Agent
    /// Teams §3.5). For a teammate pane pass `TmuxTarget::Pane("%id")` with a
    /// pane-unique `name` (the stream key + FIFO/log basename) so the teammate
    /// stream never clobbers the lead's.
    pub fn new_with_target(
        name: String,
        target: TmuxTarget,
        fifo: PathBuf,
        log: PathBuf,
        broadcast_capacity: usize,
    ) -> Self {
        // Drop the initial receiver so `receiver_count()` reflects ONLY live WS
        // subscribers (used for the per-session cap check).
        let (tx, _rx) = broadcast::channel(broadcast_capacity.max(1));
        Self {
            name,
            target,
            fifo,
            log,
            replay: Arc::new(RwLock::new(VecDeque::new())),
            broadcast: tx,
            alive: Arc::new(AtomicBool::new(true)),
            shutdown: Arc::new(Notify::new()),
            started: OnceCell::new(),
        }
    }

    /// Build a [`Tmux`] handle for this stream's target (session or pane), on
    /// the given transport. The reader uses this to seed (capture-pane) +
    /// attach (pipe-pane) + poll liveness (has-session / list-panes) — local
    /// readers thread `&LOCAL`, the SSH reader threads its own `&Transport::Ssh`.
    fn tmux_on<'a>(&'a self, transport: &'a Transport) -> Tmux<'a> {
        match &self.target {
            TmuxTarget::Session(n) => Tmux::new_on(transport, n),
            TmuxTarget::Pane(id) => Tmux::for_pane_on(transport, &self.name, id.clone()),
        }
    }

    /// True until the reader task exits OR the stream is [`shutdown`](Self::shutdown).
    /// The streamer rebuilds dead streams.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    /// Mark this stream dead NOW and tell its reader loop to exit. Called when a
    /// *session* stop/restart kills the underlying tmux pane so the next
    /// [`PtyStreamer::for_session`] rebuilds a fresh stream bound to the NEW pane
    /// (fresh FIFO + `pipe-pane` + replay seed), rather than reusing this one —
    /// which is still pointed at the OLD, now-dead pane and would replay its stale
    /// last frame forever. Flipping `alive` first makes a racing `for_session`
    /// rebuild immediately; waking `shutdown` makes the reader return so its
    /// broadcast closes and any already-open WS reconnects to the new pane.
    ///
    /// This is the SESSION-restart path only. A SERVER restart never calls this:
    /// the new process starts with an empty stream registry and rebuilds on the
    /// first attach against the surviving tmux session — so session-survival is
    /// untouched.
    pub fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
        self.shutdown.notify_waiters();
    }

    /// Active WS subscriber count = live `broadcast::Receiver`s.
    pub fn subscriber_count(&self) -> usize {
        self.broadcast.receiver_count()
    }

    /// Current replay snapshot + a fresh receiver, taken atomically against the
    /// reader: snapshot AND `subscribe()` happen under the replay read lock, and
    /// the reader pushes-then-broadcasts under the write lock (see
    /// [`push_and_broadcast`]). The two locks are mutually exclusive, so a byte in
    /// flight lands in exactly one of {snapshot, receiver} — never lost, never
    /// duplicated.
    pub fn subscribe(&self) -> (Vec<Bytes>, broadcast::Receiver<Bytes>) {
        let q = read_lock(&self.replay);
        let snapshot: Vec<Bytes> = q.iter().cloned().collect();
        let rx = self.broadcast.subscribe();
        drop(q);
        (snapshot, rx)
    }

    /// Last `n` lines of the replay buffer, ANSI-stripped (CEO #1 fast-path for
    /// the `SessionSummary` preview without a fresh `capture-pane`).
    pub fn tail(&self, n: usize) -> Vec<String> {
        let mut all = Vec::new();
        for chunk in read_lock(&self.replay).iter() {
            all.extend_from_slice(chunk);
        }
        let text = String::from_utf8_lossy(&all);
        let stripped = ANSI_RE.replace_all(&text, "");
        let lines: Vec<String> = stripped.lines().map(str::to_string).collect();
        let start = lines.len().saturating_sub(n);
        lines[start..].to_vec()
    }

    /// Idempotently set up the reader (exactly once) for this session. Errors
    /// if the tmux session is not running; on error the `OnceCell` stays
    /// uninitialised so a later call retries.
    ///
    /// The reader implementation is chosen from the session's `host_id`:
    ///
    /// * `host_id = None` (or pane stream) → [`LocalPtyReader`] (today's path,
    ///   unchanged).
    /// * `host_id = Some(id)` → [`SshPtyReader`] over the host's ControlMaster
    ///   (REMOTE_PLAN §RT3). Pane streams are always local — a teammate pane
    ///   lives in the LEAD's tmux session, which (today) is always local.
    ///
    /// `pool` is handed to the reader task so that when the reader exits because
    /// tmux died (the "stream-dead" path), it can flip the session's persisted
    /// status to `stopped` — a session that dies WHILE the server runs must not
    /// stay stuck `active` in the overview.
    ///
    /// `host_pool` is the SSH ControlMaster pool. For LOCAL streams it is
    /// unused; for SSH streams the reader holds an `Arc<HostPool>` so that on a
    /// ControlMaster bounce (RT2 auto-recovery) it can call
    /// `host_pool.transport_for(id)` to re-resolve the warm Transport without
    /// caring how the master was respawned.
    ///
    /// `pty_heartbeat` is the same `DashMap` the M5a status detector reads via
    /// [`AppState::last_pty`](crate::state::AppState::last_pty). The reader writes
    /// `Instant::now()` here on every byte batch so the detector's heartbeat
    /// branch (§3.6 fusion rule #3: "bytes <1.5s → `Active`") actually fires.
    /// Without this wire-up the heartbeat sits at the cold-start sentinel
    /// forever and the regex bank is the detector's only decisive signal — a
    /// session whose prompt the bank doesn't recognise stays stuck at its
    /// boot-time status, producing the "always grey" overview bug.
    ///
    /// `detector_wake` is this session's detector loop wake handle (the SAME
    /// `Notify` the loop parks on). The reader fires it ONCE on a silent→active
    /// EDGE — when a byte batch arrives after the heartbeat had gone stale (the
    /// pane was quiet) — so an idle/waiting session that resumes output re-ticks
    /// the detector immediately and flips to `Active` within ~1s, instead of
    /// waiting out the 4s/5s low-activity tier (STATLAT). It is NOT fired on every
    /// batch: a continuously streaming pane keeps its heartbeat fresh, so the edge
    /// condition is false and no wake storm occurs — the loop is already on the 1s
    /// hot tier handling it. This makes the sub-second resume universal (every
    /// provider + every input path: REST `/send`, the WS terminal, an agent's own
    /// resumed output), not just the Claude-hook path.
    pub async fn ensure_started(
        &self,
        pool: &SqlitePool,
        host_pool: Arc<HostPool>,
        pty_heartbeat: Arc<DashMap<String, Instant>>,
        detector_wake: Arc<Notify>,
    ) -> Result<()> {
        self.started
            .get_or_try_init(|| self.spawn_reader(pool, host_pool, pty_heartbeat, detector_wake))
            .await
            .map(|_| ())
    }

    /// Resolve the session's transport (local or SSH) and dispatch to the right
    /// [`PtyReader`]. Pane streams (teammates) are always local — their `name`
    /// is a pane-unique key, not a `sessions` row, so we never look it up.
    async fn resolve_reader(
        &self,
        pool: &SqlitePool,
        host_pool: &Arc<HostPool>,
    ) -> Result<Box<dyn PtyReader>> {
        // Teammate pane streams: always local (lead's tmux is local today).
        if self.target.is_pane() {
            return Ok(Box::new(LocalPtyReader::new(self)));
        }
        // Look up the session row to find its host_id (RT4: `Option<i64>`,
        // NULL = local). Missing → caller's bug, but treat as local rather
        // than failing (the legacy path).
        let session = match crate::db::sessions::get(pool, &self.name).await {
            Ok(Some(s)) => s,
            Ok(None) => {
                tracing::debug!(name = %self.name, "ensure_started: no session row, defaulting to LOCAL transport");
                return Ok(Box::new(LocalPtyReader::new(self)));
            }
            Err(e) => return Err(anyhow!("looking up session '{}': {e}", self.name)),
        };
        match session.host_id {
            None => Ok(Box::new(LocalPtyReader::new(self))),
            Some(host_id) => Ok(Box::new(SshPtyReader::new(
                self,
                host_pool.clone(),
                HostId(host_id),
            ))),
        }
    }

    /// The one-time setup: resolve reader by transport, build the sink, and
    /// launch the reader task. Wraps the reader's `run` in a join handler so
    /// every reader (local or SSH) shares the alive-flag + stream-dead
    /// persistence semantics.
    async fn spawn_reader(
        &self,
        pool: &SqlitePool,
        host_pool: Arc<HostPool>,
        pty_heartbeat: Arc<DashMap<String, Instant>>,
        detector_wake: Arc<Notify>,
    ) -> Result<()> {
        let reader = self.resolve_reader(pool, &host_pool).await?;

        // Pre-flight: capture a screen snapshot so the replay isn't black on
        // first connect (same rationale as today's local path). For SSH this
        // runs over the ControlMaster; for local it's a fast in-process exec.
        // Best-effort: failure means we fall back to "blank until next byte".
        let seed = self.seed_screen(&host_pool, pool).await;

        if let Some(seed) = seed {
            push_and_broadcast(&self.replay, &self.broadcast, seed);
        }

        let sink = PtySink {
            broadcast: self.broadcast.clone(),
            replay: self.replay.clone(),
            wake_on_edge: detector_wake.clone(),
            pty_heartbeat: pty_heartbeat.clone(),
            shutdown: self.shutdown.clone(),
            name: self.name.clone(),
        };

        let alive = self.alive.clone();
        let pool_clone = pool.clone();
        let name = self.name.clone();
        let is_pane = self.target.is_pane();
        tokio::spawn(async move {
            let reason = match reader.run(sink).await {
                Ok(()) => ExitReason::StreamDead,
                Err(ReaderExit::Shutdown) => ExitReason::Shutdown,
                Err(ReaderExit::Dead) => ExitReason::StreamDead,
                Err(ReaderExit::Fatal(e)) => {
                    tracing::warn!(session = %name, error = %e, "pty reader fatal");
                    ExitReason::StreamDead
                }
            };
            alive.store(false, Ordering::Release);
            tracing::debug!(session = %name, ?reason, "pty reader exited");
            // On a genuine stream-dead, persist `stopped`. On shutdown (a
            // SESSION restart rotated this stream), `lifecycle::start` owns
            // the status writes — DO NOT touch them or we'd clobber the
            // freshly-bumped `active`. Pane streams have no DB row.
            if matches!(reason, ExitReason::StreamDead) && !is_pane {
                if let Err(e) =
                    crate::db::sessions::set_last_status(&pool_clone, &name, Status::Stopped.as_str()).await
                {
                    tracing::warn!(session = %name, error = %e, "pty stream-dead: set_last_status failed");
                }
            }
        });
        Ok(())
    }

    /// Best-effort pre-seed of the replay buffer with the current visible
    /// screen — runs `tmux capture-pane -p -e` over whatever transport the
    /// session uses. A capture failure (transport down, session just spawned,
    /// permission error) is treated as "skip the seed" rather than an error
    /// because the live stream itself will populate the replay as bytes flow.
    async fn seed_screen(&self, host_pool: &Arc<HostPool>, pool: &SqlitePool) -> Option<Bytes> {
        // Pick the same transport the reader will use, but ONLY for the
        // capture — we don't store the Transport on the stream itself, and a
        // failed transport_for here just falls back to "no seed".
        let transport_arc: Option<Arc<Transport>> = if self.target.is_pane() {
            None
        } else {
            match crate::db::sessions::get(pool, &self.name).await {
                Ok(Some(s)) => match s.host_id {
                    None => None,
                    Some(h) => host_pool.transport_for(h).await.ok(),
                },
                _ => None,
            }
        };

        let tmux = match &transport_arc {
            Some(arc) => self.tmux_on(arc),
            None => self.tmux_on(&Transport::Local),
        };
        match tmux.capture_screen_ansi().await {
            Ok(s) if !s.trim_end().is_empty() => {
                let body = s.trim_end_matches('\n').replace('\n', "\r\n");
                Some(Bytes::from(format!("\x1b[2J\x1b[3J\x1b[H{body}")))
            }
            _ => None,
        }
    }
}

// ── PtyReader trait + supporting types ──────────────────────────────────────

/// What the reader writes into. Owned by `PtyStream` and handed to the reader
/// at `run` time. All downstream invariants (broadcast lag-drop, 32-subscriber
/// cap, replay ring buffer, status-detector wake) are baked into this struct +
/// the [`push_and_broadcast`] helper — readers never touch them directly, they
/// only call `forward_chunk`.
pub struct PtySink {
    pub broadcast: broadcast::Sender<Bytes>,
    pub replay: Arc<Replay>,
    /// Detector wake for the silent→active resume edge (STATLAT).
    pub wake_on_edge: Arc<Notify>,
    /// M5a heartbeat — stamp on every batch so the status detector reads
    /// `Active` off byte flow.
    pub pty_heartbeat: Arc<DashMap<String, Instant>>,
    /// Reader exits when this fires (a SESSION stop/restart). Both reader
    /// impls park on this in their main loop alongside their I/O.
    pub shutdown: Arc<Notify>,
    /// The STREAM KEY (session name OR pane key) — used for the heartbeat map
    /// + log lines.
    pub name: String,
}

impl PtySink {
    /// Push `chunk` to the replay buffer + broadcast + heartbeat + wake-on-edge,
    /// preserving every downstream invariant (atomic snapshot vs subscribe,
    /// bounded ring buffer, lag-drop on slow subscribers, edge-only detector
    /// wake). Readers call this for every chunk they read.
    pub fn forward_chunk(&self, chunk: Bytes) {
        push_and_broadcast(&self.replay, &self.broadcast, chunk);
        let now = Instant::now();
        let prev = self.pty_heartbeat.insert(self.name.clone(), now);
        if is_resume_edge(prev, now) {
            self.wake_on_edge.notify_one();
        }
    }
}

/// How a [`PtyReader`] terminated. The `Ok(())` path means "the tmux session is
/// genuinely gone" — the stream is dead, persist `stopped`. The `Err` variants
/// distinguish a session-restart shutdown (don't clobber start()'s status
/// writes) from a fatal error (treated like stream-dead).
#[derive(Debug)]
pub enum ReaderExit {
    /// `PtyStream::shutdown` was called — a SESSION stop/restart rotated this
    /// stream. The reader returns this so the spawn body knows NOT to write
    /// `stopped` (the concurrent `lifecycle::start` owns the status).
    Shutdown,
    /// The stream is dead (tmux pane gone). Persist `stopped`.
    Dead,
    /// An unrecoverable error in the reader. Treated like stream-dead.
    Fatal(anyhow::Error),
}

/// Reader trait. One implementation per transport — `LocalPtyReader` for local
/// sessions (today's FIFO + AsyncFd + keep-alive write fd pattern), and
/// `SshPtyReader` for sessions whose tmux lives on a remote host (REMOTE_PLAN
/// §RT3).
///
/// **Self-healing contract.** `run` must return ONLY when the stream is
/// genuinely dead (the tmux session is gone, the FIFO is permanently
/// unreadable, or `PtySink::shutdown` was fired). On recoverable failures
/// (e.g. an SSH ControlMaster bounce) the implementation MUST internally
/// retry — never bubble those up.
#[async_trait]
pub trait PtyReader: Send + 'static {
    /// Spawn the reader and run it to completion. Returns `Ok(())` on a clean
    /// stream-death (tmux gone); returns `Err(ReaderExit::Shutdown)` on an
    /// explicit `PtyStream::shutdown` (don't write `stopped`); returns
    /// `Err(ReaderExit::Fatal)` on a genuinely unrecoverable failure.
    async fn run(self: Box<Self>, sink: PtySink) -> std::result::Result<(), ReaderExit>;
}

// ── LocalPtyReader (today's logic, moved verbatim) ──────────────────────────

/// The local-FIFO reader. `mkfifo` on this host + `O_RDONLY | O_NONBLOCK`
/// reader + a keep-alive `O_WRONLY | O_NONBLOCK` write fd that suppresses
/// spurious EOFs when tmux's tee momentarily closes. The reader loop drains
/// the FIFO via [`AsyncFd`] and polls `tmux has-session` every 3s to detect
/// genuine pane death.
pub struct LocalPtyReader {
    name: String,
    target: TmuxTarget,
    fifo: PathBuf,
    log: PathBuf,
}

impl LocalPtyReader {
    fn new(stream: &PtyStream) -> Self {
        Self {
            name: stream.name.clone(),
            target: stream.target.clone(),
            fifo: stream.fifo.clone(),
            log: stream.log.clone(),
        }
    }

    fn tmux_local(&self) -> Tmux<'_> {
        match &self.target {
            TmuxTarget::Session(n) => Tmux::new(n),
            TmuxTarget::Pane(id) => Tmux::for_pane(&self.name, id.clone()),
        }
    }
}

#[async_trait]
impl PtyReader for LocalPtyReader {
    async fn run(self: Box<Self>, sink: PtySink) -> std::result::Result<(), ReaderExit> {
        let tmux = self.tmux_local();

        // Liveness: a SESSION uses `has-session`; a teammate PANE must check
        // pane membership. The pane case is pre-validated by the WS handler
        // before it ever calls here.
        if !tmux.is_pane() && !tmux.exists().await.unwrap_or(false) {
            return Err(ReaderExit::Fatal(anyhow!(
                "session '{}' is not running",
                self.name
            )));
        }

        if let Some(parent) = self.log.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Some(parent) = self.fifo.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }

        // mkfifo (idempotent — ignore EEXIST).
        if let Err(e) = nix::unistd::mkfifo(&self.fifo, Mode::S_IRUSR | Mode::S_IWUSR) {
            if e != nix::errno::Errno::EEXIST {
                return Err(ReaderExit::Fatal(anyhow!(
                    "mkfifo {}: {e}",
                    self.fifo.display()
                )));
            }
        }

        // Attach the pipe; retry briefly (5×100ms) for transient tmux contention.
        let mut last_err = None;
        let mut piped = false;
        for _ in 0..5 {
            match tmux.pipe_pane_to_fifo(&self.log, &self.fifo).await {
                Ok(()) => {
                    piped = true;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
        if !piped {
            return Err(ReaderExit::Fatal(
                last_err.unwrap_or_else(|| anyhow!("pipe-pane failed")),
            ));
        }

        // Open the read end NON-BLOCKING (succeeds immediately even with no
        // writer), then a keep-alive writer (succeeds now that a reader exists)
        // to suppress spurious EOFs. nix 0.29's `open` returns a raw fd; take
        // ownership immediately so the fds close on drop.
        let rfd = nix::fcntl::open(
            &self.fifo,
            OFlag::O_RDONLY | OFlag::O_NONBLOCK,
            Mode::empty(),
        )
        .map_err(|e| ReaderExit::Fatal(anyhow!("open fifo (rd) {}: {e}", self.fifo.display())))?;
        let wfd = nix::fcntl::open(
            &self.fifo,
            OFlag::O_WRONLY | OFlag::O_NONBLOCK,
            Mode::empty(),
        )
        .map_err(|e| ReaderExit::Fatal(anyhow!("open fifo (wr) {}: {e}", self.fifo.display())))?;
        // SAFETY: both fds are freshly returned by `open` and owned by us alone.
        let file = unsafe { std::fs::File::from_raw_fd(rfd) };
        let _keep_writer = unsafe { OwnedFd::from_raw_fd(wfd) };
        let async_fd = AsyncFd::new(file)
            .map_err(|e| ReaderExit::Fatal(anyhow!("AsyncFd::new: {e}")))?;

        local_reader_loop(async_fd, &tmux, &sink).await
    }
}

/// The epoll-driven read loop for the LOCAL FIFO. Drains the FIFO into the
/// sink and polls `tmux target_alive` every 3s to detect a real pane death
/// (the keep-alive write fd suppresses EOFs, so death never surfaces as an
/// FD event).
async fn local_reader_loop(
    async_fd: AsyncFd<std::fs::File>,
    tmux: &Tmux<'_>,
    sink: &PtySink,
) -> std::result::Result<(), ReaderExit> {
    let mut buf = [0u8; READ_CHUNK];

    let mut liveness = tokio::time::interval(SSH_LIVENESS_POLL);
    liveness.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    liveness.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            _ = sink.shutdown.notified() => {
                tracing::debug!(session = %sink.name, "pty reader shutdown (session restart)");
                return Err(ReaderExit::Shutdown);
            }
            readable = async_fd.readable() => {
                let mut guard = match readable {
                    Ok(g) => g,
                    Err(e) => {
                        tracing::warn!(session = %sink.name, error = ?e, "asyncfd readable failed");
                        return Err(ReaderExit::Dead);
                    }
                };
                match guard.try_io(|inner| inner.get_ref().read(&mut buf)) {
                    Ok(Ok(0)) => {
                        // True EOF (rare given the keep-alive writer). Confirm the
                        // session/pane is gone before tearing down.
                        if !tmux.target_alive().await {
                            return Ok(());
                        }
                        guard.clear_ready();
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    Ok(Ok(n)) => {
                        sink.forward_chunk(Bytes::copy_from_slice(&buf[..n]));
                    }
                    Ok(Err(e)) => {
                        tracing::warn!(session = %sink.name, error = ?e, "fifo read error");
                        return Err(ReaderExit::Dead);
                    }
                    Err(_would_block) => {}
                }
            }
            _ = liveness.tick() => {
                if !tmux.target_alive().await {
                    tracing::warn!(session = %sink.name, "tmux target gone, stream-dead");
                    return Ok(());
                }
            }
        }
    }
}

// ── SshPtyReader (REMOTE_PLAN §RT3) ─────────────────────────────────────────

/// The SSH-FIFO reader. Spawns a remote `mkfifo`, attaches a remote `pipe-pane`
/// that writes into the remote FIFO via `tee`, then runs TWO long-lived
/// `tokio::process::Child` over the host's ControlMaster:
///
/// * **READER**: `ssh -o ControlPath=<cp> -- cat <fifo>` — stdout streams into
///   the sink in 8 KB chunks.
/// * **KEEP-ALIVE WRITER**: `ssh -o ControlPath=<cp> -- sh -c
///   'exec 9>"$0"; while sleep 60; do :; done' <fifo>` — holds the remote write
///   fd open so the reader doesn't see EOF when tmux's tee briefly closes
///   (the SSH analogue of the Linux pipe keep-alive trick).
///
/// **Failure handling.** The reader self-heals across a ControlMaster bounce:
/// if its `ssh cat` child exits but the remote tmux session is still alive, it
/// polls `host_pool.transport_for(id)` for up to 30s waiting for the master to
/// come back, then respawns the cat child. The keep-alive writer is monitored
/// independently — if it dies it gets respawned too. The replay buffer is NOT
/// cleared on respawn, so a reconnecting WS client sees the historical bytes
/// intact (per the RT3 invariant: "stream resumes — replay is intact, new
/// bytes still flow").
///
/// `run` returns `Ok(())` ONLY when the remote tmux session is genuinely gone
/// (confirmed via `Tmux::exists` over the transport).
pub struct SshPtyReader {
    name: String,
    target: TmuxTarget,
    fifo: PathBuf,
    log: PathBuf,
    host_pool: Arc<HostPool>,
    host_id: HostId,
}

impl SshPtyReader {
    fn new(stream: &PtyStream, host_pool: Arc<HostPool>, host_id: HostId) -> Self {
        // The LOCAL stream.fifo/.log live under the server's data dir and are
        // meaningless on the remote. Translate to the REMOTE convention —
        // `~/.supermux-remote/pty-<name>.fifo` / `.log` — using the stream key
        // (which is filename-safe via `sanitize_key`, so the remote path has
        // no shell metacharacters: safe for ssh argv-flattening into the
        // remote shell). The `~/.supermux-remote/` directory is created on
        // the remote by RT8's bootstrap, so we don't `mkdir -p` here.
        let (fifo, log) = Self::remote_paths(&stream.name);
        Self {
            name: stream.name.clone(),
            target: stream.target.clone(),
            fifo,
            log,
            host_pool,
            host_id,
        }
    }

    /// The remote FIFO + log paths for a stream key. Pure / testable — the
    /// SSH path's argv tests construct an SshPtyReader without spinning up a
    /// HostPool by reaching for these directly.
    ///
    /// Uses `~/.supermux-remote/pty-<name>.{fifo,log}`: literal `~/` (NOT
    /// shell-expanded by us) so the remote shell expands it once when the
    /// argv reaches sh on the other side. Don't pre-resolve `$HOME` from the
    /// local environment — the remote user's home is what matters.
    fn remote_paths(name: &str) -> (PathBuf, PathBuf) {
        let fifo = PathBuf::from(format!("~/.supermux-remote/pty-{name}.fifo"));
        let log = PathBuf::from(format!("~/.supermux-remote/pty-{name}.log"));
        (fifo, log)
    }

    /// Ensure the remote FIFO exists. Idempotent — any non-zero exit from
    /// `mkfifo` is treated as "already there" (the common EEXIST), matching
    /// the local path's behaviour. Errors only when the transport itself
    /// fails to spawn (e.g. ssh binary missing).
    async fn ensure_remote_fifo(transport: &Transport, fifo: &Path) -> Result<()> {
        let fifo_str = fifo.to_string_lossy().to_string();
        let out = transport
            .spawn_command("mkfifo", &[&fifo_str])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .output()
            .await
            .with_context(|| format!("spawning remote mkfifo {fifo:?}"))?;
        // Non-zero exit = EEXIST or unwritable; the latter we'll discover when
        // `pipe-pane` fails. Don't fail here just on the exit code.
        let _ = out;
        Ok(())
    }

    /// Spawn the `ssh ... cat <fifo>` reader child over the current Transport's
    /// ControlMaster. `Stdin` is set to null so the remote `cat` doesn't try
    /// to forward our local terminal; `stderr` is piped so a meaningful error
    /// is captured if the child dies; `stdout` is piped — that's the byte
    /// stream we drain into the sink.
    fn spawn_cat_child(transport: &Transport, fifo: &Path) -> Result<Child> {
        let fifo_str = fifo.to_string_lossy().to_string();
        let child = transport
            .spawn_command("cat", &[&fifo_str])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("spawning ssh cat {fifo:?}"))?;
        Ok(child)
    }

    /// Spawn the keep-alive writer child. The remote `sh -c 'exec 9> "$0";
    /// while sleep 60; do :; done' <fifo>` opens fd 9 onto the FIFO for write
    /// and parks forever, holding the write end open so the reader's `cat`
    /// never sees EOF when tmux's tee momentarily closes its write fd. We
    /// don't read this child's stdout; just hold its `Child` so it stays
    /// alive as long as we do, and `start_kill` it on drop.
    fn spawn_keepalive_child(transport: &Transport, fifo: &Path) -> Result<Child> {
        let fifo_str = fifo.to_string_lossy().to_string();
        // Use $0 trick so the FIFO path is one positional arg — no shell
        // metacharacter concerns.
        let script = r#"exec 9>"$0"; while sleep 60; do :; done"#;
        let child = transport
            .spawn_command("sh", &["-c", script, &fifo_str])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("spawning ssh keepalive writer for {fifo:?}"))?;
        Ok(child)
    }

}

/// Spawn a short-lived task that drains `child.stdout` into a chunks mpsc and
/// signals EOF/error via a oneshot. Returns the receiver halves. The spawned
/// task is automatically dropped when its stdout closes — the main loop
/// observes either the mpsc producing chunks or the oneshot firing.
///
/// **Why a spawned task.** Holding a `&mut Child` across awaits inside
/// `tokio::select!` is incompatible with also assigning a NEW child to the
/// same slot on respawn (borrow checker complains). Moving the stdout pipe
/// into a separate task severs that borrow — the main loop only ever holds
/// the channel halves, while the child handle itself is freely mutable.
fn spawn_stdout_drain(
    child: &mut Child,
) -> (
    tokio::sync::mpsc::Receiver<Bytes>,
    tokio::sync::oneshot::Receiver<()>,
) {
    // Small channel — backpressure here is fine; the upstream `cat` will
    // pause its writes when the kernel pipe buffer fills, and tmux's tee
    // keeps buffering. The replay buffer is the real backpressure boundary.
    let (chunks_tx, chunks_rx) = tokio::sync::mpsc::channel::<Bytes>(64);
    let (eof_tx, eof_rx) = tokio::sync::oneshot::channel();
    let stdout = child.stdout.take();
    tokio::spawn(async move {
        let Some(mut stdout) = stdout else {
            let _ = eof_tx.send(());
            return;
        };
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if chunks_tx
                        .send(Bytes::copy_from_slice(&buf[..n]))
                        .await
                        .is_err()
                    {
                        // Main loop dropped its receiver — give up.
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = eof_tx.send(());
    });
    (chunks_rx, eof_rx)
}

/// `true` iff `keepalive` is `Some(child)` AND that child has exited (so we
/// should respawn it) OR `None` (so we should try to spawn it). `false` only
/// when the child exists AND is still running.
fn keepalive_dead(keepalive: &mut Option<Child>) -> bool {
    match keepalive {
        None => true,
        Some(k) => matches!(k.try_wait(), Ok(Some(_)) | Err(_)),
    }
}

#[async_trait]
impl PtyReader for SshPtyReader {
    async fn run(self: Box<Self>, sink: PtySink) -> std::result::Result<(), ReaderExit> {
        // Resolve the transport. If the master isn't up, transport_for warms
        // it; if the host is unreachable after the full backoff, we return
        // Fatal (the WS layer surfaces the error to clients).
        let transport = match self.host_pool.transport_for(self.host_id.0).await {
            Ok(t) => t,
            Err(e) => {
                return Err(ReaderExit::Fatal(
                    e.context(format!("resolving SSH transport for host {}", self.host_id.0)),
                ));
            }
        };

        // Confirm the remote tmux session exists BEFORE we mkfifo / pipe-pane.
        // Without this a typo'd session would silently leave us hanging on
        // `cat <fifo>` forever.
        let tmux = match &self.target {
            TmuxTarget::Session(n) => Tmux::new_on(&transport, n),
            TmuxTarget::Pane(id) => Tmux::for_pane_on(&transport, &self.name, id.clone()),
        };
        if !tmux.is_pane() && !tmux.exists().await.unwrap_or(false) {
            return Err(ReaderExit::Fatal(anyhow!(
                "remote tmux session '{}' is not running on host {}",
                self.name,
                self.host_id.0
            )));
        }

        // Ensure the remote FIFO exists (idempotent — EEXIST is fine).
        if let Err(e) = Self::ensure_remote_fifo(&transport, &self.fifo).await {
            return Err(ReaderExit::Fatal(e));
        }

        // Attach the remote pipe (5×100ms backoff for tmux contention, mirrors
        // the local path).
        let mut last_err = None;
        let mut piped = false;
        for _ in 0..5 {
            match tmux.pipe_pane_to_fifo(&self.log, &self.fifo).await {
                Ok(()) => {
                    piped = true;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
        if !piped {
            return Err(ReaderExit::Fatal(
                last_err.unwrap_or_else(|| anyhow!("remote pipe-pane failed")),
            ));
        }

        // Spawn the long-lived keep-alive writer ONCE up front, so the FIFO
        // has a writer holding it open before we spawn the cat reader. The
        // keep-alive is monitored alongside the reader and respawned if it
        // dies.
        let mut keepalive = match Self::spawn_keepalive_child(&transport, &self.fifo) {
            Ok(c) => Some(c),
            Err(e) => {
                tracing::warn!(session = %self.name, error = %e, "keepalive spawn failed (continuing — cat will respawn on EOF)");
                None
            }
        };

        // Spawn the cat reader.
        let cat = match Self::spawn_cat_child(&transport, &self.fifo) {
            Ok(c) => c,
            Err(e) => {
                if let Some(mut k) = keepalive.take() {
                    let _ = k.start_kill();
                }
                return Err(ReaderExit::Fatal(e));
            }
        };

        // Hand off to the inner loop which OWNS both children. The loop
        // structure is "drain stdout to a channel via a spawned task, the
        // main loop selects on channel + shutdown + liveness" so we never
        // hold concurrent &mut borrows of the children while also assigning
        // to them.
        let result = self.run_inner(&sink, cat, keepalive, transport).await;

        // Cleanup of any leftover children is handled inside run_inner's
        // termination paths (each respawn replaces the previous; the final
        // values get `start_kill()`'d before run_inner returns).
        result
    }
}

impl SshPtyReader {
    /// The hot loop after both children are spawned + the remote FIFO is wired
    /// up. Drains the cat child's stdout into the sink; on EOF/exit it probes
    /// the remote tmux session via the (possibly stale) Transport — if the
    /// session is GONE, returns `Ok(())` (stream-dead); if the session is
    /// ALIVE, waits up to [`SSH_RESPAWN_BUDGET`] for the ControlMaster to be
    /// responsive (the local HostPool auto-warms it), then respawns the cat
    /// (and the keep-alive if it also died). Replay buffer is NEVER cleared,
    /// so reconnecting WS clients see the bounce as a brief pause.
    ///
    /// **Structure.** Each cat child's stdout is drained by a SHORT-LIVED
    /// `tokio::spawn`ed task that forwards chunks to an mpsc channel + signals
    /// EOF/error via a oneshot. The main loop selects on:
    ///   * mpsc recv → forward chunk to sink (heartbeat + wake);
    ///   * oneshot recv → cat child died, decide respawn vs stream-dead;
    ///   * shutdown.notified() → SESSION restart, return Shutdown;
    ///   * liveness.tick() → periodic tmux probe (catches a hung cat).
    /// This decouples ownership of `cat` from the drain future: we always
    /// own the `Child` value in the outer scope and only the SPAWNED task
    /// holds the stdout pipe.
    async fn run_inner(
        &self,
        sink: &PtySink,
        mut cat: Child,
        mut keepalive: Option<Child>,
        mut transport: Arc<Transport>,
    ) -> std::result::Result<(), ReaderExit> {
        let mut liveness = tokio::time::interval(SSH_LIVENESS_POLL);
        liveness.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        liveness.tick().await;

        // Spawn the first drainer.
        let (mut chunks_rx, mut eof_rx) = spawn_stdout_drain(&mut cat);

        loop {
            tokio::select! {
                biased;

                _ = sink.shutdown.notified() => {
                    let _ = cat.start_kill();
                    if let Some(mut k) = keepalive.take() {
                        let _ = k.start_kill();
                    }
                    return Err(ReaderExit::Shutdown);
                }

                Some(chunk) = chunks_rx.recv() => {
                    sink.forward_chunk(chunk);
                }

                _ = &mut eof_rx => {
                    // Cat child's stdout closed (EOF or error). Decide whether
                    // it's a master bounce (respawn) or a stream-dead (return).
                    let _ = cat.start_kill();

                    // Probe tmux. If the master is wedged, transport_for will
                    // warm it and we get a fresh transport back.
                    let alive = self.probe_tmux_alive(&transport).await
                        || {
                            // Master might just be cold — re-resolve and try once more.
                            if let Ok(t) = self.host_pool.transport_for(self.host_id.0).await {
                                transport = t;
                                self.probe_tmux_alive(&transport).await
                            } else { false }
                        };

                    if !alive {
                        tracing::warn!(session = %sink.name, "remote tmux gone, stream-dead");
                        if let Some(mut k) = keepalive.take() {
                            let _ = k.start_kill();
                        }
                        return Ok(());
                    }

                    // Real bounce — wait for master + respawn.
                    if let Err(e) = self.wait_for_master(&mut transport).await {
                        if let Some(mut k) = keepalive.take() {
                            let _ = k.start_kill();
                        }
                        return Err(ReaderExit::Fatal(e));
                    }

                    // Respawn cat. If the keepalive died too, respawn it.
                    let mut new_cat = match Self::spawn_cat_child(&transport, &self.fifo) {
                        Ok(c) => c,
                        Err(e) => {
                            if let Some(mut k) = keepalive.take() {
                                let _ = k.start_kill();
                            }
                            return Err(ReaderExit::Fatal(e));
                        }
                    };
                    if keepalive_dead(&mut keepalive) {
                        keepalive = Self::spawn_keepalive_child(&transport, &self.fifo).ok();
                    }
                    let (new_chunks_rx, new_eof_rx) = spawn_stdout_drain(&mut new_cat);
                    cat = new_cat;
                    chunks_rx = new_chunks_rx;
                    eof_rx = new_eof_rx;
                }

                _ = liveness.tick() => {
                    // Periodic check — catches a hung cat that never sends EOF.
                    if !self.probe_tmux_alive(&transport).await {
                        // Try a fresh transport before declaring death.
                        let confirmed = match self.host_pool.transport_for(self.host_id.0).await {
                            Ok(t) => {
                                transport = t;
                                !self.probe_tmux_alive(&transport).await
                            }
                            Err(_) => true,
                        };
                        if confirmed {
                            tracing::warn!(session = %sink.name, "remote tmux gone (periodic poll), stream-dead");
                            let _ = cat.start_kill();
                            if let Some(mut k) = keepalive.take() {
                                let _ = k.start_kill();
                            }
                            return Ok(());
                        }
                    }
                    // Also check keepalive — if it died but cat is fine, respawn it.
                    if keepalive_dead(&mut keepalive) {
                        keepalive = Self::spawn_keepalive_child(&transport, &self.fifo).ok();
                        if keepalive.is_none() {
                            tracing::warn!(session = %sink.name, "keepalive respawn failed (will retry next tick)");
                        }
                    }
                }
            }
        }
    }

    /// One-shot tmux liveness probe over `transport`. Mirrors the local
    /// reader's `target_alive` semantics but lets the caller decide what to
    /// do on "gone".
    async fn probe_tmux_alive(&self, transport: &Transport) -> bool {
        let tmux = match &self.target {
            TmuxTarget::Session(n) => Tmux::new_on(transport, n),
            TmuxTarget::Pane(id) => Tmux::for_pane_on(transport, &self.name, id.clone()),
        };
        if tmux.is_pane() {
            tmux.pane_alive().await
        } else {
            tmux.exists().await.unwrap_or(false)
        }
    }

    /// Wait up to [`SSH_RESPAWN_BUDGET`] for the host's ControlMaster to be
    /// responsive again. Polls [`HostPool::transport_for`] (which itself warms
    /// the master if needed) every [`SSH_RESPAWN_POLL`]. On success, swaps the
    /// caller's transport handle to the (possibly new) Arc. On total failure,
    /// returns an error so the caller bubbles to ReaderExit::Fatal.
    async fn wait_for_master(&self, transport: &mut Arc<Transport>) -> Result<()> {
        let deadline = Instant::now() + SSH_RESPAWN_BUDGET;
        let mut last_err: Option<anyhow::Error> = None;
        while Instant::now() < deadline {
            match self.host_pool.transport_for(self.host_id.0).await {
                Ok(t) => {
                    *transport = t;
                    return Ok(());
                }
                Err(e) => {
                    last_err = Some(e);
                    tokio::time::sleep(SSH_RESPAWN_POLL).await;
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("SSH master never came back within {SSH_RESPAWN_BUDGET:?}")))
    }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/// Why a reader returned — distinguishes a genuine pane death (write `stopped`)
/// from an explicit session-restart rotation (leave status to the concurrent
/// [`crate::sessions::lifecycle::start`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExitReason {
    /// The tmux pane is gone / unreadable — propagate `stopped` to the DB.
    StreamDead,
    /// [`PtyStream::shutdown`] was called (a session stop/restart). Do NOT touch
    /// the persisted status; `start` owns it.
    Shutdown,
}

/// Append `chunk` to the replay buffer (evicting from the front to stay
/// ≤`REPLAY_CAP`) and fan it out — both under the replay write lock so it is
/// atomic against [`PtyStream::subscribe`]'s snapshot+subscribe (exactly-once
/// handoff). The `broadcast.send` returns `Err` when there are no subscribers —
/// an intentional drop; new subscribers get the replay snapshot.
fn push_and_broadcast(replay: &Replay, broadcast: &broadcast::Sender<Bytes>, chunk: Bytes) {
    let mut q = write_lock(replay);
    q.push_back(chunk.clone());
    let mut total: usize = q.iter().map(Bytes::len).sum();
    while total > REPLAY_CAP {
        match q.pop_front() {
            Some(front) => total -= front.len(),
            None => break,
        }
    }
    let _ = broadcast.send(chunk);
}

/// CSI escape stripper (SGR colours + cursor moves), mirrors `sessions::preview`.
static ANSI_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());

/// Read-lock that survives a poisoned lock (a panicked reader must not wedge the
/// stream for everyone).
fn read_lock(lock: &Replay) -> std::sync::RwLockReadGuard<'_, VecDeque<Bytes>> {
    lock.read().unwrap_or_else(|p| p.into_inner())
}

fn write_lock(lock: &Replay) -> std::sync::RwLockWriteGuard<'_, VecDeque<Bytes>> {
    lock.write().unwrap_or_else(|p| p.into_inner())
}

/// STATLAT — is this byte batch a silent→active RESUME edge? (pure; testable)
///
/// `prev` is the previous heartbeat instant (`None` = never seen any byte for
/// this session — the first batch is always an edge), `now` is this batch's
/// instant. An edge is when the pane had been quiet for at least
/// [`PTY_RESUME_EDGE`] — i.e. the detector would NOT already be counting the
/// session `Active` off a fresh heartbeat — so the detector loop should be woken
/// to re-tick immediately. Continuous streaming keeps `prev` fresh, so this is
/// `false` on the bulk of batches (no wake storm).
fn is_resume_edge(prev: Option<Instant>, now: Instant) -> bool {
    match prev {
        None => true,
        Some(p) => now.duration_since(p) >= PTY_RESUME_EDGE,
    }
}

#[cfg(test)]
mod resume_edge_tests {
    use super::*;

    #[test]
    fn first_ever_batch_is_an_edge() {
        // No prior heartbeat (cold session whose reader just produced its first
        // byte) → always wake so the very first output flips Unknown/Idle → Active.
        assert!(is_resume_edge(None, Instant::now()));
    }

    #[test]
    fn batch_after_a_long_quiet_is_an_edge() {
        // The pane was quiet well past the active window (an idle/waiting session
        // resuming) → wake the detector now (the STATLAT fix).
        let now = Instant::now();
        let prev = now - (PTY_RESUME_EDGE + Duration::from_millis(500));
        assert!(is_resume_edge(Some(prev), now));
    }

    #[test]
    fn edge_at_exact_threshold() {
        // Boundary: a gap of exactly PTY_RESUME_EDGE counts as an edge (≥), so a
        // session that slowed to the tier boundary still gets the prompt re-tick.
        let now = Instant::now();
        let prev = now - PTY_RESUME_EDGE;
        assert!(is_resume_edge(Some(prev), now));
    }

    #[test]
    fn continuous_stream_is_not_an_edge() {
        // Bytes flowing within the active window (a chatty, already-Active pane) →
        // NOT an edge, so no wake storm: the detector already reads it Active off
        // the fresh heartbeat and is on the 1s hot tier draining it.
        let now = Instant::now();
        let prev = now - (PTY_RESUME_EDGE / 2);
        assert!(!is_resume_edge(Some(prev), now));
    }
}

#[cfg(test)]
mod shutdown_tests {
    //! Restart-reattach (the `shutdown` invalidation path). A fresh `PtyStream`
    //! reports `is_alive() == true` so `PtyStreamer::for_session` reuses it;
    //! after `shutdown` it reports `false`, which is exactly the signal
    //! `for_session` keys on to REBUILD a fresh stream bound to the new pane on
    //! the next attach. (The reader half is exercised end-to-end by the manual
    //! integration check; this pins the alive→dead state transition that drives
    //! the registry's rebuild decision.)

    use super::*;

    fn dummy_stream() -> PtyStream {
        PtyStream::new(
            "shutdown-test".to_string(),
            PathBuf::from("/tmp/supermux-shutdown-test.fifo"),
            PathBuf::from("/tmp/supermux-shutdown-test.log"),
            16,
        )
    }

    #[test]
    fn fresh_stream_is_alive_so_for_session_reuses_it() {
        // A just-built (un-started) stream must read alive — otherwise every
        // attach would needlessly rebuild.
        assert!(dummy_stream().is_alive());
    }

    #[test]
    fn shutdown_marks_stream_dead_so_for_session_rebuilds() {
        // The restart invalidation contract: after shutdown the stream is no
        // longer alive, so `for_session` builds a fresh one (new pane) instead of
        // replaying the dead pane's stale frame.
        let s = dummy_stream();
        assert!(s.is_alive());
        s.shutdown();
        assert!(!s.is_alive());
    }

    #[test]
    fn shutdown_is_idempotent() {
        // Both stop() and a freshly_spawned start() may invalidate; a double
        // shutdown must stay safely dead, never panic.
        let s = dummy_stream();
        s.shutdown();
        s.shutdown();
        assert!(!s.is_alive());
    }
}

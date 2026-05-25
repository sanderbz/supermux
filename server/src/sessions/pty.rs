//! Per-session live pty stream (TECH_PLAN §3.2.7).
//!
//! Each running session has one [`PtyStream`]. It drives a single FIFO reader
//! that fans pane output out to every WebSocket subscriber via a
//! `tokio::sync::broadcast` channel, while keeping a bounded replay buffer so a
//! freshly-connected (or reconnecting) client can be brought up to date
//! immediately.
//!
//! **FIFO open pattern (Eng P0 #1 + Codex #2).** The naive
//! `tokio::fs::File::open(fifo)` blocks the kernel `open(2)` until a writer
//! connects — blocking an entire tokio worker thread. Instead we open the read
//! end `O_RDONLY | O_NONBLOCK` via [`nix::fcntl::open`], wrap it in
//! [`tokio::io::unix::AsyncFd`] (epoll readiness, never blocks a worker), and
//! hold a second `O_WRONLY | O_NONBLOCK` keep-alive write fd so transient
//! tmux-side writer closes don't surface as spurious EOFs (Linux pipe trick).
//!
//! **Spawn-once (Eng concurrency #1).** [`PtyStream::ensure_started`] is
//! idempotent and race-safe via [`tokio::sync::OnceCell`]: many concurrent
//! subscribers may call it, but only one mkfifos + `pipe-pane`s + spawns the
//! reader. When the reader exits (tmux gone), the stream is flagged dead so the
//! [`crate::ws::streamer::PtyStreamer`] rebuilds a fresh one on the next connect.

use std::collections::VecDeque;
use std::io::Read;
use std::os::fd::{FromRawFd, OwnedFd};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use dashmap::DashMap;
use nix::fcntl::OFlag;
use nix::sys::stat::Mode;
use once_cell::sync::Lazy;
use regex::Regex;
use sqlx::SqlitePool;
use tokio::io::unix::AsyncFd;
use tokio::sync::{broadcast, Notify, OnceCell};

use super::status::Status;
use super::tmux::Tmux;

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

/// STATLAT — silent→active edge threshold for the detector-wake (see
/// [`reader_loop`]). A byte batch is treated as a "resume" edge (and wakes the
/// detector loop to re-tick within ~1s) only when the previous batch was at least
/// this long ago — i.e. the pane had genuinely gone quiet. Matched to the
/// detector's `PTY_ACTIVE_WINDOW` (1.5s, the window within which fresh bytes
/// already read `Active`): below it the detector would classify `Active` on its
/// own next tick anyway, so an extra wake would be redundant; at/above it the
/// session has slowed to the 2s/4s/5s tiers, so the wake is what restores the
/// sub-second resume. Keeping it equal to the detector window means we never wake
/// for output the detector already counts as live (no wake storm on a chatty
/// pane).
const PTY_RESUME_EDGE: Duration = Duration::from_millis(1500);

type Replay = RwLock<VecDeque<Bytes>>;

/// One session's live stream: FIFO reader + broadcast fan-out + replay buffer.
pub struct PtyStream {
    /// Bare session name (NOT `supermux-` prefixed).
    pub name: String,
    /// `/tmp/supermux-pty-<name>.fifo` — the pane→reader FIFO.
    pub fifo: PathBuf,
    /// `<data_dir>/logs/<name>.log` — durable on-disk capture (tee target).
    pub log: PathBuf,
    /// Bounded replay snapshot (≤`REPLAY_CAP`), pushed by the reader, read on subscribe.
    pub replay: Arc<Replay>,
    /// Fan-out sender. Capacity is `config.ws.broadcast_capacity` (default 1024);
    /// a `send` with zero subscribers returns `Err` and is intentionally dropped.
    pub broadcast: broadcast::Sender<Bytes>,
    /// `false` once the reader task has exited (tmux gone / fatal read error).
    alive: Arc<AtomicBool>,
    /// Spawn-once gate for `ensure_started`.
    started: OnceCell<()>,
}

impl PtyStream {
    /// Construct an un-started stream (no FIFO/pipe-pane yet — that's
    /// `ensure_started`). `broadcast_capacity` comes from `config.ws`.
    pub fn new(name: String, fifo: PathBuf, log: PathBuf, broadcast_capacity: usize) -> Self {
        // Drop the initial receiver so `receiver_count()` reflects ONLY live WS
        // subscribers (used for the per-session cap check).
        let (tx, _rx) = broadcast::channel(broadcast_capacity.max(1));
        Self {
            name,
            fifo,
            log,
            replay: Arc::new(RwLock::new(VecDeque::new())),
            broadcast: tx,
            alive: Arc::new(AtomicBool::new(true)),
            started: OnceCell::new(),
        }
    }

    /// True until the reader task exits. The streamer rebuilds dead streams.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
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

    /// Idempotently mkfifo + `pipe-pane` + spawn the reader (exactly once). Errors
    /// if the tmux session is not running; on error the `OnceCell` stays
    /// uninitialised so a later call retries.
    ///
    /// `pool` is handed to the reader task so that when the reader exits because
    /// tmux died (the "stream-dead" path), it can flip the session's persisted
    /// status to `stopped` — a session that dies WHILE the server runs must not
    /// stay stuck `active` in the overview.
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
        tmux: &Tmux<'_>,
        pool: &SqlitePool,
        pty_heartbeat: Arc<DashMap<String, Instant>>,
        detector_wake: Arc<Notify>,
    ) -> Result<()> {
        self.started
            .get_or_try_init(|| self.spawn_reader(tmux, pool, pty_heartbeat, detector_wake))
            .await
            .map(|_| ())
    }

    /// The one-time setup: requires a live session, makes the FIFO, attaches the
    /// `tee` pipe, opens the non-blocking read fd + keep-alive write fd, and
    /// launches the reader task.
    async fn spawn_reader(
        &self,
        tmux: &Tmux<'_>,
        pool: &SqlitePool,
        pty_heartbeat: Arc<DashMap<String, Instant>>,
        detector_wake: Arc<Notify>,
    ) -> Result<()> {
        if !tmux.exists().await.unwrap_or(false) {
            bail!("session '{}' is not running", self.name);
        }

        if let Some(parent) = self.log.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Some(parent) = self.fifo.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }

        // Snapshot the CURRENT visible screen BEFORE attaching the pipe, so the
        // seed's timestamp precedes the first live byte and replay order stays
        // monotonic (seed → live). This is what lets a subscriber that connects
        // before any new output flows still see the screen instead of black —
        // the case session-survival creates: after a server restart the
        // in-memory replay is empty, and `pipe-pane` only carries NEW output, so
        // an idle re-attached pane would otherwise stay blank until it next
        // redraws (and a same-size reconnect never triggers a resize-redraw).
        // Best-effort: a capture failure just means we fall back to the old
        // (blank-until-next-output) behaviour, never an error.
        let seed = match tmux.capture_screen_ansi().await {
            Ok(s) if !s.trim_end().is_empty() => {
                // Clear screen + scrollback + home, then the captured rows with
                // CRLF line ends, so the snapshot renders as a clean screen from
                // the top. Subsequent live bytes redraw over it as the pane changes.
                let body = s.trim_end_matches('\n').replace('\n', "\r\n");
                Some(Bytes::from(format!("\x1b[2J\x1b[3J\x1b[H{body}")))
            }
            _ => None,
        };

        // mkfifo (idempotent — ignore EEXIST).
        if let Err(e) = nix::unistd::mkfifo(&self.fifo, Mode::S_IRUSR | Mode::S_IWUSR) {
            if e != nix::errno::Errno::EEXIST {
                return Err(anyhow!("mkfifo {}: {e}", self.fifo.display()));
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
            return Err(last_err.unwrap_or_else(|| anyhow!("pipe-pane failed")));
        }

        // Open the read end NON-BLOCKING (succeeds immediately even with no
        // writer), then a keep-alive writer (succeeds now that a reader exists)
        // to suppress spurious EOFs. nix 0.29's `open` returns a raw fd; take
        // ownership immediately so the fds close on drop.
        let rfd = nix::fcntl::open(&self.fifo, OFlag::O_RDONLY | OFlag::O_NONBLOCK, Mode::empty())
            .map_err(|e| anyhow!("open fifo (rd) {}: {e}", self.fifo.display()))?;
        let wfd = nix::fcntl::open(&self.fifo, OFlag::O_WRONLY | OFlag::O_NONBLOCK, Mode::empty())
            .map_err(|e| anyhow!("open fifo (wr) {}: {e}", self.fifo.display()))?;
        // SAFETY: both fds are freshly returned by `open` and owned by us alone.
        let file = unsafe { std::fs::File::from_raw_fd(rfd) };
        let keep_writer = unsafe { OwnedFd::from_raw_fd(wfd) };
        let async_fd = AsyncFd::new(file).map_err(|e| anyhow!("AsyncFd::new: {e}"))?;

        // Seed the replay with the pre-pipe screen snapshot (if any) BEFORE the
        // reader task can append a single live byte, so the replay starts with a
        // coherent screen and a connecting subscriber never sees black.
        if let Some(seed) = seed {
            push_and_broadcast(&self.replay, &self.broadcast, seed);
        }

        let name = self.name.clone();
        let replay = self.replay.clone();
        let broadcast = self.broadcast.clone();
        let alive = self.alive.clone();
        let pool = pool.clone();
        tokio::spawn(async move {
            // Hold the write fd open for the lifetime of the reader.
            let _keep_writer = keep_writer;
            reader_loop(
                async_fd,
                &name,
                &replay,
                &broadcast,
                &pty_heartbeat,
                &detector_wake,
            )
            .await;
            alive.store(false, Ordering::Release);
            tracing::debug!(session = %name, "pty reader exited (stream-dead)");
            // Stream-dead means the tmux pane is gone (or unreadable) — propagate
            // that to the session's persisted status so the overview flips it to
            // `stopped` instead of leaving it stuck `active`/`idle`. The 2s
            // detector loop won't fight this: its tick leaves the status
            // untouched when `tmux has-session` fails, so a dead session stays
            // `stopped`. A re-`start` rotates a fresh pty stream and the detector
            // re-classifies it live from there.
            if let Err(e) =
                crate::db::sessions::set_last_status(&pool, &name, Status::Stopped.as_str()).await
            {
                tracing::warn!(session = %name, error = %e, "pty stream-dead: set_last_status failed");
            }
        });
        Ok(())
    }
}

/// The epoll-driven read loop. Drains the FIFO into the replay buffer + broadcast
/// and tears down when the tmux session is gone. Also stamps
/// `pty_heartbeat[name] = Instant::now()` on every byte batch so the M5a status
/// detector's heartbeat branch (§3.6 fusion rule #3) actually fires — without
/// this stamp, `AppState::last_pty` stays at the cold-start sentinel forever
/// and the detector falls through to the regex bank alone, leaving any session
/// whose prompt the bank doesn't recognise stuck at its boot-time status.
async fn reader_loop(
    async_fd: AsyncFd<std::fs::File>,
    name: &str,
    replay: &Replay,
    broadcast: &broadcast::Sender<Bytes>,
    pty_heartbeat: &DashMap<String, Instant>,
    detector_wake: &Notify,
) {
    let tmux = Tmux::new(name);
    let mut buf = [0u8; READ_CHUNK];

    // The keep-alive write fd suppresses EOF, so tmux death never surfaces as an
    // FD event — poll liveness on a timer instead (§3.2.7: terminate when the
    // session is truly gone).
    let mut liveness = tokio::time::interval(Duration::from_secs(3));
    liveness.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    liveness.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            readable = async_fd.readable() => {
                let mut guard = match readable {
                    Ok(g) => g,
                    Err(e) => {
                        tracing::warn!(session = %name, error = ?e, "asyncfd readable failed");
                        break;
                    }
                };
                match guard.try_io(|inner| inner.get_ref().read(&mut buf)) {
                    Ok(Ok(0)) => {
                        // True EOF (rare given the keep-alive writer). Confirm the
                        // session is gone before tearing down.
                        if !tmux.exists().await.unwrap_or(false) {
                            break;
                        }
                        guard.clear_ready();
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    Ok(Ok(n)) => {
                        let chunk = Bytes::copy_from_slice(&buf[..n]);
                        // Push to replay + broadcast atomically (see `subscribe`).
                        push_and_broadcast(replay, broadcast, chunk);
                        // M5a heartbeat (§3.6 fusion rule #3): stamp on every
                        // batch so the detector sees "bytes flowing right now"
                        // and reads Active without needing a regex match.
                        let now = Instant::now();
                        let prev = pty_heartbeat.insert(name.to_string(), now);
                        // STATLAT — silent→active EDGE wake. If the pane had been
                        // quiet (no byte within the detector's active window, or
                        // never seen), this batch is the resume edge: re-tick the
                        // detector NOW so an idle/waiting session flips to `Active`
                        // within ~1s instead of waiting out its 4s/5s low-activity
                        // tier sleep. We only wake on the EDGE — a continuously
                        // streaming pane keeps `prev` fresh, so the condition is
                        // false and there is no wake storm (the loop is already on
                        // the 1s hot tier draining it). `notify_one` parks a permit
                        // if the loop isn't currently waiting, so the wake is never
                        // lost to the gap between ticks.
                        if is_resume_edge(prev, now) {
                            detector_wake.notify_one();
                        }
                        // Keep readiness set to drain any remaining buffered bytes.
                    }
                    Ok(Err(e)) => {
                        tracing::warn!(session = %name, error = ?e, "fifo read error");
                        break;
                    }
                    // try_io cleared readiness on WouldBlock; loop and re-poll.
                    Err(_would_block) => {}
                }
            }
            _ = liveness.tick() => {
                if !tmux.exists().await.unwrap_or(false) {
                    tracing::warn!(session = %name, "tmux session gone, stream-dead");
                    break;
                }
            }
        }
    }
}

/// Append `chunk` to the replay buffer (evicting from the front to stay
/// ≤`REPLAY_CAP`) and fan it out — both under the replay write lock so it is atomic against
/// [`PtyStream::subscribe`]'s snapshot+subscribe (exactly-once handoff). The
/// `broadcast.send` returns `Err` when there are no subscribers — an intentional
/// drop; new subscribers get the replay snapshot.
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

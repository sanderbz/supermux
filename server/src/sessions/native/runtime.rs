//! [`NativeSession`] — the daemon-side handle for one tmux-less session.
//!
//! It owns the VT grid, one socket connection to the session's holder, and the
//! live-byte fan-out that [`super::reader::NativePtyReader`] feeds into the
//! existing `PtySink`.
//!
//! **The pump.** A background task per session keeps the connection up:
//!
//! ```text
//!   connect → HELLO → fresh Vt at the client's geometry (or the holder's)
//!           → replay frames  (rebuild the grid, NOT forwarded to WS clients)
//!           → READY + attach-generation bump   ← captures unblock, clients re-seed
//!           → live frames    (grid + broadcast to subscribers)
//!           → disconnect → back off → connect …
//!           → child EXIT: park until the next `spawn`
//! ```
//!
//! Every (re)connection rebuilds the grid from the spool, so the SAME code path
//! serves three cases that are separate concerns in the tmux design:
//!
//! * first attach after `spawn`,
//! * **deploy survival** — the daemon was replaced (`KillMode=process` left the
//!   holder and its child running), so the new process reconnects and replays,
//! * a lagged/dropped connection — the holder disconnects a daemon that falls
//!   behind rather than blocking the pty, and the replay makes that lossless.
//!
//! Two things make a reconnect invisible to the user rather than merely
//! lossless for the grid: captures/seed WAIT for the replay to drain (`ready`),
//! and every completed attach bumps `attach_gen`, which the WS layer turns into
//! a fresh authoritative seed — otherwise a client attached across the gap would
//! silently miss every byte the replay swallowed.
//!
//! Nothing here writes to the DB or touches session status; the seam slice owns
//! that. The 15 methods below mirror the `Tmux` surface 1:1 so the seam can
//! delegate without translating.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, watch, Mutex as AsyncMutex, Notify};

use super::keys::key_bytes;
use super::vt::{Damage, Vt};
use super::{proto, spool};
use crate::sessions::runtime::TerminalDeath;
use crate::sessions::tmux::HistoryWindow;

/// Live-byte fan-out depth. Same order as the tmux path's broadcast: a
/// subscriber that falls this far behind is lag-dropped downstream.
const BROADCAST_CAP: usize = 1024;
/// First reconnect delay after a failed/closed connection.
const RECONNECT_MIN: Duration = Duration::from_millis(250);
/// Reconnect backoff ceiling (a session whose holder is gone for good).
const RECONNECT_MAX: Duration = Duration::from_secs(5);
/// A connection that lasted this long counts as HEALTHY: the backoff resets.
/// Anything shorter is a flap and backs off, *even when `connect()` itself
/// succeeded* — the production replay storm was six successful attaches in
/// 1.6 s (attach → 8 MiB replay → daemon falls behind → holder lag-drops us →
/// reconnect 250 ms later → …), and a backoff that only reacted to `connect`
/// failures never fired once.
const RECONNECT_STABLE: Duration = Duration::from_secs(30);
/// How long `spawn` waits for the holder to come up and the pump to attach.
const SPAWN_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest `INPUT` payload per frame (well under `proto::MAX_FRAME`).
const INPUT_CHUNK: usize = 256 * 1024;
/// Grace between the polite kill signal and `SIGKILL`.
const KILL_GRACE: Duration = Duration::from_secs(3);
/// Unix socket paths are capped by `sockaddr_un.sun_path` (108 on Linux).
const SOCKET_PATH_MAX: usize = 100;
/// How long a capture/seed/history call waits for a fresh attach's spool replay
/// to finish before answering with whatever grid it has. Bounded on purpose: a
/// slightly stale screen beats a hung HTTP handler, and the attach-generation
/// reseed heals the client either way.
const READY_TIMEOUT: Duration = Duration::from_secs(3);
/// How long an input frame waits for the pump to (re)attach before giving up.
/// A lag-drop reconnect takes [`RECONNECT_MIN`] (250 ms), so a keystroke typed
/// into that window is delivered rather than lost.
const ATTACH_WAIT: Duration = Duration::from_millis(500);
/// Inter-frame gap the native runtime needs between literal text and the Enter
/// that submits it. Text and key would otherwise land in ONE `read()` of the
/// child, and Ink-style TUIs (Claude, Codex) treat that as a paste — the `\r`
/// becomes a composer newline instead of a submit. tmux's two `send-keys`
/// forks had this gap for free; here we reproduce it explicitly.
pub const SUBMIT_GAP: Duration = Duration::from_millis(50);
/// Longest reason string surfaced from the `exit` marker (the rest is dropped —
/// this ends up in a UI badge, not a log).
const MAX_REASON: usize = 200;
/// How far `meta.json`'s `started_at` may differ from the pid's REAL start time
/// (read from `/proc`) before the pid is treated as a DIFFERENT, pid-reused
/// process. The holder writes `meta.json` immediately after `fork`, so the true
/// difference is milliseconds; this window only absorbs clock/`btime` skew
/// (`/proc`'s `starttime` is truncated to whole seconds, and `btime` can move by
/// one under NTP). 5 s is generous for that and narrow enough that a pid reused
/// minutes later can not slip through — the old 120 s window was wide enough to
/// call a stranger "ours" on a busy box that wraps its pid space in that time.
const MAX_START_SKEW: i64 = 5;
/// How long the ATTACH_FROM → HELLO handshake may take before the connection is
/// abandoned. A holder that accepted the socket but never answers (wedged on its
/// own lock, stopped, half-dead) would otherwise hold this session's pump
/// forever: `serve()` sits in `read_frame`, `detached` stays true, and NOTHING
/// times out — the pump is not even flapping, so the backoff loop never runs.
/// Treating the expiry as a disconnect puts it back in that loop.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Panics tolerated from the connection pump before the session is left detached
/// for good (`death()` and the status detector then do their job).
const MAX_PUMP_PANICS: u32 = 3;
/// Panics further apart than this do not count towards [`MAX_PUMP_PANICS`]: one
/// bad escape sequence a day is a transient the restart heals, three in a minute
/// is a session that can not be parsed.
const PUMP_PANIC_WINDOW: Duration = Duration::from_secs(60);

/// POISON-TOLERANT lock for this module's `std::sync::Mutex`es.
///
/// Every one of them guards a plain data structure, and the ONLY way one gets
/// poisoned is a panic in the code holding it — overwhelmingly `Vt::advance`,
/// which parses UNTRUSTED bytes straight off a pty. `lock().unwrap()` turned
/// that into a cascade: the pump task dies on the poison, so it never sets
/// `detached`/`ready` again, and from then on `attached()`, `dead()`, `death()`
/// and the WS attach gate all keep answering "healthy" for a session nothing is
/// serving — the daemon-side shape of the production incident. Recovering the
/// guard costs at worst one malformed grid update.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// One native session: VT grid + holder connection + live fan-out.
pub struct NativeSession {
    name: String,
    /// `<data_dir>/native/<name>` — spool, meta, socket.
    dir: PathBuf,
    socket: PathBuf,
    /// The grid. `std::sync::Mutex` on purpose: every critical section is a
    /// synchronous parse or serialize (sub-ms at realistic sizes), and no
    /// `.await` ever happens while it is held.
    vt: Mutex<Vt>,
    /// Write half of the live holder connection, when attached.
    writer: AsyncMutex<Option<OwnedWriteHalf>>,
    /// Live pty bytes (post-replay) for `PtyReader` subscribers.
    live: broadcast::Sender<Bytes>,
    /// `true` whenever the pump has no connection. Combined with the spool's
    /// `exit` marker to answer `dead()`. Always updated with `send_replace`:
    /// plain `send` is a NO-OP (and an error) when no receiver is currently
    /// held, which would leave `attached()` permanently stale.
    detached: watch::Sender<bool>,
    /// Child pid, learned from `HELLO` (0 = unknown).
    pid: AtomicU32,
    /// Child exit status once an `EXIT` frame or the marker says so.
    exit_code: Mutex<Option<i32>>,
    /// Set when the pump should stop for good (session object dropped, or the
    /// session was deleted/renamed out from under us — see [`Self::stop_pump`]).
    stopped: AtomicBool,
    /// ATTACH GENERATION — bumped once per (re)attach, AFTER the spool replay
    /// has fully drained into the grid.
    ///
    /// A reconnect is lossless for the GRID (the replay rebuilds it) but NOT for
    /// an attached WebSocket: the replay bytes are deliberately not forwarded
    /// (they would re-print history), so the bytes the client missed during the
    /// gap never reach it. Every bump is the signal "the grid is authoritative
    /// again, re-seed" — the WS layer runs the same `send_seed_then_done` an
    /// explicit `Resync` uses, which is what makes the gap self-heal.
    attach_gen: watch::Sender<u64>,
    /// `false` while a fresh attach is still replaying the spool into the grid.
    /// Captures/seed wait for this (bounded by [`READY_TIMEOUT`]) so an attach
    /// can never serve the blank grid a replay is still filling. Also flipped
    /// true when there is nothing to wait FOR (no holder, or the child exited),
    /// so a stopped session never pays the timeout.
    ready: watch::Sender<bool>,
    /// The geometry a client last asked for, kept across a detach so a resize
    /// performed while the holder connection was down is re-applied on the next
    /// attach instead of being overwritten by `HELLO`'s stale size.
    requested_size: Mutex<Option<(u16, u16)>>,
    /// Wakes a pump that parked after the child exited (a fresh [`Self::spawn`]).
    restart: Arc<Notify>,
    /// ABSOLUTE spool offset this daemon has received up to — the base for the
    /// `ATTACH_FROM` handshake, and the reason a reconnect is no longer an
    /// 8 MiB event. Seeded from every `HELLO` (`replay_from`) and advanced by
    /// every `OUTPUT` byte, so it survives across reconnects of this session.
    spool_offset: AtomicU64,
    /// `(pid, started_at)` of the holder the offset belongs to. A DIFFERENT
    /// holder (the session was restarted) means the offset describes somebody
    /// else's spool, so it is discarded and the attach is a full replay.
    spool_epoch: Mutex<Option<(u32, i64)>>,
    /// Abort handle for the connection pump. `forget()` uses it to stop a pump
    /// that is INSIDE `serve()` — there the pump holds a strong `Arc`, so
    /// dropping the map entry alone would leave it running forever.
    pump_handle: Mutex<Option<tokio::task::AbortHandle>>,
}

impl NativeSession {
    /// Build a session handle for `name` and start its connection pump. Does
    /// NOT spawn a holder — call [`Self::spawn`] for that; an EXISTING holder
    /// (deploy survival) is picked up automatically.
    pub fn new(name: &str, data_dir: &Path) -> Arc<Self> {
        let dir = spool::session_dir(data_dir, name);
        let socket = spool::socket_path(data_dir, name);
        let (detached, _) = watch::channel(true);
        let (live, _) = broadcast::channel(BROADCAST_CAP);
        let (attach_gen, _) = watch::channel(0u64);
        let (ready, _) = watch::channel(false);
        let me = Arc::new(Self {
            name: name.to_string(),
            dir,
            socket,
            vt: Mutex::new(Vt::new(80, 24)),
            writer: AsyncMutex::new(None),
            live,
            detached,
            pid: AtomicU32::new(0),
            exit_code: Mutex::new(None),
            stopped: AtomicBool::new(false),
            attach_gen,
            ready,
            requested_size: Mutex::new(None),
            restart: Arc::new(Notify::new()),
            spool_offset: AtomicU64::new(0),
            spool_epoch: Mutex::new(None),
            pump_handle: Mutex::new(None),
        });
        let weak = Arc::downgrade(&me);
        *lock(&me.pump_handle) = Some(supervise_pump(weak));
        me
    }

    /// Session name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Spool/meta/socket directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Subscribe to LIVE pty bytes (replay excluded — a fresh subscriber gets
    /// the current screen from [`Self::seed`], not a re-run of history).
    pub fn subscribe(&self) -> broadcast::Receiver<Bytes> {
        self.live.subscribe()
    }

    /// Watch handle that flips when the pump attaches/detaches — lets a reader
    /// react to holder death without polling.
    pub fn detached_watch(&self) -> watch::Receiver<bool> {
        self.detached.subscribe()
    }

    /// Is the pump currently connected to the holder? (Transient: a reconnect
    /// is normal and lossless. Use [`Self::alive`] for "is the child running".)
    pub fn attached(&self) -> bool {
        !*self.detached.borrow()
    }

    /// Is the GRID authoritative — has ANY holder connection completed its spool
    /// replay since this daemon started?
    ///
    /// A fresh [`NativeSession`] starts with an EMPTY `Vt`. If the pump can not
    /// attach (holder dead, socket gone) the ready gate is released anyway — by
    /// design, so a capture can never hang on a session with nothing serving it —
    /// and every `capture_*` then answers with that blank grid. Persisting that
    /// over a session's stored preview is how a daemon restart blanked the
    /// overview cards of a session whose holder had died (the incident).
    ///
    /// The attach generation is bumped exactly once per COMPLETED attach (after
    /// the replay drained), so `> 0` is precisely "the grid has been rebuilt from
    /// the holder at least once" — and callers that persist a capture must skip
    /// the writeback while this is false.
    pub fn grid_is_authoritative(&self) -> bool {
        *self.attach_gen.borrow() > 0
    }

    /// Watch handle on the ATTACH GENERATION (see the field docs). It ticks once
    /// per completed (re)attach: the grid has just been rebuilt from the spool,
    /// so every attached client must re-seed to pick up the bytes that flowed
    /// while the connection was down.
    pub fn attach_generation(&self) -> watch::Receiver<u64> {
        self.attach_gen.subscribe()
    }

    /// Stop the connection pump for good. Used when the session handle is being
    /// discarded (delete / rename): the pump holds a strong `Arc` for the whole
    /// life of a holder connection, so dropping the registry entry is NOT enough
    /// to stop it.
    ///
    /// Aborting the task drops the socket's READ half; taking the write half
    /// closes the other direction (tokio shuts an `OwnedWriteHalf` down on drop
    /// unless `forget`ten), so the holder sees EOF and releases the slot for a
    /// future daemon. The `try_lock` is best-effort — a writer busy in the
    /// middle of a frame is released anyway when the last `Arc` goes away.
    pub fn stop_pump(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        if let Some(h) = lock(&self.pump_handle).take() {
            h.abort();
        }
        if let Ok(mut g) = self.writer.try_lock() {
            *g = None;
        }
        self.detached.send_replace(true);
        // Nothing can serve this handle any more: never leave a capture waiting.
        self.ready.send_replace(true);
    }

    // ── 1. lifecycle ────────────────────────────────────────────────────────

    /// Launch a holder for this session running `shell` in `dir` with `env`.
    ///
    /// The holder inherits `dir` as its cwd and `env` in its environment, and
    /// the child inherits both from the holder — so nothing sensitive is ever
    /// visible in the holder's argv (`ps`), unlike `tmux new-session -e K=V`.
    ///
    /// The holder is `setsid`-detached, which is what makes it survive a deploy
    /// (`KillMode=process` spares non-daemon processes) and a daemon crash.
    pub async fn spawn(
        &self,
        dir: &Path,
        env: &HashMap<String, String>,
        shell: &str,
    ) -> Result<()> {
        if self.alive().await {
            bail!("native session '{}' is already running", self.name);
        }
        if self.socket.as_os_str().len() > SOCKET_PATH_MAX {
            bail!(
                "native session '{}': socket path {} is too long for a unix socket ({} > {SOCKET_PATH_MAX})",
                self.name,
                self.socket.display(),
                self.socket.as_os_str().len(),
            );
        }
        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("mkdir {}", self.dir.display()))?;
        spool::clear_exit(&self.dir);
        *lock(&self.exit_code) = None;
        // A fresh holder means a BRAND-NEW spool, whose offsets have nothing to
        // do with the ones we accumulated against the previous one. Leaving them
        // behind is how an auto-healed session came back BLANK: the pump asked
        // the new holder to continue from (say) byte 3000, the holder happily
        // answered with a delta from 3000 of ITS spool, and the epoch check then
        // rejected it — after which the session's whole head, `DECSET 1049`
        // included, was simply never applied to the fresh grid.
        self.spool_offset.store(0, Ordering::Relaxed);
        *lock(&self.spool_epoch) = None;
        // A pump parked on the previous child's exit has to come back to life,
        // otherwise nothing would ever connect to the holder we are about to
        // start (and the `detached` wait below would time out).
        self.restart.notify_one();

        let (cols, rows) = {
            let vt = lock(&self.vt);
            (vt.cols(), vt.rows())
        };
        let exe = holder_bin()?;
        let mut cmd = tokio::process::Command::new(exe);
        cmd.arg("pty-holder")
            .arg("--session")
            .arg(&self.name)
            .arg("--dir")
            .arg(&self.dir)
            .arg("--socket")
            .arg(&self.socket)
            .arg("--cols")
            .arg(cols.to_string())
            .arg("--rows")
            .arg(rows.to_string())
            .arg("--")
            .arg(shell)
            .current_dir(dir)
            .envs(env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(false);
        // The pane must NOT inherit the daemon's agent-nesting markers.
        // `envs` above ADDS to the parent environment, so a daemon started from
        // inside a Claude Code pane would hand `CLAUDE_CODE_CHILD_SESSION=1` to
        // every agent it launches — which turns transcript saving OFF, and with
        // no transcript the whole chat plane has nothing to read. `main` already
        // scrubs the daemon's own environ; this is the same rule enforced at the
        // spawn itself, so a var set after boot (or a holder spawned by some
        // future non-main entry point) cannot reintroduce it.
        // See `sessions::lifecycle::AGENT_NESTING_ENV`.
        for key in crate::sessions::lifecycle::AGENT_NESTING_ENV {
            if !env.contains_key(*key) {
                cmd.env_remove(key);
            }
        }
        // SAFETY: `setsid` is async-signal-safe. It detaches the holder from
        // the daemon's session/process group so a signal aimed at the daemon
        // (or its group) can never reach a holder or its agent.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        // The Child is dropped immediately: the holder is intentionally
        // detached, and tokio's orphan queue reaps it if it exits while we run.
        let _child = cmd.spawn().context("spawn pty holder")?;

        // Wait for the holder to bind and the pump to attach.
        let deadline = std::time::Instant::now() + SPAWN_TIMEOUT;
        while std::time::Instant::now() < deadline {
            if !*self.detached.borrow() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        bail!("native session '{}': holder did not come up in time", self.name)
    }

    /// Is the session's child still running?
    pub async fn alive(&self) -> bool {
        !self.dead().await
    }

    /// Has the child exited (or the holder gone away for good)?
    ///
    /// The `exit` marker is authoritative — it outlives both the holder and the
    /// daemon. Otherwise: attached means alive; detached falls back to the
    /// NON-DESTRUCTIVE probe ([`probe_alive`]).
    ///
    /// **Never connect() to answer this.** The holder treats any accepted
    /// connection as the new daemon and evicts the incumbent one (rule 3 in its
    /// module docs), so a "liveness probe" that dials the socket would hijack
    /// the live session — and pay an 8 MiB replay for the privilege. `alive()` /
    /// `dead()` are called on every stop poll, every WS attach and every
    /// detector tick, so that would be a self-inflicted disconnect storm.
    pub async fn dead(&self) -> bool {
        if lock(&self.exit_code).is_some() {
            return true;
        }
        if exit_marker(&self.dir).is_some() {
            return true;
        }
        if !*self.detached.borrow() {
            return false;
        }
        !probe_alive(&self.dir)
    }

    /// WHY this session's terminal is gone — `None` whenever that can not be
    /// PROVEN (it is serving, or its holder is alive and the pump is merely
    /// between two connections).
    ///
    /// This is the signal the status detector turns into a forced `Stopped`.
    /// Before it existed, a holder that died MID-RUN left the session pinned on
    /// whatever status it last had: the boot reconcile probes liveness once at
    /// startup, and the running detector classifies off the CAPTURE, which can
    /// only ever yield active/waiting/idle. The session stayed "active" with a
    /// blank screen until somebody resumed it by hand (the incident).
    ///
    /// [`TerminalDeath::unexpected`] separates the two cases the UI must treat
    /// differently: a child that exited (the ordinary end of a session, or an
    /// explicit `kill`) versus a holder that VANISHED — a crash, an OOM kill, an
    /// out-of-band `SIGKILL` — which is worth showing the user verbatim.
    pub async fn death(&self) -> Option<TerminalDeath> {
        if let Some(code) = *lock(&self.exit_code) {
            return Some(TerminalDeath::exited(code));
        }
        if let Some(marker) = exit_marker(&self.dir) {
            return Some(marker);
        }
        // Serving right now: whatever the filesystem says, this session is live.
        if !*self.detached.borrow() {
            return None;
        }
        // Detached but the holder is up — an ordinary reconnect window, NOT a
        // death. (`probe_alive` also verifies the pid is really ours, so a
        // reused pid can not hold a dead session "alive" here.)
        if probe_alive(&self.dir) {
            return None;
        }
        // Detached, no marker, no live holder. If a holder ever ran we can name
        // it; if none ever did there is nothing to prove and nothing to report.
        let meta = spool::read_meta(&self.dir)?;
        Some(TerminalDeath {
            reason: format!(
                "holder is gone (pid {} left no exit marker — it crashed or was killed)",
                meta.pid,
            ),
            unexpected: true,
        })
    }

    /// Terminate the session: `SIGHUP` to the child's process group (what a
    /// closing terminal sends, and what `tmux kill-session` does), escalating
    /// to `SIGKILL` after [`KILL_GRACE`]. The holder then flushes the spool,
    /// writes the `exit` marker and exits on its own.
    pub async fn kill(&self) -> Result<()> {
        if self.dead().await {
            return Ok(());
        }
        self.signal(libc::SIGHUP).await;
        let deadline = std::time::Instant::now() + KILL_GRACE;
        while std::time::Instant::now() < deadline {
            if self.dead().await {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.signal(libc::SIGKILL).await;
        Ok(())
    }

    /// Deliver `sig` to the child's process group — through the holder when
    /// attached, directly from `meta.json` when not.
    async fn signal(&self, sig: i32) {
        if self
            .send_frame(proto::SIGNAL, &sig.to_be_bytes())
            .await
            .is_ok()
        {
            return;
        }
        if let Some(pid) = self.pane_pid().await {
            // SAFETY: plain libc call; a stale pid yields ESRCH, ignored.
            unsafe {
                libc::killpg(pid as i32, sig);
            }
        }
    }

    // ── 2. input ────────────────────────────────────────────────────────────

    /// Write `text` to the pty LITERALLY — no tmux `send-keys` lexer, so none
    /// of its hazards: no trailing-`;` swallowing, no `ARG_MAX` ceiling, no
    /// paste-buffer detour for large payloads. Callers send `Enter` separately,
    /// exactly as on the tmux path.
    pub async fn send_text(&self, text: &str) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        self.write_input(text.as_bytes()).await
    }

    /// Paste `text`. `bracketed` wraps it in `\x1b[200~ … \x1b[201~` so the
    /// receiving app treats it as ONE paste; unbracketed is a raw literal write
    /// (the shape `send_text` uses, chosen because zsh's `bracketed-paste-magic`
    /// backslash-escapes shell metacharacters and mangles a command).
    pub async fn paste(&self, text: &str, bracketed: bool) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        if !bracketed {
            return self.write_input(text.as_bytes()).await;
        }
        let mut buf = Vec::with_capacity(text.len() + 12);
        buf.extend_from_slice(b"\x1b[200~");
        buf.extend_from_slice(text.as_bytes());
        buf.extend_from_slice(b"\x1b[201~");
        self.write_input(&buf).await
    }

    /// Send a named key (`Enter`, `C-c`, `BTab`, `Up`, …). Arrow/Home/End
    /// encoding follows the app's DECCKM state, read from our own VT.
    pub async fn send_key(&self, key: &str) -> Result<()> {
        let app_cursor = {
            let vt = lock(&self.vt);
            vt.app_cursor()
        };
        let bytes = key_bytes(key, app_cursor)
            .ok_or_else(|| anyhow!("unknown key name '{key}'"))?;
        self.write_input(&bytes).await
    }

    /// Resize the pty (holder → `TIOCSWINSZ` → `SIGWINCH`) and reflow the grid.
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let (cols, rows) = (cols.max(1), rows.max(1));
        // Remember it: `HELLO` reports the holder's CURRENT geometry, which is
        // stale if this resize happened while we were detached (or fails to
        // reach the holder at all). `serve()` re-asserts this size on attach.
        *lock(&self.requested_size) = Some((cols, rows));
        let res = self
            .send_frame(proto::RESIZE, &proto::resize_payload(cols, rows))
            .await;
        // Reflow locally even if the holder is momentarily unreachable: the
        // client's geometry is what the grid must match, and the next attach
        // re-sends the size.
        lock(&self.vt).resize(cols, rows);
        res
    }

    // ── 3. capture / seed ───────────────────────────────────────────────────

    /// `tmux capture-pane -p -S -<lines>` equivalent (plain rows, `\n`-joined).
    pub async fn capture_plain(&self, lines: usize) -> String {
        self.await_ready().await;
        lock(&self.vt).capture_plain(lines)
    }

    /// `tmux capture-pane -pe -S -<lines>` equivalent (SGR rows, `\n`-joined).
    pub async fn capture_ansi(&self, lines: usize) -> String {
        self.await_ready().await;
        lock(&self.vt).capture_ansi(lines)
    }

    /// `tmux capture-pane -p -e` equivalent — the visible screen only.
    pub async fn capture_screen_ansi(&self) -> String {
        self.await_ready().await;
        lock(&self.vt).capture_screen_ansi()
    }

    /// Entire history + viewport, plain (the `archive` dump).
    pub async fn capture_full(&self) -> String {
        self.await_ready().await;
        lock(&self.vt).capture_full()
    }

    /// Alt-screen-aware WS attach seed, built with the same framers the tmux
    /// path uses.
    pub async fn seed(&self) -> String {
        self.await_ready().await;
        lock(&self.vt).seed()
    }

    /// One window of scrollback rows, JSON-compatible with the tmux path's
    /// `HistoryWindow` (same struct, in fact).
    pub async fn history_window(&self, end_offset: i64, count: u32) -> HistoryWindow {
        self.await_ready().await;
        lock(&self.vt).history_window(end_offset, count)
    }

    /// `(history_size, cols)` for the WS `attach_meta` frame.
    pub async fn history_meta(&self) -> (u32, u16) {
        self.await_ready().await;
        lock(&self.vt).history_meta()
    }

    /// The child's pid — from `HELLO` when attached, else from `meta.json`.
    pub async fn pane_pid(&self) -> Option<u32> {
        match self.pid.load(Ordering::Relaxed) {
            0 => spool::read_meta(&self.dir).map(|m| m.pid),
            pid => Some(pid),
        }
    }

    /// Is the pty's FOREGROUND process group the login shell itself — i.e. is
    /// there NO program running in the terminal right now? `None` when it can
    /// not be determined (no pid yet, no `/proc`, an unreadable stat line).
    ///
    /// The holder runs `bash -lc <shell>`, and bash `exec`s a lone final command,
    /// so the child pid IS the interactive shell and also its process-group
    /// leader. The kernel reports the pty's foreground pgid as `tpgid` (field 8
    /// of `/proc/<pid>/stat`), so `tpgid == pid` means "sitting at the shell
    /// prompt" and anything else means "a program (the agent) is running".
    ///
    /// `start()` uses this to decide whether the launch command still needs to be
    /// typed: typing `claude --resume …` into a LIVE agent would inject the
    /// command line into its composer.
    pub async fn shell_is_foreground(&self) -> Option<bool> {
        let pid = self.pane_pid().await?;
        Some(foreground_pgid(pid)? == pid)
    }

    // ── 4. frame coalescing hook ────────────────────────────────────────────

    /// Damaged rows since the last call (alacritty unions damage until it is
    /// read). Exposed for the frame scheduler a later slice will add; nothing
    /// in this slice consumes it.
    pub fn take_damage(&self) -> Damage {
        lock(&self.vt).take_damage()
    }

    /// Test-only: `(absolute spool offset, the holder epoch it belongs to)` —
    /// the two facts the `ATTACH_FROM` handshake is built on, and the two a
    /// fresh [`Self::spawn`] has to forget.
    #[cfg(test)]
    pub(crate) fn spool_position(&self) -> (u64, Option<(u32, i64)>) {
        (self.spool_offset.load(Ordering::Relaxed), *lock(&self.spool_epoch))
    }

    /// The child's exit status, if it has exited.
    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code
            .lock()
            .unwrap()
            .or_else(|| spool::read_exit(&self.dir))
    }

    // ── internals ───────────────────────────────────────────────────────────

    /// Block until the grid is authoritative (no replay in flight), capped at
    /// [`READY_TIMEOUT`]. Returns immediately in the steady state — the flag is
    /// only ever false between a fresh `HELLO` and the end of its replay.
    async fn await_ready(&self) {
        if *self.ready.borrow() {
            return;
        }
        let mut rx = self.ready.subscribe();
        let waited = tokio::time::timeout(READY_TIMEOUT, async {
            while !*rx.borrow_and_update() {
                if rx.changed().await.is_err() {
                    return;
                }
            }
        })
        .await;
        if waited.is_err() {
            tracing::warn!(
                session = %self.name,
                "native: spool replay did not finish in time; serving the partial grid",
            );
        }
    }

    /// The grid is authoritative again: release [`Self::await_ready`] waiters and
    /// bump the attach generation so attached clients re-seed (see `attach_gen`).
    fn attach_ready(&self) {
        self.ready.send_replace(true);
        let next = self.attach_gen.borrow().wrapping_add(1);
        self.attach_gen.send_replace(next);
    }

    /// Chunk + send raw input bytes to the pty.
    async fn write_input(&self, bytes: &[u8]) -> Result<()> {
        for chunk in bytes.chunks(INPUT_CHUNK) {
            self.send_frame(proto::INPUT, chunk).await?;
        }
        Ok(())
    }

    /// Send one frame on the holder connection. A write error drops the
    /// connection so the pump reconnects (and replays).
    ///
    /// When NOT attached this waits up to [`ATTACH_WAIT`] for the pump to come
    /// back rather than failing on the spot: a holder-initiated lag-disconnect
    /// is followed by a reconnect ~250 ms later, and a keystroke typed into that
    /// window used to be dropped with "is not attached to a holder". A WRITE
    /// failure is NOT retried — the frame may have been partially written, and
    /// re-sending it on the new connection could duplicate input into the pty.
    async fn send_frame(&self, kind: u8, payload: &[u8]) -> Result<()> {
        let deadline = std::time::Instant::now() + ATTACH_WAIT;
        let mut detached = self.detached.subscribe();
        loop {
            {
                let mut g = self.writer.lock().await;
                if let Some(w) = g.as_mut() {
                    if let Err(e) = proto::write_frame(w, kind, payload).await {
                        *g = None;
                        self.detached.send_replace(true);
                        return Err(anyhow!(
                            "native session '{}': holder write failed: {e}",
                            self.name
                        ));
                    }
                    return Ok(());
                }
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                bail!("native session '{}' is not attached to a holder", self.name);
            }
            // Wake on the attach edge; the timeout is the backstop for a session
            // whose holder is gone for good.
            let _ = tokio::time::timeout(left, detached.changed()).await;
        }
    }

    /// Serve one holder connection until it closes.
    async fn serve(&self, stream: UnixStream) -> std::io::Result<()> {
        let (rd, mut wr) = stream.into_split();
        let mut rd = tokio::io::BufReader::with_capacity(64 * 1024, rd);

        // 0. Where we left off. The holder answers with just the bytes we
        //    missed when this offset still sits inside its retained spool —
        //    which is what stops a lag-drop from costing a fresh 8 MiB replay
        //    (and that replay from causing the next lag-drop). `0` means "I
        //    have nothing, send the tail"; a holder that predates the handshake
        //    ignores the frame and sends the tail anyway.
        let from = self.spool_offset.load(Ordering::Relaxed);

        // 1. HELLO — geometry + how many replay bytes are coming.
        //
        // BOUNDED. A holder that accepts the socket and then says nothing (its
        // own lock wedged, its accept loop dead, the process stopped) would
        // otherwise park this pump inside `read_frame` for ever: no error, no
        // flap, no backoff, and `detached` stuck true with nothing on its way to
        // fix it. The expiry is treated as an ordinary disconnect, which puts
        // the connection back in the pump's reconnect loop.
        let handshake = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            proto::write_frame(&mut wr, proto::ATTACH_FROM, &proto::attach_from_payload(from))
                .await?;
            match proto::read_frame(&mut rd).await? {
                Some((proto::HELLO, payload)) => {
                    serde_json::from_slice::<proto::Hello>(&payload).map_err(|e| {
                        std::io::Error::new(std::io::ErrorKind::InvalidData, format!("HELLO: {e}"))
                    })
                }
                _ => Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "holder did not send HELLO first",
                )),
            }
        })
        .await;
        let hello: proto::Hello = match handshake {
            Ok(r) => r?,
            Err(_elapsed) => {
                tracing::warn!(
                    session = %self.name,
                    "native: the holder accepted the connection but never sent HELLO — \
                     abandoning it (the pump will reconnect)",
                );
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "holder did not complete the attach handshake",
                ));
            }
        };
        self.pid.store(hello.pid, Ordering::Relaxed);

        // 1b. Is this replay the CONTINUATION we asked for, or a full tail?
        //     Three things must all hold: the holder says it honoured the
        //     offset, it is the same holder our offset was measured against
        //     (a restarted session has a brand-new spool whose offsets mean
        //     something else entirely), and its replay really starts where we
        //     stopped. Anything else is a full tail.
        let epoch = (hello.pid, hello.started_at);
        let same_holder = lock(&self.spool_epoch).replace(epoch) == Some(epoch);
        let delta = hello.delta && same_holder && from > 0 && hello.replay_from == from;
        // A delta we can NOT accept is not a full tail — it is a fragment, and
        // the only thing on its way is the gap the holder picked. Feeding that
        // to a freshly built `Vt` (which is what happens below when `delta` is
        // false) silently throws the session's whole head away: the alt-screen
        // switch, the app's initial paint, the scrollback. The reachable case is
        // a session that was restarted while the daemon kept its old offset —
        // exactly what an auto-heal produces. There is nothing to salvage on
        // THIS connection, so drop it after forgetting the offset: the reconnect
        // asks `from = 0` and is answered with a real, complete tail.
        if hello.delta && !delta {
            self.spool_offset.store(0, Ordering::Relaxed);
            tracing::warn!(
                session = %self.name,
                same_holder,
                asked_from = from,
                replay_from = hello.replay_from,
                "native: the holder answered with a delta we can not apply — \
                 reconnecting for a full tail",
            );
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unusable delta replay (the holder's spool is not the one our offset describes)",
            ));
        }
        // Our position is whatever the holder is about to start streaming from —
        // stated by the holder rather than inferred, so a degraded spool cannot
        // silently skew the count.
        self.spool_offset
            .store(hello.replay_from, Ordering::Relaxed);
        if hello.spool_degraded {
            tracing::warn!(
                session = %self.name,
                dropped = hello.spool_dropped,
                "native: the holder's spool is degraded — its replay may have a hole",
            );
        }

        // 2. The grid. A FULL replay rebuilds it from scratch (the
        //    deploy-survival path); a DELTA continues the grid we already have,
        //    because those bytes are the only ones it is missing.
        //
        //    Geometry: `HELLO` reports what the holder currently has, which is
        //    STALE if a client resized while we were detached (the RESIZE frame
        //    had nowhere to go). The remembered request wins, and is re-sent to
        //    the holder below so the pty and the grid agree.
        let want = *lock(&self.requested_size);
        let (cols, rows) = want.unwrap_or((hello.cols, hello.rows));
        {
            let mut vt = lock(&self.vt);
            if delta {
                vt.resize(cols, rows);
            } else {
                *vt = Vt::new(cols, rows);
            }
        }
        let mut replay_left = hello.replay_bytes;
        if replay_left > 0 {
            // Hold captures until the grid is rebuilt (a seed taken now would be
            // a blank screen with history_size 0).
            self.ready.send_replace(false);
        }

        *self.writer.lock().await = Some(wr);
        self.detached.send_replace(false);
        if (cols, rows) != (hello.cols, hello.rows) {
            let _ = self
                .send_frame(proto::RESIZE, &proto::resize_payload(cols, rows))
                .await;
        }
        if replay_left == 0 {
            self.attach_ready();
        }
        tracing::info!(
            session = %self.name,
            pid = hello.pid,
            replay_bytes = hello.replay_bytes,
            delta,
            replay_from = hello.replay_from,
            cols,
            rows,
            "native: attached to holder",
        );

        // 3. Frames.
        let result = loop {
            match proto::read_frame(&mut rd).await {
                Ok(None) => break Ok(()),
                Err(e) => break Err(e),
                Ok(Some((proto::OUTPUT, payload))) => {
                    lock(&self.vt).advance(&payload);
                    // Our position in the holder's spool: replay and live bytes
                    // alike, because both are spool bytes. This is what the next
                    // `ATTACH_FROM` asks to continue from.
                    self.spool_offset
                        .fetch_add(payload.len() as u64, Ordering::Relaxed);
                    // Replay bytes rebuild the grid but must NOT reach WS
                    // subscribers — they get the current screen from `seed()`.
                    // A frame is either wholly replay or wholly live, but the
                    // split is handled anyway so the boundary can never leak.
                    let live_from = (replay_left as usize).min(payload.len());
                    let was_replaying = replay_left > 0;
                    replay_left -= live_from as u64;
                    if was_replaying && replay_left == 0 {
                        // The grid is whole again. Clients that were attached
                        // across the gap missed every byte we just swallowed —
                        // the generation bump makes them re-seed.
                        self.attach_ready();
                    }
                    if live_from < payload.len() {
                        let _ = self.live.send(Bytes::from(payload[live_from..].to_vec()));
                    }
                }
                Ok(Some((proto::EXIT, payload))) => {
                    let code = proto::parse_i32(&payload).unwrap_or(-1);
                    *lock(&self.exit_code) = Some(code);
                    // Nothing more will ever arrive: never make a capture wait.
                    self.ready.send_replace(true);
                    tracing::info!(session = %self.name, code, "native: child exited");
                    break Ok(());
                }
                Ok(Some((proto::INFO, payload))) => {
                    if let Ok(info) = serde_json::from_slice::<proto::Info>(&payload) {
                        self.pid.store(info.pid, Ordering::Relaxed);
                    }
                }
                Ok(Some(_)) => {}
            }
        };

        *self.writer.lock().await = None;
        self.detached.send_replace(true);
        result
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
    }
}

/// A `JoinHandle` that ABORTS its task when dropped.
///
/// A bare `JoinHandle` drop merely detaches, which is exactly wrong here: when
/// [`NativeSession::stop_pump`] aborts the supervisor, the supervisor's future
/// is dropped — and the pump it is watching has to go down with it, or a
/// deleted/renamed session would keep a holder connection (and a grid) alive
/// forever, which is the bug `stop_pump` exists to prevent.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Start [`pump`] under SUPERVISION and return the abort handle
/// [`NativeSession::stop_pump`] keeps.
///
/// A bare `tokio::spawn(pump(..))` swallows a panic into the `JoinHandle`
/// nobody holds: the task is gone, `detached` is stuck on whatever it was
/// (typically `false`, mid-connection), and every health question — `attached()`,
/// `dead()`, `death()`, the WS attach gate — keeps answering "fine" for a
/// session that has nothing serving it. That is the daemon-side half of the
/// incident, and no amount of poison-tolerance fixes it on its own: the task
/// still has to come BACK.
///
/// So the outcome is watched. On a panic the supervisor
///
/// 1. logs it (with the panic's message — the only trace there would otherwise
///    be),
/// 2. re-asserts the truth the dead pump can no longer maintain: `detached`,
///    `ready` (never leave a capture waiting) and the write half,
/// 3. restarts the pump after a backoff, so a one-off parse panic on a stray
///    escape sequence heals itself,
///
/// and gives up after [`MAX_PUMP_PANICS`] RAPID panics — leaving the session
/// honestly detached, which is what `death()` and the status detector turn into
/// a visible `stopped` + badge.
fn supervise_pump(weak: Weak<NativeSession>) -> tokio::task::AbortHandle {
    let supervisor = tokio::spawn(async move {
        let mut panics = 0u32;
        let mut last_panic: Option<std::time::Instant> = None;
        let mut delay = RECONNECT_MIN;
        loop {
            let mut task = AbortOnDrop(tokio::spawn(pump(weak.clone())));
            let reason = match (&mut task.0).await {
                // The pump returned on its own terms (session dropped/stopped).
                Ok(()) => return,
                Err(e) if e.is_cancelled() => return,
                Err(e) => panic_message(e.into_panic()),
            };
            drop(task);
            let Some(session) = weak.upgrade() else { return };
            if session.stopped.load(Ordering::Relaxed) {
                return;
            }
            // The pump is the only writer of these; a panicked one left them
            // describing a connection that no longer exists.
            session.detached.send_replace(true);
            session.ready.send_replace(true);
            if let Ok(mut g) = session.writer.try_lock() {
                *g = None;
            }
            panics = match last_panic {
                Some(t) if t.elapsed() < PUMP_PANIC_WINDOW => panics + 1,
                _ => 1,
            };
            last_panic = Some(std::time::Instant::now());
            tracing::error!(
                session = %session.name,
                panic = %reason,
                panics,
                "native: the connection pump PANICKED — the session is detached until it is back",
            );
            if panics >= MAX_PUMP_PANICS {
                tracing::error!(
                    session = %session.name,
                    "native: giving up on the connection pump after {MAX_PUMP_PANICS} rapid \
                     panics — the session stays detached (it will surface as stopped)",
                );
                return;
            }
            drop(session);
            delay = next_backoff(delay);
            tokio::time::sleep(delay).await;
        }
    });
    supervisor.abort_handle()
}

/// The human-readable half of a panic payload (`&str` or `String`).
fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// The connection pump: connect, serve, back off, repeat — until the session
/// object is dropped (the `Weak` stops upgrading), the pump is aborted
/// ([`NativeSession::stop_pump`]), or the child exits (it PARKS then, and a
/// fresh [`NativeSession::spawn`] wakes it).
async fn pump(weak: Weak<NativeSession>) {
    let mut delay = RECONNECT_MIN;
    // Consecutive connections that did not last. The FIRST one still reconnects
    // at [`RECONNECT_MIN`] — a single lag-drop is normal and a keystroke typed
    // into that window must still land (see [`ATTACH_WAIT`]). Only a REPEAT
    // starts backing off, which is what a storm looks like.
    let mut flaps = 0u32;
    loop {
        let session = match weak.upgrade() {
            Some(s) => s,
            None => return,
        };
        if session.stopped.load(Ordering::Relaxed) {
            return;
        }
        // The panic a real `Vt::advance` would take on malformed input, without
        // needing a byte sequence that happens to break the parser today.
        #[cfg(test)]
        if pump_hooks::take_panic(&session.name) {
            panic!("injected connection-pump panic (test hook)");
        }
        // The child is gone for good (EXIT frame or the on-disk marker): there
        // is nothing to reconnect TO, so park instead of dialling a dead socket
        // every 5s forever. `spawn()` notifies to bring us back.
        if session.exit_code().is_some() {
            session.detached.send_replace(true);
            session.ready.send_replace(true);
            let restart = session.restart.clone();
            // Drop the strong ref BEFORE parking, or a forgotten session could
            // never be freed.
            drop(session);
            restart.notified().await;
            delay = RECONNECT_MIN;
            continue;
        }
        let socket = session.socket.clone();
        let attached_at = std::time::Instant::now();
        match UnixStream::connect(&socket).await {
            Ok(stream) => {
                if let Err(e) = session.serve(stream).await {
                    tracing::debug!(session = %session.name, error = %e, "native: holder connection ended");
                }
                // BETWEEN connections nothing is replaying, so a capture must
                // never sit on the ready gate — including after a connection
                // that died PART-WAY through its replay (or before its HELLO
                // ever arrived), which is precisely when the gate was last left
                // closed with nobody to open it.
                session.ready.send_replace(true);
                // A connection that LASTED was healthy; one that died in
                // seconds is a flap and must back off even though `connect`
                // itself worked. Without this the daemon happily reattached
                // every 250 ms forever (the production storm), and each attach
                // cost the holder a snapshot, a queue swap and a replay read.
                if attached_at.elapsed() >= RECONNECT_STABLE {
                    flaps = 0;
                    delay = RECONNECT_MIN;
                } else {
                    flaps += 1;
                    delay = if flaps <= 1 { RECONNECT_MIN } else { next_backoff(delay) };
                }
            }
            Err(_) => {
                session.detached.send_replace(true);
                // No holder to wait for — a capture must not sit on the ready
                // gate for a session that has nothing serving it.
                session.ready.send_replace(true);
                flaps += 1;
                delay = next_backoff(delay);
            }
        }
        // Drop the strong ref BEFORE sleeping so a dropped session's pump can
        // notice and exit promptly.
        drop(session);
        tokio::time::sleep(delay).await;
    }
}

/// The next reconnect delay: DECORRELATED JITTER over `[RECONNECT_MIN, 3×prev]`,
/// capped at [`RECONNECT_MAX`].
///
/// Jitter rather than a plain doubling because the failure mode this guards
/// against is a herd: a daemon restart reattaches every native session at once,
/// and if they all flap they would retry in lockstep, hammering one holder after
/// another in the same 250 ms slots. Randomising spreads them out, and the ×3
/// growth reaches the 5 s ceiling in three flaps — fast enough that a
/// pathological attach ⇄ lag-drop loop can never run at 4 Hz again.
fn next_backoff(prev: Duration) -> Duration {
    use rand::Rng;
    let lo = RECONNECT_MIN.as_millis() as u64;
    let hi = (prev.as_millis() as u64)
        .saturating_mul(3)
        .clamp(lo, RECONNECT_MAX.as_millis() as u64);
    if hi <= lo {
        return RECONNECT_MIN;
    }
    Duration::from_millis(rand::thread_rng().gen_range(lo..=hi))
}

/// NON-DESTRUCTIVE liveness probe for the session spooled at `dir`: is its child
/// still running?
///
/// Deliberately touches nothing but the filesystem and `kill(pid, 0)` — see
/// [`NativeSession::dead`] for why connecting to the holder's socket is not an
/// option. Answers for a session this process has never attached to (the boot
/// reconcile), which is why it is a free function over the spool dir.
///
/// A live pid is NOT enough on its own: a holder `SIGKILL`ed without writing its
/// `exit` marker frees its child's pid, and after a pid wrap an unrelated
/// process answers `kill(pid, 0)` — the session then reads "alive" forever while
/// nothing can serve it. So the pid must also be PROVEN to still be this
/// session's process (see [`pid_belongs_to_session`]).
pub fn probe_alive(dir: &Path) -> bool {
    if exit_marker(dir).is_some() {
        return false;
    }
    match spool::read_meta(dir) {
        Some(m) if m.pid > 1 => {
            pid_alive(m.pid) && pid_belongs_to_session(m.pid, &m.session, m.started_at)
        }
        _ => false,
    }
}

/// Is `pid` still THIS session's process, or is it a stranger wearing a recycled
/// pid? Evidence, cheapest first — never a socket dial (that would evict the
/// live daemon connection; see [`NativeSession::dead`]).
///
/// `meta.json`'s pid is the holder's CHILD (the login shell), so the holder is
/// its PARENT. That gives three verdicts:
///
/// * the process (or its parent) is `pty-holder --session <this session>` → ours;
/// * it is a `pty-holder` for a DIFFERENT session → a recycled pid, not ours;
/// * the parent is `init` (pid 1) → the holder that owned this child is GONE.
///   The socket has no listener any more, so nothing can ever serve this session
///   again: report it dead rather than leaving an orphaned child looking healthy.
///
/// When `/proc` yields nothing conclusive (a non-Linux host, an unreadable
/// parent, the in-process holder the tests run) it falls back to comparing the
/// pid's real start time with `meta.json`'s — a recycled pid started long after
/// the holder recorded its spawn.
fn pid_belongs_to_session(pid: u32, session: &str, started_at: i64) -> bool {
    match holder_identity(pid, session) {
        HolderId::Ours => return true,
        HolderId::Other => return false,
        HolderId::NotHolder | HolderId::Unknown => {}
    }
    match parent_pid(pid) {
        // Reparented to init: the holder died and left the child orphaned.
        Some(ppid) if ppid <= 1 => return false,
        Some(ppid) => match holder_identity(ppid, session) {
            HolderId::Ours => return true,
            HolderId::Other => return false,
            HolderId::NotHolder | HolderId::Unknown => {}
        },
        None => {}
    }
    match proc_start_unix(pid) {
        // A process that started ~when the holder wrote `meta.json` is the one
        // the holder spawned; anything else is a recycled pid.
        Some(started) => (started - started_at).abs() <= MAX_START_SKEW,
        // No `/proc` to ask — keep the historical (permissive) answer rather than
        // declaring a live session dead on a platform we can not inspect.
        None => true,
    }
}

/// What `/proc/<pid>/cmdline` says a process is.
#[derive(Debug, PartialEq, Eq)]
enum HolderId {
    /// The `pty-holder` for the session we asked about.
    Ours,
    /// A `pty-holder`, but for some OTHER session.
    Other,
    /// A real process that is not a holder at all.
    NotHolder,
    /// Unreadable (`/proc` absent, process gone, permission denied).
    Unknown,
}

/// Classify `pid` from its argv. The daemon spawns holders as
/// `<exe> pty-holder --session <name> --dir … --socket …`, so both facts are
/// plain argv entries — no socket, no signal, one small read.
fn holder_identity(pid: u32, session: &str) -> HolderId {
    let raw = match std::fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(b) if !b.is_empty() => b,
        // A kernel thread has an empty cmdline; either way we learn nothing.
        _ => return HolderId::Unknown,
    };
    let args: Vec<&[u8]> = raw.split(|b| *b == 0).filter(|a| !a.is_empty()).collect();
    if !args.iter().any(|a| *a == b"pty-holder") {
        return HolderId::NotHolder;
    }
    let named = args
        .windows(2)
        .find(|w| w[0] == b"--session")
        .map(|w| w[1] == session.as_bytes());
    match named {
        Some(true) => HolderId::Ours,
        // A holder always carries `--session`; without it we can not tell whose.
        Some(false) => HolderId::Other,
        None => HolderId::Unknown,
    }
}

/// Parent pid of `pid` (`ppid`, field 4 of `/proc/<pid>/stat`). Parsed from after
/// the LAST `)` because `comm` may contain spaces and parentheses.
fn parent_pid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(')')? + 1..];
    // After comm: state(0) ppid(1).
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// When `pid` really started, in unix seconds: `/proc/<pid>/stat`'s `starttime`
/// (field 22, in clock ticks since boot) added to `/proc/stat`'s `btime`.
/// `None` when either is unreadable — i.e. on any non-Linux host.
pub(crate) fn proc_start_unix(pid: u32) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(')')? + 1..];
    // After comm: state(0) … starttime is the 22nd field overall, i.e. #19 here.
    let ticks: i64 = rest.split_whitespace().nth(19)?.parse().ok()?;
    // SAFETY: plain libc query, no arguments to get wrong.
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    let hz = if hz > 0 { hz } else { 100 };
    let btime: i64 = std::fs::read_to_string("/proc/stat")
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("btime ")?.trim().parse().ok())?;
    Some(btime + ticks / hz)
}

/// The `exit` marker as a [`TerminalDeath`], or `None` when the session has no
/// marker (it never exited, or it was cleared by a fresh `spawn`).
///
/// Deliberately tolerant of BOTH marker shapes, so it keeps working whichever
/// side of the holder-resilience work lands first:
///
/// * a bare status code (`137`) — the historical shape, a child that exited;
/// * a leading REASON line (`panic: …`, `signal: SIGKILL`) — what a holder that
///   is going down abnormally writes, and the only trace of a crash that
///   survives the process.
///
/// A reason line makes the death `unexpected`, which is what earns the user a
/// visible "the holder died: …" instead of a silent stop.
pub fn exit_marker(dir: &Path) -> Option<TerminalDeath> {
    let body = std::fs::read_to_string(dir.join("exit")).ok()?;
    let first = body.lines().map(str::trim).find(|l| !l.is_empty());
    match first {
        None => Some(TerminalDeath {
            reason: "holder exited without recording a status".to_string(),
            unexpected: true,
        }),
        Some(line) => match line.parse::<i32>() {
            Ok(code) => Some(TerminalDeath::exited(code)),
            Err(_) => Some(TerminalDeath {
                reason: sanitize_reason(line),
                unexpected: true,
            }),
        },
    }
}

/// One line of holder-authored text, safe to put in a JSON field and a UI badge:
/// control characters dropped, bounded length.
fn sanitize_reason(line: &str) -> String {
    let mut out: String = line
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_REASON)
        .collect();
    let trimmed = out.trim_end().len();
    out.truncate(trimmed);
    out
}

/// Does process `pid` exist? `kill(pid, 0)` performs error checking only — it
/// never delivers a signal. `EPERM` means "it exists but isn't ours", which is
/// still alive.
fn pid_alive(pid: u32) -> bool {
    // SAFETY: plain libc call with signal 0; no signal is delivered.
    if unsafe { libc::kill(pid as i32, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// The foreground process-group id of the terminal `pid` is attached to
/// (`tpgid`, field 8 of `/proc/<pid>/stat`). `None` when unreadable, or when the
/// terminal has no foreground group.
///
/// The `comm` field can contain spaces AND parentheses, so the fixed fields are
/// parsed from after the LAST `)` — the standard way to read this file.
pub(crate) fn foreground_pgid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(')')? + 1..];
    // After comm: state(0) ppid(1) pgrp(2) session(3) tty_nr(4) tpgid(5).
    let tpgid: i32 = rest.split_whitespace().nth(5)?.parse().ok()?;
    u32::try_from(tpgid).ok()
}

/// Fault injection for the DAEMON-side pump, keyed by session name so tests
/// running concurrently in one process cannot disturb each other. Compiled out
/// of production builds entirely (the holder has its own, in `holder::test_hooks`).
#[cfg(test)]
pub(crate) mod pump_hooks {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use once_cell::sync::Lazy;

    /// `(panics still owed, panics actually taken)` per session.
    static PLAN: Lazy<Mutex<HashMap<String, (u32, u32)>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    fn plan() -> std::sync::MutexGuard<'static, HashMap<String, (u32, u32)>> {
        match PLAN.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    /// Make `session`'s pump panic on its next `n` connection attempts.
    pub fn arm(session: &str, n: u32) {
        plan().insert(session.to_string(), (n, 0));
    }

    /// Should the pump panic right now? Consumes one panic from the budget.
    pub fn take_panic(session: &str) -> bool {
        let mut g = plan();
        match g.get_mut(session) {
            Some((owed, taken)) if *owed > 0 => {
                *owed -= 1;
                *taken += 1;
                true
            }
            _ => false,
        }
    }

    /// How many times `session`'s pump has been made to panic.
    pub fn taken(session: &str) -> u32 {
        plan().get(session).map(|(_, t)| *t).unwrap_or(0)
    }

    /// Forget `session`'s plan.
    pub fn clear(session: &str) {
        plan().remove(session);
    }
}

/// What Linux appends to `/proc/self/exe` once the inode it pointed at has been
/// replaced or unlinked — the shape `std::env::current_exe()` hands back after a
/// rebuild or an in-place install under a running server.
const DELETED_SUFFIX: &str = " (deleted)";

/// The sentence a caller can put in front of a user, and the marker
/// [`crate::sessions::lifecycle::start`] matches on to answer 409 with it rather
/// than a naked 500. Kept as a constant so the two ends cannot drift.
pub(crate) const HOLDER_BIN_REPLACED: &str = "the supermux binary was replaced while the server \
                                              was running — restart the supermux service";

/// Path to the binary that hosts the `pty-holder` subcommand. `SUPERMUX_HOLDER_BIN`
/// overrides it (tests, and an operator pinning a specific build).
pub(crate) fn holder_bin() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("SUPERMUX_HOLDER_BIN") {
        return Ok(PathBuf::from(p));
    }
    let exe =
        std::env::current_exe().context("locate the supermux-server binary for the pty holder")?;
    resolve_holder_bin(exe, |p| p.exists())
}

/// `current_exe()` → a path we can actually spawn, or an error a human can act
/// on. Pure (the existence probe is injected) so the deleted-inode case is
/// unit-tested without deleting this test binary out from under itself.
///
/// THE BUG THIS CLOSES: every holder spawn goes through `current_exe()`, which
/// on Linux resolves `/proc/self/exe`. Replace the inode — `cargo build` over
/// `target/debug/supermux-server`, or an installer writing the same path — and
/// the running process keeps working while that path becomes
/// `…/supermux-server (deleted)`. `Command::new` on it fails ENOENT, so EVERY
/// new session answers a bare `{"error":"internal server error"}` with one
/// `spawn pty holder` line in the log and nothing on the wire; on the
/// verification rig that silently blocked all session creation for ~15 minutes.
///
/// The recovery is the obvious one: the suffix is a decoration on the ORIGINAL
/// path, and after an install that path holds the NEW binary — which is a
/// perfectly good `pty-holder` host. So strip and re-probe; only when nothing is
/// there do we fail, and then with [`HOLDER_BIN_REPLACED`] instead of silence.
fn resolve_holder_bin(exe: PathBuf, exists: impl Fn(&Path) -> bool) -> Result<PathBuf> {
    if exists(&exe) {
        return Ok(exe);
    }
    let shown = exe.to_string_lossy().into_owned();
    if let Some(stripped) = shown.strip_suffix(DELETED_SUFFIX) {
        let installed = PathBuf::from(stripped);
        if exists(&installed) {
            tracing::warn!(
                path = %stripped,
                "the running supermux binary's inode was replaced; spawning pty holders from the \
                 installed path instead — restart the service to run the new build",
            );
            return Ok(installed);
        }
        anyhow::bail!("{HOLDER_BIN_REPLACED} (nothing at {stripped} to spawn a pty holder from)");
    }
    anyhow::bail!("{HOLDER_BIN_REPLACED} ({shown} is no longer on disk)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;
    use tokio::net::UnixListener;
    use tokio::sync::mpsc;

    /// A unique temp data dir per test.
    fn data_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "supermux-rt-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    macro_rules! wait_until {
        ($timeout:expr, $cond:expr) => {{
            let deadline = std::time::Instant::now() + $timeout;
            let mut ok = false;
            while std::time::Instant::now() < deadline {
                if $cond {
                    ok = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            ok
        }};
    }

    /// How the stand-in holder should behave on each connection it serves.
    #[derive(Clone)]
    struct FakePlan {
        cols: u16,
        rows: u16,
        /// Spool tail announced in `HELLO` and then written as one `OUTPUT`.
        replay: Vec<u8>,
        /// Delay between `HELLO` and the replay frame — the window in which the
        /// grid is still blank.
        replay_delay: Duration,
        /// Drop the connection after this long (and accept a new one). `None`
        /// keeps it open forever.
        hold: Option<Duration>,
        /// Send `EXIT` with this status (and stop accepting) after the replay.
        exit_after: Option<i32>,
    }

    impl Default for FakePlan {
        fn default() -> Self {
            Self {
                cols: 80,
                rows: 24,
                replay: Vec::new(),
                replay_delay: Duration::ZERO,
                hold: None,
                exit_after: None,
            }
        }
    }

    /// A holder STAND-IN: the real socket protocol, but no pty and no child.
    ///
    /// The real holder is exercised end to end in `native::tests`; this one
    /// exists because the daemon-side edges under test here — the replay
    /// boundary, a mid-session disconnect, a reconnect — are timing the real
    /// holder gives no handle on. Frames the daemon sends are forwarded on the
    /// returned channel so a test can assert on them.
    fn fake_holder(
        data_dir: &Path,
        name: &str,
        plan: FakePlan,
    ) -> (mpsc::UnboundedReceiver<(u8, Vec<u8>)>, tokio::task::JoinHandle<()>) {
        let sdir = spool::session_dir(data_dir, name);
        std::fs::create_dir_all(&sdir).unwrap();
        let sock = spool::socket_path(data_dir, name);
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let session = name.to_string();
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let (rd, mut wr) = stream.into_split();
                let hello = proto::Hello {
                    session: session.clone(),
                    pid: std::process::id(),
                    cols: plan.cols,
                    rows: plan.rows,
                    started_at: 0,
                    replay_bytes: plan.replay.len() as u64,
                    spool_total: plan.replay.len() as u64,
                    // A stand-in with no spool always answers with the full
                    // "tail", i.e. never a delta.
                    replay_from: 0,
                    delta: false,
                    spool_degraded: false,
                    spool_dropped: 0,
                };
                let body = serde_json::to_vec(&hello).unwrap();
                if proto::write_frame(&mut wr, proto::HELLO, &body).await.is_err() {
                    continue;
                }
                let tx2 = tx.clone();
                let reader = tokio::spawn(async move {
                    let mut rd = BufReader::new(rd);
                    while let Ok(Some(frame)) = proto::read_frame(&mut rd).await {
                        // The real holder CONSUMES the position frame in its
                        // accept path (it decides full-tail vs delta), so it is
                        // not part of what a test observes the daemon sending.
                        if frame.0 == proto::ATTACH_FROM {
                            continue;
                        }
                        if tx2.send(frame).is_err() {
                            return;
                        }
                    }
                });
                tokio::time::sleep(plan.replay_delay).await;
                if !plan.replay.is_empty() {
                    let _ = proto::write_frame(&mut wr, proto::OUTPUT, &plan.replay).await;
                }
                if let Some(code) = plan.exit_after {
                    let _ = proto::write_frame(&mut wr, proto::EXIT, &code.to_be_bytes()).await;
                    spool::mark_exit(&sdir, code);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    return;
                }
                match plan.hold {
                    Some(d) => tokio::time::sleep(d).await,
                    None => std::future::pending::<()>().await,
                }
                reader.abort();
                // Dropping both halves closes the connection; loop back to
                // accept the pump's reconnect.
            }
        });
        (rx, task)
    }

    /// B2 — the attach seed must NOT race the spool replay. Before the ready
    /// gate, `runtime_for` handed back a session whose grid was still empty, so
    /// the first WS attach after a daemon restart seeded a BLANK screen with
    /// `history_size 0` and stayed that way until the next resync.
    #[tokio::test]
    async fn seed_waits_for_the_spool_replay_to_finish() {
        let dir = data_dir("ready");
        let plan = FakePlan {
            replay: b"REPLAYED-CONTENT\r\n".to_vec(),
            replay_delay: Duration::from_millis(400),
            ..Default::default()
        };
        let (_frames, holder) = fake_holder(&dir, "ready", plan);
        let session = NativeSession::new("ready", &dir);
        assert!(wait_until!(Duration::from_secs(5), session.attached()));

        // Attached, but the replay has not landed yet: the seed must block for
        // it rather than serve the blank grid it can see right now.
        let t0 = std::time::Instant::now();
        let seed = session.seed().await;
        assert!(
            t0.elapsed() >= Duration::from_millis(200),
            "seed returned in {:?} — it did not wait for the replay",
            t0.elapsed(),
        );
        assert!(seed.contains("REPLAYED-CONTENT"), "seed:\n{seed}");
        assert!(session.history_meta().await.1 > 0);

        holder.abort();
        crate::sessions::native::forget("ready");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// B2 — the gate must never HANG. A session with no holder at all has
    /// nothing to wait for, so captures answer immediately (the detector polls
    /// every stopped session every 2s).
    #[tokio::test]
    async fn the_ready_gate_does_not_stall_a_session_with_no_holder() {
        let dir = data_dir("noholder");
        let session = NativeSession::new("noholder", &dir);
        // First connect attempt fails almost at once; give the pump a beat.
        assert!(wait_until!(Duration::from_secs(2), !session.attached()));
        let t0 = std::time::Instant::now();
        let _ = session.capture_plain(40).await;
        let _ = session.seed().await;
        assert!(
            t0.elapsed() < Duration::from_secs(1),
            "captures on a holder-less session must not sit on the ready gate ({:?})",
            t0.elapsed(),
        );
        crate::sessions::native::forget("noholder");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// B1 — a reconnect rebuilds the grid from the spool and DELIBERATELY
    /// suppresses the replay bytes, so an attached WebSocket never sees what
    /// flowed during the gap. The attach generation is the signal that makes the
    /// WS layer re-seed; without it the browser silently loses those bytes.
    #[tokio::test]
    async fn attach_generation_ticks_after_a_reconnect_and_replay_stays_off_the_wire() {
        let dir = data_dir("gen");
        let plan = FakePlan {
            replay: b"REPLAY-ONLY\r\n".to_vec(),
            hold: Some(Duration::from_millis(300)),
            ..Default::default()
        };
        let (_frames, holder) = fake_holder(&dir, "gen", plan);
        let session = NativeSession::new("gen", &dir);
        let mut live = session.subscribe();
        let mut gen = session.attach_generation();

        assert!(wait_until!(Duration::from_secs(5), session.attached()));
        // First attach: the generation ticks once the replay has drained.
        assert!(
            tokio::time::timeout(Duration::from_secs(5), gen.changed())
                .await
                .is_ok(),
            "no generation tick for the first attach",
        );
        let first = *gen.borrow_and_update();
        assert!(session.capture_full().await.contains("REPLAY-ONLY"));

        // The holder drops us and we reconnect: a SECOND tick, and the grid is
        // whole again.
        assert!(
            tokio::time::timeout(Duration::from_secs(10), gen.changed())
                .await
                .is_ok(),
            "no generation tick after the reconnect — attached clients would \
             never learn they need to re-seed",
        );
        assert!(*gen.borrow() > first, "generation must advance");

        // …and none of the replayed bytes reached live subscribers (re-printing
        // history is exactly what the seed exists to avoid).
        assert!(
            live.try_recv().is_err(),
            "replay bytes must never reach the live fan-out",
        );

        holder.abort();
        crate::sessions::native::forget("gen");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// S1 — a resize applied while DETACHED must survive the reattach. `HELLO`
    /// reports the holder's stale geometry, and adopting it wholesale threw the
    /// client's real size away until the next manual resize.
    #[tokio::test]
    async fn a_resize_made_while_detached_is_re_asserted_on_attach() {
        let dir = data_dir("resize");
        let session = NativeSession::new("resize", &dir);
        // No holder yet: the RESIZE frame has nowhere to go, but the request is
        // remembered (and the grid reflows locally).
        let _ = session.resize(120, 40).await;

        let (mut frames, holder) = fake_holder(&dir, "resize", FakePlan::default());
        assert!(wait_until!(Duration::from_secs(5), session.attached()));

        let f = tokio::time::timeout(Duration::from_secs(5), frames.recv())
            .await
            .expect("holder received no frame at all")
            .expect("frame channel closed");
        assert_eq!(f.0, proto::RESIZE, "first frame on attach must be the RESIZE");
        assert_eq!(proto::parse_resize(&f.1), Some((120, 40)));
        assert_eq!(session.history_meta().await.1, 120, "grid keeps the client's width");

        holder.abort();
        crate::sessions::native::forget("resize");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// S2 — a keystroke typed into the ~250 ms reconnect window used to fail
    /// with "is not attached to a holder" and was simply lost. It now waits for
    /// the attach (bounded by `ATTACH_WAIT`).
    #[tokio::test]
    async fn input_sent_during_a_reconnect_gap_waits_for_the_attach() {
        let dir = data_dir("wait");
        // The holder drops the connection after 300ms and accepts the pump's
        // reconnect — the lag-disconnect this fix is about.
        let plan = FakePlan { hold: Some(Duration::from_millis(300)), ..Default::default() };
        let (mut frames, holder) = fake_holder(&dir, "wait", plan);
        let session = NativeSession::new("wait", &dir);
        assert!(wait_until!(Duration::from_secs(5), session.attached()));
        assert!(
            wait_until!(Duration::from_secs(5), !session.attached()),
            "the holder never dropped the connection",
        );

        // Typed INTO the gap: this used to fail on the spot and the keystroke
        // was gone for good.
        let t0 = std::time::Instant::now();
        session
            .send_text("typed-into-the-gap")
            .await
            .expect("input must survive the reconnect gap");
        assert!(
            t0.elapsed() >= Duration::from_millis(50),
            "the send should have WAITED for the re-attach ({:?})",
            t0.elapsed(),
        );

        let mut got = None;
        while let Ok(Some(f)) = tokio::time::timeout(Duration::from_secs(5), frames.recv()).await {
            if f.0 == proto::INPUT {
                got = Some(f.1);
                break;
            }
        }
        assert_eq!(got.as_deref(), Some(&b"typed-into-the-gap"[..]));

        holder.abort();
        crate::sessions::native::forget("wait");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// S2 — and it still gives up rather than hanging when no holder ever
    /// appears (a stopped session must fail fast enough for an HTTP handler).
    #[tokio::test]
    async fn input_to_a_holder_less_session_fails_within_the_attach_budget() {
        let dir = data_dir("nowait");
        let session = NativeSession::new("nowait", &dir);
        let t0 = std::time::Instant::now();
        assert!(session.send_text("nobody-home").await.is_err());
        assert!(
            t0.elapsed() < ATTACH_WAIT * 3,
            "send_frame waited {:?} — far past the attach budget",
            t0.elapsed(),
        );
        crate::sessions::native::forget("nowait");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// S6 — after the child exits there is nothing to reconnect TO. The pump
    /// used to keep dialling a dead socket forever (every 5s, per session,
    /// until the process ended).
    #[tokio::test]
    async fn the_pump_parks_after_exit_instead_of_reconnect_looping() {
        let dir = data_dir("parked");
        let plan = FakePlan { exit_after: Some(3), ..Default::default() };
        let (_frames, holder) = fake_holder(&dir, "parked", plan);
        let session = NativeSession::new("parked", &dir);
        assert!(
            wait_until!(Duration::from_secs(5), session.exit_code() == Some(3)),
            "the EXIT frame never landed",
        );
        assert!(session.dead().await);
        holder.abort();

        // Stand a fresh listener up on the same path: a pump that were still
        // reconnect-looping would land on it within a backoff or two.
        let sock = spool::socket_path(&dir, "parked");
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(1_500), listener.accept())
                .await
                .is_err(),
            "the pump reconnected to a session whose child has exited",
        );

        crate::sessions::native::forget("parked");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// B3 — the liveness probe must be NON-DESTRUCTIVE. `socket_live()` dialled
    /// the holder, which treats any accepted connection as the incoming daemon
    /// and evicts the incumbent — so every `alive()`/`dead()` call (stop polls,
    /// WS attach, detector ticks) hijacked the live session and forced an 8 MiB
    /// replay.
    #[tokio::test]
    async fn liveness_probing_never_disturbs_the_live_holder_connection() {
        let dir = data_dir("probe");
        let (_frames, holder) = fake_holder(&dir, "probe", FakePlan::default());
        // A real holder writes this; the probe reads its pid.
        spool::write_meta(
            &spool::session_dir(&dir, "probe"),
            &spool::Meta {
                session: "probe".into(),
                pid: std::process::id(),
                cols: 80,
                rows: 24,
                started_at: 0,
                command: "bash".into(),
            },
        )
        .unwrap();
        let session = NativeSession::new("probe", &dir);
        assert!(wait_until!(Duration::from_secs(5), session.attached()));
        let mut gen = session.attach_generation();
        gen.borrow_and_update();

        for _ in 0..20 {
            assert!(session.alive().await, "probe says a live session is dead");
            assert!(!session.dead().await);
        }
        // Still the SAME connection: no eviction, no reattach, no replay.
        assert!(session.attached(), "the probe dropped the holder connection");
        assert!(!gen.has_changed().unwrap(), "the probe forced a re-attach");

        holder.abort();
        crate::sessions::native::forget("probe");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// B3 — the probe reads the same three facts a holder writes, without a
    /// socket: `meta.json`'s pid, whether that pid is alive, and the `exit`
    /// marker.
    #[test]
    fn probe_alive_reads_the_meta_pid_and_the_exit_marker() {
        let dir = data_dir("probefn");
        let sdir = spool::session_dir(&dir, "s");
        std::fs::create_dir_all(&sdir).unwrap();
        // No meta at all → never spawned → not alive.
        assert!(!probe_alive(&sdir));

        let mut meta = spool::Meta {
            session: "s".into(),
            pid: std::process::id(),
            // HONEST metadata: when this pid really started. A holder writes
            // `meta.json` milliseconds after forking its child, so this is what
            // a live session's sidecar looks like — and it is the fact that
            // tells a recycled pid apart from ours (see the reused-pid test).
            started_at: proc_start_unix(std::process::id()).unwrap_or(0),
            cols: 80,
            rows: 24,
            command: "bash".into(),
        };
        spool::write_meta(&sdir, &meta).unwrap();
        assert!(probe_alive(&sdir), "our own pid is definitely alive");

        // The exit marker is authoritative even when the pid still resolves.
        spool::mark_exit(&sdir, 0);
        assert!(!probe_alive(&sdir));
        spool::clear_exit(&sdir);

        // A pid that cannot exist (0 is never a real process here).
        meta.pid = 0;
        spool::write_meta(&sdir, &meta).unwrap();
        assert!(!probe_alive(&sdir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A LIVE pid is not proof: a holder killed without writing its `exit`
    /// marker frees its child's pid, and after a pid wrap an unrelated process
    /// answers `kill(pid, 0)`. The session then reads "alive" forever while
    /// nothing can serve it — the shape of the production incident, where the
    /// status never became `stopped` and the screen stayed blank for 30 minutes.
    #[tokio::test]
    async fn probe_rejects_a_recycled_pid() {
        let dir = data_dir("reuse");
        let sdir = spool::session_dir(&dir, "s");
        std::fs::create_dir_all(&sdir).unwrap();

        // Same live pid as above — but claimed by a session that was spawned
        // long before this process existed. That is exactly what a wrapped pid
        // looks like: alive, and not ours.
        let meta = spool::Meta {
            session: "s".into(),
            pid: std::process::id(),
            started_at: proc_start_unix(std::process::id()).unwrap_or(0) - 86_400,
            cols: 80,
            rows: 24,
            command: "bash".into(),
        };
        spool::write_meta(&sdir, &meta).unwrap();
        assert!(
            pid_alive(meta.pid),
            "precondition: the pid under test must be alive",
        );
        assert!(
            !probe_alive(&sdir),
            "a live pid that is NOT this session's process must read as dead",
        );

        // …and the runtime turns that into a reportable death rather than a
        // silent blank screen.
        let session = NativeSession::new("s", &dir);
        let death = session
            .death()
            .await
            .expect("a session with no live holder must be able to say so");
        assert!(death.unexpected, "a vanished holder is not an ordinary exit");
        assert!(
            death.reason.contains("no exit marker"),
            "the reason must name the evidence, got {:?}",
            death.reason,
        );
        session.stop_pump();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `/proc/<pid>/cmdline` identifies a holder by session name, so a pid that
    /// belongs to a holder for a DIFFERENT session is never mistaken for ours.
    #[test]
    fn holder_identity_reads_the_session_out_of_the_argv() {
        // Our own process is not a holder at all.
        let me = std::process::id();
        assert_eq!(holder_identity(me, "anything"), HolderId::NotHolder);
        // A pid that cannot exist yields no evidence either way.
        assert_eq!(holder_identity(0, "anything"), HolderId::Unknown);
    }

    /// The `exit` marker is the only trace of a death that outlives both the
    /// holder and the daemon, and it carries BOTH shapes: a bare status code
    /// (an ordinary child exit) and a leading reason line (a holder going down
    /// abnormally). The reason is what the user gets to see.
    #[test]
    fn the_exit_marker_separates_a_clean_exit_from_a_crash() {
        let dir = data_dir("marker");
        let sdir = spool::session_dir(&dir, "s");
        std::fs::create_dir_all(&sdir).unwrap();
        assert!(exit_marker(&sdir).is_none(), "no marker, no death");

        // Legacy/clean shape: just the child's status.
        std::fs::write(sdir.join("exit"), b"137\n").unwrap();
        let clean = exit_marker(&sdir).unwrap();
        assert!(!clean.unexpected);
        assert_eq!(clean.reason, "exited with status 137");

        // Crash shape: a reason line the holder wrote on its way out.
        std::fs::write(sdir.join("exit"), b"panic: pty read failed\n1\n").unwrap();
        let crash = exit_marker(&sdir).unwrap();
        assert!(crash.unexpected, "a reason line means it did not exit cleanly");
        assert_eq!(crash.reason, "panic: pty read failed");

        // Control characters are stripped and the line is bounded — it ends up
        // in a JSON field and a UI badge.
        let noisy = format!("panic: \u{1b}[31m{}\n", "x".repeat(400));
        std::fs::write(sdir.join("exit"), noisy.as_bytes()).unwrap();
        let bounded = exit_marker(&sdir).unwrap();
        assert!(bounded.reason.len() <= MAX_REASON);
        assert!(!bounded.reason.contains('\u{1b}'));

        // An empty marker still means "it exited", and we say so honestly.
        std::fs::write(sdir.join("exit"), b"").unwrap();
        assert!(exit_marker(&sdir).unwrap().unexpected);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The grid a fresh daemon holds is EMPTY until a holder connection has
    /// replayed the spool into it. Anything that PERSISTS a capture has to be
    /// able to tell those apart, or a daemon restart over a dead holder
    /// overwrites every stored preview with blanks (the blank overview cards).
    #[tokio::test]
    async fn the_grid_is_only_authoritative_after_an_attach() {
        let dir = data_dir("authority");
        // No holder at all: the pump fails to connect, and the ready gate is
        // released on purpose so captures answer instead of hanging.
        let session = NativeSession::new("authority", &dir);
        assert!(!session.grid_is_authoritative());
        assert_eq!(session.capture_plain(40).await.trim(), "");
        assert!(
            !session.grid_is_authoritative(),
            "a capture served off the empty grid must not claim authority",
        );

        // A holder shows up: after the attach completes, the grid is real.
        let (_frames, holder) = fake_holder(
            &dir,
            "authority",
            FakePlan { replay: b"hello".to_vec(), ..FakePlan::default() },
        );
        assert!(wait_until!(Duration::from_secs(5), session.grid_is_authoritative()));
        assert!(session.capture_plain(40).await.contains("hello"));

        session.stop_pump();
        holder.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// B4 — `forget()` must stop a pump that is INSIDE a live connection. The
    /// pump holds a strong `Arc` there, so dropping the registry entry alone
    /// left it (and its socket, and its grid) running forever.
    #[tokio::test]
    async fn forget_stops_a_pump_that_is_serving_a_connection() {
        let dir = data_dir("forget");
        let (_frames, holder) = fake_holder(&dir, "forget", FakePlan::default());
        let session = crate::sessions::native::runtime_for("forget", &dir);
        assert!(wait_until!(Duration::from_secs(5), session.attached()));

        crate::sessions::native::forget("forget");
        assert!(!session.attached(), "forget must detach the pump");
        // The handle is gone from the registry: the next resolve builds a NEW
        // one rather than handing back the stopped session.
        let again = crate::sessions::native::runtime_for("forget", &dir);
        assert!(!Arc::ptr_eq(&session, &again));
        crate::sessions::native::forget("forget");
        holder.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// B4/S6 — the on-disk state moves with a rename and is removed on delete.
    #[test]
    fn session_data_moves_on_rename_and_is_removed_on_delete() {
        let dir = data_dir("data");
        let old = spool::session_dir(&dir, "old");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(spool::spool_path(&old), b"bytes").unwrap();

        crate::sessions::native::rename_session_data("old", "new", &dir).unwrap();
        assert!(!old.exists(), "the old session dir must not be left behind");
        let new = spool::session_dir(&dir, "new");
        assert_eq!(std::fs::read(spool::spool_path(&new)).unwrap(), b"bytes");

        // Renaming a session that has no data yet is a clean no-op.
        crate::sessions::native::rename_session_data("never-spawned", "x", &dir).unwrap();

        crate::sessions::native::remove_session_data("new", &dir);
        assert!(!new.exists(), "delete must reclaim the spool dir");
        // …and removing it twice is not an error.
        crate::sessions::native::remove_session_data("new", &dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// B5 — `shell_is_foreground` is what stops `start()` from typing a launch
    /// command into a LIVE agent. It reads the pty's foreground process group,
    /// so it must track a program starting and finishing in the terminal.
    #[tokio::test]
    async fn shell_is_foreground_tracks_the_pty_foreground_program() {
        let dir = data_dir("fg");
        let args = super::super::holder::Args {
            session: "fg".to_string(),
            dir: spool::session_dir(&dir, "fg"),
            socket: spool::socket_path(&dir, "fg"),
            cols: 80,
            rows: 24,
            command: "bash --norc -i".to_string(),
        };
        let holder = tokio::spawn(async move {
            let _ = super::super::holder::run(args).await;
        });
        let session = NativeSession::new("fg", &dir);
        assert!(wait_until!(Duration::from_secs(10), session.attached()));

        // At the prompt: the shell itself owns the terminal.
        assert!(
            wait_until!(Duration::from_secs(10), session.shell_is_foreground().await == Some(true)),
            "the shell should be its own foreground group at the prompt",
        );

        // Run something: the foreground group is now the child's.
        session.send_text("sleep 20").await.unwrap();
        tokio::time::sleep(SUBMIT_GAP).await;
        session.send_key("Enter").await.unwrap();
        assert!(
            wait_until!(Duration::from_secs(10), session.shell_is_foreground().await == Some(false)),
            "a running program must read as 'not at the shell prompt'",
        );

        session.kill().await.unwrap();
        holder.abort();
        crate::sessions::native::forget("fg");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A holder STAND-IN that speaks the POSITION handshake: it records every
    /// `ATTACH_FROM` offset the daemon sends, answers the FIRST connection with
    /// a full tail and every later one with a DELTA continuing from the offset
    /// it was given. `(pid, started_at)` stay constant, so the daemon sees one
    /// and the same holder across the reconnect.
    fn delta_holder(
        data_dir: &Path,
        name: &str,
        first: &'static [u8],
        delta: &'static [u8],
    ) -> (Arc<Mutex<Vec<u64>>>, tokio::task::JoinHandle<()>) {
        let sdir = spool::session_dir(data_dir, name);
        std::fs::create_dir_all(&sdir).unwrap();
        let sock = spool::socket_path(data_dir, name);
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();
        let seen: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let session = name.to_string();
        let task = tokio::spawn(async move {
            let mut nth = 0usize;
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let (rd, mut wr) = stream.into_split();
                let mut rd = BufReader::new(rd);
                let from = match proto::read_frame(&mut rd).await {
                    Ok(Some((proto::ATTACH_FROM, p))) => proto::parse_u64(&p).unwrap_or(0),
                    _ => 0,
                };
                recorder.lock().unwrap().push(from);
                let (payload, is_delta) = if nth == 0 { (first, false) } else { (delta, true) };
                let replay_from = if is_delta { from } else { 0 };
                let hello = proto::Hello {
                    session: session.clone(),
                    pid: std::process::id(),
                    cols: 80,
                    rows: 24,
                    started_at: 4242,
                    replay_bytes: payload.len() as u64,
                    spool_total: replay_from + payload.len() as u64,
                    replay_from,
                    delta: is_delta,
                    spool_degraded: false,
                    spool_dropped: 0,
                };
                let body = serde_json::to_vec(&hello).unwrap();
                if proto::write_frame(&mut wr, proto::HELLO, &body).await.is_err() {
                    continue;
                }
                let _ = proto::write_frame(&mut wr, proto::OUTPUT, payload).await;
                nth += 1;
                if nth == 1 {
                    // Drop it: the daemon must come back WITH a position.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                } else {
                    std::future::pending::<()>().await;
                }
            }
        });
        (seen, task)
    }

    /// DELTA REPLAY, daemon side. A reconnect used to mean "throw the grid away
    /// and rebuild it from an 8 MiB tail", which is what made the production
    /// storm so expensive. Now the daemon tells the holder where it stopped and,
    /// when the holder honours that, KEEPS its grid and applies only the gap —
    /// while the ready/attach-generation contract stays exactly as it was, so
    /// the WS layer still re-seeds.
    #[tokio::test]
    async fn a_delta_reconnect_keeps_the_grid_and_still_bumps_the_generation() {
        let dir = data_dir("delta");
        let (offsets, holder) = delta_holder(&dir, "delta", b"FIRST-HALF\r\n", b"SECOND-HALF\r\n");
        let session = NativeSession::new("delta", &dir);
        let mut gen = session.attach_generation();

        assert!(
            wait_until!(Duration::from_secs(5), session.capture_full().await.contains("FIRST-HALF")),
            "the first attach must rebuild the grid from the full tail",
        );
        assert!(gen.changed().await.is_ok() && *gen.borrow_and_update() == 1);

        // The holder dropped us; the pump comes back with its position.
        assert!(
            wait_until!(Duration::from_secs(5), session.capture_full().await.contains("SECOND-HALF")),
            "the delta never landed:\n{}",
            session.capture_full().await,
        );
        // THE POINT: the first connection's content is still on the grid. A
        // full-tail reconnect would have wiped it (the stand-in's delta frame
        // carries only the second half).
        let grid = session.capture_full().await;
        assert!(
            grid.contains("FIRST-HALF") && grid.contains("SECOND-HALF"),
            "a delta attach must CONTINUE the grid, not rebuild it:\n{grid}",
        );
        // …and the attach contract the WS layer depends on is unchanged.
        assert!(gen.changed().await.is_ok(), "a delta attach still bumps the generation");
        assert!(*gen.borrow() >= 2);

        let seen = offsets.lock().unwrap().clone();
        assert_eq!(seen.first(), Some(&0), "a fresh daemon has no position to send");
        assert_eq!(
            seen.get(1),
            Some(&(b"FIRST-HALF\r\n".len() as u64)),
            "the reconnect must ask for exactly what it had already received",
        );

        holder.abort();
        crate::sessions::native::forget("delta");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── supervision + handshake edges ───────────────────────────────────────

    /// A pump that panics must COME BACK. Before the supervisor, a panic in the
    /// pump task (`Vt::advance` parses untrusted pty bytes; one poisoned mutex
    /// used to take the whole task with it) simply ended it: the `JoinHandle`
    /// nobody held swallowed the panic, `detached` kept whatever value it had,
    /// and `attached()`/`dead()`/`death()` all went on answering "healthy" for a
    /// session with nothing serving it.
    #[tokio::test]
    async fn a_panicking_pump_is_restarted_and_re_attaches() {
        let dir = data_dir("pumppanic");
        pump_hooks::arm("pumppanic", 1);
        let (_frames, holder) = fake_holder(&dir, "pumppanic", FakePlan::default());
        let session = NativeSession::new("pumppanic", &dir);

        assert!(
            wait_until!(Duration::from_secs(5), pump_hooks::taken("pumppanic") == 1),
            "the injected panic never fired",
        );
        // The panic is not the end of the session: the supervisor restarts the
        // pump and the very next attempt attaches.
        assert!(
            wait_until!(Duration::from_secs(10), session.attached()),
            "a transient pump panic must heal itself",
        );
        // …and captures never sat on the ready gate while it was down.
        let t0 = std::time::Instant::now();
        let _ = session.capture_plain(40).await;
        assert!(t0.elapsed() < Duration::from_secs(1));

        pump_hooks::clear("pumppanic");
        session.stop_pump();
        holder.abort();
        crate::sessions::native::forget("pumppanic");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// …but not for ever. A pump that keeps panicking is a session that can not
    /// be served, and the honest answer is DETACHED — which `death()` and the
    /// status detector turn into a visible `stopped` + badge. Silently retrying
    /// at 4 Hz while the card claims "active" is the incident.
    #[tokio::test]
    async fn a_pump_that_keeps_panicking_gives_up_and_the_session_reads_dead() {
        let dir = data_dir("pumpdead");
        let sdir = spool::session_dir(&dir, "pumpdead");
        std::fs::create_dir_all(&sdir).unwrap();
        // A sidecar naming a pid that is long gone: what the death probe reads
        // once nothing is attached any more.
        spool::write_meta(
            &sdir,
            &spool::Meta {
                session: "pumpdead".into(),
                pid: 0,
                cols: 80,
                rows: 24,
                started_at: 0,
                command: "bash".into(),
            },
        )
        .unwrap();
        pump_hooks::arm("pumpdead", 10);
        let (_frames, holder) = fake_holder(&dir, "pumpdead", FakePlan::default());
        let session = NativeSession::new("pumpdead", &dir);

        assert!(
            wait_until!(
                Duration::from_secs(20),
                pump_hooks::taken("pumpdead") >= MAX_PUMP_PANICS
            ),
            "the pump should have been restarted up to its budget",
        );
        // Give a would-be fourth attempt every chance to happen.
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(
            pump_hooks::taken("pumpdead"),
            MAX_PUMP_PANICS,
            "the supervisor must STOP after {MAX_PUMP_PANICS} rapid panics",
        );
        assert!(!session.attached(), "a given-up session must read detached");
        assert!(session.dead().await, "…and dead");
        let death = session.death().await.expect("it must be able to say why");
        assert!(death.unexpected, "a holder that never served us is not a clean exit");

        pump_hooks::clear("pumpdead");
        session.stop_pump();
        holder.abort();
        crate::sessions::native::forget("pumpdead");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fresh `spawn` means a brand-new holder with a brand-new spool, so the
    /// position we accumulated against the previous one must be FORGOTTEN. It
    /// was not, and that is how an auto-healed session came back blank: the
    /// daemon asked the new holder to continue from an offset that meant
    /// nothing to it.
    #[tokio::test]
    async fn spawn_forgets_the_previous_holders_spool_position() {
        let _serial = crate::sessions::native::test_serial().await;
        let dir = data_dir("spawnreset");
        let (_offsets, holder) = delta_holder(&dir, "spawnreset", b"FIRST\r\n", b"SECOND\r\n");
        let session = NativeSession::new("spawnreset", &dir);
        assert!(
            wait_until!(Duration::from_secs(5), session.spool_position().0 > 0),
            "precondition: the daemon must have a position to forget",
        );
        assert!(session.spool_position().1.is_some(), "…and an epoch for it");

        // The holder goes away, as it does when a session dies.
        holder.abort();
        let _ = std::fs::remove_file(spool::socket_path(&dir, "spawnreset"));
        assert!(wait_until!(Duration::from_secs(5), !session.attached()));

        // `spawn` never completes here — nothing binds the socket, so its attach
        // wait times out — but the reset it performs happens up front, which is
        // the whole point.
        std::env::set_var("SUPERMUX_HOLDER_BIN", "/bin/true");
        let _ = tokio::time::timeout(
            Duration::from_millis(500),
            session.spawn(&dir, &HashMap::new(), "sh"),
        )
        .await;
        std::env::remove_var("SUPERMUX_HOLDER_BIN");
        assert_eq!(
            session.spool_position(),
            (0, None),
            "a new holder must be asked for a FULL tail, not for a continuation of a \
             spool it has never written",
        );

        session.stop_pump();
        crate::sessions::native::forget("spawnreset");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pane must never inherit the daemon's AGENT-NESTING markers.
    ///
    /// The failure: supermux started from inside a Claude Code session carries
    /// `CLAUDE_CODE_CHILD_SESSION=1` in its environ, `Command::envs` only ADDS
    /// to the parent environment, so every `claude` we launch reads itself as a
    /// nested child — prints "Transcript saving is off", writes no `.jsonl`, and
    /// leaves the entire chat plane with nothing to read.
    ///
    /// Asserted END TO END on the real spawn: the holder stand-in is a script
    /// that dumps the environment it was handed. (`spawn` itself never
    /// completes — nothing binds the socket — but the exec happens up front,
    /// which is the whole point.)
    #[tokio::test]
    async fn a_spawned_pane_never_inherits_the_daemons_agent_nesting_markers() {
        use std::os::unix::fs::PermissionsExt;
        let _serial = crate::sessions::native::test_serial().await;
        let dir = data_dir("envscrub");
        let dumped = dir.join("child-env.txt");
        let script = dir.join("holder-stub.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\nenv > '{}'\n", dumped.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        // The poison, exactly as an agent-launched daemon would carry it.
        for key in crate::sessions::lifecycle::AGENT_NESTING_ENV {
            std::env::set_var(key, "1");
        }
        // …and one env var we DO pass, to prove the scrub is surgical.
        let mut env = HashMap::new();
        env.insert("SUPERMUX_SESSION".to_string(), "envscrub".to_string());

        let session = NativeSession::new("envscrub", &dir);
        std::env::set_var("SUPERMUX_HOLDER_BIN", &script);
        let _ = tokio::time::timeout(
            Duration::from_millis(1500),
            session.spawn(&dir, &env, "sh"),
        )
        .await;
        std::env::remove_var("SUPERMUX_HOLDER_BIN");
        for key in crate::sessions::lifecycle::AGENT_NESTING_ENV {
            std::env::remove_var(key);
        }

        let child_env = std::fs::read_to_string(&dumped)
            .expect("the holder stand-in must have run and dumped its environment");
        for key in crate::sessions::lifecycle::AGENT_NESTING_ENV {
            assert!(
                !child_env.lines().any(|l| l.starts_with(&format!("{key}="))),
                "a spawned pane inherited {key}:\n{child_env}",
            );
        }
        assert!(
            child_env.lines().any(|l| l == "SUPERMUX_SESSION=envscrub"),
            "the scrub must not touch the per-pane env supermux sets:\n{child_env}",
        );

        session.stop_pump();
        crate::sessions::native::forget("envscrub");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A holder stand-in that RE-HOMES itself: the first connection is one
    /// holder, every later one claims a different `(pid, started_at)` — a
    /// restarted session — and the second answers the daemon's stale position
    /// with a delta the daemon can not possibly apply.
    fn rehomed_holder(
        data_dir: &Path,
        name: &str,
        first: &'static [u8],
        gap: &'static [u8],
        whole: &'static [u8],
    ) -> (Arc<Mutex<Vec<u64>>>, tokio::task::JoinHandle<()>) {
        let sdir = spool::session_dir(data_dir, name);
        std::fs::create_dir_all(&sdir).unwrap();
        let sock = spool::socket_path(data_dir, name);
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();
        let seen: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let session = name.to_string();
        let task = tokio::spawn(async move {
            let mut nth = 0usize;
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let (rd, mut wr) = stream.into_split();
                let mut rd = BufReader::new(rd);
                let from = match proto::read_frame(&mut rd).await {
                    Ok(Some((proto::ATTACH_FROM, p))) => proto::parse_u64(&p).unwrap_or(0),
                    _ => 0,
                };
                recorder.lock().unwrap().push(from);
                // Connection 0 is holder A; everything after is holder B, which
                // only offers a delta while the daemon still carries A's offset.
                let (payload, delta, started_at) = match nth {
                    0 => (first, false, 1_000),
                    1 => (gap, from > 0, 2_000),
                    _ => (whole, false, 2_000),
                };
                let replay_from = if delta { from } else { 0 };
                let hello = proto::Hello {
                    session: session.clone(),
                    pid: std::process::id(),
                    cols: 80,
                    rows: 24,
                    started_at,
                    replay_bytes: payload.len() as u64,
                    spool_total: replay_from + payload.len() as u64,
                    replay_from,
                    delta,
                    spool_degraded: false,
                    spool_dropped: 0,
                };
                let body = serde_json::to_vec(&hello).unwrap();
                if proto::write_frame(&mut wr, proto::HELLO, &body).await.is_err() {
                    continue;
                }
                let _ = proto::write_frame(&mut wr, proto::OUTPUT, payload).await;
                nth += 1;
                if nth <= 2 {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                } else {
                    std::future::pending::<()>().await;
                }
            }
        });
        (seen, task)
    }

    /// A delta the daemon REJECTS must not be applied to a fresh grid. It was:
    /// the epoch check turned `delta` off, the grid was rebuilt from scratch —
    /// and then fed only the handful of bytes the holder had chosen as the gap.
    /// Everything before them (the session's whole head, `DECSET 1049` included)
    /// was silently gone. The connection is dropped instead, and the reconnect
    /// asks for a full tail.
    #[tokio::test]
    async fn a_delta_from_a_different_holder_disconnects_instead_of_wiping_the_grid() {
        let dir = data_dir("rehomed");
        let (offsets, holder) = rehomed_holder(
            &dir,
            "rehomed",
            b"OLD-HOLDER-HEAD\r\n",
            b"UNAPPLIABLE-GAP\r\n",
            b"NEW-HOLDER-HEAD\r\nNEW-HOLDER-TAIL\r\n",
        );
        let session = NativeSession::new("rehomed", &dir);

        // The end state: the NEW holder's full tail, both halves of it.
        assert!(
            wait_until!(
                Duration::from_secs(10),
                session.capture_full().await.contains("NEW-HOLDER-TAIL")
            ),
            "the daemon never got a usable replay:\n{}",
            session.capture_full().await,
        );
        let grid = session.capture_full().await;
        assert!(
            grid.contains("NEW-HOLDER-HEAD"),
            "the HEAD of the new holder's tail must be on the grid — losing it is exactly \
             the silent truncation this fixes:\n{grid}",
        );
        assert!(
            !grid.contains("UNAPPLIABLE-GAP"),
            "a rejected delta's bytes must never be applied on their own:\n{grid}",
        );

        let seen = offsets.lock().unwrap().clone();
        assert_eq!(seen.first(), Some(&0), "a fresh daemon has no position");
        assert!(seen.get(1).is_some_and(|n| *n > 0), "the reconnect carried a position");
        assert_eq!(
            seen.get(2),
            Some(&0),
            "after the rejection the daemon must ask for a FULL tail",
        );

        session.stop_pump();
        holder.abort();
        crate::sessions::native::forget("rehomed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A holder that ACCEPTS the socket and then says nothing used to park the
    /// pump inside `read_frame` for ever: no error, no flap, no backoff, and
    /// `detached` stuck with nothing on its way to fix it. The handshake is
    /// bounded, and the expiry is an ordinary disconnect.
    #[tokio::test]
    async fn a_holder_that_never_sends_hello_is_abandoned_rather_than_hung_on() {
        let dir = data_dir("silent");
        let sdir = spool::session_dir(&dir, "silent");
        std::fs::create_dir_all(&sdir).unwrap();
        let sock = spool::socket_path(&dir, "silent");
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();
        let accepted = Arc::new(AtomicU32::new(0));
        let counter = accepted.clone();
        let holder = tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                counter.fetch_add(1, Ordering::Relaxed);
                // Never a HELLO, and the connection is deliberately kept open.
                held.push(stream);
            }
        });
        let session = NativeSession::new("silent", &dir);

        assert!(
            wait_until!(
                HANDSHAKE_TIMEOUT * 3,
                accepted.load(Ordering::Relaxed) >= 2
            ),
            "the pump never abandoned the silent connection (it accepted {} in {:?})",
            accepted.load(Ordering::Relaxed),
            HANDSHAKE_TIMEOUT * 3,
        );
        assert!(!session.attached(), "a handshake that never completed is not an attach");
        // And a capture answers instead of sitting on the ready gate for a
        // session whose holder will never open it.
        let t0 = std::time::Instant::now();
        let _ = session.seed().await;
        assert!(
            t0.elapsed() < Duration::from_secs(1),
            "captures must not hang behind a stalled handshake ({:?})",
            t0.elapsed(),
        );

        session.stop_pump();
        holder.abort();
        crate::sessions::native::forget("silent");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The reconnect backoff. The storm reconnected every 250 ms indefinitely
    /// because `connect()` kept SUCCEEDING — only the connections were short.
    /// The backoff now grows on a flap, is capped, and is jittered so a daemon
    /// restart does not put every session's retry in the same slot.
    #[test]
    fn the_reconnect_backoff_grows_with_jitter_and_stays_capped() {
        let mut d = RECONNECT_MIN;
        let mut grew = false;
        for _ in 0..8 {
            let next = next_backoff(d);
            assert!(next >= RECONNECT_MIN, "never faster than the floor: {next:?}");
            assert!(next <= RECONNECT_MAX, "never slower than the ceiling: {next:?}");
            grew |= next > d;
            d = next;
        }
        assert!(grew, "repeated flaps must back off");

        // At the ceiling it stays at the ceiling.
        let mut d = RECONNECT_MAX;
        for _ in 0..20 {
            d = next_backoff(d);
            assert!(d <= RECONNECT_MAX);
        }

        // Jitter: two pumps in the same state do not retry in lockstep.
        let spread: std::collections::HashSet<u128> = (0..60)
            .map(|_| next_backoff(RECONNECT_MAX).as_millis())
            .collect();
        assert!(spread.len() > 5, "decorrelated jitter must spread retries out");
    }

    /// A REBUILD UNDER A RUNNING SERVER MUST NOT BREAK SESSION CREATION.
    ///
    /// Every native start spawns `<this binary> pty-holder`, located through
    /// `current_exe()` → `/proc/self/exe`. Replace the inode (a `cargo build`
    /// over `target/debug/supermux-server`, an installer writing the same path)
    /// and that link reads `…/supermux-server (deleted)`. `Command::new` on it
    /// is ENOENT, so on the rig EVERY `POST /api/sessions/<n>/start` answered a
    /// bare `{"error":"internal server error"}` for ~15 minutes with a single
    /// `spawn pty holder` line to explain it.
    ///
    /// The suffix is a decoration on a path that, after an install, holds a
    /// perfectly good binary — so we strip and re-probe, and only fail when
    /// there is genuinely nothing to spawn, with a sentence that says what to do.
    #[test]
    fn a_replaced_binary_falls_back_to_the_installed_path_instead_of_a_bare_500() {
        let live = PathBuf::from("/opt/supermux/bin/supermux-server");
        let deleted = PathBuf::from("/opt/supermux/bin/supermux-server (deleted)");

        assert_eq!(
            resolve_holder_bin(live.clone(), |p| p == live).unwrap(),
            live,
            "the ordinary case is untouched: the path exists, use it",
        );

        assert_eq!(
            resolve_holder_bin(deleted.clone(), |p| p == live).unwrap(),
            live,
            "a replaced inode resolves to the path it decorates — that is where the \
             NEW build was just installed",
        );

        // Nothing at either path: an error a human can act on, not silence.
        let err = format!("{:#}", resolve_holder_bin(deleted, |_| false).unwrap_err());
        assert!(
            err.contains(HOLDER_BIN_REPLACED),
            "the refusal must carry the restart instruction, got {err:?}",
        );
        let err = format!("{:#}", resolve_holder_bin(PathBuf::from("/nope/smx"), |_| false).unwrap_err());
        assert!(err.contains("/nope/smx"), "…and name the path, got {err:?}");
    }
}

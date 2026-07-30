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
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
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
use crate::sessions::tmux::HistoryWindow;

/// Live-byte fan-out depth. Same order as the tmux path's broadcast: a
/// subscriber that falls this far behind is lag-dropped downstream.
const BROADCAST_CAP: usize = 1024;
/// First reconnect delay after a failed/closed connection.
const RECONNECT_MIN: Duration = Duration::from_millis(250);
/// Reconnect backoff ceiling (a session whose holder is gone for good).
const RECONNECT_MAX: Duration = Duration::from_secs(5);
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
            pump_handle: Mutex::new(None),
        });
        let weak = Arc::downgrade(&me);
        let handle = tokio::spawn(pump(weak));
        *me.pump_handle.lock().unwrap() = Some(handle.abort_handle());
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
        if let Some(h) = self.pump_handle.lock().unwrap().take() {
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
        *self.exit_code.lock().unwrap() = None;
        // A pump parked on the previous child's exit has to come back to life,
        // otherwise nothing would ever connect to the holder we are about to
        // start (and the `detached` wait below would time out).
        self.restart.notify_one();

        let (cols, rows) = {
            let vt = self.vt.lock().unwrap();
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
        if self.exit_code.lock().unwrap().is_some() {
            return true;
        }
        if spool::read_exit(&self.dir).is_some() {
            return true;
        }
        if !*self.detached.borrow() {
            return false;
        }
        !probe_alive(&self.dir)
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
            let vt = self.vt.lock().unwrap();
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
        *self.requested_size.lock().unwrap() = Some((cols, rows));
        let res = self
            .send_frame(proto::RESIZE, &proto::resize_payload(cols, rows))
            .await;
        // Reflow locally even if the holder is momentarily unreachable: the
        // client's geometry is what the grid must match, and the next attach
        // re-sends the size.
        self.vt.lock().unwrap().resize(cols, rows);
        res
    }

    // ── 3. capture / seed ───────────────────────────────────────────────────

    /// `tmux capture-pane -p -S -<lines>` equivalent (plain rows, `\n`-joined).
    pub async fn capture_plain(&self, lines: usize) -> String {
        self.await_ready().await;
        self.vt.lock().unwrap().capture_plain(lines)
    }

    /// `tmux capture-pane -pe -S -<lines>` equivalent (SGR rows, `\n`-joined).
    pub async fn capture_ansi(&self, lines: usize) -> String {
        self.await_ready().await;
        self.vt.lock().unwrap().capture_ansi(lines)
    }

    /// `tmux capture-pane -p -e` equivalent — the visible screen only.
    pub async fn capture_screen_ansi(&self) -> String {
        self.await_ready().await;
        self.vt.lock().unwrap().capture_screen_ansi()
    }

    /// Entire history + viewport, plain (the `archive` dump).
    pub async fn capture_full(&self) -> String {
        self.await_ready().await;
        self.vt.lock().unwrap().capture_full()
    }

    /// Alt-screen-aware WS attach seed, built with the same framers the tmux
    /// path uses.
    pub async fn seed(&self) -> String {
        self.await_ready().await;
        self.vt.lock().unwrap().seed()
    }

    /// One window of scrollback rows, JSON-compatible with the tmux path's
    /// `HistoryWindow` (same struct, in fact).
    pub async fn history_window(&self, end_offset: i64, count: u32) -> HistoryWindow {
        self.await_ready().await;
        self.vt.lock().unwrap().history_window(end_offset, count)
    }

    /// `(history_size, cols)` for the WS `attach_meta` frame.
    pub async fn history_meta(&self) -> (u32, u16) {
        self.await_ready().await;
        self.vt.lock().unwrap().history_meta()
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
        self.vt.lock().unwrap().take_damage()
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
        let (rd, wr) = stream.into_split();
        let mut rd = tokio::io::BufReader::with_capacity(64 * 1024, rd);

        // 1. HELLO — geometry + how many replay bytes are coming.
        let hello: proto::Hello = match proto::read_frame(&mut rd).await? {
            Some((proto::HELLO, payload)) => serde_json::from_slice(&payload).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, format!("HELLO: {e}"))
            })?,
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "holder did not send HELLO first",
                ))
            }
        };
        self.pid.store(hello.pid, Ordering::Relaxed);

        // 2. A FRESH grid — the replay that follows rebuilds it from bytes.
        //    This is the deploy-survival path.
        //
        //    Geometry: `HELLO` reports what the holder currently has, which is
        //    STALE if a client resized while we were detached (the RESIZE frame
        //    had nowhere to go). The remembered request wins, and is re-sent to
        //    the holder below so the pty and the grid agree.
        let want = *self.requested_size.lock().unwrap();
        let (cols, rows) = want.unwrap_or((hello.cols, hello.rows));
        *self.vt.lock().unwrap() = Vt::new(cols, rows);
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
                    self.vt.lock().unwrap().advance(&payload);
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
                    *self.exit_code.lock().unwrap() = Some(code);
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

/// The connection pump: connect, serve, back off, repeat — until the session
/// object is dropped (the `Weak` stops upgrading), the pump is aborted
/// ([`NativeSession::stop_pump`]), or the child exits (it PARKS then, and a
/// fresh [`NativeSession::spawn`] wakes it).
async fn pump(weak: Weak<NativeSession>) {
    let mut delay = RECONNECT_MIN;
    loop {
        let session = match weak.upgrade() {
            Some(s) => s,
            None => return,
        };
        if session.stopped.load(Ordering::Relaxed) {
            return;
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
        match UnixStream::connect(&socket).await {
            Ok(stream) => {
                delay = RECONNECT_MIN;
                if let Err(e) = session.serve(stream).await {
                    tracing::debug!(session = %session.name, error = %e, "native: holder connection ended");
                }
            }
            Err(_) => {
                session.detached.send_replace(true);
                // No holder to wait for — a capture must not sit on the ready
                // gate for a session that has nothing serving it.
                session.ready.send_replace(true);
                delay = (delay * 2).min(RECONNECT_MAX);
            }
        }
        // Drop the strong ref BEFORE sleeping so a dropped session's pump can
        // notice and exit promptly.
        drop(session);
        tokio::time::sleep(delay).await;
    }
}

/// NON-DESTRUCTIVE liveness probe for the session spooled at `dir`: is its child
/// still running?
///
/// Deliberately touches nothing but the filesystem and `kill(pid, 0)` — see
/// [`NativeSession::dead`] for why connecting to the holder's socket is not an
/// option. Answers for a session this process has never attached to (the boot
/// reconcile), which is why it is a free function over the spool dir.
///
/// Caveat: a pid can be REUSED after a holder is `SIGKILL`ed without writing its
/// `exit` marker, which would read as alive. The marker is written on every
/// ordinary exit path, so this needs an out-of-band kill *and* a pid wrap to
/// misfire — and the pump then simply fails to connect and backs off.
pub fn probe_alive(dir: &Path) -> bool {
    if spool::read_exit(dir).is_some() {
        return false;
    }
    match spool::read_meta(dir) {
        Some(m) if m.pid > 1 => pid_alive(m.pid),
        _ => false,
    }
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

/// Path to the binary that hosts the `pty-holder` subcommand. `SUPERMUX_HOLDER_BIN`
/// overrides it (tests, and an operator pinning a specific build).
fn holder_bin() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("SUPERMUX_HOLDER_BIN") {
        return Ok(PathBuf::from(p));
    }
    std::env::current_exe().context("locate the supermux-server binary for the pty holder")
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
                };
                let body = serde_json::to_vec(&hello).unwrap();
                if proto::write_frame(&mut wr, proto::HELLO, &body).await.is_err() {
                    continue;
                }
                let tx2 = tx.clone();
                let reader = tokio::spawn(async move {
                    let mut rd = BufReader::new(rd);
                    while let Ok(Some(frame)) = proto::read_frame(&mut rd).await {
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
            cols: 80,
            rows: 24,
            started_at: 0,
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
}

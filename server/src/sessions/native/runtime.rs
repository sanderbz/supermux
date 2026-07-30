//! [`NativeSession`] — the daemon-side handle for one tmux-less session.
//!
//! It owns the VT grid, one socket connection to the session's holder, and the
//! live-byte fan-out that [`super::reader::NativePtyReader`] feeds into the
//! existing `PtySink`.
//!
//! **The pump.** A background task per session keeps the connection up:
//!
//! ```text
//!   connect → HELLO → fresh Vt at the holder's geometry
//!           → replay frames  (rebuild the grid, NOT forwarded to WS clients)
//!           → live frames    (grid + broadcast to subscribers)
//!           → disconnect → back off → connect …
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
use tokio::sync::{broadcast, watch, Mutex as AsyncMutex};

use super::keys::key_bytes;
use super::vt::{Damage, Vt};
use super::{holder, proto, spool};
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
    /// Set when the pump should stop for good (session object dropped).
    stopped: AtomicBool,
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
        });
        let weak = Arc::downgrade(&me);
        tokio::spawn(pump(weak));
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
    /// daemon. Otherwise: attached means alive; detached means we probe the
    /// socket, which is safe precisely because we hold no connection the probe
    /// could displace.
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
        !holder::socket_live(&self.socket).await
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
        self.vt.lock().unwrap().capture_plain(lines)
    }

    /// `tmux capture-pane -pe -S -<lines>` equivalent (SGR rows, `\n`-joined).
    pub async fn capture_ansi(&self, lines: usize) -> String {
        self.vt.lock().unwrap().capture_ansi(lines)
    }

    /// `tmux capture-pane -p -e` equivalent — the visible screen only.
    pub async fn capture_screen_ansi(&self) -> String {
        self.vt.lock().unwrap().capture_screen_ansi()
    }

    /// Entire history + viewport, plain (the `archive` dump).
    pub async fn capture_full(&self) -> String {
        self.vt.lock().unwrap().capture_full()
    }

    /// Alt-screen-aware WS attach seed, built with the same framers the tmux
    /// path uses.
    pub async fn seed(&self) -> String {
        self.vt.lock().unwrap().seed()
    }

    /// One window of scrollback rows, JSON-compatible with the tmux path's
    /// `HistoryWindow` (same struct, in fact).
    pub async fn history_window(&self, end_offset: i64, count: u32) -> HistoryWindow {
        self.vt.lock().unwrap().history_window(end_offset, count)
    }

    /// `(history_size, cols)` for the WS `attach_meta` frame.
    pub async fn history_meta(&self) -> (u32, u16) {
        self.vt.lock().unwrap().history_meta()
    }

    /// The child's pid — from `HELLO` when attached, else from `meta.json`.
    pub async fn pane_pid(&self) -> Option<u32> {
        match self.pid.load(Ordering::Relaxed) {
            0 => spool::read_meta(&self.dir).map(|m| m.pid),
            pid => Some(pid),
        }
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

    /// Chunk + send raw input bytes to the pty.
    async fn write_input(&self, bytes: &[u8]) -> Result<()> {
        for chunk in bytes.chunks(INPUT_CHUNK) {
            self.send_frame(proto::INPUT, chunk).await?;
        }
        Ok(())
    }

    /// Send one frame on the holder connection. A write error drops the
    /// connection so the pump reconnects (and replays).
    async fn send_frame(&self, kind: u8, payload: &[u8]) -> Result<()> {
        let mut g = self.writer.lock().await;
        let w = g.as_mut().ok_or_else(|| {
            anyhow!("native session '{}' is not attached to a holder", self.name)
        })?;
        if let Err(e) = proto::write_frame(w, kind, payload).await {
            *g = None;
            self.detached.send_replace(true);
            return Err(anyhow!("native session '{}': holder write failed: {e}", self.name));
        }
        Ok(())
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

        // 2. A FRESH grid at the holder's geometry — the replay that follows
        //    rebuilds it from bytes. This is the deploy-survival path.
        *self.vt.lock().unwrap() = Vt::new(hello.cols, hello.rows);
        let mut replay_left = hello.replay_bytes;

        *self.writer.lock().await = Some(wr);
        self.detached.send_replace(false);
        tracing::info!(
            session = %self.name,
            pid = hello.pid,
            replay_bytes = hello.replay_bytes,
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
                    replay_left -= live_from as u64;
                    if live_from < payload.len() {
                        let _ = self.live.send(Bytes::from(payload[live_from..].to_vec()));
                    }
                }
                Ok(Some((proto::EXIT, payload))) => {
                    let code = proto::parse_i32(&payload).unwrap_or(-1);
                    *self.exit_code.lock().unwrap() = Some(code);
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
/// object is dropped (the `Weak` stops upgrading).
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
                delay = (delay * 2).min(RECONNECT_MAX);
            }
        }
        // Drop the strong ref BEFORE sleeping so a dropped session's pump can
        // notice and exit promptly.
        drop(session);
        tokio::time::sleep(delay).await;
    }
}

/// Path to the binary that hosts the `pty-holder` subcommand. `SUPERMUX_HOLDER_BIN`
/// overrides it (tests, and an operator pinning a specific build).
fn holder_bin() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("SUPERMUX_HOLDER_BIN") {
        return Ok(PathBuf::from(p));
    }
    std::env::current_exe().context("locate the supermux-server binary for the pty holder")
}

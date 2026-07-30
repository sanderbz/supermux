//! The **pty holder** — a tiny detached process that owns one session's pty
//! master and outlives the daemon.
//!
//! ```text
//!   browser ⇄ supermux-daemon (VT grid + scrollback)
//!                  ⇅  unix socket (proto.rs frames)
//!            supermux-holder  (pty master + append-only spool)
//!                  ⇅  pty
//!            bash -lc <shell>  →  claude / codex / shell
//! ```
//!
//! **Why it exists.** The systemd unit uses `KillMode=process`, so a deploy
//! restarts ONLY the daemon; every process the daemon *forked* keeps running.
//! That is exactly how tmux survives a deploy today. Putting the pty master in
//! a holder process gives the native runtime the same survival property without
//! tmux: the child never notices the daemon went away, and the reconnecting
//! daemon rebuilds its VT grid by replaying the holder's spool.
//!
//! **Robustness rules** (in priority order):
//!
//! 1. *The daemon going away must never disturb the child.* No daemon
//!    connection is required to run; output keeps flowing to the spool. A
//!    daemon that reads too slowly is DISCONNECTED (its queue is dropped)
//!    rather than allowed to apply backpressure to the pty — it will reconnect
//!    and replay, which is lossless because the spool is the source of truth.
//! 2. *The spool is always written.* Spool write errors are logged and
//!    swallowed; they never kill the child.
//! 3. *Exactly one daemon at a time.* A new connection replaces the old one.
//! 4. *The holder exits when the child does* — after draining the pty,
//!    flushing the spool, writing the `exit` marker and sending an `EXIT`
//!    frame.
//!
//! Rust's runtime sets `SIGPIPE` to `SIG_IGN`, so writing to a socket whose
//! daemon vanished returns `EPIPE` to the connection task instead of killing
//! the holder.

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use tokio::io::unix::AsyncFd;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

use super::proto;
use super::spool::{self, Spool};

/// Pty read chunk (matches the tmux-path reader's `READ_CHUNK`).
pub const CHUNK: usize = 8192;
/// Bytes per `OUTPUT` frame when streaming the replay tail.
const REPLAY_CHUNK: usize = 64 * 1024;
/// Frames queued for the connected daemon before it is declared lagged and
/// disconnected. 1024 × 8 KiB ≈ 8 MiB of slack — a daemon that falls further
/// behind than that is better served by a reconnect + replay.
const QUEUE_DEPTH: usize = 1024;
/// How long we keep draining the pty after the child exits (last output).
const DRAIN: std::time::Duration = std::time::Duration::from_millis(500);
/// Grace period for the connection writer to flush the final `EXIT` frame.
const EXIT_FLUSH: std::time::Duration = std::time::Duration::from_millis(150);

/// Parsed `supermux-server pty-holder …` command line.
#[derive(Debug, Clone)]
pub struct Args {
    /// Session name (identifies the spool dir and appears in `Hello`).
    pub session: String,
    /// Spool directory (`<data_dir>/native/<session>`).
    pub dir: PathBuf,
    /// Unix listener path.
    pub socket: PathBuf,
    /// Initial pty width.
    pub cols: u16,
    /// Initial pty height.
    pub rows: u16,
    /// The shell command, run as `bash -lc <command>`.
    pub command: String,
}

impl Args {
    /// Parse `--session X --dir D --socket S --cols N --rows N -- <command…>`.
    /// Everything after `--` is joined with spaces into one `bash -lc` string.
    pub fn parse<I: Iterator<Item = String>>(argv: I) -> Result<Self> {
        let (mut session, mut dir, mut socket) = (None, None, None);
        let (mut cols, mut rows) = (80u16, 24u16);
        let mut command: Vec<String> = Vec::new();
        let mut it = argv.peekable();
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--session" => session = it.next(),
                "--dir" => dir = it.next().map(PathBuf::from),
                "--socket" => socket = it.next().map(PathBuf::from),
                "--cols" => cols = it.next().and_then(|v| v.parse().ok()).unwrap_or(80),
                "--rows" => rows = it.next().and_then(|v| v.parse().ok()).unwrap_or(24),
                "--" => {
                    command.extend(it.by_ref());
                    break;
                }
                other => bail!("pty-holder: unexpected argument {other:?}"),
            }
        }
        let session = session.ok_or_else(|| anyhow!("pty-holder: --session is required"))?;
        let dir = dir.unwrap_or_else(|| PathBuf::from("."));
        let socket = socket.unwrap_or_else(|| dir.join("holder.sock"));
        if command.is_empty() {
            bail!("pty-holder: no command after `--`");
        }
        Ok(Self {
            session,
            dir,
            socket,
            cols: cols.max(1),
            rows: rows.max(1),
            command: command.join(" "),
        })
    }
}

/// `main.rs` entry point for the hidden `pty-holder` subcommand.
pub async fn main<I: Iterator<Item = String>>(argv: I) -> Result<()> {
    let args = Args::parse(argv)?;
    run(args).await
}

// ── pty master ──────────────────────────────────────────────────────────────

/// The pty master, owned as a `File` so `&File: Read + Write` gives us plain
/// `io::Result` inside `AsyncFd::try_io` (no fd-type churn across nix versions).
struct Master(File);

impl AsRawFd for Master {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_raw_fd()
    }
}

/// `TIOCSWINSZ` on `fd`. The child sees `SIGWINCH` and repaints.
fn set_winsize(fd: RawFd, cols: u16, rows: u16) -> std::io::Result<()> {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: `fd` is a live pty master; `ws` outlives the call.
    let rc = unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &ws) };
    if rc == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

// ── shared holder state ─────────────────────────────────────────────────────

/// One frame queued for the connected daemon.
type Frame = (u8, Vec<u8>);

/// State guarded by ONE mutex so the spool append and the live-queue push are a
/// single critical section. That is what makes the attach handshake gap-free:
/// a chunk is either in the replay snapshot or in the queue, never both.
struct Inner {
    spool: Spool,
    live: Option<mpsc::Sender<Frame>>,
    cols: u16,
    rows: u16,
    exited: bool,
}

struct Holder {
    session: String,
    pid: u32,
    started_at: i64,
    master: Arc<AsyncFd<Master>>,
    inner: Mutex<Inner>,
}

impl Holder {
    /// Append pty output to the spool AND hand it to the connected daemon, in
    /// one critical section. A full/closed queue disconnects the daemon (it
    /// reconnects and replays) — the pty is never blocked by a slow reader.
    fn on_output(&self, bytes: &[u8]) {
        let mut g = self.inner.lock().unwrap();
        if let Err(e) = g.spool.append(bytes) {
            tracing::warn!(session = %self.session, error = %e, "native holder: spool append failed");
        }
        if let Some(tx) = &g.live {
            if tx.try_send((proto::OUTPUT, bytes.to_vec())).is_err() {
                tracing::info!(
                    session = %self.session,
                    "native holder: daemon lagged or gone — dropping connection (it will replay)",
                );
                g.live = None;
            }
        }
    }

    /// Queue a non-output frame (`EXIT`, `INFO`) for the connected daemon.
    fn publish(&self, kind: u8, payload: Vec<u8>) {
        let mut g = self.inner.lock().unwrap();
        if let Some(tx) = &g.live {
            if tx.try_send((kind, payload)).is_err() {
                g.live = None;
            }
        }
    }

    /// Write `bytes` to the pty master, awaiting writability as needed.
    async fn write_master(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut off = 0;
        while off < bytes.len() {
            let mut guard = self.master.writable().await?;
            match guard.try_io(|inner| (&inner.get_ref().0).write(&bytes[off..])) {
                Ok(Ok(0)) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "pty master accepted 0 bytes",
                    ))
                }
                Ok(Ok(n)) => off += n,
                Ok(Err(e)) => return Err(e),
                Err(_would_block) => continue,
            }
        }
        Ok(())
    }
}

// ── run ─────────────────────────────────────────────────────────────────────

/// Run the holder to completion: open a pty, spawn the child, serve daemon
/// connections, exit when the child exits.
///
/// The child inherits the holder's OWN cwd and environment — the daemon sets
/// those on the holder process at spawn time. Nothing sensitive (session env,
/// hook tokens) ever travels through argv, so it can't leak via `ps`.
pub async fn run(args: Args) -> Result<()> {
    let Args { session, dir, socket, cols, rows, command } = args;

    let mut spool = Spool::create(&dir).context("create spool")?;

    // 0. Bind the listener FIRST. Everything after this forks a child, and a
    //    late `bind` failure (a stale socket we cannot remove, a path over
    //    `SUN_LEN`) would strand that child with no holder and no daemon. A
    //    stale socket file from a previous holder is removed first — `bind`
    //    fails with EADDRINUSE on an existing path even when nothing listens,
    //    and the daemon's `spawn` guarantees no live holder is bound here.
    if let Some(parent) = socket.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).with_context(|| {
        format!(
            "bind {} ({} bytes; unix socket paths are capped at ~108)",
            socket.display(),
            socket.as_os_str().len(),
        )
    })?;

    // 1. pty pair, sized before the child ever runs so its first paint is
    //    already at the right geometry.
    let ws = nix::pty::Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let pty = nix::pty::openpty(Some(&ws), None).context("openpty")?;
    let master_fd: OwnedFd = pty.master;
    let slave_fd: OwnedFd = pty.slave;

    // Non-blocking master so `AsyncFd` can drive it from the reactor.
    nix::fcntl::fcntl(
        master_fd.as_raw_fd(),
        nix::fcntl::FcntlArg::F_SETFL(nix::fcntl::OFlag::O_NONBLOCK),
    )
    .context("set O_NONBLOCK on pty master")?;

    // 2. Spawn `bash -lc <command>` on the slave. `-l` (login shell) matches
    //    what the tmux path gets, so PATH/profile behave identically.
    let stdin = slave_fd.try_clone().context("dup slave")?;
    let stdout = slave_fd.try_clone().context("dup slave")?;
    let stderr = slave_fd.try_clone().context("dup slave")?;
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg("-lc")
        .arg(&command)
        .stdin(std::process::Stdio::from(stdin))
        .stdout(std::process::Stdio::from(stdout))
        .stderr(std::process::Stdio::from(stderr));
    // SAFETY: `pre_exec` runs in the forked child AFTER std has dup2'd the
    // slave onto fds 0/1/2 and before `exec`. `setsid` + `TIOCSCTTY` on fd 0
    // make the child a session leader with the pty as its CONTROLLING
    // terminal — without it Ctrl-C/job control/`isatty`-gated TUIs misbehave.
    // Only async-signal-safe libc calls are used.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().context("spawn child shell")?;
    let pid = child.id().ok_or_else(|| anyhow!("child exited before we got its pid"))?;

    // The parent must NOT keep the slave open, or the master read never sees
    // EOF/EIO when the child dies.
    drop(slave_fd);

    let started_at = chrono::Utc::now().timestamp();
    spool::write_meta(
        &dir,
        &spool::Meta {
            session: session.clone(),
            pid,
            cols,
            rows,
            started_at,
            command: command.clone(),
        },
    )
    .context("write meta.json")?;
    let _ = spool.flush();

    let master = Arc::new(AsyncFd::new(Master(File::from(master_fd))).context("AsyncFd(master)")?);
    let holder = Arc::new(Holder {
        session: session.clone(),
        pid,
        started_at,
        master: master.clone(),
        inner: Mutex::new(Inner { spool, live: None, cols, rows, exited: false }),
    });

    // 3. Start serving daemon connections on the listener bound in step 0.
    let acceptor = tokio::spawn(accept_loop(holder.clone(), listener));

    // 4. Pump pty → spool/daemon until EOF (child gone).
    let pump = tokio::spawn(pty_pump(holder.clone(), master));

    // 5. Wait for the child, then drain whatever it printed on its way out.
    let status = child.wait().await.context("wait for child")?;
    let code = status.code().unwrap_or(-1);
    let _ = tokio::time::timeout(DRAIN, pump).await;

    {
        let mut g = holder.inner.lock().unwrap();
        g.exited = true;
        let _ = g.spool.flush();
    }
    spool::mark_exit(&dir, code);
    holder.publish(proto::EXIT, code.to_be_bytes().to_vec());
    // Give the connection writer a moment to push the EXIT frame out.
    tokio::time::sleep(EXIT_FLUSH).await;
    acceptor.abort();
    let _ = std::fs::remove_file(&socket);
    tracing::info!(session = %session, code, "native holder: child exited, holder done");
    Ok(())
}

/// pty master → spool + connected daemon. Ends on EOF/`EIO` (the child and all
/// its descendants closed the slave), which is the holder's "child is gone"
/// signal.
async fn pty_pump(holder: Arc<Holder>, master: Arc<AsyncFd<Master>>) {
    let mut buf = [0u8; CHUNK];
    loop {
        let mut guard = match master.readable().await {
            Ok(g) => g,
            Err(e) => {
                tracing::warn!(error = %e, "native holder: pty readable() failed");
                return;
            }
        };
        match guard.try_io(|inner| (&inner.get_ref().0).read(&mut buf)) {
            // EOF: every slave fd is closed.
            Ok(Ok(0)) => return,
            Ok(Ok(n)) => holder.on_output(&buf[..n]),
            // Linux reports "last slave closed" as EIO on the master.
            Ok(Err(e)) => {
                if e.raw_os_error() != Some(libc::EIO) {
                    tracing::warn!(error = %e, "native holder: pty read failed");
                }
                return;
            }
            Err(_would_block) => continue,
        }
    }
}

/// Accept daemon connections forever. A new connection REPLACES the previous
/// one: installing the new queue drops the old sender, which ends the old
/// connection's writer and closes its socket.
async fn accept_loop(holder: Arc<Holder>, listener: UnixListener) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "native holder: accept failed");
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                continue;
            }
        };
        // Cutover under the lock: snapshot the spool tail and install the new
        // queue atomically, so no byte is duplicated or lost across the seam.
        let (hello, replay) = {
            let mut g = holder.inner.lock().unwrap();
            let (tx, rx) = mpsc::channel::<Frame>(QUEUE_DEPTH);
            let tail = g.spool.replay_tail(spool::REPLAY_TAIL).unwrap_or_default();
            g.live = Some(tx);
            let hello = proto::Hello {
                session: holder.session.clone(),
                pid: holder.pid,
                cols: g.cols,
                rows: g.rows,
                started_at: holder.started_at,
                replay_bytes: tail.len() as u64,
                spool_total: g.spool.total(),
            };
            (hello, (tail, rx))
        };
        let (tail, rx) = replay;
        tokio::spawn(serve_conn(holder.clone(), stream, hello, tail, rx));
    }
}

/// One daemon connection: `HELLO` + replay + live frames out; control frames in.
/// Either half finishing tears the whole connection down.
async fn serve_conn(
    holder: Arc<Holder>,
    stream: UnixStream,
    hello: proto::Hello,
    replay: Vec<u8>,
    mut rx: mpsc::Receiver<Frame>,
) {
    let (mut rd, mut wr) = tokio::io::split(stream);

    let writer = async move {
        let payload = serde_json::to_vec(&hello).unwrap_or_default();
        proto::write_frame(&mut wr, proto::HELLO, &payload).await?;
        for chunk in replay.chunks(REPLAY_CHUNK) {
            proto::write_frame(&mut wr, proto::OUTPUT, chunk).await?;
        }
        while let Some((kind, payload)) = rx.recv().await {
            proto::write_frame(&mut wr, kind, &payload).await?;
        }
        Ok::<(), std::io::Error>(())
    };

    let h = holder.clone();
    let reader = async move {
        loop {
            match proto::read_frame(&mut rd).await {
                Ok(Some((kind, payload))) => handle_frame(&h, kind, payload).await,
                Ok(None) => return Ok::<(), std::io::Error>(()), // daemon closed
                Err(e) => return Err(e),
            }
        }
    };

    tokio::select! {
        r = writer => if let Err(e) = r {
            tracing::debug!(session = %holder.session, error = %e, "native holder: writer ended");
        },
        r = reader => if let Err(e) = r {
            tracing::debug!(session = %holder.session, error = %e, "native holder: reader ended");
        },
    }
}

/// Apply one daemon→holder control frame.
async fn handle_frame(holder: &Arc<Holder>, kind: u8, payload: Vec<u8>) {
    match kind {
        proto::INPUT => {
            if let Err(e) = holder.write_master(&payload).await {
                tracing::warn!(error = %e, "native holder: pty write failed");
            }
        }
        proto::RESIZE => {
            if let Some((cols, rows)) = proto::parse_resize(&payload) {
                let (cols, rows) = (cols.max(1), rows.max(1));
                if let Err(e) = set_winsize(holder.master.get_ref().as_raw_fd(), cols, rows) {
                    tracing::warn!(error = %e, "native holder: TIOCSWINSZ failed");
                } else {
                    let mut g = holder.inner.lock().unwrap();
                    g.cols = cols;
                    g.rows = rows;
                }
            }
        }
        proto::SIGNAL => {
            if let Some(sig) = proto::parse_i32(&payload) {
                signal_child(holder.pid, sig);
            }
        }
        proto::QUERY => {
            let info = {
                let g = holder.inner.lock().unwrap();
                proto::Info {
                    pid: holder.pid,
                    exited: g.exited,
                    cols: g.cols,
                    rows: g.rows,
                    spool_total: g.spool.total(),
                }
            };
            holder.publish(proto::INFO, serde_json::to_vec(&info).unwrap_or_default());
        }
        other => tracing::debug!(kind = other, "native holder: ignoring unknown frame kind"),
    }
}

/// Signal the child's whole process GROUP (the child called `setsid`, so its
/// pgid == its pid). Group-wide is what makes `kill` reach an agent's own
/// children — the tmux path gets this for free from `kill-session`.
fn signal_child(pid: u32, sig: i32) {
    // SAFETY: plain libc call; a stale pid yields ESRCH, which we ignore.
    unsafe {
        libc::killpg(pid as i32, sig);
    }
}

/// Best-effort "is a holder listening at `socket`?" — used by the daemon to
/// decide spawn-vs-reattach and to answer `alive()`.
pub async fn socket_live(socket: &Path) -> bool {
    UnixStream::connect(socket).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_takes_geometry_and_joins_the_trailing_command() {
        let argv = [
            "--session", "demo", "--dir", "/tmp/d", "--socket", "/tmp/d/holder.sock", "--cols",
            "120", "--rows", "40", "--", "claude", "--resume",
        ]
        .into_iter()
        .map(String::from);
        let a = Args::parse(argv).unwrap();
        assert_eq!(a.session, "demo");
        assert_eq!(a.dir, PathBuf::from("/tmp/d"));
        assert_eq!((a.cols, a.rows), (120, 40));
        assert_eq!(a.command, "claude --resume");
    }

    #[test]
    fn parse_defaults_geometry_and_socket_and_rejects_an_empty_command() {
        let a = Args::parse(
            ["--session", "s", "--dir", "/tmp/x", "--", "bash"]
                .into_iter()
                .map(String::from),
        )
        .unwrap();
        assert_eq!((a.cols, a.rows), (80, 24));
        assert_eq!(a.socket, PathBuf::from("/tmp/x/holder.sock"));
        assert!(Args::parse(["--session", "s"].into_iter().map(String::from)).is_err());
        assert!(Args::parse(["--bogus"].into_iter().map(String::from)).is_err());
    }
}

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
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use tokio::io::unix::AsyncFd;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

use super::proto;
use super::spool::{self, Spool, TailReader};

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
/// Mode forced on `holder.sock` right after `bind`. Anyone who can `connect()`
/// this socket can write arbitrary bytes to the pty — i.e. run commands as the
/// service user — and read every byte the child prints. `bind` applies the
/// process umask (0755 under the default 022), so it is chmod'ed explicitly.
const SOCKET_MODE: u32 = 0o600;
/// Signals the daemon may ask us to deliver to the child's process group.
///
/// The `SIGNAL` frame carries an arbitrary `i32` that used to be handed
/// straight to `killpg`. Anything else is dropped with a log line: the daemon
/// only ever needs terminate-shaped signals ([`super::runtime::NativeSession::kill`]
/// sends `SIGHUP` then `SIGKILL`), and an allowlist means a compromised or
/// buggy peer cannot aim `SIGSTOP`/`SIGCONT`/`SIGUSR*`/realtime signals at an
/// agent's process group.
const SIGNAL_ALLOWLIST: [i32; 4] = [libc::SIGHUP, libc::SIGINT, libc::SIGTERM, libc::SIGKILL];

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
        spool::ensure_dir(parent)?;
    }
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).with_context(|| {
        format!(
            "bind {} ({} bytes; unix socket paths are capped at ~108)",
            socket.display(),
            socket.as_os_str().len(),
        )
    })?;
    // Close the world-connectable window immediately (the containing dir is
    // already 0700, so this is the second lock on the same door).
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(SOCKET_MODE))
        .with_context(|| format!("chmod {SOCKET_MODE:o} {}", socket.display()))?;
    // Identity of the socket WE bound. On exit we unlink the path only if it
    // still resolves to this inode — see `remove_socket_if_ours`.
    let socket_id = path_id(&socket);

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
    // Unlink BEFORE the flush grace, not after. The daemon treats a connectable
    // socket as "holder alive", so the moment `EXIT` lands it may `spawn` a
    // successor for the same name — which binds a FRESH socket at this path.
    // Unlinking after a 150 ms sleep would delete that successor's socket,
    // orphaning its child. Unlinking first shrinks the window to nothing, and
    // the inode check closes what is left of it.
    remove_socket_if_ours(&socket, socket_id);
    // Give the connection writer a moment to push the EXIT frame out. We are
    // still listening (on an unlinked inode) — harmless: nobody can reach it.
    tokio::time::sleep(EXIT_FLUSH).await;
    acceptor.abort();
    tracing::info!(session = %session, code, "native holder: child exited, holder done");
    Ok(())
}

/// `(st_dev, st_ino)` of `path`, without following symlinks.
fn path_id(path: &Path) -> Option<(u64, u64)> {
    std::fs::symlink_metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

/// Unlink `socket` only if the path still names the inode we bound.
///
/// A successor holder that already re-bound the path has a DIFFERENT inode
/// there; removing it would leave its child running with no reachable holder
/// (and the daemon spawning a third one). Note `fstat` on the listener fd is
/// useless for this on Linux — an `AF_UNIX` fd stats to an anonymous sockfs
/// inode, never to the filesystem inode the path resolves to — so the identity
/// is taken from the PATH right after `bind` instead.
fn remove_socket_if_ours(socket: &Path, ours: Option<(u64, u64)>) {
    match (ours, path_id(socket)) {
        (Some(a), Some(b)) if a == b => {
            let _ = std::fs::remove_file(socket);
        }
        (_, None) => {} // already gone
        _ => tracing::info!(
            socket = %socket.display(),
            "native holder: socket was replaced by a successor — leaving it alone",
        ),
    }
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
        // Cutover under the lock — but WITHOUT the I/O. What has to be atomic
        // with respect to `on_output` is (a) fixing the replay tail's END
        // boundary and (b) installing the new queue; both are O(1) here.
        // Reading those bytes (up to 8 MiB) is deliberately left to
        // `serve_conn`, because this lock is the one every pty chunk needs and
        // holding it across a multi-MiB read makes the CHILD block in `write()`.
        //
        // Exactly-once still holds, and is now easier to see:
        //   * a chunk appended BEFORE the cutover is inside the snapshot's
        //     byte range and is not in the queue (the queue did not exist);
        //   * a chunk appended AFTER it goes to the queue, and lands in the
        //     spool strictly past the snapshot's end offset, so the replay read
        //     cannot pick it up;
        //   * the boundary is a single point in time under one lock, so there
        //     is no "neither" case either.
        // The snapshot survives the lock release because spool segments are
        // append-only and `TailReader` holds fds that pin them (see
        // `spool::Spool::tail_reader`).
        let (hello, tail, rx) = {
            let mut g = holder.inner.lock().unwrap();
            let (tx, rx) = mpsc::channel::<Frame>(QUEUE_DEPTH);
            let tail = match g.spool.tail_reader(spool::REPLAY_TAIL) {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!(session = %holder.session, error = %e, "native holder: replay snapshot failed");
                    continue;
                }
            };
            g.live = Some(tx);
            let hello = proto::Hello {
                session: holder.session.clone(),
                pid: holder.pid,
                cols: g.cols,
                rows: g.rows,
                started_at: holder.started_at,
                replay_bytes: tail.len(),
                spool_total: g.spool.total(),
            };
            (hello, tail, rx)
        };
        tokio::spawn(serve_conn(holder.clone(), stream, hello, tail, rx));
    }
}

/// One daemon connection: `HELLO` + replay + live frames out; control frames in.
/// Either half finishing tears the whole connection down.
async fn serve_conn(
    holder: Arc<Holder>,
    stream: UnixStream,
    hello: proto::Hello,
    tail: TailReader,
    mut rx: mpsc::Receiver<Frame>,
) {
    let (mut rd, mut wr) = tokio::io::split(stream);

    let writer = async move {
        let payload = serde_json::to_vec(&hello).unwrap_or_default();
        proto::write_frame(&mut wr, proto::HELLO, &payload).await?;
        // The 8 MiB `pread`, off both the holder's lock and the reactor. Live
        // output arriving meanwhile buffers in `rx` (and, if the daemon is that
        // slow, gets it disconnected — which replays losslessly).
        let replay = tokio::task::spawn_blocking(move || tail.read())
            .await
            .map_err(|e| std::io::Error::other(format!("replay read task: {e}")))??;
        // `HELLO.replay_bytes` promised exactly this many bytes and the daemon
        // counts them off to separate replay from live, so a short read must
        // kill the connection rather than desynchronise that boundary — the
        // `?`s above do exactly that; the daemon reconnects and re-snapshots.
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
        proto::SIGNAL => match proto::parse_i32(&payload) {
            Some(sig) if SIGNAL_ALLOWLIST.contains(&sig) => signal_child(holder.pid, sig),
            Some(sig) => tracing::warn!(
                session = %holder.session,
                sig,
                "native holder: refusing a signal outside the allowlist",
            ),
            None => tracing::debug!("native holder: malformed SIGNAL payload"),
        },
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

// (socket_live was removed: the B3 fix made liveness probing meta/pid-based —
// dialling the socket evicted the live daemon connection. See runtime::probe_alive.)

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

    #[test]
    fn the_signal_allowlist_admits_terminate_shaped_signals_only() {
        for sig in [libc::SIGHUP, libc::SIGINT, libc::SIGTERM, libc::SIGKILL] {
            assert!(SIGNAL_ALLOWLIST.contains(&sig), "kill path needs {sig}");
        }
        // The daemon has no business asking for any of these, and a hostile
        // peer must not be able to stop/continue/confuse an agent's group.
        for sig in [
            libc::SIGSTOP,
            libc::SIGCONT,
            libc::SIGUSR1,
            libc::SIGUSR2,
            libc::SIGSEGV,
            libc::SIGWINCH,
            0,
            -1,
            libc::SIGRTMIN(),
            9999,
        ] {
            assert!(!SIGNAL_ALLOWLIST.contains(&sig), "{sig} must be refused");
        }
    }

    #[test]
    fn a_dying_holder_never_unlinks_a_successors_socket() {
        let dir = std::env::temp_dir().join(format!("supermux-sockid-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("holder.sock");

        // "Our" socket: we unlink it, because the path still resolves to it.
        std::fs::write(&path, b"ours").unwrap();
        let ours = path_id(&path);
        assert!(ours.is_some());

        // A successor replaces the path with a socket of its OWN before our
        // shutdown gets around to cleaning up. (Renamed into place so the
        // successor's inode is allocated while ours still exists — otherwise
        // the filesystem happily hands the freed inode number straight back.)
        let successor = dir.join("successor.sock");
        std::fs::write(&successor, b"successor").unwrap();
        std::fs::rename(&successor, &path).unwrap();
        assert_ne!(ours, path_id(&path), "the successor must have a new inode");
        remove_socket_if_ours(&path, ours);
        assert!(path.exists(), "the successor's socket must survive");

        // The matching-inode case still cleans up.
        remove_socket_if_ours(&path, path_id(&path));
        assert!(!path.exists(), "our own socket must be removed");

        // A vanished path is a no-op, not a panic.
        remove_socket_if_ours(&path, ours);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

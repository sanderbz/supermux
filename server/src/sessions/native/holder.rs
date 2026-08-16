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
//! 2. *The spool is always written — and when it can't be, the holder lives on.*
//!    A write/rotate failure degrades the spool (see [`Spool::append`]): the
//!    error is logged once, further bytes are counted and discarded, and the pty
//!    keeps pumping. A disk hiccup must never turn into a dead agent.
//! 3. *Exactly one daemon at a time.* A new connection replaces the old one.
//! 4. *The holder exits when the child does* — after draining the pty,
//!    flushing the spool, writing the `exit` marker and sending an `EXIT`
//!    frame.
//! 5. **A holder death is never silent.** Its stderr goes to
//!    `<dir>/holder.log` (tracing lines, the panic printer, the allocator's
//!    "memory allocation failed"), a panic hook writes the message + backtrace
//!    there, and every way of stopping writes an `exit` marker whose first line
//!    says WHY: `child-exit 0`, `panic: …`, `pty-io: …`. Before this, a holder
//!    that died left nothing anywhere: stderr was `/dev/null`, the spool simply
//!    stopped growing, and the daemon could only report "not alive".
//!
//! **Supervision.** The two tasks the holder cannot live without — the pty pump
//! and the accept loop — run under [`supervise`]: a panic (or a fatal I/O
//! return) is logged and the task is RESTARTED, up to [`MAX_TASK_RESTARTS`]
//! times. Only when restarting keeps failing does the holder give up, and then
//! it says so in the `exit` marker instead of vanishing. This matters because a
//! panic in a `tokio::spawn`ed task otherwise kills just that task: a dead pty
//! pump leaves the child blocked in `write()` forever with no trace at all.
//!
//! Rust's runtime sets `SIGPIPE` to `SIG_IGN`, so writing to a socket whose
//! daemon vanished returns `EPIPE` to the connection task instead of killing
//! the holder.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tokio::io::unix::AsyncFd;
use tokio::io::{BufReader, ReadHalf, WriteHalf};
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
/// Extra bytes of slack granted while a connection is still draining its
/// REPLAY. During that window the writer is busy pushing the replay out, so it
/// is not reading the live queue at all — the old code counted that entirely
/// self-inflicted pressure as "the daemon is lagging" and dropped the link,
/// which produced another attach, another replay, and so on at ~4 Hz. Spilling
/// into a bounded, ordered side buffer instead turns a transient replay burst
/// into nothing at all, and a genuinely stuck daemon still gets dropped once
/// this budget is gone.
const SPILL_MAX: usize = 4 * 1024 * 1024;
/// …and the same budget in ENTRIES. Bytes alone are not a bound: a child that
/// prints one byte at a time (a slow `read` on the master, an interactive
/// keystroke echo) fills the spill with millions of `Vec`s long before it gets
/// anywhere near [`SPILL_MAX`], and each one costs an allocation plus 32 bytes
/// of `Vec` header the byte count never sees. 65 536 frames is far more than any
/// real replay window needs and puts a hard ceiling on both.
const SPILL_MAX_FRAMES: usize = 65_536;
/// How long the holder waits for the daemon's `ATTACH_FROM` position frame
/// before assuming "no position, send the full tail". Only a pre-delta daemon
/// ever pays it; the current one sends the frame immediately after `connect`.
const ATTACH_HANDSHAKE: Duration = Duration::from_millis(200);
/// How long we keep draining the pty after the child exits (last output).
const DRAIN: Duration = Duration::from_millis(500);
/// Grace period for the connection writer to flush the final `EXIT` frame.
const EXIT_FLUSH: Duration = Duration::from_millis(150);
/// How often a supervised task may die before the holder gives up on it.
const MAX_TASK_RESTARTS: u32 = 3;
/// Pause before restarting a supervised task (never hot-loop on a panic).
const TASK_RESTART_DELAY: Duration = Duration::from_millis(200);
/// Consecutive `accept()` failures tolerated before the accept loop is declared
/// fatal (with a 200 ms pause each, that is ~20 s of trying).
const ACCEPT_FAIL_LIMIT: u32 = 100;
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
///
/// This is where the PROCESS-wide crash plumbing goes in — the stderr redirect
/// and the panic hook — because both are global and must not be installed by
/// the in-process holders the tests run.
pub async fn main<I: Iterator<Item = String>>(argv: I) -> Result<()> {
    let args = Args::parse(argv)?;
    let log = HolderLog::open(&args.dir);
    log.redirect_stderr();
    install_panic_hook(log.clone());
    let r = run_with_log(args, log.clone()).await;
    if let Err(e) = &r {
        log.line(&format!("holder exiting with error: {e:#}"));
    }
    r
}

// ── holder.log ──────────────────────────────────────────────────────────────

/// Truncate-rotate `holder.log` once it passes this…
const LOG_CAP: u64 = 1024 * 1024;
/// …keeping this much of the tail (the newest lines are the interesting ones).
const LOG_KEEP: u64 = 256 * 1024;

/// `<spool_dir>/holder.log` — the holder's own incident log, and (in the real
/// subcommand) its stderr.
///
/// Deliberately dumb: an `O_APPEND` 0600 file, one lock, a size cap. It has to
/// work when the daemon is gone, when tracing was never initialised, and from
/// inside a panic hook, so it allocates nothing it does not have to and never
/// fails loudly — a logging error must not be the thing that kills the holder.
pub struct HolderLog {
    path: PathBuf,
    /// `None` when the file could not be opened: logging is then a no-op.
    file: Mutex<Option<File>>,
}

impl HolderLog {
    /// Open (create) `<dir>/holder.log` in append mode at 0600.
    pub fn open(dir: &Path) -> Arc<Self> {
        let _ = spool::ensure_dir(dir);
        let path = dir.join("holder.log");
        let file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .mode(spool::FILE_MODE)
            .open(&path)
            .ok();
        if let Some(f) = &file {
            // `mode()` only applies on CREATE; a log left world-readable by an
            // older build is tightened here (it can quote pty bytes).
            let _ = f.set_permissions(std::fs::Permissions::from_mode(spool::FILE_MODE));
        }
        Arc::new(Self {
            path,
            file: Mutex::new(file),
        })
    }

    /// The log's path (diagnostics/tests).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append one timestamped line (the message may be multi-line: a backtrace
    /// is written as-is).
    pub fn line(&self, msg: &str) {
        let stamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
        let pid = std::process::id();
        // A poisoned log mutex must not cascade: the whole point of this file is
        // to survive a panic elsewhere.
        let mut g = match self.file.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let Some(f) = g.as_mut() else { return };
        let _ = writeln!(f, "{stamp} pid={pid} {msg}");
        Self::trim(f);
    }

    /// Point the PROCESS's stderr (fd 2) at the log. Everything the runtime
    /// writes there — tracing, the default panic printer, the allocator's
    /// abort message — lands in the file from here on.
    pub fn redirect_stderr(&self) {
        let g = match self.file.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let Some(f) = g.as_ref() else { return };
        // SAFETY: plain libc call on a live fd; dup2 onto 2 is exactly what a
        // shell's `2>>file` does.
        unsafe {
            libc::dup2(f.as_raw_fd(), libc::STDERR_FILENO);
        }
    }

    /// Keep the file bounded: once past [`LOG_CAP`], rewrite it with the last
    /// [`LOG_KEEP`] bytes (from the first line boundary, so it never starts
    /// mid-line). Cheap because it only runs on a log that is already 1 MiB.
    fn trim(f: &mut File) {
        let len = match f.metadata() {
            Ok(m) if m.len() > LOG_CAP => m.len(),
            _ => return,
        };
        let mut buf = vec![0u8; LOG_KEEP as usize];
        if f.read_exact_at(&mut buf, len - LOG_KEEP).is_err() {
            return;
        }
        let start = buf.iter().position(|b| *b == b'\n').map_or(0, |i| i + 1);
        if f.set_len(0).is_err() {
            return;
        }
        let _ = f.write_all(&buf[start..]);
    }
}

/// Route panics into `holder.log` — message, location and backtrace — before
/// letting the previous hook print to (the redirected) stderr.
///
/// The `exit` marker is NOT written here on purpose: a panic in a per-connection
/// task is survivable (the daemon reconnects), and marking such a session dead
/// would be a worse bug than the panic. Panics that DO kill the holder come back
/// through [`supervise`], which writes the marker with the `panic: …` reason.
pub fn install_panic_hook(log: Arc<HolderLog>) {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture();
        log.line(&format!("PANIC {}\n{bt}", panic_summary(info)));
        prev(info);
    }));
}

/// `<message> at <file>:<line>:<col>` for a panic.
fn panic_summary(info: &std::panic::PanicHookInfo<'_>) -> String {
    let msg = payload_message(info.payload());
    match info.location() {
        Some(l) => format!("{msg} at {}:{}:{}", l.file(), l.line(), l.column()),
        None => msg,
    }
}

/// The human-readable half of a panic payload (`&str` or `String`).
fn payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

// ── task supervision ────────────────────────────────────────────────────────

/// A supervised task and the handle that reports its death.
struct Task {
    /// Aborts the supervised future itself (not the watcher).
    abort: tokio::task::AbortHandle,
    /// Completes once the supervised future has ended and been reported.
    done: tokio::task::JoinHandle<()>,
}

/// Why a supervised task stopped.
struct Fatal {
    task: &'static str,
    reason: String,
}

/// Run `fut` as a task whose death is REPORTED instead of swallowed.
///
/// `fut` returns `None` when it ended for a legitimate reason (pty EOF) and
/// `Some(reason)` when it hit something fatal; a panic is turned into
/// `panic: <message>`. Either way the holder's supervisor hears about it, which
/// is the difference between "the session went quiet and nobody knows why" and
/// an `exit` marker that names the bug.
fn supervise<F>(
    name: &'static str,
    log: Arc<HolderLog>,
    fatal: mpsc::Sender<Fatal>,
    fut: F,
) -> Task
where
    F: std::future::Future<Output = Option<String>> + Send + 'static,
{
    let inner = tokio::spawn(fut);
    let abort = inner.abort_handle();
    let done = tokio::spawn(async move {
        let reason = match inner.await {
            Ok(None) => return,
            Ok(Some(r)) => r,
            Err(e) if e.is_cancelled() => return,
            Err(e) => format!("panic: {}", payload_message(&*e.into_panic())),
        };
        log.line(&format!("task {name} ended: {reason}"));
        let _ = fatal.send(Fatal { task: name, reason }).await;
    });
    Task { abort, done }
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

/// The currently connected daemon's outbound path.
struct Live {
    /// Identifies THIS connection; a writer that has been replaced must not
    /// touch the newcomer's state (see [`Holder::take_spill`]).
    id: u64,
    tx: mpsc::Sender<Frame>,
    /// Ordered overflow for the replay window. Once spilling starts every frame
    /// goes here until the writer has drained it, which is what keeps the byte
    /// stream in order across the switch back to the queue.
    spill: Vec<Frame>,
    spill_bytes: usize,
    spilling: bool,
    /// `true` until the writer has finished the replay AND drained the spill.
    /// Only during that window is spilling allowed.
    replaying: bool,
}

impl Live {
    fn new(id: u64, tx: mpsc::Sender<Frame>) -> Self {
        Self {
            id,
            tx,
            spill: Vec::new(),
            spill_bytes: 0,
            spilling: false,
            replaying: true,
        }
    }

    /// Offer one frame to the daemon. `false` means "this daemon is hopeless,
    /// drop it" — it reconnects and replays, which is lossless.
    fn offer(&mut self, kind: u8, payload: Vec<u8>) -> bool {
        if self.spilling {
            return self.spill_push(kind, payload);
        }
        match self.tx.try_send((kind, payload)) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Closed(_)) => false,
            Err(mpsc::error::TrySendError::Full((kind, payload))) => {
                // Queue full. If the writer is still pushing the replay it has
                // not even looked at the queue yet — spill rather than punish a
                // daemon for our own burst.
                if !self.replaying {
                    return false;
                }
                self.spilling = true;
                self.spill_push(kind, payload)
            }
        }
    }

    fn spill_push(&mut self, kind: u8, payload: Vec<u8>) -> bool {
        // A writer that has gone away drops the receiver: stop buffering for a
        // connection that will never drain it (spilling would otherwise hold on
        // to megabytes for a daemon that is already gone).
        if self.tx.is_closed()
            || self.spill_bytes + payload.len() > SPILL_MAX
            || self.spill.len() >= SPILL_MAX_FRAMES
        {
            return false;
        }
        self.spill_bytes += payload.len();
        self.spill.push((kind, payload));
        true
    }

    /// Hand the writer everything that spilled and reset the accounting. An
    /// EMPTY batch means the spill has drained, which ENDS the replay window:
    /// from here on a full queue is a genuinely lagging daemon again.
    fn take_spill(&mut self) -> Vec<Frame> {
        let batch = std::mem::take(&mut self.spill);
        self.spill_bytes = 0;
        if batch.is_empty() {
            self.spilling = false;
            self.replaying = false;
        }
        batch
    }
}

/// State guarded by ONE mutex so the spool append and the live-queue push are a
/// single critical section. That is what makes the attach handshake gap-free:
/// a chunk is either in the replay snapshot or in the queue, never both.
struct Inner {
    spool: Spool,
    live: Option<Live>,
    cols: u16,
    rows: u16,
    exited: bool,
}

struct Holder {
    session: String,
    pid: u32,
    started_at: i64,
    master: Arc<AsyncFd<Master>>,
    log: Arc<HolderLog>,
    /// Monotonic connection ids (see [`Live::id`]).
    next_conn: AtomicU64,
    inner: Mutex<Inner>,
}

impl Holder {
    /// The shared state, POISON-TOLERANT.
    ///
    /// `lock().unwrap()` was the holder's single largest silent-death surface:
    /// one panic anywhere under this lock poisons it, and from then on EVERY
    /// path that touches it panics too — the pty pump (so the child blocks in
    /// `write()` forever), the accept loop (so no daemon can ever attach again),
    /// the resize handler, the exit path. Recovering the guard turns that
    /// cascade into, at worst, one odd chunk.
    fn inner(&self) -> MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Append pty output to the spool AND hand it to the connected daemon, in
    /// one critical section. A hopeless queue disconnects the daemon (it
    /// reconnects and replays); a broken spool degrades to counting bytes. The
    /// pty is never blocked by either.
    fn on_output(&self, bytes: &[u8]) {
        let mut degraded = None;
        let mut dropped_conn = false;
        {
            let mut g = self.inner();
            #[cfg(test)]
            g.spool
                .set_fail_writes(test_hooks::armed(&self.session, test_hooks::SPOOL_FAIL));
            if let Err(e) = g.spool.append(bytes) {
                degraded = Some(e.to_string());
            }
            if let Some(live) = g.live.as_mut() {
                if !live.offer(proto::OUTPUT, bytes.to_vec()) {
                    g.live = None;
                    dropped_conn = true;
                }
            }
        }
        // Logging happens OUTSIDE the lock — it is file I/O, and this lock is
        // the one every pty chunk needs.
        if let Some(e) = degraded {
            self.log.line(&format!(
                "spool DEGRADED (session={}): {e} — the pty keeps running, replay will be incomplete",
                self.session,
            ));
        }
        if dropped_conn {
            self.log.line(&format!(
                "daemon lagged past the queue + {SPILL_MAX} B spill (session={}) — dropping the connection; it will reconnect and replay",
                self.session,
            ));
        }
    }

    /// Queue a non-output frame (`EXIT`, `INFO`) for the connected daemon.
    fn publish(&self, kind: u8, payload: Vec<u8>) {
        let mut g = self.inner();
        if let Some(live) = g.live.as_mut() {
            if !live.offer(kind, payload) {
                g.live = None;
            }
        }
    }

    /// Hand the writer everything that spilled while it was busy with the
    /// replay. `None` = a newer daemon has taken the slot (this writer must
    /// stop); an EMPTY batch = drained, the replay window is over.
    fn take_spill(&self, conn: u64) -> Option<Vec<Frame>> {
        let mut g = self.inner();
        let live = g.live.as_mut()?;
        if live.id != conn {
            return None;
        }
        Some(live.take_spill())
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
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::Interrupted => continue,
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
    let log = HolderLog::open(&args.dir);
    run_with_log(args, log).await
}

/// [`run`] with a caller-supplied log (the subcommand opens it before anything
/// else so an early failure is recorded too).
async fn run_with_log(args: Args, log: Arc<HolderLog>) -> Result<()> {
    let Args { session, dir, socket, cols, rows, command } = args;
    log.line(&format!(
        "holder starting session={session} cols={cols} rows={rows} cmd={command}",
    ));

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
    let listener = Arc::new(listener);

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
        log: log.clone(),
        next_conn: AtomicU64::new(1),
        inner: Mutex::new(Inner { spool, live: None, cols, rows, exited: false }),
    });
    log.line(&format!("child pid={pid} started"));

    // 3./4. The two tasks the holder cannot live without, under supervision:
    //       serve daemon connections, and pump pty → spool/daemon.
    let (fatal_tx, mut fatal_rx) = mpsc::channel::<Fatal>(4);
    let mut acceptor = supervise(
        "accept-loop",
        log.clone(),
        fatal_tx.clone(),
        accept_loop(holder.clone(), listener.clone()),
    );
    let mut pump = supervise(
        "pty-pump",
        log.clone(),
        fatal_tx.clone(),
        pty_pump(holder.clone(), master.clone()),
    );

    // 5. Wait for the child — restarting a supervised task that dies under us,
    //    and recording a definitive death if restarting does not help.
    //
    //    PER TASK. One shared counter meant an accept loop that had flapped
    //    twice spent the pty pump's budget too: the next single pump panic —
    //    unrelated, and the one that actually costs the user their session —
    //    was treated as the third strike and killed the holder outright. The
    //    two tasks fail for entirely different reasons, so they get separate
    //    budgets.
    let mut restarts: std::collections::HashMap<&'static str, u32> =
        std::collections::HashMap::new();
    let status = loop {
        tokio::select! {
            // `Child::wait` is cancel-safe, so losing this branch to the other
            // one costs nothing.
            r = child.wait() => break r.context("wait for child")?,
            Some(f) = fatal_rx.recv() => {
                let n = restarts.entry(f.task).or_insert(0);
                *n += 1;
                let restarts = *n;
                if restarts > MAX_TASK_RESTARTS {
                    log.line(&format!(
                        "FATAL {}: {} — giving up after {MAX_TASK_RESTARTS} restarts; the session is dead",
                        f.task, f.reason,
                    ));
                    holder.inner().exited = true;
                    spool::mark_exit_reason(&dir, -1, &f.reason);
                    holder.publish(proto::EXIT, (-1i32).to_be_bytes().to_vec());
                    remove_socket_if_ours(&socket, socket_id);
                    tokio::time::sleep(EXIT_FLUSH).await;
                    acceptor.abort.abort();
                    pump.abort.abort();
                    bail!("native holder: {} died: {}", f.task, f.reason);
                }
                log.line(&format!("restarting {} (attempt {restarts}) after: {}", f.task, f.reason));
                tokio::time::sleep(TASK_RESTART_DELAY).await;
                if f.task == "accept-loop" {
                    acceptor = supervise(
                        "accept-loop", log.clone(), fatal_tx.clone(),
                        accept_loop(holder.clone(), listener.clone()),
                    );
                } else {
                    // A pump that died between `read()` and `on_output` took
                    // those bytes with it, and the pty has no way to re-deliver
                    // them: the spool now has a HOLE nothing recorded. Absolute
                    // offsets no longer describe what is on disk, so mark it
                    // lossy — the next attach is answered with a full tail and
                    // the daemon rebuilds its grid instead of stitching a delta
                    // across the gap.
                    holder.inner().spool.mark_lossy();
                    pump = supervise(
                        "pty-pump", log.clone(), fatal_tx.clone(),
                        pty_pump(holder.clone(), master.clone()),
                    );
                }
            }
        }
    };
    let code = status.code().unwrap_or(-1);
    let _ = tokio::time::timeout(DRAIN, pump.done).await;

    {
        let mut g = holder.inner();
        g.exited = true;
        if let Err(e) = g.spool.flush() {
            log.line(&format!("final spool flush failed: {e}"));
        }
        if let Some(reason) = g.spool.degraded() {
            log.line(&format!(
                "spool was DEGRADED at exit: {reason} ({} bytes never recorded)",
                g.spool.dropped(),
            ));
        }
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
    acceptor.abort.abort();
    log.line(&format!("child exited code={code}; holder done"));
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
/// signal — that is a `None` return. Any OTHER I/O failure is fatal and named,
/// because a pty pump that quietly stops leaves the child blocked in `write()`.
async fn pty_pump(holder: Arc<Holder>, master: Arc<AsyncFd<Master>>) -> Option<String> {
    #[cfg(test)]
    if test_hooks::armed(&holder.session, test_hooks::PANIC_PTY_PUMP) {
        panic!("injected pty-pump panic (test hook)");
    }
    let mut buf = [0u8; CHUNK];
    loop {
        let mut guard = match master.readable().await {
            Ok(g) => g,
            Err(e) => {
                holder.log.line(&format!("pty readable() failed: {e}"));
                return Some(format!("pty-io: {e}"));
            }
        };
        match guard.try_io(|inner| (&inner.get_ref().0).read(&mut buf)) {
            // EOF: every slave fd is closed.
            Ok(Ok(0)) => return None,
            Ok(Ok(n)) => holder.on_output(&buf[..n]),
            // Linux reports "last slave closed" as EIO on the master.
            Ok(Err(e)) if e.raw_os_error() == Some(libc::EIO) => return None,
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Ok(Err(e)) => {
                holder.log.line(&format!("pty read failed: {e}"));
                return Some(format!("pty-io: {e}"));
            }
            Err(_would_block) => continue,
        }
    }
}

/// Accept daemon connections forever. A new connection REPLACES the previous
/// one: installing the new queue drops the old sender, which ends the old
/// connection's writer and closes its socket.
async fn accept_loop(holder: Arc<Holder>, listener: Arc<UnixListener>) -> Option<String> {
    let mut fails = 0u32;
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(v) => {
                fails = 0;
                v
            }
            Err(e) => {
                fails += 1;
                holder.log.line(&format!("accept failed ({fails}): {e}"));
                if fails >= ACCEPT_FAIL_LIMIT {
                    return Some(format!("accept: {e}"));
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        // Split before the handshake so the bytes the daemon has already sent
        // stay in ONE buffered reader, which then becomes the connection's.
        let (rd, wr) = tokio::io::split(stream);
        let mut rd = BufReader::with_capacity(16 * 1024, rd);
        // The daemon's position frame decides full-tail vs delta replay. A
        // pre-delta daemon sends nothing until it has seen HELLO, so the wait
        // is bounded; a peer that closes immediately (a stray probe) is dropped
        // WITHOUT evicting the daemon that is currently attached.
        let (from, pending) =
            match tokio::time::timeout(ATTACH_HANDSHAKE, proto::read_frame(&mut rd)).await {
                Ok(Ok(Some((proto::ATTACH_FROM, p)))) => (proto::parse_u64(&p).unwrap_or(0), None),
                Ok(Ok(Some(other))) => (0, Some(other)),
                Ok(Ok(None)) => continue,
                Ok(Err(e)) => {
                    holder.log.line(&format!("attach handshake failed: {e}"));
                    continue;
                }
                Err(_elapsed) => (0, None),
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
        let (hello, tail, rx, id) = {
            let mut g = holder.inner();
            let (tail, delta) = match g.spool.tail_reader_from(from, spool::REPLAY_TAIL) {
                Ok(t) => t,
                Err(e) => {
                    drop(g);
                    holder.log.line(&format!("replay snapshot failed: {e}"));
                    continue;
                }
            };
            let (tx, rx) = mpsc::channel::<Frame>(QUEUE_DEPTH);
            let id = holder.next_conn.fetch_add(1, Ordering::Relaxed);
            let total = g.spool.total();
            let hello = proto::Hello {
                session: holder.session.clone(),
                pid: holder.pid,
                cols: g.cols,
                rows: g.rows,
                started_at: holder.started_at,
                replay_bytes: tail.len(),
                spool_total: total,
                replay_from: total.saturating_sub(tail.len()),
                delta,
                spool_degraded: g.spool.degraded().is_some(),
                spool_dropped: g.spool.dropped(),
            };
            g.live = Some(Live::new(id, tx));
            (hello, tail, rx, id)
        };
        tokio::spawn(serve_conn(holder.clone(), rd, wr, hello, tail, rx, id, pending));
    }
}

/// One daemon connection: `HELLO` + replay + live frames out; control frames in.
/// Either half finishing tears the whole connection down.
#[allow(clippy::too_many_arguments)]
async fn serve_conn(
    holder: Arc<Holder>,
    mut rd: BufReader<ReadHalf<UnixStream>>,
    mut wr: WriteHalf<UnixStream>,
    hello: proto::Hello,
    tail: TailReader,
    mut rx: mpsc::Receiver<Frame>,
    conn: u64,
    pending: Option<Frame>,
) {
    let hw = holder.clone();
    let writer = async move {
        let payload = serde_json::to_vec(&hello).unwrap_or_default();
        proto::write_frame(&mut wr, proto::HELLO, &payload).await?;
        // The replay `pread`, off both the holder's lock and the reactor. Live
        // output arriving meanwhile buffers in `rx` (and, once that is full, in
        // the spill — see `Live::offer`).
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
        // Leave the replay window: drain the queue, then the spill, until the
        // spill comes back empty. Order is preserved because nothing goes back
        // into the queue while a spill is outstanding.
        loop {
            match rx.try_recv() {
                Ok((kind, payload)) => {
                    proto::write_frame(&mut wr, kind, &payload).await?;
                    continue;
                }
                Err(mpsc::error::TryRecvError::Empty) => {}
                Err(mpsc::error::TryRecvError::Disconnected) => return Ok(()),
            }
            match hw.take_spill(conn) {
                None => return Ok(()), // replaced by a newer daemon
                Some(batch) if batch.is_empty() => break,
                Some(batch) => {
                    for (kind, payload) in batch {
                        proto::write_frame(&mut wr, kind, &payload).await?;
                    }
                }
            }
        }
        while let Some((kind, payload)) = rx.recv().await {
            proto::write_frame(&mut wr, kind, &payload).await?;
        }
        Ok::<(), std::io::Error>(())
    };

    let h = holder.clone();
    let reader = async move {
        if let Some((kind, payload)) = pending {
            handle_frame(&h, kind, payload).await;
        }
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
                holder.log.line(&format!("pty write failed: {e}"));
            }
        }
        proto::RESIZE => {
            if let Some((cols, rows)) = proto::parse_resize(&payload) {
                let (cols, rows) = (cols.max(1), rows.max(1));
                if let Err(e) = set_winsize(holder.master.get_ref().as_raw_fd(), cols, rows) {
                    holder.log.line(&format!("TIOCSWINSZ {cols}x{rows} failed: {e}"));
                } else {
                    let mut g = holder.inner();
                    g.cols = cols;
                    g.rows = rows;
                }
            }
        }
        proto::SIGNAL => match proto::parse_i32(&payload) {
            Some(sig) if SIGNAL_ALLOWLIST.contains(&sig) => signal_child(holder.pid, sig),
            Some(sig) => holder.log.line(&format!(
                "refusing signal {sig} (outside the allowlist) for session={}",
                holder.session,
            )),
            None => tracing::debug!("native holder: malformed SIGNAL payload"),
        },
        proto::QUERY => {
            let info = {
                let g = holder.inner();
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
        // `ATTACH_FROM` is only meaningful as the FIRST frame (the accept path
        // consumes it); a mid-connection one is a no-op, not an error.
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

/// Fault injection for the tests, keyed by SESSION NAME so the tests that run
/// concurrently in one process cannot disturb each other. Compiled out of
/// production builds entirely.
#[cfg(test)]
pub(crate) mod test_hooks {
    use std::collections::HashSet;
    use std::sync::Mutex;

    use once_cell::sync::Lazy;

    /// Panic on entry to the pty pump.
    pub const PANIC_PTY_PUMP: &str = "panic-pty-pump";
    /// Make every raw spool write fail.
    pub const SPOOL_FAIL: &str = "spool-fail";

    static ARMED: Lazy<Mutex<HashSet<(String, &'static str)>>> =
        Lazy::new(|| Mutex::new(HashSet::new()));

    fn armed_set() -> std::sync::MutexGuard<'static, HashSet<(String, &'static str)>> {
        match ARMED.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    /// Arm `what` for `session`.
    pub fn arm(session: &str, what: &'static str) {
        armed_set().insert((session.to_string(), what));
    }

    /// Disarm `what` for `session`.
    pub fn disarm(session: &str, what: &'static str) {
        armed_set().remove(&(session.to_string(), what));
    }

    /// Is `what` armed for `session`?
    pub fn armed(session: &str, what: &'static str) -> bool {
        armed_set().contains(&(session.to_string(), what))
    }
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

    /// The log is the holder's black box: 0600, appended to, and CAPPED — an
    /// agent that loops printing errors for a week must not fill the disk.
    #[test]
    fn holder_log_appends_and_stays_bounded() {
        let dir = std::env::temp_dir().join(format!(
            "supermux-hlog-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let log = HolderLog::open(&dir);
        log.line("first line");
        assert_eq!(
            std::fs::metadata(log.path()).unwrap().mode() & 0o777,
            spool::FILE_MODE,
            "holder.log can quote pty bytes — it must be owner-only",
        );
        let filler = "x".repeat(4096);
        for i in 0..400 {
            log.line(&format!("{i} {filler}"));
        }
        log.line("LAST-LINE-MARKER");
        let body = std::fs::read_to_string(log.path()).unwrap();
        assert!(
            (body.len() as u64) <= LOG_CAP,
            "holder.log grew past the cap: {} bytes",
            body.len(),
        );
        assert!(body.contains("LAST-LINE-MARKER"), "the TAIL is what must survive");
        assert!(!body.contains("first line"), "the head should have been trimmed");
        assert!(body.starts_with("20"), "trimming must land on a line boundary: {:?}", &body[..40]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE SPILL, at the unit it lives in. A daemon that has just attached is
    /// busy writing the replay out and is not reading the live queue at all, so
    /// the queue fills with the holder's OWN burst — and the old code read that
    /// self-inflicted pressure as "this daemon is lagging" and dropped the link,
    /// which produced another attach, another replay, and the ~4 Hz storm.
    ///
    /// The properties that make the spill correct, in order: nothing is dropped
    /// while the replay window is open, the byte stream survives the detour
    /// queue → spill → queue EXACTLY (order is the whole game — these are raw
    /// pty bytes), and the window closes on the first empty take.
    #[tokio::test]
    async fn the_spill_absorbs_the_replay_window_burst_without_losing_order() {
        // A stand-in for `QUEUE_DEPTH`, small enough to fill on purpose.
        let (tx, mut rx) = mpsc::channel::<Frame>(4);
        let mut live = Live::new(1, tx);

        // The writer is pushing the replay: it reads nothing, so the queue fills.
        for i in 0..4u8 {
            assert!(live.offer(proto::OUTPUT, vec![i]), "frame {i} must reach the queue");
        }
        assert!(!live.spilling, "a queue that is merely FULL is not yet a spill");

        // Past the queue: spilled, never dropped.
        for i in 4..20u8 {
            assert!(live.offer(proto::OUTPUT, vec![i]), "frame {i} was DROPPED mid-replay");
        }
        assert!(live.spilling && live.replaying);
        assert_eq!(live.spill_bytes, 16);

        // The writer drains: queue first, then the spill. The concatenation must
        // be the original stream — no gap, no repeat, no reordering.
        let mut got = Vec::new();
        while let Ok((_, p)) = rx.try_recv() {
            got.extend_from_slice(&p);
        }
        for (_, p) in live.take_spill() {
            got.extend_from_slice(&p);
        }
        assert_eq!(got, (0u8..20).collect::<Vec<u8>>(), "the byte stream must survive the detour");

        // Frames written while the spill was outstanding keep going to the
        // spill, so nothing can overtake it on the way back to the queue.
        assert!(live.offer(proto::OUTPUT, vec![20]));
        assert_eq!(live.take_spill(), vec![(proto::OUTPUT, vec![20])]);

        // An EMPTY take ends the replay window: the queue is authoritative again.
        assert!(live.take_spill().is_empty());
        assert!(!live.spilling && !live.replaying);
        for i in 21..25u8 {
            assert!(live.offer(proto::OUTPUT, vec![i]));
        }
        assert!(
            !live.offer(proto::OUTPUT, vec![99]),
            "past the replay window a full queue is a genuinely lagging daemon — it must be \
             dropped (it reconnects and replays, which is lossless)",
        );
    }

    /// …and the spill is BOUNDED, in both directions that matter. A daemon that
    /// is hopeless must cost the holder a fixed amount of memory and then be
    /// dropped cleanly — the reconnect + delta replay is what makes that free.
    #[tokio::test]
    async fn the_spill_is_capped_by_bytes_and_by_frames() {
        // Bytes.
        let (tx, _rx) = mpsc::channel::<Frame>(1);
        let mut live = Live::new(1, tx);
        assert!(live.offer(proto::OUTPUT, vec![0; 8])); // fills the queue
        assert!(live.offer(proto::OUTPUT, vec![0; SPILL_MAX]), "the budget itself must fit");
        assert!(
            !live.offer(proto::OUTPUT, vec![0; 1]),
            "one byte past SPILL_MAX the daemon is dropped, not buffered further",
        );

        // Frames. A child printing one byte at a time never approaches
        // SPILL_MAX, but a million `Vec`s is just as fatal.
        let (tx, _rx2) = mpsc::channel::<Frame>(1);
        let mut live = Live::new(2, tx);
        assert!(live.offer(proto::OUTPUT, vec![0; 8]));
        for i in 0..SPILL_MAX_FRAMES {
            assert!(live.offer(proto::OUTPUT, vec![1]), "frame {i} within the budget");
        }
        assert!(live.spill_bytes < SPILL_MAX, "precondition: nowhere near the byte cap");
        assert!(
            !live.offer(proto::OUTPUT, vec![1]),
            "the frame count must bound the spill too",
        );

        // A writer that has already gone away is never buffered for at all.
        let (tx, rx3) = mpsc::channel::<Frame>(1);
        let mut live = Live::new(3, tx);
        assert!(live.offer(proto::OUTPUT, vec![0; 8]));
        drop(rx3);
        assert!(!live.offer(proto::OUTPUT, vec![0; 8]));
    }

    /// A panic's message and location reach `holder.log` through the hook.
    #[test]
    fn the_panic_hook_writes_the_message_and_a_backtrace() {
        let dir = std::env::temp_dir().join(format!(
            "supermux-hookfmt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let log = HolderLog::open(&dir);
        // The hook's own formatting, without touching the process-wide hook
        // (which would swallow other tests' panics): this is exactly the string
        // `install_panic_hook` writes.
        let payload: Box<dyn std::any::Any + Send> = Box::new("boom in the pump".to_string());
        assert_eq!(payload_message(&*payload), "boom in the pump");
        log.line(&format!(
            "PANIC {}\n{}",
            "boom in the pump at holder.rs:1:1",
            std::backtrace::Backtrace::force_capture(),
        ));
        let body = std::fs::read_to_string(log.path()).unwrap();
        assert!(body.contains("PANIC boom in the pump"), "log:\n{body}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

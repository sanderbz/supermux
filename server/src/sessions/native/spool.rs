//! The per-session spool: an append-only raw byte log of everything the child
//! ever wrote to the pty, plus a small `meta.json` sidecar and an `exit` marker.
//!
//! ```text
//!   <data_dir>/native/<session>/      (0700 — see "Permissions" below)
//!     ├── out.raw      append-only pty output (rotated, see below)
//!     ├── out.raw.1    the previous segment, kept until the next rotation
//!     ├── meta.json    cols/rows at spawn, child pid, started_at, command
//!     ├── holder.sock  the holder's unix listener
//!     ├── holder.log   the holder's own stderr + incident log (see `holder.rs`)
//!     └── exit         written once, when the holder stops: reason + status
//! ```
//!
//! **The `exit` marker**, written atomically (temp + rename), in one of two
//! self-describing shapes:
//!
//! ```text
//!   7                     ← an ordinary child exit: just the status
//!   panic: <msg>          ← a holder that went down abnormally: REASON line…
//!   -1                    ← …followed by the status to report
//! ```
//!
//! The rule for every reader is "does the first line parse as an integer?":
//! yes → a clean child exit, no → the line IS the reason. That keeps old
//! markers (always a bare integer) readable and lets a new holder record
//! `panic: …` / `pty-io: …` / `accept: …` — the only trace of a crash that
//! outlives the process. [`read_exit`] answers the status for both shapes and
//! [`read_exit_reason`] answers a uniform reason (`child-exit 7` for the clean
//! one), so callers never have to know which shape is on disk.
//!
//! **Permissions.** `out.raw` is a verbatim recording of a terminal an agent is
//! driving: API keys echoed into a prompt, `env` dumps, `git remote` URLs with
//! tokens in them. `holder.sock` is worse — anyone who can `connect()` it can
//! write arbitrary bytes to the pty (i.e. run commands as the service user) and
//! read the whole live stream. Both used to be created with the process umask
//! (0755 dir, 0644 files, 0755 socket → world-readable and world-connectable),
//! which was a regression against the tmux path, whose socket lives in a
//! 0700 `/tmp/tmux-<uid>`. So: the session dir is [`DIR_MODE`] (0700), every
//! file we create is [`FILE_MODE`] (0600), and the holder chmods the socket to
//! 0600 the instant `bind` returns. `create_dir_all` + an explicit
//! `set_permissions` is used rather than trusting the umask, which is inherited
//! from whatever started the daemon.
//!
//! **Why a spool at all.** The daemon's VT grid lives in memory, so a daemon
//! restart (every deploy — the unit's `KillMode=process` kills ONLY the daemon,
//! the holder and its child survive) would otherwise come back to a black
//! screen. The holder replays the spool into the reconnecting daemon, which
//! rebuilds the grid from bytes. History therefore survives daemon restarts AND
//! daemon crashes — strictly better than tmux, whose scrollback is
//! in-memory-only and dies with the tmux server.
//!
//! **Rotation: rename, never copy.** A chatty agent can emit gigabytes over
//! days, so the spool is capped at [`SPOOL_CAP`] (64 MiB) of retained bytes.
//! Rotation used to read the newest 32 MiB into a `Vec`, `set_len(0)` and write
//! it back — a 32 MiB read + 32 MiB write performed *while the holder's `Inner`
//! mutex was held*, which is the same mutex every pty chunk needs. The child
//! blocked in `write()` on its pty for the duration. Rotation is now two
//! syscalls: `rename(out.raw → out.raw.1)` and a fresh `out.raw`. It is O(1),
//! so it can stay under the lock without stalling anything.
//!
//! Consequences of the two-segment layout:
//!
//! * Retained history is between [`SPOOL_KEEP`] (32 MiB, just after a rotation)
//!   and [`SPOOL_CAP`] (64 MiB, just before one) instead of a fixed 32 MiB —
//!   strictly more history for the same disk budget.
//! * Replay reads the tail of `out.raw.1` first and then `out.raw` (see
//!   [`Spool::tail_reader`]).
//! * The bytes of a segment are IMMUTABLE once written: nothing is ever shifted
//!   inside a file. An offset handed out under the lock therefore stays valid
//!   after the lock is dropped, which is what lets the holder read its replay
//!   tail *outside* the critical section.
//!
//! The cost of dropping the FRONT rather than the back is unchanged: a rebuild
//! starts mid-stream, so the first bytes replayed may sit inside an escape
//! sequence (the VT parser resyncs within a few bytes) and any mode set before
//! the cut (alt-screen, bracketed paste) is lost until the app re-asserts it.
//! Dropping the TAIL instead would be far worse — the grid would rebuild to a
//! stale screen. tmux has the same class of limit (`history-limit`, oldest
//! lines trimmed first).
//!
//! **Replay tail.** Rebuilding a grid only needs enough bytes to repaint the
//! viewport plus the history cap, so a reattach replays at most
//! [`REPLAY_TAIL`] (8 MiB) — ~1.0 s of VT parse at the spike's measured
//! 8.6 MiB/s, versus ~7.5 s if a full 64 MiB spool were replayed. 8 MiB is well
//! over the ~2000 lines × 200 cols the grid can retain even with dense SGR.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{FileExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// Hard cap on the bytes retained across both spool segments.
pub const SPOOL_CAP: u64 = 64 * 1024 * 1024;
/// Size of one spool segment: `out.raw` is rotated aside once a write would
/// take it past this, so retained bytes are always in `[SPOOL_KEEP, SPOOL_CAP]`.
pub const SPOOL_KEEP: u64 = 32 * 1024 * 1024;
/// Maximum spool tail streamed to a (re)attaching daemon.
pub const REPLAY_TAIL: u64 = 8 * 1024 * 1024;

/// Mode for the session directory — owner only (see the module docs).
pub const DIR_MODE: u32 = 0o700;
/// Mode for every file the spool creates — owner only.
pub const FILE_MODE: u32 = 0o600;

/// `<data_dir>/native/<session>` — everything for one native session.
pub fn session_dir(data_dir: &Path, session: &str) -> PathBuf {
    data_dir.join("native").join(session)
}

/// The holder's unix listener path for `session`.
///
/// Unix socket paths are capped at ~108 bytes by the kernel, so this is
/// validated at spawn time rather than failing obscurely inside `bind`.
pub fn socket_path(data_dir: &Path, session: &str) -> PathBuf {
    session_dir(data_dir, session).join("holder.sock")
}

/// `out.raw` inside the session dir — the segment currently being appended to.
pub fn spool_path(dir: &Path) -> PathBuf {
    dir.join("out.raw")
}

/// `out.raw.1` — the segment rotated aside by the previous [`Spool::rotate`].
pub fn prev_spool_path(dir: &Path) -> PathBuf {
    dir.join("out.raw.1")
}

/// `mkdir -p` the session dir and force it to [`DIR_MODE`].
///
/// The chmod is unconditional (not just on create): a dir left at 0755 by a
/// pre-fix holder is tightened the first time a fixed one touches it.
pub fn ensure_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("mkdir {}", dir.display()))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(DIR_MODE))
        .with_context(|| format!("chmod {DIR_MODE:o} {}", dir.display()))?;
    Ok(())
}

/// Create/truncate `path` at [`FILE_MODE`] and write `body`.
///
/// `OpenOptions::mode` only applies when the file is CREATED, so an existing
/// world-readable file from a pre-fix run keeps its mode — hence the explicit
/// `set_permissions` afterwards.
fn write_private(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(FILE_MODE)
        .open(path)?;
    f.set_permissions(std::fs::Permissions::from_mode(FILE_MODE))?;
    f.write_all(body)
}

/// Open (create + truncate) one spool segment at [`FILE_MODE`].
fn open_segment(path: &Path) -> std::io::Result<File> {
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .mode(FILE_MODE)
        .open(path)?;
    f.set_permissions(std::fs::Permissions::from_mode(FILE_MODE))?;
    Ok(f)
}

/// Is `pid` still around? `kill(pid, 0)` probes without delivering anything;
/// `EPERM` means "alive, but not ours to signal".
fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: plain libc call with signal 0 — it delivers nothing.
    if unsafe { libc::kill(pid as i32, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Spawn-time facts about the child, written once by the holder. Read by the
/// daemon to learn the pid/geometry WITHOUT a live socket (e.g. to report a
/// dead session's last known state).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Meta {
    /// Session name.
    pub session: String,
    /// Child pid (also the process-group leader).
    pub pid: u32,
    /// Pty width at spawn.
    pub cols: u16,
    /// Pty height at spawn.
    pub rows: u16,
    /// Unix seconds at spawn.
    pub started_at: i64,
    /// The shell command line the holder ran under `bash -lc`.
    pub command: String,
}

/// Write `meta.json` (best-effort atomic: temp file + rename), 0600.
pub fn write_meta(dir: &Path, meta: &Meta) -> Result<()> {
    ensure_dir(dir)?;
    let tmp = dir.join("meta.json.tmp");
    let body = serde_json::to_vec_pretty(meta)?;
    write_private(&tmp, &body)?;
    std::fs::rename(&tmp, dir.join("meta.json"))?;
    Ok(())
}

/// Read `meta.json`; `None` when absent or unparseable (never an error — a
/// missing sidecar just means "we don't know", and callers degrade).
pub fn read_meta(dir: &Path) -> Option<Meta> {
    let body = std::fs::read(dir.join("meta.json")).ok()?;
    serde_json::from_slice(&body).ok()
}

/// Why a holder stopped, plus the status the daemon should report.
///
/// The reason is the FIRST line of the `exit` file (see the module docs) and is
/// what the daemon-side probe surfaces: `child-exit 0` reads very differently
/// from `panic: attempt to subtract with overflow` when a session goes dark.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitRecord {
    /// Single-line reason, e.g. `child-exit 7`, `panic: …`, `pty-io: …`.
    pub reason: String,
    /// The child's exit status; `-1` when the holder died before reaping it.
    pub status: i32,
}

/// Record the child's exit status: the ORDINARY end of a session. Written AFTER
/// the final spool flush so a reader that sees `exit` knows `out.raw` is
/// complete.
///
/// Deliberately keeps the one-line legacy shape (`7`). That is what makes the
/// two marker forms self-describing for every reader, old and new: a first line
/// that parses as an integer is a clean child exit, a first line that does not
/// is a REASON — a holder that went down abnormally. [`read_exit_reason`]
/// still answers `child-exit 7` here, so callers see one uniform vocabulary.
pub fn mark_exit(dir: &Path, status: i32) {
    write_exit(dir, &format!("{status}\n"));
}

/// [`mark_exit`] with an explicit reason — the holder's "here is how I died"
/// channel, and the ONLY trace of a crash that outlives the process.
///
/// The reason is flattened to ONE line (a panic message can be multi-line) and
/// must never parse as a bare integer, or a reader would take it for a clean
/// child exit. Use it for `panic: …`, `pty-io: …`, `accept: …`, `killed`.
pub fn mark_exit_reason(dir: &Path, status: i32, reason: &str) {
    let reason: String = reason
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let mut reason = reason.trim().to_string();
    if reason.is_empty() || reason.parse::<i32>().is_ok() {
        reason = format!("holder stopped: {reason}");
    }
    write_exit(dir, &format!("{reason}\n{status}\n"));
}

/// Write the `exit` marker temp+rename, so no reader can ever see a torn one.
fn write_exit(dir: &Path, body: &str) {
    let tmp = dir.join("exit.tmp");
    if write_private(&tmp, body.as_bytes()).is_ok() {
        if std::fs::rename(&tmp, dir.join("exit")).is_ok() {
            return;
        }
        let _ = std::fs::remove_file(&tmp);
    }
    // Last resort: a non-atomic write still beats no marker at all — a missing
    // marker is exactly the silent death this whole file exists to prevent.
    let _ = write_private(&dir.join("exit"), body.as_bytes());
}

/// The full exit marker (reason + status), if the holder has stopped.
///
/// Accepts BOTH formats: the two-line one written by [`mark_exit_reason`] and
/// the bare integer a pre-fix holder wrote.
pub fn read_exit_record(dir: &Path) -> Option<ExitRecord> {
    let body = std::fs::read_to_string(dir.join("exit")).ok()?;
    if body.trim().is_empty() {
        return None;
    }
    // Old format: the whole file is the status.
    if let Ok(status) = body.trim().parse::<i32>() {
        return Some(ExitRecord {
            reason: format!("child-exit {status}"),
            status,
        });
    }
    let mut lines = body.lines();
    let reason = lines.next()?.trim().to_string();
    if reason.is_empty() {
        return None;
    }
    let status = lines
        .next()
        .and_then(|l| l.trim().parse::<i32>().ok())
        .unwrap_or(-1);
    Some(ExitRecord { reason, status })
}

/// The recorded exit status, if the holder has stopped.
pub fn read_exit(dir: &Path) -> Option<i32> {
    read_exit_record(dir).map(|r| r.status)
}

/// The recorded exit REASON, if the holder has stopped — `panic: …` when it
/// died on a bug, `child-exit <code>` when the child simply finished.
pub fn read_exit_reason(dir: &Path) -> Option<String> {
    read_exit_record(dir).map(|r| r.reason)
}

/// Clear a previous run's `exit` marker (a fresh holder for the same name).
pub fn clear_exit(dir: &Path) {
    let _ = std::fs::remove_file(dir.join("exit"));
    let _ = std::fs::remove_file(dir.join("exit.tmp"));
}

/// The append-only output log. Owned exclusively by the holder — nothing else
/// writes it, so no cross-process locking is needed.
///
/// Two segments: `out.raw` (appended to) and `out.raw.1` (the previous one).
/// Neither is ever rewritten in place, so a byte range handed out by
/// [`Spool::tail_reader`] stays meaningful for as long as its `File` is held —
/// even across two further rotations, because an open fd pins the inode after
/// `rename` unlinks the name.
pub struct Spool {
    path: PathBuf,
    prev_path: PathBuf,
    /// The segment being appended to.
    file: File,
    /// The rotated-aside segment, still open (its NAME may be gone already).
    prev: Option<File>,
    /// Bytes in `file`.
    len: u64,
    /// Bytes in `prev`.
    prev_len: u64,
    /// Bytes ever appended (pre-rotation). Monotonic; diagnostics + `Hello`.
    total: u64,
    /// Retained-bytes budget across both segments (diagnostics/documentation:
    /// the invariant `prev_len + len <= cap` follows from `keep = cap / 2`).
    cap: u64,
    /// Segment size — `file` is rotated aside once a write would exceed this.
    keep: u64,
    /// `Some(reason)` once a write/rotate failed: the spool has STOPPED
    /// recording and the holder keeps pumping the pty without it (see
    /// [`Spool::append`]). Cleared if a periodic reopen succeeds.
    degraded: Option<String>,
    /// Bytes the child wrote that never made it to disk (degraded window).
    dropped: u64,
    /// Write/rotate failures so far (diagnostics).
    errors: u64,
    /// STICKY: this spool has a hole in it, so absolute offsets no longer map
    /// to on-disk bytes. Delta replay ([`Spool::tail_reader_from`]) is refused
    /// for the rest of the holder's life — a reattaching daemon gets the full
    /// tail and rebuilds its grid from scratch, which is correct if lossy.
    lossy: bool,
    /// Next moment a degraded spool may try to reopen its segment.
    next_retry: Option<std::time::Instant>,
    /// Test hook: make the next raw write fail, to exercise the degrade path
    /// without needing a full disk. Compiled out of production builds.
    #[cfg(test)]
    fail_writes: bool,
}

/// How long a degraded spool waits before trying to reopen its segment.
const RECOVER_EVERY: std::time::Duration = std::time::Duration::from_secs(30);

impl Spool {
    /// Create/truncate `<dir>/out.raw`. A new holder means a new child and a
    /// new terminal, so the previous run's bytes are dropped (its `exit`
    /// marker is cleared too).
    pub fn create(dir: &Path) -> Result<Self> {
        Self::create_with_limits(dir, SPOOL_CAP, SPOOL_KEEP)
    }

    /// [`Spool::create`] with explicit limits. Exists so the rotation mechanism
    /// can be exercised at a scale that does not require writing 64 MiB (and so
    /// an operator could tune it later without a code change).
    ///
    /// **Refuses to run over a live session.** Truncating `out.raw` under a
    /// still-running holder loses that holder's history AND leaves it appending
    /// to a file whose bytes we just dropped. That is reachable: a holder that
    /// is shutting down used to unlink the socket ~150 ms after writing `EXIT`,
    /// so a `spawn` in that window would start a second holder for a session
    /// whose first one was still alive. The socket race is fixed in
    /// `holder.rs`, and this is the belt to that suspenders: if there is no
    /// `exit` marker and `meta.json`'s pid is still alive, we bail instead of
    /// destroying state. (Pid reuse could produce a false positive; the failure
    /// mode is a loud refusal that `rm meta.json` clears, never silent data
    /// loss.)
    pub fn create_with_limits(dir: &Path, cap: u64, keep: u64) -> Result<Self> {
        ensure_dir(dir)?;
        if read_exit(dir).is_none() {
            if let Some(meta) = read_meta(dir) {
                if pid_alive(meta.pid) {
                    bail!(
                        "refusing to truncate {}: no exit marker and meta.json's pid {} is still \
                         alive — another holder owns this session",
                        dir.display(),
                        meta.pid,
                    );
                }
            }
        }
        clear_exit(dir);
        let path = spool_path(dir);
        let prev_path = prev_spool_path(dir);
        // A leftover segment from the previous run is not ours to replay.
        let _ = std::fs::remove_file(&prev_path);
        let file = open_segment(&path).with_context(|| format!("open {}", path.display()))?;
        let keep = keep.min(cap).max(1);
        Ok(Self {
            path,
            prev_path,
            file,
            prev: None,
            len: 0,
            prev_len: 0,
            total: 0,
            cap,
            keep,
            degraded: None,
            dropped: 0,
            errors: 0,
            lossy: false,
            next_retry: None,
            #[cfg(test)]
            fail_writes: false,
        })
    }

    /// Append `bytes`, rotating first if this write would take the current
    /// segment past [`SPOOL_KEEP`].
    ///
    /// **A spool failure never kills the holder.** The FIRST failure returns
    /// the error (so the holder logs it once) and marks the spool DEGRADED:
    /// further appends are counted and discarded, returning `Ok(())` so the pty
    /// pump keeps running at full speed with no log spam. A degraded spool
    /// retries reopening its segment every [`RECOVER_EVERY`]; either way the
    /// child keeps running, which is the entire point — losing durability is
    /// bad, killing a live agent because the disk hiccuped is worse.
    pub fn append(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        if self.degraded.is_some() {
            self.dropped += bytes.len() as u64;
            self.try_recover();
            return Ok(());
        }
        if let Err(e) = self.append_inner(bytes) {
            self.errors += 1;
            self.dropped += bytes.len() as u64;
            self.lossy = true;
            self.degraded = Some(e.to_string());
            self.next_retry = Some(std::time::Instant::now() + RECOVER_EVERY);
            return Err(e);
        }
        Ok(())
    }

    /// The raw append: rotate if needed, write, account.
    fn append_inner(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        #[cfg(test)]
        if self.fail_writes {
            return Err(std::io::Error::other("injected spool write failure"));
        }
        // `len > 0` so a single write larger than a whole segment cannot spin
        // rotating an already-empty file.
        if self.len > 0 && self.len + bytes.len() as u64 > self.keep {
            self.rotate()?;
        }
        self.file.write_all(bytes)?;
        self.len += bytes.len() as u64;
        self.total += bytes.len() as u64;
        Ok(())
    }

    /// Try to bring a degraded spool back: reopen `out.raw` in APPEND mode (no
    /// truncation — whatever survived on disk is still valid history) and resync
    /// the segment length from the file itself. At most one attempt per
    /// [`RECOVER_EVERY`], so a permanently broken disk costs one `open` per 30 s.
    ///
    /// **Rotate-half failures.** [`Spool::rotate`] is three steps, and a failure
    /// after the `rename` leaves `self.file` pointing at the inode that is now
    /// called `out.raw.1` while `self.prev`/`prev_len` still describe the
    /// generation BEFORE it. Once we reopen the path we can no longer say which
    /// generation the retained bytes belong to, so the previous segment is
    /// dropped from the accounting entirely and the spool stays LOSSY: a replay
    /// then serves only what is provably contiguous with the live `out.raw`, and
    /// no daemon is ever offered a delta stitched across a boundary we cannot
    /// place. Losing a segment of scrollback is a cost; handing a daemon bytes
    /// from the wrong generation and calling it a continuation is a corruption.
    fn try_recover(&mut self) {
        match self.next_retry {
            Some(at) if std::time::Instant::now() < at => return,
            _ => {}
        }
        self.next_retry = Some(std::time::Instant::now() + RECOVER_EVERY);
        #[cfg(test)]
        if self.fail_writes {
            return;
        }
        let opened = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .mode(FILE_MODE)
            .open(&self.path);
        let Ok(f) = opened else { return };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        self.file = f;
        self.len = len;
        // See the doc comment: after a reopen the PREVIOUS generation can not be
        // proven to be the one that precedes these bytes.
        self.prev = None;
        self.prev_len = 0;
        self.lossy = true;
        self.degraded = None;
    }

    /// Mark the spool LOSSY without degrading it: bytes were lost somewhere
    /// OUTSIDE the spool (a pty pump that panicked between `read` and `append`),
    /// so writing still works but absolute offsets no longer describe the byte
    /// stream. Delta replay is refused from here on — a reattaching daemon gets
    /// the full tail and rebuilds, which is correct if expensive.
    pub fn mark_lossy(&mut self) {
        self.lossy = true;
    }

    /// `Some(reason)` while the spool is not recording (see [`Spool::append`]).
    pub fn degraded(&self) -> Option<&str> {
        self.degraded.as_deref()
    }

    /// Bytes the child wrote that never reached disk.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Has this spool ever dropped bytes? Sticky — it disables delta replay.
    pub fn lossy(&self) -> bool {
        self.lossy
    }

    /// Test hook: force raw writes to fail (or stop failing).
    #[cfg(test)]
    pub fn set_fail_writes(&mut self, on: bool) {
        self.fail_writes = on;
    }

    /// Test hook: let the next append attempt a recovery immediately instead of
    /// waiting out [`RECOVER_EVERY`].
    #[cfg(test)]
    pub fn allow_recovery_now(&mut self) {
        self.next_retry = None;
    }

    /// Flush the OS write buffer (we use unbuffered `File` writes, so this is
    /// only a `flush` on the handle — durability against a daemon crash comes
    /// from the write itself; a machine crash may lose the page cache, which is
    /// an accepted tradeoff versus `fsync` on every pty chunk).
    pub fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }

    /// Rotate: `rename(out.raw → out.raw.1)` and start a fresh `out.raw`.
    ///
    /// Two syscalls, no copying — this runs under the holder's `Inner` mutex,
    /// which every pty chunk also needs, so it MUST NOT do multi-MiB I/O. The
    /// old fd is kept as `prev`: the `rename` may have unlinked the previous
    /// `out.raw.1`, but any reader still holding a clone of that fd keeps
    /// reading the pinned inode.
    fn rotate(&mut self) -> std::io::Result<()> {
        self.file.flush()?;
        std::fs::rename(&self.path, &self.prev_path)?;
        let fresh = open_segment(&self.path)?;
        self.prev = Some(std::mem::replace(&mut self.file, fresh));
        self.prev_len = self.len;
        self.len = 0;
        Ok(())
    }

    /// A read plan for the newest `min(retained, max)` bytes, capturing the
    /// segment fds and their boundaries but reading NOTHING.
    ///
    /// This is the half that must happen under the holder's lock: the returned
    /// reader names an exact byte range, and the [`Spool::read`-side] work
    /// (`pread` of up to [`REPLAY_TAIL`]) then happens with the lock released,
    /// so the pty pump is never blocked behind an 8 MiB read. Safe because
    /// segment bytes are immutable and the cloned fds pin their inodes.
    ///
    /// [`Spool::read`-side]: TailReader::read
    pub fn tail_reader(&self, max: u64) -> std::io::Result<TailReader> {
        self.reader_for_take((self.len + self.prev_len).min(max))
    }

    /// A read plan for the bytes the daemon is MISSING — `[from, total)` — when
    /// `from` still sits inside the retained range, else the full tail.
    ///
    /// This is what kills the reconnect replay storm: a daemon that was
    /// disconnected for 250 ms asks for the ~kilobytes it missed instead of
    /// being handed the whole 8 MiB [`REPLAY_TAIL`] again (and again, and
    /// again). Returns `(reader, delta)`; `delta == false` means "this is the
    /// full tail, rebuild your grid from scratch" and happens when:
    ///
    /// * `from == 0` — a fresh daemon with no position,
    /// * `from` is older than the oldest retained byte (rotation passed it),
    /// * `from` is past our own `total` (the daemon is talking about a
    ///   PREVIOUS holder's spool — e.g. the session was restarted),
    /// * the gap is larger than `max` (a long outage: a full tail is both
    ///   cheaper and safer than a partial delta), or
    /// * the spool has ever dropped bytes ([`Spool::lossy`]), so absolute
    ///   offsets no longer describe what is on disk.
    pub fn tail_reader_from(&self, from: u64, max: u64) -> std::io::Result<(TailReader, bool)> {
        let retained = self.len + self.prev_len;
        let base = self.total.saturating_sub(retained);
        let in_range = from > 0 && from >= base && from <= self.total && !self.lossy;
        if in_range {
            let gap = self.total - from;
            if gap <= max {
                return Ok((self.reader_for_take(gap)?, true));
            }
        }
        Ok((self.tail_reader(max)?, false))
    }

    /// Absolute spool offset of the OLDEST retained byte.
    pub fn base(&self) -> u64 {
        self.total.saturating_sub(self.len + self.prev_len)
    }

    /// A read plan for exactly the newest `take` bytes (`take` is assumed to be
    /// within the retained range; callers clamp it).
    fn reader_for_take(&self, take: u64) -> std::io::Result<TailReader> {
        let want = take.min(self.len + self.prev_len);
        let cur_take = self.len.min(want);
        let prev_take = want - cur_take;
        let cur = self.file.try_clone()?;
        let prev = match &self.prev {
            Some(p) if prev_take > 0 => Some(p.try_clone()?),
            _ => None,
        };
        Ok(TailReader {
            cur,
            cur_from: self.len - cur_take,
            cur_take,
            prev,
            prev_from: self.prev_len - prev_take,
            prev_take,
        })
    }

    /// The newest `min(retained, max)` bytes, read immediately. Convenience
    /// wrapper over [`Spool::tail_reader`] for callers that are not holding a
    /// lock (tests, diagnostics).
    pub fn replay_tail(&mut self, max: u64) -> std::io::Result<Vec<u8>> {
        self.tail_reader(max)?.read()
    }

    /// Bytes currently retained on disk, across both segments.
    pub fn len(&self) -> u64 {
        self.len + self.prev_len
    }

    /// Bytes ever appended (monotonic across rotations).
    pub fn total(&self) -> u64 {
        self.total
    }

    /// Retained-bytes budget (`SPOOL_CAP` in production).
    pub fn cap(&self) -> u64 {
        self.cap
    }

    /// Path to `out.raw` (diagnostics/tests).
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// A snapshot of "the spool tail as of right now", as fds + offsets.
///
/// Created under the holder's lock, read outside it. Holding it does not block
/// appends and does not keep the spool from rotating (twice, even).
pub struct TailReader {
    cur: File,
    cur_from: u64,
    cur_take: u64,
    prev: Option<File>,
    prev_from: u64,
    prev_take: u64,
}

impl TailReader {
    /// Exactly how many bytes [`TailReader::read`] will produce. Known without
    /// reading, which is what lets `HELLO.replay_bytes` be sent first.
    pub fn len(&self) -> u64 {
        self.prev_take + self.cur_take
    }

    /// Is the tail empty (a spool nothing has been written to yet)?
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Read the snapshotted range. Positional (`pread`), so it neither disturbs
    /// nor is disturbed by the holder's append cursor.
    pub fn read(&self) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::with_capacity(self.len() as usize);
        if let Some(prev) = &self.prev {
            read_exact_at(prev, self.prev_from, self.prev_take, &mut out)?;
        }
        read_exact_at(&self.cur, self.cur_from, self.cur_take, &mut out)?;
        Ok(out)
    }
}

/// `pread` exactly `take` bytes at `from`, appending them to `out`.
fn read_exact_at(f: &File, from: u64, take: u64, out: &mut Vec<u8>) -> std::io::Result<()> {
    if take == 0 {
        return Ok(());
    }
    let at = out.len();
    out.resize(at + take as usize, 0);
    f.read_exact_at(&mut out[at..], from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "supermux-spool-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn append_then_replay_tail_returns_the_newest_bytes() {
        let dir = tmpdir("tail");
        let mut s = Spool::create(&dir).unwrap();
        s.append(b"hello ").unwrap();
        s.append(b"world").unwrap();
        assert_eq!(s.len(), 11);
        assert_eq!(s.total(), 11);
        assert_eq!(s.replay_tail(1024).unwrap(), b"hello world");
        assert_eq!(s.replay_tail(5).unwrap(), b"world");
        // The seek in replay_tail must not corrupt the next append.
        s.append(b"!").unwrap();
        assert_eq!(s.replay_tail(1024).unwrap(), b"hello world!");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_drops_the_oldest_bytes_and_keeps_writing() {
        let dir = tmpdir("rot");
        // Same mechanism as the 64 MiB / 32 MiB production setting, at a size a
        // test can assert byte-for-byte. `keep` is the SEGMENT size: `out.raw`
        // is renamed aside once a write would take it past 40 bytes.
        let mut s = Spool::create_with_limits(&dir, 80, 40).unwrap();
        s.append(&[b'a'; 30]).unwrap();
        assert_eq!(s.len(), 30);
        // 30 + 20 > 40 → rotate (rename, no copy), then append into a fresh
        // segment. Both segments are still retained.
        s.append(&[b'b'; 20]).unwrap();
        assert_eq!(s.len(), 50, "retained = prev segment (30) + current (20)");
        assert!(prev_spool_path(&dir).exists(), "rotation renames rather than copies");
        let tail = s.replay_tail(1024).unwrap();
        assert_eq!(tail.len(), 50);
        assert!(tail[..30].iter().all(|b| *b == b'a'), "oldest bytes come first");
        assert!(tail[30..].iter().all(|b| *b == b'b'));
        // A tail SHORTER than the current segment reads from it alone…
        assert_eq!(s.replay_tail(5).unwrap(), &[b'b'; 5]);
        // …and one that spans the seam stitches both segments in order.
        let across = s.replay_tail(25).unwrap();
        assert_eq!(across.len(), 25);
        assert!(across[..5].iter().all(|b| *b == b'a'));
        assert!(across[5..].iter().all(|b| *b == b'b'));

        // `total` is monotonic across rotation.
        assert_eq!(s.total(), 50);
        // Writing keeps working after the rename.
        s.append(b"post").unwrap();
        assert_eq!(s.replay_tail(4).unwrap(), b"post");

        // A second rotation drops the OLDEST segment: the 'a's are gone.
        s.append(&[b'c'; 30]).unwrap();
        let tail = s.replay_tail(1024).unwrap();
        assert!(!tail.contains(&b'a'), "the oldest segment must be dropped");
        assert!(s.len() <= s.cap(), "retained bytes stay inside the budget");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tail_snapshot_is_stable_across_appends_and_rotations() {
        // The gap-free attach handshake depends on this: the holder captures
        // the tail boundary under its lock and READS it after releasing the
        // lock. Bytes written in between belong to the live queue, so they must
        // NOT appear in the snapshot — and rotating the file out from under the
        // reader must not corrupt what it does return.
        let dir = tmpdir("snap");
        let mut s = Spool::create_with_limits(&dir, 80, 40).unwrap();
        s.append(b"OLD-BYTES").unwrap();
        let snap = s.tail_reader(REPLAY_TAIL).unwrap();
        assert_eq!(snap.len(), 9, "the promised length is known before reading");

        // Everything below happens "while the lock is not held".
        s.append(b"LIVE-1").unwrap();
        for _ in 0..3 {
            s.append(&[b'x'; 30]).unwrap(); // forces two rotations
        }
        s.append(b"LIVE-2").unwrap();

        assert_eq!(snap.read().unwrap(), b"OLD-BYTES", "snapshot must not drift");
        // Re-reading is idempotent.
        assert_eq!(snap.read().unwrap(), b"OLD-BYTES");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_spool_dir_socket_and_files_are_owner_only() {
        use std::os::unix::fs::MetadataExt;

        let dir = tmpdir("perm");
        // Start from a deliberately world-open dir: the fix must TIGHTEN, not
        // merely refrain from loosening.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut s = Spool::create(&dir).unwrap();
        s.append(b"secret-token=hunter2").unwrap();
        write_meta(
            &dir,
            &Meta {
                session: "perm".into(),
                pid: 1,
                cols: 80,
                rows: 24,
                started_at: 0,
                command: "sh".into(),
            },
        )
        .unwrap();
        mark_exit(&dir, 0);

        let mode = |p: &Path| std::fs::metadata(p).unwrap().mode() & 0o777;
        assert_eq!(mode(&dir), DIR_MODE, "session dir must be 0700");
        assert_eq!(mode(&spool_path(&dir)), FILE_MODE, "out.raw must be 0600");
        assert_eq!(mode(&dir.join("meta.json")), FILE_MODE, "meta.json must be 0600");
        assert_eq!(mode(&dir.join("exit")), FILE_MODE, "exit must be 0600");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_refuses_to_truncate_a_spool_whose_holder_is_still_alive() {
        let dir = tmpdir("live");
        let mut s = Spool::create(&dir).unwrap();
        s.append(b"the live holder's history").unwrap();
        // No `exit` marker + a pid that is definitely running (ourselves).
        write_meta(
            &dir,
            &Meta {
                session: "live".into(),
                pid: std::process::id(),
                cols: 80,
                rows: 24,
                started_at: 0,
                command: "sh".into(),
            },
        )
        .unwrap();

        let err = match Spool::create(&dir) {
            Ok(_) => panic!("a live holder's spool must not be truncated"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("refusing to truncate"), "unexpected error: {err}");
        assert_eq!(
            std::fs::read(spool_path(&dir)).unwrap(),
            b"the live holder's history",
            "the live holder's spool must be untouched",
        );

        // Once the run is over (exit marker present) a fresh holder may start.
        mark_exit(&dir, 0);
        assert!(Spool::create(&dir).is_ok());
        assert!(std::fs::read(spool_path(&dir)).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A write failure DEGRADES the spool instead of propagating forever: the
    /// first error is reported (the holder logs it once), everything after is
    /// counted and swallowed so the pty pump never stalls or spams.
    #[test]
    fn a_write_failure_degrades_the_spool_instead_of_failing_forever() {
        let dir = tmpdir("degrade");
        let mut s = Spool::create(&dir).unwrap();
        s.append(b"healthy").unwrap();
        assert!(s.degraded().is_none() && !s.lossy());

        s.set_fail_writes(true);
        let err = s.append(b"lost-1").expect_err("the FIRST failure must be reported");
        assert!(err.to_string().contains("injected"));
        assert!(s.degraded().is_some(), "the spool must be marked degraded");
        assert!(s.lossy(), "a hole makes absolute offsets meaningless");

        // Everything after is silent — a broken disk must not turn every pty
        // chunk into an error the holder has to log.
        s.append(b"lost-2").expect("a degraded spool swallows further appends");
        assert_eq!(s.dropped(), b"lost-1".len() as u64 + b"lost-2".len() as u64);
        assert_eq!(s.total(), 7, "dropped bytes are NOT counted as spooled");
        assert_eq!(s.replay_tail(1024).unwrap(), b"healthy", "what did land is intact");

        // …and a lossy spool never offers a delta again, whatever is asked for.
        let (_, delta) = s.tail_reader_from(7, REPLAY_TAIL).unwrap();
        assert!(!delta, "a spool with a hole must force a full rebuild");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A degraded spool that comes BACK keeps writing — but never regains the
    /// right to describe itself in absolute offsets. `rotate` is three steps and
    /// a failure between them leaves the live handle and the `prev` segment one
    /// generation apart, and after a reopen there is no way to tell whether that
    /// happened. So the previous segment leaves the accounting and the spool
    /// stays lossy: a reattaching daemon is answered with a full tail and
    /// rebuilds, rather than being handed a "continuation" from the wrong
    /// generation and quietly corrupting its grid.
    #[test]
    fn a_recovered_spool_keeps_writing_but_never_offers_a_delta_again() {
        let dir = tmpdir("recover");
        let mut s = Spool::create_with_limits(&dir, 80, 40).unwrap();
        s.append(b"0123456789").unwrap();
        s.append(&[b'a'; 35]).unwrap(); // rotates: there is now a prev segment
        assert_eq!(s.total(), 45);
        assert_eq!(s.len(), 45, "precondition: BOTH segments are still retained");

        s.set_fail_writes(true);
        let _ = s.append(b"lost");
        assert!(s.degraded().is_some() && s.lossy());

        // The disk comes back.
        s.set_fail_writes(false);
        s.allow_recovery_now();
        s.append(b"swallowed-while-degraded").unwrap();
        assert!(s.degraded().is_none(), "the reopen must clear the degrade");
        s.append(b"recorded-again").unwrap();
        assert!(
            s.replay_tail(1024).unwrap().ends_with(b"recorded-again"),
            "a recovered spool must record again",
        );
        assert!(s.lossy(), "…but it can never be trusted for absolute offsets again");
        let (_, delta) = s.tail_reader_from(s.total() - 5, REPLAY_TAIL).unwrap();
        assert!(!delta, "a recovered spool must always answer with a full tail");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The delta range: `[from, total)` when the daemon's position is still on
    /// disk, and the full tail in every case where it is not.
    #[test]
    fn tail_reader_from_serves_the_gap_and_falls_back_when_it_cannot() {
        let dir = tmpdir("delta");
        let mut s = Spool::create_with_limits(&dir, 80, 40).unwrap();
        s.append(b"0123456789").unwrap();
        s.append(b"abcdefghij").unwrap();
        assert_eq!((s.base(), s.total()), (0, 20));

        // The ordinary case: a daemon that got the first 10 bytes.
        let (r, delta) = s.tail_reader_from(10, REPLAY_TAIL).unwrap();
        assert!(delta);
        assert_eq!(r.read().unwrap(), b"abcdefghij");

        // Nothing missed at all is a legal, empty delta.
        let (r, delta) = s.tail_reader_from(20, REPLAY_TAIL).unwrap();
        assert!(delta && r.is_empty());

        // No position → the full tail, exactly as before the handshake existed.
        let (r, delta) = s.tail_reader_from(0, REPLAY_TAIL).unwrap();
        assert!(!delta);
        assert_eq!(r.len(), 20);

        // A position from somebody else's spool (past our end) → full tail.
        let (_, delta) = s.tail_reader_from(9_999, REPLAY_TAIL).unwrap();
        assert!(!delta, "an offset we never reached must not be treated as a gap");

        // A gap bigger than the replay budget → full tail (a partial delta
        // would leave the daemon's grid quietly missing the front of it).
        let (r, delta) = s.tail_reader_from(1, 4).unwrap();
        assert!(!delta);
        assert_eq!(r.read().unwrap(), b"ghij");

        // Rotation moves `base` forward; a position older than that is gone.
        s.append(&[b'z'; 35]).unwrap(); // rotates: 20 + 35 > 40
        s.append(&[b'y'; 35]).unwrap(); // rotates again: the first 20 are dropped
        assert!(s.base() > 10, "the oldest segment must have been dropped");
        let (_, delta) = s.tail_reader_from(5, REPLAY_TAIL).unwrap();
        assert!(!delta, "a position rotation has passed must fall back");
        let (r, delta) = s.tail_reader_from(s.total() - 5, REPLAY_TAIL).unwrap();
        assert!(delta && r.len() == 5, "a fresh position still works after rotation");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The two marker shapes, and the uniform vocabulary readers get back. This
    /// is the contract the daemon-side probe reads a crash out of.
    #[test]
    fn the_exit_marker_carries_a_reason_for_an_abnormal_death() {
        let dir = tmpdir("exitreason");
        assert!(read_exit_record(&dir).is_none());

        // Ordinary child exit: the historical one-line shape.
        mark_exit(&dir, 7);
        assert_eq!(read_exit(&dir), Some(7));
        assert_eq!(read_exit_reason(&dir).as_deref(), Some("child-exit 7"));
        assert_eq!(std::fs::read_to_string(dir.join("exit")).unwrap().trim(), "7");

        // A holder going down on a bug: reason first, status second.
        mark_exit_reason(&dir, -1, "panic: attempt to subtract with overflow");
        let rec = read_exit_record(&dir).unwrap();
        assert_eq!(rec.reason, "panic: attempt to subtract with overflow");
        assert_eq!(rec.status, -1);
        assert_eq!(read_exit(&dir), Some(-1));

        // A multi-line panic message is flattened — the first line IS the
        // reason, so a stray newline must not turn the status into garbage.
        mark_exit_reason(&dir, -1, "panic: boom\n  at holder.rs:1\n");
        let rec = read_exit_record(&dir).unwrap();
        assert_eq!(rec.reason, "panic: boom   at holder.rs:1");
        assert_eq!(rec.status, -1);

        // A reason that would READ as a clean exit is never written as one.
        mark_exit_reason(&dir, -1, "137");
        let rec = read_exit_record(&dir).unwrap();
        assert_ne!(rec.status, 137, "a reason must never be mistaken for a status");
        assert!(rec.reason.contains("137"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn meta_and_exit_marker_round_trip() {
        let dir = tmpdir("meta");
        assert!(read_meta(&dir).is_none());
        assert!(read_exit(&dir).is_none());
        let m = Meta {
            session: "demo".into(),
            pid: 4242,
            cols: 120,
            rows: 40,
            started_at: 1_700_000_000,
            command: "claude --dangerously-skip-permissions".into(),
        };
        write_meta(&dir, &m).unwrap();
        let back = read_meta(&dir).unwrap();
        assert_eq!((back.pid, back.cols, back.rows), (4242, 120, 40));
        assert_eq!(back.command, m.command);
        mark_exit(&dir, 137);
        assert_eq!(read_exit(&dir), Some(137));
        // A fresh holder clears the previous run's marker.
        Spool::create(&dir).unwrap();
        assert_eq!(read_exit(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

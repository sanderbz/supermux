//! The per-session spool: an append-only raw byte log of everything the child
//! ever wrote to the pty, plus a small `meta.json` sidecar and an `exit` marker.
//!
//! ```text
//!   <data_dir>/native/<session>/      (0700 — see "Permissions" below)
//!     ├── out.raw      append-only pty output (rotated, see below)
//!     ├── out.raw.1    the previous segment, kept until the next rotation
//!     ├── meta.json    cols/rows at spawn, child pid, started_at, command
//!     ├── holder.sock  the holder's unix listener
//!     └── exit         written once, on child exit: the exit status
//! ```
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

/// Record the child's exit status. Written AFTER the final spool flush so a
/// reader that sees `exit` knows `out.raw` is complete.
pub fn mark_exit(dir: &Path, status: i32) {
    let _ = write_private(&dir.join("exit"), status.to_string().as_bytes());
}

/// The recorded exit status, if the child has exited.
pub fn read_exit(dir: &Path) -> Option<i32> {
    std::fs::read_to_string(dir.join("exit"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Clear a previous run's `exit` marker (a fresh holder for the same name).
pub fn clear_exit(dir: &Path) {
    let _ = std::fs::remove_file(dir.join("exit"));
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
}

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
        })
    }

    /// Append `bytes`, rotating first if this write would take the current
    /// segment past [`SPOOL_KEEP`].
    ///
    /// Failures are returned but callers (the holder's pty pump) treat them as
    /// non-fatal: losing durability is bad, killing the child because the disk
    /// hiccuped is worse.
    pub fn append(&mut self, bytes: &[u8]) -> std::io::Result<()> {
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
        let want = (self.len + self.prev_len).min(max);
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

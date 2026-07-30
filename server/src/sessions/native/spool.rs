//! The per-session spool: an append-only raw byte log of everything the child
//! ever wrote to the pty, plus a small `meta.json` sidecar and an `exit` marker.
//!
//! ```text
//!   <data_dir>/native/<session>/
//!     ├── out.raw      append-only pty output (rotated, see below)
//!     ├── meta.json    cols/rows at spawn, child pid, started_at, command
//!     ├── holder.sock  the holder's unix listener
//!     └── exit         written once, on child exit: the exit status
//! ```
//!
//! **Why a spool at all.** The daemon's VT grid lives in memory, so a daemon
//! restart (every deploy — the unit's `KillMode=process` kills ONLY the daemon,
//! the holder and its child survive) would otherwise come back to a black
//! screen. The holder replays the spool into the reconnecting daemon, which
//! rebuilds the grid from bytes. History therefore survives daemon restarts AND
//! daemon crashes — strictly better than tmux, whose scrollback is
//! in-memory-only and dies with the tmux server.
//!
//! **Rotation tradeoff.** A chatty agent can emit gigabytes over days, so the
//! spool is capped at [`SPOOL_CAP`] (64 MiB). On overflow the oldest bytes are
//! dropped and the newest [`SPOOL_KEEP`] (32 MiB) are kept — truncated in place
//! so the holder keeps writing through the same fd. The cost of dropping the
//! FRONT rather than the back is that a rebuild starts mid-stream: the first
//! bytes replayed may sit inside an escape sequence (the VT parser resyncs
//! within a few bytes) and any mode set before the cut (alt-screen, bracketed
//! paste) is lost until the app re-asserts it. Dropping the TAIL instead would
//! be far worse — the grid would rebuild to a stale screen. tmux has the same
//! class of limit (`history-limit`, oldest lines trimmed first).
//!
//! Hysteresis matters: rotating 64 MiB → 32 MiB means the (multi-MiB) copy runs
//! once per 32 MiB of output, not on every write past the cap.
//!
//! **Replay tail.** Rebuilding a grid only needs enough bytes to repaint the
//! viewport plus the history cap, so a reattach replays at most
//! [`REPLAY_TAIL`] (8 MiB) — ~1.0 s of VT parse at the spike's measured
//! 8.6 MiB/s, versus ~7.5 s if a full 64 MiB spool were replayed. 8 MiB is well
//! over the ~2000 lines × 200 cols the grid can retain even with dense SGR.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Hard cap on `out.raw` before rotation kicks in.
pub const SPOOL_CAP: u64 = 64 * 1024 * 1024;
/// Bytes kept (the newest ones) when rotating.
pub const SPOOL_KEEP: u64 = 32 * 1024 * 1024;
/// Maximum spool tail streamed to a (re)attaching daemon.
pub const REPLAY_TAIL: u64 = 8 * 1024 * 1024;

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

/// `out.raw` inside the session dir.
pub fn spool_path(dir: &Path) -> PathBuf {
    dir.join("out.raw")
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

/// Write `meta.json` (best-effort atomic: temp file + rename).
pub fn write_meta(dir: &Path, meta: &Meta) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("mkdir {}", dir.display()))?;
    let tmp = dir.join("meta.json.tmp");
    let body = serde_json::to_vec_pretty(meta)?;
    std::fs::write(&tmp, &body)?;
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
    let _ = std::fs::write(dir.join("exit"), status.to_string());
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
/// writes it, so no cross-process locking is needed, and the rotation below can
/// truncate in place without invalidating anyone's offsets.
pub struct Spool {
    path: PathBuf,
    file: File,
    /// Bytes currently in the file.
    len: u64,
    /// Bytes ever appended (pre-rotation). Monotonic; diagnostics + `Hello`.
    total: u64,
    /// Rotate once the file would exceed this.
    cap: u64,
    /// Bytes kept (newest) by a rotation.
    keep: u64,
}

impl Spool {
    /// Create/truncate `<dir>/out.raw`. A new holder means a new child and a
    /// new terminal, so the previous run's bytes are dropped (its `exit`
    /// marker is cleared too).
    pub fn create(dir: &Path) -> Result<Self> {
        Self::create_with_limits(dir, SPOOL_CAP, SPOOL_KEEP)
    }

    /// [`Spool::create`] with explicit rotation limits. Exists so the rotation
    /// mechanism can be exercised at a scale that does not require writing
    /// 64 MiB (and so an operator could tune it later without a code change).
    pub fn create_with_limits(dir: &Path, cap: u64, keep: u64) -> Result<Self> {
        std::fs::create_dir_all(dir).with_context(|| format!("mkdir {}", dir.display()))?;
        clear_exit(dir);
        let path = spool_path(dir);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .with_context(|| format!("open {}", path.display()))?;
        Ok(Self { path, file, len: 0, total: 0, cap, keep: keep.min(cap) })
    }

    /// Append `bytes`, rotating first if this write would cross [`SPOOL_CAP`].
    ///
    /// Failures are returned but callers (the holder's pty pump) treat them as
    /// non-fatal: losing durability is bad, killing the child because the disk
    /// hiccuped is worse.
    pub fn append(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        if self.len + bytes.len() as u64 > self.cap {
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

    /// Drop the oldest bytes, keeping the newest [`SPOOL_KEEP`]. Truncates IN
    /// PLACE so the holder's fd stays valid.
    fn rotate(&mut self) -> std::io::Result<()> {
        if self.len <= self.keep {
            return Ok(());
        }
        let keep_from = self.len - self.keep;
        self.file.seek(SeekFrom::Start(keep_from))?;
        let mut tail = Vec::with_capacity(self.keep as usize);
        self.file.read_to_end(&mut tail)?;
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(&tail)?;
        self.len = tail.len() as u64;
        Ok(())
    }

    /// The newest `min(len, max)` bytes — what a (re)attaching daemon replays
    /// through a fresh VT to rebuild the grid.
    pub fn replay_tail(&mut self, max: u64) -> std::io::Result<Vec<u8>> {
        let want = self.len.min(max);
        let from = self.len - want;
        self.file.seek(SeekFrom::Start(from))?;
        let mut buf = vec![0u8; want as usize];
        self.file.read_exact(&mut buf)?;
        // Leave the cursor at EOF so the next `append` writes at the end.
        self.file.seek(SeekFrom::End(0))?;
        Ok(buf)
    }

    /// Bytes currently in the file.
    pub fn len(&self) -> u64 {
        self.len
    }

    /// Bytes ever appended (monotonic across rotations).
    pub fn total(&self) -> u64 {
        self.total
    }

    /// Path to `out.raw` (diagnostics/tests).
    pub fn path(&self) -> &Path {
        &self.path
    }
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
        // Same mechanism as the 64 MiB → 32 MiB production setting, at a size a
        // test can assert byte-for-byte.
        let mut s = Spool::create_with_limits(&dir, 100, 40).unwrap();
        s.append(&[b'a'; 60]).unwrap();
        assert_eq!(s.len(), 60);
        // 60 + 50 > cap → rotate to the newest 40, then append.
        s.append(&[b'b'; 50]).unwrap();
        assert_eq!(s.len(), 90, "kept tail (40) + the new write (50)");
        let tail = s.replay_tail(1024).unwrap();
        assert_eq!(tail.len(), 90);
        assert!(tail[..40].iter().all(|b| *b == b'a'), "oldest bytes go first");
        assert!(tail[40..].iter().all(|b| *b == b'b'));
        // `total` is monotonic across rotation; `len` is not.
        assert_eq!(s.total(), 110);
        // Writing keeps working through the same fd after the truncation.
        s.append(b"post").unwrap();
        assert_eq!(s.replay_tail(4).unwrap(), b"post");
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

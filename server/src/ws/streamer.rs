//! Per-session [`PtyStream`] registry (TECH_PLAN §3.2.9, M4 scope).
//!
//! Owns a `DashMap<String, Arc<PtyStream>>` so every WebSocket subscriber for a
//! session shares ONE FIFO reader + broadcast fan-out. [`PtyStreamer::for_session`]
//! creates the stream on first demand and transparently rebuilds it once the
//! previous reader has exited (tmux died / was restarted), so a re-`start` of a
//! session streams again without a server restart.

use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;

use crate::sessions::pty::PtyStream;
use crate::sessions::tmux::TmuxTarget;

/// Holds the per-session live streams plus the parameters needed to build new
/// ones (`logs/` + `pty/` directories + broadcast capacity from `config.ws`).
pub struct PtyStreamer {
    streams: DashMap<String, Arc<PtyStream>>,
    log_dir: PathBuf,
    /// Directory for the per-session pane→reader FIFOs. MUST live in the
    /// persistent data dir (NOT `/tmp`): the systemd unit runs with
    /// `PrivateTmp=true`, so `/tmp` is a fresh namespace on every (re)start.
    /// The tmux server survives restarts (`TMUX_TMPDIR` is anchored in the data
    /// dir — see session-survival), so a FIFO under `/tmp` would, after a
    /// restart, be created by the new server in its private `/tmp` while the
    /// surviving tmux's `pipe-pane` still writes to the path in the OLD private
    /// `/tmp` — the two never meet, the reader gets zero bytes, and the terminal
    /// renders black. Anchoring the FIFO in the data dir (shared, real, in
    /// `ReadWritePaths`) means both processes resolve the same inode.
    fifo_dir: PathBuf,
    broadcast_capacity: usize,
}

impl PtyStreamer {
    pub fn new(log_dir: PathBuf, fifo_dir: PathBuf, broadcast_capacity: usize) -> Self {
        Self {
            streams: DashMap::new(),
            log_dir,
            fifo_dir,
            broadcast_capacity,
        }
    }

    /// Get (creating, or replacing-if-dead) the stream for `name`. Does NOT start
    /// the reader — callers run [`PtyStream::ensure_started`] (idempotent).
    pub fn for_session(&self, name: &str) -> Arc<PtyStream> {
        // Reuse a still-live stream. Scope the `get` guard so it is released
        // before any `insert` on the same key (DashMap shard re-entrancy).
        {
            if let Some(existing) = self.streams.get(name) {
                if existing.is_alive() {
                    return existing.clone();
                }
            }
        }
        // Absent or dead → build a fresh stream (fresh FIFO/broadcast/spawn gate).
        let fresh = Arc::new(self.build(name));
        self.streams.insert(name.to_string(), fresh.clone());
        fresh
    }

    fn build(&self, name: &str) -> PtyStream {
        let (fifo, log) = self.paths_for(name);
        PtyStream::new(name.to_string(), fifo, log, self.broadcast_capacity)
    }

    /// Get (creating, or replacing-if-dead) the stream for a teammate PANE keyed
    /// by `stream_key` (Agent Teams §3.5). `stream_key` is a PANE-UNIQUE id
    /// (`%id` or `{lead}/{member}`) so the teammate stream gets its OWN registry
    /// slot + FIFO + log instead of clobbering the lead's (whose key is the bare
    /// session name). `pane_id` is the tmux `%id` the reader pipes. Does NOT start
    /// the reader — callers run [`PtyStream::ensure_started`].
    pub fn for_pane(&self, stream_key: &str, pane_id: &str) -> Arc<PtyStream> {
        {
            if let Some(existing) = self.streams.get(stream_key) {
                if existing.is_alive() {
                    return existing.clone();
                }
            }
        }
        let fresh = Arc::new(self.build_pane(stream_key, pane_id));
        self.streams.insert(stream_key.to_string(), fresh.clone());
        fresh
    }

    fn build_pane(&self, stream_key: &str, pane_id: &str) -> PtyStream {
        let (fifo, log) = self.paths_for(stream_key);
        PtyStream::new_with_target(
            stream_key.to_string(),
            TmuxTarget::Pane(pane_id.to_string()),
            fifo,
            log,
            self.broadcast_capacity,
        )
    }

    /// Pane-unique FIFO + log paths derived from a stream key. A teammate key can
    /// contain `%` (pane ids) or `/` (`{lead}/{member}`) — both illegal / unsafe
    /// in a flat filename — so the key is sanitized to `[A-Za-z0-9._-]` (every
    /// other byte → `_`). Distinct keys can't collide after sanitizing for the
    /// shapes we use: a bare session name (already filename-safe), a `%id`
    /// (`%` → `_`, the numeric id stays unique), or `{lead}/{member}` (the `/`
    /// → `_` keeps the two segments distinct).
    fn paths_for(&self, stream_key: &str) -> (PathBuf, PathBuf) {
        let safe = sanitize_key(stream_key);
        (
            self.fifo_dir.join(format!("{safe}.fifo")),
            self.log_dir.join(format!("{safe}.log")),
        )
    }

    /// Drop the cached stream for `name` (called from session delete cleanup).
    pub fn forget(&self, name: &str) {
        self.streams.remove(name);
    }

    /// Invalidate the cached stream for `name` because its underlying tmux pane
    /// was destroyed (a SESSION stop/restart). Removes it from the registry AND
    /// shuts its reader down, so:
    ///   1. the next [`for_session`](Self::for_session) builds a FRESH stream
    ///      (fresh FIFO + `pipe-pane` + replay seed) bound to the NEW pane, and
    ///   2. any already-open WebSocket — which is parked on the OLD stream's
    ///      broadcast — gets a `Closed` and reconnects (the frontend remounts on
    ///      restart), landing on the rebuilt stream.
    ///
    /// Without this, `for_session` keeps reusing the cached stream as long as
    /// `is_alive()` holds — and a restart recreates the SAME tmux session name,
    /// so the reader's `tmux has-session` liveness poll never trips, leaving the
    /// stream bound to the dead ORIGINAL pane and replaying its stale last frame
    /// forever (the restart-reattach bug).
    ///
    /// This is the SESSION-restart path only; a SERVER restart starts with an
    /// empty registry and rebuilds on first attach, so session-survival is
    /// untouched.
    pub fn invalidate(&self, name: &str) {
        if let Some((_, stream)) = self.streams.remove(name) {
            stream.shutdown();
        }
    }

    /// Carry a cached stream across a session rename.
    pub fn rename(&self, old: &str, new: &str) {
        if let Some((_, v)) = self.streams.remove(old) {
            self.streams.insert(new.to_string(), v);
        }
    }

    /// Whether a stream is currently cached under `key`. Test-only probe for the
    /// teammate-stream eviction path (lets a test assert a `{lead}/{member}` slot
    /// is dropped on team deregister without exposing the registry in prod).
    #[cfg(test)]
    pub fn is_cached(&self, key: &str) -> bool {
        self.streams.contains_key(key)
    }
}

/// Make a stream key filename-safe (Agent Teams §3.5). Keeps `[A-Za-z0-9._-]`
/// verbatim — so a VALID session name (`^[A-Za-z0-9_.-]+$`, see
/// `sessions::valid_name`) is returned UNCHANGED and existing FIFO/log filenames
/// stay byte-for-byte (no regression) — and maps every other byte (e.g. the `%`
/// of a pane id, the `/` of `{lead}/{member}`) to `_`.
fn sanitize_key(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod sanitize_tests {
    //! Stream-key → filename mapping (Agent Teams §3.5). Pins that a valid SESSION
    //! name is the identity (no FIFO/log filename regression) while teammate keys
    //! (`%id`, `{lead}/{member}`) become distinct, filename-safe basenames.

    use super::sanitize_key;

    #[test]
    fn valid_session_name_is_unchanged() {
        // Every char a session name may contain (`^[A-Za-z0-9_.-]+$`) survives, so
        // the pre-AT-E `"<name>.fifo"` / `"<name>.log"` paths are byte-for-byte.
        for n in ["proj", "my-proj", "my_proj", "v1.2.3", "ABC-123_x.y"] {
            assert_eq!(sanitize_key(n), n, "session name {n} must be identity");
        }
    }

    #[test]
    fn pane_id_becomes_filename_safe() {
        // A raw `%id` is not a legal flat filename; `%` → `_`, the id stays unique.
        assert_eq!(sanitize_key("%17"), "_17");
    }

    #[test]
    fn lead_member_key_keeps_both_segments_distinct() {
        // `{lead}/{member}` — the `/` (a path separator!) becomes `_`, so the key
        // is one flat basename yet the two distinct segments never collide.
        assert_eq!(sanitize_key("teamA/worker-1"), "teamA_worker-1");
        // Distinct keys map to distinct safe names (no accidental collision).
        assert_ne!(sanitize_key("teamA/worker-1"), sanitize_key("teamA/worker-2"));
    }
}

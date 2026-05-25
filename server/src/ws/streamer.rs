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
        let fifo = self.fifo_dir.join(format!("{name}.fifo"));
        let log = self.log_dir.join(format!("{name}.log"));
        PtyStream::new(name.to_string(), fifo, log, self.broadcast_capacity)
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
}

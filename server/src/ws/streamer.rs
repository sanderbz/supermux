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
use crate::sessions::tmux::Tmux;

/// Holds the per-session live streams plus the parameters needed to build new
/// ones (`logs/` directory + broadcast capacity from `config.ws`).
pub struct PtyStreamer {
    streams: DashMap<String, Arc<PtyStream>>,
    log_dir: PathBuf,
    broadcast_capacity: usize,
}

impl PtyStreamer {
    pub fn new(log_dir: PathBuf, broadcast_capacity: usize) -> Self {
        Self {
            streams: DashMap::new(),
            log_dir,
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
        let fifo = Tmux::new(name).fifo_path();
        let log = self.log_dir.join(format!("{name}.log"));
        PtyStream::new(name.to_string(), fifo, log, self.broadcast_capacity)
    }

    /// Drop the cached stream for `name` (called from session delete cleanup).
    pub fn forget(&self, name: &str) {
        self.streams.remove(name);
    }

    /// Carry a cached stream across a session rename.
    pub fn rename(&self, old: &str, new: &str) {
        if let Some((_, v)) = self.streams.remove(old) {
            self.streams.insert(new.to_string(), v);
        }
    }
}

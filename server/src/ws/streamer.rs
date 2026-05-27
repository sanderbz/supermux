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

    /// Get (creating, or replacing if dead OR mis-targeted) the stream for a
    /// SESSION that is hosting an Agent Team. The stream key stays the session
    /// `name` (so FIFO/log/registry paths are unchanged for that session) but
    /// the tmux target is pinned to the LEAD's pane id.
    ///
    /// This fixes the multi-bug "main pane shows teammate content + typing
    /// doesn't reach the lead" symptom: the legacy [`for_session`] builds a
    /// stream targeting `supermux-{name}` (the session), which tmux resolves
    /// to the **currently active pane**. The moment Claude `split-window`s a
    /// teammate, the new pane becomes active and the stream's `pipe-pane` /
    /// `send-keys` / `capture-pane` all start hitting that teammate instead of
    /// the lead. Building the stream against the lead's specific `%id` pins
    /// every operation to the right pane regardless of which pane tmux thinks
    /// is "active" right now (or in the future).
    ///
    /// **Rebuild semantics**: an existing alive stream is reused ONLY when its
    /// target matches `lead_pane_id`. If the cached stream still has the
    /// legacy `Session(name)` target (it was built before teams were detected,
    /// or before this fix shipped), it is invalidated + rebuilt — any open WS
    /// gets `Closed` on the old broadcast and reconnects onto the rebuilt
    /// stream within milliseconds (the same path session-restart already
    /// uses). One brief blip on first attach after the fix lands; steady-state
    /// is then correctly pinned. Mismatch on `pane_id` (the rare case where
    /// the lead pane id itself churned — e.g. lead crash-restart inside a
    /// surviving window) takes the same rebuild path for the same reason.
    pub fn for_lead_session(&self, name: &str, lead_pane_id: &str) -> Arc<PtyStream> {
        // Reuse iff alive AND already pinned to the right pane. The DashMap
        // `get` guard is scoped tight so we never hold it across the rebuild
        // path's `insert` on the same key.
        let needs_rebuild = {
            match self.streams.get(name) {
                None => true,
                Some(existing) => {
                    if !existing.is_alive() {
                        true
                    } else {
                        match &existing.target {
                            TmuxTarget::Pane(p) if p == lead_pane_id => false,
                            // Any other target (legacy Session, or a Pane bound
                            // to a stale id) → rebuild against the right pane.
                            _ => true,
                        }
                    }
                }
            }
        };
        if !needs_rebuild {
            return self
                .streams
                .get(name)
                .map(|e| e.clone())
                .expect("checked Some + alive above");
        }
        // Drop the old stream cleanly: shutdown() flips alive=false and wakes
        // the reader so its `pipe-pane` releases and any open WS broadcast
        // closes (clients reconnect onto the rebuilt stream). Then insert
        // the fresh pane-targeted stream under the SAME name key so all
        // existing call sites (`pty_for`, `pty_invalidate`, the heartbeat
        // map keyed by name) keep working unchanged.
        if let Some((_, old)) = self.streams.remove(name) {
            old.shutdown();
        }
        let fresh = Arc::new(self.build_lead_pane(name, lead_pane_id));
        self.streams.insert(name.to_string(), fresh.clone());
        fresh
    }

    /// Build an un-started PtyStream keyed by the session `name` but TARGETED
    /// at the lead's `%id` — used by [`for_lead_session`] for a team-host
    /// session. Distinct from [`build_pane`] (which keys by a pane-unique id
    /// for teammate streams); here the key stays the bare session name so
    /// every existing per-session subsystem (FIFO/log paths, heartbeat map,
    /// status detector wake) keeps reading the same slot.
    fn build_lead_pane(&self, name: &str, lead_pane_id: &str) -> PtyStream {
        let (fifo, log) = self.paths_for(name);
        PtyStream::new_with_target(
            name.to_string(),
            TmuxTarget::Pane(lead_pane_id.to_string()),
            fifo,
            log,
            self.broadcast_capacity,
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
mod lead_session_tests {
    //! Agent Teams routing pin (the multi-bug fix: "main pane shows teammate
    //! content + typing doesn't reach the lead"). Pins that `for_lead_session`
    //! rebuilds the cached stream when its target doesn't match the requested
    //! lead pane id (so a stream cached as `Session(name)` from before teams
    //! were spawned gets re-pinned to the lead's `%id` on the next attach) and
    //! reuses the cached stream when the target is already right (so a steady-
    //! state team doesn't get a WS blip on every attach).
    //!
    //! Doesn't exercise the FIFO reader / pipe-pane — those need a real tmux.
    //! The behaviours pinned here are the rebuild DECISIONS (target match vs
    //! mismatch, alive vs dead) — the registry's authoritative contract.
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static UNIQUE: AtomicU32 = AtomicU32::new(0);

    // Per-test scratch dir under the OS tmpdir — the registry only USES the
    // log/fifo paths as filename roots (no actual mkfifo here; the FIFO is
    // only created when `ensure_started` runs, which these tests don't call).
    // Unique per call so concurrent test runs never share a slot.
    fn streamer() -> PtyStreamer {
        let n = UNIQUE.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let base = std::env::temp_dir().join(format!("supermux-lead-test-{pid}-{n}"));
        let log = base.join("logs");
        let fifo = base.join("fifo");
        std::fs::create_dir_all(&log).unwrap();
        std::fs::create_dir_all(&fifo).unwrap();
        PtyStreamer::new(log, fifo, 16)
    }

    #[test]
    fn rebuilds_when_no_stream_cached() {
        let s = streamer();
        let stream = s.for_lead_session("teamA", "%6");
        assert!(stream.is_alive());
        assert!(matches!(&stream.target, TmuxTarget::Pane(p) if p == "%6"));
        assert!(s.is_cached("teamA"));
    }

    #[test]
    fn rebuilds_legacy_session_targeted_stream_to_pin_to_lead_pane() {
        // The bug repro: a stream cached as Session(name) — from the legacy
        // for_session path, before this fix shipped — must be REBUILT against
        // the lead pane id on the next attach. The old stream's `pipe-pane`
        // was bound to whatever pane was active when it first attached (often
        // a teammate post-split), so the live stream silently showed the
        // wrong pane. Rebuild = correct routing.
        let s = streamer();
        let legacy = s.for_session("teamA");
        assert!(matches!(&legacy.target, TmuxTarget::Session(n) if n == "teamA"));
        let legacy_ptr = Arc::as_ptr(&legacy);

        let pinned = s.for_lead_session("teamA", "%6");
        // Different Arc → freshly built (the old one was invalidated).
        assert_ne!(Arc::as_ptr(&pinned), legacy_ptr);
        assert!(matches!(&pinned.target, TmuxTarget::Pane(p) if p == "%6"));
        // The legacy one was shut down so any open WS reconnects.
        assert!(!legacy.is_alive());
    }

    #[test]
    fn reuses_cached_stream_when_target_already_matches_lead_pane() {
        // Steady state: the second attach to the SAME lead pane must reuse
        // the cached stream, not rebuild it — otherwise every WS attach would
        // blip the live stream and force a reconnect (the user-visible
        // "unstable" symptom the wider fix is paired with).
        let s = streamer();
        let first = s.for_lead_session("teamA", "%6");
        let second = s.for_lead_session("teamA", "%6");
        assert_eq!(Arc::as_ptr(&first), Arc::as_ptr(&second));
        assert!(first.is_alive());
    }

    #[test]
    fn rebuilds_when_cached_stream_pinned_to_a_different_pane_id() {
        // Pane ids can churn (lead crash-restart inside the surviving window,
        // a re-spawn). A cached stream pinned to a stale %id must be
        // invalidated + rebuilt on the next attach with the current lead %id
        // — otherwise we'd keep streaming a dead pane.
        let s = streamer();
        let stale = s.for_lead_session("teamA", "%6");
        let fresh = s.for_lead_session("teamA", "%42");
        assert_ne!(Arc::as_ptr(&stale), Arc::as_ptr(&fresh));
        assert!(matches!(&fresh.target, TmuxTarget::Pane(p) if p == "%42"));
        assert!(!stale.is_alive());
    }

    #[test]
    fn rebuilds_when_cached_stream_is_dead_even_if_target_would_match() {
        // A dead stream is never reused regardless of target — the reader
        // exited and the fan-out is closed. Rebuild to bring up a fresh
        // FIFO/broadcast/replay against the same pane id.
        let s = streamer();
        let first = s.for_lead_session("teamA", "%6");
        first.shutdown();
        assert!(!first.is_alive());
        let second = s.for_lead_session("teamA", "%6");
        assert_ne!(Arc::as_ptr(&first), Arc::as_ptr(&second));
        assert!(second.is_alive());
    }
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

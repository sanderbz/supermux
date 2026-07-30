//! Native (tmux-less) session runtime.
//!
//! ```text
//!   browser ⇄ supermux-daemon ⇄ unix socket ⇄ supermux-holder → child
//!             (VT grid +                      (pty master +      (claude /
//!              scrollback)                     raw spool)         codex /
//!                                                                 shell)
//! ```
//!
//! **What this replaces.** On the tmux path every capture, seed, key and resize
//! is a `tmux` fork whose output we parse; the grid lives inside tmux and the
//! scrollback dies with the tmux server. Here the grid lives in the daemon
//! (`alacritty_terminal`), so captures are memory reads (~0.3 ms for a 200×50
//! viewport serialize, measured) instead of process spawns, and the seed can
//! never suffer the cursor/frame race the tmux path needs a second probe to
//! narrow.
//!
//! **What it keeps.** Deploy survival. The systemd unit uses
//! `KillMode=process`: a deploy restarts ONLY the daemon, so the `setsid`-
//! detached holder and its child keep running — exactly how tmux survives
//! today. On boot the daemon reconnects to the holder's socket and rebuilds
//! its grid by replaying the spool. Because the spool is on disk, history now
//! also survives a daemon *crash*, which tmux's in-memory scrollback does not.
//!
//! ## Modules
//!
//! | module | side | role |
//! |--------|------|------|
//! | [`proto`] | both | frame format + the attach handshake |
//! | [`spool`] | holder | append-only `out.raw`, `meta.json`, `exit` marker, rotation |
//! | [`holder`] | holder | the `pty-holder` subcommand: pty master, child, socket |
//! | [`vt`] | daemon | `Term` + capture/seed/history surface |
//! | [`serialize`] | daemon | cell → plain/ANSI, the round-trip-proven serializer |
//! | [`keys`] | daemon | key name → pty bytes (tmux's `send-keys` table) |
//! | [`runtime`] | daemon | [`NativeSession`]: connection pump + the session API |
//! | [`reader`] | daemon | [`PtyReader`] impl feeding the existing `PtySink` |
//!
//! ## Entry points for the seam slice
//!
//! ```ignore
//! let session: Arc<NativeSession> = native::runtime_for("my-session", &data_dir);
//! let reader: Box<dyn PtyReader> = native::reader_for("my-session", &data_dir)?;
//! ```
//!
//! [`runtime_for`] is idempotent per name (one grid, one holder connection, one
//! pump per session, process-wide) and must be called from inside the tokio
//! runtime — it starts the session's connection pump.

pub mod holder;
pub mod keys;
pub mod proto;
pub mod reader;
pub mod runtime;
pub mod serialize;
pub mod spool;
pub mod vt;

#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use dashmap::DashMap;
use once_cell::sync::Lazy;

pub use reader::NativePtyReader;
pub use runtime::NativeSession;
pub use vt::{Damage, DamagedRow, Vt, HISTORY_LINES};

use crate::sessions::pty::PtyReader;

/// One [`NativeSession`] per name, process-wide. The grid and the holder
/// connection are shared state — two handles for the same session would mean
/// two competing connections (the holder serves one at a time) and two grids.
static SESSIONS: Lazy<DashMap<String, Arc<NativeSession>>> = Lazy::new(DashMap::new);

/// The session handle for `name`, creating (and starting the connection pump
/// for) it on first use. Picks up an ALREADY RUNNING holder automatically —
/// that is the deploy-survival path, and it needs no separate `reattach` call.
///
/// Must be called from within the tokio runtime.
pub fn runtime_for(name: &str, data_dir: &Path) -> Arc<NativeSession> {
    if let Some(existing) = SESSIONS.get(name) {
        return existing.clone();
    }
    SESSIONS
        .entry(name.to_string())
        .or_insert_with(|| NativeSession::new(name, data_dir))
        .clone()
}

/// A [`PtyReader`] that streams `name`'s live pty bytes into a `PtySink`.
/// Shares the session handle (and therefore the grid) with [`runtime_for`].
pub fn reader_for(name: &str, data_dir: &Path) -> Result<Box<dyn PtyReader>> {
    Ok(Box::new(NativePtyReader::new(runtime_for(name, data_dir))))
}

/// Forget the cached handle for `name` (session deleted/renamed) and STOP its
/// connection pump. The holder is unaffected — kill it via
/// [`NativeSession::kill`] first if that is what you meant.
///
/// Dropping the registry entry alone is not enough: for as long as a holder
/// connection is being served the pump holds a strong `Arc`, so it (and its
/// socket, and its grid) would outlive the session forever. [`NativeSession::stop_pump`]
/// aborts the task and closes the connection.
pub fn forget(name: &str) {
    if let Some((_, session)) = SESSIONS.remove(name) {
        session.stop_pump();
    }
}

/// Is `name`'s holder + child still running, WITHOUT attaching to it?
///
/// The boot reconcile needs this before any session handle exists, and it must
/// not dial the holder's socket — the holder would treat that as the incoming
/// daemon and evict the real one. See [`runtime::probe_alive`].
pub fn holder_alive(name: &str, data_dir: &Path) -> bool {
    runtime::probe_alive(&spool::session_dir(data_dir, name))
}

/// Delete `name`'s on-disk state (`<data_dir>/native/<name>`: spool, meta,
/// socket, exit marker) and forget its handle. Called after the session's holder
/// has been killed, from the session-delete path — otherwise weeks of churn
/// leave tens of MiB of spool per deleted session behind, and a later session
/// that reuses the name would adopt the dead one's history.
pub fn remove_session_data(name: &str, data_dir: &Path) {
    forget(name);
    let dir = spool::session_dir(data_dir, name);
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(session = %name, dir = %dir.display(), error = %e, "native: could not remove session data");
        }
    }
}

/// Move `old`'s on-disk state to `new` (the slug rename path).
///
/// The spool dir and the holder socket are NAME-KEYED, so a rename that only
/// touched the DB would orphan them. Callers MUST have established that the
/// session is not running: a live holder holds an open fd on the socket path it
/// was told at spawn, and it can not be told a new one without a protocol
/// change — hence `sessions::config_patch` refuses to rename a running native
/// session at all.
pub fn rename_session_data(old: &str, new: &str, data_dir: &Path) -> std::io::Result<()> {
    forget(old);
    forget(new);
    let from = spool::session_dir(data_dir, old);
    if !from.exists() {
        return Ok(());
    }
    let to = spool::session_dir(data_dir, new);
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from, &to)
}

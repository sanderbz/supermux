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

/// Forget the cached handle for `name` (session deleted/renamed). The pump
/// stops once the last `Arc` goes away; the holder is unaffected — kill it via
/// [`NativeSession::kill`] first if that is what you meant.
pub fn forget(name: &str) {
    SESSIONS.remove(name);
}

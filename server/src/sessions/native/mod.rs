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

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

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

/// Is THIS daemon's pump currently connected to `name`'s holder?
///
/// Reads the process-wide handle registry WITHOUT creating an entry, so an
/// audit pass can ask about every session without starting a pump for sessions
/// nothing has ever touched. `false` therefore means either "not attached" or
/// "no handle in this process yet" — callers must pair it with the
/// non-destructive [`holder_alive`] probe before concluding anything.
pub fn attached(name: &str) -> bool {
    SESSIONS.get(name).map(|s| s.attached()).unwrap_or(false)
}

/// The reason `name`'s holder recorded for stopping, if it left an `exit`
/// marker. Pure filesystem read — never dials the socket, never creates a
/// session handle, so it is safe to call from a boot-time audit.
pub fn death_reason(name: &str, data_dir: &Path) -> Option<String> {
    death_marker(name, data_dir).map(|d| d.reason)
}

/// The full exit-marker verdict (reason + whether the death was unexpected),
/// for callers that must distinguish a crash from a clean stop — e.g. the boot
/// reconcile only badges UNEXPECTED deaths.
pub fn death_marker(
    name: &str,
    data_dir: &Path,
) -> Option<crate::sessions::runtime::TerminalDeath> {
    runtime::exit_marker(&spool::session_dir(data_dir, name))
}

// ─────────────────────────────────────────────────────────────────────────────
// ORPHAN REAPING
// ─────────────────────────────────────────────────────────────────────────────

/// The evidence file a reaped crash leaves behind: the dead run's `out.raw`,
/// rotated aside rather than deleted. A reap is the ONLY moment supermux throws
/// away a session's spool, so the bytes that were on screen when the holder went
/// down stay readable (`<data_dir>/native/<name>/out.raw.crashed`) instead of
/// being truncated by the next `Spool::create`.
pub const CRASHED_SPOOL: &str = "out.raw.crashed";

/// How long an orphaned child gets between `SIGTERM` and `SIGKILL`. Short on
/// purpose: this runs INSIDE `start()`, in front of a user who pressed Resume,
/// and the process being reaped is by definition unreachable (its holder is
/// gone, so nothing can read its output or type into it any more).
pub const ORPHAN_GRACE: Duration = Duration::from_millis(600);

/// How far a process's real start time may sit from `meta.json`'s `started_at`
/// and still be believed to be the child that sidecar describes. Mirrors the
/// probe's own skew budget in [`runtime`].
///
/// NARROW on purpose: this authorises a `SIGKILL` on a process GROUP. The
/// holder writes `meta.json` milliseconds after forking, so the honest
/// difference is sub-second and this budget only has to absorb `/proc`'s
/// whole-second `starttime` truncation and a little `btime` drift. The 120 s it
/// used to be was wide enough for a busy host to recycle the pid inside it and
/// have the stranger still match.
const ORPHAN_START_SKEW: i64 = 5;

/// Whether a live pid really is the child a `meta.json` describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildId {
    /// Its real start time matches the sidecar: this IS the orphan.
    Ours,
    /// It started at a different time — a recycled pid, somebody else's process.
    NotOurs,
    /// Nothing could be read (`/proc` absent, permission denied, the process
    /// vanished mid-read). No evidence either way.
    Unprovable,
}

/// What a [`reap_orphan`] pass found and did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reaped {
    /// The pid recorded in `meta.json` — the orphaned child / process-group
    /// leader.
    pub pid: u32,
    /// The process group was actually signalled. `false` when the pid could not
    /// be PROVEN to still be this session's child (a recycled pid): the stale
    /// sidecar is still cleared, but nothing is killed.
    pub signalled: bool,
    /// `SIGTERM` did not do it and `SIGKILL` had to follow.
    pub killed: bool,
    /// Where the dead run's `out.raw` was rotated to, when there was one.
    pub evidence: Option<PathBuf>,
}

/// REAP the orphan a crashed holder left behind, so a fresh spawn for `name` can
/// succeed.
///
/// **The gap this closes.** A holder that dies while its CHILD survives (the
/// supervisor could not re-exec, an out-of-band `SIGKILL` on the holder alone,
/// an OOM kill that took the parent) leaves the child reparented to `init` with
/// `meta.json` still naming its live pid and NO `exit` marker. That is exactly
/// the state [`spool::Spool::create_with_limits`] refuses to run over — it bails
/// with *"no exit marker and meta.json's pid N is still alive — another holder
/// owns this session"*. The refusal happens inside the freshly spawned holder,
/// which then exits immediately, so `NativeSession::spawn` sits out its full
/// timeout and Resume fails with *"holder did not come up in time"*. The refusal
/// is CORRECT (truncating a live holder's spool is data loss); what was missing
/// is somebody to clear the wreckage first.
///
/// So this runs at the lifecycle layer, BEFORE the spawn, and leaves the session
/// dir in the state a clean exit would have left it in:
///
/// 1. the orphaned process GROUP gets `SIGTERM`, [`ORPHAN_GRACE`], `SIGKILL`
///    (the group, not just the pid — the agent runs children of its own);
/// 2. `out.raw` is rotated to [`CRASHED_SPOOL`] as evidence, not deleted;
/// 3. `meta.json` and any `exit` marker are removed, which is what actually
///    lifts `Spool::create`'s refusal for the holder we are about to start.
///
/// **Never touches a live session.** The first thing it does is the same
/// non-destructive probe the boot reconcile uses ([`runtime::probe_alive`]); a
/// session that probes alive returns `None` and nothing is read, signalled or
/// moved. Likewise a session with no `meta.json` (never started) and a session
/// whose recorded pid is simply gone (the ordinary stop → start cycle) return
/// `None` — the historical path stays byte-for-byte what it was.
///
/// **Never signals a stranger.** `probe_alive` says "not ours" for both an
/// orphaned child AND a recycled pid; only a process whose real start time
/// matches the sidecar's `started_at` is signalled — and the proof is re-taken
/// immediately before the `SIGKILL` escalation, because the pid can be freed
/// and REUSED inside the [`ORPHAN_GRACE`] window (that is the whole point of
/// sending `SIGTERM` first). A pid that is PROVEN not ours still gets its stale
/// `meta.json` cleared (pure daemon-side bookkeeping) but is left running.
///
/// **Refuses when it can not tell.** If the identity is UNPROVABLE — `/proc`
/// says nothing about a live pid — the reap does nothing at all: no signal, and
/// `meta.json` is left in place. Clearing the sidecar there would lift
/// `Spool::create`'s refusal and let a SECOND agent start on a session dir that
/// may still have a live one on it. `Err` makes the start fail loudly instead.
pub async fn reap_orphan(name: &str, data_dir: &Path) -> Result<Option<Reaped>, ReapRefused> {
    let dir = spool::session_dir(data_dir, name);
    // No sidecar → no holder ever ran here → nothing to reap.
    let Some(meta) = spool::read_meta(&dir) else {
        return Ok(None);
    };
    // A session that is genuinely serving is off limits, full stop.
    if runtime::probe_alive(&dir) {
        return Ok(None);
    }
    // The pid is gone too: this is the ordinary stop → start cycle, and
    // `Spool::create` will not refuse. Leave every byte where it is.
    if meta.pid <= 1 || !pid_alive(meta.pid) {
        return Ok(None);
    }

    let ours = match pid_is_this_sessions_child(meta.pid, &meta) {
        ChildId::Ours => true,
        ChildId::NotOurs => false,
        ChildId::Unprovable => {
            tracing::error!(
                session = %name,
                pid = meta.pid,
                "native: refusing to reap — meta.json names a LIVE pid whose identity can not \
                 be proven, and clearing the sidecar could put a second agent on this session",
            );
            return Err(ReapRefused::UnprovableIdentity { pid: meta.pid });
        }
    };
    let mut killed = false;
    if ours {
        signal_group(meta.pid, libc::SIGTERM);
        let deadline = std::time::Instant::now() + ORPHAN_GRACE;
        while std::time::Instant::now() < deadline && pid_alive(meta.pid) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // RE-PROVE before escalating. `SIGTERM` may well have worked, and the
        // freed pid can be handed to an unrelated process inside the same
        // 600 ms — signalling ITS process group with `SIGKILL` on the strength
        // of a proof taken before the grace would be the worst bug in this file.
        if pid_alive(meta.pid) {
            match pid_is_this_sessions_child(meta.pid, &meta) {
                ChildId::Ours => {
                    signal_group(meta.pid, libc::SIGKILL);
                    killed = true;
                }
                other => tracing::warn!(
                    session = %name,
                    pid = meta.pid,
                    identity = ?other,
                    "native: NOT escalating to SIGKILL — the pid is no longer provably \
                     this session's child (it was reaped and reused)",
                ),
            }
        }
    } else {
        tracing::warn!(
            session = %name,
            pid = meta.pid,
            "native: stale meta.json names a pid that is NOT this session's child (recycled) — \
             clearing the sidecar without signalling it",
        );
    }

    // Evidence before erasure: the next `Spool::create` truncates `out.raw`.
    let evidence = rotate_crashed_spool(&dir);
    // The two facts `Spool::create` consults. Removing `meta.json` is what
    // lifts its refusal; clearing `exit` matches what `spawn` does anyway.
    if let Err(e) = std::fs::remove_file(dir.join("meta.json")) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(session = %name, error = %e, "native: could not remove stale meta.json");
        }
    }
    spool::clear_exit(&dir);

    Ok(Some(Reaped {
        pid: meta.pid,
        signalled: ours,
        killed,
        evidence,
    }))
}

/// Why a reap did NOTHING and the caller must not proceed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReapRefused {
    /// `meta.json` names a live pid whose identity could not be established, so
    /// the session dir may still belong to a running agent. Nothing was
    /// signalled, moved or removed.
    #[error(
        "session dir names a live pid ({pid}) that can not be proven to be this session's \
         child — refusing to clear it (a second agent could end up on one session)"
    )]
    UnprovableIdentity { pid: u32 },
}

/// Rotate `out.raw` aside to [`CRASHED_SPOOL`], replacing any previous crash
/// evidence. `None` when there was no spool to keep.
fn rotate_crashed_spool(dir: &Path) -> Option<PathBuf> {
    let from = spool::spool_path(dir);
    if !from.exists() {
        return None;
    }
    let to = dir.join(CRASHED_SPOOL);
    match std::fs::rename(&from, &to) {
        Ok(()) => Some(to),
        Err(e) => {
            tracing::warn!(dir = %dir.display(), error = %e, "native: could not rotate out.raw aside");
            None
        }
    }
}

/// Is `pid` still the child `meta` describes, a stranger wearing a recycled pid,
/// or is there simply no evidence? CONSERVATIVE by construction — this
/// authorises a `SIGKILL`, so only a start time that MATCHES the sidecar counts
/// as proof, and a host that cannot be inspected answers
/// [`ChildId::Unprovable`] (never "ours").
fn pid_is_this_sessions_child(pid: u32, meta: &spool::Meta) -> ChildId {
    #[cfg(test)]
    if let Some(forced) = reap_hooks::verdict(&meta.session) {
        return forced;
    }
    match runtime::proc_start_unix(pid) {
        Some(started) if (started - meta.started_at).abs() <= ORPHAN_START_SKEW => ChildId::Ours,
        Some(_) => ChildId::NotOurs,
        None => ChildId::Unprovable,
    }
}

/// Deliver `sig` to `pid`'s process GROUP.
///
/// The GROUP and nothing else. There used to be a `kill(pid, sig)` fallback for
/// the case where `killpg` fails, but the identity we proved is the PID's — the
/// group id is only assumed to equal it because the holder's child calls
/// `setsid`. When `killpg` returns `ESRCH` that assumption has already broken,
/// and firing a bare signal at the raw pid on the strength of it is how a reap
/// would kill a stranger. A missed signal is recoverable; killing somebody
/// else's process is not.
fn signal_group(pid: u32, sig: i32) {
    // SAFETY: plain libc call; a stale pgid yields ESRCH, which is ignored.
    unsafe {
        libc::killpg(pid as i32, sig);
    }
}

/// Does `pid` exist? `kill(pid, 0)` performs error checking only.
fn pid_alive(pid: u32) -> bool {
    // SAFETY: plain libc call with signal 0 — nothing is delivered.
    if unsafe { libc::kill(pid as i32, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Fault injection for the identity proofs [`reap_orphan`] takes. The two cases
/// that matter most can not be produced on demand — the kernel handing a freed
/// pid to somebody else INSIDE the 600 ms grace, and a live pid `/proc` says
/// nothing about — so the verdict is forced instead. Compiled out of production
/// builds entirely.
#[cfg(test)]
pub(crate) mod reap_hooks {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use once_cell::sync::Lazy;

    use super::ChildId;

    /// `(proofs still answered honestly, the verdict every proof after that gets)`.
    static PLAN: Lazy<Mutex<HashMap<String, (u32, ChildId)>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    fn plan() -> std::sync::MutexGuard<'static, HashMap<String, (u32, ChildId)>> {
        match PLAN.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    /// Answer `calls` proofs honestly, then report the pid as somebody else's —
    /// the pid-reuse race the pre-`SIGKILL` re-proof exists for.
    pub fn vanish_after(session: &str, calls: u32) {
        plan().insert(session.to_string(), (calls, ChildId::NotOurs));
    }

    /// Report the identity as unprovable from the very first proof (a host with
    /// no readable `/proc`).
    pub fn unprovable(session: &str) {
        plan().insert(session.to_string(), (0, ChildId::Unprovable));
    }

    /// Forget `session`'s plan.
    pub fn clear(session: &str) {
        plan().remove(session);
    }

    /// The forced verdict for this proof, if any (consumes one honest answer).
    pub(super) fn verdict(session: &str) -> Option<ChildId> {
        let mut g = plan();
        let (left, forced) = g.get_mut(session)?;
        if *left > 0 {
            *left -= 1;
            return None;
        }
        Some(*forced)
    }
}

/// Serialises the tests that touch PROCESS-WIDE state: `SUPERMUX_HOLDER_BIN`
/// (every test that drives `NativeSession::spawn` points it at a no-op binary
/// and removes it afterwards) and the auto-heal dry-run switch. Two such tests
/// running concurrently would pull those out from under each other, so they all
/// take this one lock — one lock, so there is no order to get wrong.
#[cfg(test)]
pub(crate) async fn test_serial() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
    LOCK.lock().await
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

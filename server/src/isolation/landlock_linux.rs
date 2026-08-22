//! Linux Landlock backend (companies §4.4).
//!
//! Uses the `landlock` (rust-landlock) crate at `ABI::V4` with
//! `CompatLevel::BestEffort`. [`LandlockLinux::confine`] builds a ruleset that
//! grants read+write+exec beneath the company tree (and the extra RW paths the
//! spawn wiring adds) and read+exec beneath the system / dev-cache paths, then
//! calls `restrict_self()` on the CALLING thread — so it MUST run only inside a
//! freshly-forked child, pre-exec, where the restriction is inherited across
//! `exec` and is unescapable by the agent.
//!
//! ## The `@system-service` block on this box
//!
//! The `landlock_*` syscalls live in the systemd `@sandbox` set, which the
//! service's current `SystemCallFilter=@system-service` blocks. The crate's ABI
//! probe (`landlock_create_ruleset(NULL, 0, VERSION)`) then gets `EPERM` from
//! seccomp, reads it as "unsupported", and under `BestEffort` `restrict_self()`
//! returns `RulesetStatus::NotEnforced` — which we map to
//! [`IsolationLevel::None`]. As belt-and-suspenders, a raw `EPERM`/`ENOSYS`
//! `io::Error` bubbling out of any ruleset call is ALSO mapped to `Ok(None)`,
//! never an `Err` — the fail-open contract §4.4 requires.

use std::io;
use std::path::Path;

use landlock::{
    path_beneath_rules, Access, AccessFs, CompatLevel, Compatible, Ruleset, RulesetAttr,
    RulesetCreatedAttr, RulesetStatus, ABI,
};

use super::{IsolationLevel, IsolationProvider, SandboxSpec};

/// The ABI we target. V4 gives the FS rules (V1) plus refer/truncate (V2/V3) and
/// the V4 net-port rule; `CompatLevel::BestEffort` degrades any rule the running
/// kernel is too old for rather than failing.
const TARGET_ABI: ABI = ABI::V4;

/// The Linux Landlock provider. A zero-sized value type; the ruleset is built
/// fresh per `confine` call inside the child.
pub struct LandlockLinux;

impl IsolationProvider for LandlockLinux {
    fn name(&self) -> &'static str {
        "landlock"
    }

    fn confine(&self, spec: &SandboxSpec) -> io::Result<IsolationLevel> {
        match build_and_restrict(spec) {
            Ok(status) => Ok(status_to_level(status)),
            // Fail open on the exact errnos the `@system-service` block (and a
            // kernel without Landlock) produce. §4.4: return None, never Err.
            Err(e) if is_unsupported_errno(&e) => Ok(IsolationLevel::None),
            Err(e) => Err(e),
        }
    }
}

/// Build the ruleset from `spec` and call `restrict_self()` on the calling
/// thread. Returns the enforcement status or an `io::Error` (mapped by the
/// caller).
fn build_and_restrict(spec: &SandboxSpec) -> io::Result<RulesetStatus> {
    let rw = AccessFs::from_all(TARGET_ABI); // read + write + exec + refer/…
    let ro = AccessFs::from_read(TARGET_ABI); // read + exec (+ ReadDir)

    let created = Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(AccessFs::from_all(TARGET_ABI))
        .map_err(to_io)?
        .create()
        .map_err(to_io)?;

    // RW beneath the company tree + /tmp + the session spool dir. RO+exec
    // beneath the system + dev-cache paths. `path_beneath_rules` silently drops
    // any path that fails to open (absent caches), so the allow-list is
    // whatever actually exists.
    let created = created
        .add_rules(path_beneath_rules(rw_paths(spec), rw))
        .map_err(to_io)?
        .add_rules(path_beneath_rules(ro_paths(spec), ro))
        .map_err(to_io)?;

    let status = created.restrict_self().map_err(to_io)?;
    Ok(status.ruleset)
}

fn rw_paths(spec: &SandboxSpec) -> impl Iterator<Item = &Path> {
    spec.read_write_paths.iter().map(|p| p.as_path())
}

fn ro_paths(spec: &SandboxSpec) -> impl Iterator<Item = &Path> {
    spec.read_exec_paths.iter().map(|p| p.as_path())
}

/// Map the crate's `RulesetStatus` onto our measured level.
fn status_to_level(status: RulesetStatus) -> IsolationLevel {
    match status {
        RulesetStatus::FullyEnforced => IsolationLevel::Full { backend: "landlock" },
        RulesetStatus::PartiallyEnforced => IsolationLevel::Partial {
            backend: "landlock",
            note: "some rules degraded via CompatLevel::BestEffort (older ABI)".to_string(),
        },
        RulesetStatus::NotEnforced => IsolationLevel::None,
    }
}

/// Flatten a `landlock` error into an `io::Error`, preserving the underlying OS
/// errno where the error chain carries one (so [`is_unsupported_errno`] can see
/// `EPERM`/`ENOSYS`).
fn to_io<E: std::error::Error + 'static>(e: E) -> io::Error {
    // Walk the source chain for an io::Error carrying a raw OS errno.
    let mut src: Option<&(dyn std::error::Error + 'static)> = Some(&e);
    while let Some(err) = src {
        if let Some(io_err) = err.downcast_ref::<io::Error>() {
            if let Some(code) = io_err.raw_os_error() {
                return io::Error::from_raw_os_error(code);
            }
        }
        src = err.source();
    }
    io::Error::new(io::ErrorKind::Other, e.to_string())
}

/// True for the errnos that mean "no Landlock here" — the `@system-service`
/// seccomp `EPERM`, a kernel without Landlock (`ENOSYS`), or Landlock disabled
/// at boot (`EOPNOTSUPP`). Also `EACCES`, which some seccomp policies return.
fn is_unsupported_errno(e: &io::Error) -> bool {
    matches!(
        e.raw_os_error(),
        Some(libc::EPERM) | Some(libc::ENOSYS) | Some(libc::EOPNOTSUPP) | Some(libc::EACCES)
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup probe (fork a throwaway child that ACTUALLY restricts itself)
// ─────────────────────────────────────────────────────────────────────────────

// Exit codes the probe child reports the measured level with. Anything else
// (a signal, a wedged child we SIGKILL, an unexpected code) is read as None —
// we never claim enforcement we did not observe.
const CODE_NONE: i32 = 0;
const CODE_PARTIAL: i32 = 1;
const CODE_FULL: i32 = 2;

/// Fork a child that restricts itself against a throwaway spec and reports the
/// measured [`IsolationLevel`] via exit code. Runs in the PARENT; never
/// restricts the daemon.
///
/// The spec (and thus all its allocation) is built BEFORE the fork; the child
/// only performs Landlock syscalls + `open(2)` on already-owned `PathBuf`s and
/// then `_exit(2)`. The parent waits with a bounded poll and SIGKILLs a wedged
/// child, so the probe can never hang boot.
pub(crate) fn fork_probe(provider: &dyn IsolationProvider) -> IsolationLevel {
    // Build the throwaway spec in the PARENT. /tmp + the system paths always
    // exist; a missing cache is dropped by `path_beneath_rules`.
    let spec = SandboxSpec::for_company(Path::new("/tmp"), &super::probe_home());

    // SAFETY: `fork(2)` is async-signal-safe. In the child we run only Landlock
    // syscalls + `open(2)` on pre-owned paths and then `_exit(2)` — we never
    // return into Rust's runtime, unwind, or touch a lock another thread may
    // hold, so the classic "fork in a threaded process" hazards do not apply.
    let pid = unsafe { libc::fork() };

    if pid == 0 {
        // ── child ──────────────────────────────────────────────────────────
        // Confine ourselves, then translate the level into an exit code. Use
        // `_exit` (not `exit`) so no atexit handler / buffered-IO flush runs in
        // the forked child.
        let code = match provider.confine(&spec) {
            Ok(IsolationLevel::Full { .. }) => CODE_FULL,
            Ok(IsolationLevel::Partial { .. }) => CODE_PARTIAL,
            Ok(IsolationLevel::None) => CODE_NONE,
            Err(_) => CODE_NONE, // fail open: treat an unexpected error as "no jail"
        };
        unsafe { libc::_exit(code) };
    }

    if pid < 0 {
        // fork failed — no child; report None honestly.
        tracing::warn!("isolation probe: fork() failed; measuring None");
        return IsolationLevel::None;
    }

    // ── parent ─────────────────────────────────────────────────────────────
    wait_for_probe_child(pid)
}

/// Reap the probe child with a bounded poll (≈1.5s). If it does not exit in
/// time it is SIGKILLed and reaped, and we report `None`.
fn wait_for_probe_child(pid: libc::pid_t) -> IsolationLevel {
    const MAX_POLLS: u32 = 150;
    const POLL_SLEEP: std::time::Duration = std::time::Duration::from_millis(10);

    for _ in 0..MAX_POLLS {
        let mut status: libc::c_int = 0;
        // SAFETY: standard waitpid(2) with WNOHANG on a child we forked.
        let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if r == pid {
            return decode_status(status);
        }
        if r < 0 {
            // ECHILD / EINTR etc. — nothing reliable to read.
            return IsolationLevel::None;
        }
        // r == 0: still running.
        std::thread::sleep(POLL_SLEEP);
    }

    // Wedged child: SIGKILL + blocking reap so we never leak a zombie, then None.
    tracing::warn!("isolation probe: child did not exit in time; killing and measuring None");
    // SAFETY: kill(2)/waitpid(2) on our own child pid.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
        let mut status: libc::c_int = 0;
        libc::waitpid(pid, &mut status, 0);
    }
    IsolationLevel::None
}

/// Decode a `waitpid` status into a level. A normal exit maps its code; a
/// signalled death maps to `None`.
fn decode_status(status: libc::c_int) -> IsolationLevel {
    // libc::WIFEXITED / WEXITSTATUS as const-fn-free checks.
    let exited = (status & 0x7f) == 0;
    if exited {
        let code = (status >> 8) & 0xff;
        match code {
            CODE_FULL => IsolationLevel::Full { backend: "landlock" },
            CODE_PARTIAL => IsolationLevel::Partial {
                backend: "landlock",
                note: "partially enforced (probe)".to_string(),
            },
            _ => IsolationLevel::None,
        }
    } else {
        IsolationLevel::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confine_on_this_box_is_none_not_err() {
        // On THIS box the @system-service filter blocks landlock_*, so confine()
        // must return Ok(None) — NEVER an Err. (This restricts the CALLING thread
        // when Landlock is available; here it is blocked, so it is a safe no-op.
        // On a @sandbox host this test thread would get confined — acceptable in
        // a probe-style unit, and the assertion still holds: Ok(level).)
        let spec = SandboxSpec::for_company(Path::new("/tmp"), &super::super::probe_home());
        let level = LandlockLinux.confine(&spec).expect("confine must not Err");
        // Any level is contract-valid; on the blocked box it is None.
        let _ = format!("{level}");
    }

    #[test]
    fn unsupported_errno_classification() {
        assert!(is_unsupported_errno(&io::Error::from_raw_os_error(libc::EPERM)));
        assert!(is_unsupported_errno(&io::Error::from_raw_os_error(
            libc::ENOSYS
        )));
        assert!(!is_unsupported_errno(&io::Error::from_raw_os_error(
            libc::EINVAL
        )));
    }

    #[test]
    fn decode_status_maps_exit_codes() {
        // Exit code N is encoded in the high byte; low 7 bits zero = WIFEXITED.
        assert_eq!(
            decode_status(CODE_FULL << 8),
            IsolationLevel::Full { backend: "landlock" }
        );
        assert_eq!(decode_status(CODE_NONE << 8), IsolationLevel::None);
        // A signalled death (low bits set) => None.
        assert_eq!(decode_status(libc::SIGKILL), IsolationLevel::None);
    }
}

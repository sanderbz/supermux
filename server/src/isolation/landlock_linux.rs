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

// ─────────────────────────────────────────────────────────────────────────────
// Startup confinement self-test (fork → confine → EXEC a real binary)
// ─────────────────────────────────────────────────────────────────────────────

/// Fork a child, apply the REAL company [`SandboxSpec`] for a temp company root,
/// and `execv` a real binary (`/bin/sh -c "exit 0"`) under the confinement.
/// Returns `true` iff the confined child could boot + exec (child exit 0).
///
/// This is the honest, self-correcting guarantee: it mirrors exactly what a real
/// company holder does — confine (BestEffort: fail-open on a confine error, so a
/// blocked/mechanism-less host still execs), then exec a real binary. If a Full
/// jail's allow-list cannot exec, the kernel denies the exec, the child exits
/// non-zero, and the caller disables confinement for this boot so bots still
/// start. Runs in the PARENT; never restricts the daemon (the child `_exit`s /
/// `execv`s and never returns into the Rust runtime).
///
/// `home` supplies the toolchain/provider paths for the spec (same as the spawn
/// path). A temp company root under `home` is created (RW-allowed) so the spec is
/// realistic; it is removed after the fork.
pub(crate) fn self_test_confined_exec(home: &Path) -> bool {
    use std::path::PathBuf;

    // A realistic temp company root (RW-allowed) under $HOME. Cleaned up after.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root: PathBuf = home.join(format!(".supermux-iso-selftest-{}-{}", std::process::id(), nanos));
    let created_root = std::fs::create_dir_all(&root).is_ok();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _guard = created_root.then(|| Cleanup(root.clone()));

    // Build the REAL company allow-list + the exec target in the PARENT (all
    // allocation before the fork; the child only does libc syscalls + _exit).
    let spec = SandboxSpec::for_company(&root, home);
    let sh = std::ffi::CString::new("/bin/sh").unwrap();
    let arg0 = std::ffi::CString::new("sh").unwrap();
    let dashc = std::ffi::CString::new("-c").unwrap();
    let prog = std::ffi::CString::new("exit 0").unwrap();

    // SAFETY: mirrors `fork_probe` — the child runs only Landlock syscalls and
    // `execv`/`_exit` on pre-owned paths; it never returns into the Rust runtime.
    let pid = unsafe { libc::fork() };
    if pid == 0 {
        // ── child ── Confine (BestEffort fail-open: a confine error still execs,
        // matching `ConfinePlan::apply_in_child` under the default mode), then
        // exec a real binary. A Full jail whose allow-list denies the exec makes
        // execv fail ⇒ we _exit(127) ⇒ the caller reads "not usable".
        let _ = LandlockLinux.confine(&spec);
        let argv = [arg0.as_ptr(), dashc.as_ptr(), prog.as_ptr(), std::ptr::null()];
        unsafe {
            libc::execv(sh.as_ptr(), argv.as_ptr());
            // execv only returns on failure (e.g. the jail denied it).
            libc::_exit(127);
        }
    }
    if pid < 0 {
        // fork failed — cannot prove a confined child boots; be conservative and
        // report NOT usable so bots run unconfined rather than risk a broken jail.
        tracing::warn!("isolation self-test: fork() failed; reporting confinement not usable");
        return false;
    }

    // ── parent ── bounded reap; exit 0 ⇒ usable.
    self_test_exit_ok(pid)
}

/// Reap the self-test child with a bounded poll. `true` iff it exited 0. A wedged
/// child is SIGKILLed and reaped and reported as NOT usable (so a hang can neither
/// block boot nor enable a jail we could not verify).
fn self_test_exit_ok(pid: libc::pid_t) -> bool {
    const MAX_POLLS: u32 = 200; // ≈2s
    const POLL_SLEEP: std::time::Duration = std::time::Duration::from_millis(10);

    for _ in 0..MAX_POLLS {
        let mut status: libc::c_int = 0;
        // SAFETY: waitpid(2) with WNOHANG on a child we forked.
        let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if r == pid {
            let exited = (status & 0x7f) == 0;
            let code = (status >> 8) & 0xff;
            return exited && code == 0;
        }
        if r < 0 {
            return false;
        }
        std::thread::sleep(POLL_SLEEP);
    }
    tracing::warn!("isolation self-test: child did not exit in time; killing and reporting not usable");
    // SAFETY: kill(2)/waitpid(2) on our own child pid.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
        let mut status: libc::c_int = 0;
        libc::waitpid(pid, &mut status, 0);
    }
    false
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

    /// The company allow-list must permit a real agent to BOOT — exec a system
    /// binary + read a system lib + write inside its company root — while a
    /// SIBLING company dir stays DENIED. We fork a child, apply the COMPANY
    /// `ConfinePlan` for a temp company root, run the four probes, and report a
    /// bitmask via exit code (mirrors `fork_probe`: the parent thread is never
    /// jailed). On a host where Landlock is not enforced (the `@system-service`
    /// block / an old kernel) the child reports SKIP and the denial assertions
    /// are skipped — the allow-list wiring is still exercised.
    #[test]
    fn company_plan_boots_and_denies_sibling_company() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::path::PathBuf;

        // Exit-code protocol. SKIP = host cannot enforce (nothing to assert).
        // Otherwise a bitmask: 1=company-write ok, 2=system-lib read ok,
        // 4=sibling-read DENIED (good), 8=exec ok. All four ⇒ 15.
        const SKIP: i32 = 42;
        const B_WRITE: i32 = 1;
        const B_LIBREAD: i32 = 2;
        const B_SIBDENY: i32 = 4;
        const B_EXEC: i32 = 8;

        // The company root + sibling live directly under a fresh base in $HOME —
        // NOT under /tmp (which the allow-list grants broadly), so the sibling is
        // denied exactly as a real `<projects>/companies/<other>` tree would be.
        let Some(home) = dirs::home_dir() else {
            eprintln!("no home dir; skipping");
            return;
        };
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = home.join(format!(".supermux-iso-test-{}-{}", std::process::id(), nanos));
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = Cleanup(base.clone());

        let root = base.join("acme");
        let sibling = base.join("other");
        std::fs::create_dir_all(&root).expect("mk company root");
        std::fs::create_dir_all(&sibling).expect("mk sibling");
        // Create the sibling secret so an UN-jailed open would succeed — the
        // denial then proves the jail, not a missing file.
        std::fs::write(sibling.join("secret.txt"), b"sibling company secret").expect("write secret");

        // Build the REAL company allow-list. All allocation happens in the parent,
        // before the fork; the child only does libc syscalls + `_exit`.
        let spec = SandboxSpec::for_company(&root, &home);

        let write_c = CString::new(root.join("probe.txt").as_os_str().as_bytes()).unwrap();
        // A system lib/binary under an RO-allowed path (/bin is on the list).
        let lib_c = CString::new("/bin/sh").unwrap();
        let sib_c = CString::new(sibling.join("secret.txt").as_os_str().as_bytes()).unwrap();
        let exec_c = CString::new("/bin/true").unwrap();
        let arg0_c = CString::new("true").unwrap();

        // SAFETY: mirrors `fork_probe` — the child runs only Landlock syscalls,
        // libc open/exec on pre-owned paths, and `_exit(2)`; it never returns into
        // the Rust runtime.
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            // ── child ──
            let level = match LandlockLinux.confine(&spec) {
                Ok(l) => l,
                Err(_) => unsafe { libc::_exit(SKIP) },
            };
            if !level.is_enforced() {
                unsafe { libc::_exit(SKIP) };
            }
            let mut bits = 0i32;
            // 1) write inside the company root.
            let wfd =
                unsafe { libc::open(write_c.as_ptr(), libc::O_CREAT | libc::O_WRONLY, 0o600) };
            if wfd >= 0 {
                bits |= B_WRITE;
                unsafe { libc::close(wfd) };
            }
            // 2) read a system lib/binary (RO-allowed).
            let rfd = unsafe { libc::open(lib_c.as_ptr(), libc::O_RDONLY) };
            if rfd >= 0 {
                bits |= B_LIBREAD;
                unsafe { libc::close(rfd) };
            }
            // 3) read the sibling secret — MUST be denied by the jail.
            let sfd = unsafe { libc::open(sib_c.as_ptr(), libc::O_RDONLY) };
            if sfd < 0 {
                bits |= B_SIBDENY;
            } else {
                unsafe { libc::close(sfd) };
            }
            // 4) exec a system binary (RO+exec allowed). Nested fork so our own
            // computed bits survive; the grandchild becomes /bin/true.
            let epid = unsafe { libc::fork() };
            if epid == 0 {
                let argv = [arg0_c.as_ptr(), std::ptr::null()];
                unsafe {
                    libc::execv(exec_c.as_ptr(), argv.as_ptr());
                    libc::_exit(127);
                }
            }
            let mut est: libc::c_int = 0;
            unsafe { libc::waitpid(epid, &mut est, 0) };
            if (est & 0x7f) == 0 && ((est >> 8) & 0xff) == 0 {
                bits |= B_EXEC;
            }
            unsafe { libc::_exit(bits) };
        }
        assert!(pid > 0, "fork failed");

        // ── parent ──
        let mut status: libc::c_int = 0;
        unsafe { libc::waitpid(pid, &mut status, 0) };
        let exited = (status & 0x7f) == 0;
        let code = if exited { (status >> 8) & 0xff } else { -1 };

        if code == SKIP {
            eprintln!(
                "landlock not enforced on this host (or confine errored); \
                 skipping the company-jail assertions"
            );
            return;
        }
        assert_eq!(
            code,
            B_WRITE | B_LIBREAD | B_SIBDENY | B_EXEC,
            "confined company child: expected write|libread|sibling-denied|exec (bits {}), got {}",
            B_WRITE | B_LIBREAD | B_SIBDENY | B_EXEC,
            code,
        );
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

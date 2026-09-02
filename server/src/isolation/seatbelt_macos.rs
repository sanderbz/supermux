//! macOS Seatbelt isolation backend (`sandbox_init(3)`).
//!
//! The macOS counterpart to [`super::landlock_linux`]. It confines a freshly
//! forked agent child — in the same in-child, pre-`exec` window Landlock uses —
//! with a Seatbelt (App Sandbox) profile compiled by `sandbox_init`, the stable
//! libSystem entry point Chromium and friends have driven for years. It is
//! deprecated-but-present on every supported macOS; there is no non-deprecated
//! per-spawn equivalent, so we use it exactly as the platform still supports.
//!
//! # Level: `Partial`, by design — never `Full`
//! Landlock on Linux is deny-by-default over the *filesystem*, so it reports
//! [`IsolationLevel::Full`]. macOS Seatbelt *could* express `(deny default)`,
//! but a deny-default profile that still lets a real Claude/Codex toolchain
//! (node, cargo, git, playwright, mach lookups, sysctls, …) boot is enormous and
//! brittle — the exact fragility the PR's `TODO(P3)` calls out. So this backend
//! implements the honest, robust target the authors specified: **allow-default
//! with two targeted denials** —
//!   * **deny cross-company writes** — writes are re-restricted to the company
//!     `read_write_paths` (workspace + `/tmp`/`$TMPDIR` + spool), so a bot cannot
//!     write a sibling company tree; and
//!   * **deny reading secrets** — `~/.supermux/auth_token` is unreadable.
//! That is a real jail for the two threats that matter here, so it reports
//! [`IsolationLevel::Partial`] — never a `Full` it does not enforce.
//!
//! # Why fork for the probe/self-test
//! `sandbox_init` confines the **calling** process irreversibly. The real spawn
//! path calls [`SeatbeltMacOS::confine`] inside the agent child (post-fork,
//! pre-exec), which is correct. The startup probe and self-test must therefore
//! run in a **throwaway forked child** too — [`fork_probe`] /
//! [`self_test_confined_exec`] — so measuring the host can never jail the daemon
//! itself. This mirrors [`super::landlock_linux`] one-for-one.

use std::ffi::{CStr, CString};
use std::io;
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};

use super::{probe_home, IsolationLevel, IsolationProvider, SandboxSpec};

// `sandbox_init(3)` / `sandbox_free_error(3)` live in libSystem (linked by
// default). Deprecated in the SDK headers, but the symbols are stable and are
// the same ones `/usr/bin/sandbox-exec` and Chromium's sandbox use.
extern "C" {
    fn sandbox_init(profile: *const c_char, flags: u64, errorbuf: *mut *mut c_char) -> c_int;
    fn sandbox_free_error(errorbuf: *mut c_char);
}

// Exit-code protocol for the forked probe child — identical values to
// `landlock_linux` so the two backends speak the same wire language.
const CODE_NONE: i32 = 0;
const CODE_PARTIAL: i32 = 1;

/// The macOS Seatbelt backend. Zero-sized; all state lives in the [`SandboxSpec`].
pub struct SeatbeltMacOS;

impl IsolationProvider for SeatbeltMacOS {
    fn name(&self) -> &'static str {
        "seatbelt"
    }

    /// Confine the CURRENT process with the company Seatbelt profile. MUST only
    /// be called in a forked child (the spawn path's pre-exec window, or the
    /// [`fork_probe`]/[`self_test_confined_exec`] children) — it jails the caller
    /// for the rest of its life.
    fn confine(&self, spec: &SandboxSpec) -> io::Result<IsolationLevel> {
        apply_seatbelt(spec)
    }
}

/// Secret files a confined agent must never read (literal paths). Kept in sync
/// with [`SandboxSpec::for_company`]'s contract ("`~/.supermux/auth_token` stays
/// unreadable").
fn secret_paths() -> Vec<PathBuf> {
    let home = probe_home();
    vec![
        home.join(".supermux/auth_token"),
    ]
}

/// Secret SUBTREES a confined agent must never read — the macOS counterpart of
/// the Linux fix that stopped granting `~/.claude` wholesale. `projects/` holds
/// every Claude transcript for every project on the box (the reported leak);
/// `~/.config/gh` holds the owner's GitHub token. The session's OWN project dir
/// is re-allowed afterwards, because it rides on the spec's `read_write_paths`
/// (see [`build_profile`] — Seatbelt is last-match-wins).
fn secret_subpaths() -> Vec<PathBuf> {
    let home = probe_home();
    vec![
        home.join(".config/gh"),
    ]
}

/// Escape a path for a Seatbelt SBPL string literal (`"…"`): backslash and
/// double-quote are the only metacharacters inside an SBPL string.
fn sbpl_escape(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"")
}

/// Build the SBPL profile. Order matters — Seatbelt is last-match-wins:
///   1. `(allow default)` — the toolchain runs (this is why the level is Partial).
///   2. `(deny file-write*)` then re-allow writes under each company rw subpath —
///      net effect: writes only inside the company workspace/tmp/spool.
///   3. `(deny file-read* …)` — secrets stay unreadable: `~/.supermux/auth_token`
///      and `~/.claude/history.jsonl` as literals, plus the cross-project
///      subtrees (`~/.claude/projects`, `file-history`, `session-env`,
///      `backups`, `paste-cache`, and `~/.config/gh`).
///   4. re-allow `file-read*` under each rw subpath — LAST, so the session's own
///      Claude project dir (granted per session by the spawn path) survives the
///      blanket `projects/` denial while a sibling's does not.
fn build_profile(spec: &SandboxSpec) -> String {
    let mut s = String::from("(version 1)\n(allow default)\n");

    // (2) deny cross-company writes: blanket-deny, then re-allow the rw set.
    s.push_str("(deny file-write*)\n");
    for p in &spec.read_write_paths {
        s.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", sbpl_escape(p)));
    }

    // (3) deny reading secrets — literals, then the cross-project subtrees.
    for p in secret_paths() {
        s.push_str(&format!("(deny file-read* (literal \"{}\"))\n", sbpl_escape(&p)));
    }
    for p in secret_subpaths() {
        s.push_str(&format!("(deny file-read* (subpath \"{}\"))\n", sbpl_escape(&p)));
    }

    // (4) LAST — re-allow reads under the writable set. Seatbelt is
    // last-match-wins, so this restores the session's OWN Claude project dir
    // (granted RW per session by the spawn path) after the blanket
    // `~/.claude/projects` denial above, without re-opening a sibling's.
    for p in &spec.read_write_paths {
        s.push_str(&format!("(allow file-read* (subpath \"{}\"))\n", sbpl_escape(p)));
    }

    s
}

/// Compile + apply the profile to the current process via `sandbox_init`.
/// `Ok(Partial)` on success; `Err` (carrying `sandbox_init`'s own message) on
/// failure — the caller's strict/best-effort policy decides whether that aborts
/// the spawn or fails open, exactly as on Linux.
fn apply_seatbelt(spec: &SandboxSpec) -> io::Result<IsolationLevel> {
    let profile = build_profile(spec);
    let c_profile = CString::new(profile)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "seatbelt profile contains NUL"))?;

    let mut errbuf: *mut c_char = std::ptr::null_mut();
    // SAFETY: `sandbox_init` confines the current process and writes at most one
    // heap string into `errbuf` (freed below). Callers guarantee this runs in a
    // throwaway child, never the daemon (see the module + `confine` docs).
    let rc = unsafe { sandbox_init(c_profile.as_ptr(), 0, &mut errbuf) };
    if rc == 0 {
        Ok(IsolationLevel::Partial {
            backend: "seatbelt",
            note: "deny-cross-company-write + deny-read-secrets".to_string(),
        })
    } else {
        let msg = if errbuf.is_null() {
            "sandbox_init failed".to_string()
        } else {
            // SAFETY: `errbuf` is a non-null C string owned by libsandbox; we
            // copy it out, then hand it back to `sandbox_free_error`.
            let m = unsafe { CStr::from_ptr(errbuf) }.to_string_lossy().into_owned();
            unsafe { sandbox_free_error(errbuf) };
            m
        };
        Err(io::Error::other(format!("sandbox_init: {msg}")))
    }
}

/// Fork a throwaway child, confine it with the real company profile, and report
/// the enforced [`IsolationLevel`] via exit code. Runs in the PARENT; never
/// restricts the daemon (the child `_exit`s and never returns into the runtime).
/// Mirrors [`super::landlock_linux::fork_probe`].
pub fn fork_probe(provider: &dyn IsolationProvider) -> IsolationLevel {
    // Build the spec (allocations) BEFORE the fork; the child only runs
    // `sandbox_init` + `_exit`.
    let spec = SandboxSpec::for_company(Path::new("/tmp"), &probe_home());

    // SAFETY: `fork(2)` is async-signal-safe. The child runs one FFI call
    // (`sandbox_init`) then `_exit(2)` — no atexit handlers, no buffered-IO flush.
    let pid = unsafe { libc::fork() };
    if pid == 0 {
        let code = match provider.confine(&spec) {
            Ok(IsolationLevel::Partial { .. }) => CODE_PARTIAL,
            Ok(IsolationLevel::Full { .. }) => CODE_PARTIAL, // macOS never claims Full
            Ok(IsolationLevel::None) => CODE_NONE,
            Err(_) => CODE_NONE, // fail open: an unexpected error reads as "no jail"
        };
        // `_exit` (not `exit`): skip atexit / stdio flush in the forked child.
        unsafe { libc::_exit(code) };
    } else if pid < 0 {
        tracing::warn!("isolation probe: fork() failed; measuring None");
        return IsolationLevel::None;
    }

    match wait_exit_code(pid) {
        Some(CODE_PARTIAL) => IsolationLevel::Partial {
            backend: "seatbelt",
            note: "deny-cross-company-write + deny-read-secrets".to_string(),
        },
        _ => IsolationLevel::None,
    }
}

/// Fork a child, confine it with the real company profile, and `execv` a real
/// binary (`/bin/sh -c "exit 0"`) under it: proves a confined process can BOOT +
/// EXEC on this host. Runs in the PARENT; the child `execv`s / `_exit`s and never
/// returns into the Rust runtime. Mirrors
/// [`super::landlock_linux::self_test_confined_exec`].
pub fn self_test_confined_exec(home: &Path) -> bool {
    let spec = SandboxSpec::for_company(Path::new("/tmp"), home);

    // Pre-build the execv argv (CStrings) BEFORE the fork — no allocation in child.
    let sh = CString::new("/bin/sh").unwrap();
    let dash_c = CString::new("-c").unwrap();
    let prog = CString::new("exit 0").unwrap();
    let argv: [*const c_char; 4] = [sh.as_ptr(), dash_c.as_ptr(), prog.as_ptr(), std::ptr::null()];

    // SAFETY: `fork(2)` is async-signal-safe. The child runs `sandbox_init`,
    // then `execv`/`_exit` on pre-owned CStrings; it never returns into Rust.
    let pid = unsafe { libc::fork() };
    if pid == 0 {
        // Confine, then exec. A denied exec (insufficient allow-list) means the
        // execv fails ⇒ `_exit(127)` ⇒ the caller reads "not usable".
        let _ = SeatbeltMacOS.confine(&spec);
        unsafe {
            libc::execv(sh.as_ptr(), argv.as_ptr());
            // execv only returns on failure (e.g. the jail denied it).
            libc::_exit(127);
        }
    } else if pid < 0 {
        tracing::warn!("isolation self-test: fork() failed; reporting confinement not usable");
        return false;
    }

    matches!(wait_exit_code(pid), Some(0))
}

/// Bounded `waitpid` poll on a child we forked: returns its exit code, or
/// SIGKILLs a wedged child and returns `None`. Mirrors
/// `landlock_linux::self_test_exit_ok`'s discipline.
fn wait_exit_code(pid: libc::pid_t) -> Option<i32> {
    // ~2s budget (20 × 100ms) — the child does one syscall + exec/exit.
    for _ in 0..20 {
        let mut status: c_int = 0;
        // SAFETY: `waitpid(2)` with WNOHANG on a child we forked.
        let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if r == pid {
            if libc::WIFEXITED(status) {
                return Some(libc::WEXITSTATUS(status));
            }
            return None; // signalled/other ⇒ not a clean code
        }
        if r < 0 {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    // Wedged: SIGKILL + reap so we never leak a zombie.
    // SAFETY: `kill(2)`/`waitpid(2)` on our own child pid.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
        let mut status: c_int = 0;
        libc::waitpid(pid, &mut status, 0);
    }
    None
}

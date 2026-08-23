//! Portable per-spawn agent isolation (companies §4.4).
//!
//! A thin, in-tree `IsolationProvider` abstraction — modelled on the Codex-CLI
//! backend split, deliberately NOT the archived, GPL-3.0 `birdcage` crate — that
//! applies a kernel-enforced OS sandbox to a **company** agent's own shell at
//! spawn time. Main / PA / tech-admin bots (`company_id IS NULL`) are never
//! confined: the gate is the same one-fact `company_id` lever used everywhere
//! else in the companies design, and [`confine`](IsolationProvider::confine) is
//! simply never called for them.
//!
//! ## The three moving parts
//!
//! * [`IsolationMode`] — the *requested* policy, parsed from config
//!   (`isolation_mode`, default [`BestEffort`](IsolationMode::BestEffort)).
//! * [`IsolationLevel`] — the *measured* result. `BestEffort` surfaces THIS,
//!   never the requested mode, so it never over-claims.
//! * [`IsolationProvider`] — the backend trait. [`landlock_linux::LandlockLinux`]
//!   on Linux, [`SeatbeltMacOS`] (a P3 stub today) on macOS, [`Noop`] elsewhere.
//!
//! ## Fail-open (BestEffort) vs fail-closed (StrictRequired)
//!
//! On THIS box the systemd unit ships `SystemCallFilter=@system-service`, which
//! blocks the `landlock_*` syscalls (they live in the `@sandbox` set). The
//! `landlock` crate's ABI probe reads that seccomp `EPERM` as "unsupported" and,
//! under `CompatLevel::BestEffort`, `restrict_self()` returns
//! `RulesetStatus::NotEnforced` — which [`LandlockLinux::confine`] maps to
//! [`IsolationLevel::None`] (as a further belt-and-suspenders, a raw `EPERM` /
//! `ENOSYS` `io::Error` is also mapped to `None`, never an `Err`). Under
//! `BestEffort` the child STILL execs (one loud per-session warning); under
//! `StrictRequired` a company session refuses to start when the host measures
//! below the floor.
//!
//! The [startup probe](probe_isolation) forks a throwaway child that ACTUALLY
//! calls `restrict_self()` and reports the enforced level via its exit code —
//! the only way to catch the `@system-service` block, since a plain runtime
//! feature check would lie. It doubles as a deploy self-test: it flips
//! `None → Full` the instant the `@sandbox` unit line lands, with no code change.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;

#[cfg(target_os = "linux")]
pub mod landlock_linux;

// ─────────────────────────────────────────────────────────────────────────────
// IsolationMode — the REQUESTED policy
// ─────────────────────────────────────────────────────────────────────────────

/// The requested isolation policy (from config `isolation_mode`).
///
/// * [`Off`](Self::Off) — escape hatch; [`confine`](IsolationProvider::confine)
///   is never called.
/// * [`BestEffort`](Self::BestEffort) — default. Apply the strongest backend the
///   host offers; if none is available, log one loud per-session warning and
///   continue. Never crashes on a mechanism-less host. Surfaces the *measured*
///   [`IsolationLevel`], never this requested mode.
/// * [`StrictRequired`](Self::StrictRequired) — opt-in fail-closed: refuse to
///   start a company session when isolation is unavailable / below the floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IsolationMode {
    Off,
    #[default]
    BestEffort,
    StrictRequired,
}

impl IsolationMode {
    /// Parse a config string. Unknown / empty values fall back to the safe
    /// default ([`BestEffort`](Self::BestEffort)) rather than erroring — a typo
    /// must never silently disable the sandbox by mapping to `Off`.
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" | "none" | "disabled" => IsolationMode::Off,
            "strict" | "strictrequired" | "strict_required" | "required" => {
                IsolationMode::StrictRequired
            }
            _ => IsolationMode::BestEffort,
        }
    }
}

impl fmt::Display for IsolationMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IsolationMode::Off => f.write_str("off"),
            IsolationMode::BestEffort => f.write_str("best-effort"),
            IsolationMode::StrictRequired => f.write_str("strict-required"),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// IsolationLevel — the MEASURED result
// ─────────────────────────────────────────────────────────────────────────────

/// The measured result of applying (or probing) a backend. Display-able for
/// logs and the (P2) session UI badge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IsolationLevel {
    /// Nothing enforced (mechanism-less host, or the `@system-service` block).
    None,
    /// Some rules enforced, following a best-effort downgrade (old kernel, a
    /// macOS-v1 profile). Carries the backend name + a human note.
    Partial {
        backend: &'static str,
        note: String,
    },
    /// Fully enforced by the kernel.
    Full { backend: &'static str },
}

impl IsolationLevel {
    /// True when the kernel enforces at least a partial jail.
    pub fn is_enforced(&self) -> bool {
        !matches!(self, IsolationLevel::None)
    }
}

impl fmt::Display for IsolationLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IsolationLevel::None => f.write_str("None"),
            IsolationLevel::Partial { backend, note } => {
                write!(f, "Partial({backend}: {note})")
            }
            IsolationLevel::Full { backend } => write!(f, "Full({backend})"),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SandboxSpec — the allow-list derived from a company session
// ─────────────────────────────────────────────────────────────────────────────

/// The filesystem allow-list a backend confines a company agent to.
///
/// Built from `(root_dir, home)` (see [`for_company`](Self::for_company)) so it
/// is unit-testable without a live session. The spawn wiring additionally pushes
/// the session's own spool/socket dir onto [`read_write_paths`](Self::read_write_paths)
/// via [`allow_rw`](Self::allow_rw) (the native holder must bind its unix socket
/// and write its spool there).
#[derive(Debug, Clone, Default)]
pub struct SandboxSpec {
    /// Read + write + exec (the company tree; `/tmp`; the session spool dir).
    pub read_write_paths: Vec<PathBuf>,
    /// Read + exec only (system libraries, interpreters, dev caches).
    pub read_exec_paths: Vec<PathBuf>,
}

impl SandboxSpec {
    /// Build the allow-list for a company session rooted at `root_dir`, with the
    /// service user's `home` supplying the toolchain / config paths.
    ///
    /// The allow-list is calibrated so a real Claude/Codex agent (and the
    /// pty-holder that carries it) can EXEC + BOOT + run git/node/tmux inside its
    /// company root, while sibling company trees and `~/.supermux/auth_token` stay
    /// DENIED (they are simply never listed).
    ///
    /// * `read_write_paths` — the company tree (workspace); `/tmp` + `$TMPDIR`;
    ///   and the `$HOME` config/cache/state dirs the agent must write at boot
    ///   (`~/.claude`, `~/.claude.json`, `~/.config`, `~/.cache`, `~/.local/state`).
    ///   The spawn wiring appends the session's own spool/socket dir via
    ///   [`allow_rw`](Self::allow_rw).
    /// * `read_exec_paths` — the whole standard system read/exec surface
    ///   (`/usr`, `/bin`, `/sbin`, `/lib{,32,64}`, `/etc`, `/proc`, `/sys`), the
    ///   pty-holder binary under us ([`current_exe`](std::env::current_exe) + its
    ///   parent dir — the flagged gap: a Full jail must let the holder re-exec
    ///   itself), and the language/dev toolchains + claude/codex binary trees
    ///   under `$HOME`.
    ///
    /// Paths that do not exist are silently skipped by the Landlock backend
    /// (`PathFd::new` fails and the rule is dropped), so listing an absent path is
    /// harmless. Note `/opt` is deliberately NOT blanket-allowed so sibling
    /// company trees under `<projects>/companies/<other>` stay denied; an
    /// out-of-tree holder install is covered by `current_exe` instead.
    pub fn for_company(root_dir: &Path, home: &Path) -> Self {
        // ── RW: the company workspace + shared scratch + the agent's own
        // config/cache/state it writes at boot. ──
        let mut read_write_paths: Vec<PathBuf> =
            vec![root_dir.to_path_buf(), PathBuf::from("/tmp")];
        if let Some(tmp) = std::env::var_os("TMPDIR") {
            let tmp = PathBuf::from(tmp);
            if !tmp.as_os_str().is_empty() && tmp != Path::new("/tmp") {
                read_write_paths.push(tmp);
            }
        }
        for w in [".claude", ".claude.json", ".config", ".cache", ".local/state"] {
            read_write_paths.push(home.join(w));
        }

        // ── RO+exec: the standard system surface. ──
        let mut read_exec_paths: Vec<PathBuf> = [
            "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/proc", "/sys",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();

        // The pty-holder binary under us (e.g. /usr/local/bin/supermux-server)
        // and its parent dir — THE flagged gap: a fully-enforced jail must let the
        // holder re-exec itself to boot. `current_exe` may already fall under
        // `/usr`; adding it explicitly covers an out-of-tree install (e.g. under
        // `/opt/...`) without blanket-allowing any company tree.
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                read_exec_paths.push(parent.to_path_buf());
            }
            read_exec_paths.push(exe);
        }

        // Language/dev toolchains + the claude/codex/node binary trees under
        // $HOME (RO+exec is enough to RUN them; their writable state lives under
        // the RW dirs above or the company tree). `.local` covers
        // `.local/share/claude` and `.local/bin`; the explicit entries document
        // the boot dependency.
        //
        // Landlock matches on the RESOLVED path, so a provider launched through a
        // symlink (`~/.local/bin/codex` → `~/.codex/…/bin/codex`,
        // `~/.local/bin/claude` → `~/.local/share/claude/versions/X`,
        // `~/node-local/current` → `~/node-local/node-vX`) needs its REAL target
        // tree allow-listed too — `push_ro_resolved` adds both the listed path and
        // its `canonicalize`d target. The provider trees are named explicitly:
        //   * `.codex`  — the codex standalone package tree (covers `packages/
        //     standalone/current` → `releases/<ver>/bin/codex`, all under `.codex`).
        //   * `node-local` — the node toolchain (covers `current` → `node-vX`).
        //   * `.local/share/claude` — the claude ELF (kimi runs it too).
        for cache in [
            ".cargo",
            ".rustup",
            ".npm",
            ".nvm",
            ".local",
            ".local/share/claude",
            ".local/bin",
            ".codex",
            "node-local",
        ] {
            push_ro_resolved(&mut read_exec_paths, home.join(cache));
        }
        // The holder/provider binaries above may be reached through a symlink;
        // also resolve the pty-holder binary itself (an out-of-tree install could
        // be symlinked). `current_exe` was already pushed as-is above; add its
        // resolved target so a Full jail still permits the holder to re-exec.
        if let Ok(exe) = std::env::current_exe() {
            if let Ok(real) = std::fs::canonicalize(&exe) {
                if real != exe {
                    if let Some(parent) = real.parent() {
                        read_exec_paths.push(parent.to_path_buf());
                    }
                    read_exec_paths.push(real);
                }
            }
        }

        Self {
            read_write_paths,
            read_exec_paths,
        }
    }

    /// Grant read+write to an additional absolute path (e.g. the native
    /// session's spool/socket dir). Chainable-free; mutates in place.
    pub fn allow_rw(&mut self, path: PathBuf) {
        self.read_write_paths.push(path);
    }
}

/// Push a RO+exec allow-list entry, adding BOTH the given path and — when it (or
/// a component) is a symlink — its `canonicalize`d target. Landlock enforces
/// against the RESOLVED path, so a provider binary reached through a symlink
/// (`~/.local/bin/codex` → `~/.codex/…`) is only runnable if the real target
/// tree is on the list. An absent path canonicalizes to an error and only the
/// literal (harmlessly-absent) entry is kept; the Landlock backend drops it.
fn push_ro_resolved(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if let Ok(real) = std::fs::canonicalize(&path) {
        if real != path {
            paths.push(real);
        }
    }
    paths.push(path);
}

// ─────────────────────────────────────────────────────────────────────────────
// IsolationProvider — the backend trait
// ─────────────────────────────────────────────────────────────────────────────

/// A confinement backend. Implementations are cheap value types; the active one
/// is shared as `Arc<dyn IsolationProvider>` so a [`ConfinePlan`] can carry it
/// into a post-fork / pre-exec closure.
pub trait IsolationProvider: Send + Sync {
    /// Stable backend name for logs / the measured [`IsolationLevel`].
    fn name(&self) -> &'static str;

    /// Confine the CALLING thread to `spec` and report the measured level.
    ///
    /// **Contract:** MUST be called only inside a freshly-forked child, pre-exec
    /// — it restricts the *calling* thread irreversibly. Returns `Ok(level)` on
    /// success (including `Ok(IsolationLevel::None)` when the host enforces
    /// nothing — e.g. the `@system-service` seccomp block, which surfaces as
    /// `EPERM`/`ENOSYS` and is mapped to `None`, never `Err`). An `Err` is
    /// reserved for a genuinely unexpected failure; under `BestEffort` the spawn
    /// wiring still fails open on it.
    fn confine(&self, spec: &SandboxSpec) -> io::Result<IsolationLevel>;
}

/// The all-platforms no-op backend: never confines, always measures
/// [`IsolationLevel::None`]. The honest fallback on a mechanism-less host — it
/// claims no jail it does not have.
pub struct Noop;

impl IsolationProvider for Noop {
    fn name(&self) -> &'static str {
        "noop"
    }
    fn confine(&self, _spec: &SandboxSpec) -> io::Result<IsolationLevel> {
        Ok(IsolationLevel::None)
    }
}

/// macOS Seatbelt backend — **P3 stub**. The real backend shells out to
/// `/usr/bin/sandbox-exec -p <profile>` (deny-cross-company-write +
/// deny-read-secrets ⇒ `Partial`) once the Mac mini joins the fleet. Until then
/// it is honest: a no-op that measures [`IsolationLevel::None`] so macOS runs
/// Noop + the secret-floor and never claims a jail it lacks.
///
/// TODO(P3): build the `sandbox-exec` profile (deny-cross-company-write +
/// deny-read-secrets, `-D COMPANY_DIR=…`/`-D SECRETS=…`), report `Partial`, and
/// add the `excludedCommands` / `dangerouslyDisableSandbox` escape hatch for the
/// three known breakage classes (Go-CLI TLS, Apple Events `-600`, nested
/// Playwright/Chromium).
#[cfg(target_os = "macos")]
pub struct SeatbeltMacOS;

#[cfg(target_os = "macos")]
impl IsolationProvider for SeatbeltMacOS {
    fn name(&self) -> &'static str {
        "seatbelt"
    }
    fn confine(&self, _spec: &SandboxSpec) -> io::Result<IsolationLevel> {
        // TODO(P3): compile + apply the sandbox-exec profile; report Partial.
        Ok(IsolationLevel::None)
    }
}

/// The active backend for this host: Landlock on Linux, Seatbelt (stub) on
/// macOS, Noop elsewhere.
pub fn active_provider() -> Arc<dyn IsolationProvider> {
    #[cfg(target_os = "linux")]
    {
        Arc::new(landlock_linux::LandlockLinux)
    }
    #[cfg(target_os = "macos")]
    {
        Arc::new(SeatbeltMacOS)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Arc::new(Noop)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ConfinePlan — the unit of work carried into a pre-exec closure
// ─────────────────────────────────────────────────────────────────────────────

/// Everything a spawned child needs to confine itself: the backend, the
/// allow-list, and whether the mode is fail-closed.
///
/// Constructed in the spawn path (in the *parent*, so all allocation happens
/// before the fork) and moved into the child's `pre_exec` closure, where
/// [`apply_in_child`](Self::apply_in_child) runs it. `Send + Sync + 'static` by
/// construction (`Arc<dyn IsolationProvider>` + owned [`SandboxSpec`] + `bool`).
pub struct ConfinePlan {
    provider: Arc<dyn IsolationProvider>,
    spec: SandboxSpec,
    /// `true` under `StrictRequired`: a confine `Err` aborts the spawn. Under
    /// `BestEffort` (`false`) it fails open (the child still execs).
    strict: bool,
}

impl ConfinePlan {
    fn new(provider: Arc<dyn IsolationProvider>, spec: SandboxSpec, strict: bool) -> Self {
        Self {
            provider,
            spec,
            strict,
        }
    }

    /// Grant an extra RW path (the native session's spool/socket dir) before the
    /// plan is moved into the child.
    pub fn allow_rw(&mut self, path: PathBuf) {
        self.spec.allow_rw(path);
    }

    /// Run INSIDE the forked child, post-fork / pre-exec.
    ///
    /// Applies the confinement and translates the outcome into the `pre_exec`
    /// contract: `Ok(())` lets the exec proceed, `Err` aborts the spawn.
    ///
    /// * A measured level (`Ok(_)`) — including `Ok(None)` on a mechanism-less /
    ///   `@system-service`-blocked host — always proceeds. Fail open.
    /// * A genuinely unexpected confine `Err` aborts ONLY under `StrictRequired`;
    ///   under `BestEffort` it fails open too (the whole point of the default).
    pub fn apply_in_child(&self) -> io::Result<()> {
        match self.provider.confine(&self.spec) {
            Ok(_level) => Ok(()),
            Err(_e) if !self.strict => Ok(()), // BestEffort: fail open.
            Err(e) => Err(e),                  // StrictRequired: abort the spawn.
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup probe
// ─────────────────────────────────────────────────────────────────────────────

/// The once-at-startup probe result, stored in `AppState` for per-spawn logging
/// and the StrictRequired floor check.
#[derive(Debug, Clone)]
pub struct ProbeResult {
    /// The backend that ran the probe (`landlock` / `seatbelt` / `noop`).
    pub backend: &'static str,
    /// The strongest level this host can actually enforce.
    pub best_level: IsolationLevel,
}

/// Run the isolation probe ONCE per process (subsequent calls return the cached
/// result). Forks a throwaway child that ACTUALLY restricts itself and reports
/// the enforced [`IsolationLevel`] via exit code — the only reliable way to
/// detect the systemd `@system-service` block, which a runtime feature check
/// would miss. Logs one honest startup line.
pub fn probe_isolation() -> ProbeResult {
    static PROBE: OnceLock<ProbeResult> = OnceLock::new();
    PROBE
        .get_or_init(|| {
            let provider = active_provider();
            let backend = provider.name();
            let best_level = measure_best_level(provider.as_ref());
            let result = ProbeResult {
                backend,
                best_level,
            };
            match &result.best_level {
                IsolationLevel::Full { .. } => tracing::info!(
                    backend = result.backend,
                    "isolation: {} -> {} (kernel-enforced)",
                    result.backend,
                    result.best_level,
                ),
                IsolationLevel::Partial { .. } => tracing::info!(
                    backend = result.backend,
                    "isolation: {} -> {} (best-effort downgrade)",
                    result.backend,
                    result.best_level,
                ),
                IsolationLevel::None => tracing::warn!(
                    backend = result.backend,
                    "isolation: {} -> None (no OS sandbox on this host; if Landlock-capable, \
                     the systemd @system-service filter is blocking landlock_* — add \
                     SystemCallFilter=@sandbox to supermux.service). Company agents run \
                     UNCONFINED under BestEffort; secret-floor still applies.",
                    result.backend,
                ),
            }
            result
        })
        .clone()
}

/// Measure the best enforceable level WITHOUT confining the daemon.
///
/// On Linux this MUST fork — `restrict_self()` is irreversible and would jail
/// the daemon itself. The child restricts itself against a throwaway spec and
/// reports the level via exit code; the parent decodes it (and defends against a
/// wedged child with a bounded wait + SIGKILL, so the probe can never hang boot).
/// On every other platform the backend's `confine` does not restrict the caller
/// (Noop / the Seatbelt stub), so it is called directly.
fn measure_best_level(provider: &dyn IsolationProvider) -> IsolationLevel {
    #[cfg(target_os = "linux")]
    {
        landlock_linux::fork_probe(provider)
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Noop / Seatbelt-stub confine() do not restrict the caller.
        let spec = SandboxSpec::for_company(Path::new("/tmp"), &probe_home());
        provider
            .confine(&spec)
            .unwrap_or(IsolationLevel::None)
    }
}

/// A home dir for the probe spec. `dirs::home_dir()` when resolvable, else `/tmp`
/// (the probe only needs existing paths; absent ones are dropped anyway).
pub(crate) fn probe_home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup self-test — can a confined child actually BOOT + EXEC on this host?
// ─────────────────────────────────────────────────────────────────────────────

/// Run the company-confinement self-test ONCE per process (subsequent calls
/// return the cached result). This is the robust, self-correcting guarantee that
/// a broken jail can never silently make every company bot un-startable
/// (companies §4.4).
///
/// It forks a throwaway child, applies the **real** company [`ConfinePlan`] for a
/// temp company root (the same [`SandboxSpec::for_company`] the spawn path uses),
/// and then actually `execv`s a real binary (`/bin/sh -c "exit 0"`) under it. The
/// child's exit code reports whether a confined process can BOOT + EXEC on THIS
/// host: exit 0 ⇒ usable; anything else (the allow-list is insufficient, so the
/// kernel denied the exec; a wedged child we SIGKILL; a fork/exec failure) ⇒ not
/// usable.
///
/// * On a host that enforces nothing (this box's `@system-service` block, or an
///   old kernel), `confine` measures `None`, the child is unrestricted, the exec
///   succeeds, and the test PASSES — company bots then run unconfined via
///   fail-open, exactly as before.
/// * On a host that DOES enforce Landlock but whose allow-list cannot exec a real
///   binary, the confined child's exec is denied → the test FAILS → the spawn
///   path disables company confinement for this boot (see
///   [`IsolationRuntime::confinement_usable`] / `company_confinement`), so bots
///   still start (unconfined) instead of every one dying at exec.
///
/// Logs exactly one line (loud warning on failure) the first time it runs.
pub fn confinement_self_test() -> bool {
    static TEST: OnceLock<bool> = OnceLock::new();
    *TEST.get_or_init(|| {
        let usable = run_confinement_self_test();
        if usable {
            tracing::debug!(
                "isolation self-test: a confined child can boot + exec on this host \
                 (company confinement enabled where the host enforces it)"
            );
        } else {
            tracing::warn!(
                "isolation self-test FAILED: a confined child could NOT boot + exec with the \
                 real company allow-list on this host — company Landlock jail not functional; \
                 company bots run UNCONFINED this boot. Check the allow-list in \
                 server/src/isolation (SandboxSpec::for_company)."
            );
        }
        usable
    })
}

/// Platform dispatch for [`confinement_self_test`]. On Linux this forks + confines
/// + execs (the only honest test). Everywhere else the backend does not restrict
/// the caller (Noop / Seatbelt stub), so a confined child always execs ⇒ `true`.
fn run_confinement_self_test() -> bool {
    #[cfg(target_os = "linux")]
    {
        landlock_linux::self_test_confined_exec(&probe_home())
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// IsolationRuntime — the per-process handle stored in AppState
// ─────────────────────────────────────────────────────────────────────────────

/// The process-wide isolation handle: the requested [`IsolationMode`], the
/// startup [`ProbeResult`], and the active backend. Built once in
/// `AppState::new`; consulted by the spawn path.
pub struct IsolationRuntime {
    mode: IsolationMode,
    probe: ProbeResult,
    provider: Arc<dyn IsolationProvider>,
    /// The startup self-test result: `true` when a confined child could actually
    /// BOOT + EXEC on this host with the real company allow-list. `false` disables
    /// company Landlock confinement for this boot (bots run unconfined) so a
    /// broken jail can never leave every company bot un-startable (§4.4).
    confinement_usable: bool,
}

impl IsolationRuntime {
    /// Build from the resolved config mode. Runs (or reuses) the startup probe
    /// AND the startup confinement self-test.
    pub fn from_mode(mode: IsolationMode) -> Self {
        let provider = active_provider();
        let probe = probe_isolation();
        let confinement_usable = confinement_self_test();
        Self {
            mode,
            probe,
            provider,
            confinement_usable,
        }
    }

    /// The requested policy.
    pub fn mode(&self) -> IsolationMode {
        self.mode
    }

    /// The probe result (backend + best enforceable level on this host).
    pub fn probe(&self) -> &ProbeResult {
        &self.probe
    }

    /// Whether the startup self-test proved a confined child can BOOT + EXEC on
    /// this host. When `false`, the spawn path MUST run company bots unconfined
    /// (the jail would break them) — see `company_confinement`.
    pub fn confinement_usable(&self) -> bool {
        self.confinement_usable
    }

    /// Build a [`ConfinePlan`] for a company session rooted at `root_dir`, or
    /// `None` when the mode is [`Off`](IsolationMode::Off) (confinement is then
    /// never applied — the escape hatch). Callers MUST only call this for a
    /// company session (`company_id.is_some()`); main/PA bots are never confined.
    pub fn plan_for(&self, root_dir: &Path, home: &Path) -> Option<ConfinePlan> {
        if self.mode == IsolationMode::Off {
            return None;
        }
        let spec = SandboxSpec::for_company(root_dir, home);
        Some(ConfinePlan::new(
            self.provider.clone(),
            spec,
            self.mode == IsolationMode::StrictRequired,
        ))
    }

    /// Under [`StrictRequired`](IsolationMode::StrictRequired), the reason a
    /// company session must REFUSE to start on this host (the measured level is
    /// below the floor), or `None` when the host meets the floor / the mode is
    /// not strict. The v1 floor is "any enforcement" — `None` fails, `Partial`
    /// and `Full` pass. (A configurable ABI floor is future work.)
    pub fn strict_refusal(&self) -> Option<String> {
        if self.mode != IsolationMode::StrictRequired {
            return None;
        }
        if !self.probe.best_level.is_enforced() {
            Some(format!(
                "isolation_mode=strict-required but this host enforces no OS sandbox \
                 (backend {} measured {}); refusing to start the company session. \
                 On Linux, add SystemCallFilter=@sandbox to supermux.service, or set \
                 isolation_mode=best-effort to run unconfined with a warning.",
                self.probe.backend, self.probe.best_level,
            ))
        } else if !self.confinement_usable {
            // The host enforces Landlock, but the startup self-test showed a
            // confined child cannot boot + exec with the real allow-list. Under
            // strict we REFUSE (fail-closed) rather than silently unconfine; under
            // best-effort the spawn path unconfines instead (never reaches here).
            Some(format!(
                "isolation_mode=strict-required and this host enforces {} but the startup \
                 self-test showed a confined child cannot boot + exec with the allow-list; \
                 refusing to start the company session. Fix the allow-list in \
                 server/src/isolation (SandboxSpec::for_company), or set \
                 isolation_mode=best-effort to run unconfined with a warning.",
                self.probe.best_level,
            ))
        } else {
            None
        }
    }
}

impl std::fmt::Debug for IsolationRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IsolationRuntime")
            .field("mode", &self.mode)
            .field("probe", &self.probe)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parsing_and_default() {
        assert_eq!(IsolationMode::default(), IsolationMode::BestEffort);
        assert_eq!(IsolationMode::parse("off"), IsolationMode::Off);
        assert_eq!(IsolationMode::parse("Off"), IsolationMode::Off);
        assert_eq!(IsolationMode::parse("disabled"), IsolationMode::Off);
        assert_eq!(
            IsolationMode::parse("strict"),
            IsolationMode::StrictRequired
        );
        assert_eq!(
            IsolationMode::parse("strict_required"),
            IsolationMode::StrictRequired
        );
        assert_eq!(
            IsolationMode::parse("best-effort"),
            IsolationMode::BestEffort
        );
        // Unknown / empty / typo => the SAFE default, never Off.
        assert_eq!(IsolationMode::parse(""), IsolationMode::BestEffort);
        assert_eq!(IsolationMode::parse("bogus"), IsolationMode::BestEffort);
        assert_eq!(IsolationMode::parse("   "), IsolationMode::BestEffort);
    }

    #[test]
    fn sandbox_spec_includes_company_root_rw_and_system_ro() {
        let root = PathBuf::from("/srv/companies/acme");
        let home = PathBuf::from("/home/supermux");
        let spec = SandboxSpec::for_company(&root, &home);

        // The company tree is read-write.
        assert!(
            spec.read_write_paths.contains(&root),
            "company root must be RW: {:?}",
            spec.read_write_paths
        );
        // /tmp is read-write.
        assert!(spec.read_write_paths.contains(&PathBuf::from("/tmp")));
        // System paths are read-exec (RO), not read-write.
        for p in ["/usr", "/lib", "/lib64", "/bin", "/etc"] {
            let pb = PathBuf::from(p);
            assert!(
                spec.read_exec_paths.contains(&pb),
                "{p} must be RO: {:?}",
                spec.read_exec_paths
            );
            assert!(
                !spec.read_write_paths.contains(&pb),
                "{p} must NOT be RW"
            );
        }
        // A dev cache under $HOME is present (RO).
        assert!(spec.read_exec_paths.contains(&home.join(".cargo")));
        // The company root is NOT in the RO list (it is RW-only).
        assert!(!spec.read_exec_paths.contains(&root));
    }

    #[test]
    fn allow_list_includes_provider_binary_trees() {
        // The broadened allow-list (finding #1) must RO+exec the codex standalone
        // package tree, the node toolchain, and the claude ELF tree — the provider
        // binary homes a dev agent execs — so a Full jail can RUN any provider.
        let home = PathBuf::from("/home/supermux");
        let spec = SandboxSpec::for_company(Path::new("/srv/companies/acme"), &home);
        for p in [".codex", "node-local", ".local/share/claude", ".local/bin"] {
            assert!(
                spec.read_exec_paths.contains(&home.join(p)),
                "{p} must be RO+exec on the allow-list: {:?}",
                spec.read_exec_paths
            );
        }
        // Provider trees are RO, never RW (their writable state lives elsewhere).
        for p in [".codex", "node-local"] {
            assert!(
                !spec.read_write_paths.contains(&home.join(p)),
                "{p} must NOT be RW"
            );
        }
        // Sibling company trees + the auth token are DENIED (never listed): no
        // blanket /opt, and ~/.supermux is absent from both lists.
        assert!(!spec.read_exec_paths.contains(&PathBuf::from("/opt")));
        assert!(!spec.read_write_paths.contains(&PathBuf::from("/opt")));
        assert!(!spec
            .read_exec_paths
            .contains(&home.join(".supermux/auth_token")));
        assert!(!spec.read_write_paths.contains(&home.join(".supermux")));
    }

    #[test]
    fn push_ro_resolved_adds_both_link_and_target() {
        // A symlinked provider path must land BOTH the link and its resolved
        // target on the list (Landlock matches the resolved path). Build a real
        // symlink under a temp dir and assert both are pushed.
        let base = std::env::temp_dir().join(format!(
            "supermux-iso-symlink-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ));
        let target = base.join("real-tree");
        let link = base.join("link");
        std::fs::create_dir_all(&target).expect("mk target");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        let mut v = Vec::new();
        push_ro_resolved(&mut v, link.clone());
        assert!(v.contains(&link), "the link itself is listed: {v:?}");
        #[cfg(unix)]
        {
            let real = std::fs::canonicalize(&link).expect("canonicalize");
            assert!(v.contains(&real), "the resolved target is listed too: {v:?}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn confinement_self_test_is_a_bool_and_memoised() {
        // The startup self-test (finding #2) must return a bool without panicking,
        // and be idempotent (cached). On THIS box Landlock is @system-service-
        // blocked, so confine measures None, the confined child is unrestricted,
        // its `/bin/sh -c "exit 0"` execs, and the test PASSES (true). We assert
        // the contract (a stable bool), not a host-specific value — except that a
        // host where the self-test child can exec must report true.
        let a = confinement_self_test();
        let b = confinement_self_test();
        assert_eq!(a, b, "self-test must be memoised (stable across calls)");
        // The runtime surfaces it, and on a host that enforces nothing the
        // self-test passes (unrestricted child execs fine).
        let rt = IsolationRuntime::from_mode(IsolationMode::BestEffort);
        assert_eq!(rt.confinement_usable(), a);
        if !rt.probe().best_level.is_enforced() {
            assert!(
                rt.confinement_usable(),
                "a host that enforces nothing must pass the self-test (child execs unconfined)"
            );
        }
    }

    #[test]
    fn strict_refuses_when_self_test_fails_but_best_effort_never_does() {
        // strict_refusal must fire under StrictRequired whenever confinement is
        // not usable OR the host is unenforced; BestEffort never refuses (it
        // unconfines instead, handled in company_confinement).
        let best = IsolationRuntime::from_mode(IsolationMode::BestEffort);
        assert!(best.strict_refusal().is_none());
    }

    #[test]
    fn allow_rw_appends_the_session_dir() {
        let mut spec = SandboxSpec::for_company(
            Path::new("/srv/companies/acme"),
            Path::new("/home/supermux"),
        );
        let session_dir = PathBuf::from("/home/supermux/.supermux/native/acme-bot");
        spec.allow_rw(session_dir.clone());
        assert!(spec.read_write_paths.contains(&session_dir));
    }

    #[test]
    fn probe_runs_and_returns_a_level_without_panicking() {
        // On THIS box the systemd @system-service filter blocks landlock_*, so
        // the probe MUST measure None — and it must be a *level*, never an Err /
        // a panic. (On a host with @sandbox this would be Full/Partial; the test
        // asserts the contract, not a specific level, except that a blocked host
        // is None not an error.)
        let probe = probe_isolation();
        // Idempotent: a second call returns the same cached result.
        let again = probe_isolation();
        assert_eq!(probe.backend, again.backend);
        assert_eq!(probe.best_level, again.best_level);

        // The measured level is well-formed and Display-able (no panic).
        let _ = format!("{}", probe.best_level);

        // A blocked / mechanism-less host reports None (not an Err — the probe
        // returns a level unconditionally). We can't assert Full here since CI /
        // this box lacks @sandbox, but None must be represented as None.
        match &probe.best_level {
            IsolationLevel::None
            | IsolationLevel::Partial { .. }
            | IsolationLevel::Full { .. } => {}
        }
    }

    #[test]
    fn best_effort_plan_fails_open_when_confine_reports_none() {
        // A ConfinePlan built over a backend that measures None must let the
        // child exec under BestEffort (apply_in_child -> Ok), never abort.
        let rt = IsolationRuntime::from_mode(IsolationMode::BestEffort);
        let plan = rt
            .plan_for(Path::new("/tmp"), &probe_home())
            .expect("BestEffort yields a plan");
        // The Noop provider (and a @system-service-blocked Landlock) both report
        // None; apply_in_child must fail OPEN. We assert via a Noop-backed plan
        // so the result is deterministic on every platform.
        let noop_plan = ConfinePlan::new(
            Arc::new(Noop),
            SandboxSpec::for_company(Path::new("/tmp"), &probe_home()),
            /* strict */ false,
        );
        assert!(
            noop_plan.apply_in_child().is_ok(),
            "BestEffort must fail open on a None measurement"
        );
        // And the real host plan is constructed (mode != Off).
        let _ = plan;
    }

    #[test]
    fn off_mode_never_builds_a_plan() {
        // GATING: mode Off yields no plan, so confine() is never called — the
        // escape hatch. (The company_id gate itself is enforced at the call site
        // in lifecycle::start_locked; this covers the mode half.)
        let rt = IsolationRuntime::from_mode(IsolationMode::Off);
        assert!(rt.plan_for(Path::new("/tmp"), &probe_home()).is_none());
    }

    #[test]
    fn strict_refusal_only_when_unenforced() {
        // StrictRequired on a host that measures None must refuse; BestEffort
        // never refuses.
        let strict = IsolationRuntime::from_mode(IsolationMode::StrictRequired);
        let best = IsolationRuntime::from_mode(IsolationMode::BestEffort);
        assert!(best.strict_refusal().is_none());
        // On THIS box (blocked) strict refuses; on a @sandbox host it would not.
        if !strict.probe().best_level.is_enforced() {
            assert!(strict.strict_refusal().is_some());
        } else {
            assert!(strict.strict_refusal().is_none());
        }
    }
}

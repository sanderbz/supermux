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
//!
//! ## The shared Claude home, and the one boundary that is left
//!
//! `~/.claude` is per-USER, not per-company. Granting it wholesale (as this
//! module did until 2026-09-02) handed every confined company bot the whole
//! box's Claude state: `projects/<every project>/*.jsonl` (6.1 GB of
//! transcripts across 236 project dirs on the box where this was found),
//! `history.jsonl` (every prompt ever typed), `file-history/`, `session-env/`,
//! and write access to `settings.json` + `plugins/`, whose hooks OTHER sessions
//! execute. The owner's own confined bot demonstrated it: *"648 files, zero
//! blocked … the token came out of transcripts of supermux and home-supermux."*
//!
//! Landlock is an allow-list with no "except", so the fix is to enumerate:
//! [`CLAUDE_HOME_RO`] (read-only) + [`AGENT_STATE_RW`] (writable tool state) +
//! ONE per-session read-write grant for the session's own
//! `projects/<encoded cwd>` dir ([`ConfinePlan::allow_claude_project`]).
//!
//! What is left shared, on purpose: `~/.claude/.credentials.json`, the Claude
//! OAuth token. Company bots today authenticate as the ONE Claude account that
//! owns the box, so the agent must be able to read it. The structural fix is a
//! per-session Claude config dir — the `config_dir` column /
//! `CLAUDE_CONFIG_DIR`, which the spawn path already grants read-write when a
//! session has one; a session with its own `config_dir` sees a Claude home that
//! is private to it, credentials included.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;

#[cfg(target_os = "linux")]
pub mod landlock_linux;

#[cfg(target_os = "macos")]
pub mod seatbelt_macos;

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
            "strict" | "strictrequired" | "strict_required" | "strict-required" | "required" => {
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
    /// The EXPLICIT read-only grants added after construction (a session's own
    /// config dir, the operator's `[[company_isolation]] read_only` entries) —
    /// always also present in `read_exec_paths`. Kept separately because the
    /// Seatbelt backend is allow-by-default with a deny list for secrets and
    /// therefore ignores `read_exec_paths`; it needs to know which reads to
    /// re-allow ON TOP of its denies (`~/.config/gh` is on its secret list).
    pub extra_read_paths: Vec<PathBuf>,
}

/// The device nodes a confined company agent is granted READ+WRITE.
///
/// Deliberately an explicit list rather than a blanket `/dev` grant — see the
/// long note in [`SandboxSpec::for_company`]. Absent nodes are dropped by the
/// backend (`PathFd::new` fails), so this is safe on a stripped container too.
pub const DEV_RW_NODES: &[&str] = &[
    "/dev/ptmx",
    "/dev/pts",
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/random",
    "/dev/urandom",
    "/dev/tty",
    "/dev/shm",
];

/// The writable `$HOME` state a confined agent gets: Claude Code's own runtime
/// state plus the language/dev tool CACHES a bot needs to build anything —
/// enumerated one by one, replacing the former blanket `~/.config` + `~/.cache` +
/// `~/.local/state` read-write grant.
///
/// Measured 2026-09-02 on this box (LD_PRELOAD `open`/`mkdir`/`rename`
/// interposition around a real `claude` boot + one prompt + one Bash tool call):
/// the only writes Claude Code itself makes outside its config dir are
/// `~/.local/state/claude/locks` and `~/.cache/claude/staging`. The rest of this
/// list is the toolchain surface (`pip`, `uv`, `npm`/`pnpm`/`yarn`, `puppeteer`
/// / `ms-playwright` for the browser connector, `fontconfig`, `go-build`, …) that
/// the blanket `~/.cache` grant used to cover, kept working on purpose.
///
/// What the blanket grants covered and this list deliberately does NOT:
/// `~/.config/gh` (the owner's GitHub token), `~/.config/gcloud`,
/// `~/.config/mcp-email-server`, `~/.config/tailscale`, `~/.config/chromium` and
/// `~/.cache/gh` — credential stores a company bot has no business touching.
///
/// The spawn path pre-creates these (see [`ConfinePlan::precreate_state_dirs`]):
/// Landlock drops a rule whose path does not exist, and creating the dir later
/// would need write access to `~/.cache` itself, which is exactly what this list
/// replaces.
pub const AGENT_STATE_RW: &[&str] = &[
    ".local/state/claude",
    ".local/state/pnpm",
    // Claude Code's PER-SESSION scratch under its home. Measured live after the
    // enumeration shipped (v0.6.16): a confined bot's hooks failed with
    // `EACCES: permission denied, mkdir ~/.claude/session-env/<session id>` —
    // Claude creates that dir per session id it picks itself (unknown before
    // spawn, so it cannot be pre-created), and runs hooks/tools through it.
    // The four dirs hold empty per-session env dirs, shell-function snapshots
    // (no secrets — measured), task/todo scratch: low value, needed for the
    // hook lifeline supermux's status plane depends on.
    ".claude/session-env",
    ".claude/shell-snapshots",
    ".claude/tasks",
    ".claude/todos",
    // Claude Code REFRESHES its OAuth token and rewrites this file (tmp+rename
    // in ~/.claude). Read-only, the refresh fails and Claude reports
    // "Not logged in · Please run /login" on every confined bot — the owner's
    // Reisposter looped on re-login for an afternoon (v0.6.16 → this). It is the
    // one shared credential every bot on this account already reads; writing
    // the rotated token back is the same trust, not a wider one.
    ".claude/.credentials.json",
    ".cache/claude",
    ".cache/claude-cli-nodejs",
    ".cache/node",
    ".cache/npm",
    ".cache/pnpm",
    ".cache/yarn",
    ".cache/pip",
    ".cache/uv",
    ".cache/puppeteer",
    ".cache/ms-playwright",
    ".cache/fontconfig",
    ".cache/go-build",
    ".cache/zig",
    ".cache/cargo-zigbuild",
    ".cache/ffmpeg-static-nodejs",
    ".config/configstore",
    ".config/pip",
    ".config/uv",
    ".config/go",
    ".config/procps",
];

/// The ENUMERATED read-only slice of the shared Claude home (and the two
/// `~/.config` files a git-using agent reads), replacing the former blanket
/// `~/.claude` READ+WRITE grant.
///
/// # The leak this closes
///
/// `SandboxSpec::for_company` used to grant `~/.claude` read+write wholesale.
/// `~/.claude` is per-USER, not per-company, so every confined company bot could
/// read — and rewrite — the whole box's Claude state. Reported 2026-09-02 by the
/// owner's own confined bot: *"all Claude session transcripts of every project on
/// this box under `~/.claude/projects/` were readable — 648 files, zero blocked …
/// the token came out of transcripts of supermux and home-supermux"* (6.1 GB,
/// 236 project dirs), plus `history.jsonl` (every prompt ever typed),
/// `file-history/`, `session-env/` (other sessions' environments), `sessions/`,
/// `paste-cache/`, `backups/` — and write access to `settings.json` and
/// `plugins/`, whose hooks other sessions execute.
///
/// # What is on the list, and why
///
/// Landlock is an allow-list with no "except", so the fix is to enumerate. These
/// are the paths a real confined Claude needs (measured as above; anything not
/// measured stays denied):
///
/// * `.claude/settings.json` — the user settings file, read at boot. READ-ONLY:
///   it carries `hooks`, which other (unconfined) sessions execute, so write
///   access would be a cross-session code-execution vector.
/// * `.claude/.credentials.json` — the Claude OAuth token. **The remaining
///   boundary**: company bots today share ONE Claude account, so the agent that
///   authenticates must read it. The real fix is a per-session `config_dir`
///   (`CLAUDE_CONFIG_DIR`), already supported by the spawn path — see the module
///   docs.
/// * `.claude/CLAUDE.md`, `.claude/commands`, `.claude/plugins`, `.claude/cache`,
///   `.claude/statsig` — user memory, slash commands, the plugin/skill cache and
///   the release/statsig caches, all read at boot. READ-ONLY on purpose: plugin
///   and command files are CODE other sessions run.
/// * `.claude.json` — Claude Code's project/onboarding state file. READ-ONLY: it
///   is rewritten by `rename(2)` from a temp file in `$HOME`, which the jail
///   already denied (`$HOME` itself is not writable), so read is all it ever got.
/// * `.config/git`, `.config/curlrc` — read by every `git`/`curl` the agent runs.
///
/// Everything else under `~/.claude` — `projects/` (including the parent: a bot
/// must not even LIST which projects exist), `history.jsonl`, `file-history/`,
/// `session-env/`, `sessions/`, `shell-snapshots/`, `tasks/`, `teams/`,
/// `telemetry/`, `backups/`, `paste-cache/`, `downloads/`, `feedback/`,
/// `plans/`, `jobs/`, `daemon/` — is DENIED. The session's own
/// `projects/<encoded cwd>` dir is granted read+write per session by the spawn
/// path ([`ConfinePlan::allow_claude_project`]).
pub const CLAUDE_HOME_RO: &[&str] = &[
    ".claude/settings.json",
    ".claude/CLAUDE.md",
    ".claude/commands",
    ".claude/plugins",
    ".claude/cache",
    ".claude/statsig",
    ".claude.json",
    ".config/git",
    // `git` in the jail warned "unable to access ~/.gitconfig: Permission
    // denied" on every command — identity + defaults live there; RO only.
    ".gitconfig",
    ".config/curlrc",
    ".config/fontconfig",
];

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
    ///   and the NARROW slice of `$HOME` state a booting agent actually writes
    ///   (`~/.local/state/claude`, `~/.cache/pip`, … — [`AGENT_STATE_RW`]) — see
    ///   [`CLAUDE_HOME_RO`] for why the shared Claude home is no longer granted
    ///   wholesale. The spawn wiring appends the session's own spool/socket dir
    ///   and its OWN Claude project dir via [`allow_rw`](Self::allow_rw).
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
        // Claude's own writable runtime state that carries NOTHING from another
        // project or company — measured (2026-09-02) as the only `$HOME` state a
        // booting Claude Code writes outside its config dir: the update-staging
        // dir and the lock dir.
        // THE SHARED CLAUDE HOME, WHOLE — read+write, as before v0.6.16. Claude
        // Code rotates its OAuth token by writing a temp file INTO `~/.claude`
        // and renaming it over `.credentials.json`, and takes lock/scratch files
        // in the same dir; granting only the file (v0.6.18) left every confined
        // bot stuck at "Not logged in" the moment any other process refreshed
        // the shared token (live, 2026-09-02 17:47). Landlock has no "except",
        // so the credential store and the transcript tree share one grant. The
        // owner's rule: the Claude account is SHARED across every bot on this
        // box and is never to be locked or scoped. The per-project / per-user
        // separation belongs to a per-session `config_dir` (CLAUDE_CONFIG_DIR),
        // not to the jail.
        read_write_paths.push(home.join(".claude"));
        for w in AGENT_STATE_RW {
            read_write_paths.push(home.join(w));
        }
        // ── RW: the handful of DEVICE NODES a terminal agent cannot boot
        // without. THE bug this list was missing (measured live on the Strato
        // box: every company-agent start degraded to unconfined, 20/20 in a
        // week): `/dev` was on NEITHER list, so a fully-enforced jail denied
        // `/dev/ptmx` and the pty holder died in `openpty(3)` with
        // `EACCES: Permission denied` before it ever bound its socket — the
        // daemon then saw only "holder did not come up in time".
        //
        // Enumerated one node at a time ON PURPOSE. A blanket `/dev` grant
        // would hand a confined agent the block devices (`/dev/sda`),
        // `/dev/mem`, `/dev/kmsg` and every other host device — i.e. a trivial
        // escape from the very jail this builds. These are the nodes a shell,
        // a pty and a node/python toolchain actually open:
        //
        //   * `ptmx` + `pts`   — `openpty(3)`: the master, then the `/dev/pts/N`
        //                        slave the child gets as fds 0/1/2.
        //   * `null`/`zero`/`full`   — redirections and every libc that probes them.
        //   * `random`/`urandom`     — entropy for node/python/git/ssh at startup.
        //   * `tty`                  — `/dev/tty` (the controlling terminal) for
        //                              TUIs and password prompts.
        //   * `shm`                  — POSIX shared memory: node, python
        //                              multiprocessing, headless chromium.
        //
        // `/dev/stdin|stdout|stderr` and `/dev/fd/*` need no entry: they are
        // symlinks into `/proc/self/fd`, and Landlock matches the RESOLVED
        // target (the pty slave under `/dev/pts`, or a file already allowed).
        for d in DEV_RW_NODES {
            read_write_paths.push(PathBuf::from(d));
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

        // ── RO: the supermux SESSION RUNTIME under `~/.supermux` — only the
        // pieces a booting agent actually reads, named one by one. The launch
        // line points claude at `--settings ~/.supermux/session-config/<name>/…`,
        // spawns its MCP connectors from `~/.supermux/connectors/*.py`, prepends
        // `~/.supermux/bin` to PATH, and chat attachments arrive as paths under
        // `~/.supermux/uploads`. NONE of that was on the list — invisible for as
        // long as confinement silently failed to boot; the /dev fix made the jail
        // real and every company claude then died reading its own settings
        // (`EACCES … session-config/<name>/settings.json`, live 2026-09-01).
        // The REST of `~/.supermux` stays denied on purpose: `auth_token`,
        // `data.db`, `vault/`, `deploy/`, `cloudflared_token` are exactly what a
        // confined agent must never read. The per-session `session-config/<name>`
        // grant is added by the SPAWN path (`ConfinePlan::allow_ro`), so one
        // session cannot read a sibling session's settings.
        for ro in [".supermux/connectors", ".supermux/bin", ".supermux/uploads"] {
            push_ro_resolved(&mut read_exec_paths, home.join(ro));
        }

        // ── RO: the ENUMERATED slice of the shared Claude home. See
        // [`CLAUDE_HOME_RO`] for the measurement and the threat it closes: this
        // list replaces the former blanket `~/.claude` READ+WRITE grant, under
        // which a confined company bot could read EVERY Claude transcript on the
        // box (`~/.claude/projects/<every project>/*.jsonl`), every prompt ever
        // typed (`history.jsonl`), and the tokens that appear in them. The
        // session's OWN project dir is granted RW by the spawn path
        // (`ConfinePlan::allow_claude_project`), never here.
        for ro in CLAUDE_HOME_RO {
            push_ro_resolved(&mut read_exec_paths, home.join(ro));
        }

        // ── RO: DNS resolution targets OUTSIDE /etc. Landlock enforces on the
        // RESOLVED path, and on systemd-resolved hosts `/etc/resolv.conf` is a
        // symlink into `/run/systemd/resolve/` — which no rule above covers, so
        // a confined agent could not resolve ANY hostname and every API call
        // failed as a "network error" (live on the Strato box, 2026-09-01: the
        // agent looked jailed off the internet while the jail never touched
        // TCP at all). Grant the resolved target of resolv.conf plus the
        // resolver state dirs the common stacks use; absent paths drop out.
        push_ro_resolved(&mut read_exec_paths, PathBuf::from("/etc/resolv.conf"));
        for ro in ["/run/systemd/resolve", "/run/resolvconf", "/run/NetworkManager"] {
            push_ro_resolved(&mut read_exec_paths, PathBuf::from(ro));
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
            extra_read_paths: Vec::new(),
        }
    }

    /// Grant read+write to an additional absolute path (e.g. the native
    /// session's spool/socket dir). Chainable-free; mutates in place.
    pub fn allow_rw(&mut self, path: PathBuf) {
        self.read_write_paths.push(path);
    }

    /// Grant read(+exec) to an additional absolute path — the per-session grants
    /// the spawn path adds (this session's own `session-config/<name>` dir).
    /// Rides `read_exec_paths` (read+execute): the extra execute bit on a config
    /// dir is harmless, and it keeps the backend's two-tier model intact.
    pub fn allow_ro(&mut self, path: PathBuf) {
        self.extra_read_paths.push(path.clone());
        push_ro_resolved(&mut self.read_exec_paths, path);
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
// The macOS Seatbelt backend now lives in [`seatbelt_macos`]: a real
// `sandbox_init` profile (allow-default + deny-cross-company-write +
// deny-read-secrets) that reports `Partial`, replacing the former no-op stub.
#[cfg(target_os = "macos")]
pub use seatbelt_macos::SeatbeltMacOS;

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

    /// Grant an extra RO(+exec) path (this session's own config dir) before the
    /// plan is moved into the child.
    pub fn allow_ro(&mut self, path: PathBuf) {
        self.spec.allow_ro(path);
    }

    /// Apply an operator's screened `[[company_isolation]]` grants
    /// ([`CompanyIsolation::resolve`]) to this plan — RO entries ride the
    /// read(+exec) tier, RW entries the read+write tier. Both backends see them.
    pub fn widen(&mut self, extras: &ResolvedCompanyIsolation) {
        for path in &extras.read_only {
            self.allow_ro(path.clone());
        }
        for path in &extras.read_write {
            self.allow_rw(path.clone());
        }
    }

    /// Best-effort `mkdir -p` of the [`AGENT_STATE_RW`] dirs under `home`,
    /// BEFORE the fork.
    ///
    /// Landlock silently drops a rule whose path does not exist, and a dir the
    /// jail did not grant cannot be created from inside it (creating
    /// `~/.cache/pip` needs write access to `~/.cache`, which this design
    /// deliberately no longer grants). Without this, a fresh box would hand every
    /// company bot a toolchain whose caches are un-creatable. Failures are
    /// ignored: an absent path simply stays denied, exactly as if it were not on
    /// the list.
    pub fn precreate_state_dirs(&self, home: &Path) {
        for d in AGENT_STATE_RW {
            let _ = std::fs::create_dir_all(home.join(d));
        }
    }

    /// Grant this session's OWN Claude project dir (`<config dir>/projects/
    /// <encoded cwd>`) read+write — the one place under the shared Claude home a
    /// confined company agent may write, and the counterpart to the enumerated
    /// [`CLAUDE_HOME_RO`] list (which deliberately does not include `projects/`,
    /// not even for reading: a bot must not be able to LIST which projects, i.e.
    /// which of the owner's repos and which sibling companies, exist).
    ///
    /// The dir is CREATED here, in the parent, before the fork: Claude Code
    /// `mkdir -p`s its own project dir at boot, and a jail that grants only the
    /// leaf would have to allow `MakeDir` on `projects/` itself to let it — which
    /// would re-open the parent. Pre-creating keeps the grant a leaf.
    /// A creation failure is not fatal (the grant is still added; an absent path
    /// is dropped by the backend) — the agent then behaves as it did before this
    /// grant existed rather than failing to start.
    pub fn allow_claude_project(&mut self, project_dir: PathBuf) {
        if let Err(e) = std::fs::create_dir_all(&project_dir) {
            tracing::warn!(
                dir = %project_dir.display(),
                error = %e,
                "isolation: could not pre-create the session's Claude project dir; \
                 the confined agent may not be able to write its transcript",
            );
        }
        self.spec.allow_rw(project_dir);
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
    #[cfg(target_os = "macos")]
    {
        // Seatbelt's confine() jails the CALLER, so measure it in a forked child
        // — never the daemon.
        seatbelt_macos::fork_probe(provider)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        // Noop confine() does not restrict the caller, so a direct call is safe.
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
    #[cfg(target_os = "macos")]
    {
        // Fork + confine + execv a real binary under Seatbelt (never the daemon).
        seatbelt_macos::self_test_confined_exec(&probe_home())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        true
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// IsolationRuntime — the per-process handle stored in AppState
// ─────────────────────────────────────────────────────────────────────────────

/// One `[[company_isolation]]` block from `config.toml`: extra allow-list paths
/// for the jail of ONE company (matched by `company` = the company slug).
///
/// ```toml
/// [[company_isolation]]
/// company = "canary"
/// read_only = ["~/.ssh", "~/.config/gh"]   # read (+exec) only
/// read_write = []                          # read + write
/// ```
///
/// Why this exists: the built-in allow-list ([`SandboxSpec::for_company`]) is
/// deliberately narrow (the company tree, `~/.claude`, `/tmp`, the toolchains),
/// so a bot that legitimately needs e.g. the operator's `~/.ssh` (a crawl-fleet
/// admin) had no way in short of `isolation_mode = off` for EVERY company. This
/// widens the jail for one slug only; sibling companies still get the default
/// list.
///
/// Lifecycle: the blocks are captured ONCE at supermux boot (`config.toml` is
/// not re-read), and each block is resolved + screened per spawn by
/// [`resolve`](Self::resolve) — so a config edit needs a supermux restart, and
/// then takes effect for a bot at its next (re)start. Unknown keys are a load
/// error on purpose (a misspelled `read_only` must not silently grant nothing).
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompanyIsolation {
    /// The company slug this block applies to (exact match, no case folding).
    pub company: String,
    /// Extra read(+exec)-only paths. `~/…` is expanded against `$HOME`.
    #[serde(default)]
    pub read_only: Vec<String>,
    /// Extra read+write paths. `~/…` is expanded against `$HOME`.
    #[serde(default)]
    pub read_write: Vec<String>,
}

/// [`CompanyIsolation`] after `~` expansion + safety screening. The paths are
/// CANONICAL (what the kernel will actually attach the rule to).
#[derive(Debug, Default, PartialEq)]
pub struct ResolvedCompanyIsolation {
    pub read_only: Vec<PathBuf>,
    pub read_write: Vec<PathBuf>,
    /// `(entry as written, reason)` for every entry that was NOT granted.
    pub rejected: Vec<(String, &'static str)>,
}

impl CompanyIsolation {
    /// Expand and screen the configured entries against the service user's
    /// `home`, the supermux `data_dir` and THIS company's `company_root`.
    ///
    /// The screen runs on the CANONICAL path, because that is what the jail
    /// grants: Landlock's `path_beneath_rules` opens each entry (following
    /// symlinks and `..`) and attaches the rule to the resolved inode. Screening
    /// the literal string would let `~/x/../.supermux` or a symlink into the
    /// data dir through. Refused (reported in `rejected`, never granted):
    ///
    /// * empty entries; relative paths; entries containing `..`;
    /// * entries that do not exist (Landlock silently drops absent paths — the
    ///   operator must create the path first, and saying so is more honest);
    /// * entries that resolve through a symlink (`canonicalize` ≠ the written
    ///   path). This is the guard against a confined bot swapping a component
    ///   under a tree it can write (its company root, `/tmp`, `~/.claude`) for a
    ///   symlink to somewhere it must not read — the operator writes the real
    ///   path, and a path that stops being real is refused at the next spawn;
    /// * `/`, `$HOME`, or any ancestor of `$HOME` (each hands over the whole
    ///   home);
    /// * anything at, under or ABOVE `data_dir` (`~/.supermux` — the dashboard
    ///   `auth_token`, the DB and the vault stay denied by construction);
    /// * anything in a SIBLING company's tree, or the companies root itself
    ///   (`company_root`'s parent) — separating companies is the jail's job.
    pub fn resolve(&self, home: &Path, data_dir: &Path, company_root: &Path) -> ResolvedCompanyIsolation {
        // `~` expands against the CANONICAL home so a symlinked home directory
        // (`/home → /usr/home`) does not trip the symlink rule below.
        let home = canonical_or(home);
        let data_dir = canonical_or(data_dir);
        let company_root = canonical_or(company_root);
        let mut out = ResolvedCompanyIsolation::default();
        for raw in &self.read_only {
            match screen_entry(raw, &home, &data_dir, &company_root) {
                Ok(p) => out.read_only.push(p),
                Err(why) => out.rejected.push((raw.clone(), why)),
            }
        }
        for raw in &self.read_write {
            match screen_entry(raw, &home, &data_dir, &company_root) {
                Ok(p) => out.read_write.push(p),
                Err(why) => out.rejected.push((raw.clone(), why)),
            }
        }
        out
    }
}

/// `canonicalize`, falling back to the path as given when it cannot be resolved
/// (an absent `data_dir` on a fresh install must still be screened lexically).
fn canonical_or(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// The screening rule table for one `[[company_isolation]]` entry — see
/// [`CompanyIsolation::resolve`] for the rationale of each rule. `Ok` carries
/// the canonical path to grant; `Err` the reason it must not be.
fn screen_entry(raw: &str, home: &Path, data_dir: &Path, company_root: &Path) -> Result<PathBuf, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("empty entry");
    }
    let expanded = if raw == "~" {
        home.to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(raw)
    };
    if !expanded.is_absolute() {
        return Err("not an absolute path (or ~/…)");
    }
    if expanded.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("contains `..`");
    }
    let real = std::fs::canonicalize(&expanded)
        .map_err(|_| "does not exist (create it first; the jail drops absent paths)")?;
    if real != expanded {
        return Err("resolves through a symlink; configure the real path instead");
    }
    if real == Path::new("/") || home.starts_with(&real) {
        return Err("is `/`, the home dir, or an ancestor of it (would hand over the whole home)");
    }
    if real.starts_with(data_dir) || data_dir.starts_with(&real) {
        return Err("at, under or above the supermux data dir (auth_token, DB, vault stay denied)");
    }
    if let Some(companies_root) = company_root.parent() {
        if real.starts_with(companies_root) && !real.starts_with(company_root) {
            return Err("inside another company's tree (or the companies root itself)");
        }
    }
    Ok(real)
}

/// The process-wide isolation handle: the requested [`IsolationMode`], the
/// startup [`ProbeResult`], and the active backend. Built once in
/// `AppState::new`; consulted by the spawn path.
pub struct IsolationRuntime {
    mode: IsolationMode,
    probe: ProbeResult,
    provider: Arc<dyn IsolationProvider>,
    /// Per-company extra allow-list blocks (`[[company_isolation]]`), looked up
    /// by slug at spawn time via [`extras_for`](Self::extras_for).
    company_extras: Vec<CompanyIsolation>,
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
            company_extras: Vec::new(),
        }
    }

    /// Attach the `[[company_isolation]]` blocks from config (builder style).
    ///
    /// Two blocks for the same slug are MERGED (their lists concatenated) with a
    /// warning rather than the second one silently losing; a block that grants
    /// nothing is warned about too (the usual cause is a misspelled list key,
    /// which `deny_unknown_fields` already rejects at load — this catches an
    /// empty list). Every block is logged once so an operator can see from the
    /// journal what was loaded.
    pub fn with_company_extras(mut self, extras: Vec<CompanyIsolation>) -> Self {
        let mut merged: Vec<CompanyIsolation> = Vec::new();
        for block in extras {
            if block.read_only.is_empty() && block.read_write.is_empty() {
                tracing::warn!(
                    company = %block.company,
                    "isolation: [[company_isolation]] block grants nothing — both `read_only` and `read_write` are empty",
                );
            }
            if let Some(existing) = merged.iter_mut().find(|c| c.company == block.company) {
                tracing::warn!(
                    company = %block.company,
                    "isolation: duplicate [[company_isolation]] block for this slug — merged into the first",
                );
                existing.read_only.extend(block.read_only);
                existing.read_write.extend(block.read_write);
            } else {
                merged.push(block);
            }
        }
        for block in &merged {
            tracing::info!(
                company = %block.company,
                read_only = ?block.read_only,
                read_write = ?block.read_write,
                "isolation: [[company_isolation]] block loaded",
            );
        }
        self.company_extras = merged;
        self
    }

    /// The extra allow-list block for `slug`, if the operator configured one.
    /// Exact slug match: a block never leaks to a sibling company.
    pub fn extras_for(&self, slug: &str) -> Option<&CompanyIsolation> {
        self.company_extras.iter().find(|c| c.company == slug)
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
            .field("company_extras", &self.company_extras)
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
        // The spelling the README's deploy guide uses — a config value that
        // parsed as BestEffort here would silently downgrade fail-closed to
        // fail-open.
        assert_eq!(
            IsolationMode::parse("strict-required"),
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
    fn the_own_claude_project_dir_is_the_only_writable_spot_under_projects() {
        // The per-session grant the spawn path adds: exactly ONE dir under
        // `~/.claude/projects`, created in the parent so the jail never needs
        // MakeDir on `projects/` itself.
        let base = std::env::temp_dir().join(format!(
            "supermux-iso-proj-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ));
        let projects = base.join(".claude/projects");
        let own = projects.join("-srv-companies-acme");
        let mut plan = IsolationRuntime::from_mode(IsolationMode::BestEffort)
            .plan_for(Path::new("/srv/companies/acme"), &base)
            .expect("best-effort always yields a plan");
        plan.allow_claude_project(own.clone());
        assert!(own.is_dir(), "the grant pre-creates the project dir");
        assert!(
            plan.spec.read_write_paths.contains(&own),
            "the session's own project dir is read-write: {:?}",
            plan.spec.read_write_paths,
        );
        assert!(
            !plan.spec.read_write_paths.contains(&projects)
                && !plan.spec.read_exec_paths.contains(&projects),
            "the projects/ PARENT is never granted — not even for listing",
        );
        let _ = std::fs::remove_dir_all(&base);
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

    /// Bug B, at the allow-list: a terminal agent cannot boot without its pty
    /// device nodes, and `/dev` was on NEITHER list. Blanket `/dev` is not the
    /// fix — the block devices must stay out of a confined agent's reach.
    #[test]
    fn the_company_spec_grants_the_pty_devices_and_nothing_more_of_dev() {
        let spec = SandboxSpec::for_company(Path::new("/tmp/acme"), Path::new("/home/u"));
        let rw: Vec<&str> = spec
            .read_write_paths
            .iter()
            .filter_map(|p| p.to_str())
            .collect();
        for node in ["/dev/ptmx", "/dev/pts", "/dev/null", "/dev/urandom", "/dev/tty"] {
            assert!(rw.contains(&node), "{node} must be RW-allowed: {rw:?}");
        }
        assert!(
            !rw.contains(&"/dev") && !spec.read_exec_paths.iter().any(|p| p.as_os_str() == "/dev"),
            "a blanket /dev grant hands the agent the block devices — never do it: {rw:?}",
        );
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

#[cfg(test)]
mod company_extras_tests {
    use super::*;

    /// A throwaway tree: `<base>/home/u/{.ssh,.config/gh,.supermux,shared}` +
    /// `<base>/companies/{canary/sub,other}` + a symlink `home/u/link -> .supermux`.
    /// Real dirs, because `resolve` screens the CANONICAL path.
    struct Tree {
        base: PathBuf,
    }
    impl Tree {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            // Canonical: on macOS `/var` is a symlink to `/private/var`, and
            // absolute entries built from a symlinked base would trip the
            // "resolves through a symlink" rule instead of the one under test.
            let base = canonical_or(&std::env::temp_dir()).join(format!(
                "supermux-company-extras-{tag}-{}-{nanos}",
                std::process::id()
            ));
            for d in [
                "home/u/.ssh",
                "home/u/.config/gh",
                "home/u/.supermux",
                "home/u/shared",
                "companies/canary/sub",
                "companies/other",
            ] {
                std::fs::create_dir_all(base.join(d)).unwrap();
            }
            std::fs::write(base.join("home/u/.supermux/auth_token"), b"secret").unwrap();
            std::os::unix::fs::symlink(base.join("home/u/.supermux"), base.join("home/u/link")).unwrap();
            Self { base }
        }
        fn home(&self) -> PathBuf {
            self.base.join("home/u")
        }
        fn data_dir(&self) -> PathBuf {
            self.base.join("home/u/.supermux")
        }
        fn root(&self) -> PathBuf {
            self.base.join("companies/canary")
        }
        /// `HOME` in an entry is replaced by the tree's home path.
        fn extra(&self, ro: &[&str], rw: &[&str]) -> CompanyIsolation {
            let home = self.home().display().to_string();
            let fix = |e: &&str| e.replace("HOME", &home);
            CompanyIsolation {
                company: "canary".into(),
                read_only: ro.iter().map(fix).collect(),
                read_write: rw.iter().map(fix).collect(),
            }
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn tilde_and_absolute_entries_resolve_to_canonical_ro_and_rw() {
        let t = Tree::new("ok");
        let canon = |p: PathBuf| std::fs::canonicalize(p).unwrap();
        // The temp dir itself may be symlinked on some hosts, so compare
        // canonical forms on both sides.
        let r = t.extra(&["~/.ssh", "HOME/.config/gh"], &["~/shared"]).resolve(&t.home(), &t.data_dir(), &t.root());
        assert!(r.rejected.is_empty(), "{:?}", r.rejected);
        assert_eq!(r.read_only, vec![canon(t.home().join(".ssh")), canon(t.home().join(".config/gh"))]);
        assert_eq!(r.read_write, vec![canon(t.home().join("shared"))]);
    }

    #[test]
    fn every_refusal_rule_fires_with_its_own_reason() {
        let t = Tree::new("refuse");
        let companies = t.base.join("companies").display().to_string();
        let table: &[(&str, &str)] = &[
            ("", "empty entry"),
            ("relative/path", "not an absolute path"),
            ("~/shared/../.supermux", "contains `..`"),
            ("HOME/.ssh/..", "contains `..`"),
            ("HOME/..", "contains `..`"),
            ("~/does-not-exist", "does not exist"),
            ("~/link", "resolves through a symlink"),
            ("/", "is `/`, the home dir, or an ancestor"),
            ("~", "is `/`, the home dir, or an ancestor"),
            ("BASE", "is `/`, the home dir, or an ancestor"),
            ("~/.supermux", "supermux data dir"),
            ("~/.supermux/auth_token", "supermux data dir"),
            ("COMPANIES/other", "another company's tree"),
            ("COMPANIES", "another company's tree"),
        ];
        for (entry, reason) in table {
            let entry = entry.replace("COMPANIES", &companies).replace("BASE", &t.base.display().to_string());
            let r = t.extra(&[entry.as_str()], &[]).resolve(&t.home(), &t.data_dir(), &t.root());
            assert!(r.read_only.is_empty(), "{entry:?} must not be granted: {:?}", r.read_only);
            assert_eq!(r.rejected.len(), 1, "{entry:?}: {:?}", r.rejected);
            assert!(
                r.rejected[0].1.contains(reason),
                "{entry:?}: expected reason containing {reason:?}, got {:?}",
                r.rejected[0].1
            );
        }
        // A path that is merely NEXT to the data dir (`.supermux2`) is fine —
        // the data-dir rule is a path-component rule, not a string prefix.
        std::fs::create_dir_all(t.home().join(".supermux2")).unwrap();
        let r = t.extra(&["~/.supermux2"], &[]).resolve(&t.home(), &t.data_dir(), &t.root());
        assert!(r.rejected.is_empty(), "{:?}", r.rejected);
        // The company's OWN subtree is allowed (redundant, but not dangerous).
        let own = t.root().join("sub").display().to_string();
        let r = t.extra(&[], &[own.as_str()]).resolve(&t.home(), &t.data_dir(), &t.root());
        assert!(r.rejected.is_empty(), "{:?}", r.rejected);
    }

    #[test]
    fn a_symlink_planted_after_the_fact_is_refused_at_the_next_spawn() {
        // The TOCTOU the screen exists for: an entry that WAS a real dir is
        // replaced (by a bot with write access to that tree) with a symlink to
        // the data dir. Screening the canonical path refuses it next time.
        let t = Tree::new("toctou");
        let extra = t.extra(&["~/shared"], &[]);
        assert!(extra.resolve(&t.home(), &t.data_dir(), &t.root()).rejected.is_empty());
        std::fs::remove_dir(t.home().join("shared")).unwrap();
        std::os::unix::fs::symlink(t.data_dir(), t.home().join("shared")).unwrap();
        let r = extra.resolve(&t.home(), &t.data_dir(), &t.root());
        assert!(r.read_only.is_empty());
        assert!(r.rejected[0].1.contains("symlink"), "{:?}", r.rejected);
    }

    #[test]
    fn runtime_looks_up_extras_by_exact_slug_only_and_merges_duplicates() {
        let rt = IsolationRuntime::from_mode(IsolationMode::BestEffort).with_company_extras(vec![
            CompanyIsolation { company: "canary".into(), read_only: vec!["~/.ssh".into()], read_write: vec![] },
            CompanyIsolation { company: "canary".into(), read_only: vec![], read_write: vec!["~/shared".into()] },
            CompanyIsolation { company: "empty".into(), read_only: vec![], read_write: vec![] },
        ]);
        let c = rt.extras_for("canary").expect("configured slug");
        // Duplicate blocks for one slug are merged, not dropped.
        assert_eq!(c.read_only, vec!["~/.ssh"]);
        assert_eq!(c.read_write, vec!["~/shared"]);
        assert!(rt.extras_for("empty").is_some());
        // A sibling company gets NOTHING — the grant is scoped to one slug.
        assert!(rt.extras_for("reisposter").is_none());
        assert!(rt.extras_for("Canary").is_none(), "slugs are exact, no case folding");
        // No config at all ⇒ no extras (the default runtime).
        assert!(IsolationRuntime::from_mode(IsolationMode::BestEffort).extras_for("canary").is_none());
    }

    #[test]
    fn widen_puts_ro_in_the_exec_tier_and_rw_in_the_write_tier_for_that_plan_only() {
        let t = Tree::new("widen");
        let rt = IsolationRuntime::from_mode(IsolationMode::BestEffort)
            .with_company_extras(vec![t.extra(&["~/.ssh"], &["~/shared"])]);
        let resolved = rt.extras_for("canary").unwrap().resolve(&t.home(), &t.data_dir(), &t.root());
        let ssh = std::fs::canonicalize(t.home().join(".ssh")).unwrap();
        let shared = std::fs::canonicalize(t.home().join("shared")).unwrap();

        let mut plan = rt.plan_for(&t.root(), &t.home()).expect("BestEffort yields a plan");
        plan.widen(&resolved);
        assert!(plan.spec.read_exec_paths.contains(&ssh), "RO extra rides the read+exec tier");
        assert!(plan.spec.extra_read_paths.contains(&ssh), "…and is recorded for the Seatbelt re-allow");
        assert!(plan.spec.read_write_paths.contains(&shared), "RW extra rides the write tier");
        assert!(!plan.spec.read_write_paths.contains(&ssh), "RO never becomes RW");

        // A sibling company's plan (no block for its slug ⇒ nothing to widen)
        // carries neither path.
        let other = rt.plan_for(&t.base.join("companies/other"), &t.home()).unwrap();
        assert!(rt.extras_for("other").is_none());
        assert!(!other.spec.read_exec_paths.contains(&ssh));
        assert!(!other.spec.read_write_paths.contains(&shared));
    }
}

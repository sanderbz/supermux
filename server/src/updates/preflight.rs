//! Preflight: install-mode detection + every reason "Update now" can refuse.
//!
//! The preflight runs every time `/api/version` is fetched (cheap — a handful
//! of `git`/`df`/`which`/`stat` syscalls; no shell-out for the GitHub release,
//! which is cached separately in [`super::release`]). The UI uses
//! `blocked_reasons` to render actionable copy verbatim — the messages here ARE
//! the user-facing strings.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use super::release::LatestRelease;
use super::version::{self, VersionInfo};

/// Where the repo lives. Resolved at runtime via several heuristics so the
/// preflight works whether the binary is launched from the clone (dev) or
/// installed at `/usr/local/bin/supermux-server` (systemd).
fn detect_repo_dir() -> Option<PathBuf> {
    // 1. Explicit override — the operator can set `SUPERMUX_REPO_DIR=/path` in
    //    the unit's `Environment=` line if their layout is non-standard.
    if let Ok(p) = std::env::var("SUPERMUX_REPO_DIR") {
        let pb = PathBuf::from(p);
        if pb.join(".git").exists() {
            return Some(pb);
        }
    }
    // 2. Server-on-self default (production self-host): /opt/projects/supermux.
    //    Documented in `docs/SELF_HOST_DEV.md` and provisioned by deploy.sh.
    let prod = PathBuf::from("/opt/projects/supermux");
    if prod.join(".git").exists() {
        return Some(prod);
    }
    // 3. CWD walks (dev): the binary was launched from the clone.
    if let Ok(cwd) = std::env::current_dir() {
        let mut p = cwd.as_path();
        loop {
            if p.join(".git").exists() {
                return Some(p.to_path_buf());
            }
            match p.parent() {
                Some(parent) => p = parent,
                None => break,
            }
        }
    }
    None
}

/// Which deployment shape this binary is running under. Branches the
/// "Update now" flow: systemd+path-unit gets the 1-click path, everything else
/// gets actionable copy explaining the manual command.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstallMode {
    /// Running under a systemd unit. `path_unit_present` differentiates the
    /// 1-click case (true: `/etc/systemd/system/supermux-deploy.path` exists)
    /// from the "set up by hand" case (false: the operator runs the binary
    /// directly under systemd but never ran `scripts/setup.sh`).
    Systemd { path_unit_present: bool },
    /// Running as a bare binary (no systemd ancestor) — `nohup ./supermux-server`,
    /// a launchd plist on macOS, supervised by something we don't recognise.
    BareBinary,
    /// Dev workflow: `cargo run` / `scripts/dev.sh`.
    Dev,
    /// Inside a Docker container. We don't ship Docker images yet; future scope.
    Docker,
    /// Genuinely could not tell — show the manual fallback instructions.
    Unknown,
}

impl InstallMode {
    /// Sniff the host. Cheap — no shell-out, just a few `stat` calls + env reads.
    pub fn detect() -> Self {
        // Docker beats everything (a containerised systemd-in-docker is still
        // a container; we want the registry-pull path, not the path-unit one).
        if Path::new("/.dockerenv").exists() || std::env::var("DOCKER_CONTAINER").is_ok() {
            return Self::Docker;
        }
        // Dev: cargo sets this when running tests + when launched via `cargo run`.
        if std::env::var("CARGO").is_ok() || std::env::var("CARGO_MANIFEST_DIR").is_ok() {
            return Self::Dev;
        }
        // Systemd: `/run/systemd/system` exists on every systemd host; the
        // `INVOCATION_ID` env var is set inside a unit's process.
        let systemd_host = Path::new("/run/systemd/system").exists();
        let invoked_by_systemd = std::env::var("INVOCATION_ID").is_ok();
        if systemd_host && invoked_by_systemd {
            return Self::Systemd {
                path_unit_present: Path::new("/etc/systemd/system/supermux-deploy.path").exists(),
            };
        }
        // Anything else we can run a single binary on (macOS, BSD, a manually-
        // launched Linux build).
        Self::BareBinary
    }
}

/// One reason the "Update now" button cannot be enabled. Serialised as a tagged
/// JSON union the frontend can `switch` on; each variant also carries a
/// `message` field with the rendered English copy.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlockedReason {
    /// `git status --porcelain` returned a non-empty list. Showing the count is
    /// kinder than "uncommitted changes" alone — it answers "how dirty is dirty".
    UncommittedChanges { count: usize, message: String },
    /// Current branch isn't `main`. The new binary builds from `origin/main`,
    /// so we refuse to clobber a feature branch.
    NotOnMain { current_branch: String, message: String },
    /// Detached HEAD — usually the operator checked out a specific tag to pin
    /// to a known-good version. Updating would un-pin them silently.
    DetachedHead { message: String },
    /// Local commits not on `origin/main`. Updating would `git reset --hard`
    /// them away.
    AheadOfRemote { count: usize, message: String },
    /// A tool the build needs isn't on PATH (cargo / bun / git).
    MissingTool { name: String, message: String },
    /// Less than 2GB free on the repo's filesystem. The release build pulls
    /// several hundred MB of cargo target/, plus the bun install — 2GB is a
    /// conservative floor.
    LowDisk { available_mb: u64, message: String },
    /// The latest-release fetch failed AND no cached value exists. No update
    /// is possible because we don't know what the latest version IS.
    NoLatestRelease { message: String },
    /// We're a systemd install but `supermux-deploy.path` is not installed.
    /// `scripts/setup.sh` provisions it; until then there's no root-side
    /// listener for the marker file the 1-click writer would drop.
    PathUnitMissing { message: String },
    /// We're a bare-binary / dev install — refuse the auto-update and show
    /// the exact command to run by hand.
    ManualUpdateRequired { command: String, message: String },
    /// Docker install — future scope.
    DockerUpdateUnsupported { message: String },
    /// Cannot create the marker file under `<data>/deploy/` (permissions /
    /// missing dir). Rare — the deploy bootstrap creates the dir 0775 owned by
    /// the service user; surfaces if someone hand-deleted it.
    NotPrivilegedToWrite { message: String },
}

/// The aggregate snapshot returned by `/api/version`. Always 200 — a blocked
/// state is information, not an error.
#[derive(Debug, Clone, Serialize)]
pub struct PreflightStatus {
    pub current: VersionInfo,
    pub latest: Option<LatestRelease>,
    pub update_available: bool,
    pub blocked_reasons: Vec<BlockedReason>,
    pub install_mode: InstallMode,
    /// True IFF this binary appears to be running under a self-host clone we
    /// can write to (the dashboard shows the "Updates" section only in that
    /// case; a Docker / unknown install hides it entirely).
    pub manageable: bool,
}

/// Run every preflight check + assemble the snapshot. Accepts a pre-fetched
/// `latest` so the caller controls whether to hit the cache or force-refresh.
pub fn run_preflight(latest: Option<LatestRelease>) -> PreflightStatus {
    let install_mode = InstallMode::detect();
    let current = VersionInfo::current();
    let repo = detect_repo_dir();

    let update_available = version::is_newer(
        current.tag.as_deref(),
        latest.as_ref().map(|r| r.tag.as_str()),
    );

    let mut blocked = Vec::new();

    // No latest = no update path. Surface explicitly so the UI can show a
    // calm "couldn't reach GitHub" footnote vs the optimistic "✓ Up to date".
    if latest.is_none() {
        blocked.push(BlockedReason::NoLatestRelease {
            message:
                "Couldn't reach GitHub to check for updates. The currently running version is shown above."
                    .into(),
        });
    }

    // Install-mode gates. A bare-binary / dev install never gets the 1-click
    // path — we tell the user the exact command instead.
    match &install_mode {
        InstallMode::Systemd { path_unit_present: false } => {
            blocked.push(BlockedReason::PathUnitMissing {
                message:
                    "The deploy path-unit isn't installed. Run `bash scripts/setup.sh` once on the server to enable 1-click updates."
                        .into(),
            });
        }
        InstallMode::BareBinary | InstallMode::Dev => {
            let cmd = if let Some(ref r) = repo {
                format!("cd {} && bash scripts/update.sh", r.display())
            } else {
                "cd <your-supermux-clone> && bash scripts/update.sh".to_string()
            };
            blocked.push(BlockedReason::ManualUpdateRequired {
                command: cmd.clone(),
                message: format!(
                    "Auto-update is only available on systemd installs. Run this on the server to update manually: `{cmd}`"
                ),
            });
        }
        InstallMode::Docker => {
            blocked.push(BlockedReason::DockerUpdateUnsupported {
                message:
                    "supermux is running in a Docker container. Pull the latest image and recreate the container to update."
                        .into(),
            });
        }
        InstallMode::Unknown => {
            blocked.push(BlockedReason::ManualUpdateRequired {
                command: "bash scripts/update.sh".into(),
                message:
                    "Couldn't identify how supermux is installed. Update manually with `bash scripts/update.sh` in the clone."
                        .into(),
            });
        }
        InstallMode::Systemd { path_unit_present: true } => {
            // Eligible — fall through to the git/disk/tool checks.
        }
    }

    // Git-state gates. Only meaningful when we have a repo dir; without one,
    // the install-mode gate above will have already added a manual-update
    // reason — these would be duplicates.
    if let Some(ref repo) = repo {
        if let Some(state) = inspect_git(repo) {
            if state.detached_head {
                blocked.push(BlockedReason::DetachedHead {
                    message:
                        "You're on a detached HEAD — typically a pinned version. Run `git checkout main` in the clone to enable updates."
                            .into(),
                });
            } else if state.branch != "main" {
                blocked.push(BlockedReason::NotOnMain {
                    current_branch: state.branch.clone(),
                    message: format!(
                        "The clone is on `{}`, not `main`. Switch with `git checkout main` in the clone to enable updates.",
                        state.branch
                    ),
                });
            }
            if state.dirty_count > 0 {
                blocked.push(BlockedReason::UncommittedChanges {
                    count: state.dirty_count,
                    message: format!(
                        "The clone has {} uncommitted change{}. Commit or stash them before updating — `git reset --hard` would lose them.",
                        state.dirty_count,
                        if state.dirty_count == 1 { "" } else { "s" }
                    ),
                });
            }
            if state.ahead_count > 0 {
                blocked.push(BlockedReason::AheadOfRemote {
                    count: state.ahead_count,
                    message: format!(
                        "The clone has {} unpushed commit{} ahead of origin. Push or reset before updating — they'd be discarded.",
                        state.ahead_count,
                        if state.ahead_count == 1 { "" } else { "s" }
                    ),
                });
            }
        }
    }

    // Tool gates. Build runs as the service user, so we check the calling
    // process's PATH — close enough on a real self-host (the supermux unit
    // exports the service user's $HOME so `~/.cargo/bin` is in PATH).
    for tool in ["git", "cargo", "bun"] {
        if which::which(tool).is_err() {
            blocked.push(BlockedReason::MissingTool {
                name: tool.into(),
                message: format!(
                    "`{tool}` isn't on PATH. The build runs as the supermux service user — install {tool} for that user."
                ),
            });
        }
    }

    // Disk gate. Repo-dir filesystem; if we have no repo, the data dir is the
    // next best signal (build target/ usually lives in the repo, but we'd
    // rather over-warn than under-warn).
    let probe_dir = repo
        .clone()
        .or_else(|| dirs::home_dir().map(|h| h.join(".supermux")))
        .unwrap_or_else(|| PathBuf::from("/"));
    if let Some(free_mb) = free_megabytes(&probe_dir) {
        if free_mb < 2048 {
            blocked.push(BlockedReason::LowDisk {
                available_mb: free_mb,
                message: format!(
                    "Only {free_mb} MB free on {}. The release build needs ~2 GB; free up space before updating.",
                    probe_dir.display()
                ),
            });
        }
    }

    // Marker-dir writability gate (systemd-with-path-unit only — the other
    // modes have their own user-facing message already).
    if matches!(install_mode, InstallMode::Systemd { path_unit_present: true }) {
        let data_dir = std::env::var("SUPERMUX_DATA_DIR")
            .ok()
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".supermux")));
        if let Some(data) = data_dir {
            let req_dir = data.join("deploy");
            if !req_dir.exists() || std::fs::metadata(&req_dir).map(|m| m.permissions().readonly()).unwrap_or(true) {
                if !writable_dir(&req_dir) {
                    blocked.push(BlockedReason::NotPrivilegedToWrite {
                        message: format!(
                            "Can't write a deploy request to {}. Re-run `bash scripts/setup.sh` to recreate it with the right ownership.",
                            req_dir.display()
                        ),
                    });
                }
            }
        }
    }

    let manageable = matches!(
        install_mode,
        InstallMode::Systemd { .. } | InstallMode::BareBinary | InstallMode::Dev
    );

    PreflightStatus {
        current,
        latest,
        update_available,
        blocked_reasons: blocked,
        install_mode,
        manageable,
    }
}

/// Probe whether `dir` is writable: try to create it and a temp marker. Cheap
/// and side-effect-clean (we remove the marker immediately).
fn writable_dir(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(format!(".supermux-preflight-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Free megabytes on the filesystem hosting `path`. `None` when we can't query
/// (the host is exotic — the UI will simply skip the disk gate).
fn free_megabytes(path: &Path) -> Option<u64> {
    // We avoid pulling a new statvfs crate by shelling out to `df` — it's on
    // every Unix box supermux runs on. `df -Pk <path>` outputs a header line
    // and one data row; the 4th column is "Available" in 1K blocks.
    let out = Command::new("df").args(["-Pk", "."]).current_dir(path).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    lines.next()?; // header
    let row = lines.next()?;
    let cols: Vec<&str> = row.split_whitespace().collect();
    if cols.len() < 4 {
        return None;
    }
    let kb: u64 = cols[3].parse().ok()?;
    Some(kb / 1024)
}

/// A snapshot of the repo's git state we care about for the preflight.
struct GitSnapshot {
    branch: String,
    detached_head: bool,
    dirty_count: usize,
    ahead_count: usize,
}

/// `None` if `git` itself failed (no PATH, no `.git`); the caller treats that
/// as "no git info" and skips the per-state gates rather than blocking.
fn inspect_git(repo: &Path) -> Option<GitSnapshot> {
    // Branch name; `HEAD` literally for a detached HEAD.
    let branch_out = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(repo)
        .output()
        .ok()?;
    if !branch_out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&branch_out.stdout).trim().to_string();
    let detached_head = branch == "HEAD";

    let status_out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo)
        .output()
        .ok()?;
    let dirty_count = if status_out.status.success() {
        String::from_utf8_lossy(&status_out.stdout).lines().count()
    } else {
        0
    };

    // Ahead count vs origin/main. We do NOT fetch — that would burst out to
    // GitHub on every poll. Stale "ahead" is fine here; it's the local-only
    // commits we care about, and those don't need a fetch to detect.
    let ahead_count = Command::new("git")
        .args(["rev-list", "--count", "origin/main..HEAD"])
        .current_dir(repo)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<usize>()
                .ok()
        })
        .unwrap_or(0);

    Some(GitSnapshot {
        branch,
        detached_head,
        dirty_count,
        ahead_count,
    })
}

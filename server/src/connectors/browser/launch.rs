//! Chrome launch + **leak-safe** process ownership.
//!
//! This is the half of the browser connector that owns an OS process, so it is
//! written defensively: every path that can leave a `chrome-headless-shell`
//! behind has an explicit owner.
//!
//! # The launch recipe (spiked 2026-08-24, shared-browser v1 §2.3 R0/R0.1)
//!
//! ```text
//! LD_LIBRARY_PATH=<chromelibs> <chromium> \
//!   --headless=new \
//!   --user-agent=<the binary's own UA, see BrowserIdentity> \
//!   --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 \
//!   --no-sandbox --no-zygote --disable-gpu --disable-dev-shm-usage \
//!   --user-data-dir=<profile> --window-size=1366,900 about:blank
//! ```
//!
//! * **`--headless=new` is now the TARGET, not the forbidden flag.** The old
//!   "never `--headless=new`" rule was **shell-specific**: it is true, and stays
//!   true, for `chrome-headless-shell`, which is already headless and crashes on
//!   the flag. The shared-browser workspace runs **full Chromium**, where
//!   `--headless=new` is the supported mode and the same real-Chrome codebase
//!   (Chrome 112 unified headless and headful; the old implementation is what
//!   became `chrome-headless-shell`). The swap is config-only via
//!   [`ENV_CHROME_BIN`] — the shell can still be pinned back for a scratch-only
//!   install, and the flag list is the only thing that changes.
//! * **Why full Chromium at all.** A human signs in to real apps in this browser.
//!   The shell announces `HeadlessChrome` in its **UA Client Hints brand list**
//!   (a surface `--user-agent=` cannot touch), has `window.chrome === undefined`
//!   and `navigator.plugins.length === 0` — the three oldest headless tells, all
//!   read by ordinary login pages. Full Chromium passes all three unpatched.
//! * **The UA is the binary's own, honestly.** [`BrowserIdentity`] reads the
//!   version from the binary itself (`<chrome> --version`, once per process)
//!   and the platform from the host this server runs on, so the UA string and
//!   the UA Client Hints always name the Chromium that is really running, on
//!   the OS it is really running on. The only edit to the native UA is the
//!   `HeadlessChrome` token, which becomes `Chrome`; there is no platform or
//!   brand spoof (no "Google Chrome" brand on a Chromium build, no Linux UA on
//!   a Mac). If the version cannot be read, no UA is forced at all and the
//!   binary's native UA stands.
//! * `--remote-debugging-port=0` lets the kernel pick a free port and Chrome
//!   writes it to `<user-data-dir>/DevToolsActivePort`. That is race-free,
//!   unlike "bind :0, read the port, drop the listener, hand it to Chrome".
//!   The browser-level WebSocket URL is then read from `GET /json/version`.
//! * The debugging port is bound to `127.0.0.1` and is a full RCE surface —
//!   it is NEVER exposed; the Rust server terminates the CDP socket itself.
//!
//! # Leak safety
//!
//! 1. The child is spawned into **its own process group** (`process_group(0)`),
//!    so one `kill(-pgid)` reaps the browser process *and* its renderer / gpu /
//!    utility children in one syscall. Chrome's children do not share our group.
//! 2. [`ChromeProcess::kill_now`] escalates `SIGTERM` → `SIGKILL` on the group
//!    and then reaps the child so no zombie is left.
//! 3. [`ChromeProcess`] implements [`Drop`]: a panic, an early `?`, or a dropped
//!    test still kills the group and removes the `--user-data-dir`. Drop is the
//!    backstop, not the plan — the plan is [`ChromeProcess::shutdown`].
//! 4. An [`ProfileMode::Ephemeral`] `--user-data-dir` is created by us under
//!    `std::env::temp_dir()` and removed on every teardown path. A
//!    [`ProfileMode::Durable`] one is the workspace's **cookie jar** and is
//!    deliberately NOT removed — see [`ChromeProcess::remove_profile`]. Process
//!    leak-safety (1-3) is identical in both modes; only the rmdir differs.
//! 5. A durable profile is single-writer: [`ProfileLock`] takes an exclusive
//!    `owner.lock` beside it, because two supermux instances on one
//!    `--user-data-dir` is profile corruption (v1 spec §8.6).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::process::{Child, Command};
use tokio::time::sleep;
use tracing::{debug, info, warn};

use super::error::{BrowserError, Result};

/// Environment override for the chrome binary (absolute path).
pub const ENV_CHROME_BIN: &str = "SUPERMUX_CHROME_BIN";
/// Environment override for the `LD_LIBRARY_PATH` chrome is launched with.
pub const ENV_CHROME_LD_PATH: &str = "SUPERMUX_CHROME_LD_LIBRARY_PATH";

/// Default location of the pinned **full Chromium** build (Playwright's cache).
/// Relative to `$HOME`; resolved by [`default_executable`].
///
/// Changed from `chrome-headless-shell` in shared-browser v1 (§2.3 R0): the shell
/// cannot credibly complete a human sign-in. Both binaries are present in the
/// cache, so pinning the shell back is a one-env-var rollback.
const DEFAULT_CHROME_REL: &str = ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome";

/// What the browser honestly is: the binary's own version and this host's OS.
///
/// Read once per process ([`ensure_identity`]) and then used for both the
/// launch `--user-agent` and every `Emulation.setUserAgentOverride`, so the UA
/// string and the UA Client Hints can never disagree with each other or with
/// the binary. Replaces the old constants pinned to one Linux build (Chrome
/// 149), which on the Mac mini announced "X11; Linux, Chrome 149" next to
/// native hints saying "Chromium 159, macOS".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserIdentity {
    /// Chromium major, e.g. `159`.
    pub major: u32,
    /// Full version as the binary reports it, e.g. `159.0.8154.6`.
    pub full: String,
    /// The OS this server (and so the browser) runs on.
    pub os: HostOs,
    /// The OS version for `Sec-CH-UA-Platform-Version` (macOS: `sw_vers`; empty on Linux).
    pub os_version: String,
}

/// The host OS, as the UA and the client hints name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    Mac,
    Linux,
}

impl HostOs {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            HostOs::Mac
        } else {
            HostOs::Linux
        }
    }
}

/// `Sec-CH-UA-Arch` for this build of the server (the browser runs on the same machine).
fn host_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm"
    } else {
        "x86"
    }
}

impl BrowserIdentity {
    /// The desktop UA: Chrome's own reduced form for this platform and major.
    /// Every real Chrome on macOS sends the frozen `Intel Mac OS X 10_15_7`,
    /// on Apple silicon too, so that token is the honest one.
    pub fn user_agent(&self) -> String {
        let platform = match self.os {
            HostOs::Mac => "Macintosh; Intel Mac OS X 10_15_7",
            HostOs::Linux if cfg!(target_arch = "aarch64") => "X11; Linux aarch64",
            HostOs::Linux => "X11; Linux x86_64",
        };
        format!(
            "Mozilla/5.0 ({platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{}.0.0.0 Safari/537.36",
            self.major
        )
    }

    /// The UA applied when a viewer negotiates a PHONE viewport, so UA-sniffing
    /// sites serve their mobile layout (device metrics alone only flip the
    /// viewport meta and touch). Device emulation, as DevTools does it; the
    /// Chromium major is still the binary's own.
    pub fn mobile_user_agent(&self) -> String {
        format!(
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{}.0.0.0 Mobile Safari/537.36",
            self.major
        )
    }

    /// `navigator.platform` for the override (`platform` in `setUserAgentOverride`).
    pub fn navigator_platform(&self, mobile: bool) -> &'static str {
        match (mobile, self.os) {
            (true, _) => "Linux armv8l",
            (false, HostOs::Mac) => "MacIntel",
            (false, HostOs::Linux) if cfg!(target_arch = "aarch64") => "Linux aarch64",
            (false, HostOs::Linux) => "Linux x86_64",
        }
    }

    /// The `userAgentMetadata` (UA Client Hints) that rides with an override: a
    /// UA string without metadata leaves the high-entropy hints contradicting
    /// it. Brands are the binary's own (`Chromium` plus the GREASE filler), with
    /// its real major and full version; only platform/model/`mobile` follow the
    /// emulated viewport.
    pub fn ua_metadata(&self, mobile: bool) -> serde_json::Value {
        let v = self.major.to_string();
        let brands = serde_json::json!([
            { "brand": "Chromium", "version": v },
            { "brand": "Not.A/Brand", "version": "24" },
        ]);
        let full_version_list = serde_json::json!([
            { "brand": "Chromium", "version": self.full },
            { "brand": "Not.A/Brand", "version": "24.0.0.0" },
        ]);
        if mobile {
            serde_json::json!({
                "brands": brands, "fullVersionList": full_version_list,
                "platform": "Android", "platformVersion": "13.0.0",
                "architecture": "", "model": "Pixel 7", "mobile": true,
                "bitness": "", "wow64": false,
            })
        } else {
            serde_json::json!({
                "brands": brands, "fullVersionList": full_version_list,
                "platform": match self.os { HostOs::Mac => "macOS", HostOs::Linux => "Linux" },
                "platformVersion": self.os_version,
                "architecture": host_arch(), "model": "", "mobile": false,
                "bitness": "64", "wow64": false,
            })
        }
    }
}

/// Pull `(major, full)` out of `<chrome> --version` output, e.g.
/// `Google Chrome for Testing 159.0.8154.6` or `Chromium 149.0.7827.55 `.
pub fn parse_chrome_version(out: &str) -> Option<(u32, String)> {
    out.split_whitespace().find_map(|w| {
        let parts: Vec<&str> = w.split('.').collect();
        if parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
            Some((parts[0].parse().ok()?, w.to_string()))
        } else {
            None
        }
    })
}

static IDENTITY: std::sync::OnceLock<BrowserIdentity> = std::sync::OnceLock::new();

/// The identity read at the first launch, if it could be read.
pub fn identity() -> Option<&'static BrowserIdentity> {
    IDENTITY.get()
}

/// Read the identity once (`<chrome> --version`, plus `sw_vers` on macOS) and
/// keep it for the process. `None` when the binary does not answer in time or
/// prints no version: then nothing is overridden and the native UA stands.
pub async fn ensure_identity(executable: &Path, ld_library_path: Option<&str>) -> Option<&'static BrowserIdentity> {
    if let Some(id) = IDENTITY.get() {
        return Some(id);
    }
    let mut cmd = Command::new(executable);
    cmd.arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    if let Some(ld) = ld_library_path {
        cmd.env("LD_LIBRARY_PATH", ld);
    }
    let out = match tokio::time::timeout(Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(o)) => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(Err(e)) => {
            warn!(error = %e, "browser: `--version` failed; launching with the native UA");
            return None;
        }
        Err(_) => {
            warn!("browser: `--version` timed out; launching with the native UA");
            return None;
        }
    };
    let Some((major, full)) = parse_chrome_version(&out) else {
        warn!(output = %out.trim(), "browser: no version in `--version`; launching with the native UA");
        return None;
    };
    let os = HostOs::current();
    let os_version = match os {
        HostOs::Mac => Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .await
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default(),
        HostOs::Linux => String::new(),
    };
    let id = BrowserIdentity { major, full, os, os_version };
    info!(major = id.major, full = %id.full, os = ?id.os, "browser: identity from the binary");
    Some(IDENTITY.get_or_init(|| id))
}

/// Disk-cache ceiling (256 MiB). The root filesystem on the deploy box runs hot
/// and a durable profile's cache is otherwise unbounded (v1 spec §10 Q2).
const DISK_CACHE_BYTES: u64 = 256 * 1024 * 1024;

/// Name of the single-writer lockfile beside a durable profile (§8.6).
const OWNER_LOCK: &str = "owner.lock";

/// Default `LD_LIBRARY_PATH` entry holding the extracted chrome shared libs on
/// a no-sudo box (relative to `$HOME`). A second path from the old rig recipe
/// (`extract/lib/...`) does not exist here and is deliberately NOT included.
const DEFAULT_CHROMELIBS_REL: &str = ".local/chromelibs/extract/usr/lib/x86_64-linux-gnu";

/// How long we wait for Chrome to write `DevToolsActivePort` before declaring
/// the launch failed. The spike measured CDP up in **165 ms**; 20s is a very
/// generous ceiling for a cold page-cache / loaded box.
const DEVTOOLS_PORT_BUDGET: Duration = Duration::from_secs(20);

/// Poll interval while waiting for `DevToolsActivePort`.
const DEVTOOLS_PORT_POLL: Duration = Duration::from_millis(25);

/// How long a graceful `SIGTERM` gets before we escalate to `SIGKILL`.
/// The spike measured a clean CDP `Browser.close` exit in **81–101 ms**.
const TERM_GRACE: Duration = Duration::from_millis(1500);

/// Resolve the chrome executable: `$SUPERMUX_CHROME_BIN`, else `$HOME/<pin>`.
pub fn default_executable() -> PathBuf {
    if let Some(p) = std::env::var_os(ENV_CHROME_BIN) {
        return PathBuf::from(p);
    }
    home_join(DEFAULT_CHROME_REL)
}

/// Resolve the `LD_LIBRARY_PATH` chrome runs with, or `None` to inherit.
pub fn default_ld_library_path() -> Option<String> {
    if let Some(p) = std::env::var_os(ENV_CHROME_LD_PATH) {
        return Some(p.to_string_lossy().into_owned());
    }
    let p = home_join(DEFAULT_CHROMELIBS_REL);
    p.is_dir().then(|| p.to_string_lossy().into_owned())
}

fn home_join(rel: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(rel)
}

/// The exact argv (minus the executable) the connector launches Chrome with.
/// Split out so a test can assert the recipe without spawning anything.
pub fn launch_args(user_data_dir: &Path, width: u32, height: u32, user_agent: Option<&str>) -> Vec<String> {
    let mut args = vec![
        // Full Chromium in its modern headless mode. See the module docs: this
        // is the flag the old shell forbade and the new binary requires.
        "--headless=new".to_string(),
        // No `--disable-blink-features=AutomationControlled`: hiding
        // `navigator.webdriver` is a bot-detection dodge, and the browser presents
        // itself honestly (Sander's choice, Core point 01a20f72).
        // Kernel-assigned port; discovered via DevToolsActivePort. Loopback only.
        "--remote-debugging-port=0".to_string(),
        "--remote-debugging-address=127.0.0.1".to_string(),
        // No user namespaces on this host, and no zygote (the zygote reparents
        // renderers, which makes group-kill accounting fuzzier).
        "--no-sandbox".to_string(),
        "--no-zygote".to_string(),
        "--disable-gpu".to_string(),
        // /dev/shm is tiny in containers; without this renderers OOM-crash.
        "--disable-dev-shm-usage".to_string(),
        // A durable profile makes Chrome want to restore/first-run/nag. None of
        // those surfaces exist here, and a resurrected session target would
        // desync the tab registry (§4.2 reconciles, but not creating the mess is
        // cheaper than reconciling it).
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-session-crashed-bubble".to_string(),
        format!("--disk-cache-size={DISK_CACHE_BYTES}"),
        format!("--user-data-dir={}", user_data_dir.display()),
        format!("--window-size={width},{height}"),
        "about:blank".to_string(),
    ];
    // The binary's own UA with only `HeadlessChrome` → `Chrome` (see
    // [`BrowserIdentity`]); none at all when the version is unknown.
    if let Some(ua) = user_agent {
        args.insert(2, format!("--user-agent={ua}"));
    }
    args
}

/// **Where the cookie jar lives** — the one thing that separates the two browser
/// modes (v1 spec §2.3 R1).
///
/// The variant decides exactly one behaviour: whether
/// [`ChromeProcess::remove_profile`] deletes the directory on teardown. Process
/// ownership, the group kill and the `Drop` backstop are identical for both.
#[derive(Debug, Clone)]
pub enum ProfileMode {
    /// `temp_dir()/supermux-browser-<uuid>`, minted per launch and **removed on
    /// every teardown path** — the agent-scratch profile, today's behaviour.
    Ephemeral,
    /// A caller-owned directory that is **never removed**: the human's persistent
    /// workspace profile, whose `Default/` subtree IS the shared cookie jar.
    Durable(PathBuf),
}

impl ProfileMode {
    /// The directory this launch will use, creating it if needed.
    ///
    /// A durable dir is created (and verified) `0700`: it holds real session
    /// cookies on disk, which Chrome needs plaintext-readable, so mode is the
    /// only containment there is (§8.5). A looser mode **fails the launch** —
    /// silently browsing on a world-readable credential store is not an option.
    fn prepare(&self) -> Result<(PathBuf, bool)> {
        match self {
            Self::Ephemeral => {
                let dir = std::env::temp_dir().join(format!(
                    "supermux-browser-{}",
                    uuid::Uuid::new_v4().simple()
                ));
                std::fs::create_dir_all(&dir).map_err(|e| {
                    BrowserError::Launch(format!(
                        "could not create user-data-dir {}: {e}",
                        dir.display()
                    ))
                })?;
                Ok((dir, false))
            }
            Self::Durable(dir) => {
                std::fs::create_dir_all(dir).map_err(|e| {
                    BrowserError::Launch(format!(
                        "could not create durable profile {}: {e}",
                        dir.display()
                    ))
                })?;
                enforce_0700(dir)?;
                Ok((dir.clone(), true))
            }
        }
    }
}

/// `chmod 0700` + verify. Returns the credential-store error, never a silent
/// downgrade. Logs the PATH only — never the contents (§8.5).
fn enforce_0700(dir: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o700);
    std::fs::set_permissions(dir, perms).map_err(|e| {
        BrowserError::Launch(format!("could not chmod 0700 {}: {e}", dir.display()))
    })?;
    let mode = std::fs::metadata(dir)
        .map_err(|e| BrowserError::Launch(format!("stat {}: {e}", dir.display())))?
        .permissions()
        .mode()
        & 0o777;
    if mode & 0o077 != 0 {
        return Err(BrowserError::Launch(format!(
            "durable browser profile {} is mode {mode:o}; it holds session cookies and must be 0700",
            dir.display()
        )));
    }
    Ok(())
}

/// **One writer per durable profile** (§8.6). The user runs more than one
/// supermux; two processes on one `--user-data-dir` corrupt it, and the failure
/// mode is "every login silently gone" — the exact thing this feature exists to
/// prevent, at maximum blast radius.
///
/// `O_CREAT|O_EXCL` on `<profile>/owner.lock` holding `<pid> <instance>`. A lock
/// whose pid is dead is **stale** and reclaimed with a warning; a lock whose pid
/// is alive is refused with [`BrowserError::ProfileLocked`]. Released on `Drop`,
/// which covers `shutdown()`, the signal hook and a panic alike.
#[derive(Debug)]
pub struct ProfileLock(PathBuf);

impl ProfileLock {
    /// Take the lock, reclaiming a stale one. `Ok(None)` for an ephemeral
    /// profile — a per-launch temp dir has no second writer by construction.
    pub fn take(dir: &Path, durable: bool) -> Result<Option<Self>> {
        if !durable {
            return Ok(None);
        }
        let path = dir.join(OWNER_LOCK);
        for attempt in 0..2 {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut f) => {
                    use std::io::Write;
                    let instance =
                        std::env::var("SUPERMUX_SESSION").unwrap_or_else(|_| "supermux".into());
                    let _ = writeln!(f, "{} {instance}", std::process::id());
                    return Ok(Some(Self(path)));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => {
                    let held = std::fs::read_to_string(&path).unwrap_or_default();
                    let by_pid = held
                        .split_whitespace()
                        .next()
                        .and_then(|p| p.parse::<u32>().ok());
                    if by_pid.map(pid_alive).unwrap_or(false) {
                        return Err(BrowserError::ProfileLocked { by_pid });
                    }
                    warn!(
                        lock = %path.display(),
                        ?by_pid,
                        "browser: reclaiming a stale profile lock (owner is gone)"
                    );
                    let _ = std::fs::remove_file(&path);
                }
                Err(e) => {
                    return Err(BrowserError::Launch(format!(
                        "profile lock {}: {e}",
                        path.display()
                    )))
                }
            }
        }
        Err(BrowserError::ProfileLocked { by_pid: None })
    }
}

impl Drop for ProfileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A **live**, owned Chromium process plus its profile.
///
/// Dropping this kills the process group and — for an [`ProfileMode::Ephemeral`]
/// profile only — removes the profile dir. See the module docs for the full
/// leak-safety contract.
#[derive(Debug)]
pub struct ChromeProcess {
    /// PID of the browser process — also the process-GROUP id (we spawn with
    /// `process_group(0)`), so `kill(-pid, …)` reaps the whole tree.
    pid: u32,
    /// The `--user-data-dir`; removed on teardown only while `durable` is false.
    user_data_dir: PathBuf,
    /// Is this the persistent workspace jar? Then teardown keeps the directory.
    durable: bool,
    /// Single-writer claim on a durable profile; `None` for ephemeral. Released
    /// by `Drop`, so every teardown path frees it.
    _owner_lock: Option<ProfileLock>,
    /// The DevTools port Chrome actually bound (loopback).
    port: u16,
    /// The browser-level CDP WebSocket URL from `GET /json/version`.
    ws_url: String,
    /// Kept so we can `wait()` the child and not leave a zombie. `None` after
    /// the child has been reaped.
    child: Option<Child>,
}

impl ChromeProcess {
    /// Spawn Chrome with the pinned recipe and wait until CDP answers.
    ///
    /// On ANY failure after the spawn (port timeout, `/json/version` refusal)
    /// the partially-started process is killed and the profile removed before
    /// the error is returned — a failed launch never leaks either.
    pub async fn launch(
        executable: &Path,
        ld_library_path: Option<&str>,
        width: u32,
        height: u32,
        profile: &ProfileMode,
    ) -> Result<Self> {
        if !executable.exists() {
            return Err(BrowserError::ChromeMissing(
                executable.display().to_string(),
            ));
        }
        let (user_data_dir, durable) = profile.prepare()?;
        // Taken BEFORE the spawn: a second instance must be refused without ever
        // pointing a Chrome at a profile someone else is writing.
        let owner_lock = ProfileLock::take(&user_data_dir, durable)?;
        // **Clear the previous run's port file.** `await_devtools_port` polls for
        // this file, and on a DURABLE profile the last run left one behind with a
        // dead port — so without this the very first launch on an existing
        // profile "succeeds" instantly against a port nothing is listening on and
        // fails at `/json/version`. (Measured: exactly that, on run #2 of the
        // persistence test.) An ephemeral profile never has one; removing it is a
        // harmless no-op there.
        let _ = std::fs::remove_file(user_data_dir.join("DevToolsActivePort"));

        let ua = ensure_identity(executable, ld_library_path)
            .await
            .map(BrowserIdentity::user_agent);
        let args = launch_args(&user_data_dir, width, height, ua.as_deref());
        let mut cmd = Command::new(executable);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // Own process group ⇒ one kill(-pgid) reaps browser + renderers.
            .process_group(0)
            // Not `kill_on_drop`: we do the group kill ourselves in Drop, which
            // is strictly stronger (kill_on_drop only signals the direct child).
            .kill_on_drop(false);
        if let Some(ld) = ld_library_path {
            cmd.env("LD_LIBRARY_PATH", ld);
        }

        let child = cmd
            .spawn()
            .map_err(|e| BrowserError::Launch(format!("spawn {}: {e}", executable.display())))?;
        let pid = child.id().ok_or_else(|| {
            BrowserError::Launch("chrome exited before a pid could be read".to_string())
        })?;

        // From here on `me` owns the teardown, so every `?` below is leak-safe.
        let mut me = Self {
            pid,
            user_data_dir,
            durable,
            _owner_lock: owner_lock,
            port: 0,
            ws_url: String::new(),
            child: Some(child),
        };
        let started = Instant::now();
        me.port = me.await_devtools_port().await?;
        me.ws_url = me.fetch_ws_url().await?;
        info!(
            pid = me.pid,
            port = me.port,
            durable = me.durable,
            ms = started.elapsed().as_millis() as u64,
            "browser: chrome up"
        );
        Ok(me)
    }

    /// Poll `<user-data-dir>/DevToolsActivePort` until Chrome writes it.
    async fn await_devtools_port(&mut self) -> Result<u16> {
        let path = self.user_data_dir.join("DevToolsActivePort");
        let deadline = Instant::now() + DEVTOOLS_PORT_BUDGET;
        loop {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Some(first) = text.lines().next() {
                    if let Ok(port) = first.trim().parse::<u16>() {
                        if port != 0 {
                            return Ok(port);
                        }
                    }
                }
            }
            // Chrome died on us? Surface that instead of timing out.
            if let Some(child) = self.child.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(BrowserError::Launch(format!(
                        "chrome exited during startup with {status}"
                    )));
                }
            }
            if Instant::now() >= deadline {
                return Err(BrowserError::Launch(format!(
                    "chrome did not write {} within {:?}",
                    path.display(),
                    DEVTOOLS_PORT_BUDGET
                )));
            }
            sleep(DEVTOOLS_PORT_POLL).await;
        }
    }

    /// `GET http://127.0.0.1:<port>/json/version` → `webSocketDebuggerUrl`.
    async fn fetch_ws_url(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct Version {
            #[serde(rename = "webSocketDebuggerUrl")]
            ws: String,
            #[serde(rename = "Browser")]
            browser: Option<String>,
        }
        let url = format!("http://127.0.0.1:{}/json/version", self.port);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            // Never route CDP discovery through a corporate/system proxy.
            .no_proxy()
            .build()
            .map_err(|e| BrowserError::Launch(format!("http client: {e}")))?;
        let v: Version = client
            .get(&url)
            .send()
            .await
            .map_err(|e| BrowserError::Launch(format!("GET {url}: {e}")))?
            .json()
            .await
            .map_err(|e| BrowserError::Launch(format!("decode {url}: {e}")))?;
        debug!(browser = ?v.browser, "browser: /json/version");
        Ok(v.ws)
    }

    /// The browser-level CDP WebSocket URL (`ws://127.0.0.1:<port>/devtools/...`).
    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// PID (and process-group id) of the browser process.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// The profile dir — exposed so the leak test can assert removal (ephemeral)
    /// and the persistence test can assert survival (durable).
    pub fn user_data_dir(&self) -> &Path {
        &self.user_data_dir
    }

    /// Is this process running on the durable workspace profile?
    pub fn is_durable(&self) -> bool {
        self.durable
    }

    /// Is the browser process still alive? `kill(pid, 0)` — no signal sent.
    pub fn is_alive(&self) -> bool {
        pid_alive(self.pid)
    }

    /// Graceful teardown: give the already-issued CDP `Browser.close` a moment
    /// to land, then group-`SIGTERM`, then group-`SIGKILL`, then reap + rmdir.
    ///
    /// Idempotent and infallible by design — teardown must never propagate an
    /// error that would skip the rest of the cleanup.
    pub async fn shutdown(mut self) {
        let deadline = Instant::now() + TERM_GRACE;
        // 1. Wait briefly for a clean exit (the CDP Browser.close path).
        while Instant::now() < deadline {
            if !pid_alive(self.pid) {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        // 2. Escalate on the whole GROUP if anything is left.
        if pid_alive(self.pid) {
            signal_group(self.pid, libc::SIGTERM);
            let deadline = Instant::now() + TERM_GRACE;
            while Instant::now() < deadline && pid_alive(self.pid) {
                sleep(Duration::from_millis(20)).await;
            }
        }
        if pid_alive(self.pid) {
            warn!(
                pid = self.pid,
                "browser: SIGTERM ignored, escalating to SIGKILL"
            );
            signal_group(self.pid, libc::SIGKILL);
        }
        // 3. Reap so no zombie survives, then drop the profile.
        if let Some(mut child) = self.child.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
        // Kill the group one last time unconditionally: a renderer that
        // outlived its parent would otherwise be an orphan.
        signal_group(self.pid, libc::SIGKILL);
        self.remove_profile();
        info!(pid = self.pid, "browser: chrome torn down");
        // `self` is dropped here; Drop re-runs the same (idempotent) steps.
    }

    /// Remove the profile dir — **ephemeral only**.
    ///
    /// For [`ProfileMode::Durable`] this is a deliberate no-op: that directory is
    /// the shared cookie jar, and removing it is exactly the "all logins gone at
    /// once" failure the workspace exists to prevent. The *process* teardown
    /// above is unchanged in both modes, so leak-safety is not weakened by one
    /// line — only the rmdir is skipped.
    fn remove_profile(&self) {
        if self.durable {
            return;
        }
        if self.user_data_dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&self.user_data_dir) {
                warn!(
                    dir = %self.user_data_dir.display(),
                    error = %e,
                    "browser: could not remove user-data-dir"
                );
            }
        }
    }
}

impl Drop for ChromeProcess {
    /// Synchronous backstop. Runs on panic, on an early `?`, and at the end of
    /// [`shutdown`](Self::shutdown). Never blocks on an await.
    fn drop(&mut self) {
        if pid_alive(self.pid) {
            warn!(
                pid = self.pid,
                "browser: ChromeProcess dropped while alive — killing group"
            );
            signal_group(self.pid, libc::SIGKILL);
        }
        // Reap without blocking; tokio's orphan queue collects anything left.
        if let Some(child) = self.child.as_mut() {
            let _ = child.try_wait();
        }
        self.remove_profile();
    }
}

/// `kill(pid, 0)` — true while the pid exists (including as a zombie we own).
pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: `kill` with signal 0 performs error checking only; it sends
    // nothing and cannot affect the target process.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Signal an entire process group (`kill(-pgid, sig)`).
fn signal_group(pgid: u32, sig: libc::c_int) {
    // SAFETY: a negative pid targets the process group; we created this group
    // ourselves via `process_group(0)` at spawn, so we can only hit our own
    // chrome tree. Errors (ESRCH — already gone) are intentionally ignored.
    unsafe {
        libc::kill(-(pgid as libc::pid_t), sig);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The **rewritten** recipe rule. The old assertion said "never
    /// `--headless=new`", which was true of `chrome-headless-shell` and is false
    /// of the full-Chromium binary v1 launches: there the flag IS the mode. The
    /// invariant worth pinning is that it is `new` and never the removed
    /// `--headless=old` / bare `--headless` spelling.
    #[test]
    fn recipe_asks_full_chromium_for_headless_new() {
        let args = launch_args(Path::new("/tmp/x"), 1024, 768, None);
        assert!(
            args.iter().any(|a| a == "--headless=new"),
            "full Chromium must be launched in the new headless mode: {args:?}"
        );
        assert!(
            !args.iter().any(|a| a == "--headless" || a == "--headless=old"),
            "old headless is the shell's mode, not this binary's: {args:?}"
        );
    }

    #[test]
    fn recipe_matches_the_spike() {
        let args = launch_args(Path::new("/tmp/profile"), 1366, 900, Some("UA-X"));
        for expected in [
            "--headless=new",
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            "--no-sandbox",
            "--no-zygote",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-session-crashed-bubble",
            "--disk-cache-size=268435456",
            "--user-data-dir=/tmp/profile",
            "--window-size=1366,900",
            "about:blank",
        ] {
            assert!(
                args.iter().any(|a| a == expected),
                "missing {expected} in {args:?}"
            );
        }
        assert!(
            !args.iter().any(|a| a.contains("AutomationControlled")),
            "navigator.webdriver is not hidden: {args:?}"
        );
        assert!(
            args.iter().any(|a| a == "--user-agent=UA-X"),
            "the identity's UA rides the recipe: {args:?}"
        );
        assert!(
            !launch_args(Path::new("/tmp/profile"), 1366, 900, None)
                .iter()
                .any(|a| a.starts_with("--user-agent=")),
            "an unknown version forces no UA: the binary's native one stands"
        );
    }

    #[test]
    fn the_version_is_read_from_the_binarys_own_output() {
        assert_eq!(
            parse_chrome_version("Google Chrome for Testing 159.0.8154.6 \n"),
            Some((159, "159.0.8154.6".to_string()))
        );
        assert_eq!(
            parse_chrome_version("Chromium 149.0.7827.55 snap"),
            Some((149, "149.0.7827.55".to_string()))
        );
        assert_eq!(parse_chrome_version("Chromium dev build"), None);
        assert_eq!(parse_chrome_version("1.2.3"), None);
    }

    /// **The UA and the hints name the same browser, honestly**: the binary's
    /// own major, the host's real platform, the Chromium brand only.
    #[test]
    fn the_ua_and_the_hints_agree_with_the_binary_and_the_host() {
        let mac = BrowserIdentity { major: 159, full: "159.0.8154.6".into(), os: HostOs::Mac, os_version: "26.1".into() };
        assert_eq!(
            mac.user_agent(),
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36"
        );
        let hints = mac.ua_metadata(false);
        assert_eq!(hints["platform"], "macOS");
        assert_eq!(hints["platformVersion"], "26.1");
        assert_eq!(hints["brands"][0], serde_json::json!({"brand": "Chromium", "version": "159"}));
        assert_eq!(hints["fullVersionList"][0]["version"], "159.0.8154.6");
        assert!(!hints.to_string().contains("Google Chrome"), "a Chromium build claims no Chrome brand");
        assert_eq!(mac.navigator_platform(false), "MacIntel");

        let linux = BrowserIdentity { major: 149, full: "149.0.7827.55".into(), os: HostOs::Linux, os_version: String::new() };
        assert!(linux.user_agent().contains("X11; Linux") && linux.user_agent().contains("Chrome/149.0.0.0"));
        assert_eq!(linux.ua_metadata(false)["platform"], "Linux");

        let phone = mac.ua_metadata(true);
        assert_eq!(phone["mobile"], true);
        assert_eq!(phone["brands"][0]["version"], "159", "the phone viewport keeps the binary's major");
        assert!(mac.mobile_user_agent().contains("Chrome/159.0.0.0 Mobile"));
    }

    /// A durable profile is a credential store, so its dir is created 0700 and a
    /// looser mode is re-tightened before Chrome ever opens it (§8.5).
    #[test]
    fn a_durable_profile_dir_is_created_and_verified_0700() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("supermux-prof-{}", uuid::Uuid::new_v4()));
        let (resolved, durable) = ProfileMode::Durable(dir.clone()).prepare().expect("prepare");
        assert!(durable);
        assert_eq!(resolved, dir);
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "got {mode:o}");

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        ProfileMode::Durable(dir.clone()).prepare().expect("re-tighten");
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "got {mode:o}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §8.6 — two supermux instances on one profile is corruption; the second is
    /// refused with a typed error, and a lock whose owner is gone is reclaimed.
    #[test]
    fn a_second_writer_is_refused_and_a_stale_lock_is_reclaimed() {
        let dir = std::env::temp_dir().join(format!("supermux-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = ProfileLock::take(&dir, true)
            .expect("first")
            .expect("durable profiles take a lock");
        let err = ProfileLock::take(&dir, true).expect_err("second writer must be refused");
        assert!(
            matches!(err, BrowserError::ProfileLocked { .. }),
            "got {err:?}"
        );
        drop(first);
        let again = ProfileLock::take(&dir, true).expect("after release").expect("some");
        drop(again);

        // A lock left behind by a DEAD pid is stale, not a wall.
        std::fs::write(dir.join(OWNER_LOCK), "2147483647 ghost\n").unwrap();
        let reclaimed = ProfileLock::take(&dir, true).expect("stale lock is reclaimed");
        assert!(reclaimed.is_some());
        drop(reclaimed);

        // Ephemeral profiles never take one — a per-launch temp dir has no peer.
        assert!(ProfileLock::take(&dir, false).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An ephemeral profile is minted fresh per launch and is NOT the durable
    /// jar — the scratch guarantee in one assertion.
    #[test]
    fn ephemeral_profiles_are_unique_per_launch() {
        let (a, durable_a) = ProfileMode::Ephemeral.prepare().unwrap();
        let (b, _) = ProfileMode::Ephemeral.prepare().unwrap();
        assert!(!durable_a);
        assert_ne!(a, b, "each scratch launch gets its own jar");
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn debugging_port_is_loopback_only() {
        let args = launch_args(Path::new("/tmp/x"), 800, 600, None);
        assert!(args
            .iter()
            .any(|a| a == "--remote-debugging-address=127.0.0.1"));
        assert!(
            !args.iter().any(|a| a.contains("0.0.0.0")),
            "the CDP port is an RCE surface and must never leave loopback"
        );
    }

    #[test]
    fn pid_alive_reports_self_and_not_pid_max() {
        assert!(pid_alive(std::process::id()));
        // 0x7FFF_FFFF is above any plausible pid_max; must read as dead.
        assert!(!pid_alive(0x7FFF_FFFF));
    }

    #[test]
    fn missing_executable_is_a_typed_error() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(ChromeProcess::launch(
                Path::new("/nonexistent/chrome-headless-shell"),
                None,
                800,
                600,
                &ProfileMode::Ephemeral,
            ))
            .expect_err("should fail");
        assert!(matches!(err, BrowserError::ChromeMissing(_)), "got {err:?}");
    }
}

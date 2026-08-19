//! Chrome launch + **leak-safe** process ownership.
//!
//! This is the half of the browser connector that owns an OS process, so it is
//! written defensively: every path that can leave a `chrome-headless-shell`
//! behind has an explicit owner.
//!
//! # The launch recipe (proven by the spike, `SPIKE-RESULT.md`)
//!
//! ```text
//! LD_LIBRARY_PATH=<chromelibs> <chrome-headless-shell> \
//!   --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 \
//!   --no-sandbox --no-zygote --disable-gpu --disable-dev-shm-usage \
//!   --user-data-dir=<tmp> --window-size=1024,768 about:blank
//! ```
//!
//! * **Never `--headless=new`** — a known crasher on this shell build; the
//!   binary is already a headless shell and reports `--headless=old` internally.
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
//! 4. The temp `--user-data-dir` is created by us under `std::env::temp_dir()`
//!    and removed on every teardown path.

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

/// Default location of the pinned `chrome-headless-shell` (Playwright's cache).
/// Relative to `$HOME`; resolved by [`default_executable`].
const DEFAULT_CHROME_REL: &str =
    ".cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";

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
pub fn launch_args(user_data_dir: &Path, width: u32, height: u32) -> Vec<String> {
    vec![
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
        format!("--user-data-dir={}", user_data_dir.display()),
        format!("--window-size={width},{height}"),
        "about:blank".to_string(),
    ]
}

/// A **live**, owned `chrome-headless-shell` process plus its scratch profile.
///
/// Dropping this kills the process group and removes the profile dir. See the
/// module docs for the full leak-safety contract.
#[derive(Debug)]
pub struct ChromeProcess {
    /// PID of the browser process — also the process-GROUP id (we spawn with
    /// `process_group(0)`), so `kill(-pid, …)` reaps the whole tree.
    pid: u32,
    /// The scratch `--user-data-dir`, removed on teardown.
    user_data_dir: PathBuf,
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
    ) -> Result<Self> {
        if !executable.exists() {
            return Err(BrowserError::ChromeMissing(
                executable.display().to_string(),
            ));
        }
        let user_data_dir = std::env::temp_dir().join(format!(
            "supermux-browser-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&user_data_dir).map_err(|e| {
            BrowserError::Launch(format!(
                "could not create user-data-dir {}: {e}",
                user_data_dir.display()
            ))
        })?;

        let args = launch_args(&user_data_dir, width, height);
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
            ms = started.elapsed().as_millis() as u64,
            "browser: chrome-headless-shell up"
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

    /// The scratch profile dir — exposed so the leak test can assert removal.
    pub fn user_data_dir(&self) -> &Path {
        &self.user_data_dir
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

    fn remove_profile(&self) {
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

    #[test]
    fn recipe_never_passes_headless_new() {
        let args = launch_args(Path::new("/tmp/x"), 1024, 768);
        assert!(
            !args.iter().any(|a| a.contains("--headless")),
            "--headless=new is a known crasher on the pinned shell build: {args:?}"
        );
    }

    #[test]
    fn recipe_matches_the_spike() {
        let args = launch_args(Path::new("/tmp/profile"), 1024, 768);
        for expected in [
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            "--no-sandbox",
            "--no-zygote",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--user-data-dir=/tmp/profile",
            "--window-size=1024,768",
            "about:blank",
        ] {
            assert!(
                args.iter().any(|a| a == expected),
                "missing {expected} in {args:?}"
            );
        }
    }

    #[test]
    fn debugging_port_is_loopback_only() {
        let args = launch_args(Path::new("/tmp/x"), 800, 600);
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
            ))
            .expect_err("should fail");
        assert!(matches!(err, BrowserError::ChromeMissing(_)), "got {err:?}");
    }
}

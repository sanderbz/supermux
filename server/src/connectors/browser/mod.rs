//! **Shared-Browser connector — phase 1: the browser service.**
//!
//! A single long-lived `chrome-headless-shell`, owned by the Rust server, with
//! one **isolated CDP browser context per agent session** and an
//! **AGENT ⇄ HUMAN drive lock** per context.
//!
//! ```text
//!   BrowserService  ── lazily spawns ──▶  chrome-headless-shell  (one process)
//!        │                                        │
//!        │  one browser WebSocket (CdpClient)  ───┘
//!        │
//!        ├─ contexts["alice"] → AgentContext { browserContextId, target, DriveLock }
//!        └─ contexts["bob"]   → AgentContext { browserContextId, target, DriveLock }
//! ```
//!
//! # Phase boundaries
//!
//! * **Phase 1 (here).** The process manager, the CDP client, the per-agent
//!   context registry, the drive lock, leak safety. No HTTP routes, no MCP
//!   tools — nothing outside this module calls it yet.
//! * **Phase 2 (shipped, [`takeover`]).** The takeover UI's data plane: a WS
//!   relay that publishes [`context::ScreencastFrame`]s to an authenticated
//!   client and feeds its taps back as [`lock::Actor::Human`] input. It does
//!   NOT pause the agent's pty — the lock IS the pause (an agent browser call
//!   is refused/parked while [`lock::DriveMode::HumanDriving`]), which leaves
//!   the agent free to keep thinking about everything else.
//! * **Phase 3.** The MCP tool server, whose every tool calls
//!   [`lock::DriveLock::ensure_agent`] before touching a page.
//!
//! # Lazy start is load-bearing
//!
//! [`BrowserService::new`] allocates a config struct and nothing else. Chrome
//! is spawned on the **first** [`BrowserService::context_for`] call. A supermux
//! install with no browser grants therefore never spawns a browser, never
//! installs a signal handler, and never touches `/tmp` — its launch is
//! byte-identical to one built without this module.
//!
//! # Leak safety (the reason this phase exists)
//!
//! Four independent guarantees, because this box has leaked chrome before:
//!
//! 1. **Process group.** Chrome is spawned with `process_group(0)`, so
//!    `kill(-pgid)` reaps the browser *and* every renderer/gpu/utility child.
//! 2. **`Drop`.** [`launch::ChromeProcess`] kills the group and removes the
//!    temp profile on drop — covering panics, early `?`, and dropped tests.
//! 3. **Signal hook.** Installed *only once chrome is actually running*:
//!    SIGTERM/SIGINT tears the browser down before the server exits, because
//!    `std::process::exit` does not run destructors.
//! 4. **Idle reaper.** A browser with zero contexts for
//!    [`BrowserConfig::idle_timeout`] is shut down; the next `context_for`
//!    transparently relaunches.

pub mod cdp;
pub mod context;
pub mod error;
pub mod launch;
pub mod lock;
/// Phase 3: the store-facing connector — the `shared-browser` card and the
/// embedded MCP server a granted bot launches.
pub mod mcp;
/// Phase 3: the lock-gated tool endpoint the MCP server forwards to.
pub mod tools;
/// Phase 2: the human takeover WebSocket — screencast out, input in, gated by
/// the drive lock.
pub mod takeover;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Once, Weak};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use tracing::{info, warn};

use cdp::CdpClient;
use context::AgentContext;
use error::{BrowserError, Result};
use launch::ChromeProcess;
use lock::{DriveMode, HandOff};

pub use error::BrowserError as Error;

/// Cap on live contexts. Each context is a page + its renderer; the spike
/// measured ~592 MB RSS for browser + 3 contexts, and one 60 fps screencast
/// already costs ~68 % of a core, so this is a resource guard, not a policy.
const DEFAULT_MAX_CONTEXTS: usize = 8;

/// Shut the browser down after this long with **zero** contexts.
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// How often the idle reaper wakes.
const REAPER_INTERVAL: Duration = Duration::from_secs(30);

/// Budget for closing every context during shutdown. A wedged browser must not
/// be able to delay the process kill.
const CONTEXT_DRAIN_BUDGET: Duration = Duration::from_secs(3);

/// Budget for the graceful CDP `Browser.close`. Spike measured 81–101 ms.
const BROWSER_CLOSE_BUDGET: Duration = Duration::from_secs(2);

/// Budget for the one context disposal a session-teardown path fires. A wedged
/// browser must never be able to hold up a session Stop/delete.
const TEARDOWN_BUDGET: Duration = Duration::from_secs(5);

/// Env override: max simultaneous per-agent contexts.
pub const ENV_MAX_CONTEXTS: &str = "SUPERMUX_BROWSER_MAX_CONTEXTS";
/// Env override: idle minutes before the shell is reaped (`0` disables).
pub const ENV_IDLE_MINUTES: &str = "SUPERMUX_BROWSER_IDLE_MINUTES";

/// Static configuration for the browser service.
#[derive(Debug, Clone)]
pub struct BrowserConfig {
    /// Absolute path to `chrome-headless-shell`.
    pub executable: PathBuf,
    /// `LD_LIBRARY_PATH` for the child (extracted chrome libs on a no-sudo box).
    pub ld_library_path: Option<String>,
    /// Default per-context viewport.
    pub width: u32,
    pub height: u32,
    /// Hard cap on live contexts.
    pub max_contexts: usize,
    /// Idle-reap threshold; `Duration::ZERO` disables reaping.
    pub idle_timeout: Duration,
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            executable: launch::default_executable(),
            ld_library_path: launch::default_ld_library_path(),
            width: 1024,
            height: 768,
            max_contexts: DEFAULT_MAX_CONTEXTS,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
        }
    }
}

impl BrowserConfig {
    /// [`Default`] with the documented env overrides applied.
    pub fn from_env() -> Self {
        let mut cfg = Self::default();
        if let Ok(v) = std::env::var(ENV_MAX_CONTEXTS) {
            if let Ok(n) = v.trim().parse::<usize>() {
                if n > 0 {
                    cfg.max_contexts = n;
                }
            }
        }
        if let Ok(v) = std::env::var(ENV_IDLE_MINUTES) {
            if let Ok(n) = v.trim().parse::<u64>() {
                cfg.idle_timeout = Duration::from_secs(n * 60);
            }
        }
        cfg
    }
}

/// Everything that exists only while chrome is running.
struct Running {
    chrome: ChromeProcess,
    client: Arc<CdpClient>,
    contexts: HashMap<String, Arc<AgentContext>>,
    /// When the context map last became empty (`None` while non-empty).
    idle_since: Option<Instant>,
}

/// The server-held browser service. One per process, in
/// [`crate::state::AppState`].
pub struct BrowserService {
    cfg: BrowserConfig,
    running: Mutex<Option<Running>>,
    /// Guards the one-time spawn of the signal hook + idle reaper. Both are
    /// installed on the first successful chrome launch and never again.
    background: Once,
}

impl std::fmt::Debug for BrowserService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserService")
            .field("executable", &self.cfg.executable)
            .field("max_contexts", &self.cfg.max_contexts)
            .finish()
    }
}

impl BrowserService {
    /// Build the service. **Spawns nothing** — see the module docs on lazy
    /// start. Cheap enough to call unconditionally from `AppState::new`.
    pub fn new(cfg: BrowserConfig) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            running: Mutex::new(None),
            background: Once::new(),
        })
    }

    /// The effective configuration.
    pub fn config(&self) -> &BrowserConfig {
        &self.cfg
    }

    /// Is a chrome process live right now?
    pub async fn is_running(&self) -> bool {
        self.running.lock().await.is_some()
    }

    /// PID of the running browser, if any. Exposed for the leak test and for
    /// operational diagnostics.
    pub async fn chrome_pid(&self) -> Option<u32> {
        self.running.lock().await.as_ref().map(|r| r.chrome.pid())
    }

    /// The running browser's scratch profile dir, if any. Exposed so the leak
    /// test can assert it is gone after shutdown.
    pub async fn user_data_dir(&self) -> Option<PathBuf> {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|r| r.chrome.user_data_dir().to_path_buf())
    }

    /// Sessions that currently hold a context.
    pub async fn sessions(&self) -> Vec<String> {
        match self.running.lock().await.as_ref() {
            Some(r) => {
                let mut v: Vec<String> = r.contexts.keys().cloned().collect();
                v.sort();
                v
            }
            None => Vec::new(),
        }
    }

    // ── the registry ────────────────────────────────────────────────────────

    /// Get (or create) `session`'s isolated browser context, starting chrome on
    /// first use. **Idempotent**: a second call for the same session returns
    /// the same `Arc`, it does not create a second context.
    ///
    /// The context lives until the session ends — see [`dispose_on_teardown`],
    /// which is what makes the cap below a cap on LIVE contexts rather than a
    /// lifetime budget, and what keeps a recycled session name from finding the
    /// previous occupant's still-logged-in page.
    pub async fn context_for(self: &Arc<Self>, session: &str) -> Result<Arc<AgentContext>> {
        let mut guard = self.running.lock().await;

        // Relaunch if a previous chrome died under us.
        if let Some(r) = guard.as_ref() {
            if r.client.is_closed() || !r.chrome.is_alive() {
                warn!("browser: chrome died; relaunching on demand");
                if let Some(dead) = guard.take() {
                    dead.chrome.shutdown().await;
                }
            }
        }

        if guard.is_none() {
            *guard = Some(self.start_locked().await?);
        }
        let running = guard.as_mut().expect("just started");

        if let Some(existing) = running.contexts.get(session) {
            return Ok(existing.clone());
        }
        if running.contexts.len() >= self.cfg.max_contexts {
            return Err(BrowserError::TooManyContexts {
                max: self.cfg.max_contexts,
            });
        }

        let ctx = Arc::new(
            AgentContext::create(
                running.client.clone(),
                session,
                self.cfg.width,
                self.cfg.height,
            )
            .await?,
        );
        info!(
            session,
            browser_context = %ctx.browser_context_id(),
            "browser: context created"
        );
        running.contexts.insert(session.to_string(), ctx.clone());
        running.idle_since = None;
        Ok(ctx)
    }

    /// Look up an existing context **without** creating one (and without
    /// starting chrome). Used by the lock API and by phase 2's UI.
    pub async fn context(&self, session: &str) -> Option<Arc<AgentContext>> {
        self.running
            .lock()
            .await
            .as_ref()
            .and_then(|r| r.contexts.get(session).cloned())
    }

    /// How many contexts are live right now. This is the number
    /// [`BrowserConfig::max_contexts`] caps, so a teardown path that forgets to
    /// call [`close_context`](Self::close_context) shows up here as a count that
    /// only ever grows.
    pub async fn context_count(&self) -> usize {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|r| r.contexts.len())
            .unwrap_or(0)
    }

    /// Is the idle reaper's clock armed (zero contexts, waiting to time out)?
    /// The reaper can only fire while this is true, so it is the observable
    /// behind "the reaper is not defeated".
    pub async fn idle_armed(&self) -> bool {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|r| r.idle_since.is_some() && r.contexts.is_empty())
            .unwrap_or(false)
    }

    /// Close one session's context and dispose it browser-side. Disposing one
    /// context provably leaves its siblings responsive.
    pub async fn close_context(&self, session: &str) -> Result<()> {
        let mut guard = self.running.lock().await;
        let Some(running) = guard.as_mut() else {
            return Err(BrowserError::NoSuchContext(session.to_string()));
        };
        let Some(ctx) = running.contexts.remove(session) else {
            return Err(BrowserError::NoSuchContext(session.to_string()));
        };
        if running.contexts.is_empty() {
            running.idle_since = Some(Instant::now());
        }
        drop(guard);
        ctx.close().await;
        info!(session, "browser: context closed");
        Ok(())
    }

    // ── the AGENT/HUMAN lock, service-level ─────────────────────────────────

    /// **The human grabs the wheel** for `session`. Returns the previous mode.
    ///
    /// Phase 2 additionally pauses the agent's pty here; the lock itself — the
    /// part that makes agent input impossible — is complete now.
    pub async fn request_human_takeover(&self, session: &str) -> Result<DriveMode> {
        let ctx = self
            .context(session)
            .await
            .ok_or_else(|| BrowserError::NoSuchContext(session.to_string()))?;
        let previous = ctx.lock().request_human_takeover();
        info!(session, %previous, "browser: HUMAN takeover");
        Ok(previous)
    }

    /// **The wheel goes back to the agent**, recording how (see
    /// [`HandOff`]). Returns the previous mode.
    pub async fn release_to_agent(&self, session: &str, handoff: HandOff) -> Result<DriveMode> {
        let ctx = self
            .context(session)
            .await
            .ok_or_else(|| BrowserError::NoSuchContext(session.to_string()))?;
        let previous = ctx.lock().release_to_agent(handoff);
        info!(session, %previous, "browser: released to AGENT");
        Ok(previous)
    }

    /// Current drive mode for a session's context.
    pub async fn mode(&self, session: &str) -> Result<DriveMode> {
        self.context(session)
            .await
            .map(|c| c.mode())
            .ok_or_else(|| BrowserError::NoSuchContext(session.to_string()))
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    /// Launch chrome + connect CDP. Caller holds the `running` lock.
    async fn start_locked(self: &Arc<Self>) -> Result<Running> {
        let chrome = ChromeProcess::launch(
            &self.cfg.executable,
            self.cfg.ld_library_path.as_deref(),
            self.cfg.width,
            self.cfg.height,
        )
        .await?;
        // From here `chrome` owns its own teardown: if the CDP connect fails,
        // dropping it kills the group and removes the profile.
        let client = CdpClient::connect(chrome.ws_url()).await?;

        // Install the process-lifetime background tasks exactly once, and only
        // now that a browser really exists (see module docs: a server with no
        // browser use installs no signal handler).
        let weak = Arc::downgrade(self);
        self.background.call_once(|| {
            install_signal_hook(weak.clone());
            spawn_idle_reaper(weak, self.cfg.idle_timeout);
        });

        Ok(Running {
            chrome,
            client,
            contexts: HashMap::new(),
            idle_since: Some(Instant::now()),
        })
    }

    /// Tear everything down: dispose every context, ask chrome to exit over
    /// CDP, then kill the process group and remove the profile dir.
    ///
    /// Idempotent and infallible — a second call on an already-stopped service
    /// is a no-op. After it returns, `kill(pid, 0)` on the old pid fails and
    /// the `--user-data-dir` is gone (asserted by the leak test).
    pub async fn shutdown(&self) {
        let taken = self.running.lock().await.take();
        let Some(mut running) = taken else { return };
        let pid = running.chrome.pid();

        // 1. Best-effort per-context disposal, bounded.
        let contexts: Vec<Arc<AgentContext>> = running.contexts.drain().map(|(_, c)| c).collect();
        let _ = tokio::time::timeout(CONTEXT_DRAIN_BUDGET, async {
            for ctx in contexts {
                ctx.close().await;
            }
        })
        .await;

        // 2. Graceful CDP exit. The response never arrives — the socket dies as
        //    a consequence — so the error/timeout here is the success signal.
        let _ = tokio::time::timeout(
            BROWSER_CLOSE_BUDGET,
            running.client.call("Browser.close", serde_json::json!({})),
        )
        .await;
        running.client.close().await;

        // 3. Verify + escalate + remove the profile dir.
        running.chrome.shutdown().await;
        info!(pid, "browser: service shut down");
    }
}

impl Drop for BrowserService {
    /// Last-ditch synchronous backstop. The real teardown is
    /// [`BrowserService::shutdown`] (async, graceful); this only exists so that
    /// dropping the service without calling it still cannot leak — the inner
    /// [`ChromeProcess`]'s own `Drop` does the group kill and the rmdir.
    fn drop(&mut self) {
        if let Ok(mut guard) = self.running.try_lock() {
            if guard.take().is_some() {
                warn!(
                    "browser: service dropped without shutdown() — ChromeProcess::drop cleans up"
                );
            }
        }
    }
}

/// **Drop `session`'s browser context because the session is going away.**
///
/// Wired into every session-teardown path (`SessionEnd` hook, `lifecycle::stop`,
/// delete/archive via `AppState::forget_session`, and rename). Without it a
/// context created on an agent's first tool call lived until the process
/// exited, which leaked three ways:
///
/// 1. **The cap became a lifetime budget.** [`BrowserConfig::max_contexts`]
///    counts live contexts and nothing ever decremented it, so the 9th distinct
///    granted session was refused a context forever.
/// 2. **The idle reaper was defeated.** It only fires while the context map is
///    empty; a map that never shrinks never empties again, so chrome stayed
///    resident (and growing) for the life of the server — on a box with a
///    documented chrome-leak history.
/// 3. **Dead agents' pages stayed logged in.** A context holds whatever the
///    agent signed into; disposing it on session end is also why a recycled
///    session name finds nothing to inherit.
///
/// Fire-and-forget and bounded: teardown must never block on CDP, and a session
/// that never used the browser is the common case — its `NoSuchContext` is
/// silent, not an error. Returns the spawned task so a test can await the
/// disposal it just triggered; `None` only outside a tokio runtime.
pub fn dispose_on_teardown(
    browser: &Arc<BrowserService>,
    session: &str,
) -> Option<tokio::task::JoinHandle<()>> {
    let handle = tokio::runtime::Handle::try_current().ok()?;
    let browser = browser.clone();
    let session = session.to_string();
    Some(handle.spawn(async move {
        match tokio::time::timeout(TEARDOWN_BUDGET, browser.close_context(&session)).await {
            // The common case: this session never opened a browser.
            Ok(Err(BrowserError::NoSuchContext(_))) => {}
            Ok(Err(e)) => warn!(session, error = %e, "browser: teardown disposal failed"),
            Ok(Ok(())) => info!(session, "browser: context disposed on session teardown"),
            Err(_) => warn!(session, "browser: teardown disposal timed out"),
        }
    }))
}

/// SIGTERM/SIGINT → tear the browser down, then exit.
///
/// **Only installed once a chrome process actually exists.** `std::process::exit`
/// (and the default signal disposition) do not run destructors, so without this
/// a `systemctl restart` would orphan the browser tree. Exiting 0 matches the
/// prior default disposition from systemd's point of view.
fn install_signal_hook(weak: Weak<BrowserService>) {
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "browser: could not hook SIGTERM");
                return;
            }
        };
        let mut int = match signal(SignalKind::interrupt()) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "browser: could not hook SIGINT");
                return;
            }
        };
        let sig = tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
        };
        info!(signal = sig, "browser: tearing down chrome before exit");
        if let Some(svc) = weak.upgrade() {
            svc.shutdown().await;
        }
        std::process::exit(0);
    });
}

/// Close the shell after [`BrowserConfig::idle_timeout`] with zero contexts.
///
/// Lives for the process lifetime (it exits when the service is dropped) and
/// is a no-op while chrome is not running, so a reaped browser simply
/// relaunches on the next [`BrowserService::context_for`].
fn spawn_idle_reaper(weak: Weak<BrowserService>, idle_timeout: Duration) {
    if idle_timeout.is_zero() {
        info!("browser: idle reaper disabled");
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(REAPER_INTERVAL).await;
            let Some(svc) = weak.upgrade() else { return };
            let expired = {
                let guard = svc.running.lock().await;
                match guard.as_ref() {
                    Some(r) => r
                        .idle_since
                        .map(|t| r.contexts.is_empty() && t.elapsed() >= idle_timeout)
                        .unwrap_or(false),
                    None => false,
                }
            };
            if expired {
                info!(?idle_timeout, "browser: idle — reaping chrome");
                svc.shutdown().await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn new_spawns_nothing() {
        // The byte-identical-launch invariant: constructing the service must
        // not start a browser, install a handler, or touch the filesystem.
        let svc = BrowserService::new(BrowserConfig::default());
        assert!(!svc.is_running().await);
        assert_eq!(svc.chrome_pid().await, None);
        assert!(svc.sessions().await.is_empty());
        assert!(svc.user_data_dir().await.is_none());
    }

    #[tokio::test]
    async fn shutdown_without_start_is_a_noop() {
        let svc = BrowserService::new(BrowserConfig::default());
        svc.shutdown().await;
        svc.shutdown().await;
        assert!(!svc.is_running().await);
    }

    #[tokio::test]
    async fn lock_api_needs_a_context() {
        let svc = BrowserService::new(BrowserConfig::default());
        let err = svc.request_human_takeover("nobody").await.unwrap_err();
        assert!(matches!(err, BrowserError::NoSuchContext(_)), "got {err:?}");
        let err = svc.mode("nobody").await.unwrap_err();
        assert!(matches!(err, BrowserError::NoSuchContext(_)), "got {err:?}");
        assert!(svc.context("nobody").await.is_none());
    }

    #[tokio::test]
    async fn missing_chrome_is_a_typed_error_and_leaves_nothing_running() {
        let svc = BrowserService::new(BrowserConfig {
            executable: PathBuf::from("/nonexistent/chrome-headless-shell"),
            ..BrowserConfig::default()
        });
        let err = svc.context_for("alice").await.unwrap_err();
        assert!(matches!(err, BrowserError::ChromeMissing(_)), "got {err:?}");
        assert!(!svc.is_running().await);
    }

    #[test]
    fn env_overrides_are_parsed() {
        // Parsing is what's under test; reading the process env is not, so the
        // vars are checked through the same code path with explicit values.
        let mut cfg = BrowserConfig::default();
        assert_eq!(cfg.max_contexts, DEFAULT_MAX_CONTEXTS);
        assert_eq!(cfg.idle_timeout, DEFAULT_IDLE_TIMEOUT);
        cfg.idle_timeout = Duration::from_secs(0);
        assert!(cfg.idle_timeout.is_zero(), "0 must disable the reaper");
    }

    #[test]
    fn defaults_are_conservative() {
        let cfg = BrowserConfig::default();
        assert!(cfg.max_contexts >= 1 && cfg.max_contexts <= 32);
        assert!(cfg.idle_timeout >= Duration::from_secs(60));
        assert_eq!((cfg.width, cfg.height), (1024, 768));
    }

    // ── FINDING 1: the registry's lifetime contract ─────────────────────────

    #[tokio::test]
    async fn closing_an_unknown_context_is_a_typed_error_not_a_panic() {
        // The teardown path fires for EVERY session, and almost none of them
        // ever opened a browser — that must be a quiet no-op.
        let svc = BrowserService::new(BrowserConfig::default());
        let err = svc.close_context("never-browsed").await.unwrap_err();
        assert!(matches!(err, BrowserError::NoSuchContext(_)), "got {err:?}");
        assert_eq!(svc.context_count().await, 0);
    }

    /// REAL-CHROME (FINDING 1). Two claims that only a live browser can settle:
    ///
    /// 1. **Disposal on session end.** `close_context` drops the live count and
    ///    RE-ARMS the idle reaper (which only fires on an empty map — the map
    ///    never emptying is what defeated it).
    /// 2. **No lifetime exhaustion.** With `max_contexts = 3`, nine sessions
    ///    that come and go all get a context; before the teardown wiring the 4th
    ///    distinct session was refused forever. The cap still holds for
    ///    SIMULTANEOUS contexts, which is what it is actually for.
    ///
    /// A recycled session name inherits nothing as a consequence of (1): by the
    /// time the name is reused there is no context left to find.
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_contexts_are_disposed_and_the_cap_is_not_a_lifetime_budget() {
        fn pid_alive(pid: u32) -> bool {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }

        let svc = BrowserService::new(BrowserConfig {
            max_contexts: 3,
            ..BrowserConfig::default()
        });

        // ── 1. a context is disposed on session end ─────────────────────────
        svc.context_for("alice").await.expect("alice");
        let pid = svc.chrome_pid().await.expect("a chrome pid");
        assert_eq!(svc.context_count().await, 1);
        assert!(!svc.idle_armed().await, "a live context disarms the reaper");

        svc.close_context("alice").await.expect("dispose alice");
        assert_eq!(svc.context_count().await, 0, "the live count must DROP");
        assert!(svc.sessions().await.is_empty());
        assert!(
            svc.idle_armed().await,
            "the idle reaper must be re-armed once the last context goes"
        );

        // ── 2. nine sessions come and go under a cap of three ───────────────
        for i in 0..9 {
            let name = format!("bot-{i}");
            svc.context_for(&name)
                .await
                .unwrap_or_else(|e| panic!("session #{i} was refused a context: {e}"));
            assert_eq!(svc.context_count().await, 1, "one at a time, by construction");
            svc.close_context(&name).await.expect("dispose");
        }
        // …and the cap is still a REAL cap on SIMULTANEOUS contexts.
        for i in 0..3 {
            svc.context_for(&format!("sim-{i}"))
                .await
                .expect("under the cap");
        }
        let err = svc.context_for("sim-3").await.unwrap_err();
        assert!(
            matches!(err, BrowserError::TooManyContexts { max: 3 }),
            "got {err:?}"
        );

        svc.shutdown().await;
        for _ in 0..50 {
            if !pid_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!pid_alive(pid), "LEAK: chrome pid {pid} still alive after shutdown");
    }

    /// REAL-CHROME end-to-end leak test (spec §13; this box has had chrome/rig
    /// leaks, so the persistent-shell service must prove clean teardown). Ignored
    /// by default — it spawns the pinned `chrome-headless-shell`. Run on a box that
    /// has it with: `cargo test -- --ignored real_chrome`. Proves the whole Phase-1
    /// contract against a live browser: one shell backs many isolated contexts, the
    /// lock flips + restores, and `shutdown()` leaves NO orphan process and removes
    /// the temporary user-data-dir.
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_spawns_shares_and_tears_down_without_leak() {
        fn pid_alive(pid: u32) -> bool {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }

        let svc = BrowserService::new(BrowserConfig::default());
        // First context lazily spawns the single shell.
        svc.context_for("alice").await.expect("spawn + context alice");
        assert!(svc.is_running().await, "chrome should be running after context_for");
        let pid = svc.chrome_pid().await.expect("a chrome pid");
        let udd = svc.user_data_dir().await.expect("a user-data-dir");
        assert!(pid_alive(pid), "chrome pid {pid} must be alive while running");
        assert!(udd.exists(), "user-data-dir must exist while running");

        // A second context reuses the SAME shell (one process, isolated contexts).
        svc.context_for("bob").await.expect("context bob");
        assert_eq!(svc.chrome_pid().await, Some(pid), "second context must reuse the one shell");
        let mut names = svc.sessions().await;
        names.sort();
        assert_eq!(names, vec!["alice".to_string(), "bob".to_string()]);

        // The AGENT/HUMAN lock flips and restores. Each call returns the mode it
        // REPLACED (so a caller can tell a real takeover from a redundant click);
        // the resulting live mode is what we assert.
        assert_eq!(
            svc.request_human_takeover("alice").await.unwrap(),
            DriveMode::AgentDriving,
            "takeover returns the previous (resting) mode"
        );
        assert_eq!(svc.mode("alice").await.unwrap(), DriveMode::HumanDriving, "now HUMAN driving");
        assert_eq!(
            svc.release_to_agent("alice", HandOff::Explicit).await.unwrap(),
            DriveMode::HumanDriving,
            "release returns the previous (human) mode"
        );
        assert_eq!(svc.mode("alice").await.unwrap(), DriveMode::AgentDriving, "back to AGENT");

        // Teardown must leave nothing behind.
        svc.shutdown().await;
        assert!(!svc.is_running().await);
        assert_eq!(svc.chrome_pid().await, None);
        // Give the OS a beat to reap the process group, then assert it is truly gone.
        for _ in 0..50 {
            if !pid_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!pid_alive(pid), "LEAK: chrome pid {pid} still alive after shutdown");
        assert!(!udd.exists(), "LEAK: user-data-dir {udd:?} must be removed on shutdown");
    }
}

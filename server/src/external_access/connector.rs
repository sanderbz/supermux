//! The connector-runtime seam: supervising `cloudflared` as a CHILD of this
//! server — the same shape as the quick-tunnel path in [`super::quick`].
//!
//! # Why not a systemd user unit
//!
//! This module used to write `~/.config/systemd/user/cloudflared.service` and
//! `systemctl --user enable --now` it. That works on a desktop login session and
//! NOWHERE ELSE. A server install — the common case for an OSS product — runs
//! supermux as a SYSTEM unit (`User=supermux`, no login session): `/run/user/`
//! is empty, there is no user D-Bus, and `systemctl --user` can never work.
//! Provisioning therefore reported a healthy-looking flow (tunnel created, DNS
//! written) while NO connector process ever started, and the tunnel stayed
//! `connecting` forever.
//!
//! So the unit writing is GONE (see the PR body): one supervision path, which
//! works on every install. The connector is a supervised child of this process,
//! restarted with backoff when it exits, started again on server boot, and
//! stopped on teardown.
//!
//! # What it will not do: start a second connector
//!
//! Two connectors racing on one tunnel is worse than none. Before spawning, the
//! supervisor looks for a cloudflared that already holds THIS tunnel's token —
//! a hand-started process (exactly what the owner's box is running today), or an
//! older build's systemd user unit that genuinely came up. When it finds one it
//! ADOPTS it: reports it honestly, spawns nothing, and takes over the moment
//! that process goes away.
//!
//! # The secret
//!
//! The token is passed in the child's ENVIRONMENT (`TUNNEL_TOKEN`), never in
//! argv — `/proc/<pid>/cmdline` is world-readable, `/proc/<pid>/environ` is not.
//! That is the same discipline the old unit's `EnvironmentFile=` had. The 0600
//! `<data_dir>/cloudflared_token` env-file is still written, because it is what
//! makes the boot resume possible.
//!
//! Everything sits behind [`ConnectorHost`] so `provision-tunnel` and the boot
//! resume are testable without spawning anything ([`MockConnectorHost`]).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::watch;

/// The key in the 0600 connector-token env-file (and in the child's env).
pub const TOKEN_ENV_KEY: &str = "TUNNEL_TOKEN";

/// First restart delay after the child exits; doubles up to [`MAX_BACKOFF`].
const START_BACKOFF: Duration = Duration::from_secs(2);
/// Ceiling for the restart backoff.
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// How often the supervisor re-checks an adopted foreign connector.
const ADOPT_POLL: Duration = Duration::from_secs(5);
/// How long `provision` waits for the supervisor to reach a settled state
/// (running / adopted / failed) before answering.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

// ── the observable state ─────────────────────────────────────────────────────

/// What the supervisor is doing right now. The single source of truth behind
/// both [`ConnectorHost::status`] and the `provision` answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectorRun {
    /// Nothing has been started in this process (or it was stopped).
    Stopped,
    /// Our own supervised child is running.
    Child(u32),
    /// A cloudflared we do NOT own already holds this tunnel's token; we stand
    /// by rather than start a second connector, and take over when it exits.
    Adopted { pid: Option<u32>, source: String },
    /// The child exited and the supervisor is waiting out its backoff. Carries
    /// the last exit reason, so `status` can say WHY it is not up.
    Restarting(String),
    /// It cannot run at all (binary missing / token unreadable). Terminal.
    Failed(String),
}

impl ConnectorRun {
    /// Has the supervisor reached a state worth answering with? Everything but
    /// the initial `Stopped` (i.e. "the task has not run yet").
    fn settled(&self) -> bool {
        !matches!(self, ConnectorRun::Stopped)
    }
}

/// The honest connector answer the status endpoint renders: running (how, which
/// pid) or not running (WHY not).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorStatus {
    pub running: bool,
    /// `child` | `adopted` | `none`.
    pub via: String,
    pub pid: Option<u32>,
    /// How it is running, or why it is not. Always populated for a not-running
    /// connector — an empty spinner with no reason is what Bug 2 was.
    pub detail: Option<String>,
}

impl ConnectorStatus {
    pub fn from_run(run: &ConnectorRun) -> Self {
        match run {
            ConnectorRun::Child(pid) => Self {
                running: true,
                via: "child".into(),
                pid: Some(*pid),
                detail: Some("supermux is running the connector".into()),
            },
            ConnectorRun::Adopted { pid, source } => Self {
                running: true,
                via: "adopted".into(),
                pid: *pid,
                detail: Some(source.clone()),
            },
            ConnectorRun::Restarting(why) => Self {
                running: false,
                via: "none".into(),
                pid: None,
                detail: Some(why.clone()),
            },
            ConnectorRun::Failed(why) => Self {
                running: false,
                via: "none".into(),
                pid: None,
                detail: Some(why.clone()),
            },
            ConnectorRun::Stopped => Self {
                running: false,
                via: "none".into(),
                pid: None,
                detail: Some("the connector has not been started on this box".into()),
            },
        }
    }
}

/// The outcome of `provision`: the connector is up (and how), or it is not (why).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectorState {
    /// Running — `via` is `child` or `adopted`.
    Started { via: String, pid: Option<u32> },
    /// Not running; the reason is surfaced by the wizard, never a bare spinner.
    Unavailable(String),
}

impl ConnectorState {
    pub fn is_started(&self) -> bool {
        matches!(self, ConnectorState::Started { .. })
    }
    fn from_run(run: &ConnectorRun) -> Self {
        let s = ConnectorStatus::from_run(run);
        if s.running {
            ConnectorState::Started {
                via: s.via,
                pid: s.pid,
            }
        } else {
            ConnectorState::Unavailable(
                s.detail
                    .unwrap_or_else(|| "the connector is not running".into()),
            )
        }
    }
}

/// Everything needed to run the connector for this box.
#[derive(Debug, Clone)]
pub struct ConnectorPlan {
    /// The connector run token (the secret). Written 0600 and handed to the
    /// child through its ENVIRONMENT, never through argv.
    pub connector_token: String,
    /// Where the 0600 token env-file lives (`<data_dir>/cloudflared_token`).
    /// It is what makes the boot resume possible.
    pub token_path: PathBuf,
    /// The `cloudflared` binary path (`~/bin/cloudflared`).
    pub cloudflared_bin: PathBuf,
}

// ── the seam ─────────────────────────────────────────────────────────────────

/// The mockable connector-runtime surface.
#[async_trait]
pub trait ConnectorHost: Send + Sync {
    /// Write the 0600 token env-file and make sure the connector is running.
    /// Idempotent: re-running with the same token is a no-op on a live
    /// supervisor; a DIFFERENT token restarts it. Adopts a foreign connector
    /// rather than starting a second one. Never panics.
    async fn provision(&self, plan: &ConnectorPlan) -> ConnectorState;
    /// Stop the supervised child (teardown). Idempotent.
    async fn stop(&self);
    /// The honest current state — running (how/pid) or not (why).
    async fn status(&self) -> ConnectorStatus;
}

// ── the token env-file ───────────────────────────────────────────────────────

/// Render the 0600 token env-file body (`TUNNEL_TOKEN=<token>`). One place, so
/// the writer and [`parse_token_env`] can never drift.
pub fn token_env_body(token: &str) -> String {
    format!("{TOKEN_ENV_KEY}={token}")
}

/// Parse a `TUNNEL_TOKEN=…` env-file (the format the old systemd unit's
/// `EnvironmentFile=` read, kept so an already-provisioned box resumes without
/// re-provisioning). Tolerates comments, blank lines, `export ` and quotes.
/// Pure — unit-tested without a filesystem.
pub fn parse_token_env(contents: &str) -> Option<String> {
    for raw in contents.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some(rest) = line.strip_prefix(TOKEN_ENV_KEY) else {
            continue;
        };
        let Some(value) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'').trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

// ── finding a connector we do not own ────────────────────────────────────────

/// A cloudflared that already holds our token but is not our child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Foreign {
    pub pid: Option<u32>,
    /// Human sentence for the status detail.
    pub source: String,
}

/// Is a process with this pid still a cloudflared holding our token? Cheap
/// re-check for an adopted connector (no full `/proc` sweep).
fn pid_holds_token(pid: u32, token: &str) -> bool {
    proc_has_token(&PathBuf::from(format!("/proc/{pid}")), token)
}

/// Does this `/proc/<pid>` entry look like a cloudflared running our token?
/// Checks argv (`--token <t>`, world-readable — this is how a hand-started
/// process is spotted) AND the environment (`TUNNEL_TOKEN=<t>`, same-uid only —
/// how OUR shape is spotted).
fn proc_has_token(proc_dir: &Path, token: &str) -> bool {
    let cmdline = std::fs::read(proc_dir.join("cmdline")).unwrap_or_default();
    if cmdline.is_empty() {
        return false;
    }
    let args: Vec<&[u8]> = cmdline.split(|b| *b == 0).filter(|a| !a.is_empty()).collect();
    // Any argv slot, not just argv[0]: a wrapper (or a `#!/bin/sh` stand-in in
    // the tests) puts the interpreter in argv[0] and the real program in argv[1].
    let is_cloudflared = args
        .iter()
        .any(|a| String::from_utf8_lossy(a).contains("cloudflared"));
    if !is_cloudflared {
        return false;
    }
    let tok = token.as_bytes();
    if args
        .iter()
        .any(|a| *a == tok || a.strip_prefix(b"--token=").map(|v| v == tok).unwrap_or(false))
    {
        return true;
    }
    // Same-uid only (0400); a failure here just means "not proven by env".
    let environ = std::fs::read(proc_dir.join("environ")).unwrap_or_default();
    environ
        .split(|b| *b == 0)
        .any(|e| e.strip_prefix(format!("{TOKEN_ENV_KEY}=").as_bytes()) == Some(tok))
}

/// Sweep `/proc` for a cloudflared already running our token. Returns `None` on
/// any platform without `/proc` (documented: adoption detection is Linux-only —
/// elsewhere we simply start our own child, which is the safe default).
pub fn running_connector_pid(token: &str) -> Option<u32> {
    let entries = std::fs::read_dir("/proc").ok()?;
    let me = std::process::id();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        if pid == me {
            continue;
        }
        if proc_has_token(&entry.path(), token) {
            return Some(pid);
        }
    }
    None
}

// ── the real host ────────────────────────────────────────────────────────────

/// Supervises `cloudflared` as a child of this server.
pub struct RealConnectorHost {
    inner: tokio::sync::Mutex<Option<Supervisor>>,
    /// First restart delay (test-tunable so a restart assertion is fast).
    backoff: Duration,
    /// Probe `systemctl --user is-active cloudflared.service` before spawning.
    /// Off in unit tests so the box's own systemd never decides a test.
    probe_systemd: bool,
}

struct Supervisor {
    /// The token this supervisor runs; a different one means restart.
    token: String,
    run: Arc<Mutex<ConnectorRun>>,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Default for RealConnectorHost {
    fn default() -> Self {
        Self::new()
    }
}

impl RealConnectorHost {
    pub fn new() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(None),
            backoff: START_BACKOFF,
            probe_systemd: true,
        }
    }

    /// A host with a short backoff and no systemd probe — for unit tests that
    /// drive the state machine against a stand-in `cloudflared`.
    #[cfg(test)]
    pub fn for_test(backoff: Duration) -> Self {
        Self {
            inner: tokio::sync::Mutex::new(None),
            backoff,
            probe_systemd: false,
        }
    }

    /// Is an old build's systemd user unit genuinely running the connector?
    /// Only asked where it can possibly be true (a user session bus + the unit
    /// file). On a system-unit install this is always `false` — which is the
    /// whole bug this module exists to fix.
    async fn systemd_unit_active() -> bool {
        if std::env::var_os("XDG_RUNTIME_DIR").is_none() {
            return false;
        }
        let unit = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config/systemd/user/cloudflared.service");
        if !unit.is_file() {
            return false;
        }
        matches!(
            tokio::process::Command::new("systemctl")
                .args(["--user", "is-active", "cloudflared.service"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await,
            Ok(s) if s.success()
        )
    }
}

/// Find a cloudflared that already holds `token` and is not ours — an older
/// build's systemd user unit that genuinely came up, or a hand-started process.
async fn find_foreign(token: &str, probe_systemd: bool) -> Option<Foreign> {
    if probe_systemd && RealConnectorHost::systemd_unit_active().await {
        return Some(Foreign {
            pid: None,
            source: "the cloudflared systemd user unit is already running this tunnel".into(),
        });
    }
    running_connector_pid(token).map(|pid| Foreign {
        pid: Some(pid),
        source: format!("adopted the cloudflared already running this tunnel on this box (pid {pid})"),
    })
}

fn set_run(cell: &Arc<Mutex<ConnectorRun>>, next: ConnectorRun) {
    *cell.lock().unwrap_or_else(|e| e.into_inner()) = next;
}

fn get_run(cell: &Arc<Mutex<ConnectorRun>>) -> ConnectorRun {
    cell.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Wait for `stop`, or for `dur` to elapse. `true` ⇒ we were told to stop.
async fn sleep_or_stop(stop: &mut watch::Receiver<bool>, dur: Duration) -> bool {
    if *stop.borrow() {
        return true;
    }
    tokio::select! {
        _ = tokio::time::sleep(dur) => false,
        r = stop.changed() => r.is_err() || *stop.borrow(),
    }
}

/// The supervision loop. One task per provisioned token:
/// adopt a foreign connector → else spawn ours → drain its stderr to EOF →
/// on exit, back off and try again → on stop, kill and return.
async fn supervise(
    bin: PathBuf,
    token: String,
    probe_systemd: bool,
    first_backoff: Duration,
    run: Arc<Mutex<ConnectorRun>>,
    mut stop: watch::Receiver<bool>,
) {
    let mut backoff = first_backoff;
    loop {
        if *stop.borrow() {
            set_run(&run, ConnectorRun::Stopped);
            return;
        }
        // 1. Someone else already runs this tunnel → stand by, do NOT spawn a
        //    second connector; take over once it is gone.
        if let Some(f) = find_foreign(&token, probe_systemd).await {
            tracing::info!(pid = ?f.pid, "external-access: {}", f.source);
            set_run(
                &run,
                ConnectorRun::Adopted {
                    pid: f.pid,
                    source: f.source.clone(),
                },
            );
            loop {
                if sleep_or_stop(&mut stop, ADOPT_POLL).await {
                    set_run(&run, ConnectorRun::Stopped);
                    return;
                }
                let still_there = match f.pid {
                    Some(pid) => pid_holds_token(pid, &token),
                    // A systemd-unit adoption has no pid of ours to watch.
                    None => find_foreign(&token, probe_systemd).await.is_some(),
                };
                if !still_there {
                    break;
                }
            }
            backoff = first_backoff;
            continue;
        }

        // 2. Spawn our own child. The token rides the ENVIRONMENT, never argv.
        let mut child = match tokio::process::Command::new(&bin)
            .arg("tunnel")
            .arg("--no-autoupdate")
            .arg("run")
            .env(TOKEN_ENV_KEY, &token)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                // A missing binary is not something a retry loop can fix — say
                // so, terminally, instead of spinning forever.
                let why = format!("could not start {}: {e}", bin.display());
                tracing::warn!("external-access: {why}");
                set_run(&run, ConnectorRun::Failed(why));
                return;
            }
        };
        set_run(&run, ConnectorRun::Child(child.id().unwrap_or(0)));
        tracing::info!(pid = ?child.id(), "external-access: connector started");

        // The stderr drain is LIFE SUPPORT, not diagnostics: cloudflared logs to
        // stderr forever and Go turns an `EPIPE` on fd 2 into a fatal SIGPIPE, so
        // a dropped read end kills the tunnel within seconds (measured on this
        // box: `rc = -13`). Exactly the bug `quick.rs` documents — keep reading
        // to EOF for the child's whole life.
        let drain = child.stderr.take().map(|err| {
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::trace!(target: "cloudflared", "{line}");
                }
            })
        });

        let exit_reason = tokio::select! {
            res = child.wait() => match res {
                Ok(status) => format!("the connector exited ({status}); restarting"),
                Err(e) => format!("lost track of the connector: {e}; restarting"),
            },
            r = stop.changed() => {
                let _ = r;
                let _ = child.start_kill();
                let _ = child.wait().await;
                if let Some(d) = drain { d.abort(); }
                set_run(&run, ConnectorRun::Stopped);
                return;
            }
        };
        if let Some(d) = drain {
            d.abort();
        }
        tracing::warn!("external-access: {exit_reason}");
        set_run(&run, ConnectorRun::Restarting(exit_reason));

        // 3. Back off (interruptibly), then try again.
        if sleep_or_stop(&mut stop, backoff).await {
            set_run(&run, ConnectorRun::Stopped);
            return;
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

#[async_trait]
impl ConnectorHost for RealConnectorHost {
    async fn provision(&self, plan: &ConnectorPlan) -> ConnectorState {
        // The 0600 env-file first: it is what lets the next BOOT resume this
        // connector with no wizard round-trip.
        if let Err(e) = crate::config::write_token_0600(
            &plan.token_path,
            &token_env_body(&plan.connector_token),
        ) {
            return ConnectorState::Unavailable(format!("writing the connector token: {e}"));
        }

        let mut guard = self.inner.lock().await;
        // Already supervising this exact token, and the task is alive ⇒ idempotent.
        if let Some(sup) = guard.as_ref() {
            if sup.token == plan.connector_token && !sup.task.is_finished() {
                return ConnectorState::from_run(&get_run(&sup.run));
            }
        }
        // A different token (or a dead supervisor) ⇒ stop the old one first.
        if let Some(sup) = guard.take() {
            let _ = sup.stop.send(true);
            let _ = tokio::time::timeout(Duration::from_secs(5), sup.task).await;
        }

        let run = Arc::new(Mutex::new(ConnectorRun::Stopped));
        let (tx, rx) = watch::channel(false);
        let task = tokio::spawn(supervise(
            plan.cloudflared_bin.clone(),
            plan.connector_token.clone(),
            self.probe_systemd,
            self.backoff,
            run.clone(),
            rx,
        ));
        *guard = Some(Supervisor {
            token: plan.connector_token.clone(),
            run: run.clone(),
            stop: tx,
            task,
        });
        drop(guard);

        // Answer only once the supervisor has actually reached a state — a
        // "started" that has not started anything yet is the lie we are fixing.
        let deadline = tokio::time::Instant::now() + SETTLE_TIMEOUT;
        loop {
            let cur = get_run(&run);
            if cur.settled() {
                return ConnectorState::from_run(&cur);
            }
            if tokio::time::Instant::now() >= deadline {
                return ConnectorState::Unavailable(
                    "the connector did not come up within 5s; supermux keeps retrying".into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn stop(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(sup) = guard.take() {
            let _ = sup.stop.send(true);
            let _ = tokio::time::timeout(Duration::from_secs(5), sup.task).await;
            set_run(&sup.run, ConnectorRun::Stopped);
        }
    }

    async fn status(&self) -> ConnectorStatus {
        let guard = self.inner.lock().await;
        match guard.as_ref() {
            Some(sup) => ConnectorStatus::from_run(&get_run(&sup.run)),
            None => ConnectorStatus::from_run(&ConnectorRun::Stopped),
        }
    }
}

// ── test double ──────────────────────────────────────────────────────────────

/// Records the provisioning plan and reports a chosen [`ConnectorState`], so the
/// provision handler + the boot resume are testable without spawning anything.
/// Still writes the 0600 token env-file (so that invariant is asserted against a
/// real file), but never touches a process.
#[cfg(test)]
pub struct MockConnectorHost {
    pub state: ConnectorState,
    pub status: Mutex<ConnectorStatus>,
    pub provisions: std::sync::atomic::AtomicUsize,
    pub stops: std::sync::atomic::AtomicUsize,
    pub last_plan: Mutex<Option<ConnectorPlan>>,
}

#[cfg(test)]
impl Default for MockConnectorHost {
    fn default() -> Self {
        Self {
            state: ConnectorState::Started {
                via: "child".into(),
                pid: Some(4242),
            },
            status: Mutex::new(ConnectorStatus::from_run(&ConnectorRun::Child(4242))),
            provisions: std::sync::atomic::AtomicUsize::new(0),
            stops: std::sync::atomic::AtomicUsize::new(0),
            last_plan: Mutex::new(None),
        }
    }
}

#[cfg(test)]
impl MockConnectorHost {
    /// A host whose connector is NOT running, with a reason — the state the
    /// wizard has to render honestly instead of spinning.
    pub fn unavailable(reason: &str) -> Self {
        Self {
            state: ConnectorState::Unavailable(reason.to_string()),
            status: Mutex::new(ConnectorStatus::from_run(&ConnectorRun::Restarting(
                reason.to_string(),
            ))),
            ..Default::default()
        }
    }

    pub fn provision_count(&self) -> usize {
        self.provisions.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub fn stop_count(&self) -> usize {
        self.stops.load(std::sync::atomic::Ordering::SeqCst)
    }
    /// The token the last `provision` was asked to run.
    pub fn last_token(&self) -> Option<String> {
        self.last_plan
            .lock()
            .unwrap()
            .as_ref()
            .map(|p| p.connector_token.clone())
    }
}

#[cfg(test)]
#[async_trait]
impl ConnectorHost for MockConnectorHost {
    async fn provision(&self, plan: &ConnectorPlan) -> ConnectorState {
        self.provisions
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _ = crate::config::write_token_0600(
            &plan.token_path,
            &token_env_body(&plan.connector_token),
        );
        *self.last_plan.lock().unwrap() = Some(plan.clone());
        self.state.clone()
    }

    async fn stop(&self) {
        self.stops.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    async fn status(&self) -> ConnectorStatus {
        self.status.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::os::unix::fs::PermissionsExt as _;

    /// A stand-in `cloudflared`: a script whose PATH contains "cloudflared" (so
    /// the `/proc` matcher recognises it) doing whatever `body` says.
    fn fake_cloudflared(dir: &Path, body: &str) -> PathBuf {
        std::fs::create_dir_all(dir).expect("tmpdir");
        let bin = dir.join("cloudflared");
        {
            let mut f = std::fs::File::create(&bin).expect("create");
            f.write_all(format!("#!/bin/sh\n{body}\n").as_bytes())
                .expect("write");
        }
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        bin
    }

    /// How many live processes hold this token — the double-start guard's assertion.
    fn connector_count(token: &str) -> usize {
        let me = std::process::id();
        std::fs::read_dir("/proc")
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .and_then(|s| s.parse::<u32>().ok())
                    .is_some_and(|pid| pid != me)
                    && proc_has_token(&e.path(), token)
            })
            .count()
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("supermux-conn-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).expect("tmpdir");
        d
    }

    fn plan(dir: &Path, bin: PathBuf, token: &str) -> ConnectorPlan {
        ConnectorPlan {
            connector_token: token.to_string(),
            token_path: dir.join("cloudflared_token"),
            cloudflared_bin: bin,
        }
    }

    /// Poll `status` until `pred` holds, or give up. Keeps the timing
    /// assertions out of every test body.
    async fn wait_for(
        host: &RealConnectorHost,
        within: Duration,
        pred: impl Fn(&ConnectorStatus) -> bool,
    ) -> ConnectorStatus {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let s = host.status().await;
            if pred(&s) || tokio::time::Instant::now() >= deadline {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[test]
    fn token_env_file_roundtrips_and_tolerates_the_unit_format() {
        let body = token_env_body("tok-abc");
        assert_eq!(body, "TUNNEL_TOKEN=tok-abc");
        assert_eq!(parse_token_env(&body).as_deref(), Some("tok-abc"));
        // The shapes an operator (or an older build) might have left behind.
        assert_eq!(
            parse_token_env("# comment\n\nexport TUNNEL_TOKEN=\"tok-2\"\n").as_deref(),
            Some("tok-2")
        );
        assert_eq!(parse_token_env("TUNNEL_TOKEN='tok-3'").as_deref(), Some("tok-3"));
        // Nothing usable ⇒ None (never an empty token handed to cloudflared).
        assert_eq!(parse_token_env("TUNNEL_TOKEN=\n"), None);
        assert_eq!(parse_token_env("OTHER=x\n"), None);
        assert_eq!(parse_token_env(""), None);
    }

    /// Bug 1, the core: provisioning must actually START something, on a box
    /// with no systemd user manager at all.
    #[tokio::test]
    async fn provision_starts_a_supervised_child_and_status_says_so() {
        let dir = tmpdir("start");
        let bin = fake_cloudflared(&dir, "while true; do echo 'INF up' >&2; sleep 0.1; done");
        let host = RealConnectorHost::for_test(Duration::from_millis(100));

        let state = host.provision(&plan(&dir, bin, "tok-start")).await;
        match &state {
            ConnectorState::Started { via, pid } => {
                assert_eq!(via, "child");
                assert!(pid.unwrap_or(0) > 0, "a real pid is reported: {pid:?}");
            }
            other => panic!("expected a started child, got {other:?}"),
        }
        let s = host.status().await;
        assert!(s.running && s.via == "child");
        // The 0600 env-file is what the next boot reads.
        let body = std::fs::read_to_string(dir.join("cloudflared_token")).expect("token file");
        assert_eq!(parse_token_env(&body).as_deref(), Some("tok-start"));
        let mode = std::fs::metadata(dir.join("cloudflared_token"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "connector token must stay 0600");
        // The secret must NOT be in the child's argv (world-readable).
        let pid = s.pid.expect("pid");
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        assert!(
            !String::from_utf8_lossy(&cmdline).contains("tok-start"),
            "the token must ride the environment, never argv"
        );

        host.stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A second provision with the same token must not stack a second child.
    #[tokio::test]
    async fn provision_is_idempotent_for_the_same_token() {
        let dir = tmpdir("idem");
        let bin = fake_cloudflared(&dir, "while true; do sleep 0.1; done");
        let host = RealConnectorHost::for_test(Duration::from_millis(100));
        let p = plan(&dir, bin, "tok-idem");

        let first = host.provision(&p).await;
        let second = host.provision(&p).await;
        assert_eq!(first, second, "the same token re-provisions to the same child");
        assert_eq!(
            connector_count("tok-idem"),
            1,
            "exactly one connector process, never a second"
        );

        host.stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The child dies (crash, OOM, cloudflared self-exit) → the supervisor
    /// brings it back. Without this a single blip ends external access silently.
    #[tokio::test]
    async fn a_child_that_exits_is_restarted_after_a_backoff() {
        let dir = tmpdir("restart");
        let marker = dir.join("starts");
        let bin = fake_cloudflared(
            &dir,
            &format!("echo start >> {} ; exit 3", marker.display()),
        );
        let host = RealConnectorHost::for_test(Duration::from_millis(100));
        let state = host.provision(&plan(&dir, bin, "tok-restart")).await;
        // It may already have exited by the time provision settles; either way
        // the supervisor is the thing under test.
        assert!(matches!(
            state,
            ConnectorState::Started { .. } | ConnectorState::Unavailable(_)
        ));

        // The exit reason is reported honestly while it is down…
        let down = wait_for(&host, Duration::from_secs(3), |s| {
            !s.running && s.detail.as_deref().unwrap_or("").contains("exited")
        })
        .await;
        assert!(
            down.detail.as_deref().unwrap_or("").contains("exited"),
            "status must say why it is down: {down:?}"
        );
        // …and it is tried again.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut starts = 0;
        while tokio::time::Instant::now() < deadline {
            starts = std::fs::read_to_string(&marker)
                .map(|s| s.lines().count())
                .unwrap_or(0);
            if starts >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(starts >= 2, "the connector must be restarted (starts={starts})");

        host.stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A cloudflared already running this tunnel (the owner's hand-started
    /// process) must be ADOPTED, never doubled — and taken over when it goes.
    #[tokio::test]
    async fn a_foreign_connector_is_adopted_then_taken_over() {
        let dir = tmpdir("adopt");
        let bin = fake_cloudflared(&dir, "while true; do sleep 0.1; done");
        // The stand-in "already running" connector — token in argv, exactly like
        // a hand-started `cloudflared tunnel run --token …`.
        let mut foreign = tokio::process::Command::new(&bin)
            .args(["tunnel", "--no-autoupdate", "run", "--token", "tok-adopt"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the foreign connector");
        let foreign_pid = foreign.id().expect("foreign pid");
        // Give it a moment to exist in /proc.
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(running_connector_pid("tok-adopt"), Some(foreign_pid));

        let host = RealConnectorHost::for_test(Duration::from_millis(100));
        let state = host.provision(&plan(&dir, bin, "tok-adopt")).await;
        assert_eq!(
            state,
            ConnectorState::Started {
                via: "adopted".into(),
                pid: Some(foreign_pid)
            },
            "an existing connector is adopted, not doubled"
        );

        // It goes away → we take over with our own child.
        let _ = foreign.kill().await;
        let taken = wait_for(&host, Duration::from_secs(15), |s| s.via == "child").await;
        assert!(
            taken.running && taken.via == "child",
            "the supervisor must take over once the foreign connector exits: {taken:?}"
        );
        assert_ne!(taken.pid, Some(foreign_pid));

        host.stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Teardown stops the child and says so.
    #[tokio::test]
    async fn stop_kills_the_child_and_reports_not_running() {
        let dir = tmpdir("stop");
        let bin = fake_cloudflared(&dir, "while true; do sleep 0.1; done");
        let host = RealConnectorHost::for_test(Duration::from_millis(100));
        let started = host.provision(&plan(&dir, bin, "tok-stop")).await;
        assert!(started.is_started());

        host.stop().await;
        let s = host.status().await;
        assert!(!s.running, "status is honest after teardown: {s:?}");
        assert!(s.detail.is_some(), "and says why");
        // The process is really gone.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(running_connector_pid("tok-stop"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No binary ⇒ a terminal, NAMED failure — never a silent forever-spinner.
    #[tokio::test]
    async fn a_missing_binary_is_reported_not_spun_on() {
        let dir = tmpdir("nobin");
        let host = RealConnectorHost::for_test(Duration::from_millis(50));
        let state = host
            .provision(&plan(&dir, dir.join("nope/cloudflared"), "tok-nobin"))
            .await;
        match state {
            ConnectorState::Unavailable(why) => assert!(
                why.contains("could not start"),
                "the reason must name the failure: {why}"
            ),
            other => panic!("expected Unavailable, got {other:?}"),
        }
        let s = host.status().await;
        assert!(!s.running && s.detail.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

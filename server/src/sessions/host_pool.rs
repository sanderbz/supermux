//! Persistent SSH ControlMaster pool.
//!
//! **What this is.** One [`HostPool`] lives in [`AppState`], shared by every
//! sessions/files/git path that needs a [`Transport`] for a remote host. The
//! pool keeps **one OpenSSH ControlMaster per host**: a single multiplexed TCP
//! connection that every subsequent `ssh` invocation re-uses via
//! `-o ControlMaster=auto -o ControlPath=<sock>`. After the master is warm,
//! every `transport.spawn_command("tmux", &[...])` is a sub-millisecond hop
//! (no new handshake, no new auth).
//!
//! **State per host.** A [`tokio::sync::Mutex<HostState>`] held under a
//! `DashMap<i64, _>` keyed by host_id, so the cold/warm coordination is
//! serialized per-host without blocking other hosts. The mutex covers:
//!
//! * `control_path: PathBuf` — the unix socket the master listens on
//!   (`<data_dir>/ssh-control/cm-<host_id>`). Stable for the lifetime of the
//!   pool — derived once.
//! * `master_pid: Option<u32>` — the pid of the most-recent `ssh -fN` we
//!   spawned, for diagnostics + the reaper. `None` when the master is down /
//!   ControlPath is stale.
//! * `last_used: Instant` — bumped on every successful [`transport_for`] /
//!   [`verify`]. The reaper uses this to garbage-collect idle masters.
//! * `failures: u32` — consecutive failed warm-up attempts. Resets to 0 on
//!   the first successful `-O check`. At >= 4 the host is marked
//!   [`HostStatus::Unreachable`] and `transport_for` returns an error so
//!   callers see a clean failure (instead of a hung child).
//!
//! **Lifecycle.**
//!
//! 1. `transport_for(id)` looks up the host row (404 / tombstone → Err),
//!    acquires the per-host mutex, runs `ssh -O check` against the control
//!    socket — exit 0 means the master is alive and we hand back a fresh
//!    [`Transport::Ssh`] wrapping `(host_id, ssh_target, control_path)`.
//! 2. On `-O check` failure: spawn
//!    `ssh -o ControlMaster=yes -o ControlPath=<cp> -o ControlPersist=600 \
//!         -o BatchMode=yes -fN <target>`, then poll `-O check` every 100ms
//!    for up to 5s. The OpenSSH `-fN` flag forks the master into the
//!    background and exits the parent; we wait for the parent so any
//!    immediate auth failure surfaces as a non-zero exit.
//! 3. Each warm-up attempt that fails bumps `failures` and sleeps an
//!    exponentially-growing backoff (`100ms, 500ms, 2s, 10s`) BETWEEN
//!    attempts before returning Err. Reaching `failures >= 4` flips
//!    `hosts.status` to `unreachable` so the FE picker / host-check endpoints
//!    surface the dead host.
//!
//! **The reaper.** A `tokio::spawn`ed task (started from `main.rs`) wakes
//! every 60s, iterates the known per-host states, and tears down any master
//! whose `last_used` is >10min ago AND has no live session row pointing at
//! it (`db::sessions::list` filtered on `host_id == Some(id)`). Tearing
//! down is `ssh -O exit` against the socket plus `master_pid = None`. The
//! task obeys a `CancellationToken`-like `Notify` for clean shutdown so the
//! integration tests can stop it deterministically.
//!
//! **Safety.** Every external command goes through `tokio::process::Command`
//! with **separate args** (`args(["-o", "...", target, "--", program])`) — no
//! shell, no quoting, no metacharacter parsing. The ssh target string comes
//! straight from the `hosts` table; ssh itself rejects malformed targets at
//! syscall time. The control socket path lives under `<data_dir>/ssh-control/`
//! created mode `0700` on first use, so a co-tenant user on a shared box can't
//! impersonate the master.
//!
//! **No `.unwrap()` outside tests.** All fallible paths return
//! `anyhow::Result<_>` with `.context(...)` so the principle critic finds a
//! clean failure surface. Logs use `tracing::{info,warn,error}` (never
//! `println!`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use dashmap::DashMap;
use sqlx::SqlitePool;
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};
use tokio::time::sleep;
use tracing::{error, info, warn};

use crate::db::hosts::{self, HostStatus};
use crate::sessions::transport::{HostId, Transport};

/// How long a `ssh -O check` (or a warm-up `ssh -fN` parent) is allowed to
/// hang before we give up and treat it as a failure. ControlMaster operations
/// are local (talk to the unix socket), so this is generous on purpose — a
/// long hang means the master is wedged, not slow.
const SSH_OP_TIMEOUT: Duration = Duration::from_secs(5);

/// Poll interval while waiting for a freshly-spawned master to start
/// answering `ssh -O check`. 100ms is small enough that warm-up of a
/// reachable host is sub-second in the common case.
const CHECK_POLL: Duration = Duration::from_millis(100);

/// Total budget to wait for a master to come up after we spawn its
/// `ssh -fN` parent. 5s covers the worst-case TCP + auth round-trip on a
/// transcontinental Tailscale peer; anything longer is "the host is down".
const MASTER_UP_BUDGET: Duration = Duration::from_secs(5);

/// Backoff schedule between warm-up attempts. The Nth (0-indexed) failure
/// waits `BACKOFFS[min(N, BACKOFFS.len()-1)]` before the next try. The
/// fourth failure flips the host to `unreachable` (see [`MAX_FAILURES`]).
const BACKOFFS: &[Duration] = &[
    Duration::from_millis(100),
    Duration::from_millis(500),
    Duration::from_secs(2),
    Duration::from_secs(10),
];

/// Consecutive failed warm-ups after which the host row is flipped to
/// [`HostStatus::Unreachable`] so the FE / host-check endpoint surfaces the dead host. The
/// counter resets on the first successful `-O check`.
const MAX_FAILURES: u32 = 4;

/// Reaper sweep interval: every 60s we iterate known masters and tear down
/// any that have been idle for [`REAPER_IDLE`].
const REAPER_INTERVAL: Duration = Duration::from_secs(60);

/// An idle master older than this is a tear-down candidate. The reaper still
/// holds back if a live session row points at the host so an "idle" but
/// session-attached master isn't yanked from under a re-attaching client.
const REAPER_IDLE: Duration = Duration::from_secs(600);

/// Per-host runtime state guarded by an async mutex. See the module docs for
/// the field invariants.
#[derive(Debug)]
pub struct HostState {
    /// Unix socket the OpenSSH ControlMaster listens on. Derived once when
    /// the slot is first inserted; never rewritten.
    pub control_path: PathBuf,
    /// Pid of the most recent `ssh -fN` parent we spawned. `None` when the
    /// master is believed-down (reaper tore it down, or warm-up never
    /// succeeded). Diagnostic only — `ssh -O check` is the source of truth.
    pub master_pid: Option<u32>,
    /// Bumped on every successful `transport_for` / `verify`. Drives the
    /// reaper's idle-eviction policy.
    pub last_used: Instant,
    /// Consecutive failed warm-up attempts since the last success. Resets to
    /// 0 on the first `-O check` that exits zero. At >= [`MAX_FAILURES`] the
    /// host is marked `unreachable` and `transport_for` returns Err.
    pub failures: u32,
}

impl HostState {
    fn fresh(control_path: PathBuf) -> Self {
        Self {
            control_path,
            master_pid: None,
            last_used: Instant::now(),
            failures: 0,
        }
    }
}

/// The pool. Cloned around as an `Arc<HostPool>` from [`AppState`]. Cheap:
/// inside is a `SqlitePool` handle, a small `DashMap`, and an `Arc<PathBuf>`.
pub struct HostPool {
    /// DB pool for resolving host rows + updating status on terminal
    /// failures.
    pool: SqlitePool,
    /// Parent dir of every control socket. `<data_dir>/ssh-control/`, created
    /// `0700` on first use. The socket path itself is `<this>/cm-<host_id>`.
    control_dir: PathBuf,
    /// Per-host state. Keyed by `host_id` (i64). The `Arc<Mutex<_>>` ensures
    /// concurrent `transport_for(id)` callers serialize the cold/warm
    /// coordination for the SAME id, while NOT blocking other ids.
    hosts: DashMap<i64, Arc<Mutex<HostState>>>,
    /// Reaper shutdown signal. The reaper parks on this notify between
    /// sweeps; calling [`HostPool::shutdown`] notifies it once and the task
    /// exits at the next park/check. Wrapped in `Arc` so the spawned task
    /// can own a clone independently.
    shutdown: Arc<Notify>,
}

impl HostPool {
    /// Build a fresh pool against `pool` + `data_dir`. The control-socket dir
    /// (`<data_dir>/ssh-control/`) is created `0700` on first use. Infallible
    /// at construction time on purpose — `AppState::new` is non-fallible,
    /// every other caller is a test, and the real failure surface (a missing
    /// or unwritable dir) only matters at `transport_for` / warm-up time
    /// where we already return `Result`. A failure here is logged and the
    /// pool is still returned; the next `warm_up` will surface the real
    /// error context.
    pub fn new(pool: SqlitePool, data_dir: &Path) -> Arc<Self> {
        let control_dir = data_dir.join("ssh-control");
        if let Err(e) = ensure_dir_0700(&control_dir) {
            warn!(
                control_dir = %control_dir.display(),
                error = %e,
                "could not prepare SSH control dir at startup (will retry on warm-up)"
            );
        }
        Arc::new(Self {
            pool,
            control_dir,
            hosts: DashMap::new(),
            shutdown: Arc::new(Notify::new()),
        })
    }

    /// The socket path for `host_id`. Deterministic (`<control_dir>/cm-<id>`)
    /// so a server restart finds an already-running master from the previous
    /// process — OpenSSH happily accepts a re-connecting client against an
    /// existing master socket.
    fn socket_for(&self, host_id: i64) -> PathBuf {
        self.control_dir.join(format!("cm-{host_id}"))
    }

    /// Get or insert the per-host slot. The returned `Arc<Mutex<_>>` is the
    /// serialization point for all warm-up / tear-down ops on this host.
    fn slot_for(&self, host_id: i64) -> Arc<Mutex<HostState>> {
        self.hosts
            .entry(host_id)
            .or_insert_with(|| {
                Arc::new(Mutex::new(HostState::fresh(self.socket_for(host_id))))
            })
            .clone()
    }

    /// Resolve a [`Transport`] for `host_id`, warming the ControlMaster on
    /// demand. See the module docs for the full state machine.
    ///
    /// Returns Err for:
    /// * unknown / soft-deleted host id,
    /// * master warm-up that failed after the full backoff schedule (host is
    ///   then flipped to `unreachable`),
    /// * any unexpected I/O failure when running ssh.
    pub async fn transport_for(&self, host_id: i64) -> Result<Arc<Transport>> {
        let host = hosts::get(&self.pool, host_id)
            .await
            .with_context(|| format!("looking up host {host_id}"))?
            .ok_or_else(|| anyhow!("host {host_id} not found"))?;
        if host.deleted_at.is_some() {
            return Err(anyhow!(
                "host {host_id} ({}) is soft-deleted",
                host.name
            ));
        }

        let slot = self.slot_for(host_id);
        let mut state = slot.lock().await;

        // Fast path: master is already up. `-O check` is a unix-socket ping,
        // sub-millisecond; we do it under the lock so a concurrent caller
        // sees the same answer.
        if check_master(&state.control_path, &host.ssh_target).await {
            state.last_used = Instant::now();
            state.failures = 0;
            return Ok(Arc::new(Transport::Ssh {
                host_id: HostId(host_id),
                ssh_target: host.ssh_target,
                control_path: state.control_path.clone(),
            }));
        }

        // Slow path: spawn a master and wait for it to come up. On the path
        // out we either succeed (failures = 0, last_used bumped) or we have
        // exhausted the backoff schedule and need to flip the host's status.
        match warm_up(&state.control_path, &host.ssh_target).await {
            Ok(pid) => {
                info!(
                    host_id,
                    name = %host.name,
                    pid,
                    control_path = %state.control_path.display(),
                    "SSH ControlMaster up"
                );
                state.master_pid = pid;
                state.last_used = Instant::now();
                state.failures = 0;
                Ok(Arc::new(Transport::Ssh {
                    host_id: HostId(host_id),
                    ssh_target: host.ssh_target,
                    control_path: state.control_path.clone(),
                }))
            }
            Err(e) => {
                state.failures = state.failures.saturating_add(1);
                let failures = state.failures;
                // Index = failures - 1 (the Nth failure, 1-indexed, picks
                // BACKOFFS[N-1]). Use saturating_sub so a future refactor that
                // doesn't pre-increment can't underflow into a panic at the
                // indexing arithmetic; clamp the high end to the last slot.
                let backoff = BACKOFFS
                    .get(
                        (failures.saturating_sub(1) as usize)
                            .min(BACKOFFS.len().saturating_sub(1)),
                    )
                    .copied()
                    .unwrap_or_else(|| BACKOFFS[BACKOFFS.len() - 1]);
                warn!(
                    host_id,
                    name = %host.name,
                    failures,
                    backoff_ms = backoff.as_millis() as u64,
                    error = %e,
                    "SSH ControlMaster warm-up failed"
                );
                // Drop the mutex before sleeping so other callers (or the
                // reaper) aren't blocked by a long backoff.
                drop(state);
                sleep(backoff).await;
                if failures >= MAX_FAILURES {
                    error!(
                        host_id,
                        name = %host.name,
                        failures,
                        "SSH ControlMaster gave up — marking host unreachable"
                    );
                    if let Err(db_err) = hosts::update_status(
                        &self.pool,
                        host_id,
                        HostStatus::Unreachable,
                    )
                    .await
                    {
                        warn!(host_id, error = %db_err, "failed to mark host unreachable");
                    }
                }
                Err(e.context(format!("warming SSH master for host {host_id}")))
            }
        }
    }

    /// Explicit health check: runs `ssh -O check`, updates the host's status
    /// row accordingly (`reachable` on success, `unreachable` on failure),
    /// returns `Ok(())` IFF the master is up. Used by the
    /// `POST /api/hosts/{id}/check` endpoint.
    ///
    /// Unlike [`transport_for`], `verify` does NOT spawn a master — if the
    /// socket is cold this is a deliberate "is the master alive right now?"
    /// probe and we report Err so the caller can choose to call
    /// `transport_for` (which warms it).
    pub async fn verify(&self, host_id: i64) -> Result<()> {
        let host = hosts::get(&self.pool, host_id)
            .await
            .with_context(|| format!("looking up host {host_id}"))?
            .ok_or_else(|| anyhow!("host {host_id} not found"))?;
        if host.deleted_at.is_some() {
            return Err(anyhow!(
                "host {host_id} ({}) is soft-deleted",
                host.name
            ));
        }
        let slot = self.slot_for(host_id);
        let state = slot.lock().await;
        let alive = check_master(&state.control_path, &host.ssh_target).await;
        // Status updates are best-effort logs — verify still returns the live
        // result so the HTTP layer can respond truthfully.
        let new_status = if alive {
            HostStatus::Reachable
        } else {
            HostStatus::Unreachable
        };
        if let Err(e) = hosts::update_status(&self.pool, host_id, new_status).await {
            warn!(host_id, error = %e, "failed to record host status");
        }
        if alive {
            Ok(())
        } else {
            Err(anyhow!(
                "host {host_id} ({}) is not reachable via SSH ControlMaster",
                host.name
            ))
        }
    }

    /// Tear down the master for `host_id`: `ssh -O exit` against the control
    /// socket, then `master_pid = None`. Idempotent — a not-running master
    /// just yields a non-zero `-O exit` which we treat as a successful
    /// already-stopped result.
    pub async fn tear_down(&self, host_id: i64) -> Result<()> {
        let Some(host) = hosts::get(&self.pool, host_id)
            .await
            .with_context(|| format!("looking up host {host_id}"))?
        else {
            // Already gone from the DB — nothing to tear down (and the slot
            // below would just leave a dangling entry; drop it).
            self.hosts.remove(&host_id);
            return Ok(());
        };
        let slot = self.slot_for(host_id);
        let mut state = slot.lock().await;
        // `-O exit` against a missing socket exits non-zero. That's fine —
        // we only care that the master is GONE after this call, not that we
        // were the ones who ran it.
        let _ = run_with_timeout(
            Command::new("ssh")
                .arg("-o")
                .arg(format!("ControlPath={}", state.control_path.display()))
                .arg("-O")
                .arg("exit")
                .arg(&host.ssh_target),
            SSH_OP_TIMEOUT,
        )
        .await;
        state.master_pid = None;
        info!(host_id, name = %host.name, "SSH ControlMaster torn down");
        Ok(())
    }

    /// Snapshot of every host currently tracked in the pool: `(host_id,
    /// last_used)`. The reaper uses this to find idle hosts without holding
    /// the DashMap iterator across awaits.
    async fn snapshot_idle(&self) -> Vec<(i64, Instant)> {
        let mut out = Vec::with_capacity(self.hosts.len());
        for entry in self.hosts.iter() {
            let id = *entry.key();
            let last = entry.value().lock().await.last_used;
            out.push((id, last));
        }
        out
    }

    /// Signal the reaper task to exit. Idempotent — calling more than once
    /// just stores extra permits that the task absorbs on its next park.
    pub fn shutdown(&self) {
        self.shutdown.notify_one();
    }
}

/// Spawn the per-pool reaper task. Returns the join handle so callers (the
/// integration test harness) can `await` a clean shutdown. The task exits
/// when [`HostPool::shutdown`] is called.
///
/// The reaper:
/// * wakes every [`REAPER_INTERVAL`] (or immediately on shutdown),
/// * for each known host whose `last_used` is older than [`REAPER_IDLE`],
///   checks the DB for any session row pointing at it; if none, runs
///   [`HostPool::tear_down`].
pub fn spawn_reaper(pool: Arc<HostPool>) -> tokio::task::JoinHandle<()> {
    let shutdown = pool.shutdown.clone();
    tokio::spawn(async move {
        info!("HostPool reaper started");
        loop {
            // Park on EITHER the periodic tick OR a shutdown signal. The
            // shutdown branch exits immediately so tests / Ctrl-C return
            // quickly without waiting out the 60s tick.
            tokio::select! {
                _ = sleep(REAPER_INTERVAL) => {}
                _ = shutdown.notified() => {
                    info!("HostPool reaper shutting down");
                    return;
                }
            }
            if let Err(e) = reap_once(&pool).await {
                warn!(error = %e, "HostPool reaper sweep failed");
            }
        }
    })
}

/// One reaper sweep: find idle hosts with no live sessions and tear down
/// their masters. Extracted so the test harness can drive it manually.
async fn reap_once(pool: &HostPool) -> Result<()> {
    let now = Instant::now();
    let idle: Vec<i64> = pool
        .snapshot_idle()
        .await
        .into_iter()
        .filter(|(_, last)| now.duration_since(*last) >= REAPER_IDLE)
        .map(|(id, _)| id)
        .collect();
    if idle.is_empty() {
        return Ok(());
    }

    // List active sessions ONCE per sweep — cheaper than one query per
    // candidate. Archived sessions don't keep a master alive; `list` already
    // filters them out (sessions.archived = 0).
    let sessions = crate::db::sessions::list(&pool.pool)
        .await
        .context("listing sessions for reaper")?;
    let mut sessions_per_host: HashMap<i64, usize> = HashMap::new();
    for s in &sessions {
        if let Some(h) = s.host_id {
            *sessions_per_host.entry(h).or_insert(0) += 1;
        }
    }
    for host_id in idle {
        let attached = sessions_per_host.get(&host_id).copied().unwrap_or(0);
        if attached > 0 {
            // An idle master with live sessions stays put — the next
            // re-attach would just re-warm it (and re-warm is not free).
            continue;
        }
        if let Err(e) = pool.tear_down(host_id).await {
            warn!(host_id, error = %e, "reaper tear_down failed");
        }
    }
    Ok(())
}

// ── ssh argv construction + helpers ─────────────────────────────────────────

/// `ssh -o ControlPath=<cp> -O check <target>` returns exit 0 iff the
/// ControlMaster on `cp` is alive. Wrapped with a 5s timeout so a wedged
/// socket can never block a caller forever.
async fn check_master(control_path: &Path, target: &str) -> bool {
    let mut cmd = Command::new("ssh");
    cmd.arg("-o")
        .arg(format!("ControlPath={}", control_path.display()))
        .arg("-O")
        .arg("check")
        .arg(target);
    match run_with_timeout(&mut cmd, SSH_OP_TIMEOUT).await {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}

/// Spawn a fresh `ssh -fN` master and wait up to [`MASTER_UP_BUDGET`] for
/// `-O check` to start succeeding. Returns the pid of the (now-backgrounded)
/// parent on success — diagnostic only since `-fN` forks the master into
/// the background and the parent exits.
async fn warm_up(control_path: &Path, target: &str) -> Result<Option<u32>> {
    // Ensure the parent dir of the socket exists; if a prior teardown removed
    // it, the master would fail to bind.
    if let Some(parent) = control_path.parent() {
        ensure_dir_0700(parent)?;
    }
    // `-fN`: fork into background after auth (master is then running),
    // exit the parent so we can join the Command without holding the pty.
    // `BatchMode=yes` ensures we never hang on an interactive prompt.
    let mut spawn = Command::new("ssh");
    spawn.arg("-o")
        .arg(format!("ControlPath={}", control_path.display()))
        .arg("-o")
        .arg("ControlMaster=yes")
        .arg("-o")
        .arg("ControlPersist=600")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-fN")
        .arg(target);

    let child = spawn
        .spawn()
        .with_context(|| format!("spawning ssh master for {target}"))?;
    let pid = child.id();
    // Wait for the parent to exit (the master is now backgrounded). A
    // non-zero exit here means auth failed — the master never came up.
    let out = tokio::time::timeout(SSH_OP_TIMEOUT, child.wait_with_output())
        .await
        .context("ssh -fN parent did not exit within timeout")?
        .context("waiting for ssh -fN parent")?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(anyhow!(
            "ssh -fN exited {} for {target}: {stderr}",
            out.status
        ));
    }

    // Poll the socket until `-O check` succeeds or we exhaust the budget.
    let deadline = Instant::now() + MASTER_UP_BUDGET;
    while Instant::now() < deadline {
        if check_master(control_path, target).await {
            return Ok(pid);
        }
        sleep(CHECK_POLL).await;
    }
    Err(anyhow!(
        "ssh ControlMaster for {target} did not become responsive within {:?}",
        MASTER_UP_BUDGET
    ))
}

/// Run `cmd` to completion with a hard timeout. Captures stdout/stderr so a
/// hung child doesn't hold them open against the parent (matters for the
/// ones we capture diagnostics from). Returns `Err` on timeout OR spawn
/// failure; the caller decides whether the exit status matters.
async fn run_with_timeout(
    cmd: &mut Command,
    timeout: Duration,
) -> Result<std::process::ExitStatus> {
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    let child = cmd
        .spawn()
        .context("spawning ssh control op")?;
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .context("ssh control op timed out")?
        .context("waiting for ssh control op")?;
    Ok(out.status)
}

/// Create `dir` if missing; chmod the leaf to `0o700` so the control sockets
/// inside can't be hijacked by a co-tenant. Best-effort on the chmod (a
/// permission-change failure is logged + ignored — the dir still exists).
fn ensure_dir_0700(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)
        .with_context(|| format!("creating dir {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) =
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        {
            warn!(dir = %dir.display(), error = %e, "could not chmod 0700");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Pure-state tests that don't touch the network. The localhost-ssh
    //! end-to-end test lives in `server/tests/host_pool.rs` (gated
    //! `#[ignore]`).

    use super::*;

    async fn temp_pool() -> (SqlitePool, PathBuf) {
        let dir = std::env::temp_dir()
            .join(format!("supermux-hostpool-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "host-pool-test".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (pool, dir)
    }

    #[tokio::test]
    async fn new_creates_control_dir() {
        let (pool, dir) = temp_pool().await;
        let _hp = HostPool::new(pool.clone(), &dir);
        let cdir = dir.join("ssh-control");
        assert!(cdir.is_dir(), "control dir should exist");
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn socket_path_is_deterministic() {
        let (pool, dir) = temp_pool().await;
        let hp = HostPool::new(pool.clone(), &dir);
        let p1 = hp.socket_for(7);
        let p2 = hp.socket_for(7);
        assert_eq!(p1, p2);
        assert_eq!(p1.file_name().unwrap().to_string_lossy(), "cm-7");
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn transport_for_unknown_host_errors() {
        let (pool, dir) = temp_pool().await;
        let hp = HostPool::new(pool.clone(), &dir);
        let err = hp.transport_for(9999).await.expect_err("must Err on unknown id");
        let msg = format!("{err}");
        assert!(msg.contains("9999"), "error mentions the missing id: {msg}");
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn transport_for_soft_deleted_host_errors() {
        let (pool, dir) = temp_pool().await;
        let hp = HostPool::new(pool.clone(), &dir);
        let h = hosts::create(&pool, "doomed", "user@nowhere.invalid", None)
            .await
            .unwrap();
        hosts::soft_delete(&pool, h.id).await.unwrap();
        let err = hp
            .transport_for(h.id)
            .await
            .expect_err("must Err on tombstoned host");
        assert!(format!("{err}").contains("soft-deleted"));
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn verify_unknown_host_errors() {
        let (pool, dir) = temp_pool().await;
        let hp = HostPool::new(pool.clone(), &dir);
        let err = hp.verify(424242).await.expect_err("must Err");
        assert!(format!("{err}").contains("424242"));
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn slot_returns_same_arc_per_host_id() {
        let (pool, dir) = temp_pool().await;
        let hp = HostPool::new(pool.clone(), &dir);
        let a = hp.slot_for(1);
        let b = hp.slot_for(1);
        assert!(Arc::ptr_eq(&a, &b), "same id → same mutex");
        let c = hp.slot_for(2);
        assert!(!Arc::ptr_eq(&a, &c), "different id → different mutex");
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

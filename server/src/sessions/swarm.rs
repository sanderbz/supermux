//! Reaper for leaked Claude agent-team tmux servers.
//!
//! Agent teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) start one private tmux
//! server per team on socket `claude-swarm-<leadpid>` under TMUX_TMPDIR.
//! Nothing upstream tears that server down when the lead agent exits, so every
//! finished team leaves a detached server full of idle teammate processes
//! (~4% of a core and ~280 MB RSS each; enough of them once OOM-thrashed the
//! host, see the 2026-08-06 incident).
//!
//! Two mechanisms, both in this module:
//!   * targeted teardown at session end (`lead_pid_of` + `spawn_teardown_for_lead`),
//!     wired into lifecycle stop/archive/delete and the SessionEnd hook;
//!   * a periodic sweep (`spawn_reaper` / `sweep_once`) as the safety net for
//!     leads that die without an event (OOM kill, crash), plus stale socket
//!     file cleanup. Kill requires ALL of: lead PID dead, no attached tmux
//!     clients, server older than a grace period. A live PID is never trusted
//!     as "active" (PID recycling); it only ever means "keep", the safe side.

use anyhow::{Context, Result};
use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const SOCKET_PREFIX: &str = "claude-swarm-";

/// Socket names this module is allowed to garbage-collect stale FILES for.
/// `supermux-sync-test-*` are leftovers from this crate's own tmux tests.
fn is_reapable_socket_name(name: &str) -> bool {
    name.starts_with(SOCKET_PREFIX) || name.starts_with("supermux-sync-test-")
}

/// `claude-swarm-<pid>` -> `<pid>`. The pid is the lead agent's PID at spawn.
pub fn parse_lead_pid(socket_name: &str) -> Option<u32> {
    socket_name.strip_prefix(SOCKET_PREFIX)?.parse().ok()
}

pub fn pid_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// Field 22 (starttime, clock ticks since boot) of /proc/<pid>/stat. comm
/// (field 2) may contain spaces and ')', so split after the LAST ')'.
fn starttime_ticks(stat: &str) -> Option<u64> {
    let rest = stat.rsplit_once(')')?.1;
    rest.split_ascii_whitespace().nth(19)?.parse().ok()
}

/// How long a process has been running, from /proc statistics.
pub fn process_age(pid: u32) -> Option<Duration> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let ticks = starttime_ticks(&stat)?;
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    let hz = if hz > 0 { hz as u64 } else { 100 };
    let uptime: f64 = std::fs::read_to_string("/proc/uptime")
        .ok()?
        .split_ascii_whitespace()
        .next()?
        .parse()
        .ok()?;
    let started = ticks as f64 / hz as f64;
    (uptime > started).then(|| Duration::from_secs_f64(uptime - started))
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Kill,
    Keep(&'static str),
}

/// The kill decision. Pure so the matrix is unit-testable. Every "unknown"
/// resolves to Keep: the periodic sweep runs forever, so a false Keep costs
/// one interval while a false Kill costs a live team.
pub fn decide(lead_alive: bool, has_clients: bool, age: Option<Duration>, grace: Duration) -> Verdict {
    if lead_alive {
        return Verdict::Keep("lead-alive");
    }
    if has_clients {
        return Verdict::Keep("has-clients");
    }
    match age {
        Some(a) if a >= grace => Verdict::Kill,
        Some(_) => Verdict::Keep("younger-than-grace"),
        None => Verdict::Keep("age-unknown"),
    }
}

/// tmux appends `tmux-<uid>` to TMUX_TMPDIR; sockets live in that subdir.
pub fn socket_dir(tmux_tmpdir: &Path) -> PathBuf {
    let uid = std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(0);
    tmux_tmpdir.join(format!("tmux-{uid}"))
}

#[derive(Debug)]
pub struct SwarmServer {
    pub server_pid: u32,
    pub socket_name: String,
    pub lead_pid: u32,
    pub age: Option<Duration>,
}

/// `Some(name)` when argv is a tmux invocation on a claude-swarm socket.
/// (The daemonized tmux server keeps the spawning client's argv, so matching
/// `tmux ... -L claude-swarm-<pid> ...` finds servers even after their socket
/// file was deleted, which is why we scan processes and not socket files.)
fn socket_arg<'a>(argv: &[&'a str]) -> Option<&'a str> {
    let first = Path::new(argv.first()?).file_name()?.to_str()?;
    if first != "tmux" {
        return None;
    }
    argv.windows(2)
        .find(|w| w[0] == "-L" && w[1].starts_with(SOCKET_PREFIX))
        .map(|w| w[1])
}

/// TMUX_TMPDIR from a process's environment. Readable only for own-uid
/// processes, which is also the only set we may kill.
///
/// `None` means we could not observe the environment at all (unreadable, or
/// empty as the kernel reports for a zombie). That must NOT collapse into the
/// default: an unobservable process would then match a sweep of /tmp and be
/// killed on no evidence. Only a successfully read environment that simply
/// lacks the variable falls back to tmux's compiled default, /tmp.
fn tmpdir_of(pid: u32) -> Option<PathBuf> {
    let environ = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    if environ.is_empty() {
        return None;
    }
    Some(
        environ
            .split(|b| *b == 0)
            .find_map(|kv| {
                std::str::from_utf8(kv)
                    .ok()?
                    .strip_prefix("TMUX_TMPDIR=")
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| PathBuf::from("/tmp")),
    )
}

/// All live claude-swarm tmux servers of OUR uid whose TMUX_TMPDIR matches
/// `tmux_tmpdir`. The tmpdir match keeps a sweep scoped to its own socket
/// namespace (and keeps the test suite from ever seeing production servers).
pub fn discover_servers(tmux_tmpdir: &Path) -> Vec<SwarmServer> {
    let mut found = Vec::new();
    let Ok(me) = std::fs::metadata("/proc/self") else { return found };
    let my_uid = me.uid();
    let canon = std::fs::canonicalize(tmux_tmpdir).unwrap_or_else(|_| tmux_tmpdir.to_path_buf());
    let Ok(proc_dir) = std::fs::read_dir("/proc") else { return found };
    for entry in proc_dir.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else { continue };
        if meta.uid() != my_uid {
            continue;
        }
        let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else { continue };
        let argv: Vec<&str> = cmdline
            .split(|b| *b == 0)
            .filter_map(|s| std::str::from_utf8(s).ok())
            .filter(|s| !s.is_empty())
            .collect();
        let Some(sock) = socket_arg(&argv) else { continue };
        let Some(lead_pid) = parse_lead_pid(sock) else { continue };
        let Some(theirs) = tmpdir_of(pid) else { continue };
        let theirs = std::fs::canonicalize(&theirs).unwrap_or(theirs);
        if theirs != canon {
            continue;
        }
        found.push(SwarmServer {
            server_pid: pid,
            socket_name: sock.to_string(),
            lead_pid,
            age: process_age(pid),
        });
    }
    found
}

/// A tmux client talking to a wedged server can block in connect() forever.
/// Every call below is bounded so one sick server cannot stall the whole sweep.
const TMUX_TIMEOUT: Duration = Duration::from_secs(10);

/// Raw tmux invocation. `Ok` whenever tmux actually ran and exited, whatever its
/// status; `Err` only when it could not be run or did not come back in time.
/// Callers that must distinguish "tmux says no server" from "we learned
/// nothing" need that split, so the exit status is NOT folded in here.
///
/// `LC_ALL=C` is not cosmetic: `classify_probe_stderr` matches tmux's English
/// wording plus the C-locale `strerror` text. On a host with a localized locale
/// every probe would otherwise fall through to `Unknown`, so no socket file
/// would ever be garbage-collected and no socketless server ever reaped.
async fn tmux_output(tmux_tmpdir: &Path, args: &[&str]) -> Result<std::process::Output> {
    let bin = which::which("tmux").context("tmux not on PATH")?;
    let run = tokio::process::Command::new(bin)
        .env("TMUX_TMPDIR", tmux_tmpdir)
        .env("LC_ALL", "C")
        .args(args)
        .kill_on_drop(true) // do not leave a hung client behind on timeout
        .output();
    match tokio::time::timeout(TMUX_TIMEOUT, run).await {
        Ok(res) => res.with_context(|| format!("running tmux {args:?}")),
        Err(_) => anyhow::bail!("tmux {:?} timed out after {:?}", args, TMUX_TIMEOUT),
    }
}

async fn run_tmux(tmux_tmpdir: &Path, args: &[&str]) -> Result<String> {
    let out = tmux_output(tmux_tmpdir, args).await?;
    if !out.status.success() {
        anyhow::bail!("tmux {:?}: {}", args, String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Are any tmux clients attached to this socket's server?
///
/// `Err` means "we did not learn anything", which every caller reads as Keep.
/// The ONE failure that is still an answer is tmux reporting that nothing is
/// listening on the socket at all: no listener means no attached client, so
/// `Ok(false)`. That case is the socketless server (its socket file was
/// deleted, or never made it): no tmux client can reach it, yet it is still a
/// live process holding memory, and the pid-verified escalation inside
/// `kill_server` can take it down. Without this the clients check would error
/// forever and both callers would keep such a server for good.
async fn has_clients(tmux_tmpdir: &Path, socket_name: &str) -> Result<bool> {
    let out = tmux_output(tmux_tmpdir, &["-L", socket_name, "list-clients"]).await?;
    if out.status.success() {
        return Ok(!String::from_utf8_lossy(&out.stdout).trim().is_empty());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    match classify_probe_stderr(&stderr) {
        Probe::NoServer => Ok(false),
        // anything else (unreadable socket, unsafe dir permissions, unknown
        // wording) is not an answer: stay on the Keep side
        _ => anyhow::bail!("tmux list-clients on {socket_name}: {}", stderr.trim()),
    }
}

/// What a socket probe established. `Unknown` is the honest third answer, and
/// keeping it separate from `NoServer` is what stops the GC from unlinking a
/// live server's socket whenever tmux fails for an unrelated reason.
#[derive(Debug, PartialEq)]
enum Probe {
    Answers,
    NoServer,
    Unknown(String),
}

/// Classify a FAILED tmux client call (`list-sessions`, `list-clients`) from
/// its stderr. Pure, so the wording rules are testable without tmux. Callers
/// run tmux under `LC_ALL=C` so this English matching holds on any host.
///
/// tmux prints "no server running on X" only for ECONNREFUSED; for every OTHER
/// errno it falls back to "error connecting to X (<strerror>)". So the second
/// form is NOT evidence of death by itself: a live server whose socket is
/// merely unreadable reports "error connecting to X (Permission denied)".
/// Only the two errnos that genuinely mean "nothing is listening here" count.
fn classify_probe_stderr(stderr: &str) -> Probe {
    let lowered = stderr.trim().to_lowercase();
    let definitive = lowered.ends_with("(no such file or directory)") || lowered.ends_with("(connection refused)");
    if lowered.contains("no server running") || (lowered.contains("error connecting") && definitive) {
        Probe::NoServer
    } else {
        Probe::Unknown(stderr.trim().to_string())
    }
}

/// Is a live server listening on this socket? `list-sessions` never starts a
/// server (verified against tmux behaviour), so probing is side effect free.
///
/// Anything short of a definitive "nothing is listening" (unsafe socket dir
/// permissions, an unreadable socket, tmux missing, a timeout, a version whose
/// wording we do not know) is `Unknown` and leaves the file alone.
async fn probe_socket(tmux_tmpdir: &Path, socket_name: &str) -> Probe {
    let out = match tmux_output(tmux_tmpdir, &["-L", socket_name, "list-sessions"]).await {
        Ok(out) => out,
        Err(e) => return Probe::Unknown(e.to_string()),
    };
    if out.status.success() {
        return Probe::Answers;
    }
    classify_probe_stderr(&String::from_utf8_lossy(&out.stderr))
}

/// Is `pid` STILL the tmux server for `socket_name`? Discovery and the signal
/// escalation below are separated by seconds of waiting, and a sweep can sit
/// behind other servers for much longer, so the pid may have been recycled onto
/// an unrelated process in between. Re-reading the live argv makes each bare-pid
/// signal target the process we actually decided to kill, not whoever inherited
/// its number.
///
/// The uid check is part of that: a recycled pid can land on a process of a
/// different user, and signalling one of those is never ours to do (it would
/// also just fail with EPERM). Discovery already filters on uid, so this keeps
/// the same rule on the signalling side.
fn still_our_server(pid: u32, socket_name: &str) -> bool {
    let Ok(me) = std::fs::metadata("/proc/self") else { return false };
    let Ok(theirs) = std::fs::metadata(format!("/proc/{pid}")) else { return false };
    if theirs.uid() != me.uid() {
        return false;
    }
    let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else { return false };
    let argv: Vec<&str> = cmdline
        .split(|b| *b == 0)
        .filter_map(|s| std::str::from_utf8(s).ok())
        .filter(|s| !s.is_empty())
        .collect();
    socket_arg(&argv) == Some(socket_name)
}

/// kill-server, then escalate to SIGTERM/SIGKILL on the server process if it
/// survives (covers a wedged server or a server whose socket file is gone,
/// where the tmux client cannot connect at all). Every escalation step
/// re-verifies the pid first: a pid that is dead OR no longer this server means
/// the job is done, never a reason to signal.
async fn kill_server(tmux_tmpdir: &Path, socket_name: &str, server_pid: u32) -> Result<()> {
    let gone = || !pid_alive(server_pid) || !still_our_server(server_pid, socket_name);

    let _ = run_tmux(tmux_tmpdir, &["-L", socket_name, "kill-server"]).await;
    for _ in 0..10 {
        if gone() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    let pid = Pid::from_raw(server_pid as i32);
    if gone() {
        return Ok(());
    }
    let _ = kill(pid, Signal::SIGTERM);
    for _ in 0..10 {
        if gone() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    if gone() {
        return Ok(());
    }
    let _ = kill(pid, Signal::SIGKILL);
    tokio::time::sleep(Duration::from_millis(200)).await;
    if !gone() {
        anyhow::bail!("server pid {server_pid} survived SIGKILL");
    }
    Ok(())
}

#[derive(Debug, Default, serde::Serialize)]
pub struct SweepOutcome {
    pub killed: Vec<String>,
    pub kept: Vec<(String, &'static str)>,
    pub sockets_removed: Vec<String>,
    pub errors: Vec<String>,
}

/// One full sweep: evaluate every live swarm server against the kill rules,
/// then garbage-collect socket FILES that no live server answers on. With
/// `dry_run` every decision is reported and nothing is touched.
pub async fn sweep_once(tmux_tmpdir: &Path, grace: Duration, dry_run: bool) -> Result<SweepOutcome> {
    let mut out = SweepOutcome::default();
    let servers = discover_servers(tmux_tmpdir);

    for srv in &servers {
        let lead_alive = pid_alive(srv.lead_pid);
        // clients only matter when the lead is dead; skip the subprocess otherwise
        let clients = if lead_alive {
            false
        } else {
            match has_clients(tmux_tmpdir, &srv.socket_name).await {
                Ok(c) => c,
                Err(e) => {
                    out.errors.push(format!("{}: clients check failed: {e}", srv.socket_name));
                    out.kept.push((srv.socket_name.clone(), "clients-check-failed"));
                    continue;
                }
            }
        };
        match decide(lead_alive, clients, srv.age, grace) {
            Verdict::Keep(why) => {
                tracing::debug!(socket = %srv.socket_name, why, "swarm sweep: keeping server");
                out.kept.push((srv.socket_name.clone(), why));
            }
            Verdict::Kill => {
                tracing::info!(
                    socket = %srv.socket_name,
                    server_pid = srv.server_pid,
                    lead_pid = srv.lead_pid,
                    age_secs = srv.age.map(|a| a.as_secs()),
                    dry_run,
                    "swarm sweep: reaping stale agent-team tmux server"
                );
                if !dry_run {
                    if let Err(e) = kill_server(tmux_tmpdir, &srv.socket_name, srv.server_pid).await {
                        out.errors.push(format!("{}: kill failed: {e}", srv.socket_name));
                        continue;
                    }
                }
                out.killed.push(srv.socket_name.clone());
            }
        }
    }

    // Stale socket FILES: anything matching our patterns that tmux positively
    // reports nothing is listening on. Unlinking is only ever justified by a
    // conclusive "dead" answer, since the file may belong to a running server we
    // never discovered. Servers kept above still answer and are skipped.
    let kept_names: HashSet<&str> = out.kept.iter().map(|(n, _)| n.as_str()).collect();
    if let Ok(rd) = std::fs::read_dir(socket_dir(tmux_tmpdir)) {
        for f in rd.flatten() {
            let Some(name) = f.file_name().to_str().map(str::to_owned) else { continue };
            if !is_reapable_socket_name(&name) || kept_names.contains(name.as_str()) {
                continue;
            }
            match probe_socket(tmux_tmpdir, &name).await {
                Probe::NoServer => {}
                // a live server we did not discover: leave it alone
                Probe::Answers => continue,
                // learned nothing, so we have no licence to unlink
                Probe::Unknown(why) => {
                    tracing::warn!(socket = %name, why, "swarm sweep: socket probe inconclusive, leaving file");
                    out.errors.push(format!("{name}: socket probe inconclusive: {why}"));
                    continue;
                }
            }
            if !dry_run {
                // ENOENT is the goal state, not a failure: a targeted teardown
                // or a second CLI run may have unlinked the same file between
                // our probe and this call.
                if let Err(e) = std::fs::remove_file(f.path()) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        out.errors.push(format!("{name}: unlink failed: {e}"));
                        continue;
                    }
                }
            }
            out.sockets_removed.push(name);
        }
    }
    Ok(out)
}

/// How long the targeted teardown waits for the lead to actually die after a
/// session stop (the pane kill and the agent's exit are asynchronous).
const TEARDOWN_LEAD_WAIT: Duration = Duration::from_secs(30);

/// Unlink a leftover socket FILE, but only on a conclusive "nothing is
/// listening here". Same rule as the sweep's GC: an inconclusive probe is not
/// evidence of death, and the file may still belong to a running server.
async fn gc_socket_file(tmux_tmpdir: &Path, socket_name: &str) {
    let path = socket_dir(tmux_tmpdir).join(socket_name);
    if !path.exists() {
        return;
    }
    match probe_socket(tmux_tmpdir, socket_name).await {
        Probe::NoServer => {
            // same as the sweep's GC: an already-gone file is the goal state
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(socket = %socket_name, error = %e, "swarm teardown: socket unlink failed");
                }
            }
        }
        // something still answers there: not ours to remove
        Probe::Answers => {}
        Probe::Unknown(why) => {
            tracing::warn!(socket = %socket_name, why, "swarm teardown: socket probe inconclusive, leaving file");
        }
    }
}

/// Tear down the `claude-swarm-<lead_pid>` server after its lead died.
/// Waits briefly for the lead to disappear; if it never does, leaves the
/// server to the periodic sweep rather than kill a live team. Returns whether
/// a server was killed.
pub async fn teardown_for_lead(tmux_tmpdir: &Path, lead_pid: u32) -> Result<bool> {
    let deadline = tokio::time::Instant::now() + TEARDOWN_LEAD_WAIT;
    while pid_alive(lead_pid) {
        if tokio::time::Instant::now() >= deadline {
            tracing::debug!(lead_pid, "swarm teardown: lead still alive, deferring to sweep");
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let socket_name = format!("{SOCKET_PREFIX}{lead_pid}");
    let Some(srv) = discover_servers(tmux_tmpdir)
        .into_iter()
        .find(|s| s.socket_name == socket_name)
    else {
        // no server: still GC a stale socket file if one lingers
        gc_socket_file(tmux_tmpdir, &socket_name).await;
        return Ok(false);
    };
    // A human attached to inspect the team keeps it alive; the sweep handles it
    // later. A clients check that FAILS is not an answer either: same rule as
    // the sweep, an unanswered question never justifies a kill here.
    match has_clients(tmux_tmpdir, &socket_name).await {
        Ok(false) => {}
        Ok(true) => {
            tracing::info!(socket = %socket_name, "swarm teardown: clients attached, skipping");
            return Ok(false);
        }
        Err(e) => {
            tracing::warn!(socket = %socket_name, error = %e, "swarm teardown: clients check failed, deferring to sweep");
            return Ok(false);
        }
    }
    kill_server(tmux_tmpdir, &socket_name, srv.server_pid).await?;
    gc_socket_file(tmux_tmpdir, &socket_name).await;
    Ok(true)
}

/// Fire-and-forget wrapper for the session-end paths: must never block or
/// fail a stop/archive/delete. TMUX_TMPDIR is process-wide (set in main.rs);
/// its absence (tests, bare dev runs) falls back to tmux's default /tmp.
pub fn spawn_teardown_for_lead(lead_pid: u32) {
    let dir = std::env::var_os("TMUX_TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    tokio::spawn(async move {
        match teardown_for_lead(&dir, lead_pid).await {
            Ok(true) => {
                tracing::info!(lead_pid, "tore down agent-team tmux server for ended session")
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(lead_pid, error = %e, "agent-team teardown failed"),
        }
    });
}

/// The pane's foreground process-group leader, i.e. the running agent's PID.
/// `None` when the pane sits at the shell prompt (fg pgid == the shell) or the
/// pane is already gone. This is the pid agent teams name their socket after.
///
/// **Assumption: the lead agent runs in the window's FIRST pane.** A
/// session-targeted `pane_pid()` is `tmux list-panes -t <session>` and takes the
/// first line, i.e. the pane with the lowest index. Agent Teams renders
/// teammates as `split-window` panes of the same window, and a split is always
/// inserted after the current pane, so the lead keeps index 0 and the first
/// line is its shell. `teams::resolve_lead_pane` exists for the input path, but
/// it cannot help here: `tmux list-panes -t %id` resolves a pane target to its
/// WINDOW and lists every pane of it (measured), so pinning the runtime to the
/// resolved lead pane returns the first pane's pid all the same.
///
/// If the assumption is ever broken (panes swapped, the original lead pane
/// killed) we read a teammate's pid, the derived socket name matches no server,
/// and the targeted teardown simply finds nothing to do. The periodic sweep
/// then reaps the real server once it passes the grace period, so the cost is
/// bounded by grace + one sweep interval, never a wrong kill.
pub async fn lead_pid_of(rt: &dyn crate::sessions::runtime::SessionRuntime) -> Option<u32> {
    let shell = rt.pane_pid().await.ok().flatten()?;
    let fg = crate::sessions::native::runtime::foreground_pgid(shell)?;
    (fg != shell).then_some(fg)
}

/// Periodic safety net: sweep on a config cadence. The FIRST tick fires
/// immediately (tokio interval semantics), which doubles as the boot sweep
/// that reclaims servers orphaned by a supermux crash or OOM kill.
pub fn spawn_reaper(state: crate::state::AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let cfg = state.config.swarm_reaper.clone();
        if !cfg.enabled {
            tracing::info!("swarm reaper disabled by config");
            return;
        }
        let grace = Duration::from_secs(cfg.grace_secs);
        // clamped: a config asking for a tighter cadence than 60s does not get one
        let effective_interval_secs = cfg.interval_secs.max(60);
        let mut tick = tokio::time::interval(Duration::from_secs(effective_interval_secs));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        tracing::info!(
            grace_secs = cfg.grace_secs,
            interval_secs = cfg.interval_secs,
            effective_interval_secs,
            "swarm reaper started"
        );
        loop {
            tick.tick().await;
            // TMUX_TMPDIR is set process-wide in main.rs before any task spawns
            let dir = std::env::var_os("TMUX_TMPDIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/tmp"));
            match sweep_once(&dir, grace, false).await {
                Ok(out) => {
                    for e in &out.errors {
                        tracing::warn!(error = %e, "swarm sweep item failed");
                    }
                    if out.killed.is_empty() && out.sockets_removed.is_empty() {
                        continue;
                    }
                    // Durable trail for a destructive background action: the whole
                    // outcome, names and all (`SweepOutcome` is Serialize for
                    // exactly this), so a later "what happened to my team server"
                    // can be answered from the row alone.
                    let detail = serde_json::to_value(&out).unwrap_or_else(|e| {
                        serde_json::json!({
                            "killed": out.killed,
                            "detail_serialize_failed": e.to_string(),
                        })
                    });
                    if let Err(e) =
                        crate::db::audit::log(&state.pool, "reaper", "swarm.sweep", "swarm", detail)
                            .await
                    {
                        tracing::warn!(error = %e, "swarm sweep audit write failed");
                    }
                    if !out.killed.is_empty() {
                        let _ = state.sse_tx.send(crate::state::SseEvent {
                            event: "alerts".to_string(),
                            payload: serde_json::json!({
                                "level": "info",
                                "source": "reaper",
                                "detail": format!(
                                    "swarm reaper: killed {} stale agent-team tmux server(s)",
                                    out.killed.len()
                                ),
                            }),
                        });
                    }
                }
                Err(e) => tracing::warn!(error = %e, "swarm reaper sweep failed"),
            }
        }
    })
}

#[derive(Debug, Default)]
struct CliArgs {
    dry_run: bool,
    grace: Option<Duration>,
}

impl CliArgs {
    fn parse<I: Iterator<Item = String>>(mut it: I) -> Result<Self> {
        let mut args = CliArgs::default();
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--dry-run" => args.dry_run = true,
                "--grace-secs" => {
                    let v = it
                        .next()
                        .and_then(|v| v.parse().ok())
                        .context("--grace-secs needs a number of seconds")?;
                    args.grace = Some(Duration::from_secs(v));
                }
                other => anyhow::bail!(
                    "swarm-reaper: unexpected argument {other:?} (known: --dry-run, --grace-secs N)"
                ),
            }
        }
        Ok(args)
    }
}

/// `supermux-server swarm-reaper [--dry-run] [--grace-secs N]`: one sweep,
/// human-readable report on stdout, non-zero exit when any item errored.
/// Runs without DB or listener; safe alongside a live daemon (the sweep is
/// idempotent and both sides only ever kill servers that met the rules).
pub async fn cli<I: Iterator<Item = String>>(argv: I) -> Result<()> {
    let args = CliArgs::parse(argv)?;
    // mirror the daemon's TMUX_TMPDIR resolution: env override, else <data_dir>/tmux
    let dir = match std::env::var_os("TMUX_TMPDIR") {
        Some(d) => PathBuf::from(d),
        None => crate::config::load()?.data_dir.join("tmux"),
    };
    let grace = args.grace.unwrap_or(Duration::from_secs(
        crate::config::SwarmReaperConfig::default().grace_secs,
    ));
    let out = sweep_once(&dir, grace, args.dry_run).await?;
    for (name, why) in &out.kept {
        println!("KEEP        {name}  ({why})");
    }
    for name in &out.killed {
        println!("{} {name}", if args.dry_run { "WOULD-KILL " } else { "KILLED     " });
    }
    for name in &out.sockets_removed {
        println!("{} {name}  (stale socket file)", if args.dry_run { "WOULD-RM   " } else { "REMOVED    " });
    }
    // only when the sweep truly had nothing to report, errors included
    if out.kept.is_empty()
        && out.killed.is_empty()
        && out.sockets_removed.is_empty()
        && out.errors.is_empty()
    {
        println!("nothing to do: no claude-swarm servers or stale sockets found");
    }
    if !out.errors.is_empty() {
        for e in &out.errors {
            eprintln!("ERROR {e}");
        }
        anyhow::bail!("{} error(s) during sweep", out.errors.len());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn parses_lead_pid_from_socket_name() {
        assert_eq!(parse_lead_pid("claude-swarm-1199149"), Some(1199149));
        assert_eq!(parse_lead_pid("claude-swarm-"), None);
        assert_eq!(parse_lead_pid("claude-swarm-abc"), None);
        assert_eq!(parse_lead_pid("supermux-sync-test-123"), None);
        assert_eq!(parse_lead_pid("default"), None);
    }

    #[test]
    fn starttime_parses_stat_with_parens_in_comm() {
        // comm can contain spaces and ')' - field 22 (starttime) is index 19
        // counting from the first field after the LAST ')'.
        let stat = "12345 (tmux: server (x)) S 1 12345 12345 0 -1 4194304 5 0 0 0 1 2 0 0 20 0 1 0 987654 1000000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
        assert_eq!(starttime_ticks(stat), Some(987654));
        assert_eq!(starttime_ticks("garbage"), None);
    }

    #[test]
    fn decide_matrix() {
        let h = Duration::from_secs(3600);
        // live lead always keeps, regardless of everything else
        assert!(matches!(decide(true, false, Some(h * 10), Duration::ZERO), Verdict::Keep("lead-alive")));
        // attached client keeps
        assert!(matches!(decide(false, true, Some(h * 10), Duration::ZERO), Verdict::Keep("has-clients")));
        // young server keeps
        assert!(matches!(decide(false, false, Some(h), h * 2), Verdict::Keep("younger-than-grace")));
        // unknown age keeps (safe direction)
        assert!(matches!(decide(false, false, None, Duration::ZERO), Verdict::Keep("age-unknown")));
        // dead lead + no clients + old enough kills
        assert!(matches!(decide(false, false, Some(h * 3), h * 2), Verdict::Kill));
        // exactly at the grace boundary kills (>=)
        assert!(matches!(decide(false, false, Some(h), h), Verdict::Kill));
    }

    #[test]
    fn socket_arg_matches_only_tmux_on_a_swarm_socket() {
        assert_eq!(socket_arg(&["tmux", "-L", "claude-swarm-42", "new-session"]), Some("claude-swarm-42"));
        assert_eq!(socket_arg(&["/usr/bin/tmux", "-L", "claude-swarm-42"]), Some("claude-swarm-42"));
        // not tmux, not ours to touch even on a matching socket name
        assert_eq!(socket_arg(&["vim", "-L", "claude-swarm-42"]), None);
        // some other tmux server sharing the box
        assert_eq!(socket_arg(&["tmux", "-L", "default"]), None);
        assert_eq!(socket_arg(&["tmux", "attach"]), None);
        assert_eq!(socket_arg(&[]), None);
    }

    #[test]
    fn probe_classification_needs_a_definitive_errno() {
        // ECONNREFUSED on a socket nobody listens on
        assert_eq!(classify_probe_stderr("no server running on /x\n"), Probe::NoServer);
        // the socket file is already gone
        assert_eq!(
            classify_probe_stderr("error connecting to /x (No such file or directory)\n"),
            Probe::NoServer
        );
        assert_eq!(classify_probe_stderr("error connecting to /x (Connection refused)"), Probe::NoServer);
        // "error connecting" is tmux's catch-all for every OTHER errno, and a
        // LIVE server behind an unreadable socket lands here. Unlinking on this
        // would pull the socket out from under a running server.
        assert!(matches!(
            classify_probe_stderr("error connecting to /x (Permission denied)"),
            Probe::Unknown(_)
        ));
        // measured on this box when the socket dir has group/other bits set
        assert!(matches!(
            classify_probe_stderr("directory /tmp/x/tmux-1002 has unsafe permissions"),
            Probe::Unknown(_)
        ));
        assert!(matches!(classify_probe_stderr("wat"), Probe::Unknown(_)));
        assert!(matches!(classify_probe_stderr(""), Probe::Unknown(_)));
    }

    #[test]
    fn still_our_server_rejects_wrong_and_dead_pids() {
        // our own process is not a tmux server on that socket
        assert!(!still_our_server(std::process::id(), "claude-swarm-1"));
        // a pid that cannot exist reads as gone, never as a signal target
        assert!(!still_our_server(4_294_967_290, "claude-swarm-1"));
    }

    #[test]
    fn pid_alive_self_and_bogus() {
        assert!(pid_alive(std::process::id()));
        // PID 4194304+ is above the default pid_max; can never exist
        assert!(!pid_alive(4_294_967_290));
    }

    #[test]
    fn cli_args_parse() {
        let a = CliArgs::parse(["--dry-run".to_string()].into_iter()).unwrap();
        assert!(a.dry_run);
        assert_eq!(a.grace, None);
        let a = CliArgs::parse(["--grace-secs".to_string(), "60".to_string()].into_iter()).unwrap();
        assert_eq!(a.grace, Some(Duration::from_secs(60)));
        assert!(CliArgs::parse(["--bogus".to_string()].into_iter()).is_err());
        assert!(CliArgs::parse(["--grace-secs".to_string()].into_iter()).is_err());
    }
}

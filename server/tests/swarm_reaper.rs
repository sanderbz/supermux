//! The swarm reaper against REAL tmux servers.
//!
//! The decision matrix and the stderr-wording rules are unit-tested inside
//! `sessions::swarm`; what needs a live tmux is the part that would be
//! catastrophic to get wrong — the sweep reaching outside its own
//! `TMUX_TMPDIR`, killing a team whose lead is alive, or unlinking a socket on
//! a probe that never actually answered. Every test spawns its servers in a
//! private temp `TMUX_TMPDIR`, so a run can never see production's.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;
use supermux_server::sessions::swarm;

fn tmux_available() -> bool {
    which::which("tmux").is_ok()
}

fn temp_tmpdir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("supermux-swarm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// tmux refuses a socket dir that grants ANY bit to group/other ("directory …
/// has unsafe permissions"), so a dir left at create_dir_all's 0755 makes every
/// probe fail for a reason unrelated to liveness. Hand-built socket dirs must be
/// 0700 or the test asserts nothing.
fn make_socket_dir(dir: &Path) -> PathBuf {
    let sockdir = swarm::socket_dir(dir);
    std::fs::create_dir_all(&sockdir).unwrap();
    std::fs::set_permissions(&sockdir, std::fs::Permissions::from_mode(0o700)).unwrap();
    sockdir
}

/// A detached private tmux server whose one pane runs `cat` forever — exactly
/// the shape Claude Code's agent teams leave behind.
fn spawn_swarm_server(tmpdir: &Path, socket: &str) {
    let status = std::process::Command::new("tmux")
        .env("TMUX_TMPDIR", tmpdir)
        .args(["-L", socket, "new-session", "-d", "-s", "claude-swarm", "cat"])
        .status()
        .expect("spawn tmux");
    assert!(status.success(), "tmux new-session failed");
}

fn server_running(tmpdir: &Path, socket: &str) -> bool {
    std::process::Command::new("tmux")
        .env("TMUX_TMPDIR", tmpdir)
        .args(["-L", socket, "list-sessions"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn kill_leftover(tmpdir: &Path, socket: &str) {
    let _ = std::process::Command::new("tmux")
        .env("TMUX_TMPDIR", tmpdir)
        .args(["-L", socket, "kill-server"])
        .status();
}

/// A pid guaranteed to be dead: spawn a no-op child, reap it, reuse its number.
/// (Immediate recycling of a just-reaped pid is astronomically unlikely.)
fn dead_pid() -> u32 {
    let mut child = std::process::Command::new("true").spawn().expect("spawn true");
    let pid = child.id();
    child.wait().unwrap();
    pid
}

/// The whole point of the reaper: a team whose lead is gone gets its server —
/// and the teammate processes inside it — taken down.
#[tokio::test]
async fn reaps_server_with_dead_lead() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let socket = format!("claude-swarm-{}", dead_pid());
    spawn_swarm_server(&dir, &socket);
    assert!(server_running(&dir, &socket));

    let out = swarm::sweep_once(&dir, Duration::ZERO).await.unwrap();

    assert!(
        out.killed.contains(&socket),
        "killed: {:?} kept: {:?} errors: {:?}",
        out.killed,
        out.kept,
        out.errors
    );
    let mut gone = false;
    for _ in 0..20 {
        if !server_running(&dir, &socket) {
            gone = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(gone, "server survived the sweep");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A running team must survive a sweep even with grace at zero: the live lead
/// pid is the only thing standing between it and the reaper.
#[tokio::test]
async fn keeps_server_with_live_lead() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    // our own pid: alive for the whole test by construction
    let socket = format!("claude-swarm-{}", std::process::id());
    spawn_swarm_server(&dir, &socket);

    let out = swarm::sweep_once(&dir, Duration::ZERO).await.unwrap();

    assert!(out.killed.is_empty(), "killed a live team: {:?}", out.killed);
    assert!(out
        .kept
        .iter()
        .any(|(n, why)| n == &socket && *why == "lead-alive"));
    assert!(server_running(&dir, &socket));
    kill_leftover(&dir, &socket);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Sweeping one `TMUX_TMPDIR` must be blind to servers in another. Without the
/// scoping a sweep would reach outside its own socket namespace — a test run
/// killing production's teams, or vice versa.
#[tokio::test]
async fn scopes_sweep_to_its_own_tmpdir() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let elsewhere = temp_tmpdir();
    let swept = temp_tmpdir();
    // dead lead + zero grace: maximally killable, so tmpdir scoping is the ONLY
    // thing protecting it.
    let socket = format!("claude-swarm-{}", dead_pid());
    spawn_swarm_server(&elsewhere, &socket);
    assert!(server_running(&elsewhere, &socket));

    let out = swarm::sweep_once(&swept, Duration::ZERO).await.unwrap();

    assert!(
        !out.killed.contains(&socket),
        "killed a server outside the swept tmpdir"
    );
    assert!(
        server_running(&elsewhere, &socket),
        "a sweep of one tmpdir reached into another"
    );
    kill_leftover(&elsewhere, &socket);
    let _ = std::fs::remove_dir_all(&elsewhere);
    let _ = std::fs::remove_dir_all(&swept);
}

/// Socket-file GC removes only files a probe positively answered "nothing is
/// listening" for, and never touches a socket that is not ours.
#[tokio::test]
async fn removes_only_dead_reapable_socket_files() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let sockdir = make_socket_dir(&dir);

    // A live server on a reapable name that discovery does NOT match (no lead
    // pid to parse), so only the liveness probe protects its file. This is the
    // regression guard for the probe: drop it and the GC unlinks the socket out
    // from under a running server.
    let live = format!("supermux-sync-test-{}", std::process::id());
    spawn_swarm_server(&dir, &live);
    // dead leftovers
    std::fs::write(sockdir.join("claude-swarm-99999991"), b"").unwrap();
    std::fs::write(sockdir.join("supermux-sync-test-99999992"), b"").unwrap();
    // supermux's own session socket: never ours to touch
    std::fs::write(sockdir.join("default"), b"").unwrap();

    let out = swarm::sweep_once(&dir, Duration::ZERO).await.unwrap();

    assert_eq!(out.sockets_removed.len(), 2, "{:?}", out.sockets_removed);
    assert!(!sockdir.join("claude-swarm-99999991").exists());
    assert!(!sockdir.join("supermux-sync-test-99999992").exists());
    assert!(
        sockdir.join("default").exists(),
        "must never touch a non-swarm socket"
    );
    assert!(
        sockdir.join(&live).exists() && server_running(&dir, &live),
        "unlinked a live server's socket"
    );

    kill_leftover(&dir, &live);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A probe that fails for any reason OTHER than "nothing is listening" is not
/// evidence of death. Here the socket dir has unsafe permissions, so tmux
/// refuses every connection: the sweep must keep its hands off the files and
/// report the trouble instead of unlinking on no answer.
#[tokio::test]
async fn keeps_socket_files_when_every_probe_fails() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let sockdir = swarm::socket_dir(&dir);
    std::fs::create_dir_all(&sockdir).unwrap();
    std::fs::set_permissions(&sockdir, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(sockdir.join("claude-swarm-99999993"), b"").unwrap();

    let out = swarm::sweep_once(&dir, Duration::ZERO).await.unwrap();

    assert!(
        out.sockets_removed.is_empty(),
        "unlinked on an inconclusive probe: {:?}",
        out.sockets_removed
    );
    assert!(sockdir.join("claude-swarm-99999993").exists());
    assert!(!out.errors.is_empty(), "an inconclusive probe must be reported");
    let _ = std::fs::remove_dir_all(&dir);
}

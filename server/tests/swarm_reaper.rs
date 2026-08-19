//! Integration tests for the agent-team swarm reaper. Spawn REAL private tmux
//! servers in a throwaway TMUX_TMPDIR and reap them. Self-skips without tmux.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;
use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::sessions::swarm::{self, SweepOutcome};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "secret-test-token-swarm";

fn tmux_available() -> bool {
    which::which("tmux").is_ok()
}

/// `tests/lifecycle.rs`'s fixture, extended with the `AppState` itself so the
/// e2e test below can reach `runtime_for` / `lifecycle::stop` directly.
async fn test_app() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-swarm-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        swarm_reaper: Default::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    (state.clone(), http::router(state), dir)
}

async fn send(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    let req = match body {
        Some(b) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            builder.body(Body::from(b.to_string())).unwrap()
        }
        None => builder.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

fn temp_tmpdir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("supermux-swarm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Spawn a detached private tmux server on `socket` whose one pane runs `cat`
/// forever, exactly the shape Claude Code's agent teams leave behind.
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

/// A PID that is guaranteed dead: spawn a no-op child, reap it, reuse its pid.
/// (Immediate recycling of a just-reaped pid is astronomically unlikely.)
fn dead_pid() -> u32 {
    let child = std::process::Command::new("true").spawn().expect("spawn true");
    let pid = child.id();
    let mut child = child;
    child.wait().unwrap();
    pid
}

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

    let out: SweepOutcome = swarm::sweep_once(&dir, Duration::ZERO, false).await.unwrap();

    assert!(out.killed.contains(&socket), "killed: {:?} errors: {:?}", out.killed, out.errors);
    // kill-server is synchronous once it lands, but give the process a moment
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

/// A server whose socket FILE is gone can no longer be reached by any tmux
/// client, so `list-clients` fails. That must NOT read as "keep forever":
/// nothing can be attached to a server nothing can connect to, so the sweep
/// proceeds and the pid-verified escalation inside `kill_server` takes the
/// process down. Discovery finds it because it scans argv, not socket files.
#[tokio::test]
async fn reaps_server_whose_socket_file_is_gone() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let socket = format!("claude-swarm-{}", dead_pid());
    spawn_swarm_server(&dir, &socket);
    // the server process keeps running; only the door to it is removed
    std::fs::remove_file(swarm::socket_dir(&dir).join(&socket)).unwrap();
    let server_pid = swarm::discover_servers(&dir)
        .into_iter()
        .find(|s| s.socket_name == socket)
        .map(|s| s.server_pid)
        .expect("server still discovered by argv after its socket file went away");

    let out = swarm::sweep_once(&dir, Duration::ZERO, false).await.unwrap();

    assert!(
        out.killed.contains(&socket),
        "killed: {:?} kept: {:?} errors: {:?}",
        out.killed,
        out.kept,
        out.errors
    );
    let mut gone = false;
    for _ in 0..20 {
        if !swarm::pid_alive(server_pid) {
            gone = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !gone {
        // no socket left to kill-server through, so clean up by pid
        let _ = std::process::Command::new("kill")
            .args(["-9", &server_pid.to_string()])
            .status();
    }
    assert!(gone, "socketless server survived the sweep");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn dry_run_reports_but_kills_nothing() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let socket = format!("claude-swarm-{}", dead_pid());
    spawn_swarm_server(&dir, &socket);

    let out = swarm::sweep_once(&dir, Duration::ZERO, true).await.unwrap();

    assert!(out.killed.contains(&socket));
    assert!(server_running(&dir, &socket), "dry-run must not kill");
    kill_leftover(&dir, &socket);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn keeps_server_with_live_lead() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    // our own test process is the "lead": alive for the duration of the test
    let socket = format!("claude-swarm-{}", std::process::id());
    spawn_swarm_server(&dir, &socket);

    let out = swarm::sweep_once(&dir, Duration::ZERO, false).await.unwrap();

    assert!(out.kept.iter().any(|(n, why)| n == &socket && *why == "lead-alive"));
    assert!(server_running(&dir, &socket));
    kill_leftover(&dir, &socket);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn keeps_server_younger_than_grace() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let socket = format!("claude-swarm-{}", dead_pid());
    spawn_swarm_server(&dir, &socket);

    let out = swarm::sweep_once(&dir, Duration::from_secs(3600), false).await.unwrap();

    assert!(out.kept.iter().any(|(n, why)| n == &socket && *why == "younger-than-grace"));
    assert!(server_running(&dir, &socket));
    kill_leftover(&dir, &socket);
    let _ = std::fs::remove_dir_all(&dir);
}

/// tmux refuses to use a socket dir that grants ANY permission to group/other
/// ("directory ... has unsafe permissions"), so a dir left at the 0755 that
/// create_dir_all produces makes EVERY probe fail for a reason that has nothing
/// to do with server liveness. Tests that hand-build the socket dir must set
/// 0700 or they assert nothing.
fn make_socket_dir(dir: &Path) -> PathBuf {
    let sockdir = swarm::socket_dir(dir);
    std::fs::create_dir_all(&sockdir).unwrap();
    std::fs::set_permissions(&sockdir, std::fs::Permissions::from_mode(0o700)).unwrap();
    sockdir
}

#[tokio::test]
async fn removes_stale_socket_files() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let sockdir = make_socket_dir(&dir);

    // A live server whose lead is alive (our own pid): discovered, kept, and its
    // socket file must survive the GC.
    let live = format!("claude-swarm-{}", std::process::id());
    spawn_swarm_server(&dir, &live);
    // A live server on a reapable name that discovery does NOT match (no
    // claude-swarm- prefix, so no lead pid). Only the liveness probe protects
    // this file, so it is the regression guard for the probe itself: delete the
    // guard and this socket gets unlinked out from under a running server.
    let live_untracked = format!("supermux-sync-test-{}", std::process::id());
    spawn_swarm_server(&dir, &live_untracked);

    // dead leftovers: no server behind them
    std::fs::write(sockdir.join("claude-swarm-99999991"), b"").unwrap();
    std::fs::write(sockdir.join("supermux-sync-test-99999992"), b"").unwrap();
    // NOT ours to touch
    std::fs::write(sockdir.join("default"), b"").unwrap();

    let out = swarm::sweep_once(&dir, Duration::ZERO, false).await.unwrap();

    assert_eq!(out.sockets_removed.len(), 2, "{:?}", out.sockets_removed);
    assert!(!sockdir.join("claude-swarm-99999991").exists());
    assert!(!sockdir.join("supermux-sync-test-99999992").exists());
    assert!(sockdir.join("default").exists(), "must never touch non-swarm sockets");
    // live servers: file intact AND still answering
    assert!(sockdir.join(&live).exists(), "unlinked a live tracked server's socket");
    assert!(server_running(&dir, &live));
    assert!(sockdir.join(&live_untracked).exists(), "unlinked a live server's socket");
    assert!(server_running(&dir, &live_untracked));

    kill_leftover(&dir, &live);
    kill_leftover(&dir, &live_untracked);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A probe that fails for a reason other than "nothing is listening" must never
/// be read as "dead". Here the socket dir has unsafe permissions, so tmux
/// refuses every connection attempt; the sweep must keep its hands off the
/// files and report the trouble instead.
#[tokio::test]
async fn keeps_socket_files_when_probe_fails() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let sockdir = swarm::socket_dir(&dir);
    std::fs::create_dir_all(&sockdir).unwrap();
    std::fs::set_permissions(&sockdir, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(sockdir.join("claude-swarm-99999993"), b"").unwrap();

    let out = swarm::sweep_once(&dir, Duration::ZERO, false).await.unwrap();

    assert!(out.sockets_removed.is_empty(), "unlinked on an inconclusive probe: {:?}", out.sockets_removed);
    assert!(sockdir.join("claude-swarm-99999993").exists());
    assert!(!out.errors.is_empty(), "an inconclusive probe must be reported");
    let _ = std::fs::remove_dir_all(&dir);
}

/// tmux reports an unreadable socket as `error connecting to ... (Permission
/// denied)`, which looks a lot like the message for a socket nobody is
/// listening on. Here there IS a live server behind it, so treating that as
/// "dead" would unlink a running server's socket.
#[tokio::test]
async fn keeps_live_server_socket_when_unreadable() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let sockdir = make_socket_dir(&dir);
    // reapable name that discovery does not match, so the GC probe is the only
    // thing deciding this file's fate
    let socket = format!("supermux-sync-test-{}", std::process::id());
    spawn_swarm_server(&dir, &socket);
    let path = sockdir.join(&socket);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();

    let out = swarm::sweep_once(&dir, Duration::ZERO, false).await.unwrap();

    assert!(out.sockets_removed.is_empty(), "unlinked a live server's socket: {:?}", out.sockets_removed);
    assert!(path.exists(), "live server's socket was unlinked");
    assert!(!out.errors.is_empty(), "an unreadable socket must be reported");

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(server_running(&dir, &socket), "server should have been left alone");
    kill_leftover(&dir, &socket);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The targeted teardown runs at session end for ONE known lead pid, so it must
/// hit exactly that lead's server and leave every other team alone.
#[tokio::test]
async fn teardown_for_lead_kills_matching_server() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let lead = dead_pid();
    let socket = format!("claude-swarm-{lead}");
    spawn_swarm_server(&dir, &socket);
    // unrelated server that must survive
    let other = format!("claude-swarm-{}", std::process::id());
    spawn_swarm_server(&dir, &other);

    let killed = swarm::teardown_for_lead(&dir, lead).await.unwrap();

    assert!(killed);
    assert!(!server_running(&dir, &socket), "target server must be gone");
    assert!(server_running(&dir, &other), "unrelated server must survive");
    kill_leftover(&dir, &other);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn teardown_for_lead_noop_when_no_server() {
    let dir = temp_tmpdir();
    let killed = swarm::teardown_for_lead(&dir, dead_pid()).await.unwrap();
    assert!(!killed);
    let _ = std::fs::remove_dir_all(&dir);
}

/// No server left, but the socket file lingers: teardown garbage-collects it,
/// same rule as the sweep, only on a conclusive "nothing is listening".
#[tokio::test]
async fn teardown_for_lead_gcs_stale_socket_file() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let sockdir = make_socket_dir(&dir);
    let lead = dead_pid();
    let path = sockdir.join(format!("claude-swarm-{lead}"));
    std::fs::write(&path, b"").unwrap();

    let killed = swarm::teardown_for_lead(&dir, lead).await.unwrap();

    assert!(!killed, "no server was running, so nothing was killed");
    assert!(!path.exists(), "stale socket file should have been removed");
    let _ = std::fs::remove_dir_all(&dir);
}

/// An inconclusive probe (here: a socket dir tmux refuses to use) is not
/// evidence that the server is gone, so the file stays put.
#[tokio::test]
async fn teardown_for_lead_keeps_socket_file_when_probe_fails() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let sockdir = swarm::socket_dir(&dir);
    std::fs::create_dir_all(&sockdir).unwrap();
    std::fs::set_permissions(&sockdir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let lead = dead_pid();
    let path = sockdir.join(format!("claude-swarm-{lead}"));
    std::fs::write(&path, b"").unwrap();

    let killed = swarm::teardown_for_lead(&dir, lead).await.unwrap();

    assert!(!killed);
    assert!(path.exists(), "unlinked a socket file on an inconclusive probe");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The defer path: a lead that never dies within TEARDOWN_LEAD_WAIT must end in
/// `Ok(false)` with nothing killed and nothing unlinked, leaving the server to
/// the periodic sweep. `start_paused` auto-advances the clock whenever the task
/// is idle, so the full 30s wait costs no real time.
///
/// The wait loop gives up BEFORE discovery, so no tmux server is needed here;
/// what the test has to prove is that the call really waited out the deadline
/// instead of falling through, hence the elapsed-time assertion. That assertion
/// is the only real discriminator: the socket file also survives a fall-through,
/// because under paused time the GC's probe would hit its timeout and skip the
/// file anyway. It stays asserted as a cheap "nothing was touched" check.
#[tokio::test(start_paused = true)]
async fn teardown_for_lead_defers_while_lead_is_alive() {
    let dir = temp_tmpdir();
    let sockdir = make_socket_dir(&dir);
    // our own process: guaranteed alive for the whole test
    let lead = std::process::id();
    let path = sockdir.join(format!("claude-swarm-{lead}"));
    std::fs::write(&path, b"").unwrap();

    let started = tokio::time::Instant::now();
    let killed = swarm::teardown_for_lead(&dir, lead).await.unwrap();
    let waited = started.elapsed();

    assert!(!killed, "must never kill while the lead is still alive");
    assert!(
        waited >= Duration::from_secs(30),
        "must wait out TEARDOWN_LEAD_WAIT before deferring, waited {waited:?}"
    );
    assert!(path.exists(), "deferring must not touch the socket file");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A clients check that cannot be answered (here: an unreadable socket, so
/// every tmux client call fails) is not permission to kill. The teardown backs
/// off and leaves the server to the sweep, which re-evaluates it later.
#[tokio::test]
async fn teardown_for_lead_keeps_server_when_clients_check_fails() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let sockdir = make_socket_dir(&dir);
    let lead = dead_pid();
    let socket = format!("claude-swarm-{lead}");
    spawn_swarm_server(&dir, &socket);
    // discovery reads the process table, so the server is still found; only the
    // tmux client calls (list-clients, kill-server) break on this
    let path = sockdir.join(&socket);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();

    let killed = swarm::teardown_for_lead(&dir, lead).await.unwrap();

    assert!(!killed, "killed a server whose clients check never answered");
    assert!(path.exists(), "socket file was unlinked on an inconclusive probe");

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(server_running(&dir, &socket), "server should have been left alone");
    kill_leftover(&dir, &socket);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Sweeping one TMUX_TMPDIR must be blind to servers living in another. Without
/// this the reaper would reach outside its own socket namespace and kill
/// production servers from a test run.
#[tokio::test]
async fn scopes_sweep_to_its_own_tmpdir() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let elsewhere = temp_tmpdir();
    let swept = temp_tmpdir();
    // dead lead + zero grace: this server is maximally killable, and the ONLY
    // thing standing between it and the reaper is the tmpdir scoping.
    let socket = format!("claude-swarm-{}", dead_pid());
    spawn_swarm_server(&elsewhere, &socket);
    assert!(server_running(&elsewhere, &socket));

    let out = swarm::sweep_once(&swept, Duration::ZERO, false).await.unwrap();

    assert!(!out.killed.contains(&socket), "killed a server outside the swept tmpdir");
    assert!(
        !out.kept.iter().any(|(n, _)| n == &socket),
        "server outside the swept tmpdir was even considered: {:?}",
        out.kept
    );
    assert!(server_running(&elsewhere, &socket), "server outside the swept tmpdir died");

    kill_leftover(&elsewhere, &socket);
    let _ = std::fs::remove_dir_all(&elsewhere);
    let _ = std::fs::remove_dir_all(&swept);
}

/// Everything the e2e test below creates OUTSIDE this process: a real
/// `supermux-<name>` tmux session whose pane runs `cat`, a fake swarm server,
/// and the fixture's data dir. Unlike every other test here it cannot use a
/// throwaway TMUX_TMPDIR (it has to match what `spawn_teardown_for_lead`
/// resolves), so a leak lands in the operator's own socket dir. Worse, a
/// leaked `cat` keeps the fake lead pid ALIVE, and both the targeted teardown
/// and the periodic sweep refuse to reap a server whose lead still lives, so
/// the stray would need manual cleanup forever. Hence a Drop guard: every exit
/// path cleans up, panicking asserts included.
struct E2eCleanup {
    tmux_tmpdir: PathBuf,
    /// Set once the lead pid is known and the fake server exists.
    socket: Option<String>,
    session: String,
    data_dir: PathBuf,
}

impl Drop for E2eCleanup {
    fn drop(&mut self) {
        // Kill the pane FIRST: that ends `cat`, so the lead pid is dead by the
        // time anything looks at the swarm server.
        let _ = std::process::Command::new("tmux")
            .args(["kill-session", "-t", &format!("supermux-{}", self.session)])
            .output();
        if let Some(socket) = &self.socket {
            kill_leftover(&self.tmux_tmpdir, socket);
        }
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

/// `/proc/<pid>/comm`, used to confirm the captured foreground pid really is
/// the `cat` we asked for.
fn comm_of(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_string())
}

/// End-to-end: stopping a session tears down the swarm server named after the
/// pane's foreground process. Uses the same AppState + real-tmux setup as
/// `tests/lifecycle.rs` (its `test_app()` fixture and its HTTP create+start
/// pattern), only handing back the `AppState` too so the test can read the
/// pane's foreground pid and call `lifecycle::stop` directly.
///
/// The fake swarm server is spawned under the TMUX_TMPDIR the TEST PROCESS
/// resolves, because that is exactly what `spawn_teardown_for_lead` reads when
/// `stop()` fires it.
#[tokio::test]
async fn stop_tears_down_swarm_server_of_foreground_pid() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let (state, app, dir) = test_app().await;
    let name = format!("swarm{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let tmpdir = std::env::var_os("TMUX_TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    // Armed BEFORE the session is created, so even a half-finished `start`
    // leaves nothing behind.
    let mut cleanup = E2eCleanup {
        tmux_tmpdir: tmpdir.clone(),
        socket: None,
        session: name.clone(),
        data_dir: dir,
    };

    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": name, "provider": "shell", "dir": "/tmp", "runtime": "tmux" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, body) = send(&app, Method::POST, &format!("/api/sessions/{name}/start"), None).await;
    assert_eq!(status, StatusCode::OK, "start body: {body}");

    // Put a foreground job in the pane so `lead_pid_of` resolves to something
    // other than the shell itself (that is what stands in for the lead agent).
    let rt = state.runtime_for(&name).await.unwrap();
    rt.send_text("cat").await.unwrap();
    rt.send_key("Enter").await.unwrap();
    let mut lead = None;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        // A shell-init child can hold the foreground pgid for a moment; naming
        // the fake socket after one of those would leave a lead that dies on
        // its own, so the test would pass without proving anything. Only the
        // `cat` we asked for stands in for the lead agent.
        lead = match swarm::lead_pid_of(rt.as_ref()).await {
            Some(pid) if comm_of(pid).as_deref() == Some("cat") => Some(pid),
            _ => None,
        };
        if lead.is_some() {
            break;
        }
    }
    let lead = lead.expect("foreground pid of the pane's cat");
    drop(rt);

    let socket = format!("claude-swarm-{lead}");
    cleanup.socket = Some(socket.clone());
    spawn_swarm_server(&tmpdir, &socket);
    assert!(server_running(&tmpdir, &socket));

    supermux_server::sessions::lifecycle::stop(&state, &name).await.unwrap();

    // stop kills the pane -> cat dies -> the teardown task kills the swarm server
    let mut gone = false;
    for _ in 0..80 {
        if !server_running(&tmpdir, &socket) {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    // `cleanup` handles the pane, the fake server and the data dir on the way
    // out, whether this assert fires or not.
    assert!(gone, "swarm server survived session stop");
}

#[test]
fn swarm_reaper_config_defaults() {
    let cfg = supermux_server::config::SwarmReaperConfig::default();
    assert!(cfg.enabled);
    assert_eq!(cfg.grace_secs, 7200);
    assert_eq!(cfg.interval_secs, 1800);
}

#[test]
fn swarm_reaper_config_partial_toml() {
    // a partial block keeps the other defaults (RawConfig convention)
    let raw: supermux_server::config::SwarmReaperConfig =
        toml::from_str("grace_secs = 60").unwrap();
    assert!(raw.enabled);
    assert_eq!(raw.grace_secs, 60);
    assert_eq!(raw.interval_secs, 1800);
}

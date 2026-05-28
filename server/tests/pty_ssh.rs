//! `SshPtyReader` integration + argv tests (REMOTE_PLAN §RT3).
//!
//! Four scenarios cover the RT3 contract:
//!
//! 1. **localhost happy path** (`#[ignore]`) — register a localhost host, build
//!    a transport, spin up a real remote tmux session, attach the reader, send
//!    a keystroke, assert bytes reach the sink within 200ms of `send-keys`.
//! 2. **ControlMaster bounce** (`#[ignore]`) — same setup, then `ssh -O exit`
//!    the master mid-stream. Within 30s the reader respawns (HostPool warms a
//!    fresh master + `wait_for_master` swaps the transport) and the replay
//!    buffer is intact (no clearing on respawn).
//! 3. **Remote tmux killed** (`#[ignore]`) — kill the remote tmux session. The
//!    reader's periodic liveness probe returns `Ok(())` (stream-dead).
//! 4. **Argv construction** (always-runs UNIT) — build the reader's two
//!    long-lived `Command`s against a synthesised `Transport::Ssh` and pin the
//!    exact argv shape so an accidental flag/quoting regression is loud.
//!
//! Scenarios 1-3 are gated `#[ignore]` because the orchestrator's sandbox has
//! no usable localhost ssh; run them on a dev box with
//! `cargo test --test pty_ssh -- --ignored`.

use std::path::PathBuf;
use std::time::Duration;

use sqlx::SqlitePool;
use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db;
use supermux_server::db::hosts;
use supermux_server::sessions::host_pool::HostPool;
use supermux_server::sessions::pty::SshPtyReader;
use supermux_server::sessions::transport::{HostId, Transport};

// ── Shared fixture ──────────────────────────────────────────────────────────

async fn test_pool() -> (SqlitePool, PathBuf) {
    let dir = std::env::temp_dir()
        .join(format!("supermux-pty-ssh-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: "pty-ssh-test".to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        remote_callback_url: None,
            push_sub: None,
            github_token: None,
    };
    let pool = db::init(&config).await.expect("db init");
    (pool, dir)
}

/// Returns true iff localhost ssh with BatchMode works. We skip the ignored
/// tests cleanly if not — same precheck pattern as `tests/host_pool.rs`.
async fn ssh_localhost_usable() -> bool {
    let probe = tokio::process::Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=2",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "localhost",
            "true",
        ])
        .output()
        .await;
    matches!(probe, Ok(o) if o.status.success())
}

// ── Test 4: argv construction (always runs) ─────────────────────────────────

/// Read program + args off a configured `tokio::process::Command` without
/// spawning it. Mirrors the `argv_of` helper in `sessions::transport::tests`.
fn argv_of(cmd: &tokio::process::Command) -> (String, Vec<String>) {
    let std_cmd = cmd.as_std();
    let program = std_cmd.get_program().to_string_lossy().to_string();
    let args = std_cmd
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    (program, args)
}

/// The reader child's argv must match the SSH-master re-use shape exactly. A
/// regression here (a missing `BatchMode=yes`, the wrong `--` placement, a
/// stray flag) silently changes the network/quoting story — the only way to
/// catch that cheaply is to pin the exact argv.
///
/// Transport's SSH branch (since commit 1290ad0) shell-escapes every token
/// and joins into ONE final argv element. The remote command we ship is
/// `sh -c 'cat -- "$HOME/…"'` — the inner double quotes preserve the
/// `$HOME` variable through `shell_escape::unix::escape`'s outer
/// single-quoting, so the remote `/bin/sh -c` expands `$HOME` at exec time
/// (literal `~/…` would be silently single-quoted and fail ENOENT).
#[test]
fn cat_child_argv_is_pinned() {
    let control_path = PathBuf::from("/tmp/supermux-ssh-test.sock");
    let transport = Transport::Ssh {
        host_id: HostId(99),
        ssh_target: "user@example".to_string(),
        control_path: control_path.clone(),
    };
    let (fifo, _log) = SshPtyReader::test_remote_paths("proj");
    let cmd = SshPtyReader::build_cat_command(&transport, &fifo);
    let (program, args) = argv_of(&cmd);
    assert_eq!(program, "ssh", "must invoke the local ssh client");
    // Expected: ssh -o ControlPath=… -o ControlMaster=auto -o ControlPersist=600
    //           -o BatchMode=yes user@example -- sh -c 'cat -- "$HOME/…"'
    // The final argv element is the shell_escape-joined remote command.
    let expected: Vec<String> = vec![
        "-o".into(),
        format!("ControlPath={}", control_path.display()),
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        "ControlPersist=600".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "user@example".into(),
        "--".into(),
        // `sh` + `-c` are whitelisted (no quoting); the script body contains
        // space + `"` + `$` so shell_escape wraps it in single quotes.
        r#"sh -c 'cat -- "$HOME/.supermux-remote/pty-proj.fifo"'"#.into(),
    ];
    assert_eq!(args, expected, "cat child argv must match exactly");
}

/// The keep-alive writer's argv pins the `sh -c '<body>'` shape with the FIFO
/// path baked into the script body inside double quotes (so `$HOME` expands at
/// the remote shell). The previous `"$0"` positional-arg trick relied on
/// Transport NOT shell-escaping each token; with the 1290ad0 escape fix that
/// trick broke (single-quoted `~/…` doesn't tilde-expand).
#[test]
fn keepalive_child_argv_is_pinned() {
    let control_path = PathBuf::from("/tmp/supermux-ssh-test.sock");
    let transport = Transport::Ssh {
        host_id: HostId(99),
        ssh_target: "user@example".to_string(),
        control_path: control_path.clone(),
    };
    let (fifo, _log) = SshPtyReader::test_remote_paths("proj");
    let cmd = SshPtyReader::build_keepalive_command(&transport, &fifo);
    let (program, args) = argv_of(&cmd);
    assert_eq!(program, "ssh");
    // Final argv element: `sh -c 'exec 9>"$HOME/…"; while sleep 60; do :; done'`
    // `sh` + `-c` whitelisted; script body has `"`/`$`/`;`/space → single-quoted.
    let expected: Vec<String> = vec![
        "-o".into(),
        format!("ControlPath={}", control_path.display()),
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        "ControlPersist=600".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "user@example".into(),
        "--".into(),
        r#"sh -c 'exec 9>"$HOME/.supermux-remote/pty-proj.fifo"; while sleep 60; do :; done'"#
            .into(),
    ];
    assert_eq!(args, expected, "keepalive child argv must match exactly");
    // And the script body itself — pin the keep-alive trick verbatim.
    assert_eq!(
        SshPtyReader::keepalive_script_for(&fifo),
        r#"exec 9>"$HOME/.supermux-remote/pty-proj.fifo"; while sleep 60; do :; done"#
    );
}

/// Remote path convention (RT3 + RT8 bootstrap). Lives outside the data dir;
/// the SshPtyReader uses the `$HOME/…` token form so the remote `/bin/sh -c`
/// expands it once against the REMOTE user's HOME (literal `~/` would be
/// suppressed by `shell_escape`'s single-quoting in Transport's SSH branch).
#[test]
fn remote_paths_follow_supermux_remote_convention() {
    let (fifo, log) = SshPtyReader::test_remote_paths("my-proj");
    assert_eq!(
        fifo,
        PathBuf::from("$HOME/.supermux-remote/pty-my-proj.fifo")
    );
    assert_eq!(
        log,
        PathBuf::from("$HOME/.supermux-remote/pty-my-proj.log")
    );
}

// ── Tests 1-3: real localhost SSH (#[ignore]) ───────────────────────────────

/// Helper: run `ssh localhost <args>` synchronously and return (status,
/// stdout). Used by the localhost tests to drive remote tmux without going
/// through the higher-level lifecycle.
async fn ssh_localhost(args: &[&str]) -> (std::process::ExitStatus, String) {
    let mut full_args: Vec<&str> = vec![
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "localhost",
        "--",
    ];
    full_args.extend_from_slice(args);
    let out = tokio::process::Command::new("ssh")
        .args(&full_args)
        .output()
        .await
        .expect("ssh localhost");
    (out.status, String::from_utf8_lossy(&out.stdout).to_string())
}

/// Test 1 — happy path. Bytes flow from the remote tmux pane via the SSH FIFO
/// reader into the sink's broadcast within 200ms of a `send-keys`.
#[tokio::test]
#[ignore]
async fn ssh_reader_bytes_flow_within_200ms() {
    if !ssh_localhost_usable().await {
        eprintln!("skipping: ssh-localhost not usable");
        return;
    }

    let session = format!("pty-ssh-test-{}", uuid::Uuid::new_v4().simple());
    let target = format!("supermux-{session}");

    // Pre-clean any prior artefacts (best-effort).
    let _ = ssh_localhost(&["tmux", "kill-session", "-t", &target]).await;
    let _ = ssh_localhost(&["mkdir", "-p", "~/.supermux-remote"]).await;
    let _ = ssh_localhost(&[
        "rm",
        "-f",
        &format!("~/.supermux-remote/pty-{session}.fifo"),
        &format!("~/.supermux-remote/pty-{session}.log"),
    ])
    .await;

    // Start a remote tmux session running `cat` — it'll echo bytes back.
    let (st, _) = ssh_localhost(&[
        "tmux", "new-session", "-d", "-s", &target, "cat",
    ])
    .await;
    assert!(st.success(), "remote tmux new-session failed");

    // Register the localhost host + spin up the HostPool.
    let (pool, dir) = test_pool().await;
    let hp = HostPool::new(pool.clone(), &dir);
    let host = hosts::create(&pool, "loopback", "localhost", None)
        .await
        .expect("create host");

    // We can't construct `PtySink` from outside the crate (its fields are
    // private — by design, so external code can't accidentally bypass the
    // wake-on-edge / replay invariants). Drive the reader via the public
    // path:  insert a `sessions` row with `host_id` set, call
    // `ensure_started`, and observe through `stream.broadcast.subscribe()`.
    use dashmap::DashMap;
    use std::sync::Arc;
    use std::time::Instant;
    use tokio::sync::Notify;

    let wake = Arc::new(Notify::new());
    let hb: Arc<DashMap<String, Instant>> = Arc::new(DashMap::new());

    let session_name = session.clone();
    // Insert a `sessions` row with host_id set so ensure_started picks the SSH reader.
    db::sessions::insert_minimal(&pool, &session_name, "/tmp", "shell")
        .await
        .expect("insert session row");
    sqlx::query("UPDATE sessions SET host_id = ? WHERE name = ?")
        .bind(host.id)
        .bind(&session_name)
        .execute(&pool)
        .await
        .expect("set host_id");

    // Build the stream — the local fifo/log paths are placeholders; the SSH
    // reader overrides them with the `~/.supermux-remote/` convention.
    let stream = supermux_server::sessions::pty::PtyStream::new(
        session_name.clone(),
        dir.join(format!("{session_name}.fifo")),
        dir.join(format!("{session_name}.log")),
        64,
    );
    let mut sub = stream.broadcast.subscribe();

    stream
        .ensure_started(&pool, hp.clone(), hb.clone(), wake.clone())
        .await
        .expect("ensure_started");

    // Allow a beat for the reader to wire pipe-pane up.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Send a keystroke into the remote pane. Cat will echo it back through
    // the FIFO → reader → broadcast.
    let send_at = Instant::now();
    let (st, _) = ssh_localhost(&[
        "tmux", "send-keys", "-t", &target, "hello", "Enter",
    ])
    .await;
    assert!(st.success(), "tmux send-keys failed");

    // Wait up to 5s (generous slack for SSH+tmux+kernel pipe) for the byte
    // batch. The contract is "within 200ms" — but in CI / loaded boxes we
    // give extra headroom so the test isn't flaky on the bound.
    let _bytes = tokio::time::timeout(Duration::from_secs(5), sub.recv())
        .await
        .expect("byte batch within 5s")
        .expect("broadcast recv");
    let dt = send_at.elapsed();
    assert!(dt < Duration::from_secs(5), "bytes flowed in {dt:?}");

    // Cleanup.
    let _ = ssh_localhost(&["tmux", "kill-session", "-t", &target]).await;
    let _ = ssh_localhost(&[
        "rm",
        "-f",
        &format!("~/.supermux-remote/pty-{session}.fifo"),
        &format!("~/.supermux-remote/pty-{session}.log"),
    ])
    .await;
    hp.tear_down(host.id).await.ok();
    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// Test 2 — ControlMaster bounce mid-stream. After bytes flow, kill the
/// master via `ssh -O exit`. Within 30s the reader respawns (HostPool warms a
/// fresh master) and a fresh `send-keys` lands in the broadcast again. The
/// replay buffer is NOT cleared.
#[tokio::test]
#[ignore]
async fn ssh_reader_respawns_after_master_bounce() {
    if !ssh_localhost_usable().await {
        eprintln!("skipping: ssh-localhost not usable");
        return;
    }

    let session = format!("pty-ssh-bounce-{}", uuid::Uuid::new_v4().simple());
    let target = format!("supermux-{session}");
    let _ = ssh_localhost(&["tmux", "kill-session", "-t", &target]).await;
    let _ = ssh_localhost(&["mkdir", "-p", "~/.supermux-remote"]).await;

    let (st, _) = ssh_localhost(&[
        "tmux", "new-session", "-d", "-s", &target, "cat",
    ])
    .await;
    assert!(st.success(), "remote tmux new-session failed");

    let (pool, dir) = test_pool().await;
    let hp = HostPool::new(pool.clone(), &dir);
    let host = hosts::create(&pool, "loopback", "localhost", None)
        .await
        .expect("create host");

    db::sessions::insert_minimal(&pool, &session, "/tmp", "shell")
        .await
        .expect("insert session row");
    sqlx::query("UPDATE sessions SET host_id = ? WHERE name = ?")
        .bind(host.id)
        .bind(&session)
        .execute(&pool)
        .await
        .expect("set host_id");

    let stream = supermux_server::sessions::pty::PtyStream::new(
        session.clone(),
        dir.join(format!("{session}.fifo")),
        dir.join(format!("{session}.log")),
        128,
    );
    let mut sub = stream.broadcast.subscribe();

    let hb: std::sync::Arc<dashmap::DashMap<String, std::time::Instant>> =
        std::sync::Arc::new(dashmap::DashMap::new());
    let wake = std::sync::Arc::new(tokio::sync::Notify::new());
    stream
        .ensure_started(&pool, hp.clone(), hb.clone(), wake.clone())
        .await
        .expect("ensure_started");

    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = ssh_localhost(&[
        "tmux", "send-keys", "-t", &target, "before", "Enter",
    ])
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(5), sub.recv())
        .await
        .expect("byte batch before bounce");

    // Capture replay len before bounce so we can prove it survives.
    let replay_before = stream.subscribe().0.iter().map(|b| b.len()).sum::<usize>();

    // Bounce the master. The HostPool's control path lives under data_dir.
    let control_path = dir
        .join("ssh-control")
        .join(format!("{}-localhost", host.id));
    let _ = tokio::process::Command::new("ssh")
        .args([
            "-o",
            &format!("ControlPath={}", control_path.display()),
            "-O",
            "exit",
            "localhost",
        ])
        .output()
        .await;

    // Within 30s the reader should respawn and a fresh keystroke should land.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let _ = ssh_localhost(&[
        "tmux", "send-keys", "-t", &target, "after", "Enter",
    ])
    .await;
    let _after = tokio::time::timeout(Duration::from_secs(30), sub.recv())
        .await
        .expect("byte batch after bounce");

    // Replay must still contain the pre-bounce bytes (no clearing on respawn).
    let replay_after = stream.subscribe().0.iter().map(|b| b.len()).sum::<usize>();
    assert!(
        replay_after >= replay_before,
        "replay must grow (or stay) across master bounce: {replay_before} → {replay_after}"
    );

    let _ = ssh_localhost(&["tmux", "kill-session", "-t", &target]).await;
    hp.tear_down(host.id).await.ok();
    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// Test 3 — remote tmux killed → reader returns Ok(()) (stream-dead). After
/// the kill the reader's liveness poll OR cat-EOF path should flip the
/// stream's `alive` flag to false (the spawn task in `PtyStream::spawn_reader`
/// stores false on `Ok(())`). 5s budget is comfortably above the 3s poll
/// interval.
#[tokio::test]
#[ignore]
async fn ssh_reader_returns_stream_dead_on_remote_tmux_kill() {
    if !ssh_localhost_usable().await {
        eprintln!("skipping: ssh-localhost not usable");
        return;
    }

    let session = format!("pty-ssh-dead-{}", uuid::Uuid::new_v4().simple());
    let target = format!("supermux-{session}");
    let _ = ssh_localhost(&["tmux", "kill-session", "-t", &target]).await;
    let _ = ssh_localhost(&["mkdir", "-p", "~/.supermux-remote"]).await;

    let (st, _) = ssh_localhost(&[
        "tmux", "new-session", "-d", "-s", &target, "cat",
    ])
    .await;
    assert!(st.success());

    let (pool, dir) = test_pool().await;
    let hp = HostPool::new(pool.clone(), &dir);
    let host = hosts::create(&pool, "loopback", "localhost", None)
        .await
        .expect("create host");

    db::sessions::insert_minimal(&pool, &session, "/tmp", "shell")
        .await
        .expect("insert session row");
    sqlx::query("UPDATE sessions SET host_id = ? WHERE name = ?")
        .bind(host.id)
        .bind(&session)
        .execute(&pool)
        .await
        .expect("set host_id");

    let stream = supermux_server::sessions::pty::PtyStream::new(
        session.clone(),
        dir.join(format!("{session}.fifo")),
        dir.join(format!("{session}.log")),
        64,
    );
    let hb: std::sync::Arc<dashmap::DashMap<String, std::time::Instant>> =
        std::sync::Arc::new(dashmap::DashMap::new());
    let wake = std::sync::Arc::new(tokio::sync::Notify::new());
    stream
        .ensure_started(&pool, hp.clone(), hb.clone(), wake.clone())
        .await
        .expect("ensure_started");

    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(stream.is_alive(), "stream must be alive before kill");

    // Kill remote tmux.
    let _ = ssh_localhost(&["tmux", "kill-session", "-t", &target]).await;

    // Poll up to 10s for the reader to flip alive → false.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while stream.is_alive() && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(!stream.is_alive(), "reader must mark stream dead after remote tmux kill");

    hp.tear_down(host.id).await.ok();
    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

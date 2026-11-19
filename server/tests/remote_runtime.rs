//! A session with a `host_id` runs on that host: a recording `ssh` stand-in shows the spawn going over ssh,
//! and a gone host gives no runtime. `integration_remote.rs` uses localhost as its "remote" and cannot tell.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db::{self, hosts};
use supermux_server::state::AppState;

const TARGET: &str = "root@203.0.113.7";

async fn test_state() -> (AppState, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-remote-runtime-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: "remote-runtime-test".to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        swarm_reaper: Default::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        company_isolation: Vec::new(),
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

/// A `shell` session row, optionally pinned to a host.
async fn insert_session(state: &AppState, name: &str, host_id: Option<i64>) {
    db::sessions::insert_minimal(&state.pool, name, "/tmp", "shell").await.unwrap();
    if let Some(id) = host_id {
        sqlx::query("UPDATE sessions SET host_id = ? WHERE name = ?")
            .bind(id)
            .bind(name)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}

/// Put a recording `ssh` on PATH that always succeeds, so the host pool sees a live ControlMaster.
/// Returns the log file it appends its arguments to.
fn install_recording_ssh(dir: &Path) -> PathBuf {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let log = dir.join("ssh.log");
    let script = bin.join("ssh");
    std::fs::write(&script, format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nexit 0\n", log.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{path}", bin.display()));
    log
}

fn ssh_log(log: &Path) -> String {
    std::fs::read_to_string(log).unwrap_or_default()
}

#[tokio::test]
async fn a_session_on_a_host_spawns_its_terminal_over_ssh() {
    let (state, dir) = test_state().await;
    let log = install_recording_ssh(&dir);

    let host = hosts::create(&state.pool, "rig", TARGET, None).await.expect("create host");
    insert_session(&state, "remote-one", Some(host.id)).await;
    insert_session(&state, "local-one", None).await;

    // A local session never starts ssh, however it is used.
    let local = state.runtime_for("local-one").await.expect("local runtime");
    let _ = local.alive().await;
    assert!(ssh_log(&log).is_empty(), "a local session must not touch ssh: {}", ssh_log(&log));

    // The stand-in answers every command with nothing, so the spawn may report a problem;
    // only where the command went matters.
    let remote = state.runtime_for("remote-one").await.expect("remote runtime");
    let _ = remote.spawn(Path::new("/srv/app"), &HashMap::new(), "bash").await;

    let recorded = ssh_log(&log);
    let spawn = recorded
        .lines()
        .find(|line| line.contains("new-session"))
        .unwrap_or_else(|| panic!("no `tmux new-session` went over ssh; ssh saw:\n{recorded}"));
    assert!(spawn.contains(TARGET), "new-session must target the host: {spawn}");
    assert!(spawn.contains("supermux-remote-one"), "new-session must name the session: {spawn}");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_session_on_a_gone_host_has_no_runtime_instead_of_a_local_one() {
    let (state, dir) = test_state().await;

    let host = hosts::create(&state.pool, "retired", TARGET, None).await.expect("create host");
    insert_session(&state, "orphan", Some(host.id)).await;
    hosts::soft_delete(&state.pool, host.id).await.expect("soft delete");

    let err = state.runtime_for("orphan").await.err().expect("a gone host must be an error, not a local runtime");
    let chain = format!("{err:#}");
    assert!(chain.contains("orphan") && chain.contains("soft-deleted"), "the error names the session and the cause: {chain}");
    assert!(state.session_runtimes.get("orphan").is_none(), "a failed lookup must not be cached");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}


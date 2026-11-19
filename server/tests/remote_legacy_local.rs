//! Sessions created with a `host_id` before remote spawn worked (#240) have their
//! pane on THIS machine. An upgrade must not strand them: while that local pane
//! lives the session is served locally, and its next start goes to the host.
//!
//! Its own binary with a PRIVATE tmux server (`TMUX_TMPDIR`, `TMUX` unset), so it
//! never touches a real tmux server on the machine running the tests.

use std::os::unix::fs::PermissionsExt;
use std::process::Command;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db::{self, hosts};
use supermux_server::state::AppState;

fn tmux_available() -> bool {
    Command::new("tmux").arg("-V").output().map(|o| o.status.success()).unwrap_or(false)
}

#[tokio::test]
async fn a_host_session_still_running_here_is_served_locally_until_it_stops() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = std::env::temp_dir().join(format!("supermux-legacy-{}", uuid::Uuid::new_v4()));
    let tmux_dir = dir.join("tmux");
    let bin = dir.join("bin");
    std::fs::create_dir_all(&tmux_dir).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    std::env::remove_var("TMUX");
    std::env::set_var("TMUX_TMPDIR", &tmux_dir);
    let log = dir.join("ssh.log");
    let script = bin.join("ssh");
    std::fs::write(&script, format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nexit 0\n", log.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default()));

    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: "t".to_string(),
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
    let state = AppState::new(pool, config);
    let host = hosts::create(&state.pool, "rig", "root@203.0.113.8", None).await.unwrap();
    db::sessions::insert_minimal(&state.pool, "legacy", "/tmp", "shell").await.unwrap();
    sqlx::query("UPDATE sessions SET host_id = ? WHERE name = 'legacy'")
        .bind(host.id)
        .execute(&state.pool)
        .await
        .unwrap();

    // The pane an older build started HERE for this host row.
    let up = Command::new("tmux")
        .args(["new-session", "-d", "-s", "supermux-legacy", "sleep", "60"])
        .status()
        .unwrap();
    assert!(up.success(), "private tmux server started");

    let rt = state.runtime_for("legacy").await.expect("served locally");
    assert!(rt.alive().await, "the local pane is the session");
    assert!(state.session_transport("legacy").await.unwrap().is_none(), "attach resolves it locally too");
    assert!(std::fs::read_to_string(&log).unwrap_or_default().is_empty(), "no ssh while the local pane lives");

    // Once that pane is gone, the next resolve belongs to the host.
    let _ = Command::new("tmux").args(["kill-server"]).status();
    state.runtime_invalidate("legacy");
    assert!(state.session_transport("legacy").await.unwrap().is_some(), "now over the host's transport");
    assert!(!std::fs::read_to_string(&log).unwrap_or_default().is_empty(), "ssh used for the host");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

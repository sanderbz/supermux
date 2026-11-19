//! A session on a host that cannot be reached fails FAST after the first failed
//! connect: every other caller (hooks, tailer, API) gets the answer without
//! waiting out the SSH warm-up again. Its own binary, because it puts a failing
//! `ssh` on PATH for the whole process.

use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db::{self, hosts};
use supermux_server::state::AppState;

#[tokio::test]
async fn a_down_host_is_answered_from_the_retry_window_not_retried() {
    let dir = std::env::temp_dir().join(format!("supermux-remote-down-{}", uuid::Uuid::new_v4()));
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let log = dir.join("ssh.log");
    let script = bin.join("ssh");
    std::fs::write(&script, format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nexit 255\n", log.display())).unwrap();
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
    let host = hosts::create(&state.pool, "down", "root@203.0.113.9", None).await.unwrap();
    db::sessions::insert_minimal(&state.pool, "far", "/tmp", "shell").await.unwrap();
    sqlx::query("UPDATE sessions SET host_id = ? WHERE name = 'far'")
        .bind(host.id)
        .execute(&state.pool)
        .await
        .unwrap();

    // First caller pays the warm-up and gets the real error.
    assert!(state.runtime_for("far").await.is_err());
    let tries = std::fs::read_to_string(&log).unwrap_or_default().lines().count();
    assert!(tries > 0, "the first caller did try ssh");

    // Every caller inside the window is answered at once, without ssh.
    for _ in 0..3 {
        let t = Instant::now();
        let err = state.runtime_for("far").await.err().expect("still down");
        assert!(t.elapsed() < Duration::from_secs(1), "answered from the window: {:?}", t.elapsed());
        assert!(format!("{err:#}").contains("unreachable"), "{err:#}");
    }
    assert_eq!(
        std::fs::read_to_string(&log).unwrap_or_default().lines().count(),
        tries,
        "no new ssh attempts inside the window",
    );
    assert!(state.session_runtimes.get("far").is_none(), "a failure is never cached as a runtime");

    // Lifting the window (what the host's manual Check does) retries for real.
    state.host_down_until.remove(&host.id);
    assert!(state.runtime_for("far").await.is_err());
    assert!(std::fs::read_to_string(&log).unwrap_or_default().lines().count() > tries, "retried after the window");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

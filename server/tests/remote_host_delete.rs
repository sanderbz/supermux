//! Deleting a host drops the cached runtimes built over it. Its own binary,
//! because it puts a recording `ssh` on PATH for the whole process.

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


/// Deleting a host drops every cached runtime built over it, so no call site keeps
/// talking to a host that is gone.
#[tokio::test]
async fn deleting_a_host_drops_the_runtimes_built_over_it() {
    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use tower::ServiceExt;

    let (state, dir) = test_state().await;
    let _log = install_recording_ssh(&dir);
    let host = hosts::create(&state.pool, "short-lived", TARGET, None).await.expect("create host");
    insert_session(&state, "on-it", Some(host.id)).await;
    state.runtime_for("on-it").await.expect("remote runtime");
    // A host with live sessions refuses deletion; this one's session is stopped.
    sqlx::query("INSERT INTO session_runtime (name, last_status) VALUES ('on-it', 'stopped') \
                 ON CONFLICT(name) DO UPDATE SET last_status = 'stopped'")
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(state.session_runtimes.get("on-it").is_some(), "precondition: cached");

    let app = supermux_server::http::router(state.clone());
    let req = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/api/hosts/{}", host.id))
        .header(header::AUTHORIZATION, "Bearer remote-runtime-test")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    assert!(state.session_runtimes.get("on-it").is_none(), "the cached handle went with the host");
    let err = state.runtime_for("on-it").await.err().expect("a deleted host is an error");
    assert!(format!("{err:#}").contains("soft-deleted"), "{err:#}");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

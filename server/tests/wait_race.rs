//! `wait` primitive race regression (TECH_PLAN §3.7, §3.2.13, §7.1; M5b, Eng P0
//! #2). 100 concurrent `wait` handlers + one detector-style transition: every
//! handler must observe the transition. The watch channel (vs v1's `Notify`) has
//! no notify-before-subscribe window, so none get stuck on a lost wakeup.

use std::time::Duration;

use supermux_server::agents::wait::{wait, WaitQuery};
use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db;
use supermux_server::state::AppState;

use axum::extract::{Path, Query, State};

async fn test_state() -> (AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-waitrace-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: "wait-race-token".to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
            remote_callback_url: None,
    };
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

#[tokio::test]
async fn hundred_waiters_all_observe_one_transition() {
    let (state, dir) = test_state().await;
    let name = "racey";

    // Seed a session that starts ACTIVE; waiters want IDLE.
    db::sessions::insert_minimal(&state.pool, name, "/tmp", "shell").await.unwrap();
    db::sessions::ensure_runtime(&state.pool, name, "tok").await.unwrap();
    db::sessions::set_last_status(&state.pool, name, "active").await.unwrap();

    // Spawn 100 waiters (5s budget — should resolve in milliseconds).
    let mut handles = Vec::new();
    for _ in 0..100 {
        let st = state.clone();
        let n = name.to_string();
        handles.push(tokio::spawn(async move {
            wait(
                State(st),
                Path(n),
                Query(WaitQuery { state: "idle".into(), timeout: Some(5) }),
            )
            .await
        }));
    }

    // Drive ONE transition the way `auto_actions::tick` does: persist the status
    // FIRST, then bump the watch — so a waiter that subscribed late still reads
    // the committed status as its baseline, and an early one is woken by changed().
    db::sessions::set_last_status(&state.pool, name, "idle").await.unwrap();
    let tx = state.status_watch_for(name);
    let next = tx.borrow().1.wrapping_add(1);
    tx.send_replace(("idle".to_string(), next));

    // Every waiter must report reached=true with status idle. A bounded join so a
    // genuine hang fails the test rather than hanging CI.
    for h in handles {
        let res = tokio::time::timeout(Duration::from_secs(8), h)
            .await
            .expect("waiter task did not finish (stuck — lost wakeup)")
            .expect("waiter task panicked")
            .expect("wait handler returned an error");
        assert!(res.reached, "a waiter missed the transition (got {res:?})");
        assert_eq!(res.status, "idle");
    }

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn wait_returns_current_status_on_timeout() {
    // §10 acceptance: `wait?state=idle&timeout=…` returns {reached:false,
    // status:'active'} when the session stays active.
    let (state, dir) = test_state().await;
    let name = "busy";
    db::sessions::insert_minimal(&state.pool, name, "/tmp", "shell").await.unwrap();
    db::sessions::ensure_runtime(&state.pool, name, "tok").await.unwrap();
    db::sessions::set_last_status(&state.pool, name, "active").await.unwrap();

    let res = wait(
        State(state.clone()),
        Path(name.to_string()),
        Query(WaitQuery { state: "idle".into(), timeout: Some(1) }),
    )
    .await
    .unwrap();
    assert!(!res.0.reached, "must not reach idle while active");
    assert_eq!(res.0.status, "active");

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn wait_already_in_state_returns_immediately() {
    let (state, dir) = test_state().await;
    let name = "done";
    db::sessions::insert_minimal(&state.pool, name, "/tmp", "shell").await.unwrap();
    db::sessions::ensure_runtime(&state.pool, name, "tok").await.unwrap();
    db::sessions::set_last_status(&state.pool, name, "idle").await.unwrap();

    // `done` is the CLI alias for idle (§3.7); the session is already idle.
    let res = wait(
        State(state.clone()),
        Path(name.to_string()),
        Query(WaitQuery { state: "done".into(), timeout: Some(300) }),
    )
    .await
    .unwrap();
    assert!(res.0.reached);
    assert_eq!(res.0.status, "idle");

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn wait_unknown_session_is_404() {
    let (state, dir) = test_state().await;
    let err = wait(
        State(state.clone()),
        Path("ghost".to_string()),
        Query(WaitQuery { state: "idle".into(), timeout: Some(1) }),
    )
    .await;
    assert!(err.is_err(), "waiting on a nonexistent session must 404");
    let _ = std::fs::remove_dir_all(dir);
}

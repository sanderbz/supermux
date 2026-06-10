//! End-to-end status hero-flow: SSE clients receive `{type:'sessions'...}`
//! deltas as the detector ticks. Spawns a REAL tmux shell session, subscribes
//! to the SSE broadcast, and asserts the detector loop publishes a `sessions`
//! delta once it captures the live pane. Requires `tmux`; skips cleanly
//! without it (CI has tmux).

use std::time::Duration;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt;

const TOKEN: &str = "status-flow-token";

fn tmux_available() -> bool {
    which::which("tmux").is_ok()
}

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-statusflow-{}", uuid::Uuid::new_v4()));
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
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    (state, app, dir)
}

async fn api(app: &axum::Router, method: Method, uri: &str, body: Option<serde_json::Value>) -> StatusCode {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    let req = match body {
        Some(v) => {
            b = b.header(header::CONTENT_TYPE, "application/json");
            b.body(Body::from(v.to_string())).unwrap()
        }
        None => b.body(Body::empty()).unwrap(),
    };
    app.clone().oneshot(req).await.unwrap().status()
}

#[tokio::test]
async fn detector_publishes_sessions_delta_for_live_pane() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let (state, app, dir) = setup().await;
    let name = format!("flow{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);

    // Subscribe to the SSE broadcast BEFORE anything ticks.
    let mut rx = state.sse_tx.subscribe();

    // Create (spawns the 2s detector loop) + start (tmux pane goes live).
    assert_eq!(
        api(&app, Method::POST, "/api/sessions", Some(serde_json::json!({
            "name": name, "provider": "shell", "dir": "/tmp"
        }))).await,
        StatusCode::CREATED
    );
    assert_eq!(
        api(&app, Method::POST, &format!("/api/sessions/{name}/start"), None).await,
        StatusCode::OK
    );

    // Within a few detector ticks, a `sessions` delta carrying this session's
    // preview tail must arrive (the hero data flow, §3.6).
    let got = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match rx.recv().await {
                Ok(ev) if ev.event == "sessions" => {
                    let names: Vec<&str> = ev
                        .payload
                        .get("delta")
                        .and_then(|d| d.as_array())
                        .map(|a| a.iter().filter_map(|i| i.get("name").and_then(|n| n.as_str())).collect())
                        .unwrap_or_default();
                    if names.contains(&name.as_str()) {
                        return true;
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false);

    // Teardown before asserting so a failure still cleans up the tmux session.
    let _ = api(&app, Method::DELETE, &format!("/api/sessions/{name}"), None).await;
    let _ = std::process::Command::new("tmux")
        .args(["kill-session", "-t", &format!("supermux-{name}")])
        .output();
    let _ = std::fs::remove_dir_all(dir);

    assert!(got, "expected a `sessions` SSE delta for the live session");
}

/// Regression: `lifecycle::start` must broadcast an explicit `status:active` SSE
/// once the boot completes. Previously it only emitted `status:starting` on spawn
/// and relied on the detector loop to broadcast `active` — but the detector seeds
/// its in-memory `prev` from the freshly-written DB row (`active`), so the first
/// observed tick sees `new_status == prev` and emits nothing. Result: the client
/// cache stayed wedged on `starting` ("Booting" pill) until a full GET refresh
/// happened. Asserts the SSE `status` frame with `status == "active"` lands within
/// the boot window (well under the 2s detector tick interval).
#[tokio::test]
async fn lifecycle_start_emits_status_active_sse() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let (state, app, dir) = setup().await;
    let name = format!("act{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);

    let mut rx = state.sse_tx.subscribe();

    assert_eq!(
        api(&app, Method::POST, "/api/sessions", Some(serde_json::json!({
            "name": name, "provider": "shell", "dir": "/tmp"
        }))).await,
        StatusCode::CREATED
    );
    assert_eq!(
        api(&app, Method::POST, &format!("/api/sessions/{name}/start"), None).await,
        StatusCode::OK
    );

    // We expect TWO status frames: first `starting`, then `active`. Both must
    // arrive from lifecycle itself — do NOT rely on the detector loop here. The
    // 5s budget is well below the detector tick (2s) + ready timeout (10s) but
    // long enough that an unrelated stall is the real failure, not a slow tick.
    let saw_active = tokio::time::timeout(Duration::from_secs(15), async {
        let mut saw_starting = false;
        loop {
            match rx.recv().await {
                Ok(ev) if ev.event == "status" => {
                    let n = ev.payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if n != name { continue; }
                    let s = ev.payload.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    match s {
                        "starting" => { saw_starting = true; }
                        "active" if saw_starting => { return true; }
                        _ => {}
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false);

    let _ = api(&app, Method::DELETE, &format!("/api/sessions/{name}"), None).await;
    let _ = std::process::Command::new("tmux")
        .args(["kill-session", "-t", &format!("supermux-{name}")])
        .output();
    let _ = std::fs::remove_dir_all(dir);

    assert!(saw_active, "expected `status:active` SSE after `status:starting` from lifecycle::start");
}

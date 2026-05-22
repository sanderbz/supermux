//! End-to-end status hero-flow (TECH_PLAN §3.6, §10 M5b acceptance: "SSE clients
//! receive `{type:'sessions'...}` deltas as the detector ticks"). Spawns a REAL
//! tmux shell session, subscribes to the SSE broadcast, and asserts the detector
//! loop publishes a `sessions` delta once it captures the live pane. Requires
//! `tmux`; skips cleanly without it (CI has tmux per the M3/M5b verification note).

use std::time::Duration;

use amux_server::config::{Config, ProviderDefaults, TlsConfig};
use amux_server::state::AppState;
use amux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt;

const TOKEN: &str = "status-flow-token";

fn tmux_available() -> bool {
    which::which("tmux").is_ok()
}

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("amux-statusflow-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
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
        .args(["kill-session", "-t", &format!("amux3-{name}")])
        .output();
    let _ = std::fs::remove_dir_all(dir);

    assert!(got, "expected a `sessions` SSE delta for the live session");
}

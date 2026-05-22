//! Scheduler integration: a `kind=shell` one-shot fires within the tick window
//! (TECH_PLAN §3.8, M8 acceptance; subagent prompt's marker test) and the HTTP
//! CRUD surface round-trips through the bearer-auth router.

use std::path::PathBuf;
use std::time::Duration;

use amux_server::config::{Config, ProviderDefaults, TlsConfig};
use amux_server::state::AppState;
use amux_server::{db, http, scheduler};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "scheduler-test-token";

fn temp_config() -> (Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("amux-sched-test-{}", uuid::Uuid::new_v4()));
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
    (config, dir)
}

async fn new_state() -> (AppState, PathBuf) {
    let (config, dir) = temp_config();
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

async fn send(app: &axum::Router, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
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

/// "in 1s" shell schedule touches a marker file; the 10s tick must fire it
/// within the test's 12s window (the marker proves the runner ran end-to-end).
#[tokio::test]
async fn in_one_second_shell_job_fires() {
    let (state, dir) = new_state().await;
    let marker = dir.join("marker.txt");
    assert!(!marker.exists());

    let sched = scheduler::create(
        &state,
        scheduler::CreateScheduleInput {
            title: "marker".into(),
            command: format!("touch {}", marker.display()),
            kind: Some("shell".into()),
            schedule_expr: Some("in 1s".into()),
            ..Default::default()
        },
    )
    .await
    .expect("create schedule");
    assert_eq!(sched.sched_type, "once");
    assert_eq!(sched.enabled, 1);

    scheduler::spawn(state.clone());

    // 10s tick + a bit of slack; the marker must appear inside the window.
    let mut fired = false;
    for _ in 0..24 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if marker.exists() {
            fired = true;
            break;
        }
    }
    assert!(fired, "shell schedule did not fire within 12s");

    // One-shot disables itself after firing.
    let after = db::schedules::get(&state.pool, &sched.id).await.unwrap().unwrap();
    assert_eq!(after.enabled, 0, "one-shot should disable after firing");
    assert_eq!(after.run_count, 1);

    let runs = db::schedules::runs_for(&state.pool, &sched.id, 10).await.unwrap();
    assert!(runs.iter().any(|r| r.status == "ok"), "expected an ok run row");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// HTTP create → list → run-now → runs → delete, plus bad-expression rejection.
#[tokio::test]
async fn http_crud_roundtrip() {
    let (state, dir) = new_state().await;
    let app = http::router(state.clone());

    // Bad expression → 400.
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({ "title": "bad", "command": "echo hi", "kind": "shell", "schedule_expr": "whenever" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Create a valid recurring shell schedule.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({ "title": "tick", "command": "true", "kind": "shell", "schedule_expr": "every 1m" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = body["data"]["id"].as_str().unwrap().to_string();
    assert_eq!(body["data"]["sched_type"], "recurring");
    assert!(body["data"]["next_run"].is_string());

    // List shows it.
    let (status, body) = send(&app, Method::GET, "/api/schedules", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"].as_array().unwrap().len(), 1);

    // Single fetch.
    let (status, body) = send(&app, Method::GET, &format!("/api/schedules/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["id"], id);

    // The static /runs feed must NOT be captured by the {id} route.
    let (status, body) = send(&app, Method::GET, "/api/schedules/runs", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["data"].is_array());

    // Run now (202) then confirm a run row landed.
    let (status, _) = send(&app, Method::POST, &format!("/api/schedules/{id}/run"), None).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let mut ran = false;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let runs = db::schedules::runs_for(&state.pool, &id, 10).await.unwrap();
        if runs.iter().any(|r| r.status == "ok") {
            ran = true;
            break;
        }
    }
    assert!(ran, "manual run did not record an ok run");
    // Manual run must NOT advance next_run cadence (still recurring).
    let after = db::schedules::get(&state.pool, &id).await.unwrap().unwrap();
    assert_eq!(after.run_count, 1);

    let (status, body) = send(&app, Method::GET, &format!("/api/schedules/{id}/runs"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body["data"].as_array().unwrap().is_empty());

    // Patch: disable.
    let (status, body) = send(
        &app,
        Method::PATCH,
        &format!("/api/schedules/{id}"),
        Some(json!({ "enabled": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["enabled"], 0);

    // Delete → 404 on re-fetch.
    let (status, _) = send(&app, Method::DELETE, &format!("/api/schedules/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&app, Method::GET, &format!("/api/schedules/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// Unauthenticated requests are rejected by the shared bearer layer.
#[tokio::test]
async fn requires_auth() {
    let (state, dir) = new_state().await;
    let app = http::router(state.clone());
    let resp = app
        .clone()
        .oneshot(Request::builder().uri("/api/schedules").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

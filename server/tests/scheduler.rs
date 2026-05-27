//! Scheduler integration: a `kind=shell` one-shot fires within the tick window
//! (TECH_PLAN §3.8, M8 acceptance; subagent prompt's marker test) and the HTTP
//! CRUD surface round-trips through the bearer-auth router.

use std::path::PathBuf;
use std::time::Duration;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http, scheduler};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "scheduler-test-token";

fn temp_config() -> (Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-sched-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        // `ws` was added to `Config` after this test's milestone branched; default
        // it so the full suite compiles against the merged `Config`.
        ws: WsConfig::default(),
        remote_callback_url: None,
            push_sub: None,
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

/// M21 preview: parse an expression WITHOUT persisting and get the next 5 runs.
#[tokio::test]
async fn preview_returns_next_runs_without_persisting() {
    let (state, dir) = new_state().await;
    let app = http::router(state.clone());

    // Recurring expression → 5 future, strictly-ascending fire times.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/schedules/preview",
        Some(json!({ "expression": "every 5m" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let runs = body["data"]["next_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 5, "recurring expression previews 5 runs");
    let parsed: Vec<chrono::DateTime<chrono::Utc>> = runs
        .iter()
        .map(|v| v.as_str().unwrap().parse().unwrap())
        .collect();
    for w in parsed.windows(2) {
        assert!(w[1] > w[0], "preview runs must strictly ascend");
    }

    // One-shot expression → exactly one run.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/schedules/preview",
        Some(json!({ "expression": "in 30m" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["next_runs"].as_array().unwrap().len(), 1);

    // Bad expression → 400.
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/schedules/preview",
        Some(json!({ "expression": "whenever" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Nothing was persisted by previewing.
    assert!(db::schedules::list(&state.pool).await.unwrap().is_empty());

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The recipe / command picker source: `/api/schedules/commands` returns the REAL
/// installed agent commands (skills + user/managed commands + claude.ai MCP
/// connectors) and NEVER the built-in Claude slash commands like `/clear`/`/init`.
#[tokio::test]
async fn commands_endpoint_excludes_builtins_and_requires_auth() {
    let (state, dir) = new_state().await;
    let app = http::router(state.clone());

    // Bearer required (it rides the protected router).
    let unauth = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/schedules/commands")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

    // Authed: an array of {cmd, desc, source}; NO built-in slash commands.
    let (status, body) = send(&app, Method::GET, "/api/schedules/commands", None).await;
    assert_eq!(status, StatusCode::OK);
    let items = body["data"].as_array().expect("data is an array");
    for it in items {
        let cmd = it["cmd"].as_str().unwrap_or("");
        let source = it["source"].as_str().unwrap_or("");
        assert!(
            matches!(source, "skill" | "command" | "mcp"),
            "every entry carries a real source, got {source:?}"
        );
        // None of the built-in Claude commands leak into the recipe picker.
        for builtin in ["/clear", "/init", "/compact", "/mcp", "/help"] {
            assert_ne!(cmd, builtin, "built-in {builtin} must be excluded");
        }
    }

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// A scheduled job may carry a command AND/OR a free-text prompt. A `tmux` job
/// with only a prompt (no command) is valid and round-trips; one with NEITHER is
/// rejected.
#[tokio::test]
async fn job_accepts_command_or_prompt_and_rejects_neither() {
    let (state, dir) = new_state().await;
    let app = http::router(state.clone());

    // Prompt-only tmux job → created.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({
            "title": "prompt only",
            "prompt": "summarise the board",
            "session": "alpha",
            "kind": "tmux",
            "schedule_expr": "every 1h",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["data"]["command"], "");
    assert_eq!(body["data"]["prompt"], "summarise the board");

    // Command + prompt together → both persisted.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({
            "title": "command and prompt",
            "command": "/supermux-task",
            "prompt": "post a status update",
            "session": "alpha",
            "kind": "tmux",
            "schedule_expr": "every 1h",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["data"]["command"], "/supermux-task");
    assert_eq!(body["data"]["prompt"], "post a status update");

    // Neither command nor prompt → 400.
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({
            "title": "empty",
            "session": "alpha",
            "kind": "tmux",
            "schedule_expr": "every 1h",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// M21 test-fire: `_test_fire:true` runs once immediately, returns the result,
/// and leaves NO live schedule behind.
#[tokio::test]
async fn test_fire_runs_once_and_does_not_persist() {
    let (state, dir) = new_state().await;
    let app = http::router(state.clone());
    let marker = dir.join("test-fire-marker.txt");
    assert!(!marker.exists());

    let (status, body) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({
            "title": "test fire",
            "command": format!("touch {}", marker.display()),
            "kind": "shell",
            "schedule_expr": "every 5m",
            "_test_fire": true,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["status"], "ok", "test-fire should run successfully");
    assert!(marker.exists(), "the shell job ran during test-fire");

    // No live schedule persisted.
    assert!(
        db::schedules::list(&state.pool).await.unwrap().is_empty(),
        "test-fire must not leave a live schedule"
    );

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

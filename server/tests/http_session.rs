//! Integration tests for the tmux-free session HTTP surface (TECH_PLAN §3.4, M2
//! acceptance). Driven via `axum::Router::oneshot` against an isolated temp-dir
//! database. Covers: create=201, duplicate-name=409, missing=404, PATCH rename
//! end-to-end, plus tracked-files / steering round-trips and auth enforcement.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "secret-test-token-123";

async fn test_app() -> (axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-http-test-{}", uuid::Uuid::new_v4()));
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
    (http::router(state), dir)
}

/// Send an authenticated request; returns (status, parsed-JSON-body).
async fn send(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
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

fn cleanup(dir: std::path::PathBuf) {
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn create_returns_201_and_get_roundtrips() {
    let (app, dir) = test_app().await;

    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "alpha", "dir": "/tmp/alpha", "provider": "shell" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["data"]["name"], json!("alpha"));
    assert_eq!(body["data"]["provider"], json!("shell"));
    assert_eq!(body["data"]["status"], json!("stopped"));
    assert_eq!(body["data"]["preview_lines"], json!([]));

    // It shows up in the list and is fetchable by name.
    let (status, body) = send(&app, Method::GET, "/api/sessions", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"].as_array().unwrap().len(), 1);

    let (status, body) = send(&app, Method::GET, "/api/sessions/alpha", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["dir"], json!("/tmp/alpha"));

    cleanup(dir);
}

#[tokio::test]
async fn duplicate_name_create_returns_409() {
    let (app, dir) = test_app().await;
    let mk = || json!({ "name": "dup", "dir": "/tmp/dup", "provider": "shell" });

    let (status, _) = send(&app, Method::POST, "/api/sessions", Some(mk())).await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, body) = send(&app, Method::POST, "/api/sessions", Some(mk())).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["ok"], json!(false));

    cleanup(dir);
}

#[tokio::test]
async fn invalid_name_returns_400() {
    let (app, dir) = test_app().await;
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "bad name/slash", "provider": "shell" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    cleanup(dir);
}

#[tokio::test]
async fn get_nonexistent_returns_404() {
    let (app, dir) = test_app().await;
    let (status, body) = send(&app, Method::GET, "/api/sessions/ghost", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["ok"], json!(false));
    cleanup(dir);
}

#[tokio::test]
async fn patch_config_rename_works_end_to_end() {
    let (app, dir) = test_app().await;

    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "r1", "dir": "/tmp/r1", "provider": "shell" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Queue a steering message so the rename must repoint a child FK row too.
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions/r1/steer",
        Some(json!({ "text": "keep going" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = send(
        &app,
        Method::PATCH,
        "/api/sessions/r1/config",
        Some(json!({ "rename": "r2" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["name"], json!("r2"));

    // New name resolves, old name is gone, and the steering row followed.
    let (status, _) = send(&app, Method::GET, "/api/sessions/r2", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&app, Method::GET, "/api/sessions/r1", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body) = send(&app, Method::GET, "/api/sessions/r2/steer", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"].as_array().unwrap().len(), 1);

    cleanup(dir);
}

#[tokio::test]
async fn patch_config_toggle_and_desc() {
    let (app, dir) = test_app().await;
    send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "cfg", "provider": "shell" })),
    )
    .await;

    let (status, body) = send(
        &app,
        Method::PATCH,
        "/api/sessions/cfg/config",
        Some(json!({ "desc": "hello", "toggle_pin": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["desc"], json!("hello"));
    assert_eq!(body["data"]["pinned"], json!(true));

    // Empty patch is a 400 (nothing recognised to change).
    let (status, _) = send(
        &app,
        Method::PATCH,
        "/api/sessions/cfg/config",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    cleanup(dir);
}

#[tokio::test]
async fn duplicate_endpoint_copies_config() {
    let (app, dir) = test_app().await;
    send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "orig", "dir": "/tmp/orig", "desc": "d", "provider": "codex" })),
    )
    .await;

    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions/orig/duplicate",
        Some(json!({ "new_name": "copy" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["data"]["name"], json!("copy"));
    assert_eq!(body["data"]["dir"], json!("/tmp/orig"));
    assert_eq!(body["data"]["provider"], json!("codex"));

    // Duplicating onto an existing name conflicts.
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions/orig/duplicate",
        Some(json!({ "new_name": "copy" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    cleanup(dir);
}

#[tokio::test]
async fn delete_removes_session() {
    let (app, dir) = test_app().await;
    send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "del", "provider": "shell" })),
    )
    .await;

    let (status, _) = send(&app, Method::DELETE, "/api/sessions/del", None).await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(&app, Method::GET, "/api/sessions/del", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Deleting a missing session is a 404.
    let (status, _) = send(&app, Method::DELETE, "/api/sessions/del", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    cleanup(dir);
}

#[tokio::test]
async fn tracked_files_round_trip() {
    let (app, dir) = test_app().await;
    send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "tf", "provider": "shell" })),
    )
    .await;

    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions/tf/tracked-files",
        Some(json!({ "files": ["a.rs", "b.rs"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["files"], json!(["a.rs", "b.rs"]));

    let (status, body) = send(
        &app,
        Method::DELETE,
        "/api/sessions/tf/tracked-files",
        Some(json!({ "files": ["a.rs"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["files"], json!(["b.rs"]));

    // Tracked-files on a missing session is a 404.
    let (status, _) = send(&app, Method::GET, "/api/sessions/ghost/tracked-files", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    cleanup(dir);
}

#[tokio::test]
async fn steering_queue_round_trip() {
    let (app, dir) = test_app().await;
    send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "st", "provider": "shell" })),
    )
    .await;

    for text in ["one", "two"] {
        let (status, _) = send(
            &app,
            Method::POST,
            "/api/sessions/st/steer",
            Some(json!({ "text": text })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    let (status, body) = send(&app, Method::GET, "/api/sessions/st/steer", None).await;
    assert_eq!(status, StatusCode::OK);
    let items = body["data"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["text"], json!("one"));

    // Clear all (no body).
    let (status, body) = send(&app, Method::DELETE, "/api/sessions/st/steer", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["cleared"], json!(2));

    let (status, body) = send(&app, Method::GET, "/api/sessions/st/steer", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["data"].as_array().unwrap().is_empty());

    cleanup(dir);
}

#[tokio::test]
async fn sessions_routes_require_auth() {
    // A sub-route with no token must 401 (bearer auth on every protected route).
    let (app, dir) = test_app().await;
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/sessions/x/steer")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    cleanup(dir);
}

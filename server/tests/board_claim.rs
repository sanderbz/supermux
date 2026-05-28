//! Atomic-claim race test (TECH_PLAN §7, M6 acceptance).
//!
//! Spawn 100 concurrent `POST /api/board/{id}/claim` against the SAME agent issue
//! and assert exactly one `200 OK` and ninety-nine `409 Conflict` — and crucially
//! **zero 500s** (the Codex #1 hardening: `busy_timeout` + `BEGIN IMMEDIATE`
//! converts SQLite write contention into the 409 path, never a `SQLITE_BUSY`).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "claim-race-token";

async fn test_app() -> (axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-claim-test-{}", uuid::Uuid::new_v4()));
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

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn hundred_concurrent_claims_yield_exactly_one_winner() {
    let (app, dir) = test_app().await;

    // Two worker sessions so claims set a valid `issues.session` FK.
    for s in ["worker", "rival"] {
        let (status, _) = send(
            &app,
            Method::POST,
            "/api/sessions",
            Some(json!({ "name": s, "provider": "shell" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
    }

    // One agent-owned, claimable issue.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "race me", "owner_type": "agent", "status": "todo" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = body["data"]["id"].as_str().unwrap().to_string();

    // 100 concurrent claims (alternating sessions).
    let ok = Arc::new(AtomicUsize::new(0));
    let conflict = Arc::new(AtomicUsize::new(0));
    let server_err = Arc::new(AtomicUsize::new(0));
    let other = Arc::new(AtomicUsize::new(0));

    let mut handles = Vec::new();
    for i in 0..100 {
        let app = app.clone();
        let id = id.clone();
        let (ok, conflict, server_err, other) = (
            ok.clone(),
            conflict.clone(),
            server_err.clone(),
            other.clone(),
        );
        let session = if i % 2 == 0 { "worker" } else { "rival" };
        handles.push(tokio::spawn(async move {
            let (status, _) = send(
                &app,
                Method::POST,
                &format!("/api/board/{id}/claim"),
                Some(json!({ "session": session })),
            )
            .await;
            match status {
                StatusCode::OK => ok.fetch_add(1, Ordering::SeqCst),
                StatusCode::CONFLICT => conflict.fetch_add(1, Ordering::SeqCst),
                StatusCode::INTERNAL_SERVER_ERROR => server_err.fetch_add(1, Ordering::SeqCst),
                _ => other.fetch_add(1, Ordering::SeqCst),
            };
        }));
    }
    for h in handles {
        h.await.unwrap();
    }

    let ok = ok.load(Ordering::SeqCst);
    let conflict = conflict.load(Ordering::SeqCst);
    let server_err = server_err.load(Ordering::SeqCst);
    let other = other.load(Ordering::SeqCst);

    assert_eq!(server_err, 0, "no claim may 500 (busy_timeout + BEGIN IMMEDIATE)");
    assert_eq!(other, 0, "every claim is either 200 or 409");
    assert_eq!(ok, 1, "exactly one claim wins");
    assert_eq!(conflict, 99, "the other 99 conflict");

    // The winning issue is now `doing` and assigned to one of the workers.
    let (status, body) = send(&app, Method::GET, "/api/board?done_limit=0", None).await;
    assert_eq!(status, StatusCode::OK);
    let issue = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == json!(id))
        .expect("claimed issue present");
    assert_eq!(issue["status"], json!("doing"));
    assert!(matches!(
        issue["session"].as_str(),
        Some("worker") | Some("rival")
    ));

    let _ = std::fs::remove_dir_all(dir);
}

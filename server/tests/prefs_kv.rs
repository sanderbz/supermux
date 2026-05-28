//! Round-trip + access-control coverage for the `/api/prefs/:key` endpoint
//! added with the overview sort + custom groups feature.
//!
//! The single source of truth for the user's sort mode + custom ordering +
//! group definitions is the server's `prefs` table — these tests pin the wire
//! contract that the frontend relies on:
//!   * unknown keys 404 (allowlist enforced),
//!   * unset key reads `value: null`,
//!   * round-trip upsert is value-stable,
//!   * oversize payloads 400,
//!   * unauthenticated requests 401.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "prefs-kv-test-token";

async fn test_app() -> (axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-prefs-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
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
    auth: bool,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if auth {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    }
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

#[tokio::test]
async fn unknown_pref_key_404s() {
    let (app, _dir) = test_app().await;
    let (status, _) = send(&app, Method::GET, "/api/prefs/bogus_key", None, true).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/prefs/bogus_key",
        Some(json!({ "value": "x" })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unauthenticated_pref_is_rejected() {
    let (app, _dir) = test_app().await;
    let (status, _) = send(&app, Method::GET, "/api/prefs/overview_layout", None, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn overview_layout_round_trips() {
    let (app, _dir) = test_app().await;
    // Unset key returns null.
    let (status, body) =
        send(&app, Method::GET, "/api/prefs/overview_layout", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["value"], Value::Null);

    let payload = json!({
        "mode": "custom",
        "custom": [
            { "type": "group", "id": "g_work", "name": "Work" },
            { "type": "session", "name": "demo" }
        ]
    })
    .to_string();

    let (status, body) = send(
        &app,
        Method::PUT,
        "/api/prefs/overview_layout",
        Some(json!({ "value": payload.clone() })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["value"], Value::String(payload.clone()));

    let (status, body) =
        send(&app, Method::GET, "/api/prefs/overview_layout", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["value"], Value::String(payload));
}

#[tokio::test]
async fn quick_keys_round_trips() {
    let (app, _dir) = test_app().await;
    // Unset key returns null (the client renders the default selection).
    let (status, body) = send(&app, Method::GET, "/api/prefs/quick_keys", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["value"], Value::Null);

    let payload = json!({
        "selected": ["key:Esc", "key:Ctrl-C", "text:continue", "slash:/compact"]
    })
    .to_string();

    let (status, body) = send(
        &app,
        Method::PUT,
        "/api/prefs/quick_keys",
        Some(json!({ "value": payload.clone() })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["value"], Value::String(payload.clone()));

    let (status, body) = send(&app, Method::GET, "/api/prefs/quick_keys", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["value"], Value::String(payload));
}

#[tokio::test]
async fn oversize_pref_value_rejected() {
    let (app, _dir) = test_app().await;
    let huge = "x".repeat(60 * 1024);
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/prefs/overview_layout",
        Some(json!({ "value": huge })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

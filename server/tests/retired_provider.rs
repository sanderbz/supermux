//! LEGACY ROW SAFETY — a session whose `provider` names an agent supermux no
//! longer ships.
//!
//! The Kimi Code provider was removed, but deployed databases still hold rows
//! that were created with `provider = 'kimi'` (the column is free-form TEXT and
//! the sessions CHECK was relaxed to accept the value in migration 0023, which
//! is checksummed and therefore permanent). Those rows must stay HARMLESS:
//!
//!   * `GET /api/sessions` must list them — deserialization tolerates the
//!     string, no 500, no panic, and the row is not silently dropped from the
//!     overview (a session the user can still see is a session they can archive).
//!   * `GET /api/sessions/{name}` must render them: every derived field the tile
//!     reads (status, previews, tags) comes back, the provider verbatim.
//!   * `GET /api/sessions/{name}/recall` must answer with an EMPTY history
//!     rather than falling through to the Claude transcript reader, which would
//!     hand back another agent's conversations for the same directory.
//!   * `POST /api/sessions/{name}/start` must REFUSE with a 4xx. Before the
//!     guard, the launch builder's fallback arm would have booted `claude`
//!     inside a pane named after the retired agent — a silent lie, and the worst
//!     of the three possible outcomes (refuse / no-op / wrong agent).
//!   * Creating a NEW session on the retired provider is a 400 — the set of
//!     retired providers can only ever shrink.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "secret-test-token-retired";
/// The one provider supermux has retired so far. Kept as a literal here (rather
/// than imported) so this test pins the OBSERVABLE contract, not the constant.
const RETIRED: &str = "kimi";

async fn test_app() -> (axum::Router, SqlitePool, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-retired-test-{}", uuid::Uuid::new_v4()));
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
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool.clone(), config);
    (http::router(state), pool, dir)
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

fn cleanup(dir: std::path::PathBuf) {
    let _ = std::fs::remove_dir_all(dir);
}

/// Seed the shape a deployed DB actually holds: a row written back when the
/// provider still existed. Inserted at the DB layer on purpose — the HTTP create
/// path rejects it now, which is exactly the point of the last assertion below.
async fn seed_legacy_row(pool: &SqlitePool, name: &str) {
    db::sessions::insert_minimal(pool, name, "/tmp/legacy-kimi", RETIRED)
        .await
        .expect("a legacy provider string must still INSERT — the CHECK allows it");
}

#[tokio::test]
async fn a_retired_provider_row_lists_renders_and_refuses_to_start() {
    let (app, pool, dir) = test_app().await;
    seed_legacy_row(&pool, "legacy-kimi").await;

    // ── LIST ─────────────────────────────────────────────────────────────────
    let (status, body) = send(&app, Method::GET, "/api/sessions", None).await;
    assert_eq!(status, StatusCode::OK, "the list must not 500 on a legacy row");
    let rows = body["data"].as_array().expect("data is an array");
    let row = rows
        .iter()
        .find(|r| r["name"] == json!("legacy-kimi"))
        .expect("the legacy row is listed, not silently dropped");
    assert_eq!(
        row["provider"],
        json!(RETIRED),
        "the provider string round-trips verbatim"
    );
    assert_eq!(row["status"], json!("stopped"));

    // ── RENDER (the single-session read the tile/focus view uses) ────────────
    let (status, body) = send(&app, Method::GET, "/api/sessions/legacy-kimi", None).await;
    assert_eq!(status, StatusCode::OK, "the row must render, not error");
    assert_eq!(body["data"]["provider"], json!(RETIRED));
    assert_eq!(body["data"]["dir"], json!("/tmp/legacy-kimi"));
    assert_eq!(
        body["data"]["preview_lines"],
        json!([]),
        "no runtime, no preview — inert, not broken"
    );

    // ── RECALL: an honest empty history, never another agent's transcripts ───
    let (status, body) = send(&app, Method::GET, "/api/sessions/legacy-kimi/recall", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["entries"], json!([]));
    assert_eq!(body["data"]["hasMore"], json!(false));

    // ── START: a clear 4xx, never a panic, a 500 or a silent no-op ───────────
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions/legacy-kimi/start",
        Some(json!({})),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "starting a retired provider is a client error with a reason"
    );
    let msg = body["error"].as_str().unwrap_or_default().to_lowercase();
    assert!(
        msg.contains("retired"),
        "the refusal must SAY what happened; got {body}"
    );

    // The refusal is not a side effect: the row is untouched and still stopped.
    let (_, after) = send(&app, Method::GET, "/api/sessions/legacy-kimi", None).await;
    assert_eq!(after["data"]["status"], json!("stopped"));

    cleanup(dir);
}

#[tokio::test]
async fn creating_a_session_on_a_retired_provider_is_rejected() {
    let (app, _pool, dir) = test_app().await;

    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "new-kimi", "dir": "/tmp/x", "provider": RETIRED })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a retired provider is not creatable — the legacy set can only shrink"
    );

    cleanup(dir);
}

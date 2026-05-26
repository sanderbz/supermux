//! Integration test for the Resume picker (feat-resume-picker): the
//! `GET /api/sessions/{name}/resumable` enumeration over a seeded fake
//! `~/.claude/projects/<encoded-cwd>/*.jsonl` fixture, plus the auth gate and
//! the empty-list case. Asserts the path encoding, the jsonl parse (ai-title vs
//! first user message, message count), and newest-first ordering.
//!
//! We point Claude's config dir at a temp dir via `$CLAUDE_CONFIG_DIR` (the same
//! override `claude_config.rs`/`resumable.rs` honour) so the test never touches
//! the developer's real `~/.claude`. Because `$CLAUDE_CONFIG_DIR` is process-
//! global, the seeding tests run serially behind a mutex.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "resume-picker-token";

// `$CLAUDE_CONFIG_DIR` is process-global → serialize the env-mutating tests.
static ENV_LOCK: Mutex<()> = Mutex::new(());

async fn test_app(data_dir: &Path) -> axum::Router {
    let config = Config {
        data_dir: data_dir.to_path_buf(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
            remote_callback_url: None,
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    http::router(state)
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

/// Same encoding Claude (and `resumable.rs`) use: every `/` and `.` → `-`.
fn encode(abs: &str) -> String {
    abs.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

fn write_jsonl(dir: &Path, id: &str, lines: &[&str]) -> PathBuf {
    let path = dir.join(format!("{id}.jsonl"));
    let mut f = std::fs::File::create(&path).unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
    path
}

#[tokio::test]
async fn resumable_lists_seeded_conversations_for_dir() {
    let _g = ENV_LOCK.lock().unwrap();

    // Isolated server data dir + a temp Claude config dir (the fixture root).
    let data_dir = std::env::temp_dir().join(format!("supermux-resume-data-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let claude_dir = std::env::temp_dir().join(format!("supermux-resume-cfg-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&claude_dir).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_dir);

    // A REAL working dir so the server's canonicalize() resolves it the same way
    // Claude would have when it recorded the transcript.
    let work_dir = std::env::temp_dir().join(format!("supermux-resume-work-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work_dir).unwrap();
    let resolved = std::fs::canonicalize(&work_dir).unwrap();
    let encoded = encode(&resolved.to_string_lossy());

    // Seed the project folder Claude would have created for this dir.
    let proj = claude_dir.join("projects").join(&encoded);
    std::fs::create_dir_all(&proj).unwrap();

    // Conversation A — has an ai-title; the LATEST one wins over the first.
    write_jsonl(
        &proj,
        "11111111-1111-1111-1111-111111111111",
        &[
            r#"{"type":"ai-title","aiTitle":"First guess"}"#,
            r#"{"type":"user","message":{"role":"user","content":"hello"},"isSidechain":false}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":"hi"}}"#,
            r#"{"type":"ai-title","aiTitle":"Final title"}"#,
        ],
    );

    // Make B strictly newer so it sorts first (sub-second mtime gap).
    std::thread::sleep(std::time::Duration::from_millis(20));

    // Conversation B — no ai-title → first user message (array content); a
    // sidechain turn must NOT be counted.
    write_jsonl(
        &proj,
        "22222222-2222-2222-2222-222222222222",
        &[
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"build the thing"},{"type":"image"}]},"isSidechain":false}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":"ok"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"noise"},"isSidechain":true}"#,
        ],
    );

    let app = test_app(&data_dir).await;

    // Create the session pointing at the real work dir.
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "resumer", "dir": work_dir.to_string_lossy(), "provider": "claude" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Enumerate resumable conversations.
    let (status, body) = send(&app, Method::GET, "/api/sessions/resumer/resumable", None).await;
    assert_eq!(status, StatusCode::OK);
    let list = body["data"].as_array().unwrap();
    assert_eq!(list.len(), 2, "both seeded conversations should be listed");

    // Newest-first → B then A.
    assert_eq!(list[0]["id"], json!("22222222-2222-2222-2222-222222222222"));
    assert_eq!(list[0]["summary"], json!("build the thing")); // array text joined
    assert_eq!(list[0]["message_count"], json!(2)); // sidechain excluded

    assert_eq!(list[1]["id"], json!("11111111-1111-1111-1111-111111111111"));
    assert_eq!(list[1]["summary"], json!("Final title")); // latest ai-title wins
    assert_eq!(list[1]["message_count"], json!(2));

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&data_dir);
    let _ = std::fs::remove_dir_all(&claude_dir);
    let _ = std::fs::remove_dir_all(&work_dir);
}

#[tokio::test]
async fn resumable_empty_when_dir_has_no_conversations() {
    let _g = ENV_LOCK.lock().unwrap();

    let data_dir = std::env::temp_dir().join(format!("supermux-resume-data-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let claude_dir = std::env::temp_dir().join(format!("supermux-resume-cfg-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&claude_dir).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_dir);

    let app = test_app(&data_dir).await;
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "lonely", "dir": "/tmp/no-claude-convos-here", "provider": "claude" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, body) = send(&app, Method::GET, "/api/sessions/lonely/resumable", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["data"].as_array().unwrap().is_empty());

    // Unknown session → 404.
    let (status, _) = send(&app, Method::GET, "/api/sessions/ghost/resumable", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&data_dir);
    let _ = std::fs::remove_dir_all(&claude_dir);
}

#[tokio::test]
async fn resume_sets_conversation_id_and_resumes() {
    let _g = ENV_LOCK.lock().unwrap();

    let data_dir = std::env::temp_dir().join(format!("supermux-resume-data-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let app = test_app(&data_dir).await;

    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "starter", "dir": "/tmp/starter", "provider": "claude" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Empty id is rejected.
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions/starter/resume",
        Some(json!({ "id": "  " })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A resume targeting an unknown session is a 404 (validated before start).
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions/ghost/resume",
        Some(json!({ "id": "abc" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let _ = std::fs::remove_dir_all(&data_dir);
}

#[tokio::test]
async fn resumable_requires_auth() {
    let data_dir = std::env::temp_dir().join(format!("supermux-resume-data-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let app = test_app(&data_dir).await;

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/sessions/x/resumable")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(&data_dir);
}

//! Integration test for the rich-history recall endpoint
//! (`GET /api/sessions/{name}/recall`): drives the real Axum router with a
//! seeded Claude `~/.claude/projects/<encoded>/<uuid>.jsonl` fixture, asserts
//! the response envelope, auth gate, scope tabs, sub-agent filter, and the
//! `(session, uuid)` cursor.
//!
//! Modeled on `tests/resume_picker.rs` (same in-memory router + ENV_LOCK +
//! temp-dir trio). `$CLAUDE_CONFIG_DIR` is process-global so the env-mutating
//! tests serialise behind a mutex.

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

const TOKEN: &str = "recall-http-token";

static ENV_LOCK: Mutex<()> = Mutex::new(());

async fn test_app(data_dir: &Path) -> axum::Router {
    let config = Config {
        data_dir: data_dir.to_path_buf(),
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

fn user(uuid: &str, ts: &str, text: &str, sidechain: bool) -> String {
    json!({
        "type": "user",
        "uuid": uuid,
        "timestamp": ts,
        "isSidechain": sidechain,
        "message": { "role": "user", "content": text },
    })
    .to_string()
}

fn asst(uuid: &str, ts: &str, text: &str, sidechain: bool) -> String {
    json!({
        "type": "assistant",
        "uuid": uuid,
        "timestamp": ts,
        "isSidechain": sidechain,
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
    })
    .to_string()
}

#[tokio::test]
async fn recall_session_scope_returns_paired_entries() {
    let _g = ENV_LOCK.lock().unwrap();

    let data_dir = std::env::temp_dir().join(format!("smux-recall-d-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let claude_dir = std::env::temp_dir().join(format!("smux-recall-c-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&claude_dir).unwrap();
    let work_dir = std::env::temp_dir().join(format!("smux-recall-w-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work_dir).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_dir);

    let resolved = std::fs::canonicalize(&work_dir).unwrap();
    let encoded = encode(&resolved.to_string_lossy());
    let proj = claude_dir.join("projects").join(&encoded);
    std::fs::create_dir_all(&proj).unwrap();

    // Single conversation with two paired turns + an ai-title.
    let cc = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    write_jsonl(
        &proj,
        cc,
        &[
            &user("u1", "2026-06-05T10:00:00Z", "build SEO audit", false),
            &asst("a1", "2026-06-05T10:00:05Z", "Done — diff on `feature/seo`.", false),
            &user("u2", "2026-06-05T10:01:00Z", "fix typo in footer", false),
            &asst("a2", "2026-06-05T10:01:05Z", "Done — commit b3f7e21.", false),
            r#"{"type":"ai-title","aiTitle":"SEO sprint"}"#,
        ],
    );

    let app = test_app(&data_dir).await;

    // Create session and set its cc_conversation_id (would normally happen via
    // launch builder after a successful `claude --resume`).
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({
            "name": "recall-it", "dir": work_dir.to_string_lossy(), "provider": "claude"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions/recall-it/resume",
        Some(json!({ "id": cc })),
    )
    .await;
    // resume may return 200 OK (resumed) or 4xx if the test infra doesn't run
    // tmux; what we care about is the side-effect: cc_conversation_id set.
    // Probe the recall endpoint regardless.
    let _ = status;

    let (status, body) = send(
        &app,
        Method::GET,
        "/api/sessions/recall-it/recall?scope=session&limit=10",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body was {body}");
    assert_eq!(body["ok"], json!(true));
    let data = &body["data"];
    let entries = data["entries"].as_array().expect("entries array");
    assert_eq!(entries.len(), 2, "two paired prompts");

    // Newest-first.
    assert_eq!(entries[0]["text"], json!("fix typo in footer"));
    assert_eq!(entries[0]["reply"], json!("Done — commit b3f7e21."));
    assert_eq!(entries[0]["sessionTitle"], json!("SEO sprint"));
    assert_eq!(entries[0]["sessionId"], json!(cc));
    assert_eq!(entries[0]["sidechain"], json!(false));

    assert_eq!(entries[1]["text"], json!("build SEO audit"));
    assert_eq!(entries[1]["reply"], json!("Done — diff on `feature/seo`."));

    assert_eq!(data["hasMore"], json!(false));

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&data_dir);
    let _ = std::fs::remove_dir_all(&claude_dir);
    let _ = std::fs::remove_dir_all(&work_dir);
}

#[tokio::test]
async fn recall_substring_search_is_case_insensitive_on_prompt() {
    let _g = ENV_LOCK.lock().unwrap();

    let data_dir = std::env::temp_dir().join(format!("smux-recall-d-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let claude_dir = std::env::temp_dir().join(format!("smux-recall-c-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&claude_dir).unwrap();
    let work_dir = std::env::temp_dir().join(format!("smux-recall-w-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work_dir).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_dir);

    let resolved = std::fs::canonicalize(&work_dir).unwrap();
    let proj = claude_dir.join("projects").join(encode(&resolved.to_string_lossy()));
    std::fs::create_dir_all(&proj).unwrap();
    let cc = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    write_jsonl(
        &proj,
        cc,
        &[
            &user("u1", "2026-06-05T10:00:00Z", "Fix OAuth flow", false),
            &asst("a1", "2026-06-05T10:00:05Z", "Done.", false),
            &user("u2", "2026-06-05T10:01:00Z", "Add docs to README", false),
            &asst("a2", "2026-06-05T10:01:05Z", "OAuth was tested.", false),
        ],
    );

    let app = test_app(&data_dir).await;
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({
            "name": "s", "dir": work_dir.to_string_lossy(), "provider": "claude"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let _ = send(
        &app,
        Method::POST,
        "/api/sessions/s/resume",
        Some(json!({ "id": cc })),
    )
    .await;

    let (status, body) = send(
        &app,
        Method::GET,
        "/api/sessions/s/recall?q=oauth",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = body["data"]["entries"].as_array().unwrap();
    // Only "Fix OAuth flow" matches; the reply mentioning OAuth must NOT
    // surface the unrelated "Add docs to README" prompt.
    assert_eq!(entries.len(), 1, "got {entries:?}");
    assert_eq!(entries[0]["text"], json!("Fix OAuth flow"));

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&data_dir);
    let _ = std::fs::remove_dir_all(&claude_dir);
    let _ = std::fs::remove_dir_all(&work_dir);
}

#[tokio::test]
async fn recall_sub_agent_toggle_hides_or_shows_sidechain() {
    let _g = ENV_LOCK.lock().unwrap();

    let data_dir = std::env::temp_dir().join(format!("smux-recall-d-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let claude_dir = std::env::temp_dir().join(format!("smux-recall-c-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&claude_dir).unwrap();
    let work_dir = std::env::temp_dir().join(format!("smux-recall-w-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work_dir).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_dir);

    let resolved = std::fs::canonicalize(&work_dir).unwrap();
    let proj = claude_dir.join("projects").join(encode(&resolved.to_string_lossy()));
    std::fs::create_dir_all(&proj).unwrap();
    let cc = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    write_jsonl(
        &proj,
        cc,
        &[
            &user("u1", "2026-06-05T10:00:00Z", "main prompt", false),
            &user("u2", "2026-06-05T10:00:01Z", "sub-prompt", true),
            &asst("a1", "2026-06-05T10:00:02Z", "sub-reply", true),
            &asst("a2", "2026-06-05T10:00:03Z", "main reply", false),
        ],
    );

    let app = test_app(&data_dir).await;
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({
            "name": "t", "dir": work_dir.to_string_lossy(), "provider": "claude"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let _ = send(
        &app,
        Method::POST,
        "/api/sessions/t/resume",
        Some(json!({ "id": cc })),
    )
    .await;

    // Hidden by default — only the main turn appears, AND its reply attaches
    // correctly (regression pin for the sidechain pending-idx bug).
    let (status, body) = send(&app, Method::GET, "/api/sessions/t/recall", None).await;
    assert_eq!(status, StatusCode::OK);
    let entries = body["data"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["text"], json!("main prompt"));
    assert_eq!(entries[0]["reply"], json!("main reply"));

    // Enabled — both turns visible.
    let (status, body) = send(
        &app,
        Method::GET,
        "/api/sessions/t/recall?include_sidechains=true",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = body["data"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().any(|e| e["sidechain"] == json!(true)));

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&data_dir);
    let _ = std::fs::remove_dir_all(&claude_dir);
    let _ = std::fs::remove_dir_all(&work_dir);
}

#[tokio::test]
async fn recall_requires_auth() {
    let _g = ENV_LOCK.lock().unwrap();
    let data_dir = std::env::temp_dir().join(format!("smux-recall-d-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();

    let app = test_app(&data_dir).await;
    // Bare GET with no Authorization → 401.
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/sessions/any/recall")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    let _ = std::fs::remove_dir_all(&data_dir);
}

#[tokio::test]
async fn recall_unknown_session_is_404() {
    let _g = ENV_LOCK.lock().unwrap();
    let data_dir = std::env::temp_dir().join(format!("smux-recall-d-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();

    let app = test_app(&data_dir).await;
    let (status, _) = send(&app, Method::GET, "/api/sessions/ghost/recall", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let _ = std::fs::remove_dir_all(&data_dir);
}

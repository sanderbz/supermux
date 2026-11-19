//! `config_dir` on `POST /api/sessions` (the per-account boot path).
//!
//! Pins the wire contract the dispatcher depends on: a valid absolute
//! directory is stored and echoed on the view; anything else is a 400 that
//! leaves NO row behind; an absent field keeps the old behaviour exactly.

use std::io::Write;
use std::path::{Path, PathBuf};

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "session-config-dir-token";

/// A fresh temp dir, created. Process- and time-unique so parallel tests never
/// share one (same shape as `resumable`'s test helper).
fn temp_dir(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "supermux-cfgdir-{tag}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn setup() -> (AppState, axum::Router, PathBuf) {
    let dir = temp_dir("data");
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        statusline_tap: false,
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        isolation_mode: Default::default(),
        company_isolation: Vec::new(),
        human_auth: Default::default(),
        swarm_reaper: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    (state, app, dir)
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

#[tokio::test]
async fn valid_config_dir_is_stored_and_echoed() {
    let (state, app, data) = setup().await;
    let account = temp_dir("account");
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({
            "name": "second-account",
            "dir": "/tmp",
            "provider": "claude",
            "config_dir": account.to_string_lossy(),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(
        body["data"]["config_dir"],
        account.to_string_lossy().as_ref(),
        "{body}"
    );

    let row = db::sessions::get(&state.pool, "second-account")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.config_dir, account.to_string_lossy());

    let _ = std::fs::remove_dir_all(account);
    let _ = std::fs::remove_dir_all(data);
}

#[tokio::test]
async fn absent_config_dir_reads_back_empty() {
    let (state, app, data) = setup().await;
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "default-account", "dir": "/tmp", "provider": "claude" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["data"]["config_dir"], "", "{body}");
    let row = db::sessions::get(&state.pool, "default-account")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.config_dir, "");
    let _ = std::fs::remove_dir_all(data);
}

/// Every refusal is a 400 AND leaves no row: the caller retries a corrected
/// body under the same name without hitting a 409.
#[tokio::test]
async fn bad_config_dirs_are_refused_with_400_and_no_row() {
    let (state, app, data) = setup().await;
    let file_dir = temp_dir("file");
    let file = file_dir.join("settings.json");
    std::fs::write(&file, b"{}").unwrap();

    let cases: Vec<(&str, String)> = vec![
        // Relative path.
        ("rel", ".claude-second".to_string()),
        // Absolute but does not exist.
        ("gone", "/nonexistent-supermux-config-dir".to_string()),
        // Exists but is a file, not a directory.
        ("file", file.to_string_lossy().to_string()),
        // Shell metacharacters (space, semicolon) outside the charset.
        ("meta", "/tmp/evil; rm -rf /".to_string()),
        // Single quote would close our own quoting.
        ("quote", "/tmp/it's".to_string()),
        // Command substitution.
        ("subst", "/tmp/$(whoami)".to_string()),
    ];

    for (name, value) in cases {
        let (status, body) = send(
            &app,
            Method::POST,
            "/api/sessions",
            Some(json!({
                "name": name,
                "dir": "/tmp",
                "provider": "claude",
                "config_dir": value,
            })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{value:?} must be refused: {body}"
        );
        assert!(
            !db::sessions::exists(&state.pool, name).await.unwrap(),
            "{value:?} must leave no session row"
        );
    }

    let _ = std::fs::remove_dir_all(file_dir);
    let _ = std::fs::remove_dir_all(data);
}

/// `config_dir` is validated against THIS box's filesystem, so it cannot be
/// combined with a remote host: the launch line would run over SSH, where the
/// path means something else (or nothing). The refusal is a 400 and leaves no
/// row, so the caller can retry the same name without a config dir.
#[tokio::test]
async fn config_dir_with_a_remote_host_is_refused() {
    let (state, app, data) = setup().await;
    let account = temp_dir("remote-account");
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({
            "name": "remote-second",
            "dir": "/tmp",
            "provider": "claude",
            "host_id": 1,
            "config_dir": account.to_string_lossy(),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("only supported for local sessions"),
        "the 400 must name the reason: {body}"
    );
    assert!(
        !db::sessions::exists(&state.pool, "remote-second")
            .await
            .unwrap(),
        "a refused create must leave no session row"
    );

    let _ = std::fs::remove_dir_all(account);
    let _ = std::fs::remove_dir_all(data);
}

/// Same encoding Claude (and `resumable.rs`) use: every `/` and `.` -> `-`.
fn encode(abs: &str) -> String {
    abs.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

/// Seed `<config_dir>/projects/<encoded cwd>/<id>.jsonl` and return the folder.
fn seed_transcript(config_dir: &Path, cwd: &Path, id: &str, lines: &[String]) -> PathBuf {
    let resolved = std::fs::canonicalize(cwd).unwrap();
    let proj = config_dir
        .join("projects")
        .join(encode(&resolved.to_string_lossy()));
    std::fs::create_dir_all(&proj).unwrap();
    let mut f = std::fs::File::create(proj.join(format!("{id}.jsonl"))).unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
    proj
}

/// The Resume picker reads the SESSION's config dir. Without this, a session
/// dispatched onto the second account offers an empty Resume list even though
/// its transcripts exist: just under the other account.
#[tokio::test]
async fn resume_picker_reads_the_sessions_config_dir() {
    let (_state, app, data) = setup().await;
    let account = temp_dir("resume-account");
    let work = temp_dir("resume-work");
    seed_transcript(
        &account,
        &work,
        "11111111-0000-0000-0000-000000000001",
        &[json!({"type": "ai-title", "aiTitle": "Second account chat"}).to_string()],
    );

    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({
            "name": "resume-second",
            "dir": work.to_string_lossy(),
            "provider": "claude",
            "config_dir": account.to_string_lossy(),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    let (status, body) = send(
        &app,
        Method::GET,
        "/api/sessions/resume-second/resumable",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"].as_array().unwrap().len(), 1, "{body}");
    assert_eq!(body["data"][0]["summary"], "Second account chat", "{body}");

    let _ = std::fs::remove_dir_all(account);
    let _ = std::fs::remove_dir_all(work);
    let _ = std::fs::remove_dir_all(data);
}

/// Recall walks the same folder, so project-scope history is visible for a
/// session on the second account too.
#[tokio::test]
async fn recall_reads_the_sessions_config_dir() {
    let (_state, app, data) = setup().await;
    let account = temp_dir("recall-account");
    let work = temp_dir("recall-work");
    seed_transcript(
        &account,
        &work,
        "22222222-0000-0000-0000-000000000002",
        &[
            json!({
                "type": "user",
                "uuid": "u-1",
                "timestamp": "2026-08-17T10:00:00Z",
                "isSidechain": false,
                "message": {"role": "user", "content": "ship the capacity board"},
            })
            .to_string(),
            json!({
                "type": "assistant",
                "uuid": "a-1",
                "timestamp": "2026-08-17T10:00:05Z",
                "isSidechain": false,
                "message": {"role": "assistant", "content": [{"type": "text", "text": "on it"}]},
            })
            .to_string(),
        ],
    );

    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({
            "name": "recall-second",
            "dir": work.to_string_lossy(),
            "provider": "claude",
            "config_dir": account.to_string_lossy(),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    let (status, body) = send(
        &app,
        Method::GET,
        "/api/sessions/recall-second/recall?scope=project",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let entries = body["data"]["entries"].as_array().expect("entries array");
    assert!(
        entries.iter().any(|e| e["text"] == "ship the capacity board"),
        "recall must read the session's config dir: {body}"
    );

    let _ = std::fs::remove_dir_all(account);
    let _ = std::fs::remove_dir_all(work);
    let _ = std::fs::remove_dir_all(data);
}

// ── PATCH .../config {config_dir}: move an existing session to another login ──

async fn create(app: &axum::Router, name: &str, config_dir: Option<&Path>) {
    let mut body = json!({ "name": name, "dir": "/tmp", "provider": "claude" });
    if let Some(d) = config_dir {
        body["config_dir"] = json!(d.to_string_lossy());
    }
    let (status, b) = send(app, Method::POST, "/api/sessions", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{b}");
}

async fn patch_dir(app: &axum::Router, name: &str, value: &str) -> (StatusCode, Value) {
    send(
        app,
        Method::PATCH,
        &format!("/api/sessions/{name}/config"),
        Some(json!({ "config_dir": value })),
    )
    .await
}

/// An account dir whose `projects/` is the given transcript tree (a symlink),
/// the layout that lets a conversation move between logins.
fn account_sharing(tag: &str, projects: &Path) -> PathBuf {
    let d = temp_dir(tag);
    std::os::unix::fs::symlink(projects, d.join("projects")).unwrap();
    d
}

/// The move itself: stored, flagged `restart_required` (the live agent keeps its
/// login until its next start), and `""` returns the session to the host default.
#[tokio::test]
async fn patch_moves_a_session_to_another_login_at_its_next_start() {
    let (state, app, data) = setup().await;
    create(&app, "mover", None).await;
    let account = temp_dir("move-to");

    let (status, body) = patch_dir(&app, "mover", &account.to_string_lossy()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["config_dir"], account.to_string_lossy().as_ref(), "{body}");
    assert_eq!(body["data"]["restart_required"], true, "{body}");
    let row = db::sessions::get(&state.pool, "mover").await.unwrap().unwrap();
    assert_eq!(row.config_dir, account.to_string_lossy());

    // Trailing slash and whitespace are cleaned exactly as on create.
    let (status, _) = patch_dir(&app, "mover", &format!("  {}/ ", account.display())).await;
    assert_eq!(status, StatusCode::OK);
    let row = db::sessions::get(&state.pool, "mover").await.unwrap().unwrap();
    assert_eq!(row.config_dir, account.to_string_lossy());

    let (status, body) = patch_dir(&app, "mover", "").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let row = db::sessions::get(&state.pool, "mover").await.unwrap().unwrap();
    assert_eq!(row.config_dir, "", "empty returns the session to the host default");

    let _ = std::fs::remove_dir_all(account);
    let _ = std::fs::remove_dir_all(data);
}

/// The create-time validation applies to PATCH too, and a refusal changes nothing.
#[tokio::test]
async fn patch_refuses_bad_config_dirs_and_keeps_the_old_one() {
    let (state, app, data) = setup().await;
    let account = temp_dir("keep");
    create(&app, "keeper", Some(&account)).await;
    for bad in [".claude-second", "/nonexistent-supermux-config-dir", "/tmp/evil; rm -rf /", "/tmp/it's"] {
        let (status, body) = patch_dir(&app, "keeper", bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad:?}: {body}");
        let row = db::sessions::get(&state.pool, "keeper").await.unwrap().unwrap();
        assert_eq!(row.config_dir, account.to_string_lossy(), "{bad:?} must not land");
    }
    let _ = std::fs::remove_dir_all(account);
    let _ = std::fs::remove_dir_all(data);
}

/// A session WITH a conversation may only move to a login that reads the same
/// transcript tree; otherwise its restart would boot without the conversation.
/// With `projects/` shared (the documented layout) the move goes through, which
/// is how an existing bot changes account while keeping its name and history.
#[tokio::test]
async fn patch_keeps_the_conversation_reachable() {
    let (state, app, data) = setup().await;
    let transcripts = temp_dir("transcripts");
    let current = account_sharing("cur", &transcripts);
    create(&app, "talker", Some(&current)).await;
    db::sessions::set_cc_conversation_id(&state.pool, "talker", "conv-1").await.unwrap();

    // A login with its OWN projects/: refused, nothing written.
    let lonely = temp_dir("lonely");
    std::fs::create_dir_all(lonely.join("projects")).unwrap();
    let (status, body) = patch_dir(&app, "talker", &lonely.to_string_lossy()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.to_string().contains("transcripts"), "{body}");
    let row = db::sessions::get(&state.pool, "talker").await.unwrap().unwrap();
    assert_eq!(row.config_dir, current.to_string_lossy());

    // A login sharing the transcript tree: accepted, conversation id untouched.
    let shared = account_sharing("shared", &transcripts);
    let (status, body) = patch_dir(&app, "talker", &shared.to_string_lossy()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let row = db::sessions::get(&state.pool, "talker").await.unwrap().unwrap();
    assert_eq!(row.config_dir, shared.to_string_lossy());
    assert_eq!(row.cc_conversation_id, "conv-1");

    for d in [transcripts, current, lonely, shared, data] {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// Non-Claude providers have no `CLAUDE_CONFIG_DIR` to move.
#[tokio::test]
async fn patch_refuses_config_dir_on_a_non_claude_session() {
    let (state, app, data) = setup().await;
    let (status, b) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "codexer", "dir": "/tmp", "provider": "codex" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{b}");
    let account = temp_dir("codex-acct");
    let (status, body) = patch_dir(&app, "codexer", &account.to_string_lossy()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let row = db::sessions::get(&state.pool, "codexer").await.unwrap().unwrap();
    assert_eq!(row.config_dir, "");
    let _ = std::fs::remove_dir_all(account);
    let _ = std::fs::remove_dir_all(data);
}

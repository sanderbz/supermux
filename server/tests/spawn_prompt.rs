//! Prompt-on-create over HTTP (`POST /api/sessions {prompt: "..."}`).
//!
//! One call replaces the old "create a disabled stub schedule, then run it now"
//! dance: the handler creates the row and, when a non-blank prompt is present,
//! boots the session with that prompt.
//!
//! Three contracts are pinned here:
//!   * no prompt -> byte-identical to the old create (201, no start attempted),
//!   * a start failure propagates and LEAVES the session row behind, so
//!     the caller can inspect and retry instead of losing the record,
//!   * the `unless_live_prefix` guard fires before any start, so a 409 means
//!     nothing was created and the prompt was never delivered.
//!
//! These need `lifecycle::start` to fail deterministically without spawning
//! anything real (this box has both `tmux` and `claude` on PATH, so "it will
//! fail in CI" is not a safe assumption). They get that from provider `shell`
//! (skips the `~/.claude/settings.json` hook install, which would touch the
//! developer's real home) plus a working dir that does not exist: the native
//! runtime's holder spawn sets that dir as the child's cwd, so the spawn fails
//! with ENOENT before any process runs.
//!
//! That missing dir is also what makes "was a start attempted?" observable at
//! all. `create` mints the `session_runtime` row itself (`ensure_runtime`,
//! right after the INSERT), so the presence of that row proves nothing, and a
//! start that dies inside `spawn` never reaches the `last_status = "starting"`
//! write. The status code is the signal instead: with a missing dir, 201 means
//! no start ran and any error status means one did. `start` now checks the dir
//! up front and reports a missing one as a 400, so these assert on "the boot
//! failed" rather than pinning a specific error class.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "spawn-prompt-token";

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-spawn-prompt-{}", uuid::Uuid::new_v4()));
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
        company_isolation: Vec::new(),
        human_auth: Default::default(),
        swarm_reaper: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    (state, app, dir)
}

/// Insert a session row directly, the way `db::sessions::create` does: rows
/// only, no `session_runtime` (that arrives at start time via `ensure_runtime`).
async fn insert_session(state: &AppState, name: &str) {
    let new = db::sessions::NewSession {
        name: name.to_string(),
        display_name: name.to_string(),
        dir: "/tmp".into(),
        desc: String::new(),
        provider: "claude".into(),
        creator: "scheduler".into(),
        flags: String::new(),
        tags: "[]".into(),
        branch: String::new(),
        mcp: String::new(),
        worktree: false,
        worktree_repo: String::new(),
        host_id: None,
        company_id: None,
        runtime: "tmux".into(),
        model: String::new(),
        archive_on_stop: false,
        config_dir: String::new(),
    };
    db::sessions::create(&state.pool, &new).await.unwrap();
}

/// Give `name` a runtime row and a status, the way a started session has one.
/// A bare `set_last_status` without the runtime row is a silent no-op.
async fn set_status(state: &AppState, name: &str, status: &str) {
    db::sessions::ensure_runtime(&state.pool, name, "hooktok").await.unwrap();
    db::sessions::set_last_status(&state.pool, name, status).await.unwrap();
}

async fn post_sessions(app: &axum::Router, body: Value) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/sessions")
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
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

/// A path that cannot exist, so the runtime spawn fails at cwd resolution.
fn missing_dir() -> String {
    format!("/nonexistent-supermux-{}", uuid::Uuid::new_v4())
}

#[tokio::test]
async fn create_without_prompt_unchanged() {
    let (_state, app, _dir) = setup().await;
    let (status, body) = post_sessions(&app, json!({ "name": "plain-create", "dir": "/tmp" })).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["data"]["name"], "plain-create", "{body}");
}

/// The control for the two start tests below: same unspawnable dir, no prompt.
/// A 201 here is what makes their failure mean "a start ran", not "the dir is
/// bad".
#[tokio::test]
async fn absent_prompt_does_not_start() {
    let (_state, app, _dir) = setup().await;
    let (status, body) = post_sessions(
        &app,
        json!({ "name": "no-prompt", "dir": missing_dir(), "provider": "shell" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

/// A prompt that is only whitespace is treated as absent: no start, plain 201.
#[tokio::test]
async fn blank_prompt_does_not_start() {
    let (_state, app, _dir) = setup().await;
    let (status, body) = post_sessions(
        &app,
        json!({
            "name": "blank-prompt",
            "dir": missing_dir(),
            "provider": "shell",
            "prompt": "   \n"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

#[tokio::test]
async fn prompt_starts_the_session() {
    let (_state, app, _dir) = setup().await;
    let (status, _body) = post_sessions(
        &app,
        json!({
            "name": "Operator--t--reply-1",
            "dir": missing_dir(),
            "provider": "shell",
            "prompt": "read the contract and act"
        }),
    )
    .await;
    // The start is real, so it fails on the missing cwd and the error
    // propagates. Paired with `absent_prompt_does_not_start` (same dir, 201)
    // this is proof that the prompt is what triggered a boot.
    //
    // The missing directory is now named explicitly by `start` as a 400 rather
    // than surfacing as an opaque 5xx spawn failure, so this asserts on the
    // failure itself, not on its status class.
    assert!(
        status.is_client_error() || status.is_server_error(),
        "a start against a missing dir must fail, got {status}"
    );
}

#[tokio::test]
async fn prompt_start_failure_keeps_session_row() {
    let (state, app, _dir) = setup().await;
    let (status, _body) = post_sessions(
        &app,
        json!({
            "name": "Operator--f--reply-1",
            "dir": missing_dir(),
            "provider": "shell",
            "prompt": "read the contract and act"
        }),
    )
    .await;
    assert!(
        !status.is_success(),
        "the failed start must surface as an error, never a silent 201: {status}"
    );
    assert!(
        db::sessions::exists(&state.pool, "Operator--f--reply-1")
            .await
            .unwrap(),
        "session row survives a failed start"
    );
}

/// A failed boot must clean up after itself EXACTLY as far as the session asked
/// for: an `archive_on_stop` spawn (the dispatcher's disposable sessions) ends
/// archived, an unflagged one stays visible for inspection.
///
/// This is what bounds the dispatcher's retry loop. Without it every failed
/// boot leaves a permanently visible dead row plus two per-session tokio loops
/// (the status detector and the steering deliver loop both hang off
/// `exists_active`, which filters `archived = 0`), and a 5-minute cron that
/// keeps failing manufactures a new one of those every cycle.
#[tokio::test]
async fn failed_boot_archives_a_disposable_spawn() {
    let (state, app, _dir) = setup().await;
    let (status, _body) = post_sessions(
        &app,
        json!({
            "name": "Operator--a--reply-1",
            "dir": missing_dir(),
            "provider": "shell",
            "unless_live_prefix": "Operator--a--",
            "archive_on_stop": true,
            "prompt": "read the contract and act"
        }),
    )
    .await;
    assert!(!status.is_success(), "the boot must have failed: {status}");
    assert_eq!(
        db::sessions::is_archived(&state.pool, "Operator--a--reply-1")
            .await
            .unwrap(),
        Some(true),
        "a flagged spawn whose boot failed must archive itself"
    );
    // Archiving is also what frees the prefix here: `live_with_prefix` only
    // considers `archived = 0` rows.
    assert_eq!(
        db::sessions::live_with_prefix(&state.pool, "Operator--a--", 7200)
            .await
            .unwrap(),
        None,
        "the archived dead row must not block the identity's retry"
    );

    // The unflagged control: same failure, row stays visible.
    let (status, _body) = post_sessions(
        &app,
        json!({
            "name": "Operator--b--reply-1",
            "dir": missing_dir(),
            "provider": "shell",
            "prompt": "read the contract and act"
        }),
    )
    .await;
    assert!(!status.is_success(), "the boot must have failed: {status}");
    assert_eq!(
        db::sessions::is_archived(&state.pool, "Operator--b--reply-1")
            .await
            .unwrap(),
        Some(false),
        "a session that never asked to be archived stays visible after a failed boot"
    );
}

/// The row surviving a failed boot must not lock the identity out of a retry.
///
/// Left alone, the dead row's runtime status is `''` (the failure beat the
/// `starting` write), which `live_with_prefix` reads as live for the whole
/// quiet window. `lifecycle::start` stamps `stopped` on its error paths so the
/// prefix frees up immediately and the dispatcher can try again.
#[tokio::test]
async fn failed_boot_frees_its_prefix_for_a_retry() {
    let (state, app, _dir) = setup().await;
    let (status, _body) = post_sessions(
        &app,
        json!({
            "name": "Operator--r--reply-1",
            "dir": missing_dir(),
            "provider": "shell",
            "unless_live_prefix": "Operator--r--",
            "prompt": "read the contract and act"
        }),
    )
    .await;
    assert!(!status.is_success(), "the boot must have failed: {status}");

    // 7200s = the default quiet window, so this also covers the freshness arm
    // that a just-created row would otherwise sit inside.
    assert_eq!(
        db::sessions::live_with_prefix(&state.pool, "Operator--r--", 7200)
            .await
            .unwrap(),
        None,
        "a session whose boot failed must not read live"
    );

    // And the guard agrees: the retry gets past it (it then fails its own boot
    // on the same missing dir, which is its own error, not the guard's 409).
    let (retry, body) = post_sessions(
        &app,
        json!({
            "name": "Operator--r--reply-2",
            "dir": missing_dir(),
            "provider": "shell",
            "unless_live_prefix": "Operator--r--",
            "prompt": "read the contract and act"
        }),
    )
    .await;
    assert_ne!(retry, StatusCode::CONFLICT, "the guard blocked the retry: {body}");
    assert!(
        db::sessions::exists(&state.pool, "Operator--r--reply-2")
            .await
            .unwrap(),
        "the retry created its row"
    );
}

#[tokio::test]
async fn guard_409_over_http() {
    let (state, app, _dir) = setup().await;
    insert_session(&state, "Operator--h--reply-1").await;
    set_status(&state, "Operator--h--reply-1", "active").await;
    let (status, body) = post_sessions(
        &app,
        json!({
            "name": "Operator--h--reply-2",
            "dir": "/tmp",
            "unless_live_prefix": "Operator--h--",
            "prompt": "should never be delivered"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(
        !db::sessions::exists(&state.pool, "Operator--h--reply-2")
            .await
            .unwrap(),
        "the guard rejects before the row is created, so the prompt is never delivered"
    );
}

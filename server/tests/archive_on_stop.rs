//! The disposable-session marker (`sessions.archive_on_stop`, migration 0025):
//! the `archive_pending` gate, the stop-time auto-archive hook, and the
//! workflows plumbing that stamps a target session.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::sessions::lifecycle;
use supermux_server::state::AppState;
use supermux_server::{db, http};

const TOKEN: &str = "archive-removes-token";

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-archive-{}", uuid::Uuid::new_v4()));
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

async fn insert_session(state: &supermux_server::state::AppState, name: &str, archive_on_stop: bool) {
    let new = db::sessions::NewSession {
        name: name.to_string(),
        display_name: name.to_string(),
        dir: "/tmp".into(),
        desc: String::new(),
        provider: "claude".into(),
        creator: "spawn".into(),
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
        archive_on_stop,
        config_dir: String::new(),
    };
    db::sessions::create(&state.pool, &new).await.unwrap();
}

#[tokio::test]
async fn archive_pending_true_only_when_flagged_and_live() {
    let (state, _router, _dir) = setup().await;
    insert_session(&state, "boot-a", true).await;
    insert_session(&state, "boot-b", false).await;

    assert!(db::sessions::archive_pending(&state.pool, "boot-a").await.unwrap());
    assert!(!db::sessions::archive_pending(&state.pool, "boot-b").await.unwrap());
    // Missing row -> false (not an error).
    assert!(!db::sessions::archive_pending(&state.pool, "nope").await.unwrap());

    // Once archived, no longer pending.
    db::sessions::set_archived(&state.pool, "boot-a", true).await.unwrap();
    assert!(!db::sessions::archive_pending(&state.pool, "boot-a").await.unwrap());
}

#[tokio::test]
async fn maybe_archive_on_stop_archives_only_flagged_and_is_idempotent() {
    let (state, _router, _dir) = setup().await;
    insert_session(&state, "flagged", true).await;
    insert_session(&state, "plain", false).await;

    // Flagged -> archived.
    lifecycle::maybe_archive_on_stop(&state, "flagged").await;
    assert_eq!(db::sessions::is_archived(&state.pool, "flagged").await.unwrap(), Some(true));

    // Unflagged -> untouched.
    lifecycle::maybe_archive_on_stop(&state, "plain").await;
    assert_eq!(db::sessions::is_archived(&state.pool, "plain").await.unwrap(), Some(false));

    // Idempotent: a second call on the already-archived row logs no new audit row.
    let before = audit_count(&state.pool, "flagged").await;
    lifecycle::maybe_archive_on_stop(&state, "flagged").await;
    let after = audit_count(&state.pool, "flagged").await;
    assert_eq!(before, after, "second call must be a no-op (no duplicate audit)");
}

/// Count `session.archive` audit rows for `target`.
async fn audit_count(pool: &sqlx::SqlitePool, target: &str) -> i64 {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM audit_log WHERE action = 'session.archive' AND target = ?",
    )
    .bind(target)
    .fetch_one(pool)
    .await
    .unwrap();
    n
}

// ── the workflows plumbing ───────────────────────────────────────────────────

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use supermux_server::workflows::{self, CreateWorkflowInput, StepBody};
use tower::ServiceExt;

fn one_step() -> Vec<StepBody> {
    vec![StepBody { prompt: "do the thing".into(), ..Default::default() }]
}

async fn flag_of(pool: &sqlx::SqlitePool, name: &str) -> i64 {
    let (v,): (i64,) =
        sqlx::query_as("SELECT archive_on_stop FROM sessions WHERE name = ?")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap();
    v
}

#[tokio::test]
async fn workflow_create_stamps_the_target_session_opt_in_default_off() {
    let (state, _router, _dir) = setup().await;
    insert_session(&state, "bot-a", false).await;
    insert_session(&state, "bot-b", false).await;

    // Flag omitted -> the session's marker is untouched (opt-in, default off).
    workflows::create(&state, CreateWorkflowInput {
        title: "plain".into(),
        session: "bot-a".into(),
        steps: one_step(),
        ..Default::default()
    })
    .await
    .unwrap();
    assert_eq!(flag_of(&state.pool, "bot-a").await, 0, "omitted flag leaves the marker alone");

    // Explicit ON -> the SESSION row is stamped (there is no workflows copy).
    workflows::create(&state, CreateWorkflowInput {
        title: "clean-me-up".into(),
        session: "bot-b".into(),
        steps: one_step(),
        archive_on_stop: Some(true),
        ..Default::default()
    })
    .await
    .unwrap();
    assert_eq!(flag_of(&state.pool, "bot-b").await, 1, "explicit on stamps the session");
    assert!(db::sessions::archive_pending(&state.pool, "bot-b").await.unwrap());
}

#[tokio::test]
async fn workflow_patch_stamps_and_clears_the_target_session() {
    let (state, app, _dir) = setup().await;
    insert_session(&state, "bot-c", false).await;
    let wf = workflows::create(&state, CreateWorkflowInput {
        title: "toggle-me".into(),
        session: "bot-c".into(),
        steps: one_step(),
        ..Default::default()
    })
    .await
    .unwrap();

    let patch = |body: serde_json::Value| {
        Request::builder()
            .method(Method::PATCH)
            .uri(format!("/api/workflows/{}", wf.workflow.id))
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };

    // PATCH {archive_on_stop: true} -> stamped.
    let resp = app.clone().oneshot(patch(serde_json::json!({ "archive_on_stop": true }))).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(flag_of(&state.pool, "bot-c").await, 1);

    // PATCH without the field -> untouched.
    let resp = app.clone().oneshot(patch(serde_json::json!({ "title": "renamed" }))).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(flag_of(&state.pool, "bot-c").await, 1, "omitted field leaves the marker alone");

    // PATCH {archive_on_stop: false} -> cleared (the one write path that
    // un-marks a disposable session without unarchiving anything).
    let resp = app.clone().oneshot(patch(serde_json::json!({ "archive_on_stop": false }))).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(flag_of(&state.pool, "bot-c").await, 0);
    let _ = resp.into_body().collect().await;
}

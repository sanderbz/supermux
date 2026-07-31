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
        creator: "scheduler".into(),
        flags: String::new(),
        tags: "[]".into(),
        branch: String::new(),
        mcp: String::new(),
        worktree: false,
        worktree_repo: String::new(),
        host_id: None,
        runtime: "tmux".into(),
        archive_on_stop,
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

use supermux_server::scheduler::{self, CreateScheduleInput};

#[tokio::test]
async fn create_defaults_boot_archive_on_stop_off() {
    let (state, _router, _dir) = setup().await;

    // Boot schedule, flag omitted -> defaults OFF (opt-in, backward compatible).
    let s = scheduler::create(&state, CreateScheduleInput {
        title: "reply-trigger".into(),
        kind: Some("boot".into()),
        prompt: "do the thing".into(),
        boot_dir: Some("/tmp".into()),
        schedule_expr: Some("every 1h".into()),
        ..Default::default()
    }).await.unwrap();
    assert_eq!(s.archive_on_stop, 0, "new boot schedule defaults archive_on_stop off");

    // Boot schedule, explicit ON -> honored.
    let s2 = scheduler::create(&state, CreateScheduleInput {
        title: "clean-me-up".into(),
        kind: Some("boot".into()),
        prompt: "do the thing".into(),
        boot_dir: Some("/tmp".into()),
        schedule_expr: Some("every 1h".into()),
        archive_on_stop: Some(true),
        ..Default::default()
    }).await.unwrap();
    assert_eq!(s2.archive_on_stop, 1, "explicit on is honored");

    // Non-boot -> clamped off regardless of input.
    let s3 = scheduler::create(&state, CreateScheduleInput {
        title: "tmux-job".into(),
        kind: Some("tmux".into()),
        command: "/status".into(),
        session: Some("somesess".into()),
        schedule_expr: Some("every 1h".into()),
        archive_on_stop: Some(true),
        ..Default::default()
    }).await.unwrap();
    assert_eq!(s3.archive_on_stop, 0, "clamped off for non-boot kinds");
}

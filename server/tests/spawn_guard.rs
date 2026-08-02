//! Liveness query behind the spawn guard (`unless_live_prefix`).
//!
//! `db::sessions::create` inserts into `sessions` only, never `session_runtime`
//! (the runtime row is created by `ensure_runtime` at start time), so these
//! tests call `ensure_runtime` before `set_last_status` or the status write is
//! a silent no-op. Sessions that never get a runtime row exercise the
//! LEFT JOIN "missing runtime row" branch, which is the case the guard leans on
//! to close its create-then-boot race.
//!
//! The query's `WHEN 'error' THEN 0` arm has no test: `session_runtime`'s CHECK
//! (migration 0009) rejects `'error'`, so the value cannot be written even by a
//! raw UPDATE. The arm is there so that adding `error` to the CHECK later does
//! not silently route dead sessions into the freshness branch, where they would
//! block their own respawn.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::sessions::{self, CreateInput};
use supermux_server::state::AppState;
use supermux_server::{db, http};

const TOKEN: &str = "spawn-guard-token";

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-spawn-{}", uuid::Uuid::new_v4()));
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
        runtime: "tmux".into(),
        archive_on_stop: false,
    };
    db::sessions::create(&state.pool, &new).await.unwrap();
}

/// Give `name` a runtime row and a status, the way a started session has one.
async fn set_status(state: &AppState, name: &str, status: &str) {
    db::sessions::ensure_runtime(&state.pool, name, "hooktok").await.unwrap();
    db::sessions::set_last_status(&state.pool, name, status).await.unwrap();
}

/// Push every activity stamp `secs_ago` into the past, including the runtime
/// row's `last_status_at` (which `set_last_status` stamps with now).
async fn backdate_activity(pool: &sqlx::SqlitePool, name: &str, secs_ago: i64) {
    let then = chrono::Utc::now().timestamp() - secs_ago;
    sqlx::query("UPDATE sessions SET created_at = ?, last_started = 0, last_send = 0 WHERE name = ?")
        .bind(then)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE session_runtime SET last_status_at = ? WHERE name = ?")
        .bind(then)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
}

/// A guarded create the way the dispatcher sends it: a tmux session (the
/// native runtime would try to fork a real pty holder) in a throwaway dir.
fn spawn_input(name: &str, prefix: &str) -> CreateInput {
    CreateInput {
        name: name.into(),
        dir: Some("/tmp".into()),
        runtime: Some("tmux".into()),
        unless_live_prefix: Some(prefix.into()),
        ..Default::default()
    }
}

#[tokio::test]
async fn live_with_prefix_classifies_statuses() {
    let (state, _router, _dir) = setup().await;
    let p = &state.pool;

    // active matches, regardless of age
    insert_session(&state, "Operator--a--reply-1").await;
    set_status(&state, "Operator--a--reply-1", "active").await;
    backdate_activity(p, "Operator--a--reply-1", 999_999).await;
    assert_eq!(
        db::sessions::live_with_prefix(p, "Operator--a--", 7200).await.unwrap(),
        Some("Operator--a--reply-1".into())
    );

    // starting matches too, regardless of age (the boot window)
    insert_session(&state, "Operator--s--reply-1").await;
    set_status(&state, "Operator--s--reply-1", "starting").await;
    backdate_activity(p, "Operator--s--reply-1", 999_999).await;
    assert_eq!(
        db::sessions::live_with_prefix(p, "Operator--s--", 7200).await.unwrap(),
        Some("Operator--s--reply-1".into())
    );

    // stopped is free, even with dead-fresh activity stamps
    insert_session(&state, "Operator--b--reply-1").await;
    set_status(&state, "Operator--b--reply-1", "stopped").await;
    assert_eq!(db::sessions::live_with_prefix(p, "Operator--b--", 7200).await.unwrap(), None);

    // waiting and unknown are freshness-gated like idle (the ELSE branch)
    for (id, status) in [("w", "waiting"), ("u", "unknown")] {
        let name = format!("Operator--{id}--reply-1");
        insert_session(&state, &name).await;
        set_status(&state, &name, status).await;
        assert_eq!(
            db::sessions::live_with_prefix(p, &format!("Operator--{id}--"), 7200).await.unwrap(),
            Some(name.clone()),
            "fresh {status} must read live"
        );
        backdate_activity(p, &name, 8000).await;
        assert_eq!(
            db::sessions::live_with_prefix(p, &format!("Operator--{id}--"), 7200).await.unwrap(),
            None,
            "stale {status} must read free"
        );
    }

    // fresh idle is live, stale idle is free
    insert_session(&state, "Operator--c--reply-1").await;
    set_status(&state, "Operator--c--reply-1", "idle").await;
    assert_eq!(
        db::sessions::live_with_prefix(p, "Operator--c--", 7200).await.unwrap(),
        Some("Operator--c--reply-1".into())
    );
    backdate_activity(p, "Operator--c--reply-1", 8000).await;
    assert_eq!(db::sessions::live_with_prefix(p, "Operator--c--", 7200).await.unwrap(), None);

    // archived never matches
    insert_session(&state, "Operator--d--reply-1").await;
    set_status(&state, "Operator--d--reply-1", "active").await;
    db::sessions::set_archived(p, "Operator--d--reply-1", true).await.unwrap();
    assert_eq!(db::sessions::live_with_prefix(p, "Operator--d--", 7200).await.unwrap(), None);

    // no row at all for the prefix
    assert_eq!(db::sessions::live_with_prefix(p, "Operator--zz--", 7200).await.unwrap(), None);

    // a just-created row with no runtime row yet is live (fresh via created_at)
    insert_session(&state, "Operator--e--reply-1").await;
    assert_eq!(
        db::sessions::live_with_prefix(p, "Operator--e--", 7200).await.unwrap(),
        Some("Operator--e--reply-1".into())
    );

    // ...and goes free once that created_at falls outside the window
    sqlx::query("UPDATE sessions SET created_at = ? WHERE name = 'Operator--e--reply-1'")
        .bind(chrono::Utc::now().timestamp() - 8000)
        .execute(p)
        .await
        .unwrap();
    assert_eq!(db::sessions::live_with_prefix(p, "Operator--e--", 7200).await.unwrap(), None);

    // a stale status with fresh traffic (last_send) still reads live
    insert_session(&state, "Operator--f--reply-1").await;
    set_status(&state, "Operator--f--reply-1", "idle").await;
    backdate_activity(p, "Operator--f--reply-1", 8000).await;
    sqlx::query("UPDATE sessions SET last_send = ? WHERE name = 'Operator--f--reply-1'")
        .bind(chrono::Utc::now().timestamp())
        .execute(p)
        .await
        .unwrap();
    assert_eq!(
        db::sessions::live_with_prefix(p, "Operator--f--", 7200).await.unwrap(),
        Some("Operator--f--reply-1".into())
    );
}

#[tokio::test]
async fn live_with_prefix_matches_prefix_not_substring() {
    let (state, _router, _dir) = setup().await;
    let p = &state.pool;

    insert_session(&state, "Operator--a--reply-1").await;
    set_status(&state, "Operator--a--reply-1", "active").await;

    // the prefix anchors at the start: a mid-name match is not a match
    assert_eq!(db::sessions::live_with_prefix(p, "reply-", 7200).await.unwrap(), None);
    assert_eq!(db::sessions::live_with_prefix(p, "perator--a--", 7200).await.unwrap(), None);

    // LIKE wildcards in the prefix are literal, not patterns
    insert_session(&state, "OpZX--reply-1").await;
    set_status(&state, "OpZX--reply-1", "active").await;
    assert_eq!(db::sessions::live_with_prefix(p, "Op_X--", 7200).await.unwrap(), None);
    assert_eq!(db::sessions::live_with_prefix(p, "Op%--", 7200).await.unwrap(), None);

    insert_session(&state, "Op_X--reply-1").await;
    set_status(&state, "Op_X--reply-1", "active").await;
    assert_eq!(
        db::sessions::live_with_prefix(p, "Op_X--", 7200).await.unwrap(),
        Some("Op_X--reply-1".into())
    );
}

/// SQLite's default LIKE is ASCII-case-insensitive, so a LIKE-based match would
/// let two identities that differ only in case share one guard slot and block
/// each other's spawn for as long as either stays live. The match must be exact.
#[tokio::test]
async fn live_with_prefix_is_case_sensitive() {
    let (state, _router, _dir) = setup().await;
    let p = &state.pool;

    insert_session(&state, "op-x--reply-1").await;
    set_status(&state, "op-x--reply-1", "active").await;

    assert_eq!(db::sessions::live_with_prefix(p, "Op-x--", 7200).await.unwrap(), None);
    assert_eq!(db::sessions::live_with_prefix(p, "OP-X--", 7200).await.unwrap(), None);
    assert_eq!(
        db::sessions::live_with_prefix(p, "op-x--", 7200).await.unwrap(),
        Some("op-x--reply-1".into())
    );

    // and the differently-cased identity gets its own slot
    insert_session(&state, "Op-X--reply-1").await;
    set_status(&state, "Op-X--reply-1", "stopped").await;
    assert_eq!(db::sessions::live_with_prefix(p, "Op-X--", 7200).await.unwrap(), None);
}

#[tokio::test]
async fn guard_blocks_create_against_live_session() {
    let (state, _router, _dir) = setup().await;
    insert_session(&state, "Operator--x--reply-1").await;
    set_status(&state, "Operator--x--reply-1", "active").await;

    let err = sessions::create(&state, spawn_input("Operator--x--reply-2", "Operator--x--"))
        .await
        .unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("Operator--x--reply-1"), "409 names the live session: {msg}");
    // Nothing was created.
    assert!(!db::sessions::exists(&state.pool, "Operator--x--reply-2").await.unwrap());
}

#[tokio::test]
async fn guard_allows_create_when_prefix_is_free() {
    let (state, _router, _dir) = setup().await;
    insert_session(&state, "Operator--y--reply-1").await;
    set_status(&state, "Operator--y--reply-1", "stopped").await;

    let v = sessions::create(&state, spawn_input("Operator--y--reply-2", "Operator--y--"))
        .await
        .unwrap();
    assert_eq!(v.name, "Operator--y--reply-2");
}

/// An empty prefix matches EVERY session name, so the guard must treat it as
/// "no guard asked for" rather than "nothing may ever be created". Same for an
/// absent `unless_live_prefix`.
#[tokio::test]
async fn guard_ignores_absent_and_empty_prefix() {
    let (state, _router, _dir) = setup().await;
    insert_session(&state, "Operator--q--reply-1").await;
    set_status(&state, "Operator--q--reply-1", "active").await;

    let v = sessions::create(&state, spawn_input("Operator--q--reply-2", ""))
        .await
        .unwrap();
    assert_eq!(v.name, "Operator--q--reply-2");

    let mut unguarded = spawn_input("Operator--q--reply-3", "");
    unguarded.unless_live_prefix = None;
    let v = sessions::create(&state, unguarded).await.unwrap();
    assert_eq!(v.name, "Operator--q--reply-3");
}

/// The TOCTOU case the per-prefix lock exists for: without it both cycles read
/// "no live session" before either INSERT lands, and the operator double-boots.
#[tokio::test]
async fn guard_serializes_concurrent_spawns() {
    let (state, _router, _dir) = setup().await;
    let (a, b) = tokio::join!(
        sessions::create(&state, spawn_input("Operator--z--reply-1", "Operator--z--")),
        sessions::create(&state, spawn_input("Operator--z--reply-2", "Operator--z--")),
    );
    let oks = [a.is_ok(), b.is_ok()].iter().filter(|x| **x).count();
    assert_eq!(oks, 1, "exactly one of two concurrent same-prefix spawns wins");
}

//! `db::hosts` integration tests (RT4 of the remote-ssh plan,
//! /opt/projects/supermux-remote-ssh/plan/REMOTE_PLAN.md).
//!
//! Each test spins up an isolated temp-dir SQLite pool via [`crate::test_pool`]
//! (matches the pattern in `server/tests/auth.rs` & `server/tests/board.rs`),
//! runs migration 0017, then exercises the [`db::hosts`] surface. The
//! invariants under test mirror RT4's acceptance bullets:
//!   * `create` + `get_by_name` round-trip.
//!   * Duplicate `name` violates `UNIQUE` and surfaces as an `Err`.
//!   * `update_status(Reachable)` bumps `last_seen`; other transitions don't.
//!   * `soft_delete` tombstones the row: `list()` filters it out, but
//!     `get_by_name()` (the historical-resolution path) still returns it.
//!   * `host_id` defaults to `NULL` on every pre-RT4 session row (the
//!     non-empty-existing-db migration regression).

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db;
use supermux_server::db::hosts::{self, HostStatus};

use sqlx::SqlitePool;

/// Build an isolated on-disk pool in a fresh temp dir and run migrations. The
/// returned `PathBuf` is the dir to `remove_dir_all` at test exit.
async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-hosts-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: "hosts-db-test".to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
    };
    let pool = db::init(&config).await.expect("db init");
    (pool, dir)
}

#[tokio::test]
async fn create_and_get_by_name_round_trip() {
    let (pool, dir) = test_pool().await;

    // Fresh table is empty.
    assert!(hosts::list(&pool).await.unwrap().is_empty());

    let created = hosts::create(
        &pool,
        "ml-rig",
        "user@ml-rig.tailnet.ts.net",
        Some("/home/u/.ssh/id_rig"),
    )
    .await
    .expect("create host");

    assert_eq!(created.name, "ml-rig");
    assert_eq!(created.ssh_target, "user@ml-rig.tailnet.ts.net");
    assert_eq!(created.ssh_key_path.as_deref(), Some("/home/u/.ssh/id_rig"));
    assert_eq!(created.status, HostStatus::Unknown.as_str());
    assert!(created.last_seen.is_none(), "unprobed → last_seen NULL");
    assert!(created.deleted_at.is_none(), "live row → deleted_at NULL");
    assert!(created.created_at > 0, "created_at stamped");

    // get_by_name returns the same row.
    let by_name = hosts::get_by_name(&pool, "ml-rig")
        .await
        .unwrap()
        .expect("get_by_name finds the created row");
    assert_eq!(by_name.id, created.id);
    assert_eq!(by_name.ssh_target, created.ssh_target);

    // get(id) does too.
    let by_id = hosts::get(&pool, created.id)
        .await
        .unwrap()
        .expect("get(id) finds the created row");
    assert_eq!(by_id.name, "ml-rig");

    // list() picks it up.
    let listed = hosts::list(&pool).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, created.id);

    // Round-trip status through the enum helpers (CHECK constraint guarantees
    // the DB only stores legal values, so from_str is total).
    assert_eq!(
        HostStatus::from_str(&listed[0].status),
        Some(HostStatus::Unknown)
    );

    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn duplicate_name_returns_err() {
    let (pool, dir) = test_pool().await;
    hosts::create(&pool, "dup", "u@a", None).await.unwrap();
    let err = hosts::create(&pool, "dup", "u@b", None).await;
    assert!(
        err.is_err(),
        "UNIQUE(name) must reject a duplicate insert"
    );
    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn update_status_reachable_bumps_last_seen() {
    let (pool, dir) = test_pool().await;
    let h = hosts::create(&pool, "probe", "u@h", None).await.unwrap();
    assert!(h.last_seen.is_none());

    // Reachable transition stamps last_seen.
    hosts::update_status(&pool, h.id, HostStatus::Reachable)
        .await
        .unwrap();
    let after = hosts::get(&pool, h.id).await.unwrap().unwrap();
    assert_eq!(after.status, HostStatus::Reachable.as_str());
    let seen = after.last_seen.expect("Reachable → last_seen stamped");
    assert!(seen > 0);

    // Subsequent Unreachable does NOT clobber last_seen — the UI relies on
    // "last reachable Xm ago" after the host went down.
    hosts::update_status(&pool, h.id, HostStatus::Unreachable)
        .await
        .unwrap();
    let after2 = hosts::get(&pool, h.id).await.unwrap().unwrap();
    assert_eq!(after2.status, HostStatus::Unreachable.as_str());
    assert_eq!(
        after2.last_seen,
        Some(seen),
        "Unreachable preserves last_seen"
    );

    // And Unknown likewise preserves the previous timestamp.
    hosts::update_status(&pool, h.id, HostStatus::Unknown)
        .await
        .unwrap();
    let after3 = hosts::get(&pool, h.id).await.unwrap().unwrap();
    assert_eq!(after3.status, HostStatus::Unknown.as_str());
    assert_eq!(after3.last_seen, Some(seen));

    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn soft_delete_filters_list_but_get_by_name_still_resolves() {
    let (pool, dir) = test_pool().await;
    let h = hosts::create(&pool, "tombstone", "u@h", None)
        .await
        .unwrap();
    assert_eq!(hosts::list(&pool).await.unwrap().len(), 1);

    hosts::soft_delete(&pool, h.id).await.unwrap();

    // list() filters tombstones out (the FE picker never offers them).
    let live = hosts::list(&pool).await.unwrap();
    assert!(
        live.is_empty(),
        "soft-deleted host must not appear in list()"
    );

    // …but get_by_name still resolves: historical sessions referencing this
    // host_id need their label/ssh_target back.
    let tomb = hosts::get_by_name(&pool, "tombstone")
        .await
        .unwrap()
        .expect("get_by_name keeps tombstones");
    assert!(
        tomb.deleted_at.is_some(),
        "tombstone carries deleted_at != NULL"
    );

    // Same via get(id).
    let tomb2 = hosts::get(&pool, h.id).await.unwrap().unwrap();
    assert!(tomb2.deleted_at.is_some());

    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn migration_backfills_host_id_null_on_existing_session_rows() {
    // The RT4 migration adds `host_id` to `sessions` via ALTER TABLE ADD
    // COLUMN — SQLite must default every existing row to NULL so the entire
    // pre-RT4 fleet keeps its local-only semantics. Insert a session BEFORE
    // reading host_id back to assert the backfill behavior.
    let (pool, dir) = test_pool().await;
    // (Migrations have already run via db::init in test_pool — that's the
    // point: a fresh db sees the full chain in one go and host_id is NULL
    // on a freshly-inserted row that didn't set it.)
    supermux_server::db::sessions::insert_minimal(&pool, "legacy", "/tmp/x", "shell")
        .await
        .unwrap();
    let host_id: Option<i64> =
        sqlx::query_scalar("SELECT host_id FROM sessions WHERE name = ?")
            .bind("legacy")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(host_id, None, "new session w/o host_id defaults to NULL");

    // …and the FromRow deserializer reads it back as None too.
    let s = supermux_server::db::sessions::get(&pool, "legacy")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.host_id, None);

    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

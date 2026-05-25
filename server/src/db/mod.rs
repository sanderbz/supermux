//! Persistence layer (TECH_PLAN §3.2.4, §3.3).
//!
//! [`init`] opens the SQLite pool with WAL + foreign keys and runs the embedded
//! migrations. Per-table query modules live alongside this file; M1 fleshes out
//! [`sessions`] and [`board`], leaving the rest as typed stubs for later
//! milestones to fill in.

use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

use crate::config::Config;

pub mod audit;
pub mod board;
pub mod prefs;
pub mod push;
pub mod runtime_state;
pub mod schedules;
pub mod sessions;
pub mod skills;
pub mod steering;
pub mod tracked_files;

/// Open the pool and run migrations.
///
/// Pragmas are set per-connection via [`SqliteConnectOptions`] (not one-off
/// `PRAGMA` queries, which would only affect a single pooled connection):
/// WAL journaling, `synchronous=NORMAL`, and `foreign_keys=ON`.
pub async fn init(config: &Config) -> Result<SqlitePool> {
    let db_path = config.data_dir.join("data.db");
    let connect_opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(connect_opts)
        .await
        .with_context(|| format!("opening sqlite db at {}", db_path.display()))?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("running migrations")?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    /// Build an isolated on-disk pool in a fresh temp dir and run migrations.
    async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-db-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
        };
        let pool = init(&config).await.expect("init pool");
        (pool, dir)
    }

    #[tokio::test]
    async fn migrations_run_and_seed_statuses() {
        let (pool, dir) = test_pool().await;

        // 0002 seeds six builtin statuses; 0013 reduces them to exactly the three
        // surviving lanes (todo / doing / done) in display order.
        let statuses = board::list_statuses(&pool).await.unwrap();
        let ids: Vec<&str> = statuses.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["todo", "doing", "done"],
            "0013 leaves exactly the three lanes in order"
        );
        // The legacy columns are gone.
        for gone in ["backlog", "review", "discarded"] {
            assert!(!ids.contains(&gone), "{gone} column removed by 0013");
        }
        // Relabelled (no UPPERCASE label literals).
        let by_id: std::collections::HashMap<_, _> =
            statuses.iter().map(|s| (s.id.as_str(), s)).collect();
        assert_eq!(by_id["todo"].label, "To do");
        assert_eq!(by_id["doing"].label, "Doing");
        assert_eq!(by_id["done"].label, "Done");

        // Every migration file should be recorded as applied.
        let applied: i64 = sqlx::query("SELECT COUNT(*) AS n FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("n");
        assert_eq!(
            applied, 12,
            "expected twelve applied migrations (0001-0005, 0007-0013)"
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn session_insert_list_roundtrip_and_hook_token() {
        let (pool, dir) = test_pool().await;

        assert!(sessions::list(&pool).await.unwrap().is_empty());

        sessions::insert_minimal(&pool, "alpha", "/tmp/alpha", "shell")
            .await
            .unwrap();
        // A runtime row with a per-session hook token (Eng P1 #3).
        sessions::ensure_runtime(&pool, "alpha", "hooktok-alpha")
            .await
            .unwrap();

        let listed = sessions::list(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "alpha");
        assert_eq!(listed[0].provider, "shell");

        let rt = sessions::runtime(&pool, "alpha").await.unwrap().unwrap();
        assert_eq!(rt.hook_token, "hooktok-alpha");
        assert_eq!(rt.last_status, "unknown");

        // FK CASCADE: deleting the session removes its runtime row.
        sessions::delete(&pool, "alpha").await.unwrap();
        assert!(sessions::runtime(&pool, "alpha").await.unwrap().is_none());

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn provider_check_constraint_rejects_unknown() {
        let (pool, dir) = test_pool().await;
        let err = sessions::insert_minimal(&pool, "bad", "/tmp/bad", "bogus").await;
        assert!(err.is_err(), "CHECK(provider IN ...) must reject 'bogus'");
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

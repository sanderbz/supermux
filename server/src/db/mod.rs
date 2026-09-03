//! Persistence layer.
//!
//! [`init`] opens the SQLite pool with WAL + foreign keys and runs the embedded
//! migrations. Per-table query modules live alongside this file.

use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

use crate::config::Config;

pub mod audit;
pub mod board;
pub mod boards;
pub mod browser_tabs;
pub mod companies;
pub mod connectors;
pub mod hosts;
pub mod human_sessions;
pub mod human_users;
pub mod prefs;
pub mod push;
pub mod runtime_state;
pub mod sessions;
pub mod skills;
pub mod steering;
pub mod teams_dismissed;
pub mod tracked_files;
pub mod workflows;

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
            swarm_reaper: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            company_isolation: Vec::new(),
            human_auth: Default::default(),
            extra_origins: Vec::new(),
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
            applied, 42,
            "expected forty-two applied migrations (0001-0005, 0007-0043)"
        );

        // 0037 applied cleanly: the new nullable company_id column exists and a
        // fresh account backfills/defaults to NULL (= HQ/global, its prior meaning).
        let cols: Vec<String> = sqlx::query("PRAGMA table_info(connector_accounts)")
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|r| r.get::<String, _>("name"))
            .collect();
        assert!(
            cols.iter().any(|c| c == "company_id"),
            "0037 adds connector_accounts.company_id"
        );
        // 0042: the stable identity the brokered-OAuth account is keyed on (NULL
        // on every pre-existing row = un-keyed, adoptable by the first sign-in).
        assert!(
            cols.iter().any(|c| c == "identity_key"),
            "0042 adds connector_accounts.identity_key"
        );

        // 0039 (shared-browser v1): the workspace tab + per-tab grant tables. The
        // grant table is the ONE that must not be an overload of
        // `session_connectors` — its PK is (tab_id, grantee), so one grantee can
        // hold tab A and not tab B, which the connector grant cannot express.
        let tables: Vec<String> =
            sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table'")
                .fetch_all(&pool)
                .await
                .unwrap()
                .iter()
                .map(|r| r.get::<String, _>("name"))
                .collect();
        for want in ["browser_tabs", "browser_tab_grants"] {
            assert!(tables.iter().any(|t| t == want), "0039 adds {want}");
        }
        browser_tabs::create(&pool, "tb_migration0001", "https://x.test/", None, &[])
            .await
            .unwrap();
        browser_tabs::grant(&pool, "tb_migration0001", "alice", true)
            .await
            .unwrap();
        // ON DELETE CASCADE, mirroring connectors→session_connectors (0031).
        assert!(browser_tabs::delete(&pool, "tb_migration0001").await.unwrap());
        assert!(
            browser_tabs::grants_for_tab(&pool, "tb_migration0001")
                .await
                .unwrap()
                .is_empty(),
            "deleting a tab must cascade its grants"
        );
        connectors::upsert(&pool, "gh", "mcp_catalog", "gh", "", "", "[]", "[]", "{}", "{}")
            .await
            .unwrap();
        let acct = connectors::account_add(&pool, "gh", "alice", None, None)
            .await
            .unwrap();
        assert_eq!(
            connectors::account_get(&pool, &acct)
                .await
                .unwrap()
                .unwrap()
                .company_id,
            None,
            "a fresh account backfills to NULL company_id (HQ/global)"
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `config_dir` (migration 0041) threads NewSession -> INSERT -> row, and a
    /// duplicate inherits it, so a cloned session boots on the same account.
    /// An unset value reads back as the empty string, which every consumer
    /// treats as "use the daemon default".
    #[tokio::test]
    async fn config_dir_survives_create_and_duplicate() {
        let (pool, dir) = test_pool().await;

        let mut new = sessions::NewSession {
            name: "acct".into(),
            display_name: "acct".into(),
            dir: "/tmp".into(),
            desc: String::new(),
            provider: "claude".into(),
            creator: String::new(),
            flags: String::new(),
            tags: "[]".into(),
            branch: String::new(),
            mcp: String::new(),
            worktree: false,
            worktree_repo: String::new(),
            host_id: None,
            company_id: None,
            runtime: "native".into(),
            model: String::new(),
            archive_on_stop: false,
            config_dir: "/home/agent/.claude-second".into(),
        };
        sessions::create(&pool, &new).await.unwrap();

        let row = sessions::get(&pool, "acct").await.unwrap().unwrap();
        assert_eq!(row.config_dir, "/home/agent/.claude-second");

        sessions::duplicate(&pool, "acct", "acct-copy").await.unwrap();
        let copy = sessions::get(&pool, "acct-copy").await.unwrap().unwrap();
        assert_eq!(
            copy.config_dir, "/home/agent/.claude-second",
            "a duplicate must boot on the same account as its source"
        );

        // Unset is the empty string, never NULL: the column is NOT NULL DEFAULT ''.
        new.name = "plain".into();
        new.display_name = "plain".into();
        new.config_dir = String::new();
        sessions::create(&pool, &new).await.unwrap();
        let plain = sessions::get(&pool, "plain").await.unwrap().unwrap();
        assert_eq!(plain.config_dir, "");

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The production claim behind migration 0041: a row that already existed
    /// when the column was added keeps today's behaviour. Apply the chain up to
    /// 0040, insert a session through the pre-0041 column set, then apply the
    /// rest and read the value back. `DEFAULT ''` is what makes a legacy row
    /// mean "daemon default"; a NULL there would break every consumer that
    /// calls `config_dir.trim()`.
    #[tokio::test]
    async fn a_row_created_before_0041_backfills_to_the_empty_config_dir() {
        use sqlx::migrate::Migrate;
        use sqlx::{sqlite::SqliteConnection, Connection};
        let dir = std::env::temp_dir().join(format!("supermux-mig0041-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let mut conn = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .expect("connect");
        let migrator = sqlx::migrate!("./migrations");
        conn.ensure_migrations_table().await.unwrap();
        for m in migrator.iter().filter(|m| m.version < 41) {
            conn.apply(m).await.expect("pre-0041 migration applies");
        }
        // The pre-0041 column set: `config_dir` does not exist yet to bind.
        sqlx::query(
            "INSERT INTO sessions (name, dir, provider, created_at)
             VALUES ('legacy', '/tmp', 'claude', 0)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        migrator
            .run(&mut conn)
            .await
            .expect("0041 applies over an existing row");
        let config_dir: String =
            sqlx::query_scalar("SELECT config_dir FROM sessions WHERE name = 'legacy'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(
            config_dir, "",
            "an existing row must backfill to the daemon default"
        );

        conn.close().await.ok();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Regression for the 0015 prod crash: the runtime opens the DB with
    /// `foreign_keys=ON` (see [`init`]), and SQLite REFUSES
    /// `ALTER TABLE ... ADD COLUMN ... REFERENCES ... DEFAULT '<non-null>'` under
    /// FK enforcement ("Cannot add a REFERENCES column with non-NULL default
    /// value"). Run the FULL migration chain on a connection with `foreign_keys`
    /// explicitly enforced so any future migration that trips this fails the test
    /// suite, not a live deploy.
    #[tokio::test]
    async fn migrations_apply_under_foreign_keys_enforced() {
        use sqlx::{sqlite::SqliteConnection, Connection};
        let dir =
            std::env::temp_dir().join(format!("supermux-fkmig-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let mut conn = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .expect("connect with foreign_keys=ON");
        let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(fk, 1, "foreign_keys must be ON to faithfully mirror prod");
        sqlx::migrate!("./migrations")
            .run(&mut conn)
            .await
            .expect("all migrations must apply under foreign_keys=ON");
        conn.close().await.ok();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Migration 0032 regression, mirroring the board_id backfill/cascade proof:
    /// an existing (legacy) session — inserted with a column list that omits
    /// `company_id` — backfills to NULL (= a main bot, byte-identical behaviour);
    /// deleting a company NULLs its member sessions
    /// (`trg_company_delete_sessions`); and the seeded owner row exists exactly
    /// once.
    #[tokio::test]
    async fn migration_0032_backfills_null_company_and_cascades_on_delete() {
        let (pool, dir) = test_pool().await;
        let now = chrono::Utc::now().timestamp();

        // A legacy session (no company_id in the INSERT column list) backfills to NULL.
        sqlx::query(
            "INSERT INTO sessions (name, dir, desc, provider, flags, pinned, archived,
                 auto_continue, auto_continue_msg, rate_limit_resume_text, tags, creator,
                 branch, worktree, worktree_repo, mcp, created_at, start_count, last_started,
                 last_send, last_send_text, task_summary, cc_session_name, cc_conversation_id,
                 codex_session_id, start_error)
             VALUES ('legacy', '/home/x', '', 'claude', '', 0, 0, 0, 'continue', 'continue',
                     '[]', '', '', 0, '', '', ?, 0, 0, 0, '', '', '', '', '', '')",
        )
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
        let cid: Option<i64> =
            sqlx::query_scalar("SELECT company_id FROM sessions WHERE name = 'legacy'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cid, None, "existing fleet backfills to NULL = main bot");

        // Create a company + a member session.
        sqlx::query(
            "INSERT INTO companies (slug, display_name, root_dir, created_at, updated_at)
             VALUES ('acme', 'Acme', '/srv/acme', ?, ?)",
        )
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
        let acme: i64 = sqlx::query_scalar("SELECT id FROM companies WHERE slug='acme'")
            .fetch_one(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET company_id = ? WHERE name = 'legacy'")
            .bind(acme)
            .execute(&pool)
            .await
            .unwrap();

        // Deleting the company NULLs its sessions (trigger).
        sqlx::query("DELETE FROM companies WHERE id = ?")
            .bind(acme)
            .execute(&pool)
            .await
            .unwrap();
        let cid_after: Option<i64> =
            sqlx::query_scalar("SELECT company_id FROM sessions WHERE name = 'legacy'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cid_after, None, "trg_company_delete_sessions NULLs member sessions");

        // The seeded owner row exists exactly once.
        let owners: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM human_users WHERE role='owner'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(owners, 1, "exactly one seeded owner row");

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `company_id` threads NewSession → INSERT → `Session` row, and a
    /// `duplicate` INHERITS it (the clone's `company_id` matches the source's —
    /// the copied column list carries it).
    #[tokio::test]
    async fn create_persists_company_id_and_duplicate_inherits_it() {
        let (pool, dir) = test_pool().await;
        let now = chrono::Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO companies (slug, display_name, root_dir, created_at, updated_at)
             VALUES ('acme','Acme','/srv/acme',?,?)",
        )
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
        let acme: i64 = sqlx::query_scalar("SELECT id FROM companies WHERE slug='acme'")
            .fetch_one(&pool)
            .await
            .unwrap();

        let ns = sessions::NewSession {
            name: "bot-a".into(),
            display_name: "bot-a".into(),
            dir: "/srv/acme/bot-a".into(),
            desc: String::new(),
            provider: "claude".into(),
            creator: String::new(),
            flags: String::new(),
            tags: "[]".into(),
            branch: String::new(),
            mcp: String::new(),
            worktree: false,
            worktree_repo: String::new(),
            host_id: None,
            company_id: Some(acme),
            runtime: "native".into(),
            model: String::new(),
            archive_on_stop: false,
            config_dir: String::new(),
        };
        sessions::create(&pool, &ns).await.unwrap();
        let got = sessions::get(&pool, "bot-a").await.unwrap().unwrap();
        assert_eq!(got.company_id, Some(acme));

        sessions::duplicate(&pool, "bot-a", "bot-a-copy").await.unwrap();
        let copy = sessions::get(&pool, "bot-a-copy").await.unwrap().unwrap();
        assert_eq!(copy.company_id, Some(acme), "duplicate inherits company_id");

        // A main-bot session (no company) stays NULL and its duplicate too.
        let main = sessions::NewSession {
            name: "main-a".into(),
            display_name: "main-a".into(),
            dir: "/home/x".into(),
            desc: String::new(),
            provider: "claude".into(),
            creator: String::new(),
            flags: String::new(),
            tags: "[]".into(),
            branch: String::new(),
            mcp: String::new(),
            worktree: false,
            worktree_repo: String::new(),
            host_id: None,
            company_id: None,
            runtime: "native".into(),
            model: String::new(),
            archive_on_stop: false,
            config_dir: String::new(),
        };
        sessions::create(&pool, &main).await.unwrap();
        let got_main = sessions::get(&pool, "main-a").await.unwrap().unwrap();
        assert_eq!(got_main.company_id, None);

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn migration_0015_seeds_main_board_and_backfills_existing_cards() {
        let (pool, dir) = test_pool().await;

        // The fixed main board is seeded (id 'main', kind 'main', name "Main").
        let boards = boards::list(&pool).await.unwrap();
        assert_eq!(boards.len(), 1, "exactly the main board after a fresh migrate");
        let main = &boards[0];
        assert_eq!(main.id, boards::MAIN_BOARD_ID);
        assert_eq!(main.kind, "main");
        assert_eq!(main.name, "Main");
        assert!(main.team_name.is_none());

        // A card inserted via the legacy column set (no board_id) backfills onto
        // 'main' via the migration's DEFAULT — no card is orphaned off a board.
        let now = chrono::Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO issues (id, title, desc, status, creator, created, updated,
                                 owner_type, pinned, pos, notified)
             VALUES ('LEGACY-1', 't', '', 'todo', '', ?, ?, 'agent', 0, 0, 0)",
        )
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
        let board_id: String =
            sqlx::query_scalar("SELECT board_id FROM issues WHERE id = 'LEGACY-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(board_id, boards::MAIN_BOARD_ID, "legacy card backfilled to main");

        // Deleting a TEAM board CASCADE-deletes its cards (FK ON DELETE CASCADE),
        // and the main board is the upsert/register target for a team lookup.
        boards::insert(&pool, "team-alpha", "alpha", "team", Some("alpha"), 1.0)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO issues (id, title, desc, status, creator, created, updated,
                                 owner_type, pinned, pos, notified, board_id)
             VALUES ('TEAM-1', 't', '', 'todo', '', ?, ?, 'agent', 0, 0, 0, 'team-alpha')",
        )
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
        assert!(boards::get_by_team(&pool, "alpha").await.unwrap().is_some());
        assert!(boards::delete(&pool, "team-alpha").await.unwrap());
        let team_card: Option<String> =
            sqlx::query_scalar("SELECT id FROM issues WHERE id = 'TEAM-1'")
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(team_card.is_none(), "team board delete cascades its cards");

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
        // A runtime row with a per-session hook token.
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

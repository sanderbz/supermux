//! Company row access (migration `0032_companies.sql`).
//!
//! Mirrors the pattern in [`crate::db::hosts`]: runtime-checked
//! `sqlx::query_as::<_, T>` rather than the compile-time `query_as!` macro, so a
//! hermetic `cargo build`/`cargo test` (no `DATABASE_URL`, no committed `.sqlx`
//! cache) stays deterministic. The `FromRow` struct still gives typed rows.
//!
//! A `Company` is a first-class named workspace: a stable `slug` (immutable —
//! there is no `rename`/`set_slug`), a mutable `display_name`, a `root_dir`
//! folder every company agent lives under, an `archived` flag, and timestamps.
//! `sessions.company_id` is a plain nullable filter attribute pointing here;
//! `company_id IS NULL` is a main/PA/tech-admin bot.

use serde::Serialize;
use sqlx::SqlitePool;

/// A row of the `companies` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Company {
    pub id: i64,
    /// Stable, `[A-Za-z0-9_.-]+`, `UNIQUE`. Immutable once created (it is a
    /// folder-path and URL-legibility key), so there is no rename.
    pub slug: String,
    /// Mutable human label; may repeat across companies.
    pub display_name: String,
    /// Absolute folder root under which all this company's agents live.
    pub root_dir: String,
    /// `0` = active, `1` = archived (soft-hidden from the switcher / new-agent
    /// targeting; the `root_dir` is left untouched on disk).
    pub archived: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// List companies, alphabetically by display name. Archived rows are hidden
/// unless `include_archived` is set (the switcher passes `false`; a management
/// view can pass `true`).
pub async fn list(pool: &SqlitePool, include_archived: bool) -> sqlx::Result<Vec<Company>> {
    sqlx::query_as::<_, Company>(
        "SELECT id, slug, display_name, root_dir, archived, created_at, updated_at \
         FROM companies WHERE (? OR archived = 0) ORDER BY display_name ASC",
    )
    .bind(include_archived)
    .fetch_all(pool)
    .await
}

/// Fetch one company by id.
pub async fn get(pool: &SqlitePool, id: i64) -> sqlx::Result<Option<Company>> {
    sqlx::query_as::<_, Company>(
        "SELECT id, slug, display_name, root_dir, archived, created_at, updated_at \
         FROM companies WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

/// Fetch one company by its stable `slug`.
pub async fn get_by_slug(pool: &SqlitePool, slug: &str) -> sqlx::Result<Option<Company>> {
    sqlx::query_as::<_, Company>(
        "SELECT id, slug, display_name, root_dir, archived, created_at, updated_at \
         FROM companies WHERE slug = ?",
    )
    .bind(slug)
    .fetch_optional(pool)
    .await
}

/// Insert a fresh company row (`archived = 0`, `created_at = updated_at = now`)
/// and return it. The `UNIQUE(slug)` constraint surfaces a duplicate-slug
/// attempt as a `sqlx::Error::Database` with the SQLite UNIQUE error code; the
/// router turns that into a clean 409.
pub async fn create(
    pool: &SqlitePool,
    slug: &str,
    display_name: &str,
    root_dir: &str,
) -> sqlx::Result<Company> {
    let now = chrono::Utc::now().timestamp();
    let res = sqlx::query(
        "INSERT INTO companies (slug, display_name, root_dir, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(slug)
    .bind(display_name)
    .bind(root_dir)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;
    let id = res.last_insert_rowid();
    get(pool, id).await?.ok_or(sqlx::Error::RowNotFound)
}

/// Update the mutable `display_name` (and bump `updated_at`). Returns `true`
/// when a row was actually touched. The `slug` is immutable — there is no
/// setter for it.
pub async fn set_display_name(
    pool: &SqlitePool,
    id: i64,
    display_name: &str,
) -> sqlx::Result<bool> {
    let now = chrono::Utc::now().timestamp();
    let res = sqlx::query("UPDATE companies SET display_name = ?, updated_at = ? WHERE id = ?")
        .bind(display_name)
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Flip the `archived` flag (soft hide / restore) and bump `updated_at`.
/// Returns `true` when a row was touched.
pub async fn set_archived(pool: &SqlitePool, id: i64, archived: bool) -> sqlx::Result<bool> {
    let now = chrono::Utc::now().timestamp();
    let res = sqlx::query("UPDATE companies SET archived = ?, updated_at = ? WHERE id = ?")
        .bind(archived as i64)
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Hard-delete a company row. Returns `true` when a row was removed. The
/// `trg_company_delete_sessions` trigger (0032) then NULLs any lingering
/// sessions' `company_id`. The `root_dir` folder on disk is NOT removed — that
/// is the caller's deliberate act.
pub async fn delete(pool: &SqlitePool, id: i64) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM companies WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Count this company's ACTIVE (non-archived) sessions — the delete guard reads
/// it (a company with live members cannot be hard-deleted).
pub async fn active_session_count(pool: &SqlitePool, id: i64) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE company_id = ? AND archived = 0")
        .bind(id)
        .fetch_one(pool)
        .await
}

/// Slugs of every session belonging to `company` (archived included — a
/// delegation edge can point at an archived peer). Used by the optional
/// `company` scope on the delegation-graph read; the omniscient owner default
/// never calls it. One query, so a scoped caller filters against a set rather
/// than a per-edge lookup.
pub async fn names_in_company(pool: &SqlitePool, company: i64) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT name FROM sessions WHERE company_id = ?")
        .bind(company)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|(n,)| n).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    /// Local test pool — there is no shared `crate::db::test_pool()` (each db
    /// module brings its own; the shape is copied from `db/mod.rs`).
    async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("supermux-companies-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (pool, dir)
    }

    #[tokio::test]
    async fn create_list_archive_delete_roundtrip() {
        let (pool, dir) = test_pool().await;
        let c = create(&pool, "acme", "Acme", "/srv/acme").await.unwrap();
        assert_eq!(c.slug, "acme");
        assert_eq!(c.archived, 0);
        assert_eq!(list(&pool, false).await.unwrap().len(), 1);
        assert_eq!(get_by_slug(&pool, "acme").await.unwrap().unwrap().id, c.id);

        assert!(set_display_name(&pool, c.id, "Acme Corp").await.unwrap());
        assert_eq!(
            get(&pool, c.id).await.unwrap().unwrap().display_name,
            "Acme Corp"
        );

        assert!(set_archived(&pool, c.id, true).await.unwrap());
        assert_eq!(
            list(&pool, false).await.unwrap().len(),
            0,
            "archived hidden by default"
        );
        assert_eq!(
            list(&pool, true).await.unwrap().len(),
            1,
            "included when asked"
        );

        assert_eq!(active_session_count(&pool, c.id).await.unwrap(), 0);
        assert!(delete(&pool, c.id).await.unwrap());
        assert!(get(&pool, c.id).await.unwrap().is_none());

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

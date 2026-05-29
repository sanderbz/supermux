//! Per-session tracked-files list (`tracked_files` table).
//!
//! The set of file paths a session is "watching". Rows cascade-delete with the
//! owning session via the FK in the schema.

use sqlx::SqlitePool;

/// List a session's tracked file paths, sorted.
pub async fn list(pool: &SqlitePool, session: &str) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar::<_, String>(
        "SELECT path FROM tracked_files WHERE session = ? ORDER BY path ASC",
    )
    .bind(session)
    .fetch_all(pool)
    .await
}

/// Add paths (idempotent — `INSERT OR IGNORE` on the `(session, path)` PK).
pub async fn add(pool: &SqlitePool, session: &str, paths: &[String]) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    for path in paths {
        sqlx::query(
            "INSERT OR IGNORE INTO tracked_files (session, path, added_at) VALUES (?, ?, ?)",
        )
        .bind(session)
        .bind(path)
        .bind(now)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Remove paths (no-op for paths that were not tracked).
pub async fn remove(pool: &SqlitePool, session: &str, paths: &[String]) -> sqlx::Result<()> {
    for path in paths {
        sqlx::query("DELETE FROM tracked_files WHERE session = ? AND path = ?")
            .bind(session)
            .bind(path)
            .execute(pool)
            .await?;
    }
    Ok(())
}

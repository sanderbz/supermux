//! Per-session steering queue (TECH_PLAN §3.3 `steering_queue`, M2).
//!
//! Steering messages are queued by the user and delivered at the agent's next
//! turn boundary (the delivery half lands with the lifecycle work in a later
//! milestone). M2 owns the DB-backed CRUD only. Rows cascade-delete with the
//! owning session.

use serde::Serialize;
use sqlx::SqlitePool;

/// One queued steering message.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct SteerEntry {
    pub id: i64,
    pub text: String,
    pub queued_at: i64,
}

/// List a session's queued messages, oldest first (matches delivery order).
pub async fn list(pool: &SqlitePool, session: &str) -> sqlx::Result<Vec<SteerEntry>> {
    sqlx::query_as::<_, SteerEntry>(
        "SELECT id, text, queued_at FROM steering_queue WHERE session = ? ORDER BY id ASC",
    )
    .bind(session)
    .fetch_all(pool)
    .await
}

/// Enqueue a message; returns the new row id.
pub async fn enqueue(pool: &SqlitePool, session: &str, text: &str) -> sqlx::Result<i64> {
    let now = chrono::Utc::now().timestamp();
    let res = sqlx::query("INSERT INTO steering_queue (session, text, queued_at) VALUES (?, ?, ?)")
        .bind(session)
        .bind(text)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(res.last_insert_rowid())
}

/// Clear the whole queue for a session; returns rows removed.
pub async fn clear(pool: &SqlitePool, session: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM steering_queue WHERE session = ?")
        .bind(session)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Clear one queued message by id; returns rows removed (0 if not found).
pub async fn clear_one(pool: &SqlitePool, session: &str, id: i64) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM steering_queue WHERE session = ? AND id = ?")
        .bind(session)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

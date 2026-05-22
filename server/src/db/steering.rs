//! Per-session steering queue (TECH_PLAN §3.3 `steering_queue`, M2/M9).
//!
//! Steering messages are queued by the user (M2 CRUD) and delivered at the
//! agent's next turn boundary by the M9 deliver loop
//! ([`crate::sessions::steering::deliver_loop`]). Rows cascade-delete with the
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

/// Atomically pop the oldest queued message for `session` (TECH_PLAN §3.9 deliver
/// loop). Opens a transaction whose `DELETE WHERE id=?` is gated on the row still
/// being present, so a message is dequeued **exactly once** even if two deliver
/// passes race for the same row: only one `DELETE` reports `rows_affected == 1`;
/// the loser sees `0` and reports empty rather than re-delivering a row it never
/// owned. Returns `Some(text)` of the message removed, or `None` if the queue was
/// empty.
///
/// SQLite serializes writers; under contention an acquiring transaction can get
/// `SQLITE_BUSY` despite the pool's busy-timeout. We retry such transient locks a
/// few times (the contention here is bounded — single-flight per session plus a
/// rare safety-tick overlap), so a momentary lock never drops a steer.
pub async fn pop_oldest(pool: &SqlitePool, session: &str) -> sqlx::Result<Option<String>> {
    const MAX_ATTEMPTS: u32 = 8;
    let mut attempt = 0;
    loop {
        match pop_oldest_once(pool, session).await {
            Ok(v) => return Ok(v),
            Err(e) if is_locked(&e) && attempt < MAX_ATTEMPTS => {
                attempt += 1;
                // Brief, growing backoff to let the current writer commit.
                tokio::time::sleep(std::time::Duration::from_millis(5 * attempt as u64)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Is this a transient SQLite busy/locked error worth retrying?
fn is_locked(e: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(db) = e {
        // SQLITE_BUSY = 5, SQLITE_LOCKED = 6.
        matches!(db.code().as_deref(), Some("5") | Some("6"))
    } else {
        false
    }
}

/// One attempt at the transactional dequeue (no retry).
async fn pop_oldest_once(pool: &SqlitePool, session: &str) -> sqlx::Result<Option<String>> {
    // `begin()` issues `BEGIN`; SQLite upgrades to a write lock on the DELETE.
    // The SELECT…LIMIT 1 + DELETE WHERE id=? pair inside one tx is the
    // single-flight dequeue from the plan.
    let mut tx = pool.begin().await?;
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, text FROM steering_queue WHERE session = ? ORDER BY id ASC LIMIT 1",
    )
    .bind(session)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((id, text)) = row else {
        tx.rollback().await?;
        return Ok(None);
    };

    let deleted = sqlx::query("DELETE FROM steering_queue WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();

    tx.commit().await?;

    // If another pass deleted it first (deleted == 0), report empty so we don't
    // re-deliver a message we never owned.
    Ok(if deleted == 1 { Some(text) } else { None })
}

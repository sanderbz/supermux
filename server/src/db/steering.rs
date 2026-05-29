//! Per-session steering queue (`steering_queue` table).
//!
//! Steering messages are queued by the user and delivered at the agent's next
//! turn boundary by the deliver loop
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

/// Atomically pop the oldest queued message for `session` (the deliver loop's
/// dequeue). Opens a transaction whose `DELETE WHERE id=?` is gated on the row still
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
///
/// SQLite reports plain `SQLITE_BUSY` (5) / `SQLITE_LOCKED` (6) AND — under WAL
/// — the *extended* codes `SQLITE_BUSY_SNAPSHOT` (517) and `SQLITE_BUSY_RECOVERY`
/// (261). `BUSY_SNAPSHOT` fires when a deferred read transaction tries to
/// upgrade to a write after another connection committed: `busy_timeout` does
/// NOT retry it (the snapshot is stale by design), so the whole transaction
/// must be rolled back and retried. `BEGIN IMMEDIATE` in `pop_oldest_once`
/// avoids the read→write upgrade entirely, and this broadened predicate catches
/// the extended busy codes as a belt-and-braces guard.
fn is_locked(e: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(db) = e {
        // SQLITE_BUSY = 5, SQLITE_LOCKED = 6; extended: BUSY_SNAPSHOT = 517,
        // BUSY_RECOVERY = 261, LOCKED_SHAREDCACHE = 262.
        matches!(
            db.code().as_deref(),
            Some("5") | Some("6") | Some("517") | Some("261") | Some("262")
        )
    } else {
        false
    }
}

/// One attempt at the transactional dequeue (no retry).
async fn pop_oldest_once(pool: &SqlitePool, session: &str) -> sqlx::Result<Option<String>> {
    // `BEGIN IMMEDIATE` takes the write lock UP FRONT. sqlx's `pool.begin()`
    // issues a plain (deferred) `BEGIN`: the SELECT then starts a read snapshot
    // and the later `DELETE` must upgrade read→write — under WAL that upgrade
    // fails with `SQLITE_BUSY_SNAPSHOT` (517) if another connection committed in
    // between, and `busy_timeout` will not retry it. Acquiring a connection and
    // opening the txn with `BEGIN IMMEDIATE` makes the dequeue a single,
    // properly-serialized writer. On any early return the connection is
    // dropped, which rolls back the open transaction.
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    let row: sqlx::Result<Option<(i64, String)>> = sqlx::query_as(
        "SELECT id, text FROM steering_queue WHERE session = ? ORDER BY id ASC LIMIT 1",
    )
    .bind(session)
    .fetch_optional(&mut *conn)
    .await;
    let row = match row {
        Ok(r) => r,
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(e);
        }
    };

    let Some((id, text)) = row else {
        sqlx::query("ROLLBACK").execute(&mut *conn).await?;
        return Ok(None);
    };

    let deleted = match sqlx::query("DELETE FROM steering_queue WHERE id = ?")
        .bind(id)
        .execute(&mut *conn)
        .await
    {
        Ok(r) => r.rows_affected(),
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(e);
        }
    };

    sqlx::query("COMMIT").execute(&mut *conn).await?;

    // If another pass deleted it first (deleted == 0), report empty so we don't
    // re-deliver a message we never owned.
    Ok(if deleted == 1 { Some(text) } else { None })
}

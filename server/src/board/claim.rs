//! Atomic claim — the multi-agent coordination primitive.
//!
//! The claim is a single `UPDATE ... RETURNING` guarded by the WHERE clause
//! `status IN ('todo','backlog') AND owner_type='agent' AND deleted IS NULL`, so
//! exactly one of N racing callers can flip an issue to `doing`.
//!
//! **Contention hardening.** The pool already sets
//! `busy_timeout = 5000` (`db::init`). On top of that, the claim runs inside a
//! `BEGIN IMMEDIATE` transaction so any write contention waits *inside* SQLite
//! (up to the busy timeout) and resolves to the "no row updated" → 409 path,
//! never bubbling a `SQLITE_BUSY` 500. When the UPDATE matches nothing, a
//! follow-up read (still inside the same transaction) tells the caller *why*
//! (gone / not-an-agent-task / wrong-status / lost-the-race) for a precise 404
//! vs 409.

use sqlx::SqlitePool;

use crate::db::board::Issue;

/// Why a claim could not succeed.
#[derive(Debug)]
pub enum ClaimError {
    /// No such (non-deleted) issue → 404.
    NotFound,
    /// Issue exists but is human-owned → 409.
    NotAgentTask,
    /// Issue is not in a claimable column (already `doing`/`done`/…) → 409.
    WrongStatus(String),
    /// Lost the race: it was claimable a moment ago, gone now → 409.
    Taken,
    /// Unexpected database error → 500.
    Db(sqlx::Error),
}

impl From<sqlx::Error> for ClaimError {
    fn from(e: sqlx::Error) -> Self {
        ClaimError::Db(e)
    }
}

/// Atomically claim `id` for `session`. See module docs.
pub async fn claim(pool: &SqlitePool, id: &str, session: &str) -> Result<Issue, ClaimError> {
    let now = chrono::Utc::now().timestamp();

    // Acquire a dedicated connection and open an IMMEDIATE write transaction so
    // the write lock is taken up-front; the busy_timeout absorbs contention.
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    let updated = sqlx::query_as::<_, Issue>(
        "UPDATE issues
            SET status = 'doing', session = ?1, updated = ?2
          WHERE id = ?3
            AND status IN ('todo', 'backlog')
            AND owner_type = 'agent'
            AND deleted IS NULL
        RETURNING *",
    )
    .bind(session)
    .bind(now)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await;

    match updated {
        Ok(Some(issue)) => {
            sqlx::query("COMMIT").execute(&mut *conn).await?;
            Ok(issue)
        }
        Ok(None) => {
            // No row changed — determine the reason from the current state, still
            // holding the write lock for a consistent read, then release it.
            let current = sqlx::query_as::<_, Issue>(
                "SELECT * FROM issues WHERE id = ? AND deleted IS NULL",
            )
            .bind(id)
            .fetch_optional(&mut *conn)
            .await;
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            match current {
                Ok(None) => Err(ClaimError::NotFound),
                Ok(Some(issue)) if issue.owner_type != "agent" => Err(ClaimError::NotAgentTask),
                Ok(Some(issue))
                    if issue.status != "todo" && issue.status != "backlog" =>
                {
                    Err(ClaimError::WrongStatus(issue.status))
                }
                // Agent task, claimable column, yet the UPDATE matched nothing:
                // a concurrent claim took it between our UPDATE and this read.
                Ok(Some(_)) => Err(ClaimError::Taken),
                Err(e) => Err(ClaimError::Db(e)),
            }
        }
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(ClaimError::Db(e))
        }
    }
}

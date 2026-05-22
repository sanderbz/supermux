//! Board row access (TECH_PLAN §3.3 `issues` + `statuses`).
//!
//! Runtime-checked queries — see the note in [`super::sessions`].

use serde::Serialize;
use sqlx::SqlitePool;

/// A row of the `issues` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Issue {
    pub id: String,
    pub title: String,
    pub desc: String,
    pub status: String,
    pub session: Option<String>,
    pub creator: String,
    pub due: Option<String>,
    pub due_time: Option<String>,
    pub created: i64,
    pub updated: i64,
    pub deleted: Option<i64>,
    pub owner_type: String,
    pub pinned: i64,
    pub pos: f64,
    pub notified: i64,
}

/// A row of the `statuses` table (board columns).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct BoardStatus {
    pub id: String,
    pub label: String,
    pub position: i64,
    pub is_builtin: i64,
}

/// List the board columns in display order.
pub async fn list_statuses(pool: &SqlitePool) -> sqlx::Result<Vec<BoardStatus>> {
    sqlx::query_as::<_, BoardStatus>("SELECT * FROM statuses ORDER BY position ASC")
        .fetch_all(pool)
        .await
}

/// List non-deleted issues in column/position order.
pub async fn list_issues(pool: &SqlitePool) -> sqlx::Result<Vec<Issue>> {
    sqlx::query_as::<_, Issue>(
        "SELECT * FROM issues WHERE deleted IS NULL ORDER BY status ASC, pos ASC",
    )
    .fetch_all(pool)
    .await
}

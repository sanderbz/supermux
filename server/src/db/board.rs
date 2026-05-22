//! Board row access (TECH_PLAN §3.3 `issues` + `statuses`, feature-extract §2).
//!
//! Runtime-checked queries — see the note in [`super::sessions`]. Higher-level
//! orchestration (validation, the HTTP envelope, the atomic claim transaction)
//! lives in [`crate::board`]; this module is the typed SQL surface only.

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

// ── statuses (board columns) ─────────────────────────────────────────────────

/// List the board columns in display order.
pub async fn list_statuses(pool: &SqlitePool) -> sqlx::Result<Vec<BoardStatus>> {
    sqlx::query_as::<_, BoardStatus>("SELECT * FROM statuses ORDER BY position ASC")
        .fetch_all(pool)
        .await
}

/// Fetch one status column by id.
pub async fn get_status(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<BoardStatus>> {
    sqlx::query_as::<_, BoardStatus>("SELECT * FROM statuses WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// Insert a custom (non-builtin) status column appended after the last position.
pub async fn create_status(
    pool: &SqlitePool,
    id: &str,
    label: &str,
) -> sqlx::Result<BoardStatus> {
    // Append at the end: max(position)+1 (or 0 for an empty table).
    let next_pos: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(position) + 1, 0) FROM statuses")
            .fetch_one(pool)
            .await?;
    sqlx::query(
        "INSERT INTO statuses (id, label, position, is_builtin) VALUES (?, ?, ?, 0)",
    )
    .bind(id)
    .bind(label)
    .bind(next_pos)
    .execute(pool)
    .await?;
    Ok(BoardStatus {
        id: id.to_string(),
        label: label.to_string(),
        position: next_pos,
        is_builtin: 0,
    })
}

/// Rename a column's label. Returns false if the id does not exist.
pub async fn rename_status(pool: &SqlitePool, id: &str, label: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("UPDATE statuses SET label = ? WHERE id = ?")
        .bind(label)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Delete a custom column and reassign its issues back to `todo` (feature-extract
/// §2.1). Done in one transaction so no issue is ever orphaned in a gone column.
pub async fn delete_status(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE issues SET status = 'todo' WHERE status = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM statuses WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

/// Reorder columns: assign `position` by the index in `order`. Unlisted columns
/// keep their existing position bumped past the listed ones.
pub async fn reorder_statuses(pool: &SqlitePool, order: &[String]) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    for (pos, id) in order.iter().enumerate() {
        sqlx::query("UPDATE statuses SET position = ? WHERE id = ?")
            .bind(pos as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

// ── issues ───────────────────────────────────────────────────────────────────

/// List non-deleted issues, with `done`-column items capped at `done_limit`
/// (feature-extract §2.1; 0 = unlimited). Sort: pinned-desc, then reordered
/// (`pos != 0`) ascending, then unreordered by `updated`-desc (§2.2).
pub async fn list_issues(pool: &SqlitePool, done_limit: i64) -> sqlx::Result<Vec<Issue>> {
    // Stable composite sort matching v2's `_load_board`.
    let order = "ORDER BY pinned DESC, (pos = 0) ASC, pos ASC, updated DESC";
    let mut issues = sqlx::query_as::<_, Issue>(&format!(
        "SELECT * FROM issues WHERE deleted IS NULL AND status != 'done' {order}"
    ))
    .fetch_all(pool)
    .await?;

    let mut done = if done_limit == 0 {
        sqlx::query_as::<_, Issue>(&format!(
            "SELECT * FROM issues WHERE deleted IS NULL AND status = 'done' {order}"
        ))
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, Issue>(&format!(
            "SELECT * FROM issues WHERE deleted IS NULL AND status = 'done' {order} LIMIT ?"
        ))
        .bind(done_limit)
        .fetch_all(pool)
        .await?
    };
    issues.append(&mut done);
    Ok(issues)
}

/// Fetch one non-deleted issue by id.
pub async fn get_issue(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Issue>> {
    sqlx::query_as::<_, Issue>("SELECT * FROM issues WHERE id = ? AND deleted IS NULL")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// Issues with a `due` date set (for the iCal feed, feature-extract §2.7).
pub async fn issues_with_due(pool: &SqlitePool) -> sqlx::Result<Vec<Issue>> {
    sqlx::query_as::<_, Issue>(
        "SELECT * FROM issues WHERE deleted IS NULL AND due IS NOT NULL AND due != ''
         ORDER BY due ASC",
    )
    .fetch_all(pool)
    .await
}

/// Column values for an [`insert_issue`] call.
#[derive(Debug, Clone)]
pub struct NewIssue {
    pub id: String,
    pub title: String,
    pub desc: String,
    pub status: String,
    pub session: Option<String>,
    pub creator: String,
    pub due: Option<String>,
    pub due_time: Option<String>,
    pub owner_type: String,
    pub pos: f64,
    pub notified: i64,
}

/// Insert a new issue row. `created`/`updated` are set to now.
pub async fn insert_issue(pool: &SqlitePool, i: &NewIssue) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO issues
            (id, title, desc, status, session, creator, due, due_time,
             created, updated, owner_type, pinned, pos, notified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(&i.id)
    .bind(&i.title)
    .bind(&i.desc)
    .bind(&i.status)
    .bind(&i.session)
    .bind(&i.creator)
    .bind(&i.due)
    .bind(&i.due_time)
    .bind(now)
    .bind(now)
    .bind(&i.owner_type)
    .bind(i.pos)
    .bind(i.notified)
    .execute(pool)
    .await?;
    Ok(())
}

/// The smallest `pos` currently in `status` (for "place new card at top"). New
/// cards get `min_pos - 1024.0` (feature-extract §2.4).
pub async fn min_pos_in_status(pool: &SqlitePool, status: &str) -> sqlx::Result<f64> {
    let min: Option<f64> =
        sqlx::query_scalar("SELECT MIN(pos) FROM issues WHERE status = ? AND deleted IS NULL")
            .bind(status)
            .fetch_optional(pool)
            .await?
            .flatten();
    Ok(min.unwrap_or(0.0))
}

/// A single editable field for [`patch_issue`].
pub enum IssueField {
    Title(String),
    Desc(String),
    Status(String),
    Session(Option<String>),
    Creator(String),
    Due(Option<String>),
    DueTime(Option<String>),
    OwnerType(String),
    Pinned(i64),
    Pos(f64),
    /// Reset the notify flag (set when the assignee changes).
    Notified(i64),
}

/// Apply a set of field updates to one issue, bumping `updated`. Done in a single
/// transaction. Returns false if the id does not exist (or is soft-deleted).
pub async fn patch_issue(
    pool: &SqlitePool,
    id: &str,
    fields: &[IssueField],
) -> sqlx::Result<bool> {
    if fields.is_empty() {
        return Ok(get_issue(pool, id).await?.is_some());
    }
    let now = chrono::Utc::now().timestamp();
    let mut tx = pool.begin().await?;
    let mut any = false;
    for f in fields {
        let res = match f {
            IssueField::Title(v) => bind_set(&mut tx, "title", v, id).await?,
            IssueField::Desc(v) => bind_set(&mut tx, "desc", v, id).await?,
            IssueField::Status(v) => bind_set(&mut tx, "status", v, id).await?,
            IssueField::Creator(v) => bind_set(&mut tx, "creator", v, id).await?,
            IssueField::OwnerType(v) => bind_set(&mut tx, "owner_type", v, id).await?,
            IssueField::Session(v) => bind_set_opt(&mut tx, "session", v.as_deref(), id).await?,
            IssueField::Due(v) => bind_set_opt(&mut tx, "due", v.as_deref(), id).await?,
            IssueField::DueTime(v) => bind_set_opt(&mut tx, "due_time", v.as_deref(), id).await?,
            IssueField::Pinned(v) => bind_set_i64(&mut tx, "pinned", *v, id).await?,
            IssueField::Notified(v) => bind_set_i64(&mut tx, "notified", *v, id).await?,
            IssueField::Pos(v) => {
                sqlx::query("UPDATE issues SET pos = ? WHERE id = ? AND deleted IS NULL")
                    .bind(*v)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected()
            }
        };
        any = any || res > 0;
    }
    // Bump `updated` once if anything matched.
    if any {
        sqlx::query("UPDATE issues SET updated = ? WHERE id = ? AND deleted IS NULL")
            .bind(now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(any)
}

async fn bind_set(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    col: &str,
    val: &str,
    id: &str,
) -> sqlx::Result<u64> {
    let sql = format!("UPDATE issues SET {col} = ? WHERE id = ? AND deleted IS NULL");
    Ok(sqlx::query(&sql)
        .bind(val)
        .bind(id)
        .execute(&mut **tx)
        .await?
        .rows_affected())
}

async fn bind_set_opt(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    col: &str,
    val: Option<&str>,
    id: &str,
) -> sqlx::Result<u64> {
    let sql = format!("UPDATE issues SET {col} = ? WHERE id = ? AND deleted IS NULL");
    Ok(sqlx::query(&sql)
        .bind(val)
        .bind(id)
        .execute(&mut **tx)
        .await?
        .rows_affected())
}

async fn bind_set_i64(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    col: &str,
    val: i64,
    id: &str,
) -> sqlx::Result<u64> {
    let sql = format!("UPDATE issues SET {col} = ? WHERE id = ? AND deleted IS NULL");
    Ok(sqlx::query(&sql)
        .bind(val)
        .bind(id)
        .execute(&mut **tx)
        .await?
        .rows_affected())
}

/// Soft-delete: set `deleted = now`. Returns false if not found / already gone.
pub async fn soft_delete(pool: &SqlitePool, id: &str) -> sqlx::Result<bool> {
    let now = chrono::Utc::now().timestamp();
    let res = sqlx::query("UPDATE issues SET deleted = ? WHERE id = ? AND deleted IS NULL")
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Soft-delete every `done` issue. Returns the count of remaining non-deleted
/// issues (feature-extract §2.1 returns `{ok, remaining}`).
pub async fn clear_done(pool: &SqlitePool) -> sqlx::Result<i64> {
    let now = chrono::Utc::now().timestamp();
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE issues SET deleted = ? WHERE status = 'done' AND deleted IS NULL")
        .bind(now)
        .execute(&mut *tx)
        .await?;
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM issues WHERE deleted IS NULL")
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(remaining)
}

// ── tags ─────────────────────────────────────────────────────────────────────

/// Tags attached to one issue, in stable (alphabetical) order.
pub async fn tags_for(pool: &SqlitePool, id: &str) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar("SELECT tag FROM issue_tags WHERE issue_id = ? ORDER BY tag ASC")
        .bind(id)
        .fetch_all(pool)
        .await
}

/// Replace the full tag set for an issue (used by create + patch).
pub async fn set_tags(pool: &SqlitePool, id: &str, tags: &[String]) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM issue_tags WHERE issue_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() {
            continue;
        }
        sqlx::query("INSERT OR IGNORE INTO issue_tags (issue_id, tag) VALUES (?, ?)")
            .bind(id)
            .bind(tag)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

/// Aggregate done-status for a tag (feature-extract §2.1 `tag-completion`).
/// Returns `(total, done)` over non-deleted issues carrying `tag`.
pub async fn tag_completion(pool: &SqlitePool, tag: &str) -> sqlx::Result<(i64, i64)> {
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM issues i
         JOIN issue_tags t ON t.issue_id = i.id
         WHERE t.tag = ? AND i.deleted IS NULL",
    )
    .bind(tag)
    .fetch_one(pool)
    .await?;
    let done: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM issues i
         JOIN issue_tags t ON t.issue_id = i.id
         WHERE t.tag = ? AND i.deleted IS NULL AND i.status = 'done'",
    )
    .bind(tag)
    .fetch_one(pool)
    .await?;
    Ok((total, done))
}

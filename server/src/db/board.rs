//! Board row access (`issues` + `statuses` tables).
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
    /// Set by the auto_actions idle side-effect when the owning agent finished
    /// its turn (migration 0011). 0/1. FLAG only — the card is not moved.
    pub needs_review: i64,
    /// Set by the auto_actions sustained-`waiting` side-effect when the owning
    /// agent is blocked on the user (migration 0011). 0/1.
    pub awaiting_input: i64,
    /// Soft discard (migration 0013). 1 = archived: the card is hidden from the
    /// default board list but its row + history are preserved (restorable).
    /// Distinct from `deleted` (hard delete).
    pub archived: i64,
    /// Which board this card lives on (migration 0015). Always set —
    /// existing cards were backfilled to the fixed `main` board; new cards default
    /// to `main` unless created on a team board.
    pub board_id: String,
    /// Stable backlink to the on-disk team task this card mirrors (migration
    /// 0016). `None` for an ordinary card; `Some(task_id)` for a team card,
    /// unique within its board so the read-through mirror upserts (never
    /// duplicates) across detect ticks.
    pub team_task_id: Option<String>,
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

/// Delete a custom column and reassign its issues back to `todo`. Done in one
/// transaction so no issue is ever orphaned in a gone column.
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

/// List non-deleted, non-archived issues ACROSS ALL boards, with `done`-column
/// items capped at `done_limit` (0 = unlimited). Sort: pinned-desc, then
/// reordered (`pos != 0`) ascending, then unreordered by `updated`-desc.
/// Archived (soft-discarded) cards are excluded.
///
/// This is the "All" aggregate — the cross-board overview. Per-board scoping
/// uses [`list_issues_for_board`].
pub async fn list_issues(pool: &SqlitePool, done_limit: i64) -> sqlx::Result<Vec<Issue>> {
    // Stable composite sort matching v2's `_load_board`.
    let order = "ORDER BY pinned DESC, (pos = 0) ASC, pos ASC, updated DESC";
    let mut issues = sqlx::query_as::<_, Issue>(&format!(
        "SELECT * FROM issues
         WHERE deleted IS NULL AND archived = 0 AND status != 'done' {order}"
    ))
    .fetch_all(pool)
    .await?;

    let mut done = if done_limit == 0 {
        sqlx::query_as::<_, Issue>(&format!(
            "SELECT * FROM issues
             WHERE deleted IS NULL AND archived = 0 AND status = 'done' {order}"
        ))
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, Issue>(&format!(
            "SELECT * FROM issues
             WHERE deleted IS NULL AND archived = 0 AND status = 'done' {order} LIMIT ?"
        ))
        .bind(done_limit)
        .fetch_all(pool)
        .await?
    };
    issues.append(&mut done);
    Ok(issues)
}

/// List non-deleted, non-archived issues SCOPED to one board (migration 0015).
/// Same sort + `done_limit` semantics as [`list_issues`], just filtered by
/// `board_id` (indexed by `idx_issues_board`).
pub async fn list_issues_for_board(
    pool: &SqlitePool,
    board_id: &str,
    done_limit: i64,
) -> sqlx::Result<Vec<Issue>> {
    let order = "ORDER BY pinned DESC, (pos = 0) ASC, pos ASC, updated DESC";
    let mut issues = sqlx::query_as::<_, Issue>(&format!(
        "SELECT * FROM issues
         WHERE board_id = ? AND deleted IS NULL AND archived = 0
           AND status != 'done' {order}"
    ))
    .bind(board_id)
    .fetch_all(pool)
    .await?;

    let mut done = if done_limit == 0 {
        sqlx::query_as::<_, Issue>(&format!(
            "SELECT * FROM issues
             WHERE board_id = ? AND deleted IS NULL AND archived = 0
               AND status = 'done' {order}"
        ))
        .bind(board_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, Issue>(&format!(
            "SELECT * FROM issues
             WHERE board_id = ? AND deleted IS NULL AND archived = 0
               AND status = 'done' {order} LIMIT ?"
        ))
        .bind(board_id)
        .bind(done_limit)
        .fetch_all(pool)
        .await?
    };
    issues.append(&mut done);
    Ok(issues)
}

/// Every non-deleted card on `board_id` that mirrors an on-disk team task
/// (`team_task_id IS NOT NULL`), keyed for the read-through reconcile. The
/// watcher diffs this set against the team's current task files each tick:
/// upsert the survivors, hard-delete the cards whose task vanished. Archived
/// cards are INCLUDED (a reconcile may need to revive or finally remove one).
pub async fn team_cards_for_board(
    pool: &SqlitePool,
    board_id: &str,
) -> sqlx::Result<Vec<Issue>> {
    sqlx::query_as::<_, Issue>(
        "SELECT * FROM issues
         WHERE board_id = ? AND team_task_id IS NOT NULL AND deleted IS NULL",
    )
    .bind(board_id)
    .fetch_all(pool)
    .await
}

/// Fetch the card on `board_id` mirroring on-disk task `team_task_id`, if any.
/// The upsert lookup for the read-through mirror (unique by `(board_id,
/// team_task_id)`, migration 0016). Returns archived rows too.
pub async fn get_team_card(
    pool: &SqlitePool,
    board_id: &str,
    team_task_id: &str,
) -> sqlx::Result<Option<Issue>> {
    sqlx::query_as::<_, Issue>(
        "SELECT * FROM issues
         WHERE board_id = ? AND team_task_id = ? AND deleted IS NULL",
    )
    .bind(board_id)
    .bind(team_task_id)
    .fetch_optional(pool)
    .await
}

/// Hard-delete a card by id (its comments/acceptance/links/tags CASCADE). Used by
/// the team reconcile to remove a team card whose on-disk task disappeared — a
/// soft delete would leave a dangling `team_task_id` row that re-collides on the
/// unique index if the task id is ever reused. Returns false if not found.
pub async fn hard_delete(pool: &SqlitePool, id: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM issues WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Fetch one non-deleted issue by id.
pub async fn get_issue(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Issue>> {
    sqlx::query_as::<_, Issue>("SELECT * FROM issues WHERE id = ? AND deleted IS NULL")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// The non-deleted issue a session currently OWNS in the `doing` column, if any
/// (`WHERE session = <name> AND status = 'doing'`). Two consumers share it:
///   - the agent→board hook scope rule: an agent may only mutate the issue
///     linked to its OWN session and currently in `doing` (its active task);
///   - the session→board reaction: resolves "the issue linked to this session"
///     for the idle/waiting side-effects.
/// Strict `status = 'doing'` is the correct tight scope for both — an agent
/// can't touch an issue it already finished, and the reaction only fires on the
/// active task. If a session somehow owns more than one `doing` issue, the
/// most-recently-updated one wins (a single deterministic target).
pub async fn doing_issue_for_session(
    pool: &SqlitePool,
    session: &str,
) -> sqlx::Result<Option<Issue>> {
    sqlx::query_as::<_, Issue>(
        "SELECT * FROM issues
         WHERE session = ? AND status = 'doing' AND deleted IS NULL AND archived = 0
         ORDER BY updated DESC, id ASC
         LIMIT 1",
    )
    .bind(session)
    .fetch_optional(pool)
    .await
}

/// Fetch one issue by id INCLUDING archived (but not hard-deleted) rows. Used by
/// the restore path, which must find a discarded card that `get_issue` (which is
/// list-scoped and would still return archived rows) also returns — kept as a
/// distinct, explicit name so callers signal intent. Returns None for a
/// hard-deleted or unknown id.
pub async fn get_issue_any(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Issue>> {
    // `get_issue` already returns archived rows (it only filters `deleted`), so
    // this is an alias for clarity at the call site.
    get_issue(pool, id).await
}

/// Every non-deleted issue linked to a session (any status). Used by the
/// lifecycle paths (archive/unarchive/stop/delete) to decide whether a session
/// change should re-publish the board. Cheap — indexed by `idx_issues_session`.
pub async fn issues_for_session(pool: &SqlitePool, session: &str) -> sqlx::Result<Vec<Issue>> {
    sqlx::query_as::<_, Issue>(
        "SELECT * FROM issues WHERE session = ? AND deleted IS NULL",
    )
    .bind(session)
    .fetch_all(pool)
    .await
}

/// Issues with a `due` date set (for the iCal feed).
pub async fn issues_with_due(pool: &SqlitePool) -> sqlx::Result<Vec<Issue>> {
    sqlx::query_as::<_, Issue>(
        "SELECT * FROM issues WHERE deleted IS NULL AND archived = 0 AND due IS NOT NULL AND due != ''
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
    /// Which board the new card lands on (migration 0015). Defaults to
    /// `main` at the API layer when the client doesn't scope a board.
    pub board_id: String,
    /// Stable backlink to the on-disk team task this card mirrors (migration
    /// 0016). `None` for an ordinary card; the team watcher sets it so the
    /// read-through mirror can upsert on `(board_id, team_task_id)`.
    pub team_task_id: Option<String>,
}

/// Insert a new issue row. `created`/`updated` are set to now.
pub async fn insert_issue(pool: &SqlitePool, i: &NewIssue) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO issues
            (id, title, desc, status, session, creator, due, due_time,
             created, updated, owner_type, pinned, pos, notified, board_id,
             team_task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
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
    .bind(&i.board_id)
    .bind(&i.team_task_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// The smallest `pos` in `status` SCOPED to one board (migration 0015) — so a new
/// card lands at the top of its lane within its OWN board, not above another
/// board's cards. New cards get `min_pos - 1024.0`.
pub async fn min_pos_in_board_status(
    pool: &SqlitePool,
    board_id: &str,
    status: &str,
) -> sqlx::Result<f64> {
    let min: Option<f64> = sqlx::query_scalar(
        "SELECT MIN(pos) FROM issues
         WHERE board_id = ? AND status = ? AND deleted IS NULL",
    )
    .bind(board_id)
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
    /// "needs review" flag (idle side-effect). 0/1.
    NeedsReview(i64),
    /// "awaiting input" flag (sustained-waiting side-effect). 0/1.
    AwaitingInput(i64),
    /// Soft discard flag (migration 0013). 1 = archived/hidden, 0 = restored.
    Archived(i64),
    /// Move a card to a different board (migration 0015). The board must
    /// exist (FK); the API guards this.
    BoardId(String),
    /// Set/clear the on-disk team-task backlink (migration 0016). `None`
    /// detaches the card from its mirror; `Some(id)` links it (unique per board).
    TeamTaskId(Option<String>),
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
            IssueField::NeedsReview(v) => bind_set_i64(&mut tx, "needs_review", *v, id).await?,
            IssueField::AwaitingInput(v) => {
                bind_set_i64(&mut tx, "awaiting_input", *v, id).await?
            }
            IssueField::Archived(v) => bind_set_i64(&mut tx, "archived", *v, id).await?,
            IssueField::BoardId(v) => bind_set(&mut tx, "board_id", v, id).await?,
            IssueField::TeamTaskId(v) => {
                bind_set_opt(&mut tx, "team_task_id", v.as_deref(), id).await?
            }
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
/// issues (the API returns `{ok, remaining}`).
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

/// Aggregate done-status for a tag (`tag-completion`). Returns `(total, done)`
/// over non-deleted issues carrying `tag`.
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

// ── comments / acceptance / links (board↔agent foundation, migration 0010) ─────

/// A row of the `issue_comments` table (the per-issue activity stream).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct IssueComment {
    pub id: i64,
    pub issue_id: String,
    /// `'agent:<session>'` | `'user'` | `'human:<name>'`.
    pub author: String,
    pub body: String,
    pub created: i64,
}

/// A row of the `acceptance_items` table (the editable/tickable checklist).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct AcceptanceItem {
    pub id: i64,
    pub issue_id: String,
    pub body: String,
    /// 0/1 — kept as `i64` to mirror the rest of the board's SQLite booleans.
    pub done: i64,
    pub pos: f64,
}

/// A row of the `issue_links` table (PR/commit refs attached to an issue).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct IssueLink {
    pub id: i64,
    pub issue_id: String,
    /// `'pr'` | `'commit'` (CHECK-constrained at the schema level).
    pub kind: String,
    /// A URL (for `pr`) or a sha (for `commit`).
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub label: String,
    pub created: i64,
}

// comments ──────────────────────────────────────────────────────────────────

/// Append a comment to an issue. `created` is set to now. Returns the new row id.
pub async fn insert_comment(
    pool: &SqlitePool,
    issue_id: &str,
    author: &str,
    body: &str,
) -> sqlx::Result<i64> {
    let now = chrono::Utc::now().timestamp();
    let res = sqlx::query(
        "INSERT INTO issue_comments (issue_id, author, body, created) VALUES (?, ?, ?, ?)",
    )
    .bind(issue_id)
    .bind(author)
    .bind(body)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

/// Comments for one issue, oldest-first (stream order; index `(issue_id, id)`).
pub async fn comments_for(pool: &SqlitePool, issue_id: &str) -> sqlx::Result<Vec<IssueComment>> {
    sqlx::query_as::<_, IssueComment>(
        "SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY id ASC",
    )
    .bind(issue_id)
    .fetch_all(pool)
    .await
}

// acceptance items ────────────────────────────────────────────────────────────

/// Append an acceptance item to an issue at the end of its list (max(pos)+1).
/// Returns the new row id.
pub async fn insert_acceptance(
    pool: &SqlitePool,
    issue_id: &str,
    body: &str,
) -> sqlx::Result<i64> {
    let next_pos: f64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(pos) + 1.0, 0.0) FROM acceptance_items WHERE issue_id = ?",
    )
    .bind(issue_id)
    .fetch_one(pool)
    .await?;
    let res = sqlx::query(
        "INSERT INTO acceptance_items (issue_id, body, done, pos) VALUES (?, ?, 0, ?)",
    )
    .bind(issue_id)
    .bind(body)
    .bind(next_pos)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

/// Acceptance items for one issue, in checklist (`pos`) order.
pub async fn acceptance_for(
    pool: &SqlitePool,
    issue_id: &str,
) -> sqlx::Result<Vec<AcceptanceItem>> {
    sqlx::query_as::<_, AcceptanceItem>(
        "SELECT * FROM acceptance_items WHERE issue_id = ? ORDER BY pos ASC, id ASC",
    )
    .bind(issue_id)
    .fetch_all(pool)
    .await
}

/// Tick/untick one acceptance item by id. Returns false if the id does not exist.
pub async fn toggle_acceptance(
    pool: &SqlitePool,
    item_id: i64,
    done: bool,
) -> sqlx::Result<bool> {
    let res = sqlx::query("UPDATE acceptance_items SET done = ? WHERE id = ?")
        .bind(done as i64)
        .bind(item_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Edit one acceptance item's `body`. Returns false if the id does not exist.
pub async fn update_acceptance_body(
    pool: &SqlitePool,
    item_id: i64,
    body: &str,
) -> sqlx::Result<bool> {
    let res = sqlx::query("UPDATE acceptance_items SET body = ? WHERE id = ?")
        .bind(body)
        .bind(item_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Delete one acceptance item by id. Returns false if the id does not exist.
pub async fn delete_acceptance(pool: &SqlitePool, item_id: i64) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM acceptance_items WHERE id = ?")
        .bind(item_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Reorder an issue's acceptance items to the given id order: each listed id gets
/// `pos` = its index. Unlisted items keep their existing `pos`. Done in one
/// transaction. Ids that do not belong to `issue_id` are skipped.
pub async fn reorder_acceptance(
    pool: &SqlitePool,
    issue_id: &str,
    order: &[i64],
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    for (pos, item_id) in order.iter().enumerate() {
        sqlx::query("UPDATE acceptance_items SET pos = ? WHERE id = ? AND issue_id = ?")
            .bind(pos as f64)
            .bind(item_id)
            .bind(issue_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

/// Fetch one acceptance item by id (used by the agent hook to verify ownership).
pub async fn get_acceptance(
    pool: &SqlitePool,
    item_id: i64,
) -> sqlx::Result<Option<AcceptanceItem>> {
    sqlx::query_as::<_, AcceptanceItem>("SELECT * FROM acceptance_items WHERE id = ?")
        .bind(item_id)
        .fetch_optional(pool)
        .await
}

// links ───────────────────────────────────────────────────────────────────────

/// Attach a PR/commit ref to an issue. `created` is set to now. Returns the new
/// row id. `kind` must be `'pr'` or `'commit'` (enforced by the schema CHECK).
pub async fn insert_link(
    pool: &SqlitePool,
    issue_id: &str,
    kind: &str,
    r#ref: &str,
    label: &str,
) -> sqlx::Result<i64> {
    let now = chrono::Utc::now().timestamp();
    let res = sqlx::query(
        "INSERT INTO issue_links (issue_id, kind, ref, label, created) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(issue_id)
    .bind(kind)
    .bind(r#ref)
    .bind(label)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

/// Links for one issue, oldest-first (index `(issue_id, id)`).
pub async fn links_for(pool: &SqlitePool, issue_id: &str) -> sqlx::Result<Vec<IssueLink>> {
    sqlx::query_as::<_, IssueLink>("SELECT * FROM issue_links WHERE issue_id = ? ORDER BY id ASC")
        .bind(issue_id)
        .fetch_all(pool)
        .await
}

/// Delete one link by id. Returns false if the id does not exist.
pub async fn delete_link(pool: &SqlitePool, link_id: i64) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM issue_links WHERE id = ?")
        .bind(link_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

// batch loaders (avoid N+1 when building the whole board) ────────────────────

use std::collections::HashMap;

/// Load all comments for a set of issues in one query, grouped by `issue_id`.
/// Each group preserves stream order (oldest-first). Issues with no comments are
/// simply absent from the map (the caller defaults them to an empty vec).
pub async fn comments_for_issues(
    pool: &SqlitePool,
    ids: &[String],
) -> sqlx::Result<HashMap<String, Vec<IssueComment>>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = sql_placeholders(ids.len());
    let sql = format!(
        "SELECT * FROM issue_comments WHERE issue_id IN ({placeholders}) ORDER BY issue_id ASC, id ASC"
    );
    let mut q = sqlx::query_as::<_, IssueComment>(&sql);
    for id in ids {
        q = q.bind(id);
    }
    let rows = q.fetch_all(pool).await?;
    Ok(group_by(rows, |r| r.issue_id.clone()))
}

/// Load all acceptance items for a set of issues in one query, grouped by
/// `issue_id`. Each group is in checklist (`pos`) order.
pub async fn acceptance_for_issues(
    pool: &SqlitePool,
    ids: &[String],
) -> sqlx::Result<HashMap<String, Vec<AcceptanceItem>>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = sql_placeholders(ids.len());
    let sql = format!(
        "SELECT * FROM acceptance_items WHERE issue_id IN ({placeholders}) \
         ORDER BY issue_id ASC, pos ASC, id ASC"
    );
    let mut q = sqlx::query_as::<_, AcceptanceItem>(&sql);
    for id in ids {
        q = q.bind(id);
    }
    let rows = q.fetch_all(pool).await?;
    Ok(group_by(rows, |r| r.issue_id.clone()))
}

/// Load all links for a set of issues in one query, grouped by `issue_id`. Each
/// group is oldest-first.
pub async fn links_for_issues(
    pool: &SqlitePool,
    ids: &[String],
) -> sqlx::Result<HashMap<String, Vec<IssueLink>>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = sql_placeholders(ids.len());
    let sql = format!(
        "SELECT * FROM issue_links WHERE issue_id IN ({placeholders}) ORDER BY issue_id ASC, id ASC"
    );
    let mut q = sqlx::query_as::<_, IssueLink>(&sql);
    for id in ids {
        q = q.bind(id);
    }
    let rows = q.fetch_all(pool).await?;
    Ok(group_by(rows, |r| r.issue_id.clone()))
}

/// `?, ?, …` — `n` bound placeholders for an `IN (…)` clause.
fn sql_placeholders(n: usize) -> String {
    std::iter::repeat("?").take(n).collect::<Vec<_>>().join(", ")
}

/// Group rows into a `HashMap` by a key extracted from each row, preserving the
/// query's row order within each group.
fn group_by<T, F>(rows: Vec<T>, key: F) -> HashMap<String, Vec<T>>
where
    F: Fn(&T) -> String,
{
    let mut map: HashMap<String, Vec<T>> = HashMap::new();
    for row in rows {
        map.entry(key(&row)).or_default().push(row);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    /// Fresh on-disk pool with all migrations applied (mirrors db::tests).
    async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-board-test-{}", uuid::Uuid::new_v4()));
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
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (pool, dir)
    }

    /// Seed a bare agent-owned issue (no session → no FK requirement).
    async fn seed_issue(pool: &SqlitePool, id: &str) {
        insert_issue(
            pool,
            &NewIssue {
                id: id.to_string(),
                title: format!("issue {id}"),
                desc: String::new(),
                status: "todo".into(),
                session: None,
                creator: String::new(),
                due: None,
                due_time: None,
                owner_type: "agent".into(),
                pos: 0.0,
                notified: 0,
                board_id: "main".into(),
                team_task_id: None,
            },
        )
        .await
        .expect("insert issue");
    }

    #[tokio::test]
    async fn comment_insert_list_roundtrip() {
        let (pool, dir) = test_pool().await;
        seed_issue(&pool, "T-1").await;

        assert!(comments_for(&pool, "T-1").await.unwrap().is_empty());

        let id1 = insert_comment(&pool, "T-1", "agent:worker-2", "first").await.unwrap();
        let id2 = insert_comment(&pool, "T-1", "user", "second").await.unwrap();
        assert!(id2 > id1, "ids are monotonically increasing");

        let listed = comments_for(&pool, "T-1").await.unwrap();
        assert_eq!(listed.len(), 2);
        // Oldest-first stream order.
        assert_eq!(listed[0].body, "first");
        assert_eq!(listed[0].author, "agent:worker-2");
        assert_eq!(listed[1].body, "second");

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn acceptance_insert_list_toggle() {
        let (pool, dir) = test_pool().await;
        seed_issue(&pool, "T-1").await;

        let a = insert_acceptance(&pool, "T-1", "compiles").await.unwrap();
        let _b = insert_acceptance(&pool, "T-1", "tests pass").await.unwrap();

        let items = acceptance_for(&pool, "T-1").await.unwrap();
        assert_eq!(items.len(), 2);
        // pos order; appended item sits after.
        assert_eq!(items[0].body, "compiles");
        assert_eq!(items[1].body, "tests pass");
        assert_eq!(items[0].done, 0);
        assert!(items[0].pos < items[1].pos, "appended item gets a larger pos");

        assert!(toggle_acceptance(&pool, a, true).await.unwrap());
        let items = acceptance_for(&pool, "T-1").await.unwrap();
        assert_eq!(items[0].done, 1, "first item now ticked");

        assert!(toggle_acceptance(&pool, a, false).await.unwrap());
        let items = acceptance_for(&pool, "T-1").await.unwrap();
        assert_eq!(items[0].done, 0, "first item un-ticked");

        // Toggling a non-existent id is a no-op (returns false).
        assert!(!toggle_acceptance(&pool, 999_999, true).await.unwrap());

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn link_insert_list_and_kind_check() {
        let (pool, dir) = test_pool().await;
        seed_issue(&pool, "T-1").await;

        insert_link(&pool, "T-1", "pr", "https://example/pr/1", "PR #1").await.unwrap();
        insert_link(&pool, "T-1", "commit", "deadbeef", "").await.unwrap();

        let links = links_for(&pool, "T-1").await.unwrap();
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].kind, "pr");
        assert_eq!(links[0].r#ref, "https://example/pr/1");
        assert_eq!(links[0].label, "PR #1");
        assert_eq!(links[1].kind, "commit");
        assert_eq!(links[1].r#ref, "deadbeef");

        // The schema CHECK rejects an unknown kind.
        let bad = insert_link(&pool, "T-1", "bogus", "x", "").await;
        assert!(bad.is_err(), "CHECK(kind IN ('pr','commit')) must reject 'bogus'");

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn cascade_delete_clears_relations() {
        let (pool, dir) = test_pool().await;
        seed_issue(&pool, "T-1").await;
        insert_comment(&pool, "T-1", "user", "hi").await.unwrap();
        insert_acceptance(&pool, "T-1", "do it").await.unwrap();
        insert_link(&pool, "T-1", "pr", "url", "").await.unwrap();

        // Hard-delete the issue → ON DELETE CASCADE removes all three relations.
        sqlx::query("DELETE FROM issues WHERE id = ?")
            .bind("T-1")
            .execute(&pool)
            .await
            .unwrap();

        assert!(comments_for(&pool, "T-1").await.unwrap().is_empty());
        assert!(acceptance_for(&pool, "T-1").await.unwrap().is_empty());
        assert!(links_for(&pool, "T-1").await.unwrap().is_empty());

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn migration_0013_relocations_preserve_every_card() {
        // The 0013 relocation rules leave only todo/doing/done, relocate
        // backlog/review/discarded, and never lose a card row.
        //
        // A fresh test DB has already run 0013, so legacy columns are gone. We
        // simulate a PRE-0013 seeded DB by inserting raw rows in the legacy
        // columns (the issues table has no status CHECK), then apply the SAME
        // relocation statements 0013 runs and assert the outcome — proving the
        // migration's SQL logic against seeded data.
        let (pool, dir) = test_pool().await;

        // Seed one card in each legacy + custom column, plus a survivor, via raw
        // SQL so we can use the removed status ids. Mark a couple of fields we can
        // assert survived (owner_type=human → agent; review → needs_review=1).
        let now = chrono::Utc::now().timestamp();
        for (id, status, owner) in [
            ("L-backlog", "backlog", "human"),
            ("L-review", "review", "agent"),
            ("L-discarded", "discarded", "human"),
            ("L-custom", "my-custom-col", "agent"),
            ("L-todo", "todo", "human"),
            ("L-done", "done", "agent"),
        ] {
            sqlx::query(
                "INSERT INTO issues (id, title, desc, status, creator, created, updated,
                                     owner_type, pinned, pos, notified, needs_review,
                                     awaiting_input, archived)
                 VALUES (?, ?, '', ?, '', ?, ?, ?, 0, 0, 0, 0, 0, 0)",
            )
            .bind(id)
            .bind(format!("issue {id}"))
            .bind(status)
            .bind(now)
            .bind(now)
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        }
        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM issues")
            .fetch_one(&pool)
            .await
            .unwrap();

        // Apply the 0013 relocation statements verbatim.
        sqlx::query("UPDATE issues SET status = 'todo' WHERE status = 'backlog'")
            .execute(&pool).await.unwrap();
        sqlx::query("UPDATE issues SET status = 'doing', needs_review = 1 WHERE status = 'review'")
            .execute(&pool).await.unwrap();
        sqlx::query("UPDATE issues SET archived = 1, status = 'todo' WHERE status = 'discarded'")
            .execute(&pool).await.unwrap();
        sqlx::query("UPDATE issues SET status = 'todo' WHERE status NOT IN ('todo','doing','done')")
            .execute(&pool).await.unwrap();
        sqlx::query("UPDATE issues SET owner_type = 'agent' WHERE owner_type = 'human'")
            .execute(&pool).await.unwrap();

        // No row lost.
        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM issues")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(before, after, "no card row deleted by the relocation");

        let by_id = |id: &str| {
            let pool = pool.clone();
            let id = id.to_string();
            async move {
                sqlx::query_as::<_, Issue>("SELECT * FROM issues WHERE id = ?")
                    .bind(&id)
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };

        // backlog → todo.
        assert_eq!(by_id("L-backlog").await.status, "todo");
        // review → doing + needs_review = 1.
        let rev = by_id("L-review").await;
        assert_eq!(rev.status, "doing");
        assert_eq!(rev.needs_review, 1);
        // discarded → archived + parked in todo (row preserved).
        let disc = by_id("L-discarded").await;
        assert_eq!(disc.archived, 1, "discarded becomes archived, not deleted");
        assert_eq!(disc.status, "todo");
        // custom column → folded into todo.
        assert_eq!(by_id("L-custom").await.status, "todo");
        // survivors keep their lane.
        assert_eq!(by_id("L-todo").await.status, "todo");
        assert_eq!(by_id("L-done").await.status, "done");
        // every human row became agent.
        let humans: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM issues WHERE owner_type = 'human'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(humans, 0, "no human-owned card remains");

        // Only the three lanes have cards now.
        let lanes: Vec<String> =
            sqlx::query_scalar("SELECT DISTINCT status FROM issues ORDER BY status")
                .fetch_all(&pool)
                .await
                .unwrap();
        for lane in &lanes {
            assert!(
                ["todo", "doing", "done"].contains(&lane.as_str()),
                "unexpected lane after relocation: {lane}"
            );
        }

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn batch_loaders_group_by_issue() {
        let (pool, dir) = test_pool().await;
        seed_issue(&pool, "T-1").await;
        seed_issue(&pool, "T-2").await;
        seed_issue(&pool, "T-3").await; // no relations → absent from every map.

        insert_comment(&pool, "T-1", "user", "c1a").await.unwrap();
        insert_comment(&pool, "T-1", "user", "c1b").await.unwrap();
        insert_comment(&pool, "T-2", "user", "c2a").await.unwrap();
        insert_acceptance(&pool, "T-1", "a1").await.unwrap();
        insert_link(&pool, "T-2", "pr", "u", "").await.unwrap();

        let ids = vec!["T-1".to_string(), "T-2".to_string(), "T-3".to_string()];

        let comments = comments_for_issues(&pool, &ids).await.unwrap();
        assert_eq!(comments.get("T-1").map(|v| v.len()), Some(2));
        assert_eq!(comments.get("T-2").map(|v| v.len()), Some(1));
        assert!(comments.get("T-3").is_none(), "no comments → absent (defaults to empty)");
        // Within-group order preserved.
        assert_eq!(comments["T-1"][0].body, "c1a");
        assert_eq!(comments["T-1"][1].body, "c1b");

        let acceptance = acceptance_for_issues(&pool, &ids).await.unwrap();
        assert_eq!(acceptance.get("T-1").map(|v| v.len()), Some(1));
        assert!(acceptance.get("T-2").is_none());

        let links = links_for_issues(&pool, &ids).await.unwrap();
        assert_eq!(links.get("T-2").map(|v| v.len()), Some(1));
        assert!(links.get("T-1").is_none());

        // Empty id slice short-circuits to an empty map (no malformed SQL).
        assert!(comments_for_issues(&pool, &[]).await.unwrap().is_empty());

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Archived cards must drop out of the iCal feed exactly as they drop out
    /// of the board UI — the feed is unauthenticated (URL-secret behind
    /// Tailscale) so soft-discarded cards must not leak through it.
    #[tokio::test]
    async fn issues_with_due_excludes_archived() {
        let (pool, dir) = test_pool().await;
        seed_issue(&pool, "T-live").await;
        seed_issue(&pool, "T-archived").await;
        // Both get a due date; only the live one should surface.
        sqlx::query("UPDATE issues SET due = '2026-06-01' WHERE id = ?")
            .bind("T-live").execute(&pool).await.unwrap();
        sqlx::query("UPDATE issues SET due = '2026-06-02', archived = 1 WHERE id = ?")
            .bind("T-archived").execute(&pool).await.unwrap();

        let rows = issues_with_due(&pool).await.unwrap();
        assert_eq!(rows.len(), 1, "archived card must not appear in the iCal feed");
        assert_eq!(rows[0].id, "T-live");

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

//! Boards row access (migration 0015 `boards`). Multi-board model (AT-C, plan
//! §5.5): the single Kanban board became MULTIPLE boards selectable via a
//! switcher. Each board owns its own cards (`issues.board_id`).
//!
//! Runtime-checked queries — see the note in [`super::sessions`]. Higher-level
//! orchestration (validation, the HTTP envelope, the "main is fixed" rule) lives
//! in [`crate::board::boards`]; this module is the typed SQL surface only.

use serde::Serialize;
use sqlx::SqlitePool;

/// The fixed user board's id. It is the only `kind='main'` board, seeded by
/// migration 0015, and is non-deletable / non-renameable (enforced in the API).
pub const MAIN_BOARD_ID: &str = "main";

/// A row of the `boards` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Board {
    pub id: String,
    pub name: String,
    /// `'main'` (the fixed user board) or `'team'` (one per Claude Code team).
    pub kind: String,
    /// The on-disk team id (`~/.claude/teams/{team}/`) for a `kind='team'` board;
    /// `None` for the main board.
    pub team_name: Option<String>,
    pub created_at: i64,
    pub position: f64,
}

/// List every board in switcher order (main pinned first via position 0, then
/// team boards by position then created_at then id for a stable tiebreak).
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Board>> {
    sqlx::query_as::<_, Board>(
        "SELECT * FROM boards ORDER BY position ASC, created_at ASC, id ASC",
    )
    .fetch_all(pool)
    .await
}

/// Fetch one board by id (or None).
pub async fn get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Board>> {
    sqlx::query_as::<_, Board>("SELECT * FROM boards WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// Fetch the board registered for a given on-disk team (or None). The lookup key
/// AT-D/AT-F3 use to find a team's existing board before populating it.
pub async fn get_by_team(pool: &SqlitePool, team_name: &str) -> sqlx::Result<Option<Board>> {
    sqlx::query_as::<_, Board>("SELECT * FROM boards WHERE team_name = ?")
        .bind(team_name)
        .fetch_optional(pool)
        .await
}

/// Does a board with this id exist? (Cheap existence probe for the FK guard.)
pub async fn exists(pool: &SqlitePool, id: &str) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM boards WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(n > 0)
}

/// Insert a board. `created_at` is set to now. Used by the create-board and the
/// register-team-board paths. The caller owns id allocation + uniqueness checks
/// (the API rejects a duplicate id / a second `team_name` before calling).
pub async fn insert(
    pool: &SqlitePool,
    id: &str,
    name: &str,
    kind: &str,
    team_name: Option<&str>,
    position: f64,
) -> sqlx::Result<Board> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO boards (id, name, kind, team_name, created_at, position)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(kind)
    .bind(team_name)
    .bind(now)
    .bind(position)
    .execute(pool)
    .await?;
    Ok(Board {
        id: id.to_string(),
        name: name.to_string(),
        kind: kind.to_string(),
        team_name: team_name.map(str::to_string),
        created_at: now,
        position,
    })
}

/// Rename a board's display label. Returns false if the id does not exist. The
/// API blocks this for the main board.
pub async fn rename(pool: &SqlitePool, id: &str, name: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("UPDATE boards SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Delete a board. Its cards CASCADE-delete (FK `issues.board_id ... ON DELETE
/// CASCADE`). Returns false if the id does not exist. The API blocks this for
/// the main board.
pub async fn delete(pool: &SqlitePool, id: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM boards WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// The largest `position` currently in use (for appending a new board after the
/// last). Returns 0.0 for an (impossible — main is always seeded) empty table.
pub async fn max_position(pool: &SqlitePool) -> sqlx::Result<f64> {
    let max: Option<f64> = sqlx::query_scalar("SELECT MAX(position) FROM boards")
        .fetch_optional(pool)
        .await?
        .flatten();
    Ok(max.unwrap_or(0.0))
}

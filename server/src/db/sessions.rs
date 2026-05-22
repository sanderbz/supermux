//! Session row access (TECH_PLAN §3.3 `sessions` + `session_runtime`).
//!
//! Queries are runtime-checked (`sqlx::query_as::<_, T>`) rather than the
//! compile-time `query_as!` macro: the macro requires a live `DATABASE_URL` (or
//! a committed `.sqlx` offline cache) at build time, which would make the
//! orchestrator's hermetic `cargo build`/`cargo test` non-deterministic and add
//! a hidden coupling for every downstream milestone that adds a query. The
//! `FromRow` structs still give us typed rows.

use serde::Serialize;
use sqlx::SqlitePool;

/// A row of the `sessions` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Session {
    pub name: String,
    pub dir: String,
    pub desc: String,
    pub provider: String,
    pub flags: String,
    pub pinned: i64,
    pub archived: i64,
    pub auto_continue: i64,
    pub auto_continue_msg: String,
    pub rate_limit_resume_text: String,
    pub tags: String,
    pub creator: String,
    pub branch: String,
    pub worktree: i64,
    pub worktree_repo: String,
    pub mcp: String,
    pub created_at: i64,
    pub start_count: i64,
    pub last_started: i64,
    pub last_send: i64,
    pub last_send_text: String,
    pub task_summary: String,
    pub cc_session_name: String,
    pub cc_conversation_id: String,
    pub codex_session_id: String,
    pub start_error: String,
}

/// A row of the `session_runtime` table (ephemeral, persisted across restarts).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct SessionRuntime {
    pub name: String,
    pub rate_limit_reset_at: i64,
    pub hibernated: i64,
    pub restarting: i64,
    pub last_claude_alive_pid: i64,
    pub last_status: String,
    pub last_status_at: i64,
    pub last_capture: String,
    /// Per-session hook auth token (§6.5). Never the dashboard bearer.
    pub hook_token: String,
}

/// List active (non-archived) sessions in the overview sort order.
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Session>> {
    sqlx::query_as::<_, Session>(
        "SELECT * FROM sessions WHERE archived = 0 ORDER BY pinned DESC, last_send DESC, name ASC",
    )
    .fetch_all(pool)
    .await
}

/// Fetch one session by name.
pub async fn get(pool: &SqlitePool, name: &str) -> sqlx::Result<Option<Session>> {
    sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await
}

/// Fetch a session's runtime row.
pub async fn runtime(pool: &SqlitePool, name: &str) -> sqlx::Result<Option<SessionRuntime>> {
    sqlx::query_as::<_, SessionRuntime>("SELECT * FROM session_runtime WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await
}

/// Insert a minimal session row (used by tests and as a building block for the
/// full `sessions::create` landing in M2). `created_at` is set to now.
pub async fn insert_minimal(
    pool: &SqlitePool,
    name: &str,
    dir: &str,
    provider: &str,
) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("INSERT INTO sessions (name, dir, provider, created_at) VALUES (?, ?, ?, ?)")
        .bind(name)
        .bind(dir)
        .bind(provider)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(())
}

/// Create or refresh the runtime row for `name`, storing `hook_token`.
pub async fn ensure_runtime(
    pool: &SqlitePool,
    name: &str,
    hook_token: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO session_runtime (name, hook_token) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET hook_token = excluded.hook_token",
    )
    .bind(name)
    .bind(hook_token)
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete a session. `session_runtime` and child rows cascade via FK.
pub async fn delete(pool: &SqlitePool, name: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM sessions WHERE name = ?")
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

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

/// All runtime rows, fetched once so [`list`] can join in-memory instead of an
/// N+1 per-session lookup.
pub async fn list_runtimes(pool: &SqlitePool) -> sqlx::Result<Vec<SessionRuntime>> {
    sqlx::query_as::<_, SessionRuntime>("SELECT * FROM session_runtime")
        .fetch_all(pool)
        .await
}

/// Does a session row exist? Used for clean 404/409 mapping before mutating.
pub async fn exists(pool: &SqlitePool, name: &str) -> sqlx::Result<bool> {
    let row = sqlx::query("SELECT 1 FROM sessions WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

/// Config fields for a brand-new session (the tmux-free create path, M2). Runtime
/// counters and timestamps default to 0; `created_at` is set by [`create`].
#[derive(Debug, Clone)]
pub struct NewSession {
    pub name: String,
    pub dir: String,
    pub desc: String,
    pub provider: String,
    pub creator: String,
    pub flags: String,
    /// JSON-array string (the `tags` column is a JSON array, §3.3).
    pub tags: String,
    pub branch: String,
    pub mcp: String,
    pub worktree: bool,
    pub worktree_repo: String,
}

/// Insert a full session config row. `created_at` is set to now.
pub async fn create(pool: &SqlitePool, s: &NewSession) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO sessions
            (name, dir, desc, provider, creator, flags, tags, branch, mcp,
             worktree, worktree_repo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&s.name)
    .bind(&s.dir)
    .bind(&s.desc)
    .bind(&s.provider)
    .bind(&s.creator)
    .bind(&s.flags)
    .bind(&s.tags)
    .bind(&s.branch)
    .bind(&s.mcp)
    .bind(s.worktree as i64)
    .bind(&s.worktree_repo)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Copy a session's CONFIG (not its runtime/counters) under `new_name`. Pinned
/// is reset and `created_at` refreshed; the caller seeds a fresh runtime row.
pub async fn duplicate(pool: &SqlitePool, src: &str, new_name: &str) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO sessions
            (name, dir, desc, provider, flags, pinned, auto_continue, auto_continue_msg,
             rate_limit_resume_text, tags, creator, branch, worktree, worktree_repo, mcp,
             created_at)
         SELECT ?, dir, desc, provider, flags, 0, auto_continue, auto_continue_msg,
                rate_limit_resume_text, tags, creator, branch, worktree, worktree_repo, mcp,
                ?
         FROM sessions WHERE name = ?",
    )
    .bind(new_name)
    .bind(now)
    .bind(src)
    .execute(pool)
    .await?;
    Ok(())
}

/// Rename a session (its name is the PK and is referenced by several child
/// tables). Done in one transaction with `defer_foreign_keys` so the parent PK
/// and every child FK are updated atomically and only re-checked at COMMIT —
/// otherwise the immediate FK check would reject the parent update.
pub async fn rename(pool: &SqlitePool, old: &str, new: &str) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE sessions SET name = ? WHERE name = ?")
        .bind(new)
        .bind(old)
        .execute(&mut *tx)
        .await?;
    for stmt in [
        "UPDATE session_runtime SET name = ? WHERE name = ?",
        "UPDATE tracked_files SET session = ? WHERE session = ?",
        "UPDATE steering_queue SET session = ? WHERE session = ?",
        "UPDATE issues SET session = ? WHERE session = ?",
        "UPDATE delegations SET from_session = ? WHERE from_session = ?",
        "UPDATE delegations SET to_session = ? WHERE to_session = ?",
        "UPDATE share_tokens SET session = ? WHERE session = ?",
    ] {
        sqlx::query(stmt)
            .bind(new)
            .bind(old)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Set the human description.
pub async fn set_desc(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "desc", value).await
}
/// Set the work directory.
pub async fn set_dir(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "dir", value).await
}
/// Set the git branch label.
pub async fn set_branch(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "branch", value).await
}
/// Set the MCP selection (`''` or `'chrome'`).
pub async fn set_mcp(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "mcp", value).await
}
/// Set the tags column (JSON-array string).
pub async fn set_tags(pool: &SqlitePool, name: &str, json: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "tags", json).await
}

/// Internal: set one whitelisted TEXT column. The column name comes ONLY from the
/// fixed setters above (never user input), so the inlined identifier is safe.
async fn set_text_field(
    pool: &SqlitePool,
    name: &str,
    column: &str,
    value: &str,
) -> sqlx::Result<()> {
    let sql = format!("UPDATE sessions SET {column} = ? WHERE name = ?");
    sqlx::query(&sql)
        .bind(value)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Flip the pinned flag.
pub async fn toggle_pin(pool: &SqlitePool, name: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET pinned = 1 - pinned WHERE name = ?")
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Flip the auto-continue flag.
pub async fn toggle_auto_continue(pool: &SqlitePool, name: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET auto_continue = 1 - auto_continue WHERE name = ?")
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

// ── lifecycle mutations (M3) ──────────────────────────────────────────────────

/// Record a successful start: bump `start_count`, stamp `last_started = now`.
pub async fn bump_start(pool: &SqlitePool, name: &str) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE sessions SET start_count = start_count + 1, last_started = ? WHERE name = ?")
        .bind(now)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Record a send: stamp `last_send = now` and store the first 200 chars of text.
pub async fn set_last_send(pool: &SqlitePool, name: &str, text: &str) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    let preview: String = text.chars().take(200).collect();
    sqlx::query("UPDATE sessions SET last_send = ?, last_send_text = ? WHERE name = ?")
        .bind(now)
        .bind(preview)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Set the archived flag.
pub async fn set_archived(pool: &SqlitePool, name: &str, archived: bool) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET archived = ? WHERE name = ?")
        .bind(archived as i64)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Clear the Claude resume identifiers (used by the resume-picker fallback when
/// `--resume` gets stuck — §1.5 of feature-extract).
pub async fn clear_cc(pool: &SqlitePool, name: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET cc_session_name = '', cc_conversation_id = '' WHERE name = ?")
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Set the hibernated flag in `session_runtime` (cleared by `wake`).
pub async fn set_hibernated(pool: &SqlitePool, name: &str, hibernated: bool) -> sqlx::Result<()> {
    sqlx::query("UPDATE session_runtime SET hibernated = ? WHERE name = ?")
        .bind(hibernated as i64)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Write `session_runtime.last_capture` — the canonical tile-tail-preview source
/// (CEO #1). The M5a detector loop calls this EVERY 2s tick (classification or
/// not) with the last 30 lines of `capture-pane`, ANSI-stripped, so
/// `SessionView.preview_lines` always reflects the freshest pane content.
pub async fn set_last_capture(pool: &SqlitePool, name: &str, capture: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE session_runtime SET last_capture = ? WHERE name = ?")
        .bind(capture)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Set the live status + timestamp in `session_runtime`. The detector (M5) is the
/// usual writer; M3 sets `active`/`stopped` on start/stop so the API reflects the
/// lifecycle before the detector lands. Status must be a `last_status` CHECK value.
pub async fn set_last_status(pool: &SqlitePool, name: &str, status: &str) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "UPDATE session_runtime SET last_status = ?, last_status_at = ? WHERE name = ?",
    )
    .bind(status)
    .bind(now)
    .bind(name)
    .execute(pool)
    .await?;
    Ok(())
}

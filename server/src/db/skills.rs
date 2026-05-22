//! Skills row access (TECH_PLAN §3.3 `skills`, feature-extract §5.4; M9).
//!
//! Skills are markdown files persisted in the `skills` table and ALSO synced to
//! `~/.supermux/skills/<name>.md` and `~/.claude/commands/<name>.md` so Claude
//! sees them as native `/<name>` slash commands. This module owns only the DB
//! half; the filesystem sync lives in [`crate::agents::skills`].
//!
//! Runtime-checked queries — see the note in [`super::sessions`].

use serde::Serialize;
use sqlx::SqlitePool;

/// A row of the `skills` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Skill {
    pub name: String,
    pub content: String,
    pub updated: i64,
}

/// List all skills (name ascending).
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Skill>> {
    sqlx::query_as::<_, Skill>("SELECT name, content, updated FROM skills ORDER BY name ASC")
        .fetch_all(pool)
        .await
}

/// Fetch one skill by name.
pub async fn get(pool: &SqlitePool, name: &str) -> sqlx::Result<Option<Skill>> {
    sqlx::query_as::<_, Skill>("SELECT name, content, updated FROM skills WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await
}

/// Insert or replace a skill's content (idempotent create-or-update).
pub async fn upsert(pool: &SqlitePool, name: &str, content: &str) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO skills (name, content, updated) VALUES (?, ?, ?) \
         ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated = excluded.updated",
    )
    .bind(name)
    .bind(content)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete a skill; returns rows removed (0 if not found).
pub async fn delete(pool: &SqlitePool, name: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM skills WHERE name = ?")
        .bind(name)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

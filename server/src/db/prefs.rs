//! Prefs / snippets / kbd_groups row access (TECH_PLAN §3.3).
//!
//! M1 declared the structs; M9 attaches the CRUD queries used by the snippet
//! picker (§4.4.1) and the swipeable kbd accessory bar (§4.4.2). Runtime-checked
//! queries — see the note in [`super::sessions`].

use serde::Serialize;
use sqlx::SqlitePool;

/// A row of the `prefs` key/value table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Pref {
    pub key: String,
    pub value: String,
}

/// A row of the `snippets` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Snippet {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub position: i64,
    pub created: i64,
}

/// A row of the `kbd_groups` table (accessory-bar groups; table-backed, not a
/// prefs blob — resolves Codex contradiction E).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct KbdGroup {
    pub id: i64,
    pub name: String,
    /// JSON array `[{label,key}, …]`, length 4 (§3.3).
    pub keys: String,
    pub position: i64,
}

// ── prefs (key/value) ────────────────────────────────────────────────────────

/// Read a single pref value by key (returns `None` if unset).
pub async fn get_pref(pool: &SqlitePool, key: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM prefs WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(v,)| v))
}

/// Upsert a single pref. Idempotent — overwrites any prior value.
pub async fn put_pref(pool: &SqlitePool, key: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO prefs (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

/// The `prefs` key holding the global experimental "Agent Teams" toggle (AT-B).
/// Stored in the existing `prefs` k/v table so no migration is needed; value is
/// the literal string `"on"` (any other value, or an absent row, reads OFF).
/// Default OFF — Agent Teams is experimental AND carries the ~7× token cost of N
/// real Claude processes, so it must be opted into deliberately.
pub const AGENT_TEAMS_PREF_KEY: &str = "experimental.agent_teams";

/// Is the experimental Agent Teams feature ON? Reads [`AGENT_TEAMS_PREF_KEY`];
/// a missing/unparseable/`"off"` row reads OFF (the safe default). A DB error is
/// swallowed to OFF — the gate must FAIL CLOSED so a transient read failure can
/// never silently enable a ~7×-cost experimental feature.
pub async fn agent_teams_enabled(pool: &SqlitePool) -> bool {
    matches!(
        get_pref(pool, AGENT_TEAMS_PREF_KEY).await,
        Ok(Some(ref v)) if v.trim().eq_ignore_ascii_case("on")
    )
}

/// Set the experimental Agent Teams toggle. `on` → `"on"`, off → `"off"`.
pub async fn set_agent_teams_enabled(pool: &SqlitePool, on: bool) -> sqlx::Result<()> {
    put_pref(pool, AGENT_TEAMS_PREF_KEY, if on { "on" } else { "off" }).await
}

// ── snippets ─────────────────────────────────────────────────────────────────

/// List all snippets, ordered by `position` then insertion (`id`).
pub async fn list_snippets(pool: &SqlitePool) -> sqlx::Result<Vec<Snippet>> {
    sqlx::query_as::<_, Snippet>(
        "SELECT id, title, body, position, created FROM snippets ORDER BY position ASC, id ASC",
    )
    .fetch_all(pool)
    .await
}

/// Insert a snippet; returns the new row id.
pub async fn create_snippet(
    pool: &SqlitePool,
    title: &str,
    body: &str,
    position: i64,
) -> sqlx::Result<i64> {
    let now = chrono::Utc::now().timestamp();
    let res = sqlx::query(
        "INSERT INTO snippets (title, body, position, created) VALUES (?, ?, ?, ?)",
    )
    .bind(title)
    .bind(body)
    .bind(position)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

/// Patch a snippet's mutable fields (only the `Some` ones). Returns rows changed.
pub async fn update_snippet(
    pool: &SqlitePool,
    id: i64,
    title: Option<&str>,
    body: Option<&str>,
    position: Option<i64>,
) -> sqlx::Result<u64> {
    let mut affected = 0;
    if let Some(t) = title {
        affected += sqlx::query("UPDATE snippets SET title = ? WHERE id = ?")
            .bind(t)
            .bind(id)
            .execute(pool)
            .await?
            .rows_affected();
    }
    if let Some(b) = body {
        sqlx::query("UPDATE snippets SET body = ? WHERE id = ?")
            .bind(b)
            .bind(id)
            .execute(pool)
            .await?;
        affected = affected.max(1);
    }
    if let Some(p) = position {
        sqlx::query("UPDATE snippets SET position = ? WHERE id = ?")
            .bind(p)
            .bind(id)
            .execute(pool)
            .await?;
        affected = affected.max(1);
    }
    Ok(affected)
}

/// Delete a snippet; returns rows removed (0 if not found).
pub async fn delete_snippet(pool: &SqlitePool, id: i64) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM snippets WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

// ── kbd_groups ───────────────────────────────────────────────────────────────

/// List all accessory-bar groups, ordered by `position` then `id`.
pub async fn list_kbd_groups(pool: &SqlitePool) -> sqlx::Result<Vec<KbdGroup>> {
    sqlx::query_as::<_, KbdGroup>(
        "SELECT id, name, keys, position FROM kbd_groups ORDER BY position ASC, id ASC",
    )
    .fetch_all(pool)
    .await
}

/// Insert a group (`keys` is a pre-serialized JSON array string). Returns id.
pub async fn create_kbd_group(
    pool: &SqlitePool,
    name: &str,
    keys_json: &str,
    position: i64,
) -> sqlx::Result<i64> {
    let res = sqlx::query("INSERT INTO kbd_groups (name, keys, position) VALUES (?, ?, ?)")
        .bind(name)
        .bind(keys_json)
        .bind(position)
        .execute(pool)
        .await?;
    Ok(res.last_insert_rowid())
}

/// Patch a group's mutable fields (only the `Some` ones). Returns rows changed.
pub async fn update_kbd_group(
    pool: &SqlitePool,
    id: i64,
    name: Option<&str>,
    keys_json: Option<&str>,
    position: Option<i64>,
) -> sqlx::Result<u64> {
    let mut affected = 0;
    if let Some(n) = name {
        affected += sqlx::query("UPDATE kbd_groups SET name = ? WHERE id = ?")
            .bind(n)
            .bind(id)
            .execute(pool)
            .await?
            .rows_affected();
    }
    if let Some(k) = keys_json {
        sqlx::query("UPDATE kbd_groups SET keys = ? WHERE id = ?")
            .bind(k)
            .bind(id)
            .execute(pool)
            .await?;
        affected = affected.max(1);
    }
    if let Some(p) = position {
        sqlx::query("UPDATE kbd_groups SET position = ? WHERE id = ?")
            .bind(p)
            .bind(id)
            .execute(pool)
            .await?;
        affected = affected.max(1);
    }
    Ok(affected)
}

/// Replace the WHOLE ordered `kbd_groups` list in one transaction (M24b
/// integration fix — the M16 manage-sheet's reorder / add / remove collapse to
/// a single canonical PUT so the table is never left half-written). Each input
/// is `(name, keys_json)`; `position` is the slice index. The table is cleared
/// and re-inserted atomically — a failure rolls back to the prior state.
pub async fn replace_kbd_groups(
    pool: &SqlitePool,
    groups: &[(String, String)],
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM kbd_groups").execute(&mut *tx).await?;
    for (pos, (name, keys_json)) in groups.iter().enumerate() {
        sqlx::query("INSERT INTO kbd_groups (name, keys, position) VALUES (?, ?, ?)")
            .bind(name)
            .bind(keys_json)
            .bind(pos as i64)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

/// Delete a group; returns rows removed (0 if not found).
pub async fn delete_kbd_group(pool: &SqlitePool, id: i64) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM kbd_groups WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Count rows in `kbd_groups` (used to decide first-GET default seeding §M9).
pub async fn count_kbd_groups(pool: &SqlitePool) -> sqlx::Result<i64> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM kbd_groups")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

#[cfg(test)]
mod agent_teams_pref_tests {
    //! AT-B §3.1: the Agent-Teams gate MUST default OFF and fail closed — the
    //! whole cost-control guarantee rides on this. Pin the default + the
    //! round-trip.
    use super::*;
    use crate::config::Config;

    async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-teams-pref-{}", uuid::Uuid::new_v4()));
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

    #[tokio::test]
    async fn defaults_off_and_round_trips() {
        let (pool, dir) = test_pool().await;
        // Absent row → OFF (the safe default).
        assert!(!agent_teams_enabled(&pool).await, "default must be OFF");

        set_agent_teams_enabled(&pool, true).await.unwrap();
        assert!(agent_teams_enabled(&pool).await, "ON after enable");

        set_agent_teams_enabled(&pool, false).await.unwrap();
        assert!(!agent_teams_enabled(&pool).await, "OFF after disable");

        // A junk value reads OFF (fail closed).
        put_pref(&pool, AGENT_TEAMS_PREF_KEY, "maybe").await.unwrap();
        assert!(!agent_teams_enabled(&pool).await, "junk value reads OFF");

        // Case-insensitive "ON".
        put_pref(&pool, AGENT_TEAMS_PREF_KEY, "ON").await.unwrap();
        assert!(agent_teams_enabled(&pool).await, "ON is case-insensitive");

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

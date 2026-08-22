//! Connector store persistence: the `connectors` manifests, the
//! `session_connectors` grants (the per-agent scoping primitive), and the
//! encrypted `vault` rows (migration 0031).
//!
//! Like [`crate::db::sessions`], queries are runtime-checked
//! (`sqlx::query_as::<_, T>`) rather than the compile-time macro, so no live
//! `DATABASE_URL` / offline cache is needed at build time.
//!
//! Secret hygiene: the `vault` blob is opaque here (BLOBs in/out). Sealing +
//! opening happens in [`crate::vault`]; this module never sees plaintext.

use serde::Serialize;
use sqlx::SqlitePool;

/// The sentinel `session_name` in `session_connectors` meaning "all agents".
pub const ALL_AGENTS: &str = "*";

/// A row of the `connectors` table — one installed manifest. The `*_json` columns
/// are stored verbatim; parsing into the manifest model lives in
/// [`crate::connectors::manifest`].
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Connector {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub icon: String,
    pub description: String,
    pub tools_json: String,
    pub credentials_json: String,
    /// The `mcpServers` entry template with `${VAR}` placeholders. NEVER contains
    /// a raw secret — only placeholders that the vault fills at launch.
    pub emit_json: String,
    pub source_json: String,
    pub created_at: i64,
}

/// A row of the `session_connectors` table — one grant.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Grant {
    pub session_name: String,
    pub connector_id: String,
    /// `vault.id` of the secret to inject, or `None` for a no-secret connector.
    pub secret_ref: Option<String>,
    pub enabled: i64,
    pub granted_at: i64,
}

/// A row of the `vault` table (opaque ciphertext — see [`crate::vault`]).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VaultRow {
    pub id: String,
    pub connector_id: String,
    pub fields_enc: Vec<u8>,
    pub nonce: Vec<u8>,
    pub created_at: i64,
    pub rotated_at: i64,
}

// ── connectors CRUD ───────────────────────────────────────────────────────────

/// List all installed connectors, newest first.
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Connector>> {
    sqlx::query_as::<_, Connector>("SELECT * FROM connectors ORDER BY created_at DESC, id ASC")
        .fetch_all(pool)
        .await
}

/// Fetch one connector by id.
pub async fn get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Connector>> {
    sqlx::query_as::<_, Connector>("SELECT * FROM connectors WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// Insert or replace a connector manifest. `created_at` is preserved on an
/// existing row (an upsert of the card fields must not reset provenance time).
#[allow(clippy::too_many_arguments)]
pub async fn upsert(
    pool: &SqlitePool,
    id: &str,
    kind: &str,
    display_name: &str,
    icon: &str,
    description: &str,
    tools_json: &str,
    credentials_json: &str,
    emit_json: &str,
    source_json: &str,
) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO connectors
            (id, kind, display_name, icon, description, tools_json, credentials_json,
             emit_json, source_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            display_name = excluded.display_name,
            icon = excluded.icon,
            description = excluded.description,
            tools_json = excluded.tools_json,
            credentials_json = excluded.credentials_json,
            emit_json = excluded.emit_json,
            source_json = excluded.source_json",
    )
    .bind(id)
    .bind(kind)
    .bind(display_name)
    .bind(icon)
    .bind(description)
    .bind(tools_json)
    .bind(credentials_json)
    .bind(emit_json)
    .bind(source_json)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete a connector. Its grants + vault rows CASCADE away (FK ON DELETE
/// CASCADE, migration 0031). Returns true if a row existed.
pub async fn delete(pool: &SqlitePool, id: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM connectors WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

// ── grants (session_connectors) ───────────────────────────────────────────────

/// The ENABLED grants that apply to `session_name`: its OWN grants unioned with
/// the `*` (all-agents) grants. This is the exact set the launch-scoping engine
/// turns into the session's inline `--mcp-config` (spec §5). A per-session grant
/// row wins over an `*` row for the same connector (its `secret_ref` is used).
pub async fn grants_for_session(pool: &SqlitePool, session_name: &str) -> sqlx::Result<Vec<Grant>> {
    // Own grants first, then all-agents grants; the caller de-dupes by
    // connector_id keeping the first (own) occurrence.
    let mut own = sqlx::query_as::<_, Grant>(
        "SELECT * FROM session_connectors WHERE session_name = ? AND enabled = 1",
    )
    .bind(session_name)
    .fetch_all(pool)
    .await?;
    let all = sqlx::query_as::<_, Grant>(
        "SELECT * FROM session_connectors WHERE session_name = ? AND enabled = 1",
    )
    .bind(ALL_AGENTS)
    .fetch_all(pool)
    .await?;
    let owned: std::collections::HashSet<String> =
        own.iter().map(|g| g.connector_id.clone()).collect();
    own.extend(all.into_iter().filter(|g| !owned.contains(&g.connector_id)));
    Ok(own)
}

/// List every grant for a connector (both a card's per-agent grants and its
/// all-agents grant), for the store UI's grant state.
pub async fn grants_for_connector(pool: &SqlitePool, connector_id: &str) -> sqlx::Result<Vec<Grant>> {
    sqlx::query_as::<_, Grant>(
        "SELECT * FROM session_connectors WHERE connector_id = ? ORDER BY session_name ASC",
    )
    .bind(connector_id)
    .fetch_all(pool)
    .await
}

/// Grant `connector_id` to `session_name` (or the `*` sentinel), optionally
/// pinning a `secret_ref`. Idempotent upsert on the (session, connector) PK.
pub async fn grant(
    pool: &SqlitePool,
    session_name: &str,
    connector_id: &str,
    secret_ref: Option<&str>,
    enabled: bool,
) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO session_connectors
            (session_name, connector_id, secret_ref, enabled, granted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_name, connector_id) DO UPDATE SET
            secret_ref = excluded.secret_ref,
            enabled = excluded.enabled",
    )
    .bind(session_name)
    .bind(connector_id)
    .bind(secret_ref)
    .bind(if enabled { 1 } else { 0 })
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Revoke a grant (delete the row). Returns true if it existed.
pub async fn revoke(pool: &SqlitePool, session_name: &str, connector_id: &str) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "DELETE FROM session_connectors WHERE session_name = ? AND connector_id = ?",
    )
    .bind(session_name)
    .bind(connector_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

// ── vault ─────────────────────────────────────────────────────────────────────

/// Insert (or replace) a vault row with an already-sealed blob. Returns nothing;
/// the caller minted `id`.
pub async fn vault_put(
    pool: &SqlitePool,
    id: &str,
    connector_id: &str,
    fields_enc: &[u8],
    nonce: &[u8],
    rotated: bool,
) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    let rotated_at = if rotated { now } else { 0 };
    sqlx::query(
        "INSERT INTO vault (id, connector_id, fields_enc, nonce, created_at, rotated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            fields_enc = excluded.fields_enc,
            nonce = excluded.nonce,
            rotated_at = ?",
    )
    .bind(id)
    .bind(connector_id)
    .bind(fields_enc)
    .bind(nonce)
    .bind(now)
    .bind(rotated_at)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Fetch a vault row by id (opaque ciphertext).
pub async fn vault_get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<VaultRow>> {
    sqlx::query_as::<_, VaultRow>("SELECT * FROM vault WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db;

    async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-conn-db-{}", uuid::Uuid::new_v4()));
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
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            extra_origins: Vec::new(),
        };
        let pool = db::init(&config).await.expect("init pool");
        (pool, dir)
    }

    async fn insert_connector(pool: &SqlitePool, id: &str) {
        upsert(pool, id, "mcp_catalog", id, "", "", "[]", "[]", "{}", "{}")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn connector_upsert_get_delete() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "notion").await;
        assert!(get(&pool, "notion").await.unwrap().is_some());
        // Upsert updates fields, keeps created_at.
        let before = get(&pool, "notion").await.unwrap().unwrap().created_at;
        upsert(&pool, "notion", "mcp_catalog", "Notion", "", "docs", "[]", "[]", "{}", "{}")
            .await
            .unwrap();
        let after = get(&pool, "notion").await.unwrap().unwrap();
        assert_eq!(after.display_name, "Notion");
        assert_eq!(after.created_at, before, "upsert preserves created_at");
        assert!(delete(&pool, "notion").await.unwrap());
        assert!(get(&pool, "notion").await.unwrap().is_none());
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn grants_union_own_and_all_agents() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "gh").await;
        insert_connector(&pool, "mail").await;
        // 'gh' granted to alpha only; 'mail' granted to all agents.
        grant(&pool, "alpha", "gh", Some("sref-gh"), true).await.unwrap();
        grant(&pool, ALL_AGENTS, "mail", Some("sref-mail"), true).await.unwrap();

        let alpha = grants_for_session(&pool, "alpha").await.unwrap();
        let ids: std::collections::HashSet<_> = alpha.iter().map(|g| g.connector_id.clone()).collect();
        assert!(ids.contains("gh"));
        assert!(ids.contains("mail"), "all-agents grant unions into alpha");

        // Beta gets 'mail' (all-agents) but NOT 'gh' (alpha-only) — isolation.
        let beta = grants_for_session(&pool, "beta").await.unwrap();
        let bids: std::collections::HashSet<_> = beta.iter().map(|g| g.connector_id.clone()).collect();
        assert!(bids.contains("mail"));
        assert!(!bids.contains("gh"), "beta must NOT see alpha's private grant");

        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn own_grant_wins_over_all_agents_for_same_connector() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "mail").await;
        grant(&pool, ALL_AGENTS, "mail", Some("shared"), true).await.unwrap();
        grant(&pool, "alpha", "mail", Some("alpha-own"), true).await.unwrap();
        let alpha = grants_for_session(&pool, "alpha").await.unwrap();
        let mail: Vec<_> = alpha.iter().filter(|g| g.connector_id == "mail").collect();
        assert_eq!(mail.len(), 1, "no duplicate connector in the union");
        assert_eq!(mail[0].secret_ref.as_deref(), Some("alpha-own"));
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn disabled_grant_is_excluded() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "gh").await;
        grant(&pool, "alpha", "gh", None, false).await.unwrap();
        assert!(grants_for_session(&pool, "alpha").await.unwrap().is_empty());
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn delete_connector_cascades_grants_and_vault() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "mail").await;
        grant(&pool, "alpha", "mail", Some("sref"), true).await.unwrap();
        vault_put(&pool, "sref", "mail", b"ct", b"nonce12bytes", false).await.unwrap();
        delete(&pool, "mail").await.unwrap();
        assert!(grants_for_connector(&pool, "mail").await.unwrap().is_empty());
        assert!(vault_get(&pool, "sref").await.unwrap().is_none());
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn vault_roundtrip_row() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "mail").await;
        vault_put(&pool, "s1", "mail", b"\x00\x01ciphertext", b"nonce12bytes", false)
            .await
            .unwrap();
        let row = vault_get(&pool, "s1").await.unwrap().unwrap();
        assert_eq!(row.fields_enc, b"\x00\x01ciphertext");
        assert_eq!(row.nonce, b"nonce12bytes");
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }
}

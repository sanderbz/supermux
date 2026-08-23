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

/// The `session_name` prefix for a COMPANY-scoped grant: `@company:<id>`. A grant
/// keyed this way applies to every session whose `sessions.company_id` matches the
/// `<id>` suffix — the middle tier between an own-slug grant and the all-agents
/// `*` sentinel (precedence: own > company > all). Same free-TEXT sentinel
/// mechanism as [`ALL_AGENTS`]; no schema column of its own.
pub const COMPANY_PREFIX: &str = "@company:";

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
    /// Denormalized from the account (see [`Account::secret_ref`]) so the launch
    /// path ([`crate::sessions::connector_config`]) reads it straight off the grant
    /// with zero JOIN — untouched by multi-account.
    pub secret_ref: Option<String>,
    pub enabled: i64,
    pub granted_at: i64,
    /// WHICH [`Account`] this grant is using (`connector_accounts.id`), or `None`
    /// for a legacy / no-identity grant. Rides along on the union; it never changes
    /// grant precedence or company isolation — those key off `connector_id` only.
    pub account_ref: Option<String>,
}

/// A row of the `connector_accounts` table (migrations 0035/0036) — one CONNECTED
/// ACCOUNT of a connector. A connector may have N of these; a [`Grant`] references
/// one via [`Grant::account_ref`]. `account_label` is NON-secret (display only);
/// the sensitive material lives, sealed, in the [`vault`](crate::vault) at
/// `secret_ref`. The row (and its `secret_ref`) survives a disconnect so a reconnect
/// reuses the sealed secret.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Account {
    pub id: String,
    pub connector_id: String,
    /// Non-secret display identity, e.g. `"sander@acme.com"`; `""` when the
    /// connector captures no identity field.
    pub account_label: String,
    /// `vault.id` of this account's sealed secret (`None` for a no-secret connector).
    pub secret_ref: Option<String>,
    /// `"active"` | `"disconnected"`.
    pub status: String,
    pub created_at: i64,
    /// Passive freshness (stamped at launch; written by a later slice).
    pub last_used_at: i64,
    /// Active health (0036): `None` | `"ok"` | `"expired"` | `"error"`. Written by a
    /// later "Test connection" probe.
    pub health: Option<String>,
    pub last_checked_at: i64,
    /// Masked, human-readable last health error.
    pub last_error: Option<String>,
    /// Company that owns this connected account (P2b isolation, 0037). `None` =
    /// HQ / global scope. Two companies connecting the same identity label are
    /// DISTINCT rows keyed by this; two HQ (`None`) connects still dedup to one.
    /// `SELECT *` / `FromRow` picks up the nullable column automatically.
    pub company_id: Option<i64>,
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

/// The ENABLED grants that apply to `session_name`, resolved across THREE tiers
/// with own > company > all-agents precedence:
///   1. the session's OWN grants (keyed on its slug),
///   2. its COMPANY grants (keyed `@company:<company_id>`), if the session row
///      carries a non-NULL `company_id`,
///   3. the `*` (all-agents) grants.
/// This is the exact set the launch-scoping engine turns into the session's
/// inline `--mcp-config` (spec §5). De-dup is by `connector_id`, keeping the
/// first (highest-precedence) occurrence, so an own grant overrides its
/// company's and a company grant overrides the global default (its `secret_ref`
/// is the one used). A main/NULL-company session never picks up the company tier,
/// and a session in company X never sees company Y's grants.
pub async fn grants_for_session(pool: &SqlitePool, session_name: &str) -> sqlx::Result<Vec<Grant>> {
    // Tier 1 — own grants (highest precedence).
    let mut out = sqlx::query_as::<_, Grant>(
        "SELECT * FROM session_connectors WHERE session_name = ? AND enabled = 1",
    )
    .bind(session_name)
    .fetch_all(pool)
    .await?;

    // Tier 2 — company grants, only when this session belongs to a company. The
    // lookup is by the session's own row; a `*`/`@company:` sentinel is not a
    // real session, so this resolves to NULL and the tier is skipped for them.
    let company_id: Option<i64> =
        sqlx::query_scalar::<_, Option<i64>>("SELECT company_id FROM sessions WHERE name = ?")
            .bind(session_name)
            .fetch_optional(pool)
            .await?
            .flatten();
    let company: Vec<Grant> = if let Some(cid) = company_id {
        sqlx::query_as::<_, Grant>(
            "SELECT * FROM session_connectors WHERE session_name = ? AND enabled = 1",
        )
        .bind(format!("{COMPANY_PREFIX}{cid}"))
        .fetch_all(pool)
        .await?
    } else {
        Vec::new()
    };

    // Tier 3 — all-agents grants (lowest precedence).
    let all = sqlx::query_as::<_, Grant>(
        "SELECT * FROM session_connectors WHERE session_name = ? AND enabled = 1",
    )
    .bind(ALL_AGENTS)
    .fetch_all(pool)
    .await?;

    // Fold the lower tiers in, skipping any connector already claimed by a
    // higher tier (own wins over company wins over all).
    let mut seen: std::collections::HashSet<String> =
        out.iter().map(|g| g.connector_id.clone()).collect();
    for g in company.into_iter().chain(all.into_iter()) {
        if seen.insert(g.connector_id.clone()) {
            out.push(g);
        }
    }
    Ok(out)
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

/// Account-aware [`grant`]: same idempotent upsert, but also pins which
/// [`Account`] the grant uses (`account_ref`). Used by the connect / add-account /
/// reconnect paths; the plain [`grant`] leaves `account_ref` untouched (a re-grant
/// of a legacy row keeps whatever account it already had).
pub async fn grant_with_account(
    pool: &SqlitePool,
    session_name: &str,
    connector_id: &str,
    secret_ref: Option<&str>,
    enabled: bool,
    account_ref: Option<&str>,
) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO session_connectors
            (session_name, connector_id, secret_ref, enabled, granted_at, account_ref)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_name, connector_id) DO UPDATE SET
            secret_ref = excluded.secret_ref,
            enabled = excluded.enabled,
            account_ref = excluded.account_ref",
    )
    .bind(session_name)
    .bind(connector_id)
    .bind(secret_ref)
    .bind(if enabled { 1 } else { 0 })
    .bind(now)
    .bind(account_ref)
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

/// Revoke every grant of `connector_id` that uses `account_ref` — the DISCONNECT
/// primitive. The [`Account`] row and its sealed secret are LEFT INTACT (the caller
/// flips its status), so a later reconnect reuses the secret. Returns the count of
/// grants removed.
pub async fn revoke_by_account(
    pool: &SqlitePool,
    connector_id: &str,
    account_ref: &str,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        "DELETE FROM session_connectors WHERE connector_id = ? AND account_ref = ?",
    )
    .bind(connector_id)
    .bind(account_ref)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

// ── connector_accounts (multi-account, migrations 0035/0036) ────────────────────

/// Insert a new connected [`Account`] and return its minted id (the `account_ref`).
/// `status` starts `"active"`. `account_label` is stored in cleartext (non-secret).
pub async fn account_add(
    pool: &SqlitePool,
    connector_id: &str,
    account_label: &str,
    secret_ref: Option<&str>,
    company_id: Option<i64>,
) -> sqlx::Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO connector_accounts
            (id, connector_id, account_label, secret_ref, status, created_at,
             last_used_at, company_id)
         VALUES (?, ?, ?, ?, 'active', ?, 0, ?)",
    )
    .bind(&id)
    .bind(connector_id)
    .bind(account_label)
    .bind(secret_ref)
    .bind(now)
    .bind(company_id)
    .execute(pool)
    .await?;
    Ok(id)
}

/// The one account of a connector matching `account_label` **within a company
/// scope** — the dedup key for the paste/device connect paths (0037). `company_id`
/// `None` means HQ/global; SQLite `IS` makes `company_id IS NULL` match (a bare
/// `= ?` with a NULL bind never matches a NULL row). Company A's "alice" and
/// company B's "alice" never collide; two HQ (`None`) connects find the same row.
pub async fn account_find_by_label(
    pool: &SqlitePool,
    connector_id: &str,
    account_label: &str,
    company_id: Option<i64>,
) -> sqlx::Result<Option<Account>> {
    sqlx::query_as::<_, Account>(
        "SELECT * FROM connector_accounts
          WHERE connector_id = ? AND account_label = ? AND company_id IS ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1",
    )
    .bind(connector_id)
    .bind(account_label)
    .bind(company_id)
    .fetch_optional(pool)
    .await
}

/// The company a grant TARGET resolves to — the scope an account minted for it
/// belongs to (own > company > all, expressed as the target string, 0037):
///   * `*` / "all" / empty  → `None` (HQ / all-agents / global)
///   * `@company:<id>`       → `Some(id)`
///   * a real session slug   → that session's `sessions.company_id` (`None` if the
///                             row is missing or itself HQ/NULL)
/// Mirrors `resolve_grant_scope`'s company arm; the single source of truth for
/// "which company owns the account this connect creates". The caller passes the
/// already-normalized target (`*` / `@company:<id>` / slug).
pub async fn company_of_grant_target(pool: &SqlitePool, session_name: &str) -> Option<i64> {
    let t = session_name.trim();
    if t.is_empty() || t == ALL_AGENTS {
        return None;
    }
    if let Some(ids) = t.strip_prefix(COMPANY_PREFIX) {
        return ids.parse::<i64>().ok();
    }
    super::sessions::get(pool, t)
        .await
        .ok()
        .flatten()
        .and_then(|s| s.company_id)
}

/// Fetch one account by its id (the `account_ref`).
pub async fn account_get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Account>> {
    sqlx::query_as::<_, Account>("SELECT * FROM connector_accounts WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// Every account of a connector, oldest first — the multi-account list.
pub async fn accounts_for_connector(
    pool: &SqlitePool,
    connector_id: &str,
) -> sqlx::Result<Vec<Account>> {
    sqlx::query_as::<_, Account>(
        "SELECT * FROM connector_accounts WHERE connector_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(connector_id)
    .fetch_all(pool)
    .await
}

/// Flip an account's lifecycle `status` (`"active"` | `"disconnected"`). Returns
/// true if the row existed.
pub async fn account_set_status(pool: &SqlitePool, id: &str, status: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("UPDATE connector_accounts SET status = ? WHERE id = ?")
        .bind(status)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// REPLACE an account's identity in place — a new `account_label` and/or a rotated
/// `secret_ref` — keeping the same account id (so every grant referencing it stays
/// wired) and setting status back to `"active"`. Returns true if the row existed.
pub async fn account_replace(
    pool: &SqlitePool,
    id: &str,
    account_label: &str,
    secret_ref: Option<&str>,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "UPDATE connector_accounts
            SET account_label = ?, secret_ref = ?, status = 'active'
          WHERE id = ?",
    )
    .bind(account_label)
    .bind(secret_ref)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Stamp `last_used_at` (passive freshness). Best-effort; returns true if updated.
pub async fn account_mark_used(pool: &SqlitePool, id: &str, at: i64) -> sqlx::Result<bool> {
    let res = sqlx::query("UPDATE connector_accounts SET last_used_at = ? WHERE id = ?")
        .bind(at)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Record the outcome of a "Test connection" probe (0036): the active `health`
/// (`"ok"|"expired"|"error"`, or `None` to clear), a masked human-readable
/// `last_error` (`None` on success), and the `last_checked_at` stamp. Best-effort;
/// returns true if the row existed.
pub async fn account_set_health(
    pool: &SqlitePool,
    id: &str,
    health: Option<&str>,
    last_error: Option<&str>,
    at: i64,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "UPDATE connector_accounts
            SET health = ?, last_error = ?, last_checked_at = ?
          WHERE id = ?",
    )
    .bind(health)
    .bind(last_error)
    .bind(at)
    .bind(id)
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
            human_auth: Default::default(),
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

    /// Minimal `sessions` row so the company tier can resolve a real bot's
    /// `company_id`. Only `name`/`dir`/`created_at` are NOT NULL without a
    /// default; `company_id` is the nullable P1 column.
    async fn insert_session(pool: &SqlitePool, name: &str, company_id: Option<i64>) {
        sqlx::query("INSERT INTO sessions (name, dir, created_at, company_id) VALUES (?, ?, ?, ?)")
            .bind(name)
            .bind("/tmp")
            .bind(0i64)
            .bind(company_id)
            .execute(pool)
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
    async fn company_grant_resolves_for_a_company_bot() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "crm").await;
        // A bot in company 7, and a grant keyed to that company.
        insert_session(&pool, "acme-bot", Some(7)).await;
        grant(&pool, &format!("{COMPANY_PREFIX}7"), "crm", Some("sref-crm"), true)
            .await
            .unwrap();

        let bot = grants_for_session(&pool, "acme-bot").await.unwrap();
        let crm: Vec<_> = bot.iter().filter(|g| g.connector_id == "crm").collect();
        assert_eq!(crm.len(), 1, "the company grant resolves for its company bot");
        assert_eq!(crm[0].secret_ref.as_deref(), Some("sref-crm"));
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn precedence_own_over_company_over_all() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "mail").await;
        insert_session(&pool, "acme-bot", Some(7)).await;
        // Same connector granted at all three tiers with distinct secret_refs.
        grant(&pool, ALL_AGENTS, "mail", Some("all-sref"), true).await.unwrap();
        grant(&pool, &format!("{COMPANY_PREFIX}7"), "mail", Some("company-sref"), true)
            .await
            .unwrap();
        grant(&pool, "acme-bot", "mail", Some("own-sref"), true).await.unwrap();

        // Own wins over company wins over all — one row, own's secret.
        let bot = grants_for_session(&pool, "acme-bot").await.unwrap();
        let mail: Vec<_> = bot.iter().filter(|g| g.connector_id == "mail").collect();
        assert_eq!(mail.len(), 1, "no duplicate connector across the three tiers");
        assert_eq!(mail[0].secret_ref.as_deref(), Some("own-sref"), "own tier wins");

        // Drop the own grant: company must now beat all-agents.
        revoke(&pool, "acme-bot", "mail").await.unwrap();
        let bot = grants_for_session(&pool, "acme-bot").await.unwrap();
        let mail: Vec<_> = bot.iter().filter(|g| g.connector_id == "mail").collect();
        assert_eq!(mail.len(), 1);
        assert_eq!(
            mail[0].secret_ref.as_deref(),
            Some("company-sref"),
            "company tier beats all-agents"
        );
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn company_x_bot_does_not_see_company_y_grants() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "x-only").await;
        insert_connector(&pool, "y-only").await;
        insert_session(&pool, "x-bot", Some(1)).await;
        insert_session(&pool, "y-bot", Some(2)).await;
        grant(&pool, &format!("{COMPANY_PREFIX}1"), "x-only", Some("x"), true)
            .await
            .unwrap();
        grant(&pool, &format!("{COMPANY_PREFIX}2"), "y-only", Some("y"), true)
            .await
            .unwrap();

        let x = grants_for_session(&pool, "x-bot").await.unwrap();
        let xids: std::collections::HashSet<_> = x.iter().map(|g| g.connector_id.clone()).collect();
        assert!(xids.contains("x-only"), "company-1 bot gets company-1 grant");
        assert!(
            !xids.contains("y-only"),
            "company-1 bot must NEVER see company-2's grant"
        );
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn null_company_bot_ignores_the_company_tier() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "crm").await;
        insert_connector(&pool, "mail").await;
        // A main/NULL-company bot; a company-7 grant exists but must not reach it.
        insert_session(&pool, "main-bot", None).await;
        grant(&pool, &format!("{COMPANY_PREFIX}7"), "crm", Some("c"), true)
            .await
            .unwrap();
        grant(&pool, ALL_AGENTS, "mail", Some("a"), true).await.unwrap();

        let bot = grants_for_session(&pool, "main-bot").await.unwrap();
        let ids: std::collections::HashSet<_> = bot.iter().map(|g| g.connector_id.clone()).collect();
        assert!(!ids.contains("crm"), "NULL-company bot ignores the company tier");
        assert!(ids.contains("mail"), "but still gets the all-agents grant");
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

    // ── multi-account (0035/0036) ───────────────────────────────────────────────

    #[tokio::test]
    async fn multi_account_roundtrip_add_grant_consumers_disconnect_keeps_secret() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "gmail").await;

        // TWO accounts on ONE connector, each its own label + its own sealed secret.
        vault_put(&pool, "sref-a", "gmail", b"ct-a", b"nonce12bytes", false).await.unwrap();
        vault_put(&pool, "sref-b", "gmail", b"ct-b", b"nonce12bytes", false).await.unwrap();
        let acct_a = account_add(&pool, "gmail", "sander@acme.com", Some("sref-a"), None).await.unwrap();
        let acct_b = account_add(&pool, "gmail", "ops@acme.com", Some("sref-b"), None).await.unwrap();
        assert_ne!(acct_a, acct_b, "each account is a distinct row");

        let accts = accounts_for_connector(&pool, "gmail").await.unwrap();
        assert_eq!(accts.len(), 2, "connector holds two accounts");
        let labels: std::collections::HashSet<_> =
            accts.iter().map(|a| a.account_label.clone()).collect();
        assert!(labels.contains("sander@acme.com") && labels.contains("ops@acme.com"));

        // Grant ACCOUNT A to a bot — the grant pins account_ref AND rides A's secret.
        grant_with_account(&pool, "crm-bot", "gmail", Some("sref-a"), true, Some(&acct_a))
            .await
            .unwrap();

        // grants_for_connector lists the consumer, carrying which account it uses.
        let consumers = grants_for_connector(&pool, "gmail").await.unwrap();
        assert_eq!(consumers.len(), 1);
        assert_eq!(consumers[0].session_name, "crm-bot");
        assert_eq!(consumers[0].account_ref.as_deref(), Some(acct_a.as_str()));
        assert_eq!(consumers[0].secret_ref.as_deref(), Some("sref-a"));

        // The launch path still resolves the grant unchanged (own secret rides it).
        let bot = grants_for_session(&pool, "crm-bot").await.unwrap();
        let g = bot.iter().find(|g| g.connector_id == "gmail").unwrap();
        assert_eq!(g.account_ref.as_deref(), Some(acct_a.as_str()));
        assert_eq!(g.secret_ref.as_deref(), Some("sref-a"));

        // DISCONNECT account A: revoke its grants, KEEP the account row + its secret.
        let removed = revoke_by_account(&pool, "gmail", &acct_a).await.unwrap();
        assert_eq!(removed, 1, "the one grant using account A is revoked");
        account_set_status(&pool, &acct_a, "disconnected").await.unwrap();

        assert!(
            grants_for_connector(&pool, "gmail").await.unwrap().is_empty(),
            "no consumers after disconnect"
        );
        let a = account_get(&pool, &acct_a).await.unwrap().unwrap();
        assert_eq!(a.status, "disconnected");
        assert_eq!(a.secret_ref.as_deref(), Some("sref-a"), "the account keeps its secret_ref");
        assert!(
            vault_get(&pool, "sref-a").await.unwrap().is_some(),
            "the sealed secret survives a disconnect (1-tap reconnect)"
        );
        // Account B (never disconnected) is untouched.
        assert_eq!(accounts_for_connector(&pool, "gmail").await.unwrap().len(), 2);

        // RECONNECT: reuse the kept secret_ref, flip status back.
        let a = account_get(&pool, &acct_a).await.unwrap().unwrap();
        grant_with_account(&pool, "crm-bot", "gmail", a.secret_ref.as_deref(), true, Some(&acct_a))
            .await
            .unwrap();
        account_set_status(&pool, &acct_a, "active").await.unwrap();
        let consumers = grants_for_connector(&pool, "gmail").await.unwrap();
        assert_eq!(consumers.len(), 1, "reconnect re-grants using the kept secret");
        assert_eq!(consumers[0].secret_ref.as_deref(), Some("sref-a"));

        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn account_health_and_last_used_round_trip() {
        // The freshness + health columns (0035/0036) persist honestly: a fresh
        // account is health=NULL / last_used=0; a launch stamps last_used; a probe
        // writes health + last_error + last_checked_at; clearing sets health=NULL.
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "gmail").await;
        let acct = account_add(&pool, "gmail", "sander@acme.com", Some("sref"), None).await.unwrap();

        let a = account_get(&pool, &acct).await.unwrap().unwrap();
        assert_eq!(a.health, None, "never-probed account has no health");
        assert_eq!(a.last_used_at, 0);
        assert_eq!(a.last_checked_at, 0);

        // Passive freshness at launch.
        assert!(account_mark_used(&pool, &acct, 1_700).await.unwrap());
        assert_eq!(account_get(&pool, &acct).await.unwrap().unwrap().last_used_at, 1_700);

        // A failing probe records error + a masked reason + the check time.
        assert!(account_set_health(&pool, &acct, Some("error"), Some("Couldn't reach the endpoint."), 2_000)
            .await
            .unwrap());
        let a = account_get(&pool, &acct).await.unwrap().unwrap();
        assert_eq!(a.health.as_deref(), Some("error"));
        assert_eq!(a.last_error.as_deref(), Some("Couldn't reach the endpoint."));
        assert_eq!(a.last_checked_at, 2_000);
        assert_eq!(a.last_used_at, 1_700, "a probe never touches last_used");

        // A passing probe clears the error.
        assert!(account_set_health(&pool, &acct, Some("ok"), None, 2_500).await.unwrap());
        let a = account_get(&pool, &acct).await.unwrap().unwrap();
        assert_eq!(a.health.as_deref(), Some("ok"));
        assert_eq!(a.last_error, None, "a green check clears the prior error");

        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn account_replace_swaps_identity_and_keeps_the_grant() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "gmail").await;
        vault_put(&pool, "sref-1", "gmail", b"ct", b"nonce12bytes", false).await.unwrap();
        let acct = account_add(&pool, "gmail", "old@acme.com", Some("sref-1"), None).await.unwrap();
        grant_with_account(&pool, "crm-bot", "gmail", Some("sref-1"), true, Some(&acct))
            .await
            .unwrap();

        // Replace the identity in place (same account id, rotated secret in place).
        vault_put(&pool, "sref-1", "gmail", b"ct-rotated", b"nonce12bytes", true).await.unwrap();
        assert!(account_replace(&pool, &acct, "new@acme.com", Some("sref-1")).await.unwrap());

        let a = account_get(&pool, &acct).await.unwrap().unwrap();
        assert_eq!(a.account_label, "new@acme.com", "identity swapped");
        assert_eq!(a.status, "active");
        // The grant still points at the SAME account (grants kept).
        let consumers = grants_for_connector(&pool, "gmail").await.unwrap();
        assert_eq!(consumers.len(), 1);
        assert_eq!(consumers[0].account_ref.as_deref(), Some(acct.as_str()));

        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn account_ref_rides_the_union_without_disturbing_precedence() {
        // Multi-account must NOT change own>company>all precedence or isolation:
        // the account_ref just rides along on the winning tier's grant.
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "mail").await;
        insert_session(&pool, "acme-bot", Some(7)).await;
        let own = account_add(&pool, "mail", "own@acme.com", Some("own-sref"), None).await.unwrap();
        // all-agents (plain grant, no account) + own-tier account-aware grant.
        grant(&pool, ALL_AGENTS, "mail", Some("all-sref"), true).await.unwrap();
        grant_with_account(&pool, "acme-bot", "mail", Some("own-sref"), true, Some(&own))
            .await
            .unwrap();

        let bot = grants_for_session(&pool, "acme-bot").await.unwrap();
        let mail: Vec<_> = bot.iter().filter(|g| g.connector_id == "mail").collect();
        assert_eq!(mail.len(), 1, "still de-duped to one connector across tiers");
        assert_eq!(mail[0].secret_ref.as_deref(), Some("own-sref"), "own tier still wins");
        assert_eq!(mail[0].account_ref.as_deref(), Some(own.as_str()), "and carries its account");

        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn delete_connector_cascades_accounts() {
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "gmail").await;
        account_add(&pool, "gmail", "a@acme.com", None, None).await.unwrap();
        account_add(&pool, "gmail", "b@acme.com", None, None).await.unwrap();
        assert_eq!(accounts_for_connector(&pool, "gmail").await.unwrap().len(), 2);
        delete(&pool, "gmail").await.unwrap();
        assert!(
            accounts_for_connector(&pool, "gmail").await.unwrap().is_empty(),
            "accounts CASCADE with the connector"
        );
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    // ── company-scoped accounts (0037, P2b isolation) ───────────────────────────

    #[tokio::test]
    async fn two_companies_same_label_are_distinct_rows() {
        // Company A and company B both connect the identity "alice" on the same
        // connector: two DISTINCT rows with DISTINCT secret_refs — never a shared
        // row / secret_ref (the cross-company token-swap the fix closes).
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "gh").await;
        let a = account_add(&pool, "gh", "alice", Some("sref-A"), Some(1)).await.unwrap();
        let b = account_add(&pool, "gh", "alice", Some("sref-B"), Some(2)).await.unwrap();
        assert_ne!(a, b, "same label in two companies = two rows");

        let found_a = account_find_by_label(&pool, "gh", "alice", Some(1)).await.unwrap().unwrap();
        let found_b = account_find_by_label(&pool, "gh", "alice", Some(2)).await.unwrap().unwrap();
        assert_eq!(found_a.id, a);
        assert_eq!(found_b.id, b);
        assert_eq!(found_a.secret_ref.as_deref(), Some("sref-A"));
        assert_eq!(found_b.secret_ref.as_deref(), Some("sref-B"), "no secret_ref swap");
        assert_eq!(found_a.company_id, Some(1));
        assert_eq!(found_b.company_id, Some(2));
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn same_company_relabel_dedups_to_one_row() {
        // Re-connecting the same label WITHIN one company finds the existing row —
        // the caller account_replace's it in place (one row, same id, new secret).
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "gh").await;
        let id = account_add(&pool, "gh", "alice", Some("sref-1"), Some(1)).await.unwrap();

        let existing = account_find_by_label(&pool, "gh", "alice", Some(1)).await.unwrap();
        assert_eq!(existing.as_ref().map(|a| a.id.clone()), Some(id.clone()), "dedup finds the row");
        account_replace(&pool, &existing.unwrap().id, "alice", Some("sref-2")).await.unwrap();

        let all = accounts_for_connector(&pool, "gh").await.unwrap();
        assert_eq!(all.len(), 1, "same company + label = one row (no dup)");
        assert_eq!(all[0].id, id, "same id preserved (grants stay wired)");
        assert_eq!(all[0].secret_ref.as_deref(), Some("sref-2"), "secret rotated in place");
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn both_hq_null_dedup_to_one() {
        // Two HQ (company_id = None) connects of the same label must dedup to ONE
        // row — this GUARDS the `company_id IS ?` operator: a `= ?` NULL bind never
        // matches a NULL row and would silently mint a duplicate HQ account.
        let (pool, dir) = test_pool().await;
        insert_connector(&pool, "gh").await;
        let id = account_add(&pool, "gh", "alice", Some("sref-hq"), None).await.unwrap();

        let found = account_find_by_label(&pool, "gh", "alice", None).await.unwrap();
        assert_eq!(
            found.map(|a| a.id),
            Some(id),
            "IS NULL matches the HQ row (guards the IS-vs-= pitfall)"
        );
        // A company-scoped lookup of the same label finds nothing (HQ != company 1).
        assert!(
            account_find_by_label(&pool, "gh", "alice", Some(1)).await.unwrap().is_none(),
            "a company lookup never sees the HQ row"
        );
        pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn company_of_grant_target_maps_scope_to_company() {
        let (pool, dir) = test_pool().await;
        // `*` / empty → HQ/None.
        assert_eq!(company_of_grant_target(&pool, ALL_AGENTS).await, None);
        assert_eq!(company_of_grant_target(&pool, "  ").await, None);
        // `@company:<id>` → Some(id).
        assert_eq!(company_of_grant_target(&pool, &format!("{COMPANY_PREFIX}7")).await, Some(7));
        // A real bot slug → its session's company_id.
        insert_session(&pool, "acme-bot", Some(3)).await;
        assert_eq!(company_of_grant_target(&pool, "acme-bot").await, Some(3));
        // An HQ bot (NULL company) → None.
        insert_session(&pool, "hq-bot", None).await;
        assert_eq!(company_of_grant_target(&pool, "hq-bot").await, None);
        // A missing session row → None (matches resolve_grant_scope).
        assert_eq!(company_of_grant_target(&pool, "ghost").await, None);
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

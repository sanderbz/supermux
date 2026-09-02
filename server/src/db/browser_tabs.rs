//! Shared-browser **workspace tab** persistence: the `browser_tabs` rows and the
//! `browser_tab_grants` per-tab grants (migration 0039).
//!
//! Shaped after [`crate::db::connectors`] on purpose — same runtime-checked
//! (`sqlx::query_as::<_, T>`) style, so no live `DATABASE_URL` / offline cache is
//! needed at build time, and the SAME three-tier grantee keyspace
//! (`own slug > @company:<id> > *`).
//!
//! # The one function that matters
//!
//! [`tabs_for_session`] is the tab-shaped analogue of
//! [`crate::db::connectors::grants_for_session`], plus the **hard company
//! containment filter** of spec §8.3. It is deliberately the single source of
//! truth for BOTH `browser_list_tabs` (what an agent may discover) and
//! [`has_tab_grant`](crate::connectors::browser::tools) (what an agent may
//! touch), so the two can never disagree — a discovery oracle and an
//! enforcement hole are the same bug seen from two sides.

use serde::Serialize;
use sqlx::SqlitePool;

use super::connectors::{ALL_AGENTS, COMPANY_PREFIX};

/// A row of `browser_tabs` — one persistent workspace tab.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct TabRow {
    /// `tb_<uuid-simple>`. Durable across restarts; NOT the CDP `targetId`,
    /// which changes on every rehydrate.
    pub id: String,
    pub title: String,
    pub url: String,
    pub pinned: i64,
    /// Owning company (`None` = HQ / global). The containment axis of §8.3.
    pub company_id: Option<i64>,
    /// JSON array of host rules — an exact host, or a leading-dot suffix the
    /// human opted into. Host-matching, deliberately NOT PSL-based (a PSL means
    /// a new crate; this module's stated pride is that it adds none).
    pub origins: String,
    /// `ok` | `needs_login` | `unknown`. See [`LOGIN_OK`] / [`LOGIN_NEEDED`].
    pub login_state: String,
    pub last_probe_at: Option<i64>,
    pub keepalive_enabled: i64,
    pub keepalive_every: i64,
    pub keepalive_url: Option<String>,
    pub keepalive_action: String,
    pub keepalive_script: Option<String>,
    pub last_keepalive_at: Option<i64>,
    pub created_at: i64,
    pub last_used_at: i64,
}

/// A row of `browser_tab_grants` — one per-tab grant.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct TabGrant {
    pub tab_id: String,
    /// bot slug | `@company:<id>` | `*` — the SAME keyspace as
    /// `session_connectors.session_name`.
    pub grantee: String,
    pub enabled: i64,
    pub granted_at: i64,
}

/// `login_state` — the probe saw an authenticated response.
pub const LOGIN_OK: &str = "ok";
/// `login_state` — the probe saw a sign-in wall. **Agent verbs are refused.**
pub const LOGIN_NEEDED: &str = "needs_login";
/// `login_state` — never probed, or the probe itself failed. Not a claim.
pub const LOGIN_UNKNOWN: &str = "unknown";

/// The `tb_` prefix every tab id carries.
pub const TAB_PREFIX: &str = "tb_";

/// Mint a fresh durable tab id (`tb_<uuid-simple>`), the same idiom the launch
/// path uses for a scratch profile.
pub fn new_tab_id() -> String {
    format!("{TAB_PREFIX}{}", uuid::Uuid::new_v4().simple())
}

/// **Is this a syntactically valid tab id?** Applied before the id is used as a
/// map key, spliced into a log line, or reaches a query — the same shape gate
/// `sessions::valid_name` is to a session name.
pub fn valid_tab_id(id: &str) -> bool {
    id.len() > TAB_PREFIX.len()
        && id.len() <= 64
        && id.starts_with(TAB_PREFIX)
        && id[TAB_PREFIX.len()..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric())
}

// ── tabs CRUD ─────────────────────────────────────────────────────────────────

/// Every tab, newest last-used first. **The HUMAN's view** — the human owns the
/// browser and sees all of it; an agent must go through [`tabs_for_session`].
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<TabRow>> {
    sqlx::query_as::<_, TabRow>(
        "SELECT * FROM browser_tabs ORDER BY pinned DESC, last_used_at DESC, id ASC",
    )
    .fetch_all(pool)
    .await
}

/// One tab by id.
pub async fn get(pool: &SqlitePool, tab_id: &str) -> sqlx::Result<Option<TabRow>> {
    sqlx::query_as::<_, TabRow>("SELECT * FROM browser_tabs WHERE id = ?")
        .bind(tab_id)
        .fetch_optional(pool)
        .await
}

/// Insert a new tab row. `origins` is seeded from the first URL's host by the
/// caller (§8.4) — an empty list means "no agent navigation is allowed off the
/// current host", which is the fail-closed reading.
pub async fn create(
    pool: &SqlitePool,
    id: &str,
    url: &str,
    company_id: Option<i64>,
    origins: &[String],
) -> sqlx::Result<TabRow> {
    let now = chrono::Utc::now().timestamp();
    let origins_json = serde_json::to_string(origins).unwrap_or_else(|_| "[]".into());
    sqlx::query(
        "INSERT INTO browser_tabs (id, title, url, pinned, company_id, origins, login_state, \
         created_at, last_used_at) VALUES (?, '', ?, 0, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(url)
    .bind(company_id)
    .bind(&origins_json)
    .bind(LOGIN_UNKNOWN)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(get(pool, id).await?.expect("just inserted"))
}

/// A sparse update — every field is optional and `None` leaves the column alone.
/// One statement per present field keeps the SQL literal (no dynamic assembly).
#[derive(Debug, Default, Clone)]
pub struct TabPatch {
    pub title: Option<String>,
    pub url: Option<String>,
    pub pinned: Option<bool>,
    pub origins: Option<Vec<String>>,
    pub login_state: Option<String>,
    pub probed_now: bool,
    pub touch_used: bool,
    // ── keep-signed-in (the `keepalive_*` columns migration 0039 reserved) ──
    /// The HUMAN's toggle. The only keepalive field a request body may set.
    pub keepalive_enabled: Option<bool>,
    /// Minutes between checks. **Server-derived only** — the sweep writes what
    /// it learned from the cookie jar; no request body reaches this.
    pub keepalive_every: Option<i64>,
    /// `soft` (fetch-ping) | `watch` (read the jar, ping nothing). The MODE, not
    /// a verb: `reload` is not implemented anywhere in this feature.
    pub keepalive_action: Option<String>,
    /// Stamp `last_keepalive_at = now` — a completed tick.
    pub keepalive_stamp_now: bool,
    /// Stamp `last_keepalive_at = NULL` — "never checked", which `due_at` reads
    /// as **due now**. This is how enabling schedules its first tick inside 60 s
    /// with no extra state.
    pub keepalive_clear_stamp: bool,
}

/// Apply a [`TabPatch`]. Unknown tab ⇒ `Ok(false)`.
pub async fn update(pool: &SqlitePool, tab_id: &str, patch: &TabPatch) -> sqlx::Result<bool> {
    if get(pool, tab_id).await?.is_none() {
        return Ok(false);
    }
    let now = chrono::Utc::now().timestamp();
    if let Some(t) = &patch.title {
        sqlx::query("UPDATE browser_tabs SET title = ? WHERE id = ?")
            .bind(t)
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    if let Some(u) = &patch.url {
        sqlx::query("UPDATE browser_tabs SET url = ? WHERE id = ?")
            .bind(u)
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    if let Some(p) = patch.pinned {
        sqlx::query("UPDATE browser_tabs SET pinned = ? WHERE id = ?")
            .bind(if p { 1 } else { 0 })
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    if let Some(o) = &patch.origins {
        sqlx::query("UPDATE browser_tabs SET origins = ? WHERE id = ?")
            .bind(serde_json::to_string(o).unwrap_or_else(|_| "[]".into()))
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    if let Some(ls) = &patch.login_state {
        sqlx::query("UPDATE browser_tabs SET login_state = ? WHERE id = ?")
            .bind(ls)
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    if patch.probed_now {
        sqlx::query("UPDATE browser_tabs SET last_probe_at = ? WHERE id = ?")
            .bind(now)
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    if patch.touch_used {
        sqlx::query("UPDATE browser_tabs SET last_used_at = ? WHERE id = ?")
            .bind(now)
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    if let Some(k) = patch.keepalive_enabled {
        sqlx::query("UPDATE browser_tabs SET keepalive_enabled = ? WHERE id = ?")
            .bind(if k { 1 } else { 0 })
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    if let Some(e) = patch.keepalive_every {
        sqlx::query("UPDATE browser_tabs SET keepalive_every = ? WHERE id = ?")
            .bind(e)
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    if let Some(a) = &patch.keepalive_action {
        sqlx::query("UPDATE browser_tabs SET keepalive_action = ? WHERE id = ?")
            .bind(a)
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    // Order matters only if a caller sets both; it never does — `clear` is the
    // enable path and `stamp` is the sweep's. Clear runs last so a caller that
    // asked for "never checked" gets it.
    if patch.keepalive_stamp_now {
        sqlx::query("UPDATE browser_tabs SET last_keepalive_at = ? WHERE id = ?")
            .bind(now)
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    if patch.keepalive_clear_stamp {
        sqlx::query("UPDATE browser_tabs SET last_keepalive_at = NULL WHERE id = ?")
            .bind(tab_id)
            .execute(pool)
            .await?;
    }
    Ok(true)
}

/// **The keep-signed-in sweep's only read**: every tab whose human toggled the
/// setting on. Ordered by id so a tick is deterministic (the wake budget is
/// spent on the same tabs first every time, rather than on whoever sorts lucky).
pub async fn list_keepalive(pool: &SqlitePool) -> sqlx::Result<Vec<TabRow>> {
    sqlx::query_as::<_, TabRow>("SELECT * FROM browser_tabs WHERE keepalive_enabled = 1 ORDER BY id")
        .fetch_all(pool)
        .await
}

/// Delete a tab row. Its grants cascade. **Does not clear its cookies** — they
/// live in the one shared jar; the honest eraser is the profile reset (§8.5).
pub async fn delete(pool: &SqlitePool, tab_id: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM browser_tabs WHERE id = ?")
        .bind(tab_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Delete every tab owned by `company_id` — the company-delete cascade primitive.
/// Each tab's `browser_tab_grants` rows cascade away with it (FK `ON DELETE
/// CASCADE`, migration 0039). This must run BEFORE the `companies` row is deleted:
/// `browser_tabs.company_id` is `ON DELETE SET NULL`, so dropping the company first
/// would silently RE-SCOPE these tabs to HQ/global instead of removing them.
/// Returns the number of tab rows removed.
pub async fn delete_for_company(pool: &SqlitePool, company_id: i64) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM browser_tabs WHERE company_id = ?")
        .bind(company_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

// ── per-tab grants ────────────────────────────────────────────────────────────

/// Every grant on a tab (the human's grant sheet).
pub async fn grants_for_tab(pool: &SqlitePool, tab_id: &str) -> sqlx::Result<Vec<TabGrant>> {
    sqlx::query_as::<_, TabGrant>(
        "SELECT * FROM browser_tab_grants WHERE tab_id = ? ORDER BY grantee ASC",
    )
    .bind(tab_id)
    .fetch_all(pool)
    .await
}

/// Grant `grantee` (slug | `@company:<id>` | `*`) the use of `tab_id`.
/// Idempotent upsert on the (tab, grantee) PK.
///
/// **Containment is NOT checked here** — it is checked by the caller
/// ([`crate::connectors::browser::api`]) before the write AND again at call time
/// in `has_tab_grant`, because a session can move between companies after a
/// grant is made (§8.3).
pub async fn grant(
    pool: &SqlitePool,
    tab_id: &str,
    grantee: &str,
    enabled: bool,
) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO browser_tab_grants (tab_id, grantee, enabled, granted_at) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(tab_id, grantee) DO UPDATE SET enabled = excluded.enabled",
    )
    .bind(tab_id)
    .bind(grantee)
    .bind(if enabled { 1 } else { 0 })
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Revoke one grantee from one tab. `Ok(false)` when there was nothing to
/// revoke — the store's "disabled phantom-revoke" honesty rule needs to know.
pub async fn revoke(pool: &SqlitePool, tab_id: &str, grantee: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM browser_tab_grants WHERE tab_id = ? AND grantee = ?")
        .bind(tab_id)
        .bind(grantee)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// **The tabs `session_name` may use** — the three-tier union, then the hard
/// company containment filter.
///
/// Tiers, highest precedence first (de-duplicated by `tab_id`):
///   1. the session's OWN grants (keyed on its slug),
///   2. its COMPANY grants (`@company:<company_id>`), when the session row
///      carries a non-NULL `company_id`,
///   3. the `*` (all-agents) grants.
///
/// Then **§8.3**: a tab owned by company `c` is dropped unless the session is
/// itself in company `c`; a tab with `company_id = NULL` (HQ) is visible to any
/// session, because HQ is the global scope the `*` sentinel already means. This
/// re-check at CALL TIME is what makes a session moved between companies lose
/// access immediately, rather than merely being hidden in the UI.
pub async fn tabs_for_session(pool: &SqlitePool, session_name: &str) -> sqlx::Result<Vec<TabRow>> {
    // The session's company — the containment axis. A `*` / `@company:` sentinel
    // is not a real session, so this resolves to NULL for them.
    let session_company: Option<i64> =
        sqlx::query_scalar::<_, Option<i64>>("SELECT company_id FROM sessions WHERE name = ?")
            .bind(session_name)
            .fetch_optional(pool)
            .await?
            .flatten();

    let mut grantees: Vec<String> = vec![session_name.to_string()];
    if let Some(cid) = session_company {
        grantees.push(format!("{COMPANY_PREFIX}{cid}"));
    }
    grantees.push(ALL_AGENTS.to_string());

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<TabRow> = Vec::new();
    for grantee in grantees {
        let rows = sqlx::query_as::<_, TabRow>(
            "SELECT t.* FROM browser_tabs t \
             JOIN browser_tab_grants g ON g.tab_id = t.id \
             WHERE g.grantee = ? AND g.enabled = 1 \
             ORDER BY t.pinned DESC, t.last_used_at DESC, t.id ASC",
        )
        .bind(&grantee)
        .fetch_all(pool)
        .await?;
        for row in rows {
            // §8.3 — company containment, enforced server-side, not hidden.
            if let Some(owner) = row.company_id {
                if session_company != Some(owner) {
                    continue;
                }
            }
            if seen.insert(row.id.clone()) {
                out.push(row);
            }
        }
    }
    Ok(out)
}

/// Does `session_name` hold a per-tab grant on `tab_id`, containment included?
///
/// Built on [`tabs_for_session`] on purpose: one predicate, so "what an agent can
/// list" and "what an agent can touch" cannot drift apart.
pub async fn session_may_use(
    pool: &SqlitePool,
    session_name: &str,
    tab_id: &str,
) -> sqlx::Result<bool> {
    Ok(tabs_for_session(pool, session_name)
        .await?
        .iter()
        .any(|t| t.id == tab_id))
}

/// Parse a tab's `origins` JSON into host rules, fail-closed (a malformed column
/// reads as "no host is allowed", never "every host is").
pub fn origins_of(row: &TabRow) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&row.origins).unwrap_or_default()
}

/// **Does `host` satisfy this tab's origin allowlist?** (§8.4)
///
/// A rule is either an exact host (`mail.example.com`) or a leading-dot suffix
/// the human explicitly opted into (`.example.com`, matching `example.com` and
/// any subdomain). Host-matching, NOT PSL-based — deliberately, because a PSL
/// means a new crate and this module adds none. An empty allowlist allows
/// nothing: fail closed.
pub fn host_allowed(rules: &[String], host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    rules.iter().any(|rule| {
        let rule = rule.trim().to_ascii_lowercase();
        match rule.strip_prefix('.') {
            Some(suffix) => host == suffix || host.ends_with(&format!(".{suffix}")),
            None => host == rule,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real migrated pool on a temp data dir — the same idiom
    /// `db::connectors`'s tests use, so the keepalive columns are asserted
    /// against migration 0039 itself rather than a hand-built table.
    async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-tabs-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
            swarm_reaper: Default::default(),
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
            company_isolation: Vec::new(),
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (pool, dir)
    }

    #[tokio::test]
    async fn the_keepalive_patch_fields_round_trip_and_none_leaves_the_column_alone() {
        let (pool, dir) = test_pool().await;
        let id = new_tab_id();
        create(&pool, &id, "https://example.com/", None, &[])
            .await
            .unwrap();

        // Migration defaults, unread by anything until this feature.
        let row = get(&pool, &id).await.unwrap().unwrap();
        assert_eq!(row.keepalive_enabled, 0);
        assert_eq!(row.keepalive_action, "reload");
        assert_eq!(row.last_keepalive_at, None);

        // The enable path: on, soft, blind interval, "never checked".
        update(
            &pool,
            &id,
            &TabPatch {
                keepalive_enabled: Some(true),
                keepalive_every: Some(15),
                keepalive_action: Some("soft".into()),
                keepalive_clear_stamp: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let row = get(&pool, &id).await.unwrap().unwrap();
        assert_eq!(row.keepalive_enabled, 1);
        assert_eq!(row.keepalive_every, 15);
        assert_eq!(row.keepalive_action, "soft");
        assert_eq!(row.last_keepalive_at, None);

        // A sweep stamp: the tick completed.
        update(
            &pool,
            &id,
            &TabPatch {
                keepalive_every: Some(45),
                keepalive_stamp_now: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let row = get(&pool, &id).await.unwrap().unwrap();
        assert!(row.last_keepalive_at.is_some());
        assert_eq!(row.keepalive_every, 45);
        // `None` / `false` left everything else exactly as it was.
        assert_eq!(row.keepalive_enabled, 1);
        assert_eq!(row.keepalive_action, "soft");

        // Disable keeps the learned cadence — turning it back on shows it again.
        update(
            &pool,
            &id,
            &TabPatch {
                keepalive_enabled: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let row = get(&pool, &id).await.unwrap().unwrap();
        assert_eq!(row.keepalive_enabled, 0);
        assert_eq!(row.keepalive_every, 45);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn list_keepalive_returns_only_the_enabled_rows() {
        let (pool, dir) = test_pool().await;
        let on = new_tab_id();
        let off = new_tab_id();
        create(&pool, &on, "https://on.example/", None, &[])
            .await
            .unwrap();
        create(&pool, &off, "https://off.example/", None, &[])
            .await
            .unwrap();
        assert!(list_keepalive(&pool).await.unwrap().is_empty());

        update(
            &pool,
            &on,
            &TabPatch {
                keepalive_enabled: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let rows = list_keepalive(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, on);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tab_ids_are_shape_checked_before_they_are_used_as_keys() {
        assert!(valid_tab_id(&new_tab_id()));
        assert!(valid_tab_id("tb_abc123"));
        // Everything below would otherwise reach a log line or a map key.
        assert!(!valid_tab_id("tb_"));
        assert!(!valid_tab_id(""));
        assert!(!valid_tab_id("abc123"));
        assert!(!valid_tab_id("tb_../../etc/passwd"));
        assert!(!valid_tab_id("tb_a b"));
        assert!(!valid_tab_id(&format!("tb_{}", "a".repeat(200))));
    }

    #[test]
    fn the_origin_allowlist_is_host_matching_and_fails_closed() {
        let exact = vec!["mail.example.com".to_string()];
        assert!(host_allowed(&exact, "mail.example.com"));
        assert!(host_allowed(&exact, "MAIL.EXAMPLE.COM"));
        assert!(!host_allowed(&exact, "example.com"));
        assert!(!host_allowed(&exact, "evil.mail.example.com"));
        // The classic suffix-confusion attack: a bare `endsWith` would pass this.
        assert!(!host_allowed(&exact, "notmail.example.com"));

        let suffix = vec![".example.com".to_string()];
        assert!(host_allowed(&suffix, "example.com"));
        assert!(host_allowed(&suffix, "mail.example.com"));
        assert!(!host_allowed(&suffix, "example.com.evil.test"));
        assert!(!host_allowed(&suffix, "notexample.com"));

        // Empty allowlist / empty host allow NOTHING.
        assert!(!host_allowed(&[], "example.com"));
        assert!(!host_allowed(&suffix, ""));
    }

    #[test]
    fn a_malformed_origins_column_reads_as_no_hosts_allowed() {
        let row = TabRow {
            id: "tb_x".into(),
            title: String::new(),
            url: "about:blank".into(),
            pinned: 0,
            company_id: None,
            origins: "not json".into(),
            login_state: LOGIN_UNKNOWN.into(),
            last_probe_at: None,
            keepalive_enabled: 0,
            keepalive_every: 20,
            keepalive_url: None,
            keepalive_action: "reload".into(),
            keepalive_script: None,
            last_keepalive_at: None,
            created_at: 0,
            last_used_at: 0,
        };
        assert!(origins_of(&row).is_empty());
        assert!(!host_allowed(&origins_of(&row), "example.com"));
    }
}

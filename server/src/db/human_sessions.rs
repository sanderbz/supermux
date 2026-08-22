//! Human cookie-session row access (migration `0033_human_sessions.sql`).
//!
//! The store holds ONLY a SHA-256 hash of the opaque cookie token — never the
//! raw value — so a DB read cannot mint a cookie. A session authenticates iff a
//! row matches the presented token's hash AND is neither revoked nor expired
//! (fail-closed).

use sqlx::SqlitePool;

/// A resolved, still-valid human session (join of `human_sessions` + the
/// authoritative company/role from `human_users`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct HumanSession {
    pub id: i64,
    pub user_id: i64,
    /// Company scope snapshot stored on the session row (NULL = owner/admin).
    pub company_id: Option<i64>,
    /// HMAC-SHA256 hex of the double-submit CSRF token (may be NULL for a
    /// degenerate row).
    pub csrf_hash: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub revoked_at: Option<i64>,
    /// The authoritative role from `human_users` (joined) — `owner|admin|member`.
    pub role: String,
}

/// Insert a freshly minted session. `token_hash` = SHA-256 hex of the opaque
/// cookie token; `csrf_hash` = HMAC-SHA256 hex of the CSRF token. Returns the new id.
#[allow(clippy::too_many_arguments)]
pub async fn insert(
    pool: &SqlitePool,
    user_id: i64,
    token_hash: &str,
    company_id: Option<i64>,
    csrf_hash: &str,
    created_at: i64,
    expires_at: i64,
) -> sqlx::Result<i64> {
    let res = sqlx::query(
        "INSERT INTO human_sessions \
           (user_id, token_hash, company_id, csrf_hash, created_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(token_hash)
    .bind(company_id)
    .bind(csrf_hash)
    .bind(created_at)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

/// Resolve a presented token's hash to a **valid** session, joined to the live
/// `human_users` role. Returns `None` for: no such hash, a revoked row, or an
/// expired row (`expires_at <= now`). Fail-closed by construction — the WHERE
/// clause encodes every deny condition, so a caller that gets `Some` holds a
/// genuinely live session.
pub async fn resolve_valid(
    pool: &SqlitePool,
    token_hash: &str,
    now: i64,
) -> sqlx::Result<Option<HumanSession>> {
    sqlx::query_as::<_, HumanSession>(
        "SELECT s.id, s.user_id, s.company_id, s.csrf_hash, s.created_at, \
                s.expires_at, s.revoked_at, u.role AS role \
         FROM human_sessions s \
         JOIN human_users u ON u.id = s.user_id \
         WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?",
    )
    .bind(token_hash)
    .bind(now)
    .fetch_optional(pool)
    .await
}

/// Revoke the session whose token hashes to `token_hash` (logout). Idempotent;
/// returns `true` if a live row was revoked.
pub async fn revoke_by_token_hash(
    pool: &SqlitePool,
    token_hash: &str,
    now: i64,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "UPDATE human_sessions SET revoked_at = ? \
         WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(token_hash)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Revoke every live session for a user (rotate-on-login / lock-out). Returns
/// the number of rows revoked.
pub async fn revoke_all_for_user(
    pool: &SqlitePool,
    user_id: i64,
    now: i64,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        "UPDATE human_sessions SET revoked_at = ? \
         WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

//! Human-user (colleague) row access (migration `0032_companies.sql`, activated
//! by P3a).
//!
//! `human_users` is the **allowlist** identity store: an email → company → role
//! mapping seeded by the owner. There is **no self-provisioning** — a verified
//! Google login for an email with no row here is refused (403). The single
//! seeded `owner@localhost` sentinel is rebound to the owner's real email from
//! config at startup.
//!
//! Same runtime-checked `query_as` discipline as [`crate::db::companies`] (no
//! `DATABASE_URL`, no committed `.sqlx` cache).

use serde::Serialize;
use sqlx::SqlitePool;

/// A row of the `human_users` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct HumanUser {
    pub id: i64,
    pub email: String,
    pub display_name: String,
    /// `NULL` = owner / admin-all (bypasses company scoping); `Some(id)` = a
    /// colleague fenced to exactly that company.
    pub company_id: Option<i64>,
    /// `owner` | `admin` | `member` (CHECK-constrained by 0032).
    pub role: String,
    pub created_at: i64,
}

/// Look up a human by email (case-insensitive on the stored value). The
/// allowlist gate: `None` here means the login is refused.
///
/// Google emails are lowercased before storage/compare by the caller; we also
/// compare with `LOWER(...)` defensively so a seed row typed in mixed case still
/// matches a verified lowercase email.
pub async fn get_by_email(pool: &SqlitePool, email: &str) -> sqlx::Result<Option<HumanUser>> {
    sqlx::query_as::<_, HumanUser>(
        "SELECT id, email, display_name, company_id, role, created_at \
         FROM human_users WHERE LOWER(email) = LOWER(?)",
    )
    .bind(email)
    .fetch_optional(pool)
    .await
}

/// Fetch one human by id.
pub async fn get(pool: &SqlitePool, id: i64) -> sqlx::Result<Option<HumanUser>> {
    sqlx::query_as::<_, HumanUser>(
        "SELECT id, email, display_name, company_id, role, created_at \
         FROM human_users WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

/// Rebind the seeded `owner@localhost` sentinel to the owner's real email, once,
/// at startup — per the 0032 header ("the real email is bound from config at
/// startup"). Only touches the still-sentinel owner row, so it is idempotent and
/// never clobbers an operator who already set their address. Returns `true` if a
/// row was updated.
pub async fn bind_owner_email(pool: &SqlitePool, email: &str) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "UPDATE human_users SET email = ? \
         WHERE role = 'owner' AND email = 'owner@localhost'",
    )
    .bind(email)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// A colleague row plus its derived onboarding status (Invited → Pending →
/// Active), computed by joining `human_sessions`. Used by the invite wizard's
/// `GET /api/companies/{id}/humans` roster.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct HumanInvitee {
    pub id: i64,
    pub email: String,
    pub display_name: String,
    pub company_id: Option<i64>,
    pub role: String,
    pub created_at: i64,
    /// `active` (a live, non-revoked, non-expired session exists), `pending`
    /// (logged in at least once but no live session), or `invited` (never logged
    /// in). Derived, not stored.
    pub status: String,
}

/// List every colleague fenced to `company_id`, newest first, each tagged with a
/// derived Invited/Pending/Active status (a left-join over `human_sessions`,
/// bucketed against `now`). Owner/admin rows (`company_id NULL`) are never
/// returned here — this is the per-company invite roster.
pub async fn list_by_company(
    pool: &SqlitePool,
    company_id: i64,
    now: i64,
) -> sqlx::Result<Vec<HumanInvitee>> {
    sqlx::query_as::<_, HumanInvitee>(
        "SELECT u.id, u.email, u.display_name, u.company_id, u.role, u.created_at, \
                CASE \
                  WHEN EXISTS (SELECT 1 FROM human_sessions s \
                                 WHERE s.user_id = u.id \
                                   AND s.revoked_at IS NULL AND s.expires_at > ?) \
                       THEN 'active' \
                  WHEN EXISTS (SELECT 1 FROM human_sessions s WHERE s.user_id = u.id) \
                       THEN 'pending' \
                  ELSE 'invited' \
                END AS status \
         FROM human_users u \
         WHERE u.company_id = ? \
         ORDER BY u.created_at DESC, u.id DESC",
    )
    .bind(now)
    .bind(company_id)
    .fetch_all(pool)
    .await
}

/// Delete a colleague row by id, but ONLY when it is fenced to `company_id`
/// (a defense-in-depth guard so an admin cannot revoke a row outside the company
/// they addressed, and so an owner/admin `company_id NULL` row can never be
/// deleted through the per-company invite surface). Returns `true` if a row was
/// removed. The caller revokes the user's live `human_sessions` separately.
pub async fn delete_in_company(
    pool: &SqlitePool,
    id: i64,
    company_id: i64,
) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM human_users WHERE id = ? AND company_id = ?")
        .bind(id)
        .bind(company_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Insert a colleague (used by the owner-only seeding path / tests). `role` must
/// be one of `owner|admin|member` (enforced by the 0032 CHECK). Returns the new id.
pub async fn insert(
    pool: &SqlitePool,
    email: &str,
    display_name: &str,
    company_id: Option<i64>,
    role: &str,
) -> sqlx::Result<i64> {
    let now = chrono::Utc::now().timestamp();
    let res = sqlx::query(
        "INSERT INTO human_users (email, display_name, company_id, role, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(email)
    .bind(display_name)
    .bind(company_id)
    .bind(role)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

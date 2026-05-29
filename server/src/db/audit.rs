//! Audit-log writer (migration `0007_audit.sql`).
//!
//! Every destructive HTTP call records a row. Callers write `file.put` and
//! `file.delete`, and reuse [`log`] for `session.delete`, `schedule.run`, etc.
//! The `actor` is `user` for HTTP-originated calls, `scheduler` for
//! tick-originated calls, and `agent:<name>` for cross-session calls.
//!
//! **Secret hygiene.** `detail` must never contain secret values — only
//! metadata (path, byte count, which env var). Callers are responsible for
//! keeping secrets out of the JSON they pass here.

use serde_json::Value;
use sqlx::SqlitePool;

use crate::db::runtime_state::{AuditEntry, Delegation};

/// Insert one audit row. `detail` is serialized to a JSON string column.
pub async fn log(
    pool: &SqlitePool,
    actor: &str,
    action: &str,
    target: &str,
    detail: Value,
) -> sqlx::Result<()> {
    let ts = chrono::Utc::now().timestamp();
    sqlx::query("INSERT INTO audit_log (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
        .bind(ts)
        .bind(actor)
        .bind(action)
        .bind(target)
        .bind(detail.to_string())
        .execute(pool)
        .await?;
    Ok(())
}

/// The most-recent `limit` audit rows, newest first (`GET /api/audit?limit=N`).
/// Backed by `idx_audit_ts`.
pub async fn list(pool: &SqlitePool, limit: i64) -> sqlx::Result<Vec<AuditEntry>> {
    sqlx::query_as::<_, AuditEntry>(
        "SELECT id, ts, actor, action, target, detail FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

// ── delegations (migration 0005) ─────────────────────────────────────────────

/// Record a cross-session delegation edge (`from` sent `prompt` to `to`).
/// Returns the new row id. `from`/`to` are FK-checked against `sessions(name)`.
pub async fn record_delegation(
    pool: &SqlitePool,
    from_session: &str,
    to_session: &str,
    prompt: &str,
) -> sqlx::Result<i64> {
    let ts = chrono::Utc::now().timestamp();
    let res = sqlx::query(
        "INSERT INTO delegations (from_session, to_session, prompt, ts) VALUES (?, ?, ?, ?)",
    )
    .bind(from_session)
    .bind(to_session)
    .bind(prompt)
    .bind(ts)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

/// Edges OUT of `session` (it delegated to others), newest first. Backed by
/// `idx_delegations_from`.
pub async fn delegations_out(pool: &SqlitePool, session: &str) -> sqlx::Result<Vec<Delegation>> {
    sqlx::query_as::<_, Delegation>(
        "SELECT id, from_session, to_session, prompt, ts FROM delegations \
         WHERE from_session = ? ORDER BY ts DESC, id DESC",
    )
    .bind(session)
    .fetch_all(pool)
    .await
}

/// Edges INTO `session` (others delegated to it), newest first. Backed by
/// `idx_delegations_to`.
pub async fn delegations_in(pool: &SqlitePool, session: &str) -> sqlx::Result<Vec<Delegation>> {
    sqlx::query_as::<_, Delegation>(
        "SELECT id, from_session, to_session, prompt, ts FROM delegations \
         WHERE to_session = ? ORDER BY ts DESC, id DESC",
    )
    .bind(session)
    .fetch_all(pool)
    .await
}

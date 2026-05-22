//! Audit-log writer (TECH_PLAN §6.4, migration `0007_audit.sql`).
//!
//! Every destructive HTTP call records a row. M7 writes `file.put` and
//! `file.delete`; later milestones reuse [`log`] for `session.delete`,
//! `schedule.run`, etc. The `actor` is `user` for HTTP-originated calls,
//! `scheduler` for tick-originated calls, and `agent:<name>` for cross-session
//! calls.
//!
//! **Secret hygiene (§6.4).** `detail` must never contain secret values — only
//! metadata (path, byte count, which env var). Callers are responsible for
//! keeping secrets out of the JSON they pass here.

use serde_json::Value;
use sqlx::SqlitePool;

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

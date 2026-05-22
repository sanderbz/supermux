//! Schedule row access (TECH_PLAN §3.3 `schedules`, §3.8 scheduler).
//!
//! The [`Schedule`] struct mirrors the `schedules` table 1:1 (M1 stub); M8 adds
//! the query surface the tick loop, runner, and HTTP handlers need. Runtime-
//! checked queries (`query`/`query_as`) — see the note in [`super::sessions`].
//!
//! **Idempotency (§3.8 / Codex #6).** [`claim_run_key`] inserts the
//! `(schedule_id, scheduled_for_ts)` tuple BEFORE a dispatch; a UNIQUE collision
//! (returned as `Ok(false)`) means the schedule already fired for that fire-time
//! — the caller skips, so a restart never double-fires.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::SqlitePool;

/// A row of the `schedules` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Schedule {
    pub id: String,
    pub title: String,
    pub session: String,
    pub command: String,
    pub kind: String,
    pub boot_dir: String,
    pub boot_provider: String,
    pub boot_worktree: i64,
    pub sched_type: String,
    pub recurrence: Option<String>,
    pub run_at: Option<String>,
    pub next_run: Option<String>,
    pub last_run: Option<String>,
    pub enabled: i64,
    pub run_count: i64,
    pub schedule_expr: Option<String>,
    pub watch: i64,
    pub watch_timeout: i64,
    pub done_pattern: Option<String>,
    pub done_action: String,
    pub created: i64,
    pub updated: i64,
    pub deleted: Option<i64>,
}

/// A row of `schedule_runs` (the per-fire ledger).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct ScheduleRun {
    pub id: i64,
    pub schedule_id: String,
    pub ran_at: i64,
    pub status: String,
    pub note: String,
}

/// A run joined with its schedule title (the cross-schedule `/runs` feed).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct RunSummary {
    pub id: i64,
    pub schedule_id: String,
    pub ran_at: i64,
    pub status: String,
    pub note: String,
    pub title: String,
}

// ── reads ─────────────────────────────────────────────────────────────────────

/// All non-deleted schedules, newest first.
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Schedule>> {
    sqlx::query_as::<_, Schedule>(
        "SELECT * FROM schedules WHERE deleted IS NULL ORDER BY created DESC",
    )
    .fetch_all(pool)
    .await
}

/// One non-deleted schedule by id.
pub async fn get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Schedule>> {
    sqlx::query_as::<_, Schedule>("SELECT * FROM schedules WHERE id = ? AND deleted IS NULL")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// Enabled, non-deleted schedules with a non-null `next_run`. The tick loop
/// parses `next_run` and compares to `now` in Rust (avoiding RFC3339 string
/// ordering pitfalls); at user scale the full scan is cheap.
pub async fn enabled_with_next(pool: &SqlitePool) -> sqlx::Result<Vec<Schedule>> {
    sqlx::query_as::<_, Schedule>(
        "SELECT * FROM schedules
         WHERE deleted IS NULL AND enabled = 1 AND next_run IS NOT NULL",
    )
    .fetch_all(pool)
    .await
}

// ── writes ────────────────────────────────────────────────────────────────────

/// Insert a fully-formed schedule row (the scheduler builds it after parsing).
pub async fn insert(pool: &SqlitePool, s: &Schedule) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO schedules
            (id, title, session, command, kind, boot_dir, boot_provider, boot_worktree,
             sched_type, recurrence, run_at, next_run, last_run, enabled, run_count,
             schedule_expr, watch, watch_timeout, done_pattern, done_action,
             created, updated, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&s.id)
    .bind(&s.title)
    .bind(&s.session)
    .bind(&s.command)
    .bind(&s.kind)
    .bind(&s.boot_dir)
    .bind(&s.boot_provider)
    .bind(s.boot_worktree)
    .bind(&s.sched_type)
    .bind(&s.recurrence)
    .bind(&s.run_at)
    .bind(&s.next_run)
    .bind(&s.last_run)
    .bind(s.enabled)
    .bind(s.run_count)
    .bind(&s.schedule_expr)
    .bind(s.watch)
    .bind(s.watch_timeout)
    .bind(&s.done_pattern)
    .bind(&s.done_action)
    .bind(s.created)
    .bind(s.updated)
    .bind(s.deleted)
    .execute(pool)
    .await?;
    Ok(())
}

/// Soft-delete (`deleted = now`). Returns true if a row was affected.
pub async fn soft_delete(pool: &SqlitePool, id: &str) -> sqlx::Result<bool> {
    let now = Utc::now().timestamp();
    let res = sqlx::query("UPDATE schedules SET deleted = ?, updated = ? WHERE id = ? AND deleted IS NULL")
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Persist a real fire: bump `last_run`/`run_count`, set the recomputed
/// `next_run` (NULL disables a finished one-shot).
pub async fn record_fire(
    pool: &SqlitePool,
    id: &str,
    fired_at: DateTime<Utc>,
    next_run: Option<DateTime<Utc>>,
) -> sqlx::Result<()> {
    let now = Utc::now().timestamp();
    let next_str = next_run.map(|d| d.to_rfc3339());
    sqlx::query(
        "UPDATE schedules
            SET last_run = ?, run_count = run_count + 1, updated = ?, next_run = ?,
                enabled = (CASE WHEN ? IS NULL THEN 0 ELSE enabled END)
          WHERE id = ?",
    )
    .bind(fired_at.to_rfc3339())
    .bind(now)
    .bind(&next_str)
    .bind(&next_str)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Manual "run now": bump `last_run`/`run_count` but DO NOT touch `next_run`
/// (feature-extract §4.7 — the tick still owns the schedule's cadence).
pub async fn record_manual(pool: &SqlitePool, id: &str, fired_at: DateTime<Utc>) -> sqlx::Result<()> {
    let now = Utc::now().timestamp();
    sqlx::query(
        "UPDATE schedules SET last_run = ?, run_count = run_count + 1, updated = ? WHERE id = ?",
    )
    .bind(fired_at.to_rfc3339())
    .bind(now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Advance `next_run` WITHOUT firing (missed-window catch-up). NULL disables a
/// one-shot whose window was missed.
pub async fn advance_next(
    pool: &SqlitePool,
    id: &str,
    next_run: Option<DateTime<Utc>>,
) -> sqlx::Result<()> {
    let now = Utc::now().timestamp();
    let next_str = next_run.map(|d| d.to_rfc3339());
    sqlx::query(
        "UPDATE schedules
            SET next_run = ?, updated = ?,
                enabled = (CASE WHEN ? IS NULL THEN 0 ELSE enabled END)
          WHERE id = ?",
    )
    .bind(&next_str)
    .bind(now)
    .bind(&next_str)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Set `enabled` (the watch-mode `disable` action).
pub async fn set_enabled(pool: &SqlitePool, id: &str, enabled: bool) -> sqlx::Result<()> {
    let now = Utc::now().timestamp();
    sqlx::query("UPDATE schedules SET enabled = ?, updated = ? WHERE id = ?")
        .bind(enabled as i64)
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Apply a PATCH from the HTTP layer. The caller pre-computes `next_run` when the
/// schedule expression changed; passing `None` for a field leaves it untouched.
#[allow(clippy::too_many_arguments)]
pub struct SchedulePatch {
    pub title: Option<String>,
    pub session: Option<String>,
    pub command: Option<String>,
    pub kind: Option<String>,
    pub enabled: Option<bool>,
    pub watch: Option<bool>,
    pub watch_timeout: Option<i64>,
    pub done_pattern: Option<String>,
    pub done_action: Option<String>,
    pub schedule_expr: Option<String>,
    pub next_run: Option<DateTime<Utc>>,
    pub sched_type: Option<String>,
}

/// Persist a [`SchedulePatch`]. Builds the SET clause dynamically so unset
/// fields are never overwritten.
pub async fn patch(pool: &SqlitePool, id: &str, p: &SchedulePatch) -> sqlx::Result<()> {
    let mut sets: Vec<&str> = Vec::new();
    if p.title.is_some() {
        sets.push("title = ?");
    }
    if p.session.is_some() {
        sets.push("session = ?");
    }
    if p.command.is_some() {
        sets.push("command = ?");
    }
    if p.kind.is_some() {
        sets.push("kind = ?");
    }
    if p.enabled.is_some() {
        sets.push("enabled = ?");
    }
    if p.watch.is_some() {
        sets.push("watch = ?");
    }
    if p.watch_timeout.is_some() {
        sets.push("watch_timeout = ?");
    }
    if p.done_pattern.is_some() {
        sets.push("done_pattern = ?");
    }
    if p.done_action.is_some() {
        sets.push("done_action = ?");
    }
    if p.schedule_expr.is_some() {
        sets.push("schedule_expr = ?");
    }
    if p.next_run.is_some() {
        sets.push("next_run = ?");
    }
    if p.sched_type.is_some() {
        sets.push("sched_type = ?");
    }
    sets.push("updated = ?");

    let sql = format!("UPDATE schedules SET {} WHERE id = ?", sets.join(", "));
    let mut q = sqlx::query(&sql);
    if let Some(v) = &p.title {
        q = q.bind(v);
    }
    if let Some(v) = &p.session {
        q = q.bind(v);
    }
    if let Some(v) = &p.command {
        q = q.bind(v);
    }
    if let Some(v) = &p.kind {
        q = q.bind(v);
    }
    if let Some(v) = p.enabled {
        q = q.bind(v as i64);
    }
    if let Some(v) = p.watch {
        q = q.bind(v as i64);
    }
    if let Some(v) = p.watch_timeout {
        q = q.bind(v);
    }
    if let Some(v) = &p.done_pattern {
        q = q.bind(v);
    }
    if let Some(v) = &p.done_action {
        q = q.bind(v);
    }
    if let Some(v) = &p.schedule_expr {
        q = q.bind(v);
    }
    if let Some(v) = p.next_run {
        q = q.bind(v.to_rfc3339());
    }
    if let Some(v) = &p.sched_type {
        q = q.bind(v);
    }
    q = q.bind(Utc::now().timestamp());
    q = q.bind(id);
    q.execute(pool).await?;
    Ok(())
}

// ── run ledger ──────────────────────────────────────────────────────────────

/// Append a `schedule_runs` row. Returns the new row id.
pub async fn insert_run(
    pool: &SqlitePool,
    schedule_id: &str,
    ran_at: i64,
    status: &str,
    note: &str,
) -> sqlx::Result<i64> {
    let res = sqlx::query(
        "INSERT INTO schedule_runs (schedule_id, ran_at, status, note) VALUES (?, ?, ?, ?)",
    )
    .bind(schedule_id)
    .bind(ran_at)
    .bind(status)
    .bind(note)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

/// Recent runs for one schedule, newest first.
pub async fn runs_for(pool: &SqlitePool, schedule_id: &str, limit: i64) -> sqlx::Result<Vec<ScheduleRun>> {
    sqlx::query_as::<_, ScheduleRun>(
        "SELECT id, schedule_id, ran_at, status, note
           FROM schedule_runs WHERE schedule_id = ? ORDER BY ran_at DESC, id DESC LIMIT ?",
    )
    .bind(schedule_id)
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// Recent runs across all schedules, joined with the schedule title.
pub async fn recent_runs(pool: &SqlitePool, limit: i64) -> sqlx::Result<Vec<RunSummary>> {
    sqlx::query_as::<_, RunSummary>(
        "SELECT r.id, r.schedule_id, r.ran_at, r.status, r.note,
                COALESCE(s.title, '') AS title
           FROM schedule_runs r
           LEFT JOIN schedules s ON s.id = r.schedule_id
          ORDER BY r.ran_at DESC, r.id DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

// ── idempotency ─────────────────────────────────────────────────────────────

/// Claim the `(schedule_id, scheduled_for_ts)` fire-key. Returns `true` if this
/// caller won the claim (proceed) and `false` if it was already taken (a
/// duplicate dispatch — skip). `INSERT OR IGNORE` makes the UNIQUE collision a
/// 0-row no-op rather than an error.
pub async fn claim_run_key(
    pool: &SqlitePool,
    schedule_id: &str,
    scheduled_for_ts: i64,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "INSERT OR IGNORE INTO schedule_run_keys (schedule_id, scheduled_for_ts, fired_at)
         VALUES (?, ?, ?)",
    )
    .bind(schedule_id)
    .bind(scheduled_for_ts)
    .bind(Utc::now().timestamp())
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

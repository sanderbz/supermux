//! Schedule row access (TECH_PLAN §3.3 `schedules`).
//!
//! Stub for M1 — the `Schedule` struct mirrors the table so M8 can attach
//! queries without redefining it. Runtime-checked queries — see the note in
//! [`super::sessions`].

use serde::Serialize;

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

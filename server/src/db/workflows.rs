//! Workflow row access (`workflows`, `workflow_steps`, `workflow_runs`,
//! `workflow_step_runs`, `workflow_run_keys`).
//!
//! The row layer for Workflows v1. The structs mirror the tables 1:1 and the
//! query surface is what the tick loop, engine, and HTTP handlers need — no
//! handler above this module writes SQL. Runtime-checked queries
//! (`query`/`query_as`) — see the note in [`super::sessions`].
//!
//! **Idempotency.** [`claim_run_key`] inserts the
//! `(workflow_id, scheduled_for_ts)` tuple BEFORE a dispatch; a UNIQUE collision
//! (returned as `Ok(false)`) means the workflow already fired for that fire-time
//! — the caller skips, so a restart never double-fires. This is the same
//! contract `schedule_run_keys` carried, re-keyed by `workflow_id`, and 0038
//! ports the live tuples across so a window straddling the upgrade stays claimed.
//!
//! **`company_id` is derived, never taken from a caller** ([`derive_company_id`]).
//! It is a cache of `sessions.company_id` re-read on every write to the row, the
//! same rule `sessions::create` applies to `CreateInput.company_id`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// A row of the `workflows` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Workflow {
    pub id: String,
    pub title: String,
    /// The owning bot's slug. Deliberately unkeyed TEXT (spec §2.4) — which is
    /// why the four session cascades at the bottom of this file exist.
    pub session: String,
    /// DERIVED cache of `sessions.company_id`. NULL = the main bot.
    pub company_id: Option<i64>,
    pub enabled: i64,
    /// `'manual'` | `'once'` | `'recurring'`.
    pub trigger_kind: String,
    /// NULL iff `trigger_kind = 'manual'` (enforced by a CHECK in 0038).
    pub schedule_expr: Option<String>,
    pub next_run: Option<String>,
    pub last_run: Option<String>,
    pub run_count: i64,
    /// Typed JSON — `workflows::complete::CompletionAction`. Never free text.
    pub on_complete: String,
    pub created: i64,
    pub updated: i64,
    pub deleted: Option<i64>,
}

/// A row of `workflow_steps`. Steps are ORDERED ROWS, not a JSON column, so a
/// step run can point at a durable step identity (spec §2.3).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct WorkflowStep {
    pub id: String,
    pub workflow_id: String,
    pub position: i64,
    pub title: String,
    /// The bare slash line. Delivered as its OWN submission — never concatenated
    /// with `prompt`, or Claude stops executing it as a slash command.
    pub command: String,
    pub prompt: String,
    /// JSON `[{path,name,size,mime}]`, absolute paths under `<data_dir>/uploads`.
    pub files: String,
    /// JSON `["gmail","github"]` — connector ids the bot should prefer.
    pub connectors: String,
    pub timeout_secs: i64,
    pub on_complete: String,
    pub created: i64,
    pub updated: i64,
}

/// What a writer supplies for one step. Ids and positions are the layer's own.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct StepInput {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub prompt: String,
    /// JSON array as a string; `[]` when absent.
    #[serde(default)]
    pub files: Option<String>,
    #[serde(default)]
    pub connectors: Option<String>,
    #[serde(default)]
    pub timeout_secs: Option<i64>,
    #[serde(default)]
    pub on_complete: Option<String>,
}

/// A row of `workflow_runs` (one chain execution).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct WorkflowRun {
    pub id: i64,
    pub workflow_id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub trigger: String,
    pub status: String,
    pub current_step: i64,
    pub note: String,
    pub heartbeat: i64,
}

/// A row of `workflow_step_runs` (one step inside a run).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct WorkflowStepRun {
    pub id: i64,
    pub run_id: i64,
    /// Deliberately NOT a foreign key: a step may be deleted after it ran, and
    /// the history of what actually happened must survive that edit.
    pub step_id: String,
    pub position: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub signal: String,
    pub preview: String,
    pub note: String,
}

/// A run joined with its workflow title (the cross-workflow activity feed).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct RunSummary {
    pub id: i64,
    pub workflow_id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub note: String,
    pub title: String,
    pub company_id: Option<i64>,
}

/// A workflow with its ordered steps — what every read handler returns.
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowWithSteps {
    #[serde(flatten)]
    pub workflow: Workflow,
    pub steps: Vec<WorkflowStep>,
}

/// A PATCH from the HTTP layer. `session` and `company_id` are deliberately
/// absent: a workflow cannot be reassigned to another bot (and therefore not to
/// another company) after it is created.
#[derive(Debug, Clone, Default)]
pub struct WorkflowPatch {
    pub title: Option<String>,
    pub enabled: Option<bool>,
    pub trigger_kind: Option<String>,
    pub schedule_expr: Option<String>,
    pub next_run: Option<Option<DateTime<Utc>>>,
    pub on_complete: Option<String>,
}

/// Fresh workflow / step ids. Ported rows keep their `SCHED-…` id (spec §7.2);
/// everything created after the upgrade gets one of these.
pub fn new_workflow_id() -> String {
    format!("WF-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

pub fn new_step_id() -> String {
    format!("WS-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

// ── reads ─────────────────────────────────────────────────────────────────────

/// All non-deleted workflows, newest first.
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Workflow>> {
    sqlx::query_as::<_, Workflow>(
        "SELECT * FROM workflows WHERE deleted IS NULL ORDER BY created DESC",
    )
    .fetch_all(pool)
    .await
}

/// Non-deleted workflows for one bot, newest first.
pub async fn list_for_session(pool: &SqlitePool, session: &str) -> sqlx::Result<Vec<Workflow>> {
    sqlx::query_as::<_, Workflow>(
        "SELECT * FROM workflows WHERE session = ? AND deleted IS NULL ORDER BY created DESC",
    )
    .bind(session)
    .fetch_all(pool)
    .await
}

/// One non-deleted workflow by id.
pub async fn get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Workflow>> {
    sqlx::query_as::<_, Workflow>("SELECT * FROM workflows WHERE id = ? AND deleted IS NULL")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// The ordered step list of one workflow.
pub async fn steps_for(pool: &SqlitePool, workflow_id: &str) -> sqlx::Result<Vec<WorkflowStep>> {
    sqlx::query_as::<_, WorkflowStep>(
        "SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position",
    )
    .bind(workflow_id)
    .fetch_all(pool)
    .await
}

/// One workflow plus its ordered steps.
pub async fn get_with_steps(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<WorkflowWithSteps>> {
    let Some(workflow) = get(pool, id).await? else { return Ok(None) };
    let steps = steps_for(pool, id).await?;
    Ok(Some(WorkflowWithSteps { workflow, steps }))
}

/// Enabled, non-deleted workflows with a non-null `next_run`. The tick loop
/// parses `next_run` and compares to `now` in Rust (avoiding RFC3339 string
/// ordering pitfalls); at user scale the full scan is cheap.
pub async fn enabled_with_next(pool: &SqlitePool) -> sqlx::Result<Vec<Workflow>> {
    sqlx::query_as::<_, Workflow>(
        "SELECT * FROM workflows
         WHERE deleted IS NULL AND enabled = 1 AND next_run IS NOT NULL",
    )
    .fetch_all(pool)
    .await
}

/// How many live workflows a bot owns (the per-session cap check).
pub async fn count_for_session(pool: &SqlitePool, session: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM workflows WHERE session = ? AND deleted IS NULL",
    )
    .bind(session)
    .fetch_one(pool)
    .await
}

/// Who created a workflow, from the ledger: the actor of its first create row
/// (`workflow.create`, or `schedule.create` for a row ported from the scheduler,
/// which kept its `SCHED-…` id). `None` when the ledger has no such row.
pub async fn creator(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar::<_, String>(
        "SELECT actor FROM audit_log
         WHERE target = ? AND action IN ('workflow.create', 'schedule.create')
         ORDER BY id LIMIT 1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

/// The company a bot belongs to. NULL for the main bot AND for a session that
/// does not exist — a missing session is not an error here, it is a NULL.
pub async fn derive_company_id(pool: &SqlitePool, session: &str) -> sqlx::Result<Option<i64>> {
    Ok(sqlx::query_scalar::<_, Option<i64>>("SELECT company_id FROM sessions WHERE name = ?")
        .bind(session)
        .fetch_optional(pool)
        .await?
        .flatten())
}

// ── writes ────────────────────────────────────────────────────────────────────

/// Insert a fully-formed workflow row and return it as persisted.
///
/// `w.company_id` is IGNORED: it is re-derived from `sessions` here, so no
/// caller — HTTP body, hook, or test — can place a workflow in a company its
/// bot does not belong to (spec §2.5).
pub async fn insert(pool: &SqlitePool, w: &Workflow) -> sqlx::Result<Workflow> {
    let company_id = derive_company_id(pool, &w.session).await?;
    sqlx::query(
        "INSERT INTO workflows
            (id, title, session, company_id, enabled, trigger_kind, schedule_expr,
             next_run, last_run, run_count, on_complete, created, updated, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&w.id)
    .bind(&w.title)
    .bind(&w.session)
    .bind(company_id)
    .bind(w.enabled)
    .bind(&w.trigger_kind)
    .bind(&w.schedule_expr)
    .bind(&w.next_run)
    .bind(&w.last_run)
    .bind(w.run_count)
    .bind(&w.on_complete)
    .bind(w.created)
    .bind(w.updated)
    .bind(w.deleted)
    .execute(pool)
    .await?;
    Ok(Workflow { company_id, ..w.clone() })
}

/// Replace a workflow's ordered step list ATOMICALLY.
///
/// The whole list is rewritten inside one transaction so positions are always
/// contiguous and no reader ever sees a half-saved order. Deleted steps keep
/// their `workflow_step_runs` history: `step_id` is deliberately not a foreign
/// key, so "what ran" survives "what the workflow says now" (spec §2.3).
pub async fn replace_steps(
    pool: &SqlitePool,
    workflow_id: &str,
    steps: &[StepInput],
) -> sqlx::Result<Vec<WorkflowStep>> {
    let now = Utc::now().timestamp();
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM workflow_steps WHERE workflow_id = ?")
        .bind(workflow_id)
        .execute(&mut *tx)
        .await?;
    for (i, s) in steps.iter().enumerate() {
        sqlx::query(
            "INSERT INTO workflow_steps
                (id, workflow_id, position, title, command, prompt, files, connectors,
                 timeout_secs, on_complete, created, updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(new_step_id())
        .bind(workflow_id)
        .bind(i as i64)
        .bind(&s.title)
        .bind(&s.command)
        .bind(&s.prompt)
        .bind(s.files.clone().unwrap_or_else(|| "[]".into()))
        .bind(s.connectors.clone().unwrap_or_else(|| "[]".into()))
        .bind(s.timeout_secs.filter(|t| *t > 0).unwrap_or(DEFAULT_STEP_TIMEOUT))
        .bind(s.on_complete.clone().unwrap_or_else(|| r#"{"kind":"none"}"#.into()))
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE workflows SET updated = ? WHERE id = ?")
        .bind(now)
        .bind(workflow_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    steps_for(pool, workflow_id).await
}

/// The per-step done deadline when a writer does not name one. Today's
/// `scheduler::DEFAULT_WATCH_TIMEOUT`, carried over verbatim.
pub const DEFAULT_STEP_TIMEOUT: i64 = 1800;

/// Persist a [`WorkflowPatch`]. Builds the SET clause dynamically so unset
/// fields are never overwritten. `session` and `company_id` are not patchable.
pub async fn patch(pool: &SqlitePool, id: &str, p: &WorkflowPatch) -> sqlx::Result<()> {
    let mut sets: Vec<&str> = Vec::new();
    if p.title.is_some() {
        sets.push("title = ?");
    }
    if p.enabled.is_some() {
        sets.push("enabled = ?");
    }
    if p.trigger_kind.is_some() {
        sets.push("trigger_kind = ?");
    }
    if p.schedule_expr.is_some() {
        sets.push("schedule_expr = ?");
    }
    if p.next_run.is_some() {
        sets.push("next_run = ?");
    }
    if p.on_complete.is_some() {
        sets.push("on_complete = ?");
    }
    if sets.is_empty() {
        return Ok(());
    }
    sets.push("updated = ?");
    let sql = format!("UPDATE workflows SET {} WHERE id = ?", sets.join(", "));
    let mut q = sqlx::query(&sql);
    if let Some(v) = &p.title {
        q = q.bind(v);
    }
    if let Some(v) = p.enabled {
        q = q.bind(v as i64);
    }
    if let Some(v) = &p.trigger_kind {
        q = q.bind(v);
    }
    if let Some(v) = &p.schedule_expr {
        q = q.bind(v);
    }
    if let Some(v) = &p.next_run {
        q = q.bind(v.map(|d| d.to_rfc3339()));
    }
    if let Some(v) = &p.on_complete {
        q = q.bind(v);
    }
    q.bind(Utc::now().timestamp()).bind(id).execute(pool).await?;
    Ok(())
}

/// Soft-delete one workflow. A hard delete would cascade the run ledger away
/// with it, and "what this bot did last month" is exactly what the log is for.
pub async fn soft_delete(pool: &SqlitePool, id: &str) -> sqlx::Result<u64> {
    let now = Utc::now().timestamp();
    let res = sqlx::query("UPDATE workflows SET deleted = ?, updated = ? WHERE id = ? AND deleted IS NULL")
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Set `enabled` (the `disable` completion action, and the list toggle).
pub async fn set_enabled(pool: &SqlitePool, id: &str, enabled: bool) -> sqlx::Result<()> {
    let now = Utc::now().timestamp();
    sqlx::query("UPDATE workflows SET enabled = ?, updated = ? WHERE id = ?")
        .bind(enabled as i64)
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
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
        "UPDATE workflows
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
/// — the tick still owns the workflow's cadence.
pub async fn record_manual(pool: &SqlitePool, id: &str, fired_at: DateTime<Utc>) -> sqlx::Result<()> {
    let now = Utc::now().timestamp();
    sqlx::query(
        "UPDATE workflows SET last_run = ?, run_count = run_count + 1, updated = ? WHERE id = ?",
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
        "UPDATE workflows
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

// ── the run ledger ────────────────────────────────────────────────────────────

/// How many runs a single workflow keeps. Beyond this, the oldest is dropped
/// on insert: nobody scrolls a nightly job's 400th entry, and a workflow firing
/// `every 5m` would write ~105k rows a year into a table with no retention
/// policy at all — in a database that is one SQLite file read on every page load.
pub const RUN_HISTORY_KEEP: i64 = 20;

/// Append a `workflow_runs` row, then prune THIS workflow's history to the
/// newest [`RUN_HISTORY_KEEP`]. Returns the new run id.
///
/// Pruned ON INSERT rather than by a sweeper: the table only grows here, so
/// this is the one place that can keep the invariant without a second moving
/// part. The delete is scoped to `workflow_id`, so two workflows' histories are
/// independent and a busy one cannot evict a quiet one's rows.
pub async fn insert_run(
    pool: &SqlitePool,
    workflow_id: &str,
    started_at: i64,
    trigger: &str,
    status: &str,
    note: &str,
) -> sqlx::Result<i64> {
    let finished_at = (status != "running").then_some(started_at);
    let res = sqlx::query(
        "INSERT INTO workflow_runs
            (workflow_id, started_at, finished_at, trigger, status, current_step, note, heartbeat)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(workflow_id)
    .bind(started_at)
    .bind(finished_at)
    .bind(trigger)
    .bind(status)
    .bind(note)
    .bind(started_at)
    .execute(pool)
    .await?;
    // Ordered by the SAME key `runs_for` reads by (`started_at DESC, id DESC`),
    // so what survives is exactly what the history would have shown. A prune
    // that failed must not fail the run it is recording — the fire happened,
    // and the ledger row for it is already in.
    if let Err(e) = sqlx::query(
        "DELETE FROM workflow_runs
          WHERE workflow_id = ?
            AND id NOT IN (
                SELECT id FROM workflow_runs
                 WHERE workflow_id = ?
                 ORDER BY started_at DESC, id DESC
                 LIMIT ?
            )",
    )
    .bind(workflow_id)
    .bind(workflow_id)
    .bind(RUN_HISTORY_KEEP)
    .execute(pool)
    .await
    {
        tracing::warn!(workflow = %workflow_id, error = %e, "run-history prune failed");
    }
    Ok(res.last_insert_rowid())
}

/// Open a `running` run for a chain that is starting. Same prune rule.
pub async fn open_run(pool: &SqlitePool, workflow_id: &str, trigger: &str) -> sqlx::Result<i64> {
    insert_run(pool, workflow_id, Utc::now().timestamp(), trigger, "running", "").await
}

/// Close a run: terminal status, note, `finished_at`.
pub async fn close_run(pool: &SqlitePool, run_id: i64, status: &str, note: &str) -> sqlx::Result<()> {
    let now = Utc::now().timestamp();
    sqlx::query(
        "UPDATE workflow_runs SET status = ?, note = ?, finished_at = ?, heartbeat = ? WHERE id = ?",
    )
    .bind(status)
    .bind(note)
    .bind(now)
    .bind(now)
    .bind(run_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Bump the liveness stamp the reaper reads. Called on every advance.
pub async fn bump_heartbeat(pool: &SqlitePool, run_id: i64, current_step: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE workflow_runs SET heartbeat = ?, current_step = ? WHERE id = ?")
        .bind(Utc::now().timestamp())
        .bind(current_step)
        .bind(run_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Open a step run. `preview` is the DELIVERED prompt as the user sees it —
/// never the wrapper, the footer, or the attachment sentence.
pub async fn open_step_run(
    pool: &SqlitePool,
    run_id: i64,
    step_id: &str,
    position: i64,
    preview: &str,
) -> sqlx::Result<i64> {
    let res = sqlx::query(
        "INSERT INTO workflow_step_runs
            (run_id, step_id, position, started_at, status, signal, preview, note)
         VALUES (?, ?, ?, ?, 'running', '', ?, '')",
    )
    .bind(run_id)
    .bind(step_id)
    .bind(position)
    .bind(Utc::now().timestamp())
    .bind(preview)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

/// Close a step run with the signal that ended it.
pub async fn close_step_run(
    pool: &SqlitePool,
    step_run_id: i64,
    status: &str,
    signal: &str,
    note: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE workflow_step_runs
            SET status = ?, signal = ?, note = ?, finished_at = ?
          WHERE id = ?",
    )
    .bind(status)
    .bind(signal)
    .bind(note)
    .bind(Utc::now().timestamp())
    .bind(step_run_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Recent runs for one workflow, newest first.
pub async fn runs_for(pool: &SqlitePool, workflow_id: &str, limit: i64) -> sqlx::Result<Vec<WorkflowRun>> {
    sqlx::query_as::<_, WorkflowRun>(
        "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
    )
    .bind(workflow_id)
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// One run row by id — what `complete::fire` is handed after the engine closes
/// a run and before it fires the workflow's typed completion action.
pub async fn get_run(pool: &SqlitePool, run_id: i64) -> sqlx::Result<Option<WorkflowRun>> {
    sqlx::query_as::<_, WorkflowRun>("SELECT * FROM workflow_runs WHERE id = ?")
        .bind(run_id)
        .fetch_optional(pool)
        .await
}

/// The step rows of one run, in order.
pub async fn step_runs_for(pool: &SqlitePool, run_id: i64) -> sqlx::Result<Vec<WorkflowStepRun>> {
    sqlx::query_as::<_, WorkflowStepRun>(
        "SELECT * FROM workflow_step_runs WHERE run_id = ? ORDER BY position, id",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await
}

/// Recent runs across all workflows, joined with the title and the company the
/// SSE frame will be stamped with.
pub async fn recent_runs(pool: &SqlitePool, limit: i64) -> sqlx::Result<Vec<RunSummary>> {
    sqlx::query_as::<_, RunSummary>(
        "SELECT r.id, r.workflow_id, r.started_at, r.finished_at, r.status, r.note,
                COALESCE(w.title, '') AS title, w.company_id AS company_id
           FROM workflow_runs r
           LEFT JOIN workflows w ON w.id = r.workflow_id
          ORDER BY r.started_at DESC, r.id DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// The in-flight run of one workflow, if any. This is the §3.2 rule-2 guard:
/// a workflow with a run already going does not start a second chain.
pub async fn running_for(pool: &SqlitePool, workflow_id: &str) -> sqlx::Result<Option<WorkflowRun>> {
    sqlx::query_as::<_, WorkflowRun>(
        "SELECT * FROM workflow_runs
          WHERE workflow_id = ? AND status = 'running'
          ORDER BY started_at DESC, id DESC LIMIT 1",
    )
    .bind(workflow_id)
    .fetch_optional(pool)
    .await
}

/// Runs still marked `running` whose heartbeat is older than the in-flight
/// step's own timeout plus a minute of grace — i.e. runs whose in-memory
/// watcher died with the process. The reaper turns these into an honest
/// `interrupted` so the workflow's next cadence is not blocked forever (§3.6).
///
/// A run with no open step run falls back to [`DEFAULT_STEP_TIMEOUT`].
pub async fn stale_running(pool: &SqlitePool, now: i64) -> sqlx::Result<Vec<WorkflowRun>> {
    sqlx::query_as::<_, WorkflowRun>(
        "SELECT r.* FROM workflow_runs r
          WHERE r.status = 'running'
            AND r.heartbeat < ? - (
                COALESCE((SELECT st.timeout_secs
                            FROM workflow_step_runs sr
                            JOIN workflow_steps st ON st.id = sr.step_id
                           WHERE sr.run_id = r.id AND sr.finished_at IS NULL
                           ORDER BY sr.position DESC LIMIT 1), ?) + 60)
          ORDER BY r.id",
    )
    .bind(now)
    .bind(DEFAULT_STEP_TIMEOUT)
    .fetch_all(pool)
    .await
}

// ── idempotency ─────────────────────────────────────────────────────────────

/// Claim the `(workflow_id, scheduled_for_ts)` fire-key. Returns `true` if this
/// caller won the claim (proceed) and `false` if it was already taken (a
/// duplicate dispatch — skip). `INSERT OR IGNORE` makes the UNIQUE collision a
/// 0-row no-op rather than an error.
pub async fn claim_run_key(
    pool: &SqlitePool,
    workflow_id: &str,
    scheduled_for_ts: i64,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "INSERT OR IGNORE INTO workflow_run_keys (workflow_id, scheduled_for_ts, fired_at)
         VALUES (?, ?, ?)",
    )
    .bind(workflow_id)
    .bind(scheduled_for_ts)
    .bind(Utc::now().timestamp())
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// When the `(workflow_id, scheduled_for_ts)` key was claimed (unix seconds), or
/// `None` when nobody ever claimed it.
///
/// A lost claim only tells the caller that SOMEONE holds the key; it does not
/// say whether that holder is still alive. Since `next_run` is advanced by the
/// holder alone, a key whose claimant died leaves the workflow due forever — so
/// the tick needs to read the key back, not just fail to take it. `fired_at` has
/// been written by [`claim_run_key`] since 0038 and was never read until now.
pub async fn run_key_fired_at(
    pool: &SqlitePool,
    workflow_id: &str,
    scheduled_for_ts: i64,
) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar::<_, i64>(
        "SELECT fired_at FROM workflow_run_keys WHERE workflow_id = ? AND scheduled_for_ts = ?",
    )
    .bind(workflow_id)
    .bind(scheduled_for_ts)
    .fetch_optional(pool)
    .await
}

// ── session cascades ────────────────────────────────────────────────────────
//
// `workflows.session` has NO foreign key (0038, deliberately — spec §2.4), so
// deferred-FK cascade does not reach these rows. Every session lifecycle edge
// therefore has to call into this section by hand. The three functions below
// are the whole contract; `db::sessions` and `sessions::lifecycle` are their
// only callers.

/// Soft-delete every live workflow of a session.
///
/// **Post-mortem (carried over from `db::schedules::soft_delete_for_session`).**
/// `session` is an unkeyed TEXT column, so deleting a session used to leave its
/// jobs behind — pointed at a name that no longer resolved, firing into
/// nothing, and reappearing under a *new* session that happened to reuse the
/// slug. The cascade is manual because the column is deliberately unkeyed, and
/// it is a SOFT delete because a hard one would take the run ledger with it
/// ("what this bot did last month" is exactly what the log is for).
///
/// Deliberately NOT called on archive: archiving *pauses* workflows as a pure
/// function of `sessions.archived`, so unarchive resumes them with nothing to
/// restore.
pub async fn soft_delete_for_session(pool: &SqlitePool, session: &str) -> sqlx::Result<u64> {
    let now = Utc::now().timestamp();
    let res = sqlx::query(
        "UPDATE workflows SET deleted = ?, updated = ?
         WHERE session = ? AND deleted IS NULL",
    )
    .bind(now)
    .bind(now)
    .bind(session)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// Re-point every workflow of `from` at `to` (session rename).
pub async fn rename_session(pool: &SqlitePool, from: &str, to: &str) -> sqlx::Result<u64> {
    let now = Utc::now().timestamp();
    let company_id = derive_company_id(pool, to).await?;
    let res = sqlx::query(
        "UPDATE workflows SET session = ?, company_id = ?, updated = ? WHERE session = ?",
    )
    .bind(to)
    .bind(company_id)
    .bind(now)
    .bind(from)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// Copy every live workflow from `src` onto `dst`, WITH ITS STEPS, DISABLED.
///
/// Returns how many workflows were copied.
///
/// **Why they are copied at all.** `duplicate` cloned no child row of any kind,
/// so "duplicate this agent" silently dropped its scheduled jobs — the copy
/// looked identical and behaved differently, which is the worst kind of wrong.
///
/// **Why the steps come too.** A workflow IS its ordered steps. A copy that
/// arrived with the trigger but an empty body would be exactly the bug this
/// function's doc-comment was written to prevent, one level down.
///
/// **Why DISABLED.** A copy that immediately starts firing is a surprise, and
/// doubles the load of whatever the original does. The framing is "a bot is its
/// own template", not "its own daemon".
///
/// New ids everywhere, and `last_run`/`run_count`/`next_run` all reset: the copy
/// has no history, and inheriting the original's would make its ledger a lie.
/// The fire-key table is keyed by workflow id, so fresh ids also mean the copy
/// can never be suppressed by the original's fire history.
pub async fn copy_for_session(pool: &SqlitePool, src: &str, dst: &str) -> sqlx::Result<u64> {
    let now = Utc::now().timestamp();
    let company_id = derive_company_id(pool, dst).await?;
    let sources = list_for_session(pool, src).await?;
    let mut copied = 0u64;
    for w in &sources {
        let steps = steps_for(pool, &w.id).await?;
        let new_id = new_workflow_id();
        let mut tx = pool.begin().await?;
        sqlx::query(
            "INSERT INTO workflows
                (id, title, session, company_id, enabled, trigger_kind, schedule_expr,
                 next_run, last_run, run_count, on_complete, created, updated, deleted)
             VALUES (?, ?, ?, ?, 0, ?, ?, NULL, NULL, 0, ?, ?, ?, NULL)",
        )
        .bind(&new_id)
        .bind(&w.title)
        .bind(dst)
        .bind(company_id)
        .bind(&w.trigger_kind)
        .bind(&w.schedule_expr)
        .bind(&w.on_complete)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        for s in &steps {
            sqlx::query(
                "INSERT INTO workflow_steps
                    (id, workflow_id, position, title, command, prompt, files, connectors,
                     timeout_secs, on_complete, created, updated)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(new_step_id())
            .bind(&new_id)
            .bind(s.position)
            .bind(&s.title)
            .bind(&s.command)
            .bind(&s.prompt)
            .bind(&s.files)
            .bind(&s.connectors)
            .bind(s.timeout_secs)
            .bind(&s.on_complete)
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        copied += 1;
    }
    Ok(copied)
}

/// Re-derive `company_id` for every workflow from its session's current value.
/// Idempotent; used by `workflows::port::reconcile` at boot, where a restored
/// database may have grown its `sessions` rows after 0038 ran. Returns how many
/// rows actually changed.
pub async fn resync_company_ids(pool: &SqlitePool) -> sqlx::Result<u64> {
    let res = sqlx::query(
        "UPDATE workflows
            SET company_id = (SELECT s.company_id FROM sessions s WHERE s.name = workflows.session)
          WHERE company_id IS NOT (SELECT s.company_id FROM sessions s WHERE s.name = workflows.session)",
    )
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// One archived `schedules` row from the 0038 port (`workflows_import_log`).
/// `row_json` stays the raw TEXT here; the HTTP layer parses it for the reader.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct ImportLogRow {
    pub old_id: String,
    /// 1 = became a workflow, 0 = refused.
    pub ported: i64,
    /// '' when ported cleanly; else why not.
    pub reason: String,
    /// The complete pre-drop `schedules` row as JSON.
    pub row_json: String,
    pub at: i64,
}

/// The whole schedules-port archive, refused rows first (those are the ones a
/// user must act on), then by drop time. The table is written exactly once, by
/// migration 0038, and never grows — no pagination needed.
pub async fn import_log(pool: &SqlitePool) -> sqlx::Result<Vec<ImportLogRow>> {
    sqlx::query_as::<_, ImportLogRow>(
        "SELECT old_id, ported, reason, row_json, at
           FROM workflows_import_log
          ORDER BY ported ASC, at ASC, old_id ASC",
    )
    .fetch_all(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> (SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-wf-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(dir.join("data.db"))
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        (pool, dir)
    }

    async fn wf(pool: &SqlitePool, id: &str, session: &str) -> Workflow {
        let now = Utc::now().timestamp();
        insert(
            pool,
            &Workflow {
                id: id.into(),
                title: format!("wf {id}"),
                session: session.into(),
                company_id: None,
                enabled: 1,
                trigger_kind: "recurring".into(),
                schedule_expr: Some("every 1h".into()),
                next_run: Some("2026-09-01T09:00:00+00:00".into()),
                last_run: None,
                run_count: 0,
                on_complete: r#"{"kind":"none"}"#.into(),
                created: now,
                updated: now,
                deleted: None,
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn insert_run_prunes_to_twenty_per_workflow_not_globally() {
        let (pool, dir) = pool().await;
        wf(&pool, "WF-aaaaaaaa", "scout").await;
        wf(&pool, "WF-bbbbbbbb", "scout").await;

        for i in 0..25 {
            insert_run(&pool, "WF-aaaaaaaa", 1_700_000_000 + i, "tick", "ok", "").await.unwrap();
        }
        for i in 0..3 {
            insert_run(&pool, "WF-bbbbbbbb", 1_700_000_000 + i, "tick", "ok", "").await.unwrap();
        }

        // A busy workflow trims its own history and cannot evict a quiet one's.
        assert_eq!(runs_for(&pool, "WF-aaaaaaaa", 100).await.unwrap().len(), 20);
        assert_eq!(runs_for(&pool, "WF-bbbbbbbb", 100).await.unwrap().len(), 3);
        // And what survives is the NEWEST 20, in the order the history shows.
        let kept = runs_for(&pool, "WF-aaaaaaaa", 100).await.unwrap();
        assert_eq!(kept[0].started_at, 1_700_000_024);
        assert_eq!(kept[19].started_at, 1_700_000_005);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn claim_run_key_is_idempotent_for_the_same_scheduled_for_ts() {
        let (pool, dir) = pool().await;
        wf(&pool, "WF-aaaaaaaa", "scout").await;

        assert!(claim_run_key(&pool, "WF-aaaaaaaa", 1_700_000_000).await.unwrap());
        assert!(
            !claim_run_key(&pool, "WF-aaaaaaaa", 1_700_000_000).await.unwrap(),
            "a second claim for the same fire-time must lose — this is what stops a \
             restart from double-firing a window it already fired"
        );
        // A different window is a different key.
        assert!(claim_run_key(&pool, "WF-aaaaaaaa", 1_700_000_060).await.unwrap());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn replace_steps_rewrites_positions_atomically_and_history_survives() {
        let (pool, dir) = pool().await;
        wf(&pool, "WF-aaaaaaaa", "scout").await;

        let step = |p: &str| StepInput { prompt: p.into(), ..Default::default() };
        let first = replace_steps(&pool, "WF-aaaaaaaa", &[step("a"), step("b"), step("c")])
            .await
            .unwrap();
        assert_eq!(first.iter().map(|s| s.position).collect::<Vec<_>>(), vec![0, 1, 2]);
        let b_id = first[1].id.clone();

        // b ran once. Then the operator drops b and reorders what is left.
        let run = open_run(&pool, "WF-aaaaaaaa", "tick").await.unwrap();
        let sr = open_step_run(&pool, run, &b_id, 1, "b").await.unwrap();
        close_step_run(&pool, sr, "ok", "status-idle", "").await.unwrap();

        let after = replace_steps(&pool, "WF-aaaaaaaa", &[step("c"), step("a")]).await.unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after.iter().map(|s| s.position).collect::<Vec<_>>(), vec![0, 1]);
        assert_eq!(after.iter().map(|s| s.prompt.as_str()).collect::<Vec<_>>(), vec!["c", "a"]);
        assert!(!after.iter().any(|s| s.id == b_id), "b is gone from the step list");

        // …but what b DID is still in the log. step_id is not an FK for exactly
        // this reason: the history must not be rewritten by a later edit.
        let history = step_runs_for(&pool, run).await.unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].step_id, b_id);
        assert_eq!(history[0].status, "ok");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stale_running_finds_a_run_whose_heartbeat_is_older_than_its_timeout_plus_sixty() {
        let (pool, dir) = pool().await;
        wf(&pool, "WF-aaaaaaaa", "scout").await;
        let steps = replace_steps(
            &pool,
            "WF-aaaaaaaa",
            &[StepInput { prompt: "a".into(), timeout_secs: Some(120), ..Default::default() }],
        )
        .await
        .unwrap();

        let run = open_run(&pool, "WF-aaaaaaaa", "tick").await.unwrap();
        open_step_run(&pool, run, &steps[0].id, 0, "a").await.unwrap();

        let now = Utc::now().timestamp();
        // Fresh: the watcher is alive, hands off.
        assert!(stale_running(&pool, now).await.unwrap().is_empty());

        // One second inside the grace window is still not stale.
        sqlx::query("UPDATE workflow_runs SET heartbeat = ? WHERE id = ?")
            .bind(now - (120 + 60))
            .bind(run)
            .execute(&pool)
            .await
            .unwrap();
        assert!(stale_running(&pool, now).await.unwrap().is_empty(), "the boundary is exclusive");

        // One second past it, the watcher is provably gone with its process.
        sqlx::query("UPDATE workflow_runs SET heartbeat = ? WHERE id = ?")
            .bind(now - (120 + 61))
            .bind(run)
            .execute(&pool)
            .await
            .unwrap();
        let stale = stale_running(&pool, now).await.unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].id, run);

        // A finished run is never reaped, however old it is.
        close_run(&pool, run, "ok", "").await.unwrap();
        sqlx::query("UPDATE workflow_runs SET heartbeat = 0 WHERE id = ?")
            .bind(run)
            .execute(&pool)
            .await
            .unwrap();
        assert!(stale_running(&pool, now).await.unwrap().is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn company_id_is_derived_from_the_session_and_never_from_the_caller() {
        let (pool, dir) = pool().await;
        sqlx::query(
            "INSERT INTO companies (id, slug, display_name, root_dir, created_at, updated_at)
             VALUES (3, 'acme', 'Acme', '/tmp/acme', 1000, 1000)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO sessions (name, dir, created_at, company_id) VALUES ('scout', '/tmp/s', 1000, 3)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let now = Utc::now().timestamp();
        let w = insert(
            &pool,
            &Workflow {
                id: "WF-cccccccc".into(),
                title: "t".into(),
                session: "scout".into(),
                company_id: Some(99), // a client lying about its company
                enabled: 1,
                trigger_kind: "manual".into(),
                schedule_expr: None,
                next_run: None,
                last_run: None,
                run_count: 0,
                on_complete: r#"{"kind":"none"}"#.into(),
                created: now,
                updated: now,
                deleted: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(w.company_id, Some(3), "the session's company wins, always");
        assert_eq!(get(&pool, "WF-cccccccc").await.unwrap().unwrap().company_id, Some(3));

        // A session that does not exist is a NULL, not an error and not a guess.
        let ghost = wf(&pool, "WF-dddddddd", "ghost").await;
        assert_eq!(ghost.company_id, None);

        let _ = std::fs::remove_dir_all(dir);
    }
}

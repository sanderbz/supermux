//! Backend scheduler: tick loop, expression parsing, job runner, HTTP surface
//! (TECH_PLAN §3.2.12, §3.8; feature-extract §4).
//!
//! **Tick (§3.8 / Codex #6).** A 10s `tokio::time::interval` with
//! `MissedTickBehavior::Skip` — the default `Burst` would, on laptop wake from
//! sleep, fire every missed tick at once and dispatch each schedule N times.
//! Skip drops missed ticks; the next scheduled tick runs normally. Each tick
//! selects due schedules; for any whose window was missed by >60s it logs a
//! `skipped` run and advances `next_run` WITHOUT firing; the rest dispatch via
//! [`runner::run`] (which idempotency-gates on the fire-key).
//!
//! **Router-registry pattern (§3.4).** [`router_for`] returns this module's
//! sub-router; `http::router` merges it under the shared bearer-auth layer.

pub mod hook;
pub mod parser;
pub mod runner;
pub mod watch;

use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::MissedTickBehavior;

use crate::db;
use crate::db::schedules::{Schedule, SchedulePatch};
use crate::error::AppError;
use crate::state::{AppState, SseEvent};

use runner::Trigger;

/// The scheduler tick interval (§3.8 — explicit 10s).
const TICK_INTERVAL: Duration = Duration::from_secs(10);
/// Past-due tolerance: beyond this, the window is treated as missed (§3.8).
const MISSED_WINDOW: chrono::Duration = chrono::Duration::seconds(60);
/// Grace window for a *one-shot* (`sched_type == 'once'`): a single-fire job that
/// is past due by less than this is still FIRED rather than silently discarded
/// (R2-002). A one-shot created while the server was down — or one whose first
/// post-creation tick is slightly past due — should still run a few hours late;
/// only an egregiously stale one-shot is skip+disabled.
const ONESHOT_GRACE: chrono::Duration = chrono::Duration::hours(6);
/// Default watch deadline (seconds) for a "notify when done" schedule when the
/// client doesn't specify one. The structural status→idle signal is event-driven
/// (no polling cost while waiting), so a generous default lets long agent tasks
/// run to completion instead of the old 120s cut-off that left long jobs
/// silently un-notified. On timeout a `notify` schedule still pings "still
/// running" (see [`watch::notify_timeout`]).
const DEFAULT_WATCH_TIMEOUT: i64 = 1800;

// ── tick loop (§3.2.12) ───────────────────────────────────────────────────────

/// Spawn the 10s scheduler tick (fire-and-forget; errors are logged only).
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK_INTERVAL);
        // Codex #6: drop missed ticks instead of bursting after a sleep.
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            if let Err(e) = tick_once(&state).await {
                tracing::warn!(error = %e, "scheduler tick failed");
            }
        }
    });
}

/// One tick: dispatch due schedules, skipping (and advancing) missed windows.
async fn tick_once(state: &AppState) -> anyhow::Result<()> {
    let now = Utc::now();
    let candidates = db::schedules::enabled_with_next(&state.pool).await?;

    for sched in candidates {
        let Some(next_run) = sched
            .next_run
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
        else {
            continue;
        };
        if next_run > now {
            continue; // not due yet
        }

        let scheduled_for_ts = next_run.timestamp();

        if now - next_run > MISSED_WINDOW {
            // R2-002: a still-recent ONE-SHOT is honoured late rather than
            // discarded. `recompute_next` returns `None` for `sched_type='once'`,
            // so the generic skip path below would NULL `next_run` + set
            // `enabled = 0` — silently dropping a one-shot that fired before the
            // server's first tick (server was down at creation, a brief busy
            // spell, or a restored DB). Inside the grace window we fall through
            // to the normal dispatch instead, which fires it via `runner::run`
            // (that path emits the SSE `alerts` event and advances cadence).
            let recent_oneshot =
                sched.sched_type == "once" && now - next_run <= ONESHOT_GRACE;
            if !recent_oneshot {
                // Missed-window: log + advance, do NOT fire (§3.8). Claim the
                // fire-key first so this only catches GENUINELY missed windows
                // (server downtime); an in-flight long-running job already holds
                // the key, so we leave its next_run for `record_fire` and skip.
                match db::schedules::claim_run_key(&state.pool, &sched.id, scheduled_for_ts).await {
                    Ok(true) => {
                        let _ = db::schedules::insert_run(
                            &state.pool,
                            &sched.id,
                            now.timestamp(),
                            "skipped",
                            "missed window",
                        )
                        .await;
                        let next = runner::recompute_next(&sched, now);
                        let _ = db::schedules::advance_next(&state.pool, &sched.id, next).await;
                        tracing::info!(schedule = %sched.id, "advanced past missed schedule window (not fired)");
                        // R2-002: surface a stranded/skipped schedule to clients
                        // — previously this path was log-only and invisible.
                        let _ = state.sse_tx.send(SseEvent {
                            event: "alerts".to_string(),
                            payload: json!({
                                "level": "info",
                                "source": "scheduler",
                                "schedule": sched.id,
                                "detail": format!(
                                    "Skipped schedule '{}' — fire window missed by >6h",
                                    sched.title
                                ),
                            }),
                        });
                    }
                    Ok(false) => {} // already handled/in-flight — leave to record_fire
                    Err(e) => tracing::warn!(schedule = %sched.id, error = %e, "missed-window claim failed"),
                }
                continue;
            }
            tracing::info!(
                schedule = %sched.id,
                "one-shot past due within grace window — firing late rather than skipping",
            );
            // fall through to the normal dispatch below
        }

        let st = state.clone();
        tokio::spawn(async move {
            runner::run(st, sched, Trigger::Tick { scheduled_for_ts }).await;
        });
    }
    Ok(())
}

// ── HTTP router ───────────────────────────────────────────────────────────────

/// The agent→scheduler hook sub-router (`/api/hook/schedule/*`). Merged at the
/// top level of `http::router` OUTSIDE the bearer layer — auth is the per-session
/// hook token, like the board hook router.
pub fn hook_router_for(state: AppState) -> Router {
    hook::router_for(state)
}

/// Build the scheduler sub-router (no auth layer — applied by `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::{get, post};
    Router::new()
        .route("/api/schedules", get(list_handler).post(create_handler))
        // Static segments are registered alongside the `{id}` capture; axum's
        // router prioritizes static segments, so order is unambiguous.
        .route("/api/schedules/preview", post(preview_handler)) // M21
        // Real installed agent commands for the recipe / command picker (skills +
        // user/managed commands + claude.ai MCP connectors — never built-ins).
        .route("/api/schedules/commands", get(commands_handler))
        .route("/api/schedules/runs", get(all_runs_handler))
        .route(
            "/api/schedules/{id}",
            get(get_handler).patch(patch_handler).delete(delete_handler),
        )
        .route("/api/schedules/{id}/runs", get(runs_handler))
        .route("/api/schedules/{id}/run", post(run_now_handler))
        .with_state(state)
}

#[derive(Serialize)]
struct Envelope<T> {
    ok: bool,
    data: T,
}

fn ok<T: Serialize>(data: T) -> Json<Envelope<T>> {
    Json(Envelope { ok: true, data })
}

// ── create ────────────────────────────────────────────────────────────────────

/// Create-schedule request body (feature-extract §4.1). `schedule_expr` is the
/// canonical cadence; `recurrence`+`run_at` are an accepted legacy alternative.
#[derive(Debug, Deserialize, Default)]
pub struct CreateScheduleInput {
    pub title: String,
    #[serde(default)]
    pub command: String,
    /// Optional free-text prompt sent right AFTER the command (a job may carry a
    /// command and/or a prompt — at least one must be non-empty).
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub boot_dir: Option<String>,
    #[serde(default)]
    pub boot_provider: Option<String>,
    #[serde(default)]
    pub boot_worktree: Option<bool>,
    #[serde(default)]
    pub schedule_expr: Option<String>,
    #[serde(default)]
    pub recurrence: Option<String>,
    #[serde(default)]
    pub run_at: Option<String>,
    #[serde(default)]
    pub watch: Option<bool>,
    #[serde(default)]
    pub watch_timeout: Option<i64>,
    #[serde(default)]
    pub done_pattern: Option<String>,
    #[serde(default)]
    pub done_action: Option<String>,
    /// Agent-confirmed finish (tmux only): append a completion-call footer to the
    /// delivered prompt so the agent signals "done" itself. Most-reliable finish
    /// tier; idle detection stays the fallback.
    #[serde(default)]
    pub confirm_finish: Option<bool>,
    /// M21 "test fire": create the schedule, run it ONCE immediately, return the
    /// run result, then delete it — so the user can prove a job works before
    /// committing it. Never persists a live schedule.
    #[serde(default, rename = "_test_fire")]
    pub test_fire: bool,
}

/// Create a schedule: validate, parse the expression to compute the first
/// `next_run`, and insert. Reused by the HTTP handler and integration tests.
pub async fn create(state: &AppState, input: CreateScheduleInput) -> Result<Schedule, AppError> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("title required".into()));
    }
    let kind = input.kind.unwrap_or_else(|| "tmux".into());
    if !["tmux", "shell", "boot"].contains(&kind.as_str()) {
        return Err(AppError::BadRequest(format!("invalid kind '{kind}'")));
    }
    let has_command = !input.command.trim().is_empty();
    let has_prompt = !input.prompt.trim().is_empty();
    // `shell` runs the command literally via bash — a prompt has no meaning there,
    // so it still requires a command. `tmux`/`boot` deliver a command and/or a
    // prompt to an agent session; at least one is required.
    if kind == "shell" {
        if !has_command {
            return Err(AppError::BadRequest("command required".into()));
        }
    } else if !has_command && !has_prompt {
        return Err(AppError::BadRequest("command or prompt required".into()));
    }
    let session = input.session.unwrap_or_default();
    if kind == "tmux" && session.trim().is_empty() {
        return Err(AppError::BadRequest("tmux schedule requires a target session".into()));
    }
    let boot_dir = input.boot_dir.unwrap_or_default();
    if kind == "boot" && boot_dir.trim().is_empty() {
        return Err(AppError::BadRequest("boot schedule requires boot_dir".into()));
    }

    let done_action = input.done_action.unwrap_or_else(|| "disable".into());
    if !valid_done_action(&done_action) {
        return Err(AppError::BadRequest(
            "done_action must be 'disable', 'notify', or 'command:<text>'".into(),
        ));
    }
    // Agent-confirmed finish only applies to tmux jobs (shell finishes on process
    // exit; boot spawns a runtime-generated session the footer can't scope to).
    // Clamp it off for other kinds so the column never lies.
    let confirm_finish = kind == "tmux" && input.confirm_finish.unwrap_or(false);

    // Determine the cadence expression.
    let expr = input
        .schedule_expr
        .filter(|s| !s.trim().is_empty())
        .or_else(|| synth_expr(input.recurrence.as_deref(), input.run_at.as_deref()))
        .ok_or_else(|| AppError::BadRequest("schedule_expr or recurrence+run_at required".into()))?;

    let now = Utc::now();
    let parsed = parser::parse(&expr, now).map_err(|e| AppError::BadRequest(e.to_string()))?;

    let ts = now.timestamp();
    let sched = Schedule {
        id: format!("SCHED-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
        title: title.to_string(),
        session,
        command: input.command.trim().to_string(),
        prompt: input.prompt.trim().to_string(),
        kind,
        boot_dir,
        boot_provider: input.boot_provider.unwrap_or_else(|| "claude".into()),
        boot_worktree: input.boot_worktree.unwrap_or(false) as i64,
        sched_type: parsed.sched_type.to_string(),
        recurrence: input.recurrence,
        run_at: input.run_at,
        next_run: Some(parsed.next_run.to_rfc3339()),
        last_run: None,
        enabled: 1,
        run_count: 0,
        schedule_expr: Some(expr),
        watch: input.watch.unwrap_or(false) as i64,
        watch_timeout: input.watch_timeout.unwrap_or(DEFAULT_WATCH_TIMEOUT),
        done_pattern: input.done_pattern,
        done_action,
        confirm_finish: confirm_finish as i64,
        created: ts,
        updated: ts,
        deleted: None,
    };
    db::schedules::insert(&state.pool, &sched).await?;
    Ok(sched)
}

/// Synthesize a 5-field cron from the legacy `recurrence`+`run_at` pair.
fn synth_expr(recurrence: Option<&str>, run_at: Option<&str>) -> Option<String> {
    let rec = recurrence?;
    let run_at = run_at.unwrap_or("");
    let parts: Vec<&str> = run_at.split(':').collect();
    let p = |i: usize| -> Option<u32> { parts.get(i).and_then(|s| s.parse().ok()) };
    match rec {
        // minute portion of run_at, every hour
        "hourly" => {
            let m = if parts.len() >= 2 { p(1)? } else { p(0).unwrap_or(0) };
            Some(format!("{m} * * * *"))
        }
        // run_at = "HH:MM"
        "daily" => Some(format!("{} {} * * *", p(1)?, p(0)?)),
        // run_at = "<wd>:<HH>:<MM>" with wd 0=Mon..6=Sun → std DOW (Sun=0)
        "weekly" => {
            let (wd, h, m) = (p(0)?, p(1)?, p(2)?);
            let std_dow = (wd + 1) % 7;
            Some(format!("{m} {h} * * {std_dow}"))
        }
        // run_at = "<DD>:<HH>:<MM>"
        "monthly" => {
            let (dd, h, m) = (p(0)?, p(1)?, p(2)?);
            Some(format!("{m} {h} {dd} * *"))
        }
        _ => None,
    }
}

fn valid_done_action(a: &str) -> bool {
    a == "disable" || a == "notify" || a.starts_with("command:")
}

// ── patch ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct PatchInput {
    title: Option<String>,
    session: Option<String>,
    command: Option<String>,
    prompt: Option<String>,
    kind: Option<String>,
    enabled: Option<bool>,
    watch: Option<bool>,
    watch_timeout: Option<i64>,
    done_pattern: Option<String>,
    done_action: Option<String>,
    confirm_finish: Option<bool>,
    schedule_expr: Option<String>,
    recurrence: Option<String>,
    run_at: Option<String>,
}

// ── handlers ──────────────────────────────────────────────────────────────────

async fn list_handler(
    State(state): State<AppState>,
) -> Result<Json<Envelope<Vec<Schedule>>>, AppError> {
    Ok(ok(db::schedules::list(&state.pool).await?))
}

async fn create_handler(
    State(state): State<AppState>,
    Json(input): Json<CreateScheduleInput>,
) -> Result<impl IntoResponse, AppError> {
    // M21 test-fire: create, run once, capture the result, then delete. The
    // schedule never goes live; the user gets immediate proof the job works.
    if input.test_fire {
        let result = test_fire(&state, input).await?;
        return Ok((StatusCode::OK, ok(json!(result))));
    }
    let sched = create(&state, input).await?;
    Ok((StatusCode::CREATED, ok(json!(sched))))
}

/// Result of a test-fire: the run's terminal `status` + `note`.
#[derive(Debug, Serialize)]
pub struct TestFireResult {
    pub status: String,
    pub note: String,
}

/// Run a schedule ONCE synchronously without leaving it live (M21). The schedule
/// is created (so id/audit semantics are identical to a real fire), executed via
/// the manual-run path (no idempotency key, no cadence advance), the resulting
/// `schedule_runs` row is read back, then the schedule is soft-deleted.
pub async fn test_fire(
    state: &AppState,
    input: CreateScheduleInput,
) -> Result<TestFireResult, AppError> {
    // R2-001: a `boot`-kind run spawns a REAL, persistent session (a `sessions`
    // row + a tmux/pty process, and optionally a git worktree). `test_fire` only
    // soft-deletes the *schedule* row, so test-firing a boot schedule would
    // leave a permanent orphan session/worktree behind on every call — breaking
    // the "never persists a live schedule" promise. Reject it up front; the
    // user can prove a boot schedule by creating it and using "run now".
    if input.kind.as_deref() == Some("boot") {
        return Err(AppError::BadRequest(
            "test-fire is not supported for boot schedules (it would spawn an orphan session); \
             create the schedule and use 'run now' instead"
                .into(),
        ));
    }
    let sched = create(state, input).await?;
    // Run synchronously so the result is ready when we respond. The manual
    // trigger never touches next_run, so deletion afterward is clean.
    runner::run(state.clone(), sched.clone(), Trigger::Manual).await;
    let runs = db::schedules::runs_for(&state.pool, &sched.id, 1).await?;
    let result = runs
        .into_iter()
        .next()
        .map(|r| TestFireResult { status: r.status, note: r.note })
        .unwrap_or_else(|| TestFireResult {
            status: "error".into(),
            note: "no run recorded".into(),
        });
    let _ = db::schedules::soft_delete(&state.pool, &sched.id).await;
    Ok(result)
}

/// `POST /api/schedules/preview` (M21). Parse `expression` WITHOUT persisting and
/// return the next up-to-5 fire times as RFC3339 strings, so the create dialog
/// can preview a cadence as the user types.
async fn preview_handler(
    State(_state): State<AppState>,
    Json(input): Json<PreviewInput>,
) -> Result<Json<Envelope<serde_json::Value>>, AppError> {
    let runs = preview_runs(&input.expression, 5).map_err(AppError::BadRequest)?;
    let iso: Vec<String> = runs.iter().map(|d| d.to_rfc3339()).collect();
    Ok(ok(json!({ "next_runs": iso })))
}

#[derive(Debug, Deserialize)]
struct PreviewInput {
    expression: String,
}

/// `GET /api/schedules/commands?cwd=<dir>` — the REAL installed agent commands the
/// recipe / command picker offers: the user's skills + user/managed commands +
/// claude.ai MCP connectors. Built-in Claude slash commands are deliberately
/// excluded (a scheduled job wants a skill/MCP, not `/clear`). Backed by the same
/// filesystem read the Claude-tools registry uses — one source of truth.
async fn commands_handler(
    State(state): State<AppState>,
    Query(q): Query<CommandsQuery>,
) -> Result<Json<Envelope<Vec<crate::claude_tools::registry::InstalledCommand>>>, AppError> {
    let cwd = q.cwd.as_deref().filter(|s| !s.is_empty());
    Ok(ok(crate::claude_tools::registry::installed_commands(&state, cwd).await?))
}

#[derive(Debug, Deserialize, Default)]
struct CommandsQuery {
    /// Optional focused session dir; when present, project-scoped skills/commands
    /// are included alongside the global ones.
    #[serde(default)]
    cwd: Option<String>,
}

/// Compute the next `count` fire times for `expr` relative to now (no DB I/O).
/// A one-shot yields a single time; recurring expressions are walked forward via
/// the parser's [`parser::Recurrence`].
pub fn preview_runs(expr: &str, count: usize) -> Result<Vec<DateTime<Utc>>, String> {
    let now = Utc::now();
    let parsed = parser::parse(expr, now).map_err(|e| e.to_string())?;
    let mut out = vec![parsed.next_run];
    let mut cursor = parsed.next_run;
    while out.len() < count {
        match parsed.recurrence.next_after(cursor, cursor) {
            Some(next) if next > cursor => {
                out.push(next);
                cursor = next;
            }
            _ => break, // one-shot, or no further occurrences
        }
    }
    Ok(out)
}

async fn get_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Envelope<Schedule>>, AppError> {
    let sched = db::schedules::get(&state.pool, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("schedule '{id}'")))?;
    Ok(ok(sched))
}

async fn all_runs_handler(
    State(state): State<AppState>,
) -> Result<Json<Envelope<Vec<db::schedules::RunSummary>>>, AppError> {
    Ok(ok(db::schedules::recent_runs(&state.pool, 50).await?))
}

async fn runs_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Envelope<Vec<db::schedules::ScheduleRun>>>, AppError> {
    Ok(ok(db::schedules::runs_for(&state.pool, &id, 20).await?))
}

async fn run_now_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let sched = db::schedules::get(&state.pool, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("schedule '{id}'")))?;
    // Manual run is async-shaped (a shell job may take up to 600s): dispatch in
    // the background and acknowledge immediately.
    let st = state.clone();
    tokio::spawn(async move {
        runner::run(st, sched, Trigger::Manual).await;
    });
    Ok((StatusCode::ACCEPTED, ok(json!({ "ran": true }))))
}

async fn patch_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<PatchInput>,
) -> Result<Json<Envelope<Schedule>>, AppError> {
    let existing = db::schedules::get(&state.pool, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("schedule '{id}'")))?;

    if let Some(a) = input.done_action.as_deref() {
        if !valid_done_action(a) {
            return Err(AppError::BadRequest(
                "done_action must be 'disable', 'notify', or 'command:<text>'".into(),
            ));
        }
    }

    // Recompute next_run when the cadence changed.
    let new_expr = input
        .schedule_expr
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            if input.recurrence.is_some() || input.run_at.is_some() {
                synth_expr(
                    input.recurrence.as_deref().or(existing.recurrence.as_deref()),
                    input.run_at.as_deref().or(existing.run_at.as_deref()),
                )
            } else {
                None
            }
        });

    let (next_run, sched_type) = match &new_expr {
        Some(expr) => {
            let parsed =
                parser::parse(expr, Utc::now()).map_err(|e| AppError::BadRequest(e.to_string()))?;
            (Some(parsed.next_run), Some(parsed.sched_type.to_string()))
        }
        // Re-enable from off → on without a cadence change: the stored `next_run`
        // is anchored to the pre-pause fire (or was never advanced), so the UI
        // would show "next: <hours ago>" until the tick loop's missed-window
        // sweep heals it. Reparse the existing expression from `now` so the
        // next fire is one cadence-step ahead instead.
        None if input.enabled == Some(true) && existing.enabled == 0 => {
            match existing.schedule_expr.as_deref() {
                Some(expr) => {
                    let parsed = parser::parse(expr, Utc::now())
                        .map_err(|e| AppError::BadRequest(e.to_string()))?;
                    (Some(parsed.next_run), Some(parsed.sched_type.to_string()))
                }
                None => (None, None),
            }
        }
        None => (None, None),
    };

    let patch = SchedulePatch {
        title: input.title,
        session: input.session,
        command: input.command,
        prompt: input.prompt,
        kind: input.kind,
        enabled: input.enabled,
        watch: input.watch,
        watch_timeout: input.watch_timeout,
        done_pattern: input.done_pattern,
        done_action: input.done_action,
        confirm_finish: input.confirm_finish,
        schedule_expr: new_expr,
        next_run,
        sched_type,
    };
    db::schedules::patch(&state.pool, &id, &patch).await?;

    let updated = db::schedules::get(&state.pool, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("schedule '{id}'")))?;
    Ok(ok(updated))
}

async fn delete_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let deleted = db::schedules::soft_delete(&state.pool, &id).await?;
    if !deleted {
        return Err(AppError::NotFound(format!("schedule '{id}'")));
    }
    let _ = db::audit::log(
        &state.pool,
        "user",
        "schedule.delete",
        &id,
        json!({}),
    )
    .await;
    Ok(Json(json!({ "ok": true, "data": { "deleted": true } })))
}

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

pub mod parser;
pub mod runner;
pub mod watch;

use std::time::Duration;

use axum::extract::{Path, State};
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
use crate::state::AppState;

use runner::Trigger;

/// The scheduler tick interval (§3.8 — explicit 10s).
const TICK_INTERVAL: Duration = Duration::from_secs(10);
/// Past-due tolerance: beyond this, the window is treated as missed (§3.8).
const MISSED_WINDOW: chrono::Duration = chrono::Duration::seconds(60);

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
            // Missed-window: log + advance, do NOT fire (§3.8). Claim the
            // fire-key first so this only catches GENUINELY missed windows
            // (server downtime); an in-flight long-running job already holds the
            // key, so we leave its next_run for `record_fire` and skip silently.
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
                }
                Ok(false) => {} // already handled/in-flight — leave to record_fire
                Err(e) => tracing::warn!(schedule = %sched.id, error = %e, "missed-window claim failed"),
            }
            continue;
        }

        let st = state.clone();
        tokio::spawn(async move {
            runner::run(st, sched, Trigger::Tick { scheduled_for_ts }).await;
        });
    }
    Ok(())
}

// ── HTTP router ───────────────────────────────────────────────────────────────

/// Build the scheduler sub-router (no auth layer — applied by `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::{get, post};
    Router::new()
        .route("/api/schedules", get(list_handler).post(create_handler))
        // Static `/runs` is registered alongside the `{id}` capture; axum's
        // router prioritizes the static segment, so order is unambiguous.
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
    if input.command.trim().is_empty() {
        return Err(AppError::BadRequest("command required".into()));
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
        watch_timeout: input.watch_timeout.unwrap_or(120),
        done_pattern: input.done_pattern,
        done_action,
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
    kind: Option<String>,
    enabled: Option<bool>,
    watch: Option<bool>,
    watch_timeout: Option<i64>,
    done_pattern: Option<String>,
    done_action: Option<String>,
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
    let sched = create(&state, input).await?;
    Ok((StatusCode::CREATED, ok(sched)))
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
        None => (None, None),
    };

    let patch = SchedulePatch {
        title: input.title,
        session: input.session,
        command: input.command,
        kind: input.kind,
        enabled: input.enabled,
        watch: input.watch,
        watch_timeout: input.watch_timeout,
        done_pattern: input.done_pattern,
        done_action: input.done_action,
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

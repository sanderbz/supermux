//! Workflows — a bot, an ORDERED list of prompt steps, a trigger, and a typed
//! completion action.
//!
//! The successor to `scheduler/`. This module owns the cadence grammar
//! ([`parser`], moved here unchanged), the post-upgrade reconciliation that runs
//! once at boot after `0038_workflows.sql`, and — from Phase 2 — the execution
//! engine and its 10s tick.

pub mod complete;
pub mod engine;
pub mod hook;
pub mod parser;
pub mod port;
pub mod shim;

use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::MissedTickBehavior;

use crate::auth_human::AuthContext;
use crate::db;
use crate::db::workflows::Workflow;
use crate::error::AppError;
use crate::scope::{OptCtx, Scope};
use crate::state::{AppState, SseEvent};

// ── constants ─────────────────────────────────────────────────────────────────
//
// Carried over VERBATIM from `scheduler::mod` (spec §3.2). Every one of them is
// a behaviour the old scheduler earned the hard way; none of them is a new
// tuning knob.

/// The workflows tick interval (explicit 10s).
pub const TICK_INTERVAL: Duration = Duration::from_secs(10);
/// Past-due tolerance: beyond this, the window is treated as missed.
pub const MISSED_WINDOW: chrono::Duration = chrono::Duration::seconds(60);
/// Grace window for a *one-shot* (`trigger_kind == 'once'`): a single-fire
/// workflow past due by less than this is still FIRED rather than silently
/// discarded — the server may simply have been down when it came due.
pub const ONESHOT_GRACE: chrono::Duration = chrono::Duration::hours(6);
/// Default per-step deadline (seconds) — today's `DEFAULT_WATCH_TIMEOUT`. The
/// status→idle signal is event-driven (no polling cost while waiting), so a
/// generous default lets long agent steps run to completion.
pub use crate::db::workflows::DEFAULT_STEP_TIMEOUT;
/// How many ARMED (switched-on) workflows one bot may have at once. Paused and
/// finished ones do not count: they arm no work.
pub const MAX_WORKFLOWS_PER_SESSION: usize = 20;
/// An agent's own finished one-shot is tidied away this long after it last
/// changed (see [`db::workflows::tidy_finished_agent_oneshots`]).
pub const FINISHED_ONESHOT_KEEP: chrono::Duration = chrono::Duration::days(7);
/// How many steps one workflow may carry.
pub const MAX_STEPS_PER_WORKFLOW: usize = 20;
/// How many steps a workflow created over the AGENT hook path may carry — a
/// session token arms less than a human at a keyboard does.
pub const MAX_STEPS_VIA_HOOK: usize = 5;

/// Compute the next `count` fire times for `expr` relative to now (no DB I/O).
/// A one-shot yields a single time; recurring expressions are walked forward via
/// the parser's [`parser::Recurrence`].
///
/// Moved verbatim from `scheduler::preview_runs` — the next-5-runs preview is
/// one of the few genuinely good bits of today's create dialog.
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

// ── tick loop ─────────────────────────────────────────────────────────────────

/// Spawn the 10s workflows tick (fire-and-forget; errors are logged only).
///
/// [`MissedTickBehavior::Skip`] is load-bearing, not a preference: the default
/// `Burst` fires every missed tick at once after a laptop sleep and would
/// dispatch each due workflow N times.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        // A restart is EXACTLY when in-memory watchers were lost, so the reaper
        // runs once at boot before the first tick — otherwise a run interrupted
        // by the restart would sit `running` forever and rule 2 would block its
        // workflow from ever firing again (§3.6).
        engine::reap(&state).await;
        let mut tick = tokio::time::interval(TICK_INTERVAL);
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            if let Err(e) = tick_once(&state).await {
                tracing::warn!(error = %e, "workflows tick failed");
            }
        }
    });
}

/// One tick: dispatch due workflows, skipping (and advancing) missed windows.
/// Public so a test can drive a single tick deterministically instead of racing
/// a 10s interval.
pub async fn tick_once(state: &AppState) -> anyhow::Result<()> {
    let now = Utc::now();
    let candidates = db::workflows::enabled_with_next(&state.pool).await?;

    for wf in candidates {
        let Some(next_run) = wf
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

        // §3.2 rule 2 — ONE RUN AT A TIME, checked BEFORE the fire-key so the
        // skip is recorded against THIS window rather than swallowed by the
        // in-flight run's own claim. A chain can outlive its cadence, and two
        // interleaved chains in one pane would be indistinguishable garbage in
        // the transcript. `next_run` still advances: the workflow keeps its
        // rhythm, it just misses this beat, and the ledger says so out loud.
        match db::workflows::running_for(&state.pool, &wf.id).await {
            Ok(Some(inflight)) => {
                let _ = db::workflows::insert_run(
                    &state.pool,
                    &wf.id,
                    now.timestamp(),
                    "tick",
                    "skipped",
                    &format!("previous run #{} still in flight", inflight.id),
                )
                .await;
                let next = engine::recompute_next(&wf, now);
                let _ = db::workflows::advance_next(&state.pool, &wf.id, next).await;
                continue;
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(workflow = %wf.id, error = %e, "in-flight check failed"),
        }

        if now - next_run > MISSED_WINDOW {
            // A still-recent ONE-SHOT is honoured late rather than discarded.
            // `recompute_next` returns `None` for `trigger_kind='once'`, so the
            // generic skip path below would NULL `next_run` + set `enabled = 0`
            // — silently dropping a one-shot that came due before the server's
            // first tick (down at creation, a brief busy spell, a restored DB).
            // Inside the grace window we fall through to the normal dispatch.
            let recent_oneshot = wf.trigger_kind == "once" && now - next_run <= ONESHOT_GRACE;
            if !recent_oneshot {
                // Missed-window: log + advance, do NOT fire. Claim the fire-key
                // FIRST so this only catches GENUINELY missed windows (server
                // downtime); the ordering is what distinguishes downtime from a
                // long job, and it is carried over deliberately.
                match db::workflows::claim_run_key(&state.pool, &wf.id, scheduled_for_ts).await {
                    Ok(true) => {
                        skip_and_advance(
                            state,
                            &wf,
                            now,
                            "missed window",
                            "its fire window was missed",
                        )
                        .await;
                        tracing::info!(workflow = %wf.id, "advanced past a missed window (not fired)");
                    }
                    // The claim lost, so a key for THIS window already exists.
                    // Usually that means a run holds it and `record_fire` owns
                    // the advance — but a key whose claimant is gone wedges the
                    // workflow forever, so this arm has to look before it walks
                    // away.
                    Ok(false) => sweep_if_stale(state, &wf, now, scheduled_for_ts).await,
                    Err(e) => tracing::warn!(workflow = %wf.id, error = %e, "missed-window claim failed"),
                }
                continue;
            }
            tracing::info!(
                workflow = %wf.id,
                "one-shot past due within the grace window — firing late rather than skipping",
            );
            // fall through to the normal dispatch below
        }

        // The idempotency gate: a restart mid-dispatch cannot double-fire the
        // same (workflow, fire-time) tuple.
        match db::workflows::claim_run_key(&state.pool, &wf.id, scheduled_for_ts).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::debug!(workflow = %wf.id, scheduled_for_ts, "duplicate fire skipped");
                continue;
            }
            Err(e) => {
                tracing::warn!(workflow = %wf.id, error = %e, "fire-key claim failed");
                continue;
            }
        }
        if let Err(e) = engine::start(state, wf.clone(), engine::Trigger::Tick).await {
            tracing::warn!(workflow = %wf.id, error = %e, "workflow dispatch failed");
        }
    }

    // §3.6 — the reaper rides the same tick.
    engine::reap(state).await;
    Ok(())
}

/// Record a `skipped` run for a window the tick will not fire, advance the
/// cadence past it, and say so out loud. Shared by the two missed-window exits:
/// a genuinely missed window, and one wedged behind a dead run's fire-key.
///
/// `note` is the ledger note; `reason` is the half-sentence a human reads in the
/// alert. The frame is COMPANY-STAMPED for the same reason every other emit in
/// this module is — an unstamped alert is owner-only, and the people whose bot
/// just skipped a beat are the ones who need to see it.
async fn skip_and_advance(
    state: &AppState,
    wf: &Workflow,
    now: DateTime<Utc>,
    note: &str,
    reason: &str,
) {
    let _ =
        db::workflows::insert_run(&state.pool, &wf.id, now.timestamp(), "tick", "skipped", note)
            .await;
    let next = engine::recompute_next(wf, now);
    let _ = db::workflows::advance_next(&state.pool, &wf.id, next).await;
    let _ = state.sse_tx.send(SseEvent::for_company(
        "alerts",
        json!({
            "level": "info",
            "source": "workflows",
            "workflow": wf.id,
            "detail": format!("Skipped workflow '{}' — {reason}", wf.title),
        }),
        wf.company_id,
    ));
}

/// A missed-window fire-key claim that was LOST: sweep the window when no live
/// run can be holding the key.
///
/// `next_run` is only ever advanced by the run that claimed the key (in
/// `record_fire`, from `engine::finish`). So a key whose claimant never gets
/// there — the process died mid-run, or `engine::start` returned an error after
/// the claim was already committed — leaves the workflow due on every later
/// tick, losing the claim to its own orphan key, forever. The key is persisted,
/// so a restart does not help; this was a production wedge ("last fired 22h ago,
/// next fire 22h ago") and the upgrade in 0038 copied the legacy scheduler's
/// keys over, orphans included.
///
/// The evidence that the claimant is gone is the RUN LEDGER, not the clock: a
/// chain of up to [`MAX_STEPS_PER_WORKFLOW`] steps at [`DEFAULT_STEP_TIMEOUT`]
/// each may legitimately hold its key for hours, so any age threshold big enough
/// to be safe is too big to be useful. Two guards keep the inference honest:
///
/// 1. `running_for` is re-read here rather than trusted from the top of the tick
///    — that check falls THROUGH on `Err`, and a run can have opened since;
/// 2. `fired_at` must be older than [`MISSED_WINDOW`], which excludes the sliver
///    between `claim_run_key` and the `open_run` inside `engine::start`.
///
/// On any uncertainty (a lookup error, a missing row) it logs and leaves the
/// workflow alone: a wedged workflow is recoverable on the next tick, a spurious
/// double-fire into a live pane is not.
async fn sweep_if_stale(
    state: &AppState,
    wf: &Workflow,
    now: DateTime<Utc>,
    scheduled_for_ts: i64,
) {
    match db::workflows::running_for(&state.pool, &wf.id).await {
        Ok(None) => {}
        // A run is in flight: it holds the key and will advance the cadence.
        Ok(Some(_)) => return,
        Err(e) => {
            tracing::warn!(workflow = %wf.id, error = %e, "stale fire-key: in-flight re-check failed");
            return;
        }
    }
    let fired_at = match db::workflows::run_key_fired_at(&state.pool, &wf.id, scheduled_for_ts).await
    {
        Ok(Some(ts)) => ts,
        // Lost the claim but the row is gone — a cascade delete raced this tick.
        Ok(None) => {
            tracing::warn!(workflow = %wf.id, "fire-key claim lost but no key row found");
            return;
        }
        Err(e) => {
            tracing::warn!(workflow = %wf.id, error = %e, "fire-key age lookup failed");
            return;
        }
    };
    if now.timestamp() - fired_at <= MISSED_WINDOW.num_seconds() {
        return; // young enough that a dispatch could still be on its way up
    }
    skip_and_advance(
        state,
        wf,
        now,
        "stale fire-key from a dead run",
        "a previous run claimed this window and never finished",
    )
    .await;
    tracing::warn!(
        workflow = %wf.id,
        fired_at,
        "swept a stale fire-key: its run never advanced next_run",
    );
}

// ── HTTP router ───────────────────────────────────────────────────────────────

/// Build the workflows sub-router (no auth layer — applied by `http::router`).
///
/// Deliberately NOT wrapped in `require_admin_mw` the way `scheduler::router_for`
/// was: a company member has to be able to see their own bot's workflows (spec
/// §5.1), so the fence is the per-handler [`Scope::sees`] check plus the
/// `scope::member_may_reach` allowlist entry — not a blanket owner-only route
/// layer that would 404 the whole surface for members.
pub fn router_for(state: AppState) -> Router {
    use axum::routing::{get, post, put};
    Router::new()
        .route("/api/workflows", get(list_handler).post(create_handler))
        // Static segments are registered alongside the `{id}` capture; axum's
        // router prioritizes static segments, so the order is unambiguous —
        // exactly the shape `scheduler::router_for` had.
        .route("/api/workflows/preview", post(preview_handler))
        // The REAL installed agent commands for the step / command picker
        // (skills + user/managed commands + claude.ai MCP connectors — never
        // built-ins).
        .route("/api/workflows/commands", get(commands_handler))
        // The 0038 schedules-port archive (owner/admin-only, like `/commands`).
        .route("/api/workflows/import-log", get(import_log_handler))
        .route("/api/workflows/runs", get(all_runs_handler))
        .route(
            "/api/workflows/{id}",
            get(get_handler).patch(patch_handler).delete(delete_handler),
        )
        .route("/api/workflows/{id}/steps", put(put_steps_handler))
        .route("/api/workflows/{id}/runs", get(runs_handler))
        .route("/api/workflows/{id}/run", post(run_now_handler))
        .route("/api/workflows/{id}/cancel", post(cancel_handler))
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

// ── scope ─────────────────────────────────────────────────────────────────────

/// Load a workflow for a viewer, or answer the UNIFORM 404.
///
/// A member asking for another company's workflow must not be able to tell "not
/// yours" from "does not exist" — the same rule (and the same sentence shape)
/// `sessions`' `authorize_session_for_human` applies. `Scope::All` (owner /
/// admin-all / no stamped identity) sees everything, including the unstamped
/// rows of the main bot; a scoped member sees only `company_id == their own`,
/// because [`Scope::sees`] is fail-closed on `None`.
async fn scoped_workflow(
    state: &AppState,
    ctx: Option<&AuthContext>,
    id: &str,
) -> Result<Workflow, AppError> {
    let missing = || AppError::NotFound(format!("workflow '{id}'"));
    let wf = db::workflows::get(&state.pool, id).await?.ok_or_else(missing)?;
    if !Scope::of(ctx).sees(wf.company_id) {
        return Err(missing());
    }
    Ok(wf)
}

// ── create ────────────────────────────────────────────────────────────────────

/// One step, as a writer supplies it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct StepBody {
    #[serde(default)]
    pub title: String,
    /// The bare slash line — delivered as its own submission (never concatenated
    /// with `prompt`, or Claude stops executing it as a slash command).
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub prompt: String,
    /// `[{path,name,size,mime}]` — every `path` must canonicalise under
    /// `<data_dir>/uploads/`.
    #[serde(default)]
    pub files: Option<serde_json::Value>,
    /// `["gmail","github"]` — connector ids the bot should prefer.
    #[serde(default)]
    pub connectors: Option<serde_json::Value>,
    #[serde(default)]
    pub timeout_secs: Option<i64>,
    /// The step's own typed completion action (same vocabulary as the workflow's).
    #[serde(default)]
    pub on_complete: Option<serde_json::Value>,
}

/// Create-workflow request body.
///
/// The removed dragon fields are NAMED so they can be refused with a sentence.
/// Serde ignores unknown fields, so leaving them out would silently DROP an old
/// client's `kind: "shell"` and hand back something it did not ask for — a
/// surprise that reads as the endpoint having accepted the request.
#[derive(Debug, Default, Deserialize)]
pub struct CreateWorkflowInput {
    pub title: String,
    /// The owning bot. Required: a workflow with no pane has nowhere to deliver.
    #[serde(default)]
    pub session: String,
    /// `manual` | `once` | `recurring`. Derived from `schedule_expr` when absent
    /// — the expression is the source of truth, as it is in today's parser.
    #[serde(default)]
    pub trigger_kind: Option<String>,
    #[serde(default)]
    pub schedule_expr: Option<String>,
    /// Typed JSON ([`complete::CompletionAction`]). Never free text.
    #[serde(default)]
    pub on_complete: Option<serde_json::Value>,
    #[serde(default)]
    pub steps: Vec<StepBody>,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// DERIVED from the session, never taken from here (spec §2.5). Named only
    /// so a client that sends it learns nothing happened — it is dropped, not
    /// honoured, and `db::workflows::insert` re-derives it regardless.
    #[serde(default)]
    pub company_id: Option<i64>,
    /// Archive the target session when it stops (migration 0025). NOT a
    /// workflows column: the preference is stamped onto `sessions.
    /// archive_on_stop` of the target session itself, the one place the stop
    /// hook reads, so two workflows on one bot can never disagree about it.
    /// `Some(v)` stamps `v`; absent leaves the session's marker untouched
    /// (opt-in, default off, a fresh session row carries 0). The engine's
    /// archive contract is unchanged: once the session archives itself, this
    /// workflow reads as a readable SKIP ("paused until you unarchive").
    #[serde(default)]
    pub archive_on_stop: Option<bool>,

    // ── named ONLY so they can be refused with a sentence ──────────────────
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub boot_dir: Option<String>,
    #[serde(default)]
    pub boot_provider: Option<String>,
    #[serde(default)]
    pub boot_worktree: Option<bool>,
    #[serde(default)]
    pub bypass_permissions: Option<bool>,
    #[serde(default)]
    pub done_action: Option<String>,
    #[serde(default)]
    pub watch: Option<bool>,
    #[serde(default)]
    pub done_pattern: Option<String>,
    #[serde(default, rename = "_test_fire")]
    pub test_fire: Option<bool>,
}

/// THE validation funnel — one validator, two callers (the bearer HTTP handler
/// and [`hook`]), which is today's shape and the reason `scheduler::create` was
/// worth keeping in one piece.
///
/// What it enforces, in order:
/// 1. the removed kinds are refused BY NAME (`shell`/`boot`/`bypass`/`command:`
///    cannot be expressed here, and an old payload gets a legible answer);
/// 2. `reject_wrapper_markup` over the title and EVERY step field that reaches a
///    transcript — a prompt that closes its own `<supermux-schedule>` wrapper can
///    forge a `<supermux-delegation from="…">` at top level;
/// 3. `on_complete` through [`complete::parse`] — an unknown `kind` is a 400, so
///    a row written by a future version can never become a silent no-op;
/// 4. every `files[].path` canonicalises under `<data_dir>/uploads/`;
/// 5. `connectors[]` exist and are granted to `session` — a WARNING, not a
///    refusal, because a grant can disappear later and the chip should render
///    "not connected" rather than the workflow becoming unsaveable;
/// 6. the two caps.
pub async fn create(
    state: &AppState,
    input: CreateWorkflowInput,
) -> Result<db::workflows::WorkflowWithSteps, AppError> {
    // 1. The dragon fields, refused by name.
    for (field, present) in [
        ("kind", input.kind.is_some()),
        ("command", input.command.is_some()),
        ("prompt", input.prompt.is_some()),
        ("boot_dir", input.boot_dir.is_some()),
        ("boot_provider", input.boot_provider.is_some()),
        ("boot_worktree", input.boot_worktree.is_some()),
        ("bypass_permissions", input.bypass_permissions.is_some()),
        ("done_action", input.done_action.is_some()),
        ("watch", input.watch.is_some()),
        ("done_pattern", input.done_pattern.is_some()),
        ("_test_fire", input.test_fire.is_some()),
    ] {
        if present {
            return Err(AppError::BadRequest(format!(
                "'{field}' no longer exists — a workflow is a bot, an ordered list of prompt \
                 steps, a trigger and a typed 'on_complete'"
            )));
        }
    }

    let title = input.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("title required".into()));
    }
    let session = input.session.trim().to_string();
    if session.is_empty() {
        return Err(AppError::BadRequest("a workflow requires a target session".into()));
    }
    if input.steps.is_empty() {
        return Err(AppError::BadRequest("a workflow requires at least one step".into()));
    }

    // 2. + 3. + 4. + 5. — the per-step funnel, shared with PUT /steps.
    reject_wrapper_markup(&[("title", title)])?;
    let steps = validate_steps(state, &session, &input.steps).await?;

    let on_complete = parse_on_complete(input.on_complete.as_ref())?;

    // The trigger. The EXPRESSION is the source of truth for `trigger_kind`:
    // `parser::parse` already decides once/recurring, and a client-supplied kind
    // that disagreed with its own expression would put a lie in the column.
    let expr = input.schedule_expr.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let (trigger_kind, schedule_expr, next_run) = match expr {
        Some(expr) => {
            let parsed =
                parser::parse(&expr, Utc::now()).map_err(|e| AppError::BadRequest(e.to_string()))?;
            (parsed.sched_type.to_string(), Some(expr), Some(parsed.next_run.to_rfc3339()))
        }
        None => {
            // No expression: manual, and any `trigger_kind` that claims otherwise
            // is refused rather than silently downgraded (0038's CHECK would
            // reject it anyway — as a 500 nobody can read).
            if let Some(k) = input.trigger_kind.as_deref() {
                if k != "manual" {
                    return Err(AppError::BadRequest(format!(
                        "trigger_kind '{k}' requires a schedule_expr"
                    )));
                }
            }
            ("manual".to_string(), None, None)
        }
    };

    // 6. The per-session cap, BEFORE the insert. Only switched-on workflows
    // count; a new one that is created paused arms nothing either.
    let creates_armed = input.enabled.unwrap_or(true);
    let armed = db::workflows::count_armed_for_session(&state.pool, &session).await? as usize;
    if creates_armed && armed >= MAX_WORKFLOWS_PER_SESSION {
        return Err(AppError::TooManyRequests(cap_message(armed)));
    }

    let ts = Utc::now().timestamp();
    let wf = Workflow {
        id: db::workflows::new_workflow_id(),
        title: title.to_string(),
        session,
        // Ignored by `insert`, which re-derives it from `sessions`. Set to the
        // derived-null default here so the struct never carries a client value.
        company_id: None,
        enabled: input.enabled.unwrap_or(true) as i64,
        trigger_kind,
        schedule_expr,
        next_run,
        last_run: None,
        run_count: 0,
        on_complete,
        created: ts,
        updated: ts,
        deleted: None,
    };
    let wf = db::workflows::insert(&state.pool, &wf).await?;
    let steps = db::workflows::replace_steps(&state.pool, &wf.id, &steps).await?;
    stamp_archive_on_stop(state, &wf.session, input.archive_on_stop).await;
    Ok(db::workflows::WorkflowWithSteps { workflow: wf, steps })
}

/// The 429 text for the per-session cap, shared by the bearer and hook paths.
pub(crate) fn cap_message(armed: usize) -> String {
    format!(
        "this session already has {armed} active workflows (max {MAX_WORKFLOWS_PER_SESSION}) — \
         pause or delete one before creating another (paused and finished ones do not count)"
    )
}

/// Stamp the disposable marker (`sessions.archive_on_stop`, 0025) onto the
/// workflow's target session, when the caller asked for it.
///
/// This is the workflows half of archive-on-stop, and deliberately the WHOLE
/// half: the marker lives on the session row (the one place
/// `lifecycle::maybe_archive_on_stop` reads), never on the workflow, so there
/// is no second copy to drift. `None` touches nothing, so an old client that
/// omits the field changes no behaviour. Best-effort: the workflow save
/// already succeeded, and a marker on a row that vanished mid-request matches
/// zero rows, which is logged rather than raised.
async fn stamp_archive_on_stop(state: &AppState, session: &str, want: Option<bool>) {
    let Some(on) = want else { return };
    match db::sessions::set_archive_on_stop(&state.pool, session, on).await {
        Ok(0) => tracing::warn!(
            session,
            "archive_on_stop stamp matched no session row; the marker was not written"
        ),
        Ok(_) => {}
        Err(e) => tracing::warn!(session, error = %e, "archive_on_stop stamp failed"),
    }
}

/// The per-step half of the funnel, shared by `create` and `PUT /{id}/steps`.
async fn validate_steps(
    state: &AppState,
    session: &str,
    steps: &[StepBody],
) -> Result<Vec<db::workflows::StepInput>, AppError> {
    if steps.len() > MAX_STEPS_PER_WORKFLOW {
        return Err(AppError::BadRequest(format!(
            "a workflow may hold at most {MAX_STEPS_PER_WORKFLOW} steps (got {})",
            steps.len()
        )));
    }
    let granted = db::connectors::grants_for_session(&state.pool, session)
        .await
        .unwrap_or_default();
    let mut out = Vec::with_capacity(steps.len());
    for (i, s) in steps.iter().enumerate() {
        let n = i + 1;
        let command = s.command.trim();
        let prompt = s.prompt.trim();
        // 0038's own CHECK, answered as a readable 400 rather than a 500 from
        // the constraint: a step delivers a command and/or a prompt.
        if command.is_empty() && prompt.is_empty() {
            return Err(AppError::BadRequest(format!(
                "step {n}: command or prompt required"
            )));
        }
        reject_wrapper_markup(&[
            (&format!("steps[{i}].title"), s.title.trim()),
            (&format!("steps[{i}].prompt"), prompt),
            (&format!("steps[{i}].command"), command),
        ])?;
        let files = jail_files(state, s.files.as_ref(), i)?;
        let connectors = normalise_connectors(s.connectors.as_ref(), i)?;
        // WARN, do not hard-fail: a grant revoked after the save must not make
        // the workflow unsaveable — the UI renders the chip "not connected".
        for id in &connectors {
            if !granted.iter().any(|g| &g.connector_id == id) {
                tracing::warn!(
                    session, connector = %id, step = i,
                    "workflow step names a connector this bot does not hold a grant for",
                );
            }
        }
        out.push(db::workflows::StepInput {
            title: s.title.trim().to_string(),
            command: command.to_string(),
            prompt: prompt.to_string(),
            files: Some(files),
            connectors: Some(
                serde_json::to_string(&connectors).unwrap_or_else(|_| "[]".into()),
            ),
            timeout_secs: s.timeout_secs,
            on_complete: Some(parse_on_complete(s.on_complete.as_ref())?),
        });
    }
    Ok(out)
}

/// Parse an incoming `on_complete` value into its canonical stored JSON. Absent
/// (or `null`) is `{"kind":"none"}`; an unknown `kind` is a 400.
fn parse_on_complete(v: Option<&serde_json::Value>) -> Result<String, AppError> {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return Ok(r#"{"kind":"none"}"#.to_string());
    };
    let action = complete::parse(&v.to_string())?;
    Ok(serde_json::to_string(&action).unwrap_or_else(|_| r#"{"kind":"none"}"#.into()))
}

/// Every `files[].path` must resolve INSIDE `<data_dir>/uploads/`.
///
/// A step body is delivered into a pane with the paths in it, so an unjailed
/// path is "read me `/etc/shadow`" written by whoever can POST a workflow. The
/// schedules table had no file concept at all, so this is not a regression being
/// carried over — it is the obvious hole, closed before it exists (spec §5.1).
fn jail_files(
    state: &AppState,
    files: Option<&serde_json::Value>,
    step: usize,
) -> Result<String, AppError> {
    let Some(v) = files.filter(|v| !v.is_null()) else { return Ok("[]".to_string()) };
    let arr = v
        .as_array()
        .ok_or_else(|| AppError::BadRequest(format!("steps[{step}].files must be an array")))?;
    let uploads = state.config.data_dir.join("uploads");
    // Both forms: the canonical root (when it exists) and the literal one, so a
    // data_dir that is itself reached through a symlink still matches.
    let root_real = uploads.canonicalize().unwrap_or_else(|_| uploads.clone());
    for f in arr {
        let path = f
            .get("path")
            .and_then(|p| p.as_str())
            .ok_or_else(|| AppError::BadRequest(format!("steps[{step}].files[].path is required")))?;
        let p = std::path::Path::new(path);
        let escapes = !p.is_absolute()
            || p.components().any(|c| matches!(c, std::path::Component::ParentDir))
            || {
                let real = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
                !real.starts_with(&root_real) && !p.starts_with(&uploads)
            };
        if escapes {
            return Err(AppError::BadRequest(format!(
                "steps[{step}]: '{path}' is outside the uploads directory — a step may only \
                 attach a file uploaded through supermux"
            )));
        }
    }
    Ok(v.to_string())
}

/// `connectors` as a list of ids — accepting only strings, so no object can
/// smuggle a second field into the delivered sentence.
fn normalise_connectors(
    v: Option<&serde_json::Value>,
    step: usize,
) -> Result<Vec<String>, AppError> {
    let Some(v) = v.filter(|v| !v.is_null()) else { return Ok(Vec::new()) };
    let arr = v
        .as_array()
        .ok_or_else(|| AppError::BadRequest(format!("steps[{step}].connectors must be an array")))?;
    let mut out = Vec::with_capacity(arr.len());
    for c in arr {
        let id = c.as_str().ok_or_else(|| {
            AppError::BadRequest(format!("steps[{step}].connectors[] must be connector ids"))
        })?;
        if !id.trim().is_empty() {
            out.push(id.trim().to_string());
        }
    }
    Ok(out)
}

/// 400 on any field carrying markup that could forge — or break out of — one of
/// supermux's transcript wrappers. Named fields so the refusal says WHICH one.
/// Carried over verbatim from `scheduler::reject_wrapper_markup`.
fn reject_wrapper_markup(fields: &[(&str, &str)]) -> Result<(), AppError> {
    for (field, value) in fields {
        if crate::agents::delegate::wrapper_markup(value) {
            return Err(AppError::BadRequest(format!(
                "'{field}' may not contain supermux wrapper markup"
            )));
        }
    }
    Ok(())
}

/// Ledger row + `harness` tick for a workflow that was just created.
///
/// `session` + `title` are in the detail from birth because the row's `target`
/// is the WORKFLOW id — the detail is the only thing that ties a workflow event
/// to the session whose feed should show it (`db::audit::EVENTS_SQL`'s
/// `detail.session` arm). Port of `scheduler::audit_schedule_create`.
pub async fn audit_workflow_create(state: &AppState, wf: &Workflow, actor: &str) {
    if wf.session.trim().is_empty() {
        return;
    }
    let _ = crate::sessions::audit_harness(
        state,
        actor,
        "workflow.create",
        &wf.id,
        json!({ "session": wf.session, "title": wf.title, "trigger": wf.trigger_kind }),
        &[wf.session.as_str()],
    )
    .await;
}

// ── handlers ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Default)]
struct ListQuery {
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    company_id: Option<i64>,
    /// Default TRUE. The list is the management surface: a disabled workflow
    /// that is invisible by default is a workflow nobody can re-enable.
    #[serde(default)]
    include_disabled: Option<bool>,
}

async fn list_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Query(q): Query<ListQuery>,
) -> Result<Json<Envelope<Vec<db::workflows::WorkflowWithSteps>>>, AppError> {
    let scope = Scope::of(ctx.as_ref());
    let rows = match q.session.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => db::workflows::list_for_session(&state.pool, s).await?,
        None => db::workflows::list(&state.pool).await?,
    };
    let include_disabled = q.include_disabled.unwrap_or(true);
    let mut out = Vec::new();
    for wf in rows {
        // The company fence, before anything else is read.
        if !scope.sees(wf.company_id) {
            continue;
        }
        // `company_id=` narrows for an owner; a member is already fenced above,
        // so it can only ever narrow their own company to itself or to nothing.
        if let Some(c) = q.company_id {
            if wf.company_id != Some(c) {
                continue;
            }
        }
        if !include_disabled && wf.enabled == 0 {
            continue;
        }
        let steps = db::workflows::steps_for(&state.pool, &wf.id).await?;
        out.push(db::workflows::WorkflowWithSteps { workflow: wf, steps });
    }
    Ok(ok(out))
}

async fn create_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Json(input): Json<CreateWorkflowInput>,
) -> Result<impl IntoResponse, AppError> {
    // A member may only create a workflow for a bot in their own company. The
    // uniform 404 is `authorize_session_for_human`'s, so this cannot be used to
    // probe which session slugs exist elsewhere.
    crate::scope::authorize_session_for_human(&state, ctx.as_ref(), input.session.trim()).await?;
    let created = create(&state, input).await?;
    audit_workflow_create(&state, &created.workflow, "user").await;
    emit_workflows(&state, &created.workflow, "created");
    Ok((StatusCode::CREATED, ok(json!(created))))
}

async fn get_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Path(id): Path<String>,
) -> Result<Json<Envelope<serde_json::Value>>, AppError> {
    let wf = scoped_workflow(&state, ctx.as_ref(), &id).await?;
    let steps = db::workflows::steps_for(&state.pool, &id).await?;
    // The last run summary rides along: the detail view's header renders it, and
    // a second round-trip for one row is a round-trip the UI does not need.
    let last = db::workflows::runs_for(&state.pool, &id, 1).await?.into_iter().next();
    Ok(ok(json!({
        "workflow": wf,
        "steps": steps,
        "last_run_summary": last,
    })))
}

#[derive(Debug, Deserialize)]
struct PatchInput {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    trigger_kind: Option<String>,
    #[serde(default)]
    schedule_expr: Option<String>,
    #[serde(default)]
    on_complete: Option<serde_json::Value>,
    /// Archive the target session when it stops (migration 0025): stamped onto
    /// the SESSION row, exactly as on create; see `CreateWorkflowInput`.
    /// `Some(false)` clears the marker, absent leaves it untouched.
    #[serde(default)]
    archive_on_stop: Option<bool>,
    // `session` and `company_id` are deliberately ABSENT rather than named: a
    // workflow cannot be reassigned to another bot (and therefore not to another
    // company) after it is created, and a client echoing back the object it just
    // GET'd must not be answered with a 400 for a field it never meant to change.
    // Serde drops them; `db::workflows::WorkflowPatch` has nowhere to put them.
}

async fn patch_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Path(id): Path<String>,
    Json(input): Json<PatchInput>,
) -> Result<Json<Envelope<db::workflows::WorkflowWithSteps>>, AppError> {
    let existing = scoped_workflow(&state, ctx.as_ref(), &id).await?;

    if let Some(t) = input.title.as_deref() {
        reject_wrapper_markup(&[("title", t.trim())])?;
    }
    let on_complete = match input.on_complete.as_ref() {
        Some(v) => Some(parse_on_complete(Some(v))?),
        None => None,
    };

    // Recompute the cadence when the expression changed — or when the workflow
    // is being switched back ON without one. The stored `next_run` is anchored
    // to the pre-pause fire, so re-enabling would otherwise show "next: hours
    // ago" until the tick's missed-window sweep healed it (carried over from
    // `scheduler::patch_handler`).
    let new_expr = input
        .schedule_expr
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let reparse = match &new_expr {
        Some(expr) => Some(expr.clone()),
        None if input.enabled == Some(true) && existing.enabled == 0 => {
            existing.schedule_expr.clone()
        }
        None => None,
    };
    let (next_run, trigger_kind) = match reparse {
        Some(expr) => {
            let parsed =
                parser::parse(&expr, Utc::now()).map_err(|e| AppError::BadRequest(e.to_string()))?;
            (Some(Some(parsed.next_run)), Some(parsed.sched_type.to_string()))
        }
        None => (None, None),
    };
    // An explicit switch to `manual` drops the armed fire; 0038 permits the
    // expression to stay on the row, and keeping it means "back to recurring"
    // does not make the user retype their cadence.
    let (next_run, trigger_kind) = match input.trigger_kind.as_deref() {
        Some("manual") => (Some(None), Some("manual".to_string())),
        Some(k) if k != "once" && k != "recurring" => {
            return Err(AppError::BadRequest(format!(
                "trigger_kind must be 'manual', 'once' or 'recurring' (got '{k}')"
            )))
        }
        // `once`/`recurring` are derived from the expression, never asserted.
        _ => (next_run, trigger_kind),
    };

    let patch = db::workflows::WorkflowPatch {
        title: input.title.map(|t| t.trim().to_string()),
        enabled: input.enabled,
        trigger_kind,
        schedule_expr: new_expr,
        next_run,
        on_complete,
    };
    db::workflows::patch(&state.pool, &id, &patch).await?;
    stamp_archive_on_stop(&state, &existing.session, input.archive_on_stop).await;

    let updated = db::workflows::get_with_steps(&state.pool, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("workflow '{id}'")))?;
    emit_workflows(&state, &updated.workflow, "updated");
    Ok(ok(updated))
}

/// `PUT /api/workflows/{id}/steps` — replace the ordered list ATOMICALLY.
///
/// The run ledger is untouched: `workflow_step_runs.step_id` is deliberately not
/// a foreign key, so "what actually ran" survives "what the workflow says now".
async fn put_steps_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Path(id): Path<String>,
    Json(input): Json<StepsInput>,
) -> Result<Json<Envelope<Vec<db::workflows::WorkflowStep>>>, AppError> {
    let wf = scoped_workflow(&state, ctx.as_ref(), &id).await?;
    if input.steps.is_empty() {
        return Err(AppError::BadRequest("a workflow requires at least one step".into()));
    }
    let steps = validate_steps(&state, &wf.session, &input.steps).await?;
    let saved = db::workflows::replace_steps(&state.pool, &id, &steps).await?;
    emit_workflows(&state, &wf, "steps");
    Ok(ok(saved))
}

#[derive(Debug, Deserialize)]
struct StepsInput {
    #[serde(default)]
    steps: Vec<StepBody>,
}

async fn delete_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let wf = scoped_workflow(&state, ctx.as_ref(), &id).await?;
    let deleted = db::workflows::soft_delete(&state.pool, &id).await?;
    if deleted == 0 {
        return Err(AppError::NotFound(format!("workflow '{id}'")));
    }
    let _ = db::audit::log(&state.pool, "user", "workflow.delete", &id, json!({})).await;
    emit_workflows(&state, &wf, "deleted");
    Ok(Json(json!({ "ok": true, "data": { "deleted": true } })))
}

// ── preview + commands — verbatim ports ───────────────────────────────────────

/// `POST /api/workflows/preview`. Parse `expression` WITHOUT persisting and
/// return the next up-to-5 fire times as RFC3339 strings, so the composer can
/// preview a cadence as the user types.
///
/// Moved from `scheduler::preview_handler` unchanged — the next-5-runs preview
/// is one of the few genuinely good bits of today's create dialog, so it is
/// moved, not redesigned.
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

/// `GET /api/workflows/commands?cwd=<dir>` — the REAL installed agent commands
/// the step / command picker offers: the user's skills + user/managed commands +
/// claude.ai MCP connectors. Built-in Claude slash commands are deliberately
/// excluded (a workflow step wants a skill/MCP, not `/clear`). Backed by the
/// same filesystem read the Claude-tools registry uses — one source of truth.
///
/// Moved from `scheduler::commands_handler` — and, like its `/api/schedules`
/// predecessor, **owner/admin-only**: the digest is a projection of the
/// admin-gated claude-tools registry (global skills / commands / MCP connector
/// names), and `?cwd=` points the filesystem read at an arbitrary directory.
/// `member_may_reach` already denies the route (outer fence); this in-handler
/// gate is the defense-in-depth half, same shape as the companies wizard
/// endpoints. A member gets the uniform 404.
async fn commands_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Query(q): Query<CommandsQuery>,
) -> Result<Json<Envelope<Vec<crate::claude_tools::registry::InstalledCommand>>>, AppError> {
    crate::scope::require_admin(ctx.as_ref(), "/api/workflows/commands")?;
    let cwd = q.cwd.as_deref().filter(|s| !s.is_empty());
    Ok(ok(crate::claude_tools::registry::installed_commands(&state, cwd).await?))
}

#[derive(Debug, Deserialize, Default)]
struct CommandsQuery {
    /// Optional focused session dir; when present, project-scoped skills and
    /// commands are included alongside the global ones.
    #[serde(default)]
    cwd: Option<String>,
}

/// `GET /api/workflows/import-log` — the 0038 schedules-port archive, the real
/// destination behind [`port`]'s `/settings#imported-schedules` notification.
/// Migration 0038 dropped the `schedules` table irreversibly; every pre-drop row
/// lives on in `workflows_import_log`, and this endpoint is the app's only way
/// to read them back (a refused shell job's command line included, so the user
/// can rebuild it by hand). Owner/admin-only — the archive is global,
/// pre-company data.
///
/// Each entry carries the raw columns plus `row` — `row_json` parsed — so no
/// client has to double-decode. `ported` is surfaced as a bool.
async fn import_log_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
) -> Result<Json<Envelope<serde_json::Value>>, AppError> {
    crate::scope::require_admin(ctx.as_ref(), "/api/workflows/import-log")?;
    let rows = db::workflows::import_log(&state.pool).await?;
    let data: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            let row: serde_json::Value =
                serde_json::from_str(&r.row_json).unwrap_or(serde_json::Value::Null);
            json!({
                "old_id": r.old_id,
                "ported": r.ported != 0,
                "reason": r.reason,
                "row": row,
                "at": r.at,
            })
        })
        .collect();
    Ok(ok(serde_json::Value::Array(data)))
}

// ── run now, cancel, and the run ledger ───────────────────────────────────────

/// `POST /api/workflows/{id}/run` — start the chain now.
///
/// 202, not 200: a chain can outlive the request by hours, so the honest answer
/// is "accepted, here is the run to watch". [`engine::Trigger::Manual`] never
/// claims a fire-key and never touches `next_run` — the tick still owns cadence.
async fn run_now_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let wf = scoped_workflow(&state, ctx.as_ref(), &id).await?;
    let run_id = engine::start(&state, wf.clone(), engine::Trigger::Manual).await?;
    let _ = crate::sessions::audit_harness(
        &state,
        "user",
        "workflow.run",
        &wf.id,
        json!({ "session": wf.session, "title": wf.title, "run_id": run_id }),
        &[wf.session.as_str()],
    )
    .await;
    emit_workflows(&state, &wf, "run");
    Ok((StatusCode::ACCEPTED, ok(json!({ "run_id": run_id }))))
}

/// `POST /api/workflows/{id}/cancel` — stop the in-flight run.
///
/// A chain needs a stop button: without one, a workflow whose first step parks
/// for its full 1800s deadline holds §3.2 rule 2's "one run at a time" lock and
/// blocks every later window. Cancelling closes the run row FIRST (so the
/// advance claim below is what actually stops step k+1 from being delivered) and
/// then closes the step run that was still open, so the ledger does not carry a
/// step that runs forever.
async fn cancel_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let wf = scoped_workflow(&state, ctx.as_ref(), &id).await?;
    let Some(run) = db::workflows::running_for(&state.pool, &id).await? else {
        // Not an error: "stop" on something already stopped is the outcome the
        // caller wanted, and a 404 here would make a double-click look broken.
        return Ok((StatusCode::ACCEPTED, ok(json!({ "cancelled": false }))));
    };
    engine::cancel(&state, run.id).await?;
    emit_workflows(&state, &wf, "cancelled");
    Ok((StatusCode::ACCEPTED, ok(json!({ "cancelled": true, "run_id": run.id }))))
}

#[derive(Debug, Deserialize, Default)]
struct RunsQuery {
    #[serde(default)]
    limit: Option<i64>,
}

/// `GET /api/workflows/{id}/runs` — this workflow's history, newest first, each
/// run carrying its own step rows (the timeline the detail view draws).
async fn runs_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Path(id): Path<String>,
    Query(q): Query<RunsQuery>,
) -> Result<Json<Envelope<Vec<serde_json::Value>>>, AppError> {
    scoped_workflow(&state, ctx.as_ref(), &id).await?;
    // Clamped to the retention cap: asking for more than the table keeps is a
    // question with no answer, and an unbounded limit is a table scan a client
    // should not be able to ask for.
    let limit = q.limit.unwrap_or(20).clamp(1, db::workflows::RUN_HISTORY_KEEP);
    let runs = db::workflows::runs_for(&state.pool, &id, limit).await?;
    let mut out = Vec::with_capacity(runs.len());
    for run in runs {
        let steps = db::workflows::step_runs_for(&state.pool, run.id).await?;
        out.push(json!({ "run": run, "steps": steps }));
    }
    Ok(ok(out))
}

/// `GET /api/workflows/runs` — the cross-workflow activity feed.
///
/// SCOPE-FILTERED on the run's own workflow `company_id`, which `recent_runs`
/// joins in for exactly this reason: the feed is the one place a member could
/// otherwise read another company's titles.
async fn all_runs_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
) -> Result<Json<Envelope<Vec<db::workflows::RunSummary>>>, AppError> {
    let scope = Scope::of(ctx.as_ref());
    let rows = db::workflows::recent_runs(&state.pool, 50).await?;
    Ok(ok(rows.into_iter().filter(|r| scope.sees(r.company_id)).collect()))
}

/// The `workflows` SSE frame — COMPANY-STAMPED, always (spec §5.5).
///
/// Every scheduler frame was `company_id: None`, i.e. owner-only, so a company
/// member never saw their own bot's job change. `SseEvent::for_company` with the
/// row's own derived `company_id` is the whole fix; `Scope::sees` does the rest
/// per subscriber — and it is fail-closed on `None`, so an UNSTAMPED frame would
/// silently become owner-only again. That is why every emit site in this module
/// and in [`engine`] goes through these two functions rather than building an
/// `SseEvent` by hand.
pub fn emit_workflows(state: &AppState, wf: &Workflow, change: &str) {
    emit_frame(state, wf, json!({ "change": change }));
}

/// The step/run delta frame — the same `workflows` event, carrying which run and
/// which step moved so a list can repaint one row instead of refetching.
pub fn emit_workflow_run(
    state: &AppState,
    wf: &Workflow,
    change: &str,
    run_id: i64,
    step: Option<(usize, usize)>,
) {
    let mut detail = json!({ "change": change, "run_id": run_id });
    if let Some((k, n)) = step {
        detail["step"] = json!(k + 1);
        detail["steps"] = json!(n);
    }
    emit_frame(state, wf, detail);
}

fn emit_frame(state: &AppState, wf: &Workflow, mut detail: serde_json::Value) {
    if let Some(obj) = detail.as_object_mut() {
        obj.insert("workflow".into(), json!(wf.id));
        obj.insert("session".into(), json!(wf.session));
        obj.insert("title".into(), json!(wf.title));
    }
    let _ = state.sse_tx.send(SseEvent::for_company("workflows", detail, wf.company_id));
}

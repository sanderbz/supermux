//! Agent→workflows hook endpoints (the agent-confirmed-finish tier, and agent
//! self-scheduling).
//!
//! `git mv`'d from `scheduler/hook.rs` and retyped onto workflows. **Every
//! guarantee carries over** — this is the narrowest endpoint in the codebase and
//! the owner signed off on each narrowing individually (gate G2); the comments
//! below are the originals, kept because they record *why*, not *what*.
//!
//! The reverse edge for a chain, mirroring `crate::board::hook`: every workflow
//! step carries a footer (`engine::confirm_footer`) teaching the agent to POST
//! here when its work is genuinely done. That makes completion AGENT-DECLARED —
//! the only party that truly knows the task is finished — rather than inferred
//! from idle. In a chain it is load-bearing in a way it never was for a
//! schedule: the done-edge decides whether step k+1 ever happens.
//!
//! **Auth (identical to the status + board hooks).** The request presents
//! `X-Supermux-Hook-Token`, constant-time compared against the session's stored
//! `session_runtime.hook_token`. A leaked dashboard bearer can't drive this (not
//! checked); session A's token can't authenticate as session B.
//!
//! **Scope rule.** Authentication proves *which session* you are; the object you
//! may act on is then constrained to one whose `session` equals the
//! authenticated session. So an agent can only confirm a run in its own pane —
//! never someone else's. Advancing is idempotent with the idle edge through the
//! shared fire-guard in `engine` (no step is ever delivered twice).
//!
//! ## `POST /api/hook/workflow/create` — an agent scheduling its own work
//!
//! A REAL CAPABILITY INCREASE — a running agent can put a recurring job on the
//! host with no human in the loop — so it is deliberately narrow:
//!
//! - **Scope is structural, not checked.** The row's `session` is the
//!   AUTHENTICATED one; any `session` in the payload is used for authentication
//!   and then discarded. A later refactor cannot drop a check that does not
//!   exist.
//! - **`kind`, `command`, `boot_*`, `bypass_permissions` and `_test_fire` are
//!   rejected outright**, so a workflow created here can only ever deliver a
//!   PROMPT to the pane the caller already occupies. Most of those fields no
//!   longer exist anywhere in the server; **the refusals stay** so an old
//!   payload gets a legible answer rather than a surprise.
//! - **The completion action may only be `none`, `notify` or `disable`**
//!   ([`complete::parse_for_hook`]). `command:…` is rejected (400) — on this path
//!   it would turn a per-session token into arbitrary host command execution —
//!   and so are `connector_send` and `message_bot`: a session token must not be
//!   able to arm something that emails the world or types into another bot.
//! - **There is a cap** ([`super::MAX_WORKFLOWS_PER_SESSION`]) answered with a
//!   429 the agent can act on, so a loop cannot arm unbounded work.
//! - **At most [`super::MAX_STEPS_VIA_HOOK`] steps.** v1 lets an agent chain its
//!   own follow-ups; the single-prompt form stays the default.
//! - **No natural-language parsing.** The agent brings a concrete
//!   `schedule_expr` from the grammar `/supermux-schedule` teaches it; the
//!   server validates with the same `parser::parse` the bearer path uses.
//!
//! ## The two legacy aliases are PERMANENT
//!
//! Confirm footers already delivered into running panes contain the literal
//! `"$SUPERMUX_URL/api/hook/schedule/done"` with a `schedule_id`, and the skill
//! an agent has already read teaches `/api/hook/schedule/create`. Both routes
//! therefore stay registered forever as thin aliases onto the canonical
//! handlers. This is why ported workflows KEEP their `SCHED-…` id (spec §7.2):
//! the legacy `schedule_id` resolves as a workflow id, so no mapping table is
//! needed.
//!
//! ## The body is read `Content-Type`-agnostically
//!
//! Both handlers take [`crate::extract::LenientJson`], not `axum::Json`. The
//! documentation an agent copies (`agents/supermux-schedule.md`, and
//! [`super::engine::confirm_footer`]) writes the body with `curl -d`, whose
//! default content type is `application/x-www-form-urlencoded` — which `Json`
//! answers with a bare 415 and an empty JSON body, i.e. `curl -fsS` exit 22 and
//! nothing the agent can read. See the extractor's module doc for why accepting
//! it is not a CSRF hole (the auth header is not CORS-simple).
//!
//! ## `list` / `disable` / `delete` — an agent tidying its own calendar
//!
//! Without these, a recurring workflow an agent armed for a finished job kept
//! firing until a human found it in the Schedules sheet (Menno-Marketeer's
//! 12-hourly check ran for weeks past the test week it was for). Each is
//! scoped exactly like the legacy done route: the workflow's `session` must be
//! the authenticated one, and another session's id is a 401.
//!
//! - **`list`** returns the workflows that target this session.
//! - **`disable`** pauses one. It is reversible (the owner re-enables it from
//!   the app) and grants less than `create` already does, so it applies to any
//!   workflow targeting the session, whoever set it up.
//! - **`delete`** is not reversible from the app, so it is narrower: only a
//!   workflow this session CREATED itself (its ledger create row's actor is
//!   `agent:<session>`, see [`db::workflows::creator`]). One the owner set up
//!   answers 403 with a pointer to `disable`. A missing ledger row fails closed.
//!
//! What is NOT here, and is recorded as a known limitation rather than an
//! oversight: an agent still cannot DELEGATE with its hook token
//! (`/api/agents/delegate` is bearer-only), and it cannot patch or (re-)enable
//! any workflow — not even its own. Re-arming is the owner's.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db;
use crate::error::AppError;
use crate::extract::LenientJson;
use crate::state::AppState;

use super::{complete, engine, StepBody};

/// Header the agent sets to its per-session `$SUPERMUX_HOOK_TOKEN`.
const HOOK_TOKEN_HEADER: &str = "X-Supermux-Hook-Token";

/// The agent→workflows hook sub-router. Merged at the top level of
/// `http::router` (NO bearer layer — auth is the per-session hook token,
/// validated per handler).
///
/// The two `/api/hook/schedule/*` routes are the PERMANENT legacy aliases; see
/// the module doc. They are not deprecated and they are not scheduled for
/// removal — a footer sitting in a live pane has no way to learn a new URL.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/hook/workflow/step-done", post(step_done_handler))
        .route("/api/hook/workflow/create", post(create_handler))
        .route("/api/hook/schedule/done", post(legacy_done_handler))
        .route("/api/hook/schedule/create", post(create_handler))
        .route("/api/hook/workflow/list", post(list_handler))
        .route("/api/hook/workflow/disable", post(disable_handler))
        .route("/api/hook/workflow/delete", post(delete_handler))
        .with_state(state)
}

/// Constant-time validate the presented hook token against `session`'s stored
/// token. 401 on any mismatch / missing row. Mirrors `board::hook::authenticate`.
async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    session: &str,
) -> Result<(), AppError> {
    let expected = db::sessions::runtime(&state.pool, session)
        .await?
        .map(|rt| rt.hook_token)
        .ok_or(AppError::Unauthorized)?;
    let presented = headers
        .get(HOOK_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if expected.is_empty()
        || !constant_time_eq::constant_time_eq(expected.as_bytes(), presented.as_bytes())
    {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

// ── step-done ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct StepDoneBody {
    session: String,
    run_id: i64,
}

/// `POST /api/hook/workflow/step-done` — the agent declares this step done.
///
/// It only ever WAKES the parked watcher; [`engine::confirm_step_done`] never
/// advances the chain itself, which is what makes "the idle edge and the hook
/// cannot both advance the same step" structural rather than a race. That
/// function also re-checks that the run belongs to the authenticated session:
/// the footer hands out a run id in plaintext, so the id is not a secret.
async fn step_done_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<StepDoneBody>,
) -> Result<Json<Value>, AppError> {
    authenticate(&state, &headers, &body.session).await?;
    engine::confirm_step_done(&state, body.run_id, &body.session).await;
    let _ = db::audit::log(
        &state.pool,
        &format!("agent:{}", body.session),
        "workflow.agent_confirmed",
        &body.run_id.to_string(),
        json!({ "session": body.session }),
    )
    .await;
    Ok(Json(json!({ "ok": true, "run_id": body.run_id, "status": "done" })))
}

#[derive(Debug, Deserialize)]
struct LegacyDoneBody {
    session: String,
    schedule_id: String,
}

/// `POST /api/hook/schedule/done` — the PERMANENT legacy alias.
///
/// Ported rows keep their `SCHED-…` id, so the `schedule_id` a live footer holds
/// resolves directly as a workflow id and no mapping table is needed. The step
/// it confirms is whichever run of that workflow is currently in flight — which
/// is the only run the footer could have come from.
async fn legacy_done_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<LegacyDoneBody>,
) -> Result<Json<Value>, AppError> {
    authenticate(&state, &headers, &body.session).await?;

    let wf = db::workflows::get(&state.pool, &body.schedule_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("workflow '{}'", body.schedule_id)))?;

    // Scope: an agent may only confirm a workflow that targets its own session.
    // Mismatch is Unauthorized (not NotFound) — the row exists, the caller
    // simply isn't its owner, and answering 404 would leak the opposite.
    if wf.session != body.session {
        return Err(AppError::Unauthorized);
    }

    // No run in flight is a no-op, not an error: a footer can outlive its run
    // (the step timed out, the reaper closed it, the user cancelled), and a
    // failing curl at the end of a finished job teaches the agent nothing.
    let run = db::workflows::running_for(&state.pool, &wf.id).await?;
    if let Some(run) = &run {
        engine::confirm_step_done(&state, run.id, &body.session).await;
    }

    let _ = db::audit::log(
        &state.pool,
        &format!("agent:{}", body.session),
        "workflow.agent_confirmed",
        &wf.id,
        json!({ "session": body.session }),
    )
    .await;

    Ok(Json(json!({
        "ok": true,
        "workflow": wf.id,
        "run_id": run.map(|r| r.id),
        "status": "done",
    })))
}

// ── create ───────────────────────────────────────────────────────────────────

/// What an agent may ask for. Deliberately a SUBSET of
/// [`super::CreateWorkflowInput`] rather than a re-use of it: accepting the
/// bearer struct here would mean every future field is granted to session tokens
/// by default. This way a new capability is opt-in.
#[derive(Debug, Deserialize)]
struct CreateBody {
    /// Authenticates the caller. NOT used for the row — see the module doc.
    session: String,
    title: String,
    /// The single-prompt form — the default, and what the skill teaches.
    #[serde(default)]
    prompt: Option<String>,
    /// The chain form: up to [`super::MAX_STEPS_VIA_HOOK`] steps.
    #[serde(default)]
    steps: Option<Vec<StepBody>>,
    /// A concrete expression from `workflows::parser`'s grammar. The agent does
    /// the natural-language parsing; the server never guesses.
    schedule_expr: String,
    /// The legacy spelling: `disable` (default) or `notify`. `command:…` is
    /// refused here. Kept because the skill an agent has already read teaches
    /// this field, and a live agent cannot re-read the skill.
    #[serde(default)]
    done_action: Option<String>,
    /// The typed spelling. Run through [`complete::parse_for_hook`], so the two
    /// outward-facing arms are a hard 400 on this path.
    #[serde(default)]
    on_complete: Option<Value>,

    // ── named ONLY so they can be refused with a sentence ──────────────────
    //
    // Serde ignores unknown fields, so leaving these out would silently DROP an
    // agent's `kind: "shell"` and hand back something it did not ask for — a
    // surprise, and one that reads as the endpoint having accepted the request.
    // Most of them no longer exist anywhere; the refusals stay so an old payload
    // gets a legible answer.
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    boot_dir: Option<String>,
    #[serde(default)]
    boot_provider: Option<String>,
    #[serde(default)]
    boot_worktree: Option<bool>,
    #[serde(default)]
    bypass_permissions: Option<bool>,
    #[serde(default, rename = "_test_fire")]
    test_fire: Option<bool>,
}

/// `POST /api/hook/workflow/create` (and its permanent `/api/hook/schedule/create`
/// alias) — an agent schedules a prompt for its own pane.
///
/// Authenticates as the session, forces every field that could reach beyond it,
/// then hands the rest to the SAME [`super::create`] the bearer path uses, so
/// there is one validator and two callers.
async fn create_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<CreateBody>,
) -> Result<(axum::http::StatusCode, Json<Value>), AppError> {
    let session = body.session.trim().to_string();
    authenticate(&state, &headers, &session).await?;

    let title = body.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("'title' is required".into()));
    }
    if body.schedule_expr.trim().is_empty() {
        return Err(AppError::BadRequest(
            "'schedule_expr' is required — see /supermux-schedule for the grammar".into(),
        ));
    }
    // The fields an agent may not ask for at all. Refused with a sentence rather
    // than silently dropped — see `CreateBody`.
    for (field, present) in [
        ("kind", body.kind.is_some()),
        ("command", body.command.is_some()),
        ("boot_dir", body.boot_dir.is_some()),
        ("boot_provider", body.boot_provider.is_some()),
        ("boot_worktree", body.boot_worktree.is_some()),
        ("bypass_permissions", body.bypass_permissions.is_some()),
        ("_test_fire", body.test_fire.is_some()),
    ] {
        if present {
            return Err(AppError::BadRequest(format!(
                "'{field}' is not permitted on this endpoint — a session token may only schedule a prompt for its own pane"
            )));
        }
    }

    // The steps. The single-prompt form is the default; the chain form is capped
    // well below the bearer path's 20, because a session token arms less than a
    // human at a keyboard does.
    let steps: Vec<StepBody> = match body.steps.filter(|s| !s.is_empty()) {
        Some(steps) => {
            if steps.len() > super::MAX_STEPS_VIA_HOOK {
                return Err(AppError::BadRequest(format!(
                    "a workflow created by an agent may hold at most {} steps (got {})",
                    super::MAX_STEPS_VIA_HOOK,
                    steps.len()
                )));
            }
            steps
        }
        None => {
            let prompt = body.prompt.unwrap_or_default();
            if prompt.trim().is_empty() {
                return Err(AppError::BadRequest("'prompt' is required".into()));
            }
            vec![StepBody { prompt, ..Default::default() }]
        }
    };
    // A step an agent writes may not carry a command line either: `command` is
    // refused at the top level, and it must not walk back in through a step.
    for (i, s) in steps.iter().enumerate() {
        if !s.command.trim().is_empty() {
            return Err(AppError::BadRequest(format!(
                "'command' is not permitted on this endpoint (steps[{i}]) — a session token may \
                 only schedule a prompt for its own pane"
            )));
        }
        if s.prompt.trim().is_empty() {
            return Err(AppError::BadRequest(format!("steps[{i}]: 'prompt' is required")));
        }
    }

    // G2: a session token may not become host command execution, nor an outward
    // send. Both spellings land on the same typed enum, through the hook parser.
    let on_complete = hook_completion(body.done_action.as_deref(), body.on_complete.as_ref())?;

    // The cap, BEFORE the insert. Counted over live rows for this session only —
    // one agent filling its own quota must not stop another from scheduling.
    let owned = db::workflows::count_for_session(&state.pool, &session).await? as usize;
    if owned >= super::MAX_WORKFLOWS_PER_SESSION {
        return Err(AppError::TooManyRequests(format!(
            "this session already owns {owned} workflows (max {}) — delete one before creating another",
            super::MAX_WORKFLOWS_PER_SESSION
        )));
    }

    // One validator, two callers: the expression grammar, the wrapper-markup
    // rule, the uploads jail and the `next_run` computation are `create`'s,
    // unchanged.
    let created = super::create(
        &state,
        super::CreateWorkflowInput {
            title: title.to_string(),
            // FORCED: see the module doc. Not defaulted — forced, so a payload
            // that asked for something else gets it dropped rather than honoured.
            session: session.clone(),
            schedule_expr: Some(body.schedule_expr.clone()),
            on_complete: Some(on_complete),
            steps,
            ..Default::default()
        },
    )
    .await?;

    // The ledger row + `harness` tick, with the AGENT as the actor — so the
    // transcript's "Created workflow ⏱ …" line is attributed to the session that
    // asked rather than to the owner who did not. `SURFACED_ACTIONS` and
    // `HarnessLine` already consume this exact shape; the line falls out free.
    super::audit_workflow_create(&state, &created.workflow, &format!("agent:{session}")).await;
    super::emit_workflows(&state, &created.workflow, "created");

    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "ok": true, "data": created })),
    ))
}

// ── list / disable / delete ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ListBody {
    session: String,
}

#[derive(Debug, Deserialize)]
struct ManageBody {
    session: String,
    #[serde(default)]
    id: String,
}

/// Whether `session` created workflow `id` itself (see the module doc).
async fn created_by(state: &AppState, id: &str, session: &str) -> Result<bool, AppError> {
    let creator = db::workflows::creator(&state.pool, id).await?;
    Ok(creator.as_deref() == Some(format!("agent:{session}").as_str()))
}

/// Load a workflow the authenticated session may act on: it must exist and
/// target that session. Another session's workflow is a 401, as on the legacy
/// done route.
async fn own_workflow(
    state: &AppState,
    session: &str,
    id: &str,
) -> Result<db::workflows::Workflow, AppError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(AppError::BadRequest(
            "'id' is required — `supermux-schedule list` shows your workflow ids".into(),
        ));
    }
    let wf = db::workflows::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("workflow '{id}'")))?;
    if wf.session != session {
        return Err(AppError::Unauthorized);
    }
    Ok(wf)
}

/// `POST /api/hook/workflow/list` — the workflows that target this session.
async fn list_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<ListBody>,
) -> Result<Json<Value>, AppError> {
    let session = body.session.trim().to_string();
    authenticate(&state, &headers, &session).await?;

    let mut out = Vec::new();
    for wf in db::workflows::list_for_session(&state.pool, &session).await? {
        let steps = db::workflows::steps_for(&state.pool, &wf.id).await?;
        let created_by_you = created_by(&state, &wf.id, &session).await?;
        out.push(json!({
            "id": wf.id,
            "title": wf.title,
            "enabled": wf.enabled != 0,
            "trigger": wf.trigger_kind,
            "schedule_expr": wf.schedule_expr,
            "next_run": wf.next_run,
            "last_run": wf.last_run,
            "run_count": wf.run_count,
            "created_by_you": created_by_you,
            "steps": steps
                .iter()
                .map(|s| json!({ "title": s.title, "command": s.command, "prompt": s.prompt }))
                .collect::<Vec<_>>(),
        }));
    }
    Ok(Json(json!({ "ok": true, "data": out })))
}

/// `POST /api/hook/workflow/disable` — pause one of this session's workflows.
/// Idempotent: an already-paused workflow answers 200 with `changed: false`.
async fn disable_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<ManageBody>,
) -> Result<Json<Value>, AppError> {
    let session = body.session.trim().to_string();
    authenticate(&state, &headers, &session).await?;
    let wf = own_workflow(&state, &session, &body.id).await?;

    let changed = wf.enabled != 0;
    if changed {
        db::workflows::set_enabled(&state.pool, &wf.id, false).await?;
        let _ = db::audit::log(
            &state.pool,
            &format!("agent:{session}"),
            "workflow.disable",
            &wf.id,
            json!({ "session": session, "title": wf.title }),
        )
        .await;
        if let Some(updated) = db::workflows::get(&state.pool, &wf.id).await? {
            super::emit_workflows(&state, &updated, "updated");
        }
    }
    Ok(Json(json!({
        "ok": true,
        "data": { "id": wf.id, "title": wf.title, "enabled": false, "changed": changed },
    })))
}

/// `POST /api/hook/workflow/delete` — delete a workflow this session created
/// itself. One the owner set up is a 403: the agent may only pause it.
async fn delete_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<ManageBody>,
) -> Result<Json<Value>, AppError> {
    let session = body.session.trim().to_string();
    authenticate(&state, &headers, &session).await?;
    let wf = own_workflow(&state, &session, &body.id).await?;

    if !created_by(&state, &wf.id, &session).await? {
        return Err(AppError::Forbidden(format!(
            "workflow '{}' was not created by this session, so only the owner can delete it — \
             you can pause it with `supermux-schedule disable {}`",
            wf.id, wf.id
        )));
    }
    if db::workflows::soft_delete(&state.pool, &wf.id).await? == 0 {
        return Err(AppError::NotFound(format!("workflow '{}'", wf.id)));
    }
    let _ = db::audit::log(
        &state.pool,
        &format!("agent:{session}"),
        "workflow.delete",
        &wf.id,
        json!({ "session": session, "title": wf.title }),
    )
    .await;
    super::emit_workflows(&state, &wf, "deleted");
    Ok(Json(json!({
        "ok": true,
        "data": { "id": wf.id, "title": wf.title, "deleted": true },
    })))
}

/// Resolve the two spellings of "what happens when it finishes" into the ONE
/// typed value this path allows, and refuse everything else by name.
///
/// `done_action` is the legacy string a live agent's skill still teaches;
/// `on_complete` is the typed object the current API takes. Whichever arrives,
/// it ends up in [`complete::parse_for_hook`], which is where `connector_send`
/// and `message_bot` become a 400.
fn hook_completion(
    done_action: Option<&str>,
    on_complete: Option<&Value>,
) -> Result<Value, AppError> {
    if let Some(v) = on_complete.filter(|v| !v.is_null()) {
        let action = complete::parse_for_hook(&v.to_string())?;
        return Ok(serde_json::to_value(action).unwrap_or_else(|_| json!({ "kind": "none" })));
    }
    let a = done_action.unwrap_or("disable");
    match a {
        "disable" => Ok(json!({ "kind": "disable" })),
        "notify" => Ok(json!({ "kind": "notify" })),
        "none" => Ok(json!({ "kind": "none" })),
        _ => Err(AppError::BadRequest(
            "done_action must be 'disable' or 'notify' on this endpoint".into(),
        )),
    }
}

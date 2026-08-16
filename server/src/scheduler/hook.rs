//! Agent→scheduler hook endpoint (the agent-confirmed-finish tier).
//!
//! The reverse edge for schedules, mirroring `crate::board::hook`: a `tmux`
//! schedule created with `confirm_finish` injects a footer (see
//! `runner::confirm_footer`) teaching the agent to POST here when its scheduled
//! work is genuinely done. That makes completion AGENT-DECLARED — the only party
//! that truly knows the task is finished — rather than inferred from idle.
//!
//! **Auth (identical to the status + board hooks).** The request presents
//! `X-Supermux-Hook-Token`, constant-time compared against the session's stored
//! `session_runtime.hook_token`. A leaked dashboard bearer can't drive this (not
//! checked); session A's token can't authenticate as session B.
//!
//! **Scope rule.** Authentication proves *which session* you are; the schedule
//! you may complete is then constrained to one whose `session` equals the
//! authenticated session. So an agent can only confirm a schedule that targets
//! its own pane — never someone else's. Completion is idempotent with the watch
//! loop via the shared fire-guard in `watch` (no double `done_action`).
//!
//! ## `POST /api/hook/schedule/create` — an agent scheduling its own work
//!
//! Fase B4 T6. This is a REAL CAPABILITY INCREASE — a running agent can put a
//! recurring job on the host with no human in the loop — so it is deliberately
//! the narrowest endpoint in the codebase, and the owner signed off on each
//! narrowing (gate G2):
//!
//! - **Scope is structural, not checked.** The row's `session` is the
//!   AUTHENTICATED one; any `session` in the payload is used for authentication
//!   and then discarded. A later refactor cannot drop a check that does not
//!   exist.
//! - **`kind` is forced to `tmux`.** `shell` runs a command on the host and
//!   `boot` launches a fresh agent in a directory of the caller's choosing;
//!   neither is a thing "schedule my own follow-up" needs.
//! - **`done_action` may only be `disable` or `notify`.** `command:…` is
//!   rejected (400): the bearer path keeps it, but on this path it would turn a
//!   per-session token into arbitrary host command execution.
//! - **`command`, `boot_*` and `bypass_permissions` are rejected outright**, so
//!   a schedule created here can only ever deliver a PROMPT to the pane the
//!   caller already occupies.
//! - **There is a cap** ([`MAX_SCHEDULES_PER_SESSION`]) answered with a 429 the
//!   agent can act on, so a loop cannot arm unbounded work.
//! - **No natural-language parsing.** The agent brings a concrete
//!   `schedule_expr` from the grammar `/supermux-schedule` teaches it; the
//!   server validates with the same `parser::parse` the bearer path uses.
//!
//! What is NOT here, and is recorded as a known limitation rather than an
//! oversight: an agent still cannot DELEGATE with its hook token
//! (`/api/agents/delegate` is bearer-only), and it cannot run, patch, enable or
//! delete any schedule — not even its own. Creation is the whole of it.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db;
use crate::error::AppError;
use crate::state::AppState;

use super::watch;

/// Header the agent sets to its per-session `$SUPERMUX_HOOK_TOKEN`.
const HOOK_TOKEN_HEADER: &str = "X-Supermux-Hook-Token";

/// The agent→scheduler hook sub-router. Merged at the top level of `http::router`
/// (NO bearer layer — auth is the per-session hook token, validated per handler).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/hook/schedule/done", post(done_handler))
        .route("/api/hook/schedule/create", post(create_handler))
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

#[derive(Debug, Deserialize)]
struct DoneBody {
    session: String,
    schedule_id: String,
}

/// `POST /api/hook/schedule/done` — the agent declares its scheduled task done.
/// Authenticates the session, scopes to a schedule the session actually targets,
/// then fires the schedule's `done_action` (deduped with the watch loop).
async fn done_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<DoneBody>,
) -> Result<Json<Value>, AppError> {
    authenticate(&state, &headers, &body.session).await?;

    let sched = db::schedules::get(&state.pool, &body.schedule_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("schedule '{}'", body.schedule_id)))?;

    // Scope: an agent may only confirm a schedule that targets its own session.
    // Mismatch is Unauthorized (not NotFound) — the schedule exists, the caller
    // simply isn't its owner.
    if sched.session != body.session {
        return Err(AppError::Unauthorized);
    }

    watch::confirm_done(&state, &sched).await;

    let _ = db::audit::log(
        &state.pool,
        &format!("agent:{}", body.session),
        "schedule.agent_confirmed",
        &sched.id,
        json!({ "session": body.session }),
    )
    .await;

    Ok(Json(json!({ "ok": true, "schedule": sched.id, "status": "done" })))
}

// ── create (fase B4 T6) ──────────────────────────────────────────────────────

/// The most live schedules one session may own.
///
/// Owner gate G2's number. "Live" means present in the `schedules` table and
/// not soft-deleted — a DISABLED schedule still counts, because it is still a
/// row somebody has to reason about and re-enabling it is one PATCH away.
/// Twenty is far above any real use (the busiest hand-written session on this
/// host owns three) and far below "an agent in a loop filled the table".
pub const MAX_SCHEDULES_PER_SESSION: usize = 20;

/// What an agent may ask for. Deliberately a SUBSET of `CreateScheduleInput`
/// rather than a re-use of it: the bearer struct has seventeen fields, and
/// accepting it here would mean every future field is granted to session tokens
/// by default. This way a new capability is opt-in.
#[derive(Debug, Deserialize)]
struct CreateBody {
    /// Authenticates the caller. NOT used for the row — see the module doc.
    session: String,
    title: String,
    prompt: String,
    /// A concrete expression from `scheduler::parser`'s grammar. The agent does
    /// the natural-language parsing; the server never guesses.
    schedule_expr: String,
    /// `disable` (default) or `notify`. `command:…` is refused here.
    #[serde(default)]
    done_action: Option<String>,

    // ── named ONLY so they can be refused with a sentence ──────────────────
    //
    // Serde ignores unknown fields, so leaving these out would silently DROP an
    // agent's `kind: "shell"` and hand back a `tmux` schedule it did not ask
    // for — a surprise, and one that reads as the endpoint having accepted the
    // request. Naming them means the refusal is explicit and legible; the
    // module doc says why each one is refused.
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

/// `POST /api/hook/schedule/create` — an agent schedules a prompt for its own
/// pane. Authenticates as the session, forces every field that could reach
/// beyond it, then hands the rest to the SAME `scheduler::create` the bearer
/// path uses so there is one validator and two callers.
async fn create_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateBody>,
) -> Result<(axum::http::StatusCode, Json<Value>), AppError> {
    let session = body.session.trim().to_string();
    authenticate(&state, &headers, &session).await?;

    let title = body.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("'title' is required".into()));
    }
    if body.prompt.trim().is_empty() {
        return Err(AppError::BadRequest("'prompt' is required".into()));
    }
    if body.schedule_expr.trim().is_empty() {
        return Err(AppError::BadRequest(
            "'schedule_expr' is required — see /supermux-schedule for the grammar".into(),
        ));
    }
    // The prompt becomes a `<supermux-schedule>` body in this session's own
    // transcript, and the title becomes a `SystemEntity` in it. Refuse markup
    // that could forge either wrapper, by the same rule and for the same reason
    // `agents::delegate` does — a schedule an agent wrote for itself is still
    // untrusted text arriving in a transcript.
    for (field, value) in [("title", title), ("prompt", body.prompt.as_str())] {
        if crate::agents::delegate::wrapper_markup(value) {
            return Err(AppError::BadRequest(format!(
                "'{field}' may not contain supermux wrapper markup"
            )));
        }
    }
    // The fields an agent may not ask for at all. Refused with a sentence
    // rather than silently dropped — see `CreateBody`.
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
    // G2: a session token may not become host command execution.
    let done_action = body.done_action.unwrap_or_else(|| "disable".into());
    if done_action != "disable" && done_action != "notify" {
        return Err(AppError::BadRequest(
            "done_action must be 'disable' or 'notify' on this endpoint".into(),
        ));
    }

    // The cap, BEFORE the insert. Counted over live rows for this session only
    // — one agent filling its own quota must not stop another from scheduling.
    let owned = db::schedules::list(&state.pool)
        .await?
        .into_iter()
        .filter(|s| s.session == session)
        .count();
    if owned >= MAX_SCHEDULES_PER_SESSION {
        return Err(AppError::TooManyRequests(format!(
            "this session already owns {owned} schedules (max {MAX_SCHEDULES_PER_SESSION}) — delete one before creating another"
        )));
    }

    // One validator, two callers: the expression grammar, the kind rules and
    // the `next_run` computation are `scheduler::create`'s, unchanged.
    let sched = super::create(
        &state,
        super::CreateScheduleInput {
            title: title.to_string(),
            prompt: body.prompt.clone(),
            // FORCED, all four: see the module doc. Not defaulted — forced, so
            // a payload that asked for something else gets it dropped rather
            // than honoured.
            session: Some(session.clone()),
            kind: Some("tmux".into()),
            schedule_expr: Some(body.schedule_expr.clone()),
            done_action: Some(done_action),
            ..Default::default()
        },
    )
    .await?;

    // The ledger row + `harness` tick, with the AGENT as the actor — so the
    // transcript's "Created schedule ⏱ …" line is attributed to the session
    // that asked rather than to the owner who did not. `SURFACED_ACTIONS` and
    // `HarnessLine` already consume this exact shape; the line falls out free.
    super::audit_schedule_create(&state, &sched, &format!("agent:{session}")).await;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "ok": true, "data": sched })),
    ))
}

//! Kanban board HTTP surface (TECH_PLAN §3.2.10, §3.4, M6; feature-extract §2).
//!
//! **Router-registry pattern (§3.4).** [`router_for`] returns the protected
//! sub-router (merged by `http::router` under the bearer-auth layer);
//! [`public_router_for`] returns the single PUBLIC route — the iCal feed — which
//! is merged OUTSIDE that layer.
//!
//! Endpoints (feature-extract §2.1): list/create/clear-done/patch/delete issues,
//! the atomic [`claim`], statuses CRUD + reorder, tag-completion, and the iCal
//! export. Every mutation re-publishes the board over SSE (§2.8) so clients never
//! poll (anti-vision: WebSocket/SSE only). `delete` and `claim` also append an
//! `audit_log` row (§6.4 / M6 prompt).

pub mod claim;
pub mod dispatch;
pub mod hook;
pub mod prefix;

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db;
use crate::db::board::{AcceptanceItem, Issue, IssueComment, IssueField, IssueLink, NewIssue};
use crate::error::AppError;
use crate::state::{AppState, SseEvent};

use claim::ClaimError;

/// Build the protected board sub-router (no auth layer — applied by `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::{delete, get, patch, post, put};
    Router::new()
        .route("/api/board", get(list_handler).post(create_handler))
        .route("/api/board/clear-done", post(clear_done_handler))
        .route(
            "/api/board/statuses",
            get(list_statuses_handler).post(create_status_handler),
        )
        .route("/api/board/statuses/reorder", put(reorder_statuses_handler))
        .route(
            "/api/board/statuses/{id}",
            delete(delete_status_handler).patch(rename_status_handler),
        )
        .route("/api/board/tag-completion", get(tag_completion_handler))
        // AB2 — human-side (bearer) comment + acceptance + link CRUD.
        .route("/api/board/{id}/comment", post(comment_handler))
        .route(
            "/api/board/{id}/acceptance",
            post(add_acceptance_handler),
        )
        .route(
            "/api/board/{id}/acceptance/reorder",
            put(reorder_acceptance_handler),
        )
        .route(
            "/api/board/{id}/acceptance/{item_id}",
            patch(patch_acceptance_handler).delete(delete_acceptance_handler),
        )
        .route("/api/board/{id}/link", post(add_link_handler))
        .route(
            "/api/board/{id}/link/{link_id}",
            delete(delete_link_handler),
        )
        .route("/api/board/{id}", patch(patch_handler).delete(delete_handler))
        .route("/api/board/{id}/claim", post(claim_handler))
        .with_state(state)
}

/// Build the agent→board hook sub-router (AB1). Re-export of [`hook::router_for`]
/// so `http::router` mounts it OUTSIDE the bearer layer alongside the status hook.
pub fn hook_router_for(state: AppState) -> Router {
    hook::router_for(state)
}

/// Build the public board sub-router (iCal feed; no auth — feature-extract §2.7).
pub fn public_router_for(state: AppState) -> Router {
    use axum::routing::get;
    Router::new()
        .route("/api/calendar.ics", get(calendar_handler))
        .with_state(state)
}

// ── HTTP envelope ────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct Envelope<T> {
    ok: bool,
    data: T,
}

fn ok<T: Serialize>(data: T) -> Json<Envelope<T>> {
    Json(Envelope { ok: true, data })
}

// ── view model (feature-extract §2.2 issue response shape) ────────────────────

#[derive(Debug, Serialize)]
pub struct IssueView {
    pub id: String,
    pub title: String,
    pub desc: String,
    pub status: String,
    pub session: Option<String>,
    pub creator: String,
    pub due: Option<String>,
    pub due_time: Option<String>,
    pub created: i64,
    pub updated: i64,
    pub owner_type: String,
    pub pinned: i64,
    pub pos: f64,
    pub tags: Vec<String>,
    /// Board↔agent relations (migration 0010), carried inline so the SSE/REST
    /// board payload renders the card + sheet with no extra round-trips. Always
    /// present — empty vecs when the issue has no comments/items/links.
    pub comments: Vec<IssueComment>,
    pub acceptance: Vec<AcceptanceItem>,
    pub links: Vec<IssueLink>,
    /// R1 session→board reaction flags (migration 0011). `needs_review` is set
    /// when the owning agent went idle (turn finished); `awaiting_input` is set
    /// when it is blocked waiting on the user. The board badges the card off
    /// these; a human clears them.
    pub needs_review: bool,
    pub awaiting_input: bool,
    /// R2 link liveness — computed at load time (NOT stored). `true` when this
    /// issue's `session` points to a session row that still exists and is NOT
    /// archived; `false` when the link is dangling (no session) or points at an
    /// archived/deleted session. The card uses this to show "session archived —
    /// reassign?" instead of a confidently-wrong live dot. An issue with no
    /// `session` is reported `false` (there is no live link to show).
    pub session_live: bool,
}

impl IssueView {
    fn from(
        issue: Issue,
        tags: Vec<String>,
        comments: Vec<IssueComment>,
        acceptance: Vec<AcceptanceItem>,
        links: Vec<IssueLink>,
        session_live: bool,
    ) -> Self {
        IssueView {
            id: issue.id,
            title: issue.title,
            desc: issue.desc,
            status: issue.status,
            session: issue.session,
            creator: issue.creator,
            due: issue.due,
            due_time: issue.due_time,
            created: issue.created,
            updated: issue.updated,
            owner_type: issue.owner_type,
            pinned: issue.pinned,
            pos: issue.pos,
            tags,
            comments,
            acceptance,
            links,
            needs_review: issue.needs_review != 0,
            awaiting_input: issue.awaiting_input != 0,
            session_live,
        }
    }
}

/// R2 link liveness: is `session` a live (existing, non-archived) session? An
/// unassigned issue (`None`) is never "live". Computed from the sessions table at
/// load time — no schema impact (plan §C.3).
async fn session_is_live(state: &AppState, session: Option<&str>) -> Result<bool, AppError> {
    match session {
        Some(name) if !name.is_empty() => {
            Ok(db::sessions::exists_active(&state.pool, name).await?)
        }
        _ => Ok(false),
    }
}

/// Load one issue + its tags and 0010 relations as a view, or 404.
async fn view_of(state: &AppState, id: &str) -> Result<IssueView, AppError> {
    let issue = db::board::get_issue(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("issue '{id}'")))?;
    let tags = db::board::tags_for(&state.pool, id).await?;
    let comments = db::board::comments_for(&state.pool, id).await?;
    let acceptance = db::board::acceptance_for(&state.pool, id).await?;
    let links = db::board::links_for(&state.pool, id).await?;
    let live = session_is_live(state, issue.session.as_deref()).await?;
    Ok(IssueView::from(issue, tags, comments, acceptance, links, live))
}

/// Load the full board (used by `GET /api/board` and the SSE re-publish). The
/// 0010 relations are batch-loaded in three grouped queries keyed by `issue_id`
/// (not one query per issue) so a big board stays O(1) round-trips per relation.
async fn load_board(state: &AppState, done_limit: i64) -> Result<Vec<IssueView>, AppError> {
    let issues = db::board::list_issues(&state.pool, done_limit).await?;
    let ids: Vec<String> = issues.iter().map(|i| i.id.clone()).collect();

    let mut comments = db::board::comments_for_issues(&state.pool, &ids).await?;
    let mut acceptance = db::board::acceptance_for_issues(&state.pool, &ids).await?;
    let mut links = db::board::links_for_issues(&state.pool, &ids).await?;

    // R2 link liveness, batched: one list of the live (non-archived) sessions,
    // then an O(1) set membership per card — no per-issue session probe.
    let live_sessions: std::collections::HashSet<String> = db::sessions::list(&state.pool)
        .await?
        .into_iter()
        .map(|s| s.name)
        .collect();

    let mut out = Vec::with_capacity(issues.len());
    for issue in issues {
        // tags keep their per-issue query (existing behaviour, small + indexed).
        let tags = db::board::tags_for(&state.pool, &issue.id).await?;
        let c = comments.remove(&issue.id).unwrap_or_default();
        let a = acceptance.remove(&issue.id).unwrap_or_default();
        let l = links.remove(&issue.id).unwrap_or_default();
        let live = issue
            .session
            .as_deref()
            .is_some_and(|s| live_sessions.contains(s));
        out.push(IssueView::from(issue, tags, c, a, l, live));
    }
    Ok(out)
}

/// Re-publish the board over SSE after a mutation (§2.8). Best-effort: a send
/// error just means no SSE subscribers are connected.
///
/// `pub(crate)` so the session lifecycle (R2) and the auto_actions reaction (R1)
/// can re-publish the board when a session change makes an open board stale —
/// e.g. archiving a session that owns a `doing` issue flips that card's
/// `session_live` to false, and the board must reflect it without a manual refetch.
pub(crate) async fn emit_board(state: &AppState) {
    if let Ok(board) = load_board(state, 0).await {
        let _ = state.sse_tx.send(SseEvent {
            event: "board".to_string(),
            payload: serde_json::to_value(&board).unwrap_or(serde_json::Value::Null),
        });
    }
}

/// Surface an `alerts` SSE event (used by the auto-notify-on-assign path, §2.6).
fn emit_alert(state: &AppState, session: &str, detail: &str) {
    let _ = state.sse_tx.send(SseEvent {
        event: "alerts".to_string(),
        payload: json!([{ "level": "info", "session": session, "detail": detail }]),
    });
}

// ── validation helpers ───────────────────────────────────────────────────────

const OWNER_TYPES: [&str; 2] = ["human", "agent"];

/// Confirm `status` is a known column, for a clean 400 instead of a dangling id.
async fn valid_status(state: &AppState, status: &str) -> Result<bool, AppError> {
    Ok(db::board::get_status(&state.pool, status).await?.is_some())
}

/// Confirm an assignee session exists (the `issues.session` FK requires it).
async fn session_exists(state: &AppState, name: &str) -> Result<bool, AppError> {
    Ok(db::sessions::exists(&state.pool, name).await?)
}

/// Auto-send-on-assign (S3; feature-extract §2.6). When an agent-owned issue is
/// assigned to a session via PATCH, deliver the work to that session — the same
/// auto-send the claim does, but on the assignment path. This replaces the dead
/// `notified` TODO ("the literal tmux send_text lands with M3"): the send now
/// actually exists, via the steering deliver-loop. `notified` is kept purely as
/// the dedupe latch so one assignment dispatches at most once.
///
/// Returns the enqueued steer id when a dispatch fired (so a future UI could
/// surface Undo on the patch path too); `None` when nothing was sent.
async fn maybe_notify_assignee(state: &AppState, id: &str) -> Result<Option<i64>, AppError> {
    let Some(issue) = db::board::get_issue(&state.pool, id).await? else {
        return Ok(None);
    };
    let Some(session) = issue.session.clone() else {
        return Ok(None);
    };
    // Deliver on assignment to a fresh agent task (not a self-assign by the
    // creator), exactly once per assignment.
    let claimable = issue.status == "todo" || issue.status == "backlog";
    let needs_send = issue.owner_type == "agent"
        && claimable
        && issue.notified == 0
        && issue.creator != session
        && session_exists(state, &session).await?;
    if !needs_send {
        return Ok(None);
    }
    // Observable alert (kept for any browser listening) + the real dispatch.
    emit_alert(state, &session, &format!("New task assigned: {}", issue.title));
    let payload = dispatch::build_payload(&state.pool, &issue, &session).await?;
    let steer_id = db::steering::enqueue(&state.pool, &session, &payload).await?;
    db::board::patch_issue(&state.pool, id, &[IssueField::Notified(1)]).await?;
    Ok(Some(steer_id))
}

// ── issues ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ListQuery {
    /// `done` items cap; 0 (or omitted-as-100) per feature-extract §2.1.
    done_limit: Option<i64>,
}

async fn list_handler(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Envelope<Vec<IssueView>>>, AppError> {
    let done_limit = q.done_limit.unwrap_or(100).max(0);
    Ok(ok(load_board(&state, done_limit).await?))
}

#[derive(Debug, Deserialize)]
struct CreateInput {
    title: String,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    due: Option<String>,
    #[serde(default)]
    due_time: Option<String>,
    #[serde(default)]
    creator: Option<String>,
    #[serde(default)]
    desc: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    owner_type: Option<String>,
    #[serde(default)]
    pos: Option<f64>,
}

async fn create_handler(
    State(state): State<AppState>,
    Json(input): Json<CreateInput>,
) -> Result<impl IntoResponse, AppError> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::BadRequest("title is required".into()));
    }
    let status = input.status.unwrap_or_else(|| "todo".into());
    if !valid_status(&state, &status).await? {
        return Err(AppError::BadRequest(format!("unknown status '{status}'")));
    }
    let owner_type = input.owner_type.unwrap_or_else(|| "human".into());
    if !OWNER_TYPES.contains(&owner_type.as_str()) {
        return Err(AppError::BadRequest(format!(
            "invalid owner_type '{owner_type}'"
        )));
    }
    // Normalise the assignee: empty string → unassigned; otherwise it must exist
    // (the `issues.session` FK rejects unknown names).
    let session = match input.session.as_deref().map(str::trim) {
        Some("") | None => None,
        Some(s) => {
            if !session_exists(&state, s).await? {
                return Err(AppError::BadRequest(format!("unknown session '{s}'")));
            }
            Some(s.to_string())
        }
    };

    let new_prefix = prefix::prefix_from_session(session.as_deref());
    let id = prefix::next_id(&state.pool, &new_prefix)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;

    // New cards sit at the top of their column: min(pos) - 1024 (§2.4).
    let pos = match input.pos {
        Some(p) => p,
        None => db::board::min_pos_in_status(&state.pool, &status).await? - 1024.0,
    };

    let new = NewIssue {
        id: id.clone(),
        title,
        desc: input.desc.unwrap_or_default(),
        status,
        session,
        creator: input.creator.unwrap_or_default(),
        due: norm_opt(input.due),
        due_time: norm_opt(input.due_time),
        owner_type,
        pos,
        notified: 0,
    };
    db::board::insert_issue(&state.pool, &new).await?;
    if let Some(tags) = input.tags {
        db::board::set_tags(&state.pool, &id, &tags).await?;
    }
    maybe_notify_assignee(&state, &id).await?;
    emit_board(&state).await;

    let v = view_of(&state, &id).await?;
    Ok((StatusCode::CREATED, ok(v)))
}

#[derive(Debug, Deserialize)]
struct PatchInput {
    title: Option<String>,
    desc: Option<String>,
    status: Option<String>,
    /// Present (even as JSON null) means "set the assignee"; absent means leave.
    #[serde(default, deserialize_with = "double_option")]
    session: Option<Option<String>>,
    due: Option<String>,
    due_time: Option<String>,
    owner_type: Option<String>,
    pinned: Option<bool>,
    pos: Option<f64>,
    tags: Option<Vec<String>>,
    creator: Option<String>,
}

async fn patch_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<PatchInput>,
) -> Result<Json<Envelope<IssueView>>, AppError> {
    // 404 up-front so a no-op patch on a missing issue is still a clean 404.
    db::board::get_issue(&state.pool, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("issue '{id}'")))?;

    let mut fields: Vec<IssueField> = Vec::new();
    let mut session_changed = false;

    if let Some(v) = input.title {
        fields.push(IssueField::Title(v));
    }
    if let Some(v) = input.desc {
        fields.push(IssueField::Desc(v));
    }
    if let Some(v) = input.status {
        if !valid_status(&state, &v).await? {
            return Err(AppError::BadRequest(format!("unknown status '{v}'")));
        }
        fields.push(IssueField::Status(v));
    }
    if let Some(opt) = input.session {
        let session = match opt.as_deref().map(str::trim) {
            Some("") | None => None,
            Some(s) => {
                if !session_exists(&state, s).await? {
                    return Err(AppError::BadRequest(format!("unknown session '{s}'")));
                }
                Some(s.to_string())
            }
        };
        fields.push(IssueField::Session(session));
        session_changed = true;
    }
    if let Some(v) = input.due {
        fields.push(IssueField::Due(norm_opt(Some(v))));
    }
    if let Some(v) = input.due_time {
        fields.push(IssueField::DueTime(norm_opt(Some(v))));
    }
    if let Some(v) = input.owner_type {
        if !OWNER_TYPES.contains(&v.as_str()) {
            return Err(AppError::BadRequest(format!("invalid owner_type '{v}'")));
        }
        fields.push(IssueField::OwnerType(v));
    }
    if let Some(v) = input.pinned {
        fields.push(IssueField::Pinned(v as i64));
    }
    if let Some(v) = input.pos {
        fields.push(IssueField::Pos(v));
    }
    if let Some(v) = input.creator {
        fields.push(IssueField::Creator(v));
    }
    // Re-assigning resets the notify flag so the new assignee gets pinged (§2.6).
    if session_changed {
        fields.push(IssueField::Notified(0));
    }

    if fields.is_empty() && input.tags.is_none() {
        return Err(AppError::BadRequest("no recognized field".into()));
    }
    if !fields.is_empty() {
        db::board::patch_issue(&state.pool, &id, &fields).await?;
    }
    if let Some(tags) = input.tags {
        db::board::set_tags(&state.pool, &id, &tags).await?;
    }
    if session_changed {
        maybe_notify_assignee(&state, &id).await?;
    }
    emit_board(&state).await;
    Ok(ok(view_of(&state, &id).await?))
}

async fn delete_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let deleted = db::board::soft_delete(&state.pool, &id).await?;
    if !deleted {
        return Err(AppError::NotFound(format!("issue '{id}'")));
    }
    // Audit (§6.4 / M6 prompt): record the soft-delete.
    db::audit::log(&state.pool, "user", "issue.delete", &id, json!({})).await?;
    emit_board(&state).await;
    Ok(Json(json!({ "ok": true, "deleted": id })))
}

async fn clear_done_handler(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let remaining = db::board::clear_done(&state.pool).await?;
    emit_board(&state).await;
    Ok(Json(json!({ "ok": true, "remaining": remaining })))
}

// ── atomic claim ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ClaimInput {
    session: String,
    /// Auto-send the work to the agent (S3, user default = true). When true, the
    /// claim enqueues the issue's dispatch payload into the session via the
    /// existing steering deliver-loop (auto-wakes a stopped session). Set false
    /// for "Claim only" — flip the DB link without dispatching.
    #[serde(default = "default_deliver")]
    deliver: bool,
}

fn default_deliver() -> bool {
    true
}

/// The claim response carries the full issue view PLUS the dispatch outcome so
/// the UI can render the "Sent to <session>" toast + an Undo (the `steer_id` is
/// what the UI passes to `DELETE /api/sessions/{session}/steering` / the unsend).
#[derive(Debug, Serialize)]
struct ClaimResult {
    issue: IssueView,
    /// True when a steer was enqueued (deliver=true and the agent got the work).
    delivered: bool,
    /// The steering-queue row id of the just-enqueued dispatch, for the Undo
    /// toast. `None` when `deliver` was false. Pass to the unsend endpoint to
    /// retract a still-undelivered steer.
    steer_id: Option<i64>,
}

async fn claim_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<ClaimInput>,
) -> Result<Json<Envelope<ClaimResult>>, AppError> {
    let session = input.session.trim().to_string();
    if session.is_empty() {
        return Err(AppError::BadRequest("session is required".into()));
    }
    // The claim sets `issues.session`; the FK requires the session to exist.
    if !session_exists(&state, &session).await? {
        return Err(AppError::BadRequest(format!("unknown session '{session}'")));
    }

    match claim::claim(&state.pool, &id, &session).await {
        Ok(issue) => {
            // Audit (§6.4 / M6 prompt): record the claim.
            db::audit::log(
                &state.pool,
                &format!("agent:{session}"),
                "issue.claim",
                &id,
                json!({ "session": session, "deliver": input.deliver }),
            )
            .await?;

            // S3 — board→agent: auto-send the work via the steering deliver-loop
            // (the default). The loop delivers at the agent's next turn boundary
            // and auto-wakes a stopped session — no new delivery machinery.
            let steer_id = if input.deliver {
                let payload = dispatch::build_payload(&state.pool, &issue, &session).await?;
                let sid = db::steering::enqueue(&state.pool, &session, &payload).await?;
                // Dedupe one delivery per assignment (repurposes the dead
                // `notified` latch — it now guards a send that actually exists).
                db::board::patch_issue(&state.pool, &id, &[IssueField::Notified(1)]).await?;
                Some(sid)
            } else {
                None
            };

            emit_board(&state).await;
            // Re-read the full view so claim returns the same shape (incl. 0010
            // relations) as every other board endpoint. `claim` already proved
            // the issue exists, so `view_of` cannot 404 here.
            let issue = view_of(&state, &id).await?;
            Ok(ok(ClaimResult {
                issue,
                delivered: steer_id.is_some(),
                steer_id,
            }))
        }
        Err(ClaimError::NotFound) => Err(AppError::NotFound(format!("issue '{id}'"))),
        Err(ClaimError::NotAgentTask) => {
            Err(AppError::Conflict("item is not an agent task".into()))
        }
        Err(ClaimError::WrongStatus(s)) => Err(AppError::Conflict(format!(
            "claim failed — issue is '{s}', not claimable"
        ))),
        Err(ClaimError::Taken) => Err(AppError::Conflict(
            "claim failed — taken by another session".into(),
        )),
        Err(ClaimError::Db(e)) => Err(AppError::Internal(e.into())),
    }
}

// ── human-side comment + acceptance + link CRUD (bearer, AB2) ────────────────
//
// These run UNDER the bearer layer (dashboard token). Agent-side equivalents
// live in `board::hook` (hook-token scoped). All emit_board + audit (actor=user).

/// Resolve an issue id to 404 early, shared by the AB2 sub-resource handlers.
async fn require_issue(state: &AppState, id: &str) -> Result<Issue, AppError> {
    db::board::get_issue(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("issue '{id}'")))
}

#[derive(Debug, Deserialize)]
struct HumanCommentInput {
    body: String,
}

/// `POST /api/board/{id}/comment` — a human comment (author `'user'`).
async fn comment_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<HumanCommentInput>,
) -> Result<Json<Envelope<IssueView>>, AppError> {
    require_issue(&state, &id).await?;
    let body = input.body.trim();
    if body.is_empty() {
        return Err(AppError::BadRequest("body is required".into()));
    }
    let comment_id = db::board::insert_comment(&state.pool, &id, "user", body).await?;
    db::audit::log(
        &state.pool,
        "user",
        "issue.comment",
        &id,
        json!({ "comment_id": comment_id }),
    )
    .await?;
    emit_board(&state).await;
    Ok(ok(view_of(&state, &id).await?))
}

#[derive(Debug, Deserialize)]
struct AcceptanceInput {
    body: String,
}

/// `POST /api/board/{id}/acceptance` — add an acceptance item (appended at end).
async fn add_acceptance_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<AcceptanceInput>,
) -> Result<Json<Envelope<IssueView>>, AppError> {
    require_issue(&state, &id).await?;
    let body = input.body.trim();
    if body.is_empty() {
        return Err(AppError::BadRequest("body is required".into()));
    }
    let item_id = db::board::insert_acceptance(&state.pool, &id, body).await?;
    db::audit::log(
        &state.pool,
        "user",
        "issue.acceptance.add",
        &id,
        json!({ "item_id": item_id }),
    )
    .await?;
    emit_board(&state).await;
    Ok(ok(view_of(&state, &id).await?))
}

#[derive(Debug, Deserialize)]
struct AcceptancePatchInput {
    body: Option<String>,
    done: Option<bool>,
}

/// `PATCH /api/board/{id}/acceptance/{item_id}` — edit an item's body and/or
/// toggle its done state. The item must belong to the issue in the path.
async fn patch_acceptance_handler(
    State(state): State<AppState>,
    Path((id, item_id)): Path<(String, i64)>,
    Json(input): Json<AcceptancePatchInput>,
) -> Result<Json<Envelope<IssueView>>, AppError> {
    require_issue(&state, &id).await?;
    // Ownership: the item must be on this issue (no cross-issue edit by id guess).
    let item = db::board::get_acceptance(&state.pool, item_id)
        .await?
        .filter(|i| i.issue_id == id)
        .ok_or_else(|| AppError::NotFound(format!("acceptance item {item_id} not on '{id}'")))?;
    if input.body.is_none() && input.done.is_none() {
        return Err(AppError::BadRequest("no recognized field".into()));
    }
    if let Some(body) = input.body {
        let body = body.trim();
        if body.is_empty() {
            return Err(AppError::BadRequest("body cannot be empty".into()));
        }
        db::board::update_acceptance_body(&state.pool, item.id, body).await?;
    }
    if let Some(done) = input.done {
        db::board::toggle_acceptance(&state.pool, item.id, done).await?;
    }
    emit_board(&state).await;
    Ok(ok(view_of(&state, &id).await?))
}

/// `DELETE /api/board/{id}/acceptance/{item_id}` — remove an acceptance item.
async fn delete_acceptance_handler(
    State(state): State<AppState>,
    Path((id, item_id)): Path<(String, i64)>,
) -> Result<Json<Envelope<IssueView>>, AppError> {
    require_issue(&state, &id).await?;
    let item = db::board::get_acceptance(&state.pool, item_id)
        .await?
        .filter(|i| i.issue_id == id)
        .ok_or_else(|| AppError::NotFound(format!("acceptance item {item_id} not on '{id}'")))?;
    db::board::delete_acceptance(&state.pool, item.id).await?;
    emit_board(&state).await;
    Ok(ok(view_of(&state, &id).await?))
}

#[derive(Debug, Deserialize)]
struct AcceptanceReorderInput {
    order: Vec<i64>,
}

/// `PUT /api/board/{id}/acceptance/reorder` — set the checklist display order.
async fn reorder_acceptance_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<AcceptanceReorderInput>,
) -> Result<Json<Envelope<IssueView>>, AppError> {
    require_issue(&state, &id).await?;
    db::board::reorder_acceptance(&state.pool, &id, &input.order).await?;
    emit_board(&state).await;
    Ok(ok(view_of(&state, &id).await?))
}

#[derive(Debug, Deserialize)]
struct LinkInput {
    kind: String,
    #[serde(rename = "ref")]
    r#ref: String,
    #[serde(default)]
    label: Option<String>,
}

/// `POST /api/board/{id}/link` — attach a PR/commit ref (human side).
async fn add_link_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<LinkInput>,
) -> Result<Json<Envelope<IssueView>>, AppError> {
    require_issue(&state, &id).await?;
    let kind = input.kind.trim();
    if kind != "pr" && kind != "commit" {
        return Err(AppError::BadRequest("kind must be 'pr' or 'commit'".into()));
    }
    let r#ref = input.r#ref.trim();
    if r#ref.is_empty() {
        return Err(AppError::BadRequest("ref is required".into()));
    }
    let label = input.label.unwrap_or_default();
    let link_id = db::board::insert_link(&state.pool, &id, kind, r#ref, label.trim()).await?;
    db::audit::log(
        &state.pool,
        "user",
        "issue.link.add",
        &id,
        json!({ "link_id": link_id, "kind": kind }),
    )
    .await?;
    emit_board(&state).await;
    Ok(ok(view_of(&state, &id).await?))
}

/// `DELETE /api/board/{id}/link/{link_id}` — remove a PR/commit ref.
async fn delete_link_handler(
    State(state): State<AppState>,
    Path((id, link_id)): Path<(String, i64)>,
) -> Result<Json<Envelope<IssueView>>, AppError> {
    require_issue(&state, &id).await?;
    // Confirm the link is on this issue before deleting (no cross-issue delete).
    let links = db::board::links_for(&state.pool, &id).await?;
    if !links.iter().any(|l| l.id == link_id) {
        return Err(AppError::NotFound(format!("link {link_id} not on '{id}'")));
    }
    db::board::delete_link(&state.pool, link_id).await?;
    emit_board(&state).await;
    Ok(ok(view_of(&state, &id).await?))
}

// ── statuses (board columns) ─────────────────────────────────────────────────

async fn list_statuses_handler(
    State(state): State<AppState>,
) -> Result<Json<Envelope<Vec<db::board::BoardStatus>>>, AppError> {
    Ok(ok(db::board::list_statuses(&state.pool).await?))
}

#[derive(Debug, Deserialize)]
struct StatusInput {
    label: String,
}

async fn create_status_handler(
    State(state): State<AppState>,
    Json(input): Json<StatusInput>,
) -> Result<impl IntoResponse, AppError> {
    let label = input.label.trim().to_string();
    if label.is_empty() {
        return Err(AppError::BadRequest("label is required".into()));
    }
    // Slugify the label into a stable id; ensure uniqueness with a numeric suffix.
    let base = slugify(&label);
    let mut id = base.clone();
    let mut n = 2;
    while db::board::get_status(&state.pool, &id).await?.is_some() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let st = db::board::create_status(&state.pool, &id, &label).await?;
    emit_board(&state).await;
    Ok((StatusCode::CREATED, ok(st)))
}

async fn rename_status_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<StatusInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let label = input.label.trim();
    if label.is_empty() {
        return Err(AppError::BadRequest("label is required".into()));
    }
    if !db::board::rename_status(&state.pool, &id, label).await? {
        return Err(AppError::NotFound(format!("status '{id}'")));
    }
    emit_board(&state).await;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_status_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let status = db::board::get_status(&state.pool, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("status '{id}'")))?;
    if status.is_builtin != 0 {
        return Err(AppError::Conflict(
            "built-in columns cannot be deleted".into(),
        ));
    }
    db::board::delete_status(&state.pool, &id).await?;
    emit_board(&state).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct ReorderInput {
    order: Vec<String>,
}

async fn reorder_statuses_handler(
    State(state): State<AppState>,
    Json(input): Json<ReorderInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    db::board::reorder_statuses(&state.pool, &input.order).await?;
    emit_board(&state).await;
    Ok(Json(json!({ "ok": true })))
}

// ── tag completion ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TagQuery {
    tag: String,
}

async fn tag_completion_handler(
    State(state): State<AppState>,
    Query(q): Query<TagQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let tag = q.tag.trim();
    if tag.is_empty() {
        return Err(AppError::BadRequest("tag is required".into()));
    }
    let (total, done) = db::board::tag_completion(&state.pool, tag).await?;
    Ok(Json(json!({
        "ok": true,
        "data": {
            "tag": tag,
            "total": total,
            "done": done,
            "complete": total > 0 && done == total,
        }
    })))
}

// ── iCal export (PUBLIC, feature-extract §2.7) ───────────────────────────────

async fn calendar_handler(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let issues = db::board::issues_with_due(&state.pool).await?;
    let body = ical::render(&issues);
    Ok(([(header::CONTENT_TYPE, "text/calendar; charset=utf-8")], body))
}

mod ical {
    use super::Issue;

    /// Render an iCalendar feed from issues with a `due` date (§2.7).
    pub fn render(issues: &[Issue]) -> String {
        let mut lines = vec![
            "BEGIN:VCALENDAR".to_string(),
            "VERSION:2.0".to_string(),
            "PRODID:-//supermux//v3//EN".to_string(),
            "CALSCALE:GREGORIAN".to_string(),
        ];
        for issue in issues {
            let Some(date) = issue.due.as_deref().filter(|d| !d.is_empty()) else {
                continue;
            };
            let Some(date_basic) = date_to_basic(date) else {
                continue;
            };
            lines.push("BEGIN:VEVENT".to_string());
            lines.push(format!("UID:{}@supermux", issue.id));
            lines.push(format!("SUMMARY:{}", escape(&issue.title)));
            if !issue.desc.is_empty() {
                lines.push(format!("DESCRIPTION:{}", escape(&issue.desc)));
            }
            match issue.due_time.as_deref().and_then(time_to_basic) {
                // Timed event → 1-hour block (§2.7).
                Some((h, m)) => {
                    lines.push(format!("DTSTART:{date_basic}T{h:02}{m:02}00"));
                    let (eh, em) = add_hour(h, m);
                    lines.push(format!("DTEND:{date_basic}T{eh:02}{em:02}00"));
                }
                // No time → all-day event.
                None => {
                    lines.push(format!("DTSTART;VALUE=DATE:{date_basic}"));
                }
            }
            lines.push(format!("STATUS:{}", map_status(&issue.status)));
            lines.push("END:VEVENT".to_string());
        }
        lines.push("END:VCALENDAR".to_string());
        // RFC 5545 mandates CRLF line breaks.
        lines.join("\r\n") + "\r\n"
    }

    /// `todo→NEEDS-ACTION`, `doing→IN-PROCESS`, `done→COMPLETED` (§2.7); others
    /// map to the closest sensible value.
    fn map_status(status: &str) -> &'static str {
        match status {
            "done" => "COMPLETED",
            "doing" => "IN-PROCESS",
            "discarded" => "CANCELLED",
            _ => "NEEDS-ACTION",
        }
    }

    /// `YYYY-MM-DD` → `YYYYMMDD` (basic iCal date form). Returns None if malformed.
    fn date_to_basic(date: &str) -> Option<String> {
        let parts: Vec<&str> = date.split('-').collect();
        if parts.len() != 3 {
            return None;
        }
        let (y, m, d) = (parts[0], parts[1], parts[2]);
        if y.len() == 4
            && m.len() == 2
            && d.len() == 2
            && [y, m, d].iter().all(|p| p.bytes().all(|b| b.is_ascii_digit()))
        {
            Some(format!("{y}{m}{d}"))
        } else {
            None
        }
    }

    /// `HH:MM` → `(h, m)`. Returns None if malformed.
    fn time_to_basic(time: &str) -> Option<(u32, u32)> {
        let (h, m) = time.split_once(':')?;
        let h: u32 = h.parse().ok()?;
        let m: u32 = m.parse().ok()?;
        if h < 24 && m < 60 {
            Some((h, m))
        } else {
            None
        }
    }

    fn add_hour(h: u32, m: u32) -> (u32, u32) {
        ((h + 1) % 24, m)
    }

    /// Escape a text value per RFC 5545 §3.3.11.
    fn escape(s: &str) -> String {
        s.replace('\\', "\\\\")
            .replace(';', "\\;")
            .replace(',', "\\,")
            .replace('\n', "\\n")
            .replace('\r', "")
    }
}

// ── small helpers ────────────────────────────────────────────────────────────

/// Trim an optional string; an empty result becomes `None`.
fn norm_opt(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Lower-case slug for a custom status id: alphanumerics kept, runs of anything
/// else collapse to a single `-`.
fn slugify(label: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in label.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "col".to_string()
    } else {
        trimmed
    }
}

/// serde helper: distinguish "field absent" from "field present and null" for
/// `Option<Option<T>>` (used by the patch `session` field).
fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(de)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::board::NewIssue;
    use crate::state::AppState;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-view-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
        };
        let pool = db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    async fn seed_issue(state: &AppState, id: &str) {
        db::board::insert_issue(
            &state.pool,
            &NewIssue {
                id: id.to_string(),
                title: format!("issue {id}"),
                desc: String::new(),
                status: "todo".into(),
                session: None,
                creator: String::new(),
                due: None,
                due_time: None,
                owner_type: "agent".into(),
                pos: 0.0,
                notified: 0,
            },
        )
        .await
        .expect("insert issue");
    }

    #[tokio::test]
    async fn issueview_empty_relations_for_bare_issue() {
        let (state, dir) = test_state().await;
        seed_issue(&state, "T-1").await;

        // view_of: relations are present-but-empty, never null/missing.
        let v = view_of(&state, "T-1").await.unwrap();
        assert!(v.comments.is_empty());
        assert!(v.acceptance.is_empty());
        assert!(v.links.is_empty());

        // The JSON payload carries the three keys as empty arrays.
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["comments"], serde_json::json!([]));
        assert_eq!(json["acceptance"], serde_json::json!([]));
        assert_eq!(json["links"], serde_json::json!([]));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn issueview_populated_relations() {
        let (state, dir) = test_state().await;
        seed_issue(&state, "T-1").await;
        db::board::insert_comment(&state.pool, "T-1", "agent:w2", "working").await.unwrap();
        db::board::insert_acceptance(&state.pool, "T-1", "compiles").await.unwrap();
        db::board::insert_link(&state.pool, "T-1", "pr", "https://x/pr/1", "PR").await.unwrap();

        let v = view_of(&state, "T-1").await.unwrap();
        assert_eq!(v.comments.len(), 1);
        assert_eq!(v.comments[0].body, "working");
        assert_eq!(v.acceptance.len(), 1);
        assert_eq!(v.acceptance[0].body, "compiles");
        assert_eq!(v.links.len(), 1);
        assert_eq!(v.links[0].kind, "pr");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn session_live_reflects_archive_state() {
        let (state, dir) = test_state().await;
        // A live session + an issue linked to it.
        db::sessions::insert_minimal(&state.pool, "worker-2", "/tmp", "claude")
            .await
            .unwrap();
        db::board::insert_issue(
            &state.pool,
            &NewIssue {
                id: "B-1".into(),
                title: "linked".into(),
                desc: String::new(),
                status: "doing".into(),
                session: Some("worker-2".into()),
                creator: String::new(),
                due: None,
                due_time: None,
                owner_type: "agent".into(),
                pos: 0.0,
                notified: 0,
            },
        )
        .await
        .unwrap();
        // An unlinked issue is never "live".
        seed_issue(&state, "B-2").await;

        // Live session → session_live true (both single + batch loaders agree).
        assert!(view_of(&state, "B-1").await.unwrap().session_live);
        let board = load_board(&state, 0).await.unwrap();
        let by_id: std::collections::HashMap<_, _> =
            board.iter().map(|v| (v.id.as_str(), v)).collect();
        assert!(by_id["B-1"].session_live, "live link reads live in load_board");
        assert!(!by_id["B-2"].session_live, "unassigned issue is never live");

        // Archive the session → the link goes stale (session_live false).
        db::sessions::set_archived(&state.pool, "worker-2", true)
            .await
            .unwrap();
        assert!(
            !view_of(&state, "B-1").await.unwrap().session_live,
            "archived session → stale link"
        );
        let board = load_board(&state, 0).await.unwrap();
        let by_id: std::collections::HashMap<_, _> =
            board.iter().map(|v| (v.id.as_str(), v)).collect();
        assert!(!by_id["B-1"].session_live, "load_board marks archived link stale");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn flags_surface_in_issueview() {
        let (state, dir) = test_state().await;
        seed_issue(&state, "B-1").await;

        // Default: both flags false.
        let v = view_of(&state, "B-1").await.unwrap();
        assert!(!v.needs_review);
        assert!(!v.awaiting_input);

        // After setting both flags they surface as booleans in the view + JSON.
        db::board::patch_issue(
            &state.pool,
            "B-1",
            &[
                db::board::IssueField::NeedsReview(1),
                db::board::IssueField::AwaitingInput(1),
            ],
        )
        .await
        .unwrap();
        let v = view_of(&state, "B-1").await.unwrap();
        assert!(v.needs_review);
        assert!(v.awaiting_input);
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["needs_review"], serde_json::json!(true));
        assert_eq!(json["awaiting_input"], serde_json::json!(true));
        assert_eq!(json["session_live"], serde_json::json!(false));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn load_board_batches_relations_per_issue() {
        let (state, dir) = test_state().await;
        // Three issues; only T-1 and T-2 have relations, T-3 is bare.
        seed_issue(&state, "T-1").await;
        seed_issue(&state, "T-2").await;
        seed_issue(&state, "T-3").await;
        db::board::insert_comment(&state.pool, "T-1", "user", "a").await.unwrap();
        db::board::insert_comment(&state.pool, "T-1", "user", "b").await.unwrap();
        db::board::insert_acceptance(&state.pool, "T-2", "ship it").await.unwrap();
        db::board::insert_link(&state.pool, "T-2", "commit", "deadbeef", "").await.unwrap();

        let board = load_board(&state, 0).await.unwrap();
        let by_id: std::collections::HashMap<_, _> =
            board.iter().map(|v| (v.id.as_str(), v)).collect();

        // Correct grouping: each issue gets only its own relations.
        assert_eq!(by_id["T-1"].comments.len(), 2);
        assert!(by_id["T-1"].acceptance.is_empty());
        assert!(by_id["T-1"].links.is_empty());

        assert!(by_id["T-2"].comments.is_empty());
        assert_eq!(by_id["T-2"].acceptance.len(), 1);
        assert_eq!(by_id["T-2"].links.len(), 1);

        // Bare issue: all three vecs empty, none leaked from siblings.
        assert!(by_id["T-3"].comments.is_empty());
        assert!(by_id["T-3"].acceptance.is_empty());
        assert!(by_id["T-3"].links.is_empty());

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Seed a live session so the `issues.session` FK + steering accept it.
    async fn seed_session(state: &AppState, name: &str) {
        db::sessions::insert_minimal(&state.pool, name, "/tmp", "claude")
            .await
            .expect("insert session");
    }

    // ── S3: claim auto-sends the work to the agent via steering ────────────────

    #[tokio::test]
    async fn claim_enqueues_steer_by_default() {
        let (state, dir) = test_state().await;
        seed_session(&state, "worker-2").await;
        seed_issue(&state, "T-1").await;
        db::board::insert_acceptance(&state.pool, "T-1", "compiles").await.unwrap();

        // Default deliver=true (field omitted) → a steer is enqueued.
        let res = claim_handler(
            State(state.clone()),
            Path("T-1".into()),
            Json(serde_json::from_value(json!({ "session": "worker-2" })).unwrap()),
        )
        .await
        .expect("claim ok");
        let result = &res.0.data;
        assert!(result.delivered, "deliver defaults true");
        let steer_id = result.steer_id.expect("steer id present");

        // The steering row exists and carries the issue context.
        let queued = db::steering::list(&state.pool, "worker-2").await.unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].id, steer_id);
        assert!(queued[0].text.contains("T-1"), "payload names the issue");
        assert!(queued[0].text.contains("compiles"), "payload has acceptance");
        assert!(
            queued[0].text.contains("/api/hook/board/comment"),
            "payload teaches the report-back footer"
        );

        // The issue is now `doing`, linked, and `notified` latched once.
        let issue = db::board::get_issue(&state.pool, "T-1").await.unwrap().unwrap();
        assert_eq!(issue.status, "doing");
        assert_eq!(issue.session.as_deref(), Some("worker-2"));
        assert_eq!(issue.notified, 1);

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn claim_only_skips_the_steer() {
        let (state, dir) = test_state().await;
        seed_session(&state, "worker-2").await;
        seed_issue(&state, "T-1").await;

        // deliver=false → "Claim only": link flips, NO steer enqueued.
        let res = claim_handler(
            State(state.clone()),
            Path("T-1".into()),
            Json(serde_json::from_value(json!({ "session": "worker-2", "deliver": false })).unwrap()),
        )
        .await
        .expect("claim ok");
        assert!(!res.0.data.delivered);
        assert!(res.0.data.steer_id.is_none());
        assert!(db::steering::list(&state.pool, "worker-2").await.unwrap().is_empty());

        // Issue still claimed (link + status flipped) — only the send was skipped.
        let issue = db::board::get_issue(&state.pool, "T-1").await.unwrap().unwrap();
        assert_eq!(issue.status, "doing");
        assert_eq!(issue.session.as_deref(), Some("worker-2"));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn claim_undo_clears_the_enqueued_steer() {
        // The Undo toast clears the just-enqueued steer via steering::clear_one
        // (what the UI's unsend calls). Prove the steer_id retracts it.
        let (state, dir) = test_state().await;
        seed_session(&state, "worker-2").await;
        seed_issue(&state, "T-1").await;

        let res = claim_handler(
            State(state.clone()),
            Path("T-1".into()),
            Json(serde_json::from_value(json!({ "session": "worker-2" })).unwrap()),
        )
        .await
        .unwrap();
        let steer_id = res.0.data.steer_id.unwrap();

        let cleared = db::steering::clear_one(&state.pool, "worker-2", steer_id).await.unwrap();
        assert_eq!(cleared, 1, "the enqueued steer is retracted");
        assert!(db::steering::list(&state.pool, "worker-2").await.unwrap().is_empty());

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── AB2: human-side comment + acceptance CRUD (bearer) ─────────────────────

    #[tokio::test]
    async fn human_comment_appends_as_user() {
        let (state, dir) = test_state().await;
        seed_issue(&state, "T-1").await;

        let res = comment_handler(
            State(state.clone()),
            Path("T-1".into()),
            Json(serde_json::from_value(json!({ "body": "looks good" })).unwrap()),
        )
        .await
        .expect("comment ok");
        assert_eq!(res.0.data.comments.len(), 1);
        assert_eq!(res.0.data.comments[0].author, "user");
        assert_eq!(res.0.data.comments[0].body, "looks good");

        // Empty body → 400.
        let bad = comment_handler(
            State(state.clone()),
            Path("T-1".into()),
            Json(serde_json::from_value(json!({ "body": "  " })).unwrap()),
        )
        .await;
        assert!(matches!(bad, Err(AppError::BadRequest(_))));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn human_acceptance_crud_roundtrip() {
        let (state, dir) = test_state().await;
        seed_issue(&state, "T-1").await;

        // Add.
        let v = add_acceptance_handler(
            State(state.clone()),
            Path("T-1".into()),
            Json(serde_json::from_value(json!({ "body": "compiles" })).unwrap()),
        )
        .await
        .unwrap();
        let item_id = v.0.data.acceptance[0].id;
        assert_eq!(v.0.data.acceptance[0].done, 0);

        // Edit body + toggle done in one patch.
        let v = patch_acceptance_handler(
            State(state.clone()),
            Path(("T-1".into(), item_id)),
            Json(serde_json::from_value(json!({ "body": "compiles clean", "done": true })).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(v.0.data.acceptance[0].body, "compiles clean");
        assert_eq!(v.0.data.acceptance[0].done, 1);

        // A patch targeting an item on a DIFFERENT issue 404s (no cross-issue edit).
        seed_issue(&state, "T-2").await;
        let other = db::board::insert_acceptance(&state.pool, "T-2", "x").await.unwrap();
        let cross = patch_acceptance_handler(
            State(state.clone()),
            Path(("T-1".into(), other)),
            Json(serde_json::from_value(json!({ "done": true })).unwrap()),
        )
        .await;
        assert!(matches!(cross, Err(AppError::NotFound(_))));

        // Delete.
        let v = delete_acceptance_handler(State(state.clone()), Path(("T-1".into(), item_id)))
            .await
            .unwrap();
        assert!(v.0.data.acceptance.is_empty());

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn human_link_add_and_remove() {
        let (state, dir) = test_state().await;
        seed_issue(&state, "T-1").await;

        let v = add_link_handler(
            State(state.clone()),
            Path("T-1".into()),
            Json(serde_json::from_value(json!({ "kind": "pr", "ref": "https://x/pr/1", "label": "PR" })).unwrap()),
        )
        .await
        .unwrap();
        let link_id = v.0.data.links[0].id;
        assert_eq!(v.0.data.links[0].kind, "pr");

        // Bad kind → 400.
        let bad = add_link_handler(
            State(state.clone()),
            Path("T-1".into()),
            Json(serde_json::from_value(json!({ "kind": "bogus", "ref": "x" })).unwrap()),
        )
        .await;
        assert!(matches!(bad, Err(AppError::BadRequest(_))));

        let v = delete_link_handler(State(state.clone()), Path(("T-1".into(), link_id)))
            .await
            .unwrap();
        assert!(v.0.data.links.is_empty());

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

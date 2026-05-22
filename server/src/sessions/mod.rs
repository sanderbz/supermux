//! Session HTTP surface — the tmux-free CRUD subset (TECH_PLAN §3.2.5, §3.4, M2).
//!
//! **Router-registry pattern (§3.4).** [`router_for`] returns this module's
//! sub-router; `http::router` merges it (plus board/files/scheduler/agents in
//! later milestones) and applies the bearer-auth layer once. Adding a backend
//! milestone is one new module + one `.merge(...)` line — no shared edits here.
//!
//! **Scope.** Only the parts that need no live tmux: list/create/get/delete/
//! duplicate/config_patch, plus the DB-backed tracked-files and steering-queue
//! endpoints. `start/stop/send/keys/paste/clone/archive/wake/peek` land in M3.
//!
//! **HTTP envelope (§3.4).** Successful responses are `{ ok: true, data: T }`;
//! errors are `{ ok: false, error: "..." }` via [`crate::error::AppError`].
//!
//! **M3 — tmux lifecycle.** [`lifecycle`] wires the live operations
//! (start/stop/send/keys/paste/peek/archive/wake/clone) onto [`tmux`]; their
//! handlers are merged into [`router_for`] alongside the M2 CRUD routes.

pub mod lifecycle;
pub mod pty;
pub mod tmux;

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
// Routing constructors are fully-qualified (`axum::routing::get`) to avoid a name
// clash with this module's public `get`/`delete` API functions (§3.2.5).
use axum::{Json, Router};
use base64::Engine;
use once_cell::sync::Lazy;
use rand::RngCore;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db;
use crate::db::sessions::{NewSession, Session, SessionRuntime};
use crate::error::AppError;
use crate::state::AppState;

/// Build the sessions sub-router (no auth layer — applied by `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::{get, patch, post};
    Router::new()
        .route("/api/sessions", get(list_handler).post(create_handler))
        .route(
            "/api/sessions/{name}",
            get(get_handler).delete(delete_handler),
        )
        .route("/api/sessions/{name}/duplicate", post(duplicate_handler))
        .route("/api/sessions/{name}/config", patch(config_handler))
        // ── M3 tmux lifecycle ──
        .route("/api/sessions/{name}/start", post(start_handler))
        .route("/api/sessions/{name}/stop", post(stop_handler))
        .route("/api/sessions/{name}/send", post(send_handler))
        .route("/api/sessions/{name}/keys", post(keys_handler))
        .route("/api/sessions/{name}/paste", post(paste_handler))
        .route("/api/sessions/{name}/peek", get(peek_handler))
        .route("/api/sessions/{name}/archive", post(archive_handler))
        .route("/api/sessions/{name}/wake", post(wake_handler))
        .route("/api/sessions/{name}/clone", post(clone_handler))
        .route(
            "/api/sessions/{name}/tracked-files",
            get(tracked_list_handler)
                .post(tracked_add_handler)
                .delete(tracked_remove_handler),
        )
        .route(
            "/api/sessions/{name}/steer",
            get(steer_list_handler)
                .post(steer_add_handler)
                .delete(steer_clear_handler),
        )
        .with_state(state)
}

// ── HTTP envelope ────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct Envelope<T> {
    ok: bool,
    data: T,
}

/// Wrap a success payload in the `{ ok: true, data }` envelope (defaults to 200).
fn ok<T: Serialize>(data: T) -> Json<Envelope<T>> {
    Json(Envelope { ok: true, data })
}

// ── view model ───────────────────────────────────────────────────────────────

/// The session shape returned to clients (superset of the frontend
/// `SessionSummary`/`Session` types). `status`/`preview_lines` are populated by
/// the status detector (M5); until then a session reads as `stopped` with no
/// preview lines.
#[derive(Debug, Serialize)]
pub struct SessionView {
    pub name: String,
    pub status: String,
    pub dir: String,
    pub provider: String,
    pub desc: String,
    pub pinned: bool,
    pub archived: bool,
    pub auto_continue: bool,
    pub tags: Vec<String>,
    pub flags: String,
    pub branch: String,
    pub mcp: String,
    pub worktree: bool,
    pub creator: String,
    /// Last 6 lines of `last_capture`, ANSI-stripped (§3.4).
    pub preview_lines: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn view(s: &Session, rt: Option<&SessionRuntime>) -> SessionView {
    let last_status = rt.map(|r| r.last_status.as_str()).unwrap_or("unknown");
    let last_capture = rt.map(|r| r.last_capture.as_str()).unwrap_or("");
    let updated_ts = s.last_send.max(s.last_started).max(s.created_at);
    SessionView {
        name: s.name.clone(),
        status: normalize_status(last_status),
        dir: s.dir.clone(),
        provider: s.provider.clone(),
        desc: s.desc.clone(),
        pinned: s.pinned != 0,
        archived: s.archived != 0,
        auto_continue: s.auto_continue != 0,
        tags: parse_tags(&s.tags),
        flags: s.flags.clone(),
        branch: s.branch.clone(),
        mcp: s.mcp.clone(),
        worktree: s.worktree != 0,
        creator: s.creator.clone(),
        preview_lines: preview_lines(last_capture),
        created_at: to_rfc3339(s.created_at),
        updated_at: to_rfc3339(updated_ts),
    }
}

/// Map the DB `last_status` onto the API status union. A session with no live
/// detection (`unknown`) reads as `stopped` for the client.
fn normalize_status(s: &str) -> String {
    match s {
        "active" | "waiting" | "idle" | "stopped" => s.to_string(),
        _ => "stopped".to_string(),
    }
}

fn parse_tags(json_str: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json_str).unwrap_or_default()
}

fn to_rfc3339(ts: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0)
        .unwrap_or_else(|| chrono::DateTime::<chrono::Utc>::from_timestamp(0, 0).unwrap())
        .to_rfc3339()
}

/// Strip CSI escape sequences (covers SGR colour codes and cursor moves).
static ANSI_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());

/// Last 6 lines of `capture`, ANSI-stripped (§3.4 SessionSummary.preview_lines).
fn preview_lines(capture: &str) -> Vec<String> {
    if capture.is_empty() {
        return Vec::new();
    }
    let stripped = ANSI_RE.replace_all(capture, "");
    let lines: Vec<String> = stripped.lines().map(str::to_string).collect();
    let start = lines.len().saturating_sub(6);
    lines[start..].to_vec()
}

// ── validation helpers ───────────────────────────────────────────────────────

static NAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_.-]+$").unwrap());
const PROVIDERS: [&str; 3] = ["claude", "codex", "shell"];

/// Session-name slug rule (§1.2 of feature-extract): `[a-zA-Z0-9_.-]+`, bounded.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 100 && NAME_RE.is_match(name)
}

fn valid_provider(provider: &str) -> bool {
    PROVIDERS.contains(&provider)
}

/// Fresh per-session hook token: 32 bytes from the OS CSPRNG, base64url.
pub(crate) fn gen_hook_token() -> String {
    let mut buf = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

async fn ensure_session(state: &AppState, name: &str) -> Result<(), AppError> {
    if db::sessions::exists(&state.pool, name).await? {
        Ok(())
    } else {
        Err(AppError::NotFound(format!("session '{name}'")))
    }
}

// ── public API (reused by M3 lifecycle) ──────────────────────────────────────

pub async fn list(state: &AppState) -> Result<Vec<SessionView>, AppError> {
    let sessions = db::sessions::list(&state.pool).await?;
    let rt_map: HashMap<String, SessionRuntime> = db::sessions::list_runtimes(&state.pool)
        .await?
        .into_iter()
        .map(|r| (r.name.clone(), r))
        .collect();
    Ok(sessions
        .iter()
        .map(|s| view(s, rt_map.get(&s.name)))
        .collect())
}

pub async fn get(state: &AppState, name: &str) -> Result<SessionView, AppError> {
    let s = db::sessions::get(&state.pool, name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))?;
    let rt = db::sessions::runtime(&state.pool, name).await?;
    Ok(view(&s, rt.as_ref()))
}

#[derive(Debug, Deserialize)]
pub struct CreateInput {
    pub name: String,
    #[serde(default)]
    pub dir: Option<String>,
    #[serde(default)]
    pub desc: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub creator: Option<String>,
    #[serde(default)]
    pub flags: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub mcp: Option<String>,
    #[serde(default)]
    pub worktree: Option<bool>,
}

pub async fn create(state: &AppState, input: CreateInput) -> Result<SessionView, AppError> {
    let name = input.name.trim().to_string();
    if !valid_name(&name) {
        return Err(AppError::BadRequest(
            "invalid session name (allowed: letters, digits, '_', '.', '-')".into(),
        ));
    }
    let provider = input.provider.unwrap_or_else(|| "claude".into());
    if !valid_provider(&provider) {
        return Err(AppError::BadRequest(format!("invalid provider '{provider}'")));
    }
    if db::sessions::exists(&state.pool, &name).await? {
        return Err(AppError::Conflict(format!(
            "session '{name}' already exists"
        )));
    }

    let dir = input
        .dir
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| {
            dirs::home_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| ".".into())
        });
    let tags = input.tags.unwrap_or_default();
    let new = NewSession {
        name: name.clone(),
        dir,
        desc: input.desc.unwrap_or_default(),
        provider,
        creator: input.creator.unwrap_or_default(),
        flags: input.flags.unwrap_or_default(),
        tags: serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into()),
        branch: input.branch.unwrap_or_default(),
        mcp: input.mcp.unwrap_or_default(),
        worktree: input.worktree.unwrap_or(false),
        worktree_repo: String::new(),
    };
    db::sessions::create(&state.pool, &new).await?;
    let hook_token = gen_hook_token();
    db::sessions::ensure_runtime(&state.pool, &name, &hook_token).await?;
    state.hook_tokens.insert(name.clone(), hook_token);
    get(state, &name).await
}

pub async fn delete(state: &AppState, name: &str) -> Result<(), AppError> {
    ensure_session(state, name).await?;
    // Best-effort tmux teardown so a deleted session leaves no orphan pane/FIFO.
    let _ = tmux::Tmux::new(name).kill_session().await;
    db::sessions::delete(&state.pool, name).await?;
    // §3.2.5 lock-map lifecycle: drop every per-session in-memory map entry so
    // session churn does not leak DashMap entries.
    state.forget_session(name);
    Ok(())
}

pub async fn duplicate(
    state: &AppState,
    src: &str,
    new_name: &str,
) -> Result<SessionView, AppError> {
    let new_name = new_name.trim();
    if !valid_name(new_name) {
        return Err(AppError::BadRequest("invalid new_name".into()));
    }
    ensure_session(state, src).await?;
    if db::sessions::exists(&state.pool, new_name).await? {
        return Err(AppError::Conflict(format!(
            "session '{new_name}' already exists"
        )));
    }
    db::sessions::duplicate(&state.pool, src, new_name).await?;
    let hook_token = gen_hook_token();
    db::sessions::ensure_runtime(&state.pool, new_name, &hook_token).await?;
    state.hook_tokens.insert(new_name.to_string(), hook_token);
    get(state, new_name).await
}

/// Config patch — the tmux-free fields (§1.1 `PATCH .../config`). `model`,
/// `toggle_yolo`, and `new_conversation` involve flags/resume mechanics and land
/// with the lifecycle work in M3.
#[derive(Debug, Deserialize)]
pub struct ConfigInput {
    pub rename: Option<String>,
    pub desc: Option<String>,
    pub dir: Option<String>,
    pub branch: Option<String>,
    pub mcp: Option<String>,
    pub tags: Option<Vec<String>>,
    pub toggle_pin: Option<bool>,
    pub toggle_auto_continue: Option<bool>,
}

pub async fn config_patch(
    state: &AppState,
    name: &str,
    patch: ConfigInput,
) -> Result<SessionView, AppError> {
    ensure_session(state, name).await?;
    let mut current = name.to_string();
    let mut changed = false;

    if let Some(target) = patch.rename.as_deref() {
        let target = target.trim();
        if !valid_name(target) {
            return Err(AppError::BadRequest("invalid rename target".into()));
        }
        if target != current {
            if db::sessions::exists(&state.pool, target).await? {
                return Err(AppError::Conflict(format!(
                    "session '{target}' already exists"
                )));
            }
            db::sessions::rename(&state.pool, &current, target).await?;
            // Carry the per-session in-memory maps (lock/watch/hook token) over.
            state.rename_session(&current, target);
            current = target.to_string();
        }
        changed = true;
    }
    if let Some(v) = patch.desc {
        db::sessions::set_desc(&state.pool, &current, &v).await?;
        changed = true;
    }
    if let Some(v) = patch.dir {
        db::sessions::set_dir(&state.pool, &current, &v).await?;
        changed = true;
    }
    if let Some(v) = patch.branch {
        db::sessions::set_branch(&state.pool, &current, &v).await?;
        changed = true;
    }
    if let Some(v) = patch.mcp {
        db::sessions::set_mcp(&state.pool, &current, &v).await?;
        changed = true;
    }
    if let Some(v) = patch.tags {
        let json = serde_json::to_string(&v).unwrap_or_else(|_| "[]".into());
        db::sessions::set_tags(&state.pool, &current, &json).await?;
        changed = true;
    }
    if patch.toggle_pin.is_some() {
        db::sessions::toggle_pin(&state.pool, &current).await?;
        changed = true;
    }
    if patch.toggle_auto_continue.is_some() {
        db::sessions::toggle_auto_continue(&state.pool, &current).await?;
        changed = true;
    }

    if !changed {
        return Err(AppError::BadRequest("no recognized config field".into()));
    }
    get(state, &current).await
}

// ── handlers ─────────────────────────────────────────────────────────────────

async fn list_handler(
    State(state): State<AppState>,
) -> Result<Json<Envelope<Vec<SessionView>>>, AppError> {
    Ok(ok(list(&state).await?))
}

async fn get_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Envelope<SessionView>>, AppError> {
    Ok(ok(get(&state, &name).await?))
}

async fn create_handler(
    State(state): State<AppState>,
    Json(input): Json<CreateInput>,
) -> Result<impl IntoResponse, AppError> {
    let v = create(&state, input).await?;
    Ok((StatusCode::CREATED, ok(v)))
}

async fn delete_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    delete(&state, &name).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct DuplicateInput {
    new_name: String,
}

async fn duplicate_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<DuplicateInput>,
) -> Result<impl IntoResponse, AppError> {
    let v = duplicate(&state, &name, &input.new_name).await?;
    Ok((StatusCode::CREATED, ok(v)))
}

async fn config_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<ConfigInput>,
) -> Result<Json<Envelope<SessionView>>, AppError> {
    Ok(ok(config_patch(&state, &name, input).await?))
}

// ── M3 lifecycle handlers ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct StartInput {
    #[serde(default)]
    prompt: Option<String>,
}

async fn start_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, AppError> {
    // Body optional: `{}` or `{prompt}`.
    let input: StartInput = if body.is_empty() {
        StartInput { prompt: None }
    } else {
        serde_json::from_slice(&body)
            .map_err(|_| AppError::BadRequest("expected JSON body {prompt?}".into()))?
    };
    let result = lifecycle::start(&state, &name, input.prompt.as_deref()).await?;
    Ok(Json(json!({ "ok": true, "data": result })))
}

async fn stop_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    lifecycle::stop(&state, &name).await?;
    // §3.2.5: stop is async-shaped → 202 Accepted.
    Ok((StatusCode::ACCEPTED, Json(json!({ "ok": true }))))
}

#[derive(Debug, Deserialize)]
struct SendInput {
    text: String,
}

async fn send_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<SendInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    lifecycle::send_text(&state, &name, &input.text).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct KeysInput {
    /// Accept either `{keys}` (canonical, §1.1) or `{key}` for a single key.
    #[serde(default)]
    keys: Option<String>,
    #[serde(default)]
    key: Option<String>,
}

async fn keys_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<KeysInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let key = input
        .keys
        .or(input.key)
        .ok_or_else(|| AppError::BadRequest("expected {keys} or {key}".into()))?;
    lifecycle::send_keys(&state, &name, &key).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct PasteInput {
    text: String,
    #[serde(default)]
    submit: bool,
}

async fn paste_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<PasteInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    lifecycle::paste(&state, &name, &input.text, input.submit).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct PeekQuery {
    #[serde(default = "default_peek_lines")]
    lines: usize,
}

fn default_peek_lines() -> usize {
    40
}

async fn peek_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    axum::extract::Query(q): axum::extract::Query<PeekQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let text = lifecycle::peek(&state, &name, q.lines).await?;
    Ok(Json(json!({ "ok": true, "data": text })))
}

async fn archive_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let job_id = lifecycle::archive(&state, &name).await?;
    // §3.2.5: archive returns 202 + job_id immediately.
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "ok": true, "job_id": job_id })),
    ))
}

async fn wake_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = lifecycle::wake(&state, &name).await?;
    Ok(Json(json!({ "ok": true, "data": result })))
}

async fn clone_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<DuplicateInput>,
) -> Result<impl IntoResponse, AppError> {
    let v = lifecycle::clone(&state, &name, &input.new_name).await?;
    Ok((StatusCode::CREATED, ok(v)))
}

// ── tracked files ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct FilesBody {
    files: Vec<String>,
}

async fn tracked_list_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_session(&state, &name).await?;
    let files = db::tracked_files::list(&state.pool, &name).await?;
    Ok(Json(json!({ "ok": true, "data": { "files": files } })))
}

async fn tracked_add_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<FilesBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_session(&state, &name).await?;
    db::tracked_files::add(&state.pool, &name, &body.files).await?;
    let files = db::tracked_files::list(&state.pool, &name).await?;
    Ok(Json(json!({ "ok": true, "data": { "files": files } })))
}

async fn tracked_remove_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_session(&state, &name).await?;
    let req: FilesBody = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("expected JSON body {files:[...]}".into()))?;
    db::tracked_files::remove(&state.pool, &name, &req.files).await?;
    let files = db::tracked_files::list(&state.pool, &name).await?;
    Ok(Json(json!({ "ok": true, "data": { "files": files } })))
}

// ── steering queue ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct SteerBody {
    text: String,
}

#[derive(Debug, Deserialize)]
struct SteerClear {
    id: Option<i64>,
}

async fn steer_list_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_session(&state, &name).await?;
    let items = db::steering::list(&state.pool, &name).await?;
    Ok(Json(json!({ "ok": true, "data": items })))
}

async fn steer_add_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<SteerBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_session(&state, &name).await?;
    if body.text.trim().is_empty() {
        return Err(AppError::BadRequest("text required".into()));
    }
    let id = db::steering::enqueue(&state.pool, &name, &body.text).await?;
    Ok(Json(json!({ "ok": true, "id": id, "message": "queued" })))
}

async fn steer_clear_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_session(&state, &name).await?;
    // Body is optional: empty (or unparsable) means "clear all".
    let id = if body.is_empty() {
        None
    } else {
        serde_json::from_slice::<SteerClear>(&body)
            .ok()
            .and_then(|r| r.id)
    };
    let cleared = match id {
        Some(i) => db::steering::clear_one(&state.pool, &name, i).await?,
        None => db::steering::clear(&state.pool, &name).await?,
    };
    Ok(Json(json!({ "ok": true, "cleared": cleared })))
}

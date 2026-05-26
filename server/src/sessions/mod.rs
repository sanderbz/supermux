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

pub mod activity;
pub mod auto_actions;
pub mod lifecycle;
pub mod pty;
pub mod resumable;
pub mod status;
pub mod steering;
pub mod teams;
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
use crate::state::{AppState, SessionActivity};

/// Build the sessions sub-router (no auth layer — applied by `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::{get, patch, post};
    Router::new()
        .route("/api/sessions", get(list_handler).post(create_handler))
        // Archived (soft-deleted) sessions — the Archived sheet's data source.
        // Registered BEFORE `/api/sessions/{name}` so `archived` is matched as a
        // literal segment, never captured as a `{name}` path param.
        .route("/api/sessions/archived", get(list_archived_handler))
        .route(
            "/api/sessions/{name}",
            get(get_handler).delete(delete_handler),
        )
        // Hard delete (the "Delete forever" path) — archived-only, audited.
        .route("/api/sessions/{name}/purge", axum::routing::delete(purge_handler))
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
        .route("/api/sessions/{name}/unarchive", post(unarchive_handler))
        .route("/api/sessions/{name}/wake", post(wake_handler))
        .route("/api/sessions/{name}/clone", post(clone_handler))
        // ── mode-shift: switch the Claude permission mode from the ⋯ menu ──
        .route("/api/sessions/{name}/mode", post(mode_handler))
        // ── feat-resume-picker: reopen a past Claude conversation for the dir ──
        .route(
            "/api/sessions/{name}/resumable",
            get(resumable_handler),
        )
        .route("/api/sessions/{name}/resume", post(resume_handler))
        // feat-edit-in-native-editor: the dashboard "Done"/"Cancel" of the native
        // editor sheet resolves the session's in-flight edit. Bearer-gated (a
        // dashboard→server call); the bridge-side open/result are hook-token-authed
        // on the `external_edit` router merged at the top level.
        .route(
            "/api/sessions/{name}/external-edit/submit",
            post(external_edit_submit_handler),
        )
        // feat-session-info: live git status for the session's working dir (real
        // branch / dirty / ahead-behind) — read lazily when the info panel opens.
        .route("/api/sessions/{name}/git", get(git_handler))
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
    /// Same last 6 lines, with SGR escape sequences preserved — the colour-true
    /// tile preview source (overview tile preview feature). Empty until the
    /// first capture; the client falls back to `preview_lines` when so.
    pub preview_ansi: Vec<String>,
    /// Live "current activity" line derived from the latest `PreToolUse` hook
    /// (hooks-10x): a short, emoji-prefixed label like `✎ tile.tsx` / `⚡ npm
    /// test`. In-memory only (never persisted); `None` when the agent isn't
    /// mid-tool (cleared on `Stop`/`SessionEnd`). The UI shows it under the
    /// status dot while the session is working, falling back to the spinner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    /// The machine-readable activity class for [`activity`](Self::activity)
    /// (`bash`/`edit`/`read`/`search`/`web`/`task`/`mcp`/`tool`) so the UI can
    /// style without re-parsing the emoji. `None` whenever `activity` is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_kind: Option<String>,
    /// The latest unrecovered agent error from a `StopFailure` hook (hooks-10x):
    /// `{type, message}` (e.g. `rate_limit` / `billing_error`). In-memory only;
    /// cleared on the next `UserPromptSubmit`/`SessionStart`. Drives the amber
    /// error badge on the card.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorInfo>,
    /// The Claude Code permission MODE parsed from the persistent status bar in
    /// `last_capture` (mode-shift): `normal` / `accept_edits` / `plan` / `bypass`.
    /// `None` until the first capture (the menu then defaults to `normal`). Drives
    /// the ⋯ mode menu's live-checked radio — the menu reflects the TRUE mode, not
    /// an optimistic guess. Cheap (a pure string scan over the held capture).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// The `SessionView.error` shape (hooks-10x): a `StopFailure`-derived error class
/// plus a human message. Both are size-capped and secret-conscious upstream (see
/// [`activity::error_info`]); in-memory only, never persisted.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorInfo {
    /// The error class (`rate_limit`, `billing_error`, `authentication_failed`,
    /// …), defaulting to `"error"` when Claude omitted `error_type`.
    #[serde(rename = "type")]
    pub error_type: String,
    /// The human-readable error message (may be empty).
    pub message: String,
}

fn view(s: &Session, rt: Option<&SessionRuntime>, act: Option<SessionActivity>) -> SessionView {
    let last_status = rt.map(|r| r.last_status.as_str()).unwrap_or("unknown");
    let last_capture = rt.map(|r| r.last_capture.as_str()).unwrap_or("");
    let last_capture_ansi = rt.map(|r| r.last_capture_ansi.as_str()).unwrap_or("");
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
        preview_ansi: last_n_lines(last_capture_ansi, 20),
        activity: act.as_ref().and_then(|a| a.activity.clone()),
        activity_kind: act.as_ref().and_then(|a| a.activity_kind.clone()),
        error: act.and_then(|a| a.error.map(|(error_type, message)| ErrorInfo {
            error_type,
            message,
        })),
        // mode-shift: parse the permission mode from the held capture. `None`
        // before the first capture (the UI defaults the menu to Normal then).
        mode: if last_capture.is_empty() {
            None
        } else {
            Some(status::parse_mode(last_capture).as_str().to_string())
        },
        created_at: to_rfc3339(s.created_at),
        updated_at: to_rfc3339(updated_ts),
    }
}

/// Map the DB `last_status` onto the API status union. A session with no live
/// detection (`unknown`) reads as `stopped` for the client.
fn normalize_status(s: &str) -> String {
    match s {
        "active" | "waiting" | "idle" | "stopped" | "starting" => s.to_string(),
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

/// Last N lines of `capture`, ANSI-stripped (§3.4 SessionSummary.preview_lines).
/// Sized to 20 so the Settings → Expanded-text hover mode has the full tail to
/// reveal; the static tile still only renders the bottom ~6 (CSS-clipped by the
/// idle container height + the top fade mask), so no compactness regression.
fn preview_lines(capture: &str) -> Vec<String> {
    if capture.is_empty() {
        return Vec::new();
    }
    let stripped = ANSI_RE.replace_all(capture, "");
    let lines: Vec<String> = stripped.lines().map(str::to_string).collect();
    let start = lines.len().saturating_sub(20);
    lines[start..].to_vec()
}

/// Last `n` lines of `capture` VERBATIM (escapes kept) — drives `preview_ansi`,
/// the colour-true tile preview. `capture` is already trimmed of trailing blanks
/// upstream (`prepare_capture_ansi`).
fn last_n_lines(capture: &str, n: usize) -> Vec<String> {
    if capture.is_empty() {
        return Vec::new();
    }
    let lines: Vec<String> = capture.lines().map(str::to_string).collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].to_vec()
}

// ── validation helpers ───────────────────────────────────────────────────────

static NAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_.-]+$").unwrap());
const PROVIDERS: [&str; 3] = ["claude", "codex", "shell"];

/// Session-name slug rule (§1.2 of feature-extract): `[a-zA-Z0-9_.-]+`, bounded.
pub(crate) fn valid_name(name: &str) -> bool {
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
        .map(|s| view(s, rt_map.get(&s.name), state.session_activity(&s.name)))
        .collect())
}

pub async fn get(state: &AppState, name: &str) -> Result<SessionView, AppError> {
    let s = db::sessions::get(&state.pool, name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))?;
    let rt = db::sessions::runtime(&state.pool, name).await?;
    Ok(view(&s, rt.as_ref(), state.session_activity(name)))
}

/// List archived (soft-deleted) sessions — the Archived sheet's data source.
/// Mirrors [`list`] but on `WHERE archived = 1` (most-recently-touched first).
/// Each row carries `archived: true` so the client renders them in the recovery
/// sheet rather than the live overview.
pub async fn list_archived(state: &AppState) -> Result<Vec<SessionView>, AppError> {
    let sessions = db::sessions::list_archived(&state.pool).await?;
    let rt_map: HashMap<String, SessionRuntime> = db::sessions::list_runtimes(&state.pool)
        .await?
        .into_iter()
        .map(|r| (r.name.clone(), r))
        .collect();
    Ok(sessions
        .iter()
        .map(|s| view(s, rt_map.get(&s.name), state.session_activity(&s.name)))
        .collect())
}

/// Hard-delete (the "Delete forever" path): permanently DELETE an ARCHIVED
/// session row. Refuses when the row is missing (404) or still live (409,
/// `archived = 0`) so purge can never nuke a running/visible session. Audited
/// as `session.purge` (harder-destructive than `session.delete` — the archived
/// scrollback dump goes too), and the dump file under `<data_dir>/archives/` is
/// best-effort removed. `session_runtime` + child rows cascade via FK.
pub async fn purge(state: &AppState, name: &str) -> Result<(), AppError> {
    // Refuse a live (or absent) session BEFORE the destructive DELETE so the
    // caller gets a clean 404/409 rather than a silent no-op.
    match db::sessions::is_archived(&state.pool, name).await? {
        None => return Err(AppError::NotFound(format!("session '{name}'"))),
        Some(false) => {
            return Err(AppError::Conflict(format!(
                "session '{name}' is not archived — archive it before purging"
            )))
        }
        Some(true) => {}
    }

    let removed = db::sessions::purge_archived(&state.pool, name).await?;
    if removed == 0 {
        // Raced with another purge/unarchive between the guard and the DELETE.
        return Err(AppError::NotFound(format!("session '{name}'")));
    }

    // R2-011: audit row per ARCHITECTURE §3.3 — every destructive HTTP call
    // records an entry. `purge` is the hardest-destructive session op (the row
    // AND its archived scrollback are gone), so it MUST leave a forensic trace.
    // `?` (not `let _ =`) so a failed audit-insert fails the request, matching
    // the `session.delete`/`session.archive` patterns.
    db::audit::log(&state.pool, "user", "session.purge", name, json!({})).await?;

    // Best-effort: remove the scrollback dump(s) this session wrote on archive
    // (`<data_dir>/archives/<name>-<ts>.log`). Failure is non-fatal — the row is
    // already gone; a stale dump is harmless and never re-surfaces in the UI.
    let archive_dir = state.config.data_dir.join("archives");
    let prefix = format!("{name}-");
    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(entries) = std::fs::read_dir(&archive_dir) {
            for entry in entries.flatten() {
                let fname = entry.file_name();
                let fname = fname.to_string_lossy();
                if fname.starts_with(&prefix) && fname.ends_with(".log") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    })
    .await;

    // Drop any lingering per-session in-memory maps (hook token, locks, watches).
    // The background loops already exited at archive time (they guard on
    // `exists_active`), so this is just final cleanup.
    state.forget_session(name);
    Ok(())
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
    // M5a: start this session's 2s status detector loop (the loop self-terminates
    // when the session is deleted). Boot-time sessions are wired by
    // `auto_actions::spawn_all`; this covers sessions created in-process.
    auto_actions::spawn_status_loop(state.clone(), name.clone());
    // M9: start this session's steering delivery loop (mirrors the detector
    // lifecycle — self-terminates on delete; boot-time sessions are wired by
    // `steering::deliver_loop::spawn_all`).
    steering::deliver_loop::spawn(state.clone(), name.clone());
    get(state, &name).await
}

pub async fn delete(state: &AppState, name: &str) -> Result<(), AppError> {
    ensure_session(state, name).await?;
    // R2: capture whether any board card links to this session BEFORE the delete.
    // The `issues.session` FK is `ON DELETE SET NULL`, so after the row is gone
    // the link is already nulled and `issues_for_session` would find nothing — we
    // must check first, then re-publish the board AFTER so open boards drop the
    // now-dangling link (`session_live` → false) without a manual refetch.
    let had_linked_issues = !db::board::issues_for_session(&state.pool, name)
        .await
        .unwrap_or_default()
        .is_empty();
    // Best-effort tmux teardown so a deleted session leaves no orphan pane/FIFO.
    let _ = tmux::Tmux::new(name).kill_session().await;
    db::sessions::delete(&state.pool, name).await?;

    // R2-011: audit row per ARCHITECTURE §3.3 — every destructive HTTP call
    // records an entry. `delete` is harder-destructive than `archive` (the row
    // is gone, not just soft-archived), so it MUST leave a forensic trace.
    // Uses `?` (not `let _ =`) so a failed audit-insert fails the request,
    // matching board/mod.rs:401, files/mod.rs:262, scheduler/runner.rs:92,
    // agents/delegate.rs:63, and the archive fix at lifecycle.rs:454.
    db::audit::log(&state.pool, "user", "session.delete", name, json!({})).await?;

    // Nudge the per-session background loops to re-check their `exists_active`
    // guard immediately (detector via the wake handle; steering via a no-op
    // status-watch re-send), so they observe the deleted row and exit.
    state.wake_detector(name);
    {
        let tx = state.status_watch_for(name);
        let cur = tx.borrow().clone();
        tx.send_replace(cur);
    }

    // R1-2: `forget_session` must be the LAST thing — wait for every per-session
    // loop to stop (task-guard count → 0) before dropping the DashMap entries,
    // otherwise a still-running loop's `or_insert_with` re-creates them.
    for _ in 0..100 {
        if state.live_session_tasks(name) == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    // §3.2.5 lock-map lifecycle: drop every per-session in-memory map entry so
    // session churn does not leak DashMap entries.
    state.forget_session(name);

    // R2: if any card linked to this (now-deleted) session, re-publish the board
    // so open boards reflect the FK-nulled, now-stale link immediately.
    if had_linked_issues {
        crate::board::emit_board(state).await;
    }
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
    // M5a/M9: a duplicated session is a real session — give it the same detector
    // and steering delivery loops a created one gets.
    auto_actions::spawn_status_loop(state.clone(), new_name.to_string());
    steering::deliver_loop::spawn(state.clone(), new_name.to_string());
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
            // Complete the rename across all three layers so a RUNNING session
            // survives it. The live tmux session is named `supermux-<name>`, so
            // without renaming it the renamed row would point at a tmux target
            // that no longer exists and the terminal would go dark. Order: rename
            // tmux FIRST (the only fallible external step) so a failure aborts
            // before the DB drifts; the window/pane (and its pipe-pane capture)
            // survive the rename untouched.
            let tmux = tmux::Tmux::new(&current);
            let live = tmux.exists().await.unwrap_or(false);
            if live {
                tmux.rename_session(target).await?;
            }
            db::sessions::rename(&state.pool, &current, target).await?;
            // Carry the per-session in-memory maps (lock/watch/hook token) over.
            state.rename_session(&current, target);
            // The carried pty stream still polls the OLD tmux name for liveness;
            // drop it so the next attach rebuilds fresh against `supermux-<new>`
            // (same pattern as a restart). No-op for a stopped session.
            if live {
                state.pty_invalidate(target);
            }
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

// ── git status (feat-session-info) ─────────────────────────────────────────────

/// Live git status for a session's working dir, surfaced by
/// `GET /api/sessions/{name}/git`. The stored `branch` label is set once at
/// create time and goes stale; this reads the REAL state on demand so the info
/// panel never lies. Every field defaults to "not a repo" so a non-git dir (or a
/// missing `git` binary) degrades cleanly — the panel just hides the section.
#[derive(Debug, Default, Serialize)]
pub struct GitInfo {
    /// True when `dir` is inside a git work tree.
    pub repo: bool,
    /// Current branch name; the short commit SHA when HEAD is detached; empty
    /// when not a repo.
    pub branch: String,
    /// True when HEAD is detached (then `branch` holds the short SHA).
    pub detached: bool,
    /// True when the work tree has uncommitted changes (tracked or untracked).
    pub dirty: bool,
    /// Commits ahead of the upstream (0 when there is no upstream / not a repo).
    pub ahead: u32,
    /// Commits behind the upstream (0 when there is no upstream / not a repo).
    pub behind: u32,
}

/// Read the live git status of `dir` in a single `git status --porcelain=v2
/// --branch` (branch head, ahead/behind, and per-file change lines in one shot).
/// Never errors: anything other than a clean exit (not a repo, `git` absent, dir
/// gone) yields the default `GitInfo { repo: false, .. }`.
async fn git_info(dir: &str) -> GitInfo {
    let mut info = GitInfo::default();
    let out = match tokio::process::Command::new("git")
        .args(["-C", dir, "status", "--porcelain=v2", "--branch"])
        .output()
        .await
    {
        Ok(o) if o.status.success() => o,
        _ => return info,
    };
    info.repo = true;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut oid = String::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.") {
            if let Some(v) = rest.strip_prefix("oid ") {
                oid = v.trim().to_string();
            } else if let Some(v) = rest.strip_prefix("head ") {
                let v = v.trim();
                if v == "(detached)" {
                    info.detached = true;
                } else {
                    info.branch = v.to_string();
                }
            } else if let Some(v) = rest.strip_prefix("ab ") {
                // "+<ahead> -<behind>"
                for tok in v.split_whitespace() {
                    if let Some(n) = tok.strip_prefix('+') {
                        info.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = tok.strip_prefix('-') {
                        info.behind = n.parse().unwrap_or(0);
                    }
                }
            }
        } else if !line.starts_with('#') && !line.is_empty() {
            // Any 1/2/u/? entry line means the work tree is dirty.
            info.dirty = true;
        }
    }
    if info.detached {
        info.branch = oid.chars().take(12).collect();
    }
    info
}

// ── handlers ─────────────────────────────────────────────────────────────────

async fn list_handler(
    State(state): State<AppState>,
) -> Result<Json<Envelope<Vec<SessionView>>>, AppError> {
    Ok(ok(list(&state).await?))
}

async fn list_archived_handler(
    State(state): State<AppState>,
) -> Result<Json<Envelope<Vec<SessionView>>>, AppError> {
    Ok(ok(list_archived(&state).await?))
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

async fn purge_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    purge(&state, &name).await?;
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

async fn git_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let s = db::sessions::get(&state.pool, &name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))?;
    // An explicit on-open fetch — `git_info` runs `git` as an async child, so a
    // large work tree's stat cost never blocks the runtime.
    let info = git_info(&s.dir).await;
    Ok(Json(json!({ "ok": true, "data": info })))
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

/// `POST /api/sessions/{name}/external-edit/submit` (bearer auth). The dashboard's
/// native-editor sheet posts the edited text (`{requestId, text}`) on "Done"/"Save"
/// or `{requestId, cancelled:true}` on dismiss; we resolve the session's in-flight
/// edit so the `$EDITOR` bridge's `/result` long-poll returns. A stale/missing
/// `requestId` (edit already resolved, timed out, or superseded) → 409 (the
/// dashboard just drops the sheet). See `crate::external_edit`.
async fn external_edit_submit_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<crate::external_edit::SubmitBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::external_edit::submit(&state, &name, body).await?;
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

async fn unarchive_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Reverse of archive (the overview's Undo). Flips `archived = 0` + emits the
    // `sessions` SSE delta SYNCHRONOUSLY, so it returns 200 once the row is back.
    lifecycle::unarchive(&state, &name).await?;
    Ok(Json(json!({ "ok": true })))
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

// ── mode-shift ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ModeInput {
    /// The target permission mode: `normal` | `accept_edits` | `plan` | `bypass`.
    mode: String,
}

/// `POST /api/sessions/{name}/mode {mode}` — switch the Claude permission mode
/// (mode-shift). `normal`/`accept_edits`/`plan` cycle in place via targeted
/// Shift+Tab (re-reading the capture, capped retries); `bypass` does a clean
/// relaunch (stop → add the flag → resume). Returns the mode ACTUALLY in effect
/// after the op (the UI reflects truth) + whether it converged / relaunched.
async fn mode_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<ModeInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let target = status::Mode::from_token(&input.mode).ok_or_else(|| {
        AppError::BadRequest(format!(
            "invalid mode '{}' (expected normal|accept_edits|plan|bypass)",
            input.mode
        ))
    })?;
    let result = lifecycle::set_mode(&state, &name, target).await?;
    Ok(Json(json!({ "ok": true, "data": result })))
}

// ── feat-resume-picker ─────────────────────────────────────────────────────────

/// `GET /api/sessions/{name}/resumable` — past Claude conversations for the
/// session's working dir, newest-first. Empty list when the dir has no project
/// folder / no conversations (the picker hides Resume).
async fn resumable_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let s = db::sessions::get(&state.pool, &name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))?;
    let dir = s.dir.clone();
    // Filesystem scan can touch large transcripts → off the async runtime.
    let list = tokio::task::spawn_blocking(move || resumable::list_for_dir(&dir))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("resumable scan join failed: {e}")))?;
    Ok(Json(json!({ "ok": true, "data": list })))
}

#[derive(Debug, Deserialize)]
struct ResumeInput {
    id: String,
}

/// `POST /api/sessions/{name}/resume {id}` — set the session's Claude
/// conversation id, then run the existing start path. The launch builder turns
/// `cc_conversation_id` into `claude --resume <id>`, so the session resumes that
/// conversation instead of booting fresh.
async fn resume_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<ResumeInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let id = input.id.trim();
    if id.is_empty() {
        return Err(AppError::BadRequest("expected {id}".into()));
    }
    // Validate the session exists before touching the row.
    ensure_session(&state, &name).await?;
    db::sessions::set_cc_conversation_id(&state.pool, &name, id).await?;
    let result = lifecycle::start(&state, &name, None).await?;
    Ok(Json(json!({ "ok": true, "data": result })))
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

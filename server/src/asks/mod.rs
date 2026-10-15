//! Asks — the durable, answerable record of "an agent is waiting on a human".
//!
//! An ask is one of five kinds, each raised by a signal supermux already had:
//!
//! | kind          | raised by                                                   |
//! |---------------|-------------------------------------------------------------|
//! | `permission`  | Claude Code's `PermissionRequest` hook (a tool dialog)      |
//! | `question`    | an `AskUserQuestion` call (its PreToolUse + PermissionRequest)|
//! | `elicitation` | an MCP server's form (`Elicitation` hook)                   |
//! | `needs_input` | a board card's `needs-input` (`supermux-task needs-input`)  |
//! | `waiting`     | a needs-you `Notification` (idle / needs input)             |
//!
//! Every ask is a row in `asks` (migration 0046) with a stable id, a state
//! (`open` → `answered` | `dismissed` | `resolved`) and a global, monotonic
//! `rev`. Every change is published as an `asks` SSE frame carrying the rev, and
//! `GET /api/asks?since=<rev>` replays every change after a cursor — so neither a
//! restart nor a disconnected client loses an ask.
//!
//! **Answering.** `permission`, `question` and `elicitation` asks are answered
//! through Claude Code's own hook decision control, not keystrokes: the
//! `PermissionRequest` (and, opt-in, `Elicitation`) hook supermux installs is a
//! long-poll ([`hook`]) that stays connected while the dialog is up, and an API
//! answer is printed by that hook as the documented `hookSpecificOutput`. The
//! terminal dialog stays fully usable meanwhile — Claude Code runs
//! PermissionRequest hooks alongside the dialog and takes whichever answers
//! first — so this never takes the prompt away from a human at the keyboard.
//! `needs_input` and `waiting` asks are answered by typing the reply into the
//! session (the board-reply path).
//!
//! **Ground truth for "still pending".** A connected decision hook IS the proof
//! that Claude is still waiting on that request: Claude kills the hook when the
//! request is cancelled (an interrupt, a "No" at the terminal) and supermux
//! releases it the moment a later hook proves the request was answered
//! (PostToolUse etc.). So the "the turn moved on" clears never close an ask
//! whose hook is still attached, and a hook that vanishes without being
//! released closes its ask after a short grace period.

pub mod answer;
pub mod detail;
pub mod hook;

use std::collections::HashMap;
use std::path::Path as FsPath;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::auth_human::AuthContext;
use crate::db;
use crate::db::asks::AskRow;
use crate::error::AppError;
use crate::state::{AppState, SseEvent};

pub const KIND_PERMISSION: &str = "permission";
pub const KIND_QUESTION: &str = "question";
pub const KIND_ELICITATION: &str = "elicitation";
pub const KIND_NEEDS_INPUT: &str = "needs_input";
pub const KIND_WAITING: &str = "waiting";
pub const KINDS: [&str; 5] = [
    KIND_PERMISSION,
    KIND_QUESTION,
    KIND_ELICITATION,
    KIND_NEEDS_INPUT,
    KIND_WAITING,
];

pub const STATES: [&str; 4] = ["open", "answered", "dismissed", "resolved"];

/// The kinds answered through a waiting decision hook.
fn is_hook_kind(kind: &str) -> bool {
    matches!(kind, KIND_PERMISSION | KIND_QUESTION | KIND_ELICITATION)
}

/// The SSE event name every ask change is published under.
pub const SSE_EVENT: &str = "asks";

// ── config ───────────────────────────────────────────────────────────────────

/// `[asks]` block of `config.toml`. Read on its own (the main config parser
/// ignores unknown tables), so adding it needs no change to [`crate::config`].
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct AsksConfig {
    /// How long a `PermissionRequest` decision hook waits for an API answer
    /// before it gives up and leaves the dialog to the terminal (seconds,
    /// clamped to `0..=86400`). The dialog is usable in the terminal the whole
    /// time; `0` turns API answering of permission/question asks off.
    pub hold_secs: u64,
    /// The same for MCP elicitation forms — but OFF by default, because Claude
    /// Code runs `Elicitation` hooks BEFORE it draws the form: while the hook
    /// waits, the form is not shown in the terminal. Set it (e.g. `600`) to
    /// answer forms remotely; after it lapses the form appears as usual.
    pub elicitation_hold_secs: u64,
    /// Closed asks older than this are pruned (days, at least 1).
    pub retention_days: u64,
    /// How long a vanished decision hook may take to reconnect before its ask
    /// is closed as cancelled (milliseconds).
    pub hook_grace_ms: u64,
}

pub const MAX_HOLD_SECS: u64 = 86_400;

impl Default for AsksConfig {
    fn default() -> Self {
        Self {
            hold_secs: MAX_HOLD_SECS,
            elicitation_hold_secs: 0,
            retention_days: 30,
            hook_grace_ms: 5_000,
        }
    }
}

impl AsksConfig {
    fn clamped(mut self) -> Self {
        self.hold_secs = self.hold_secs.min(MAX_HOLD_SECS);
        self.elicitation_hold_secs = self.elicitation_hold_secs.min(MAX_HOLD_SECS);
        self.retention_days = self.retention_days.max(1);
        self
    }

    /// Read `[asks]` from `<data_dir>/config.toml`; defaults when absent or
    /// unreadable (logged — a typo must not take the server down).
    pub fn load(data_dir: &FsPath) -> Self {
        #[derive(Deserialize, Default)]
        struct Wrapper {
            #[serde(default)]
            asks: Option<AsksConfig>,
        }
        let path = data_dir.join("config.toml");
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        match toml::from_str::<Wrapper>(&text) {
            Ok(w) => w.asks.unwrap_or_default().clamped(),
            Err(e) => {
                tracing::warn!(error = %e, "asks: could not parse [asks] in config.toml; using defaults");
                Self::default()
            }
        }
    }
}

// ── in-memory registry ───────────────────────────────────────────────────────

/// What a waiting decision hook is handed.
#[derive(Debug)]
pub enum Outcome {
    /// Print this JSON (the hook's decision-control output).
    Decision(Value),
    /// Print nothing: the ask closed some other way, or a newer hook took over.
    Release,
}

struct Waiter {
    gen: u64,
    tx: oneshot::Sender<Outcome>,
    /// The hook payload, exactly as Claude Code sent it. Memory only: it is what
    /// an AskUserQuestion answer's `updatedInput` is built from, and what the
    /// live `input` view shows.
    payload: Arc<Value>,
}

/// Why a decision hook stopped waiting without being answered or released.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detach {
    /// The hold lapsed: the dialog is the terminal's alone now.
    Expired,
    /// The connection dropped: Claude killed the hook (the request was
    /// cancelled), or the network blipped and a retry is on its way.
    Gone,
}

/// Bound on remembered `tool_use_id → match key` pairs.
const TOOL_KEYS_MAX: usize = 4096;

fn tool_use_id(raw: &Value) -> Option<&str> {
    raw.get("tool_use_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

pub struct AskRegistry {
    pub config: AsksConfig,
    locks: DashMap<String, Arc<tokio::sync::Mutex<()>>>,
    waiters: std::sync::Mutex<HashMap<String, Waiter>>,
    tool_keys: std::sync::Mutex<HashMap<String, String>>,
    next_gen: AtomicU64,
}

impl AskRegistry {
    pub fn new(config: AsksConfig) -> Self {
        Self {
            config,
            locks: DashMap::new(),
            waiters: std::sync::Mutex::new(HashMap::new()),
            tool_keys: std::sync::Mutex::new(HashMap::new()),
            next_gen: AtomicU64::new(1),
        }
    }

    /// Serialise every ask mutation of one session: the PreToolUse and the
    /// PermissionRequest of one AskUserQuestion arrive ~20 ms apart on separate
    /// requests and must land on ONE row.
    async fn lock(&self, session: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let m = self.locks.entry(session.to_string()).or_default().clone();
        m.lock_owned().await
    }

    fn waiters(&self) -> std::sync::MutexGuard<'_, HashMap<String, Waiter>> {
        self.waiters.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn has_waiter(&self, id: &str) -> bool {
        self.waiters().contains_key(id)
    }

    fn payload_of(&self, id: &str) -> Option<Arc<Value>> {
        self.waiters().get(id).map(|w| w.payload.clone())
    }

    /// Remember which match key a tool call's PreToolUse carried, so its
    /// PostToolUse (same `tool_use_id`) closes exactly that ask.
    fn remember_tool_key(&self, tool_use_id: &str, key: String) {
        let mut m = self.tool_keys.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() >= TOOL_KEYS_MAX {
            // A PostToolUse that never came (killed session) leaks one entry; a
            // wholesale reset at the cap bounds that without bookkeeping.
            m.clear();
        }
        m.insert(tool_use_id.to_string(), key);
    }

    fn take_tool_key(&self, tool_use_id: &str) -> Option<String> {
        self.tool_keys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tool_use_id)
    }

    /// Send `outcome` to the waiter of `id` (removing it). `false` when there
    /// was none, or its hook already hung up.
    fn deliver(&self, id: &str, outcome: Outcome) -> bool {
        let w = self.waiters().remove(id);
        match w {
            Some(w) => w.tx.send(outcome).is_ok(),
            None => false,
        }
    }
}

// ── wire view ────────────────────────────────────────────────────────────────

/// The ask as every API surface and SSE frame shows it.
#[derive(Debug, Clone, Serialize)]
pub struct AskView {
    pub id: String,
    pub session: String,
    pub kind: String,
    pub state: String,
    /// Can `POST /api/asks/{id}/answer` deliver an answer right now? For
    /// permission / question / elicitation: a decision hook is connected and
    /// waiting. For needs_input / waiting: the ask is open (the answer is typed
    /// into the session).
    pub answerable: bool,
    pub detail: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_ms: Option<i64>,
    pub rev: i64,
    /// LIVE ONLY (`GET` responses, while a decision hook waits): the real tool
    /// input and Claude's offered permission updates. Never persisted, never on
    /// SSE.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
}

pub fn view(row: &AskRow) -> AskView {
    let open = row.state == "open";
    let answerable = open && (!is_hook_kind(&row.kind) || row.hook_attached != 0);
    AskView {
        id: row.id.clone(),
        session: row.session.clone(),
        kind: row.kind.clone(),
        state: row.state.clone(),
        answerable,
        detail: serde_json::from_str(&row.detail).unwrap_or_else(|_| json!({})),
        resolution: row
            .resolution
            .as_deref()
            .and_then(|r| serde_json::from_str(r).ok()),
        issue_id: row.issue_id.clone(),
        created_ms: row.created_at,
        updated_ms: row.updated_at,
        resolved_ms: row.resolved_at,
        rev: row.rev,
        input: None,
    }
}

fn view_live(state: &AppState, row: &AskRow) -> AskView {
    let mut v = view(row);
    if row.state == "open" {
        if let Some(p) = state.asks.payload_of(&row.id) {
            v.input = Some(detail::live_input(&p));
        }
    }
    v
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn emit(state: &AppState, op: &str, row: &AskRow) {
    // The literal (not `SSE_EVENT`) is what `web/tests/unit/sse-events.test.ts`
    // scrapes to prove the client subscribes to every emitted channel.
    let _ = state.sse_tx.send(SseEvent::global(
        "asks",
        json!({ "op": op, "rev": row.rev, "ask": view(row) }),
    ));
}

fn new_id() -> String {
    format!("ask_{}", uuid::Uuid::new_v4().simple())
}

// ── lifecycle (callers hold the session lock) ────────────────────────────────

/// Find the open ask of `(session, kind, key)` or create it. A re-raised ask
/// whose detail changed is updated in place (same id, new rev).
async fn open_or_refresh(
    state: &AppState,
    session: &str,
    kind: &str,
    key: &str,
    detail: &Value,
    issue_id: Option<&str>,
) -> anyhow::Result<AskRow> {
    let detail_s = detail.to_string();
    let open = db::asks::open_for_session(&state.pool, session, Some(kind)).await?;
    if let Some(row) = open.into_iter().find(|r| r.match_key == key) {
        if row.detail == detail_s {
            return Ok(row);
        }
        if let Some(updated) =
            db::asks::update_detail(&state.pool, &row.id, &detail_s, now_ms()).await?
        {
            emit(state, "updated", &updated);
            return Ok(updated);
        }
        return Ok(row);
    }
    let id = new_id();
    let row = db::asks::insert(
        &state.pool,
        &db::asks::NewAsk {
            id: &id,
            session,
            kind,
            match_key: key,
            detail: &detail_s,
            issue_id,
            now: now_ms(),
        },
    )
    .await?;
    emit(state, "opened", &row);
    Ok(row)
}

/// Close one open ask and release its decision hook (if any) with "no answer".
async fn close_row(
    state: &AppState,
    row: &AskRow,
    new_state: &str,
    resolution: Value,
) -> anyhow::Result<Option<AskRow>> {
    let closed = db::asks::close(
        &state.pool,
        &row.id,
        new_state,
        &resolution.to_string(),
        now_ms(),
    )
    .await?;
    state.asks.deliver(&row.id, Outcome::Release);
    if let Some(c) = &closed {
        emit(state, "closed", c);
    }
    Ok(closed)
}

fn resolution(by: &str, outcome: &str) -> Value {
    json!({ "by": by, "outcome": outcome })
}

/// Which open asks a "the session moved on" event closes.
#[derive(Clone, Copy)]
enum Sweep {
    /// Only asks with NO decision hook attached (an attached hook proves the
    /// request is still pending in Claude).
    Unhooked,
    /// Everything — the Claude process itself started or ended.
    All,
}

async fn close_kinds(
    state: &AppState,
    session: &str,
    kinds: &[&str],
    sweep: Sweep,
    res: Value,
) -> anyhow::Result<()> {
    for row in db::asks::open_for_session(&state.pool, session, None).await? {
        if !kinds.contains(&row.kind.as_str()) {
            continue;
        }
        if matches!(sweep, Sweep::Unhooked)
            && is_hook_kind(&row.kind)
            && state.asks.has_waiter(&row.id)
        {
            continue;
        }
        close_row(state, &row, "resolved", res.clone()).await?;
    }
    Ok(())
}

/// A tool call finished (PostToolUse / PostToolUseFailure): close the
/// permission / question ask it belonged to — it was answered outside this API
/// (at the terminal, or by another client pressing keys).
async fn close_for_tool(
    state: &AppState,
    session: &str,
    raw: &Value,
    failed: bool,
) -> anyhow::Result<()> {
    let open: Vec<AskRow> = db::asks::open_for_session(&state.pool, session, None)
        .await?
        .into_iter()
        .filter(|r| r.kind == KIND_PERMISSION || r.kind == KIND_QUESTION)
        .collect();
    let outcome = if failed { "tool_failed" } else { "tool_ran" };
    // The keys this call is known by: the one its PreToolUse was seen with
    // (correlated by `tool_use_id`, robust to anything that rewrote the input on
    // the way), and the one its own input hashes to.
    let mut keys = Vec::new();
    if let Some(k) = tool_use_id(raw).and_then(|t| state.asks.take_tool_key(t)) {
        keys.push(k);
    }
    if detail::tool_name(raw).is_some() {
        keys.push(detail::tool_key(raw));
    }
    let exact = open.iter().find(|r| keys.contains(&r.match_key)).cloned();
    // Without an exact match, fall back — but only onto an ask with NO decision
    // hook attached: an attached hook proves its own request is still pending,
    // so a parallel call of the same tool finishing must not close it.
    let unhooked: Vec<&AskRow> = open
        .iter()
        .filter(|r| !state.asks.has_waiter(&r.id))
        .collect();
    let target = exact.or_else(|| match detail::tool_name(raw) {
        Some(tool) => unhooked
            .iter()
            .find(|r| {
                let d: Value = serde_json::from_str(&r.detail).unwrap_or_default();
                if tool == detail::ASK_USER_QUESTION {
                    r.kind == KIND_QUESTION
                } else {
                    r.kind == KIND_PERMISSION && d["tool"].as_str() == Some(tool)
                }
            })
            .map(|r| (*r).clone()),
        // A payload the hook had to truncate: no tool name to match on. The
        // oldest open unhooked tool ask is the one a finished call most
        // plausibly belonged to (the in-memory card makes the same call).
        None => unhooked.first().map(|r| (*r).clone()),
    });
    if let Some(row) = target {
        close_row(state, &row, "resolved", resolution("terminal", outcome)).await?;
    }
    // An MCP form is raised mid-tool-call: that server's tool finishing proves
    // the form is gone.
    if let Some(tool) = detail::tool_name(raw) {
        if let Some(rest) = tool.strip_prefix("mcp__") {
            let server = rest.split("__").next().unwrap_or_default();
            for row in
                db::asks::open_for_session(&state.pool, session, Some(KIND_ELICITATION)).await?
            {
                let d: Value = serde_json::from_str(&row.detail).unwrap_or_default();
                if d["server"].as_str() == Some(server) && !state.asks.has_waiter(&row.id) {
                    close_row(state, &row, "resolved", resolution("terminal", outcome)).await?;
                }
            }
        }
    }
    // The agent is working again: a needs-you line is stale.
    close_kinds(
        state,
        session,
        &[KIND_WAITING],
        Sweep::All,
        resolution("agent", "working"),
    )
    .await
}

/// Record one Claude Code hook event against the session's asks. Called by
/// [`crate::hooks::ingest`] for every authenticated hook, after the in-memory
/// activity snapshot was updated. Returns the id of the ask this event opened
/// or refreshed (the decision hook waits on it). Never fails the hook: errors
/// are logged.
pub async fn observe(
    state: &AppState,
    session: &str,
    event: &str,
    raw: &Value,
    foreign_agent: bool,
) -> Option<String> {
    let relevant = matches!(
        event,
        "pre_tool"
            | "pre_tool_use"
            | "PreToolUse"
            | "permission_request"
            | "PermissionRequest"
            | "elicitation"
            | "Elicitation"
            | "elicitation_result"
            | "ElicitationResult"
            | "post_tool"
            | "post_tool_use"
            | "PostToolUse"
            | "post_tool_failure"
            | "PostToolUseFailure"
            | "stop"
            | "Stop"
            | "stop_failure"
            | "StopFailure"
            | "user_prompt"
            | "user_prompt_submit"
            | "UserPromptSubmit"
            | "session_start"
            | "SessionStart"
            | "session_end"
            | "SessionEnd"
            | "notification"
            | "Notification"
    );
    if !relevant {
        return None;
    }
    let _guard = state.asks.lock(session).await;
    match observe_locked(state, session, event, raw, foreign_agent).await {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!(session, event, error = %e, "asks: could not record hook event");
            None
        }
    }
}

async fn observe_locked(
    state: &AppState,
    session: &str,
    event: &str,
    raw: &Value,
    foreign_agent: bool,
) -> anyhow::Result<Option<String>> {
    match event {
        "pre_tool" | "pre_tool_use" | "PreToolUse" => {
            if let Some(t) = tool_use_id(raw) {
                state.asks.remember_tool_key(t, detail::tool_key(raw));
            }
            if detail::is_question(raw) {
                if let Some(d) = detail::question(raw) {
                    let row = open_or_refresh(
                        state,
                        session,
                        KIND_QUESTION,
                        &detail::tool_key(raw),
                        &d,
                        None,
                    )
                    .await?;
                    return Ok(Some(row.id));
                }
            }
            Ok(None)
        }
        "permission_request" | "PermissionRequest" => {
            let key = detail::tool_key(raw);
            if detail::is_question(raw) {
                if let Some(d) = detail::question(raw) {
                    let row =
                        open_or_refresh(state, session, KIND_QUESTION, &key, &d, None).await?;
                    return Ok(Some(row.id));
                }
            }
            match detail::permission(raw) {
                Some(d) => {
                    let row =
                        open_or_refresh(state, session, KIND_PERMISSION, &key, &d, None).await?;
                    Ok(Some(row.id))
                }
                None => Ok(None),
            }
        }
        "elicitation" | "Elicitation" => match detail::elicitation(raw) {
            Some(d) => {
                let row = open_or_refresh(
                    state,
                    session,
                    KIND_ELICITATION,
                    &detail::elicitation_key(raw),
                    &d,
                    None,
                )
                .await?;
                Ok(Some(row.id))
            }
            None => Ok(None),
        },
        "elicitation_result" | "ElicitationResult" => {
            let action = raw
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("answered");
            let has_id = raw
                .get("elicitation_id")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty());
            let key = detail::elicitation_key(raw);
            for row in
                db::asks::open_for_session(&state.pool, session, Some(KIND_ELICITATION)).await?
            {
                if !has_id || row.match_key == key {
                    close_row(state, &row, "resolved", resolution("terminal", action)).await?;
                }
            }
            Ok(None)
        }
        "post_tool" | "post_tool_use" | "PostToolUse" => {
            close_for_tool(state, session, raw, false).await?;
            Ok(None)
        }
        "post_tool_failure" | "PostToolUseFailure" => {
            close_for_tool(state, session, raw, true).await?;
            Ok(None)
        }
        "stop" | "Stop" | "stop_failure" | "StopFailure" => {
            let child = foreign_agent || raw.get("agent_id").and_then(Value::as_str).is_some();
            if matches!(event, "stop_failure" | "StopFailure") && child {
                return Ok(None);
            }
            close_kinds(
                state,
                session,
                &[
                    KIND_PERMISSION,
                    KIND_QUESTION,
                    KIND_ELICITATION,
                    KIND_WAITING,
                ],
                Sweep::Unhooked,
                resolution("agent", "turn_ended"),
            )
            .await?;
            Ok(None)
        }
        "user_prompt" | "user_prompt_submit" | "UserPromptSubmit" => {
            if foreign_agent {
                return Ok(None);
            }
            // A new prompt is the human (or a teammate) talking to the agent
            // again — the one signal that a board needs-input was answered
            // outside this API (typed at the terminal, in chat…). NOT the
            // session going Active: an agent raises needs-input mid-turn, while
            // it is still active, so that edge says nothing about an answer.
            close_kinds(
                state,
                session,
                &[
                    KIND_PERMISSION,
                    KIND_QUESTION,
                    KIND_ELICITATION,
                    KIND_WAITING,
                    KIND_NEEDS_INPUT,
                ],
                Sweep::Unhooked,
                resolution("session", "new_prompt"),
            )
            .await?;
            Ok(None)
        }
        "session_start" | "SessionStart" | "session_end" | "SessionEnd" => {
            if foreign_agent {
                return Ok(None);
            }
            let outcome = if event.to_ascii_lowercase().contains("start") {
                "session_started"
            } else {
                "session_ended"
            };
            close_kinds(
                state,
                session,
                &[
                    KIND_PERMISSION,
                    KIND_QUESTION,
                    KIND_ELICITATION,
                    KIND_WAITING,
                ],
                Sweep::All,
                resolution("session", outcome),
            )
            .await?;
            Ok(None)
        }
        "notification" | "Notification" => {
            let ntype = raw
                .get("notification_type")
                .or_else(|| raw.get("notificationType"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let message = raw
                .get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if message.is_empty()
                || !matches!(
                    ntype,
                    "permission_prompt" | "idle_prompt" | "agent_needs_input"
                )
            {
                return Ok(None);
            }
            if ntype == "permission_prompt" {
                // The same dialog a permission / question ask already stands for.
                let blocking = db::asks::open_for_session(&state.pool, session, None)
                    .await?
                    .iter()
                    .any(|r| is_hook_kind(&r.kind));
                if blocking {
                    return Ok(None);
                }
            }
            let row = open_or_refresh(
                state,
                session,
                KIND_WAITING,
                "waiting",
                &detail::waiting(ntype, message),
                None,
            )
            .await?;
            Ok(Some(row.id))
        }
        _ => Ok(None),
    }
}

// ── decision-hook waiters ────────────────────────────────────────────────────

/// Register a connected decision hook as the waiter of `id`. `None` when the
/// ask is no longer open (it closed between the hook's arrival and now). A
/// previous waiter of the same ask (a hook that reconnected after a blip) is
/// released.
pub async fn attach(
    state: &AppState,
    session: &str,
    id: &str,
    payload: Arc<Value>,
) -> Option<(u64, oneshot::Receiver<Outcome>)> {
    let _guard = state.asks.lock(session).await;
    let row = db::asks::get(&state.pool, id).await.ok().flatten()?;
    if row.state != "open" {
        return None;
    }
    let gen = state.asks.next_gen.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    let old = state
        .asks
        .waiters()
        .insert(id.to_string(), Waiter { gen, tx, payload });
    if let Some(old) = old {
        let _ = old.tx.send(Outcome::Release);
    }
    match db::asks::set_hook_attached(&state.pool, id, true, now_ms()).await {
        Ok(Some(updated)) => emit(state, "updated", &updated),
        Ok(None) => {}
        Err(e) => tracing::warn!(id, error = %e, "asks: could not mark hook attached"),
    }
    Some((gen, rx))
}

/// A decision hook stopped waiting without an answer or a release.
pub async fn detach(state: &AppState, session: &str, id: &str, gen: u64, why: Detach) {
    {
        let _guard = state.asks.lock(session).await;
        let mine = {
            let mut w = state.asks.waiters();
            if w.get(id).is_some_and(|x| x.gen == gen) {
                w.remove(id);
                true
            } else {
                false
            }
        };
        if !mine {
            // A newer hook took over, or the waiter was consumed: nothing to do.
            return;
        }
        match db::asks::set_hook_attached(&state.pool, id, false, now_ms()).await {
            Ok(Some(updated)) => emit(state, "updated", &updated),
            Ok(None) => {}
            Err(e) => tracing::warn!(id, error = %e, "asks: could not mark hook detached"),
        }
    }
    if why == Detach::Gone {
        // Claude kills the hook when it cancels the request (an interrupt, a
        // "No" at the terminal); a network blip reconnects within the grace.
        let grace = Duration::from_millis(state.asks.config.hook_grace_ms);
        let state = state.clone();
        let session = session.to_string();
        let id = id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            let _guard = state.asks.lock(&session).await;
            if state.asks.has_waiter(&id) {
                return;
            }
            if let Ok(Some(row)) = db::asks::get(&state.pool, &id).await {
                if row.state == "open" {
                    if let Err(e) =
                        close_row(&state, &row, "resolved", resolution("hook", "cancelled")).await
                    {
                        tracing::warn!(id = %id, error = %e, "asks: could not close a cancelled ask");
                    }
                }
            }
        });
    }
}

// ── board needs-input ────────────────────────────────────────────────────────

fn issue_key(issue_id: &str) -> String {
    format!("issue:{issue_id}")
}

/// A board card went "needs input": open (or refresh) its ask.
pub async fn open_needs_input(state: &AppState, session: &str, issue_id: &str, question: &str) {
    let _guard = state.asks.lock(session).await;
    if let Err(e) = open_or_refresh(
        state,
        session,
        KIND_NEEDS_INPUT,
        &issue_key(issue_id),
        &detail::needs_input(issue_id, question),
        Some(issue_id),
    )
    .await
    {
        tracing::warn!(issue_id, error = %e, "asks: could not record needs-input");
    }
}

/// A board card's "needs input" cleared (`by`: `board` for a board reply,
/// `agent` when the agent resumed work).
pub async fn close_needs_input(
    state: &AppState,
    issue_id: &str,
    new_state: &str,
    by: &str,
    outcome: &str,
) {
    let rows = match db::asks::open_for_issue(&state.pool, issue_id).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(issue_id, error = %e, "asks: could not read needs-input asks");
            return;
        }
    };
    for row in rows {
        let _guard = state.asks.lock(&row.session).await;
        if let Err(e) = close_row(state, &row, new_state, resolution(by, outcome)).await {
            tracing::warn!(issue_id, error = %e, "asks: could not close needs-input");
        }
    }
}

// ── answering ────────────────────────────────────────────────────────────────

fn actor_of(ctx: Option<&AuthContext>) -> String {
    match ctx {
        Some(AuthContext::Human { user_id, .. }) => format!("human:{user_id}"),
        _ => "user".to_string(),
    }
}

fn client_label(s: Option<&str>) -> Option<String> {
    s.map(|c| c.trim().chars().take(60).collect::<String>())
        .filter(|c| !c.is_empty())
}

fn not_open(row: &AskRow) -> AppError {
    AppError::Conflict(format!("ask_not_open: ask {} is {}", row.id, row.state))
}

/// Answer an open ask. See [`answer::AnswerBody`] for the per-kind body.
pub async fn answer_ask(
    state: &AppState,
    id: &str,
    body: &answer::AnswerBody,
    actor: &str,
    client: Option<String>,
) -> Result<AskRow, AppError> {
    let row = db::asks::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("ask '{id}'")))?;
    let mut res = json!({ "by": "api", "actor": actor });
    if let Some(c) = &client {
        res["client"] = json!(c);
    }

    if is_hook_kind(&row.kind) {
        let _guard = state.asks.lock(&row.session).await;
        let row = db::asks::get(&state.pool, id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("ask '{id}'")))?;
        if row.state != "open" {
            return Err(not_open(&row));
        }
        let payload = state.asks.payload_of(id).ok_or_else(|| {
            AppError::Conflict(format!(
                "ask_not_answerable: no decision hook is waiting for ask {id} (its hold lapsed, the session's \
                 hooks predate this feature, or the agent is not Claude Code); answer it in the terminal"
            ))
        })?;
        let built = match row.kind.as_str() {
            KIND_PERMISSION => answer::permission(body, &payload),
            KIND_QUESTION => answer::question(body, &payload),
            _ => answer::elicitation(body, &payload),
        };
        let (output, record) = built.map_err(AppError::BadRequest)?;
        if !state.asks.deliver(id, Outcome::Decision(output)) {
            return Err(AppError::Conflict(format!(
                "ask_not_answerable: the decision hook for ask {id} went away before the answer reached it"
            )));
        }
        // permission/question records name a `decision`; an elicitation's
        // names its `action` (accept/decline/cancel).
        res["outcome"] = record
            .get("decision")
            .or_else(|| record.get("action"))
            .cloned()
            .unwrap_or(Value::Null);
        res["answer"] = record;
        let closed = db::asks::close(&state.pool, id, "answered", &res.to_string(), now_ms())
            .await?
            .ok_or_else(|| not_open(&row))?;
        emit(state, "closed", &closed);
        db::audit::log(
            &state.pool,
            actor,
            "ask.answer",
            id,
            json!({ "session": closed.session, "kind": closed.kind, "outcome": res["outcome"] }),
        )
        .await?;
        return Ok(closed);
    }

    // needs_input / waiting: the answer is a reply typed into the session.
    let (text, record) = answer::text(body).map_err(AppError::BadRequest)?;
    res["outcome"] = json!("reply");
    res["answer"] = record;
    let claimed = {
        let _guard = state.asks.lock(&row.session).await;
        let fresh = db::asks::get(&state.pool, id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("ask '{id}'")))?;
        if fresh.state != "open" {
            return Err(not_open(&fresh));
        }
        let c = db::asks::close(&state.pool, id, "answered", &res.to_string(), now_ms())
            .await?
            .ok_or_else(|| not_open(&fresh))?;
        emit(state, "closed", &c);
        c
    };
    // Typed OUTSIDE the lock: delivering wakes the session, whose own hooks
    // (UserPromptSubmit…) must not queue behind this request.
    let delivered = match (claimed.kind.as_str(), claimed.issue_id.as_deref()) {
        (KIND_NEEDS_INPUT, Some(issue)) => crate::board::reply_to_issue(state, issue, &text, actor)
            .await
            .map(|_| ()),
        _ => crate::sessions::lifecycle::send_text(state, &claimed.session, &text).await,
    };
    if let Err(e) = delivered {
        if let Ok(Some(reopened)) = db::asks::reopen(&state.pool, id, now_ms()).await {
            emit(state, "updated", &reopened);
        }
        return Err(e);
    }
    db::audit::log(
        &state.pool,
        actor,
        "ask.answer",
        id,
        json!({ "session": claimed.session, "kind": claimed.kind, "outcome": "reply" }),
    )
    .await?;
    Ok(claimed)
}

/// Dismiss an open ask without answering it. A waiting decision hook is
/// released with no decision, so the dialog simply stays in the terminal.
pub async fn dismiss_ask(
    state: &AppState,
    id: &str,
    actor: &str,
    client: Option<String>,
) -> Result<AskRow, AppError> {
    let row = db::asks::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("ask '{id}'")))?;
    let _guard = state.asks.lock(&row.session).await;
    let row = db::asks::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("ask '{id}'")))?;
    if row.state != "open" {
        return Err(not_open(&row));
    }
    let mut res = json!({ "by": "api", "actor": actor, "outcome": "dismissed" });
    if let Some(c) = client {
        res["client"] = json!(c);
    }
    let closed = close_row(state, &row, "dismissed", res)
        .await?
        .ok_or_else(|| not_open(&row))?;
    db::audit::log(
        &state.pool,
        actor,
        "ask.dismiss",
        id,
        json!({ "session": closed.session, "kind": closed.kind }),
    )
    .await?;
    Ok(closed)
}

// ── maintenance ──────────────────────────────────────────────────────────────

/// Boot (AWAITED before the listener binds, so a decision hook reconnecting
/// in the first instant cannot be marked detached after it attached): no hook
/// of the previous process is attached any more. Then, daily: prune closed
/// asks past retention.
pub async fn start(state: &AppState) {
    match db::asks::detach_all(&state.pool, now_ms()).await {
        Ok(n) if n > 0 => tracing::info!(
            n,
            "asks: cleared stale hook attachments from the previous run"
        ),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "asks: could not clear stale hook attachments"),
    }
    let state = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(24 * 3600));
        loop {
            tick.tick().await;
            let days = state.asks.config.retention_days as i64;
            let cutoff = now_ms() - days * 24 * 3600 * 1000;
            match db::asks::prune_closed_before(&state.pool, cutoff).await {
                Ok(n) if n > 0 => tracing::info!(n, "asks: pruned closed asks past retention"),
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "asks: prune failed"),
            }
        }
    });
}

// ── REST ─────────────────────────────────────────────────────────────────────

pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/asks", get(list_handler))
        .route("/api/asks/{id}", get(get_handler))
        .route("/api/asks/{id}/answer", post(answer_handler))
        .route("/api/asks/{id}/dismiss", post(dismiss_handler))
        .with_state(state)
}

#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    /// `open` (default) / `answered` / `dismissed` / `resolved` / `all`.
    /// With `since`, the default is `all`.
    pub state: Option<String>,
    pub session: Option<String>,
    pub kind: Option<String>,
    /// Return only asks changed after this rev, oldest change first.
    pub since: Option<i64>,
    pub limit: Option<i64>,
}

async fn list_handler(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let st = match q.state.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some("all") => None,
        Some(s) if STATES.contains(&s) => Some(s.to_string()),
        Some(s) => {
            return Err(AppError::BadRequest(format!(
                "state must be one of open, answered, dismissed, resolved, all; got {s:?}"
            )))
        }
        None if q.since.is_some() => None,
        None => Some("open".to_string()),
    };
    if let Some(k) = q.kind.as_deref() {
        if !KINDS.contains(&k) {
            return Err(AppError::BadRequest(format!(
                "kind must be one of {}; got {k:?}",
                KINDS.join(", ")
            )));
        }
    }
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    // Read the cursor BEFORE the rows: a change landing in between is then
    // returned again on the next poll rather than skipped.
    let current = db::asks::current_rev(&state.pool).await?;
    let rows = db::asks::list(
        &state.pool,
        &db::asks::Filter {
            state: st,
            session: q.session.clone(),
            kind: q.kind.clone(),
            since: q.since,
            limit,
        },
    )
    .await?;
    let more = rows.len() as i64 == limit;
    let rev = match (q.since, more) {
        (Some(_), true) => rows.last().map(|r| r.rev).unwrap_or(current),
        _ => current,
    };
    let asks: Vec<AskView> = rows.iter().map(|r| view_live(&state, r)).collect();
    Ok(Json(
        json!({ "ok": true, "data": { "asks": asks, "rev": rev, "more": more } }),
    ))
}

async fn get_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = db::asks::get(&state.pool, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("ask '{id}'")))?;
    Ok(Json(json!({ "ok": true, "data": view_live(&state, &row) })))
}

#[derive(Debug, Default, Deserialize)]
struct AnswerRequest {
    #[serde(flatten)]
    body: answer::AnswerBody,
    /// Free-form label of the answering client (`phone`, `voice`…), recorded
    /// on the resolution.
    #[serde(default)]
    client: Option<String>,
}

async fn answer_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<String>,
    Json(req): Json<AnswerRequest>,
) -> Result<Json<Value>, AppError> {
    let actor = actor_of(ctx.0.as_ref());
    let row = answer_ask(
        &state,
        &id,
        &req.body,
        &actor,
        client_label(req.client.as_deref()),
    )
    .await?;
    Ok(Json(json!({ "ok": true, "data": view(&row) })))
}

#[derive(Debug, Default, Deserialize)]
struct DismissRequest {
    #[serde(default)]
    client: Option<String>,
}

async fn dismiss_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<String>,
    body: Option<Json<DismissRequest>>,
) -> Result<Json<Value>, AppError> {
    let actor = actor_of(ctx.0.as_ref());
    let client = body.and_then(|b| client_label(b.0.client.as_deref()));
    let row = dismiss_ask(&state, &id, &actor, client).await?;
    Ok(Json(json!({ "ok": true, "data": view(&row) })))
}

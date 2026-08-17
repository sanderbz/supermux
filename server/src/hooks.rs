//! Claude `SettingsHook` ingestion endpoint.
//!
//! `POST /api/_internal/hook` is the inbound side of the status detector's apex
//! signal: Claude Code runs supermux's `curl` hook (installed by
//! [`crate::claude_config`]) on every tool call / notification / turn end, and it
//! lands here. A valid event is recorded into [`AppState::record_hook`] and the
//! session's detector loop is woken so the status update surfaces well within the
//! "1s" bound.
//!
//! **Auth model — per-session, NOT the dashboard bearer.** This route is
//! mounted OUTSIDE the bearer-token layer because the hook command never carries
//! the dashboard bearer (it must not be in the session env). Instead each request
//! presents `X-Supermux-Hook-Token`, validated by a **constant-time** compare against
//! `session_runtime.hook_token WHERE name = body.session`. Consequences:
//!   * A leaked dashboard bearer cannot drive this endpoint (it isn't checked).
//!   * A leaked hook token of session A cannot mark session B — B's row holds a
//!     different token, so the compare fails → 401 (regression: `hook_auth_scope`).

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use axum::body::Bytes;

use crate::db;
use crate::notify::{self, NotifEvent};
use crate::error::AppError;
use crate::sessions::activity::{self, HookPayload};
use crate::sessions::elicitation;
use crate::sessions::status::{HookEvent, Status};
use crate::state::{AppState, SseEvent};

/// Header the hook command sets to its per-session `$SUPERMUX_HOOK_TOKEN`.
const HOOK_TOKEN_HEADER: &str = "X-Supermux-Hook-Token";

/// The hook sub-router. Merged at the top level of `http::router` (NO bearer
/// layer — auth is the per-session hook token, validated in [`hook_handler`]).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/_internal/hook", post(hook_handler))
        // The OPT-IN statusline tap's inbound side (fase A2 Task 6). Same
        // per-session hook-token auth, same reason: the statusline command runs
        // inside the pane and must never hold the dashboard bearer.
        .route(
            "/api/_internal/statusline",
            post(crate::sessions::chat::statusline::ingest_handler),
        )
        .with_state(state)
}

/// Validate a per-session `X-Supermux-Hook-Token` against the DB (the source of
/// truth, so it survives a restart) in CONSTANT TIME.
///
/// Shared by every pane-side endpoint on this router. The scope rule is the
/// point: session A's token authenticates ONLY session A, because B's row holds
/// a different secret (regression: `hook_auth_scope`). A missing session row is
/// a 401, not a 404 — no existence oracle.
pub(crate) async fn verify_hook_token(
    state: &AppState,
    session: &str,
    headers: &HeaderMap,
) -> Result<(), AppError> {
    let expected = db::sessions::runtime(&state.pool, session)
        .await?
        .map(|rt| rt.hook_token)
        .ok_or(AppError::Unauthorized)?;
    let presented = headers
        .get(HOOK_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // An empty stored token (session never started → no secret minted) can never
    // be authenticated.
    if expected.is_empty()
        || !constant_time_eq::constant_time_eq(expected.as_bytes(), presented.as_bytes())
    {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct HookBody {
    /// The supermux session name (`$SUPERMUX_SESSION`); scopes the token check.
    session: String,
    /// The Claude event kind, as installed by [`crate::claude_config`]:
    /// `user_prompt` | `pre_tool` | `post_tool` | `post_tool_failure` |
    /// `permission_request` | `notification` | `stop` | `subagent_start` |
    /// `subagent_stop` | `session_start` | `session_end` | `stop_failure`.
    /// An unrecognised kind is a 200 no-op, never a 400 (a future Claude event
    /// type must never trip a tool call).
    event: String,
    /// The forwarded Claude hook JSON: the event's STDIN payload,
    /// size-capped by the hook command. Parsed LENIENTLY into [`HookPayload`]
    /// (every field optional; a partial/truncated/odd payload is a no-op, never a
    /// 400). A cap that lands mid-token invalidates the enclosing body too;
    /// [`salvage_truncated_body`] recovers `session`+`event` and leaves this
    /// `None` rather than losing the whole event. Held in memory only — NEVER
    /// persisted (spec §SECURITY). Absent on a legacy hook command
    /// (pre-upgrade sessions) → treated as `{}`.
    #[serde(default)]
    payload: Option<Value>,
}

/// Ingest one hook event. 401 on any auth failure; 200 even for an unknown event
/// kind (a no-op) so a future Claude event type never trips a tool call.
///
/// The body is taken as raw [`Bytes`] and parsed manually rather than via the
/// `Json` extractor ON PURPOSE: the extractor 415s any request whose
/// `Content-Type` is not exactly `application/json`, and the hook is a `curl -d`
/// POST whose default content type is `application/x-www-form-urlencoded`. A 415
/// here is invisible (the hook `|| true`s it away) yet fatal — it kills the
/// entire turn state machine. The hook command now sends the correct header, but
/// parsing leniently makes the endpoint robust to any future client / proxy that
/// drops or rewrites it, so the detector's authoritative signal can never be
/// silently severed by a content-type mismatch again.
async fn hook_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Result<Json<Value>, AppError> {
    // Parse the JSON body ourselves (Content-Type agnostic). A malformed body is
    // a 400 — a genuine client bug, distinct from the silent 415 we are avoiding.
    //
    // …except for the ONE malformed body we produce ourselves: the hook command
    // splices Claude's STDIN in raw after capping it (`head -c 16384`), so an
    // oversized payload is cut mid-token and takes the whole envelope down with
    // it. That is not a client bug and must not cost us the event — see
    // [`salvage_truncated_body`].
    let body: HookBody = match serde_json::from_slice::<HookBody>(&raw) {
        Ok(b) => b,
        Err(e) => match salvage_truncated_body(&raw) {
            Some(b) => {
                tracing::debug!(
                    session = %b.session,
                    event = %b.event,
                    bytes = raw.len(),
                    "hook payload was truncated mid-token; salvaged the envelope, dropping the payload"
                );
                b
            }
            None => return Err(AppError::BadRequest(format!("hook body: {e}"))),
        },
    };
    // Per-session token, constant-time compared against the DB row (no timing
    // oracle, no cross-session authority). A missing session row → 401 (no
    // existence oracle); an empty stored token can never authenticate.
    verify_hook_token(&state, &body.session, &headers).await?;

    // Authenticated. The session's Claude hooks are demonstrably LIVE (this POST
    // reached us), so flag it: the detector now treats the turn state machine +
    // content bank as authoritative and suppresses the raw PTY-heartbeat `Active`
    // fallback for this session — typing at the prompt echoes bytes but must not
    // read as "the agent is working". This fires on EVERY event kind (incl.
    // `SessionStart`, which lands in the boot window before the first prompt), so
    // the flag is set well before the user can type.
    state.mark_hooks_live(&body.session);

    // Fold the turn-state signal in for the events the detector
    // cares about (Notification→Waiting, turn-start→Active, …). Unknown
    // event kinds (e.g. SessionStart/SessionEnd/StopFailure) have NO HookEvent
    // variant and are skipped here — they are handled by the activity/lifecycle
    // dispatch below, NOT by the turn state machine.
    if let Some(event) = HookEvent::from_event_str(&body.event) {
        state.record_hook(&body.session, event);
    }

    // ── live activity + error + lifecycle from the PAYLOAD ──────────
    // Parse leniently (every field optional); a missing/odd/truncated payload
    // parses to the empty default and is a no-op rather than a 400.
    //
    // The raw `Value` is kept beside the typed parse (deserialized BY REFERENCE,
    // so nothing is cloned): the `Elicitation` payload's `requested_schema` is
    // an arbitrary JSON Schema, which `elicitation::parse` reads structurally
    // rather than through a fixed struct.
    let raw_payload = body.payload.unwrap_or(Value::Null);
    apply_payload(&state, &body.session, &body.event, &raw_payload);

    if is_pointer_event(&body.event) {
        let id = raw_payload
            .get("session_id")
            .or_else(|| raw_payload.get("sessionId"))
            .and_then(Value::as_str);
        track_conversation_pointer(&state, &body.session, id).await;
    }

    // Re-tick the detector now so the status (e.g. Notification → waiting,
    // SessionEnd → stopped) is broadcast within ~1s, not at the next tier edge.
    state.wake_detector(&body.session);

    Ok(Json(json!({ "ok": true })))
}

/// The two events that reliably carry a MAIN-session conversation id:
/// `SessionStart` (a fresh Claude process) and `UserPromptSubmit` (the user
/// acting). Per-tool events are excluded on purpose — a subagent's hooks carry
/// the parent's token but their own ids, and would thrash the pointer.
fn is_pointer_event(event: &str) -> bool {
    matches!(
        event,
        "session_start" | "SessionStart" | "user_prompt" | "user_prompt_submit" | "UserPromptSubmit"
    )
}

/// Track the LIVE Claude conversation id so "this session" prompt-recall — and,
/// since the A2 chat data plane, the transcript tailer — read the CURRENT
/// transcript rather than a stale one.
///
/// Claude switches conversation files on a **restart**, on `/clear`, and on a
/// terminal-side `--resume`. (Compaction does NOT: a `compact_boundary` stays
/// inline in the same file with the same `sessionId` — re-verified on 2.1.231 —
/// which is exactly why the chat tailer's byte cursor survives it.) The
/// resume-only `set_cc_conversation_id` never followed those switches, so a
/// long-lived session's `cc_conversation_id` drifted days behind the real
/// conversation — the stale-recall bug.
///
/// The DB write is conditional, and only a REAL change wakes the chat tailer:
/// waking on every hook would re-scan the project dir on every prompt.
///
/// The id is charset-checked against the SAME rule the HTTP resume boundary
/// enforces ([`crate::sessions::valid_cc_id`]). It is not decoration: this
/// column is interpolated into `claude --resume '<id>'` (`lifecycle.rs`) and,
/// since A2, resolved into filesystem paths — `<project>/<id>.jsonl` and
/// `<project>/<id>/subagents/` — by the chat tailer, the chat WS seed and
/// fetch-full. The hook body is free-form JSON from inside the pane, so
/// without this check anything holding `$SUPERMUX_HOOK_TOKEN` could point a
/// session at `../../../somewhere/private` and have the dashboard stream it
/// back. A refused id leaves the previous pointer in place.
async fn track_conversation_pointer(state: &AppState, session: &str, id: Option<&str>) {
    let Some(id) = id.filter(|i| !i.is_empty()) else {
        return;
    };
    if !crate::sessions::valid_cc_id(id) {
        tracing::debug!(
            session = %session,
            "hook carried a conversation id outside the Claude id charset; pointer left alone"
        );
        return;
    }
    if db::sessions::track_cc_conversation_id(&state.pool, session, id)
        .await
        .unwrap_or(false)
    {
        // The pointer MOVED. Re-resolve now: without this the chat tailer would
        // keep reading the previous conversation until its cold-pointer backstop
        // noticed, and could then only report `Reconnecting` — it never adopts a
        // file it merely noticed, and this hook-carried id is the one
        // authoritative adoption signal.
        state.wake_chat_pointer(session);
    }
}

/// Recover `session` + `event` from a body whose `payload` was truncated
/// mid-token, dropping the unusable payload.
///
/// The hook command builds `{"session":…,"event":…,"payload":$D}` where `$D`
/// is Claude's STDIN capped at 16 KB (`head -c 16384`). A Write/Edit of a
/// large file blows straight past that, so `$D` ends mid-string and the WHOLE
/// body becomes invalid JSON — not just the payload. Before this salvage that
/// meant a 400 before any dispatch: `mark_hooks_live`, `record_hook` and
/// `apply_payload` never ran, so the turn state machine missed the tool
/// boundary (sticky activity label, a permission row left on screen after the
/// tool had long finished) on exactly the biggest tool calls.
///
/// The cap only ever cuts the TAIL, and `payload` is the last field, so the
/// prefix `{"session":…,"event":…` is always intact: re-close it and parse.
/// `payload` then defaults to `None`, which the handler already treats as `{}`
/// — the "a clipped payload is a no-op, never a 400" contract this module
/// documents. Returns `None` for a body that is malformed for any other
/// reason, which stays a 400.
fn salvage_truncated_body(raw: &[u8]) -> Option<HookBody> {
    const PAYLOAD_KEY: &[u8] = b",\"payload\":";
    let mut from = 0usize;
    // A session name could itself contain the literal `,"payload":`, so try
    // every occurrence and keep the first that yields a parseable envelope.
    while from < raw.len() {
        let rel = raw[from..]
            .windows(PAYLOAD_KEY.len())
            .position(|w| w == PAYLOAD_KEY)?;
        let cut = from + rel;
        let mut candidate = Vec::with_capacity(cut + 1);
        candidate.extend_from_slice(&raw[..cut]);
        candidate.push(b'}');
        if let Ok(body) = serde_json::from_slice::<HookBody>(&candidate) {
            return Some(body);
        }
        from = cut + 1;
    }
    None
}

/// Derive + store the in-memory activity/error/lifecycle effects of one hook
/// event's PAYLOAD, broadcasting a `sessions` SSE delta only
/// when the activity/error actually changed (change-only). Pure
/// dispatch on the wire `event` token (accepts both the snake_case form supermux
/// emits and Claude's PascalCase). NOTHING here is persisted to disk/DB.
fn apply_payload(state: &AppState, session: &str, event: &str, raw: &Value) {
    // The typed view of the same bytes, deserialized BY REFERENCE so nothing is
    // cloned. Both are needed: every arm but the elicitation pair reads named
    // fields, and `requested_schema` is an arbitrary JSON Schema that no fixed
    // struct can hold.
    let payload = &HookPayload::deserialize(raw).unwrap_or_default();
    let changed = match event {
        // A tool call started → set the live activity label (`✎ tile.tsx`, …).
        // A payload with no tool name yields no label → leave activity as-is.
        "pre_tool" | "pre_tool_use" | "PreToolUse" => {
            // TRIGGER 1 (B5/T1.5) — `AskUserQuestion` is the agent ASKING, not a
            // tool call to watch, and the pre-tool arm is where the question
            // TEXT arrives. Raising it here is what lets the banner carry the
            // agent's own sentence instead of "needs permission —
            // AskUserQuestion".
            //
            // Lenient about the shape: a payload that does not carry a question
            // still raises the event, and `notify::compose` falls back to its
            // declared generic sentence. That names what happened without
            // inventing content — and it is the ONLY push for this tool call,
            // because the `PermissionRequest` Claude raises ~20 ms later
            // deliberately does not push (see that arm).
            if payload.tool_name.as_deref() == Some("AskUserQuestion") {
                let q = activity::first_question(payload).unwrap_or_default();
                notify::notify_event(state, session, NotifEvent::Question(q));
            }
            match activity::activity_label(payload) {
                Some((label, kind)) => state.set_activity(session, label, kind),
                None => false,
            }
        }
        // A tool FAILED → transient `✗ {tool} failed`. Claude DOES have a
        // dedicated `PostToolUseFailure` event (live-verified on 2.1.227 +
        // 2.1.231; its payload adds `tool_use_id`, a top-level `error` string,
        // `is_interrupt` and `duration_ms` — all of which the lenient parse
        // either uses or ignores), and supermux installs it. We ALSO keep
        // treating a `post_tool` whose payload carries an error as a failure:
        // it is the fallback for sessions whose settings.json predates the new
        // entry. Either way the tool call is over, so any pending permission
        // dialog for it is resolved.
        "post_tool_failure" | "PostToolUseFailure" => {
            let cleared = state.clear_permission_request(session) | state.clear_elicitation(session);
            let set = state.set_activity(session, activity::failed_label(payload), "failed".into());
            cleared || set
        }
        // A clean PostToolUse is a no-op for the activity label (it falls through
        // to the turn state machine for status, untouched here) — but it still
        // resolves a pending permission dialog.
        "post_tool" | "post_tool_use" | "PostToolUse" => {
            // …and any pending ELICITATION: the form is raised mid-tool-call, so
            // the tool having finished proves the form is gone even if the
            // `ElicitationResult` leg never arrived.
            let cleared = state.clear_permission_request(session) | state.clear_elicitation(session);
            let failed = if payload.error_type.is_some() || payload.error.is_some() {
                state.set_activity(session, activity::failed_label(payload), "failed".into())
            } else {
                false
            };
            cleared || failed
        }
        // Claude is DISPLAYING a permission dialog for this tool call and is
        // blocked on a human. Fires before any decision; no hook ever reports the
        // outcome, so this state is cleared by whatever happens next (see the
        // clears in the arms around here). A payload with no tool name has
        // nothing to show → no-op.
        "permission_request" | "PermissionRequest" => {
            match activity::permission_ask(payload) {
                Some(ask) => {
                    // Whether this dialog is one the pre-tool arm already
                    // announced with the agent's own words. Decided BEFORE the
                    // ask is moved into the state.
                    let pushes = notify::permission_raises_push(&ask.tool);
                    let changed = state.set_permission_request(session, ask);
                    // TRIGGER 2 (B5/T1.5) — needs-attention. Only on a CHANGE:
                    // Claude re-fires the identical dialog payload, and the ask
                    // comparison dedupes that for free, so the phone buzzes once
                    // per dialog rather than once per re-render.
                    if changed && pushes {
                        notify::notify_event(state, session, NotifEvent::PermissionAsked);
                    }
                    changed
                }
                None => false,
            }
        }
        // ── MCP elicitation ──────────────────────────────────────────────────
        // An MCP server has stopped mid-tool-call and is demanding a TYPED FORM
        // from the human (`elicitation/create`). Claude Code draws it as
        // `Claude Code needs your input` and waits; nothing about it reaches the
        // transcript, no other hook fires, and the turn simply stops — which is
        // why an MCP-using session used to park here forever wearing a green
        // Idle dot (`mcp.elicitation_form`).
        //
        // OBSERVE-ONLY, and the whole feature depends on it staying that way:
        // this hook's STDOUT is how a hook DECIDES the elicitation
        // (`hookSpecificOutput.action`), and exit code 2 declines it outright.
        // supermux's installed command is `-o /dev/null … || true`, pinned by
        // `claude_config`'s inertness tests — so it can watch the ask and can
        // never answer it on the user's behalf.
        "elicitation" | "Elicitation" => match elicitation::parse(raw) {
            Some(ask) => {
                // Named push, like the permission dialog's: the sentence a
                // phone shows has to carry WHO is asking, because the answer
                // turns on trusting a third party.
                let server = ask.server.clone();
                let changed = state.set_elicitation(session, ask);
                if changed {
                    notify::notify_event(state, session, NotifEvent::McpFormAsked { server });
                }
                changed
            }
            // An ask with no server name is refused rather than shown (see
            // `elicitation::parse`): an unattributed third-party prompt in this
            // app's own voice is the one thing this card must never be.
            None => false,
        },
        // The human answered in the terminal (or a hook did). The `Elicitation`
        // leg never reports an outcome, so THIS is the resolution signal — the
        // one dialog family where the outcome is actually observable.
        "elicitation_result" | "ElicitationResult" => state.clear_elicitation(session),
        // A Task sub-agent STARTED → bump the live outstanding count (the
        // display-only parallelism signal). Never touches the turn boundary.
        "subagent_start" | "SubagentStart" => state.inc_subagents(session),
        // The MAIN turn ended → clear the live activity (the error, if any,
        // persists until the next prompt/start) AND force-0 the subagent count
        // (the authoritative turn end; makes the finished-notification gate
        // fail-safe — a lost SubagentStop can't permanently suppress a finish).
        "stop" | "Stop" => {
            let act = state.clear_activity(session);
            let sub = state.reset_subagents(session);
            let perm = state.clear_permission_request(session) | state.clear_elicitation(session);
            // TRIGGER 3 (B5/T1.5) — unread. The MAIN `Stop` only: `SubagentStop`
            // has its own arm and structurally cannot reach this one, so a Task
            // subagent finishing can never be announced as "the turn is done".
            //
            // The permission clear happens FIRST (above), which is what makes
            // this push's replacement of a pending "needs you" banner causally
            // correct: by the time it lands, the dialog is provably resolved.
            notify::notify_event(state, session, NotifEvent::TurnFinished);
            act || sub || perm
        }
        // A Task sub-agent finished. It shares the parent session token and the
        // MAIN agent is still working, so do NOT wipe the main activity label or
        // end the turn (non-decisive, mirrors turn_end = Stop-only) — but DO
        // decrement the live outstanding count (saturating).
        "subagent_stop" | "SubagentStop" => state.dec_subagents(session),
        // A new prompt / a fresh session → the previous error is no longer
        // current (the user is acting again) → clear it, and reset the subagent
        // count for the new turn.
        "user_prompt" | "user_prompt_submit" | "UserPromptSubmit" => {
            let err = state.clear_error(session);
            let sub = state.reset_subagents(session);
            let perm = state.clear_permission_request(session) | state.clear_elicitation(session);
            err || sub || perm
        }
        // Session lifecycle ───────────────────────────────────────────────────
        // Start: clear a stale error AND any pending forced-stopped override so
        // the detector re-evaluates the freshly-(re)started session freely.
        "session_start" | "SessionStart" => {
            // A brand-new Claude process: clear the stale forced-stopped override
            // AND wipe the previous process's in-progress turn so the detector
            // doesn't pin the freshly-booted, idle session Active (the
            // restart-stuck-loading bug). reset_turn_state has no activity-delta
            // effect; wake_detector (in the handler) re-ticks the status.
            state.reset_turn_state(session);
            state.clear_forced_status(session);
            let err = state.clear_error(session);
            let perm = state.clear_permission_request(session) | state.clear_elicitation(session);
            err || perm
        }
        // End: clear activity AND force Stopped now (the capture classifier can't
        // infer a clean exit). The forced status is applied by the detector loop;
        // we ALSO push the stopped status straight through the DB + watch + SSE so
        // the tile flips immediately, mirroring lifecycle::stop's broadcast.
        "session_end" | "SessionEnd" => {
            // TRIGGER 4 (B5/T1.5) — error, and ONLY for a death the user did not
            // cause. `clear` / `logout` / `prompt_input_exit` / `exit` are the
            // human at the keyboard: `/clear`ing a conversation or typing
            // `/exit` must never ring their own phone. An absent reason is a
            // real death (a killed pane reports nothing).
            //
            // Raised BEFORE the activity clear so the crash body can still name
            // what the session was doing when it died.
            if crashed_reason(payload) {
                notify::notify_event(
                    state,
                    session,
                    NotifEvent::SessionCrashed {
                        reason: payload.reason.clone().unwrap_or_default(),
                    },
                );
            }
            let act_changed = state.clear_activity(session);
            let sub_changed = state.reset_subagents(session);
            let perm_changed =
                state.clear_permission_request(session) | state.clear_elicitation(session);
            // The turn is definitively over when the session ends — drop it so a
            // later restart can't inherit it (belt-and-suspenders with the
            // SessionStart reset above).
            state.reset_turn_state(session);
            force_stopped(state, session);
            act_changed || sub_changed || perm_changed
        }
        // A turn failed with an agent error → record `{type, message}` for the
        // error badge (also clear the now-irrelevant activity).
        "stop_failure" | "StopFailure" => {
            let (etype, msg) = activity::error_info(payload);
            let cleared = state.clear_activity(session);
            // TRIGGER 5 (B5/T1.5) — error. Raised with the agent's own error
            // text, before `set_error` moves it into the state.
            notify::notify_event(
                state,
                session,
                NotifEvent::TurnFailed { etype: etype.clone(), msg: msg.clone() },
            );
            let set = state.set_error(session, etype, msg);
            cleared || set
        }
        _ => false,
    };

    if changed {
        broadcast_activity_delta(state, session);
    }
}

/// Did this `SessionEnd` represent a death the user did NOT cause?
///
/// `clear` / `logout` / `prompt_input_exit` / `exit` are the human at the
/// keyboard — their own keystroke ringing their own phone is the single
/// most-hated false positive. Everything else (`other`, or no reason at all,
/// which is what a killed pane produces) is a real death.
fn crashed_reason(payload: &HookPayload) -> bool {
    match payload.reason.as_deref().map(str::trim) {
        None | Some("") => true,
        Some(r) => !matches!(
            r.to_ascii_lowercase().as_str(),
            "clear" | "logout" | "prompt_input_exit" | "exit"
        ),
    }
}

/// Force a session `Stopped` from a `SessionEnd` hook (lifecycle).
/// Sets the detector-loop override (so the next tick can't re-derive it back to
/// active) AND pushes the transition straight through the DB + status watch + SSE
/// `status` so connected tiles flip immediately — the exact triplet
/// `lifecycle::stop`/`start` use, so the wait-primitive + clients stay coherent.
fn force_stopped(state: &AppState, session: &str) {
    state.set_forced_status(session, Status::Stopped);
    // Best-effort DB writeback + broadcast on a detached task (the handler must
    // return fast, within the hook's `--max-time 1`). A failed write only delays
    // the flip to the next detector tick, which the forced override also covers.
    let state = state.clone();
    let session = session.to_string();
    tokio::spawn(async move {
        if let Err(e) =
            db::sessions::set_last_status(&state.pool, &session, Status::Stopped.as_str()).await
        {
            tracing::debug!(name = %session, error = %e, "SessionEnd: set_last_status failed");
        }
        let version = {
            let tx = state.status_watch_for(&session);
            let next = tx.borrow().1.wrapping_add(1);
            tx.send_replace((Status::Stopped.as_str().to_string(), next));
            next
        };
        let _ = state.sse_tx.send(SseEvent {
            event: "status".to_string(),
            payload: json!({
                "name": session,
                "status": Status::Stopped.as_str(),
                "version": version,
            }),
        });
        let _ = state.sse_tx.send(SseEvent {
            event: "sessions".to_string(),
            payload: json!({ "delta": [{ "name": session, "status": Status::Stopped.as_str() }] }),
        });
    });
}

/// Broadcast a `sessions` SSE delta carrying `name`'s current activity/error so
/// open overviews update the live line / error badge without a refetch.
/// Cheap; sent only when the snapshot changed (the caller gates
/// on that). A cleared field is sent as JSON `null` so the client drops it.
fn broadcast_activity_delta(state: &AppState, session: &str) {
    let act = state.session_activity(session).unwrap_or_default();
    let error = act.error.as_ref().map(|(t, m)| json!({ "type": t, "message": m }));
    let permission = act.permission.as_ref().map(|a| {
        json!({ "tool": a.tool, "summary": a.summary, "kind": a.kind, "mode": a.mode })
    });
    let _ = state.sse_tx.send(SseEvent {
        event: "sessions".to_string(),
        payload: json!({ "delta": [{
            "name": session,
            // `null` when absent so a client clears the prior value.
            "activity": act.activity,
            "activity_kind": act.activity_kind,
            "error": error,
            // The live permission dialog (`null` once it resolved — the client
            // must drop the card, so this is always present).
            "permission_request": permission,
            // The live MCP elicitation form, same rule: always present, `null`
            // the moment `ElicitationResult` (or anything after it) proves the
            // form is gone. Carried WHOLE because the card IS the form — it is
            // already capped by `sessions::elicitation`.
            "elicitation": act.elicitation,
            // Live outstanding-subagent count (display-only parallelism signal).
            // Always present so a drop back to 0 clears the client's clause.
            "subagents": act.subagents,
            // Server-clock ms stamp: the fase-A1 hook→UI latency anchor AND
            // the chat client's clock-skew source — every chat supersede
            // comparison runs in this clock domain (a0-findings §1 item 3).
            "activity_at": chrono::Utc::now().timestamp_millis(),
        }] }),
    });
}

#[cfg(test)]
mod tests {
    //! Endpoint PAYLOAD dispatch. Drives [`apply_payload`] —
    //! the same in-memory derivation the live `/api/_internal/hook` handler runs
    //! after auth — so the activity/error/lifecycle effects are pinned without a
    //! live HTTP request. A real `AppState` (with a temp DB) is used so the
    //! `SessionEnd` forced-stop writeback task has a pool.

    use super::*;
    use crate::config::Config;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-hook-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
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

    /// One hook payload, as the raw JSON `apply_payload` takes.
    fn p(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    #[tokio::test]
    async fn subagent_count_rides_the_sessions_delta() {
        // The live overview gets the outstanding-subagent count on the SAME
        // change-only `sessions` SSE delta that already carries the activity line
        // — no new event type. The broadcasts fire synchronously inside
        // apply_payload, so the channel holds them immediately.
        let (state, dir) = test_state().await;
        let s = "lead-3";
        let mut rx = state.sse_tx.subscribe();

        apply_payload(&state, s, "subagent_start", &p("{}"));
        apply_payload(&state, s, "subagent_start", &p("{}"));

        let mut last_count: Option<i64> = None;
        while let Ok(ev) = rx.try_recv() {
            if ev.event == "sessions" {
                if let Some(d) = ev
                    .payload
                    .get("delta")
                    .and_then(|d| d.as_array())
                    .and_then(|a| a.first())
                {
                    if d.get("name").and_then(|n| n.as_str()) == Some(s) {
                        last_count = d.get("subagents").and_then(|v| v.as_i64());
                    }
                }
            }
        }
        assert_eq!(last_count, Some(2), "the sessions delta must carry subagents: 2");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn pre_tool_sets_activity_and_stop_clears_it() {
        let (state, dir) = test_state().await;
        let s = "worker-1";

        apply_payload(
            &state,
            s,
            "pre_tool",
            &p(r#"{"tool_name":"Edit","tool_input":{"file_path":"src/tile.tsx"}}"#),
        );
        let act = state.session_activity(s).unwrap();
        assert_eq!(act.activity.as_deref(), Some("✎ tile.tsx"));
        assert_eq!(act.activity_kind.as_deref(), Some("edit"));

        // Stop clears the live activity; the snapshot prunes empty → None.
        apply_payload(&state, s, "stop", &p("{}"));
        assert!(state.session_activity(s).is_none(), "Stop clears activity");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn subagent_stop_does_not_clear_the_main_activity() {
        // A Task subagent finishing (SubagentStop, on the parent session token)
        // means the MAIN agent is still working — its live activity label must
        // survive. Only the main Stop clears it.
        let (state, dir) = test_state().await;
        let s = "lead-1";

        apply_payload(
            &state,
            s,
            "pre_tool",
            &p(r#"{"tool_name":"Task","tool_input":{"description":"review"}}"#),
        );
        assert!(state.session_activity(s).is_some(), "pre_tool set an activity");

        apply_payload(&state, s, "subagent_stop", &p("{}"));
        assert!(
            state.session_activity(s).is_some(),
            "SubagentStop must NOT clear the main session's activity"
        );

        // The real main Stop still clears it.
        apply_payload(&state, s, "stop", &p("{}"));
        assert!(state.session_activity(s).is_none(), "main Stop clears activity");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Read the live outstanding-subagent count (0 when there's no entry).
    fn subagents(state: &AppState, s: &str) -> u32 {
        state.session_activity(s).map(|a| a.subagents).unwrap_or(0)
    }

    #[tokio::test]
    async fn session_start_resets_a_stale_turn_state() {
        // A restarted session must NOT inherit the previous Claude process's
        // in-progress turn. The server keeps in-memory TurnState across a session
        // restart (it's only cleared on delete), and a turn left with
        // turn_start > turn_end (no clean Stop — e.g. the old process was killed,
        // or a dangling SubagentStop) makes the detector pin the freshly-booted,
        // idle session "active" until TURN_SAFETY (15 min). SessionStart (a new
        // process) must reset the turn machine so the detector classifies the new
        // session from scratch.
        use crate::sessions::status::{HookEvent, TurnState};
        let (state, dir) = test_state().await;
        let s = "restarted-1";

        // The previous process left a turn in progress (UserPromptSubmit/PreToolUse,
        // no Stop) → the detector would read this Active.
        state.record_hook(s, HookEvent::UserPromptSubmit);
        state.record_hook(s, HookEvent::PreToolUse);
        assert_ne!(
            state.turn_state(s),
            TurnState::default(),
            "precondition: a turn is in progress"
        );

        // The new process boots → SessionStart must wipe the stale turn.
        apply_payload(&state, s, "session_start", &p("{}"));
        assert_eq!(
            state.turn_state(s),
            TurnState::default(),
            "SessionStart must reset the stale turn state so the idle session isn't pinned active"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn subagent_start_stop_track_the_outstanding_count() {
        // Display-only parallelism signal: SubagentStart increments, SubagentStop
        // decrements (saturating), a new prompt resets, and the main Stop force-0s
        // (the authoritative turn end — bounds any drift to one turn).
        let (state, dir) = test_state().await;
        let s = "lead-2";

        apply_payload(&state, s, "subagent_start", &p("{}"));
        apply_payload(&state, s, "subagent_start", &p("{}"));
        apply_payload(&state, s, "subagent_start", &p("{}"));
        assert_eq!(subagents(&state, s), 3, "three subagents started");

        apply_payload(&state, s, "subagent_stop", &p("{}"));
        assert_eq!(subagents(&state, s), 2, "one finished → 2 outstanding");

        // Saturating: more stops than starts must clamp at 0, never underflow.
        apply_payload(&state, s, "subagent_stop", &p("{}"));
        apply_payload(&state, s, "subagent_stop", &p("{}"));
        apply_payload(&state, s, "subagent_stop", &p("{}"));
        assert_eq!(subagents(&state, s), 0, "saturating dec floors at 0");

        // A fresh turn resets the count.
        apply_payload(&state, s, "subagent_start", &p("{}"));
        apply_payload(&state, s, "subagent_start", &p("{}"));
        assert_eq!(subagents(&state, s), 2);
        apply_payload(&state, s, "user_prompt", &p("{}"));
        assert_eq!(subagents(&state, s), 0, "a new prompt resets the count");

        // The main Stop force-0s any stragglers (makes the notification gate
        // fail-safe: a lost SubagentStop can never permanently suppress a finish).
        apply_payload(&state, s, "subagent_start", &p("{}"));
        apply_payload(&state, s, "subagent_start", &p("{}"));
        assert_eq!(subagents(&state, s), 2);
        apply_payload(&state, s, "stop", &p("{}"));
        assert_eq!(subagents(&state, s), 0, "main Stop force-0s the count");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stop_failure_records_error_and_user_prompt_clears_it() {
        let (state, dir) = test_state().await;
        let s = "worker-1";

        apply_payload(
            &state,
            s,
            "stop_failure",
            &p(r#"{"error_type":"rate_limit","message":"quota exceeded"}"#),
        );
        let err = state.session_activity(s).unwrap().error.unwrap();
        assert_eq!(err.0, "rate_limit");
        assert_eq!(err.1, "quota exceeded");

        // The next UserPromptSubmit clears the (now-stale) error.
        apply_payload(&state, s, "user_prompt", &p("{}"));
        assert!(
            state.session_activity(s).and_then(|a| a.error).is_none(),
            "UserPromptSubmit clears the error"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn session_end_forces_stopped_and_clears_activity() {
        let (state, dir) = test_state().await;
        let s = "worker-1";

        // A live activity to be cleared by the end.
        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Bash","tool_input":{"command":"sleep 1"}}"#));
        assert!(state.session_activity(s).is_some());

        apply_payload(&state, s, "session_end", &p("{}"));
        // Activity cleared.
        assert!(
            state.session_activity(s).and_then(|a| a.activity).is_none(),
            "SessionEnd clears activity"
        );
        // A Stopped override is pending for the detector loop to apply.
        assert_eq!(state.take_forced_status(s), Some(Status::Stopped));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn session_start_clears_error_and_forced_status() {
        let (state, dir) = test_state().await;
        let s = "worker-1";

        // Seed an error + a pending forced-stop (as if from a prior end).
        state.set_error(s, "billing_error".into(), "card declined".into());
        state.set_forced_status(s, Status::Stopped);

        apply_payload(&state, s, "session_start", &p("{}"));
        assert!(
            state.session_activity(s).and_then(|a| a.error).is_none(),
            "SessionStart clears the error"
        );
        assert_eq!(state.take_forced_status(s), None, "SessionStart clears the forced stop");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn change_only_broadcast_is_suppressed_on_no_op() {
        let (state, dir) = test_state().await;
        let s = "worker-1";
        let mut rx = state.sse_tx.subscribe();

        // A clean PostToolUse (no error) is a no-op for activity → no broadcast.
        apply_payload(&state, s, "post_tool", &p(r#"{"tool_name":"Read"}"#));
        assert!(rx.try_recv().is_err(), "clean post_tool must not broadcast");

        // A PreToolUse with no tool name is also a no-op.
        apply_payload(&state, s, "pre_tool", &p("{}"));
        assert!(rx.try_recv().is_err(), "tool-less pre_tool must not broadcast");

        // A real activity change DOES broadcast a `sessions` delta.
        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Read","tool_input":{"file_path":"a.rs"}}"#));
        let ev = rx.try_recv().expect("activity change broadcasts");
        assert_eq!(ev.event, "sessions");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The two VERBATIM live captures (Claude Code 2.1.227, byte-identical on
    /// 2.1.231) the new events actually deliver.
    const LIVE_PERMISSION_REQUEST: &str = r#"{"session_id":"a2a3a5c5","permission_mode":"default","hook_event_name":"PermissionRequest","tool_name":"Read","tool_input":{"file_path":"/nonexistent-a0-probe.txt"},"permission_suggestions":[]}"#;
    const LIVE_POST_TOOL_FAILURE: &str = r#"{"session_id":"a2a3a5c5","permission_mode":"default","hook_event_name":"PostToolUseFailure","tool_name":"Read","tool_input":{"file_path":"/nonexistent-a0-probe.txt"},"tool_use_id":"toolu_01XvHoKvEax8CniDEibaznWN","error":"File does not exist.","is_interrupt":false,"duration_ms":34}"#;

    /// Drain the channel and return the LAST `sessions` delta object for `s`.
    fn last_delta(rx: &mut tokio::sync::broadcast::Receiver<SseEvent>, s: &str) -> Option<Value> {
        let mut last = None;
        while let Ok(ev) = rx.try_recv() {
            if ev.event != "sessions" {
                continue;
            }
            if let Some(d) = ev.payload.get("delta").and_then(|d| d.as_array()).and_then(|a| a.first())
            {
                if d.get("name").and_then(|n| n.as_str()) == Some(s) {
                    last = Some(d.clone());
                }
            }
        }
        last
    }

    #[tokio::test]
    async fn permission_request_sets_live_state_and_rides_the_sessions_delta() {
        let (state, dir) = test_state().await;
        let s = "worker-perm";
        let mut rx = state.sse_tx.subscribe();

        apply_payload(&state, s, "permission_request", &p(LIVE_PERMISSION_REQUEST));

        let ask = state
            .session_activity(s)
            .and_then(|a| a.permission)
            .expect("the live permission-request state is set");
        assert_eq!(ask.tool, "Read");
        assert_eq!(ask.summary, "📖 nonexistent-a0-probe.txt");
        assert_eq!(ask.kind, "read");
        assert_eq!(ask.mode.as_deref(), Some("default"));

        // It rides the SAME change-only `sessions` delta the activity line does.
        let d = last_delta(&mut rx, s).expect("permission_request broadcasts a delta");
        assert_eq!(d["permission_request"]["tool"], json!("Read"));
        assert_eq!(d["permission_request"]["summary"], json!("📖 nonexistent-a0-probe.txt"));
        assert_eq!(d["permission_request"]["kind"], json!("read"));
        assert_eq!(d["permission_request"]["mode"], json!("default"));

        // Re-firing the identical dialog is not a change → no second broadcast.
        apply_payload(&state, s, "permission_request", &p(LIVE_PERMISSION_REQUEST));
        assert!(rx.try_recv().is_err(), "an unchanged ask must not re-broadcast");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn permission_request_is_cleared_by_post_tool_stop_and_next_prompt() {
        // The dialog's OUTCOME is never reported by a hook, so the ask is cleared
        // by the next event that can only happen after it resolved: the tool ran
        // (post_tool / post_tool_failure), the turn ended (Stop/SessionEnd), or
        // the user moved on (UserPromptSubmit / SessionStart).
        for (event, payload) in [
            ("post_tool", r#"{"tool_name":"Read"}"#),
            ("post_tool_failure", LIVE_POST_TOOL_FAILURE),
            ("stop", "{}"),
            ("session_end", "{}"),
            ("user_prompt", "{}"),
            ("session_start", "{}"),
        ] {
            let (state, dir) = test_state().await;
            let s = "worker-perm";
            apply_payload(&state, s, "permission_request", &p(LIVE_PERMISSION_REQUEST));
            assert!(
                state.session_activity(s).and_then(|a| a.permission).is_some(),
                "{event}: precondition — an ask is live"
            );

            let mut rx = state.sse_tx.subscribe();
            apply_payload(&state, s, event, &p(payload));
            assert!(
                state.session_activity(s).and_then(|a| a.permission).is_none(),
                "{event} must clear the live permission request"
            );
            // The clear is a change → the client is told (explicit null).
            let d = last_delta(&mut rx, s).unwrap_or_else(|| panic!("{event}: clear broadcasts"));
            assert_eq!(d["permission_request"], Value::Null, "{event}: cleared as null");

            state.pool.close().await;
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// A live `Elicitation` payload's exact documented shape (cc 2.1.227:
    /// "Input to command is JSON with mcp_server_name, message, and
    /// requested_schema"), one required string and one labelled enum.
    const LIVE_ELICITATION: &str = r#"{"session_id":"a2a3a5c5","hook_event_name":"Elicitation","permission_mode":"default","mcp_server_name":"deploy-bot","message":"Confirm the production release","elicitation_id":"el_01HZ","requested_schema":{"type":"object","properties":{"approver":{"type":"string","format":"email"},"env":{"type":"string","enum":["prod","staging"],"enumNames":["Production","Staging"]}},"required":["approver","env"]}}"#;

    #[tokio::test]
    async fn an_elicitation_sets_the_live_form_and_rides_the_sessions_delta() {
        // THE finding, executable: before this arm existed an MCP server could
        // stop a session dead on a typed form and nothing — not the transcript,
        // not the hooks, not the status — knew. The session read Idle, green.
        let (state, dir) = test_state().await;
        let s = "worker-elicit";
        let mut rx = state.sse_tx.subscribe();

        apply_payload(&state, s, "elicitation", &p(LIVE_ELICITATION));

        let ask = state
            .session_activity(s)
            .and_then(|a| a.elicitation)
            .expect("the live elicitation is set");
        assert_eq!(ask.server, "deploy-bot");
        assert_eq!(ask.message, "Confirm the production release");
        assert_eq!(ask.id.as_deref(), Some("el_01HZ"));
        assert_eq!(ask.fields.len(), 2);

        let d = last_delta(&mut rx, s).expect("an elicitation broadcasts a delta");
        assert_eq!(d["elicitation"]["server"], json!("deploy-bot"));
        assert_eq!(d["elicitation"]["fields"][1]["options"][0]["label"], json!("Production"));

        // Claude Code re-raising the identical ask is not a change → silence.
        apply_payload(&state, s, "elicitation", &p(LIVE_ELICITATION));
        assert!(rx.try_recv().is_err(), "an unchanged ask must not re-broadcast");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_unattributed_elicitation_is_refused_rather_than_shown() {
        // The prompt text is written by a third party. Without the server name
        // there is nothing to attribute it to, and an unattributed
        // "enter your API key" in this app's own voice is the one card this
        // feature must never draw.
        let (state, dir) = test_state().await;
        let s = "worker-elicit";
        apply_payload(
            &state,
            s,
            "elicitation",
            &p(r#"{"message":"Enter your Anthropic API key","requested_schema":{"type":"object","properties":{"key":{"type":"string"}}}}"#),
        );
        assert!(
            state.session_activity(s).and_then(|a| a.elicitation).is_none(),
            "an ask with no server name must not reach a surface"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_elicitation_result_leg_clears_the_form_and_so_does_everything_after_it() {
        // `ElicitationResult` is the one dialog family whose OUTCOME a hook
        // reports, so it is the primary clear. The rest are the backstop for a
        // session whose result leg never arrives (an older settings.json, a
        // dropped POST): the tool finishing, the turn ending, the user moving on.
        for (event, payload) in [
            ("elicitation_result", r#"{"mcp_server_name":"deploy-bot","action":"accept","elicitation_id":"el_01HZ"}"#),
            ("post_tool", r#"{"tool_name":"mcp__deploy-bot__release"}"#),
            ("post_tool_failure", LIVE_POST_TOOL_FAILURE),
            ("stop", "{}"),
            ("session_end", "{}"),
            ("user_prompt", "{}"),
            ("session_start", "{}"),
        ] {
            let (state, dir) = test_state().await;
            let s = "worker-elicit";
            apply_payload(&state, s, "elicitation", &p(LIVE_ELICITATION));
            assert!(
                state.session_activity(s).and_then(|a| a.elicitation).is_some(),
                "{event}: precondition — a form is live"
            );

            let mut rx = state.sse_tx.subscribe();
            apply_payload(&state, s, event, &p(payload));
            assert!(
                state.session_activity(s).and_then(|a| a.elicitation).is_none(),
                "{event} must clear the live elicitation"
            );
            let d = last_delta(&mut rx, s).unwrap_or_else(|| panic!("{event}: clear broadcasts"));
            assert_eq!(d["elicitation"], Value::Null, "{event}: cleared as null");

            state.pool.close().await;
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[tokio::test]
    async fn an_elicitation_survives_a_pre_tool_and_a_subagent_stop() {
        // The form is raised in the MIDDLE of an MCP tool call: more tool calls
        // and subagent traffic can happen around it, and none of them says the
        // human answered.
        let (state, dir) = test_state().await;
        let s = "worker-elicit";
        apply_payload(&state, s, "elicitation", &p(LIVE_ELICITATION));
        apply_payload(&state, s, "subagent_stop", &p("{}"));
        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Read","tool_input":{"file_path":"a.rs"}}"#));
        assert!(
            state.session_activity(s).and_then(|a| a.elicitation).is_some(),
            "nothing here proves the form was answered"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn permission_request_survives_a_pre_tool_and_a_subagent_stop() {
        // PreToolUse fires BEFORE the permission check, and a subagent finishing
        // says nothing about the main agent's dialog — neither may clear the ask.
        let (state, dir) = test_state().await;
        let s = "worker-perm";
        apply_payload(&state, s, "permission_request", &p(LIVE_PERMISSION_REQUEST));
        apply_payload(&state, s, "subagent_stop", &p("{}"));
        assert!(state.session_activity(s).and_then(|a| a.permission).is_some());
        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Read","tool_input":{"file_path":"a.rs"}}"#));
        assert!(
            state.session_activity(s).and_then(|a| a.permission).is_some(),
            "PreToolUse precedes the dialog; it must not clear the ask"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn dedicated_post_tool_failure_event_sets_the_failed_label() {
        // The real event (not the `error`-carrying-PostToolUse heuristic), with
        // the verbatim live payload: `tool_use_id`/`is_interrupt`/`duration_ms`
        // are extras the lenient parse ignores; the label comes off `tool_name`.
        let (state, dir) = test_state().await;
        let s = "worker-fail";

        apply_payload(&state, s, "post_tool_failure", &p(LIVE_POST_TOOL_FAILURE));
        let act = state.session_activity(s).unwrap();
        assert_eq!(act.activity.as_deref(), Some("✗ Read failed"));
        assert_eq!(act.activity_kind.as_deref(), Some("failed"));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn post_tool_with_error_sets_failed_label() {
        let (state, dir) = test_state().await;
        let s = "worker-1";

        apply_payload(
            &state,
            s,
            "post_tool",
            &p(r#"{"tool_name":"Bash","error_type":"non_zero_exit"}"#),
        );
        let act = state.session_activity(s).unwrap();
        assert_eq!(act.activity.as_deref(), Some("✗ Bash failed"));
        assert_eq!(act.activity_kind.as_deref(), Some("failed"));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn activity_delta_carries_the_server_clock_stamp() {
        let (state, dir) = test_state().await;
        let s = "worker-at";
        let mut rx = state.sse_tx.subscribe();

        apply_payload(
            &state,
            s,
            "pre_tool",
            &p(r#"{"tool_name":"Bash","tool_input":{"command":"ls"}}"#),
        );
        let ev = rx.try_recv().expect("activity broadcasts");
        assert_eq!(ev.event, "sessions");
        let d = ev.payload["delta"][0].clone();
        let at = d["activity_at"].as_i64().expect("activity_at present");
        let now = chrono::Utc::now().timestamp_millis();
        assert!((now - at).abs() < 5_000, "server-clock ms stamp, fresh");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── the chat tailer's pointer-change notification ────────────────────────

    /// Did the chat-pointer wake fire? `notify_one` parks a permit, so a wake
    /// that happened before we waited still resolves immediately.
    async fn woke(state: &AppState, session: &str) -> bool {
        let n = state.chat_pointer_wake_for(session);
        tokio::time::timeout(std::time::Duration::from_millis(50), n.notified())
            .await
            .is_ok()
    }

    #[tokio::test]
    async fn a_changed_conversation_pointer_wakes_the_chat_tailer() {
        let (state, dir) = test_state().await;
        let s = "ptr-1";
        db::sessions::insert_minimal(&state.pool, s, "/tmp", "claude").await.unwrap();

        track_conversation_pointer(&state, s, Some("conv-a")).await;
        assert!(woke(&state, s).await, "the first id is a change — the tailer must re-resolve");
        let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
        assert_eq!(row.cc_conversation_id, "conv-a");

        // A terminal-side `--resume` / `/clear`: the id MOVED.
        track_conversation_pointer(&state, s, Some("conv-b")).await;
        assert!(woke(&state, s).await, "a moved pointer must wake the tailer");
        let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
        assert_eq!(row.cc_conversation_id, "conv-b");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_unchanged_pointer_never_wakes_the_tailer() {
        // Every prompt in a long session re-reports the SAME id; waking on those
        // would re-scan the project dir on every turn.
        let (state, dir) = test_state().await;
        let s = "ptr-2";
        db::sessions::insert_minimal(&state.pool, s, "/tmp", "claude").await.unwrap();

        track_conversation_pointer(&state, s, Some("conv-a")).await;
        assert!(woke(&state, s).await);
        for _ in 0..3 {
            track_conversation_pointer(&state, s, Some("conv-a")).await;
        }
        assert!(!woke(&state, s).await, "an unchanged id must not wake the tailer");

        // A missing / empty id is a no-op, not a pointer reset.
        track_conversation_pointer(&state, s, None).await;
        track_conversation_pointer(&state, s, Some("")).await;
        assert!(!woke(&state, s).await);
        let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
        assert_eq!(row.cc_conversation_id, "conv-a", "the pointer must survive");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_hook_carried_pointer_outside_the_id_charset_is_refused() {
        // The hook body is free-form JSON produced INSIDE the pane, and this
        // column becomes both a `claude --resume '<id>'` argument and — since
        // A2 — a filesystem path (`<project>/<id>.jsonl`,
        // `<project>/<id>/subagents/`) read by the tailer, the chat WS seed and
        // fetch-full. Anything holding $SUPERMUX_HOOK_TOKEN could otherwise
        // point a session at an arbitrary file and have it streamed back.
        let (state, dir) = test_state().await;
        let s = "ptr-3";
        db::sessions::insert_minimal(&state.pool, s, "/tmp", "claude").await.unwrap();
        track_conversation_pointer(&state, s, Some("conv-a")).await;
        assert!(woke(&state, s).await);

        for bad in [
            "../../../../home/u/notes/private",
            "..",
            "a/b",
            "conv'; rm -rf /",
            "conv a",
            "conv$(id)",
            &"x".repeat(129),
        ] {
            track_conversation_pointer(&state, s, Some(bad)).await;
            let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
            assert_eq!(
                row.cc_conversation_id, "conv-a",
                "{bad:?} must never become the tracked pointer"
            );
            assert!(!woke(&state, s).await, "{bad:?} must not wake the tailer either");
        }

        // …and the real shapes still land.
        track_conversation_pointer(&state, s, Some("550e8400-e29b-41d4-a716-446655440000")).await;
        let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
        assert_eq!(row.cc_conversation_id, "550e8400-e29b-41d4-a716-446655440000");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_session_start_and_user_prompt_move_the_pointer() {
        for e in ["session_start", "SessionStart", "user_prompt", "user_prompt_submit",
                  "UserPromptSubmit"] {
            assert!(is_pointer_event(e), "{e} carries a main-session id");
        }
        for e in ["pre_tool", "PreToolUse", "post_tool", "PostToolUse", "subagent_start",
                  "SubagentStop", "Stop", "Notification", "session_end"] {
            assert!(!is_pointer_event(e),
                    "{e} must NOT move the pointer (subagent hooks would thrash it)");
        }
    }
}

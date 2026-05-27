//! Claude `SettingsHook` ingestion endpoint (TECH_PLAN §3.6, §6.5; M5b).
//!
//! `POST /api/_internal/hook` is the inbound side of the status detector's apex
//! signal: Claude Code runs supermux's `curl` hook (installed by
//! [`crate::claude_config`]) on every tool call / notification / turn end, and it
//! lands here. A valid event is recorded into [`AppState::record_hook`] and the
//! session's detector loop is woken so the status update surfaces well within the
//! §3.6 "1s" bound.
//!
//! **Auth model (§6.5) — per-session, NOT the dashboard bearer.** This route is
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
use crate::error::AppError;
use crate::sessions::activity::{self, HookPayload};
use crate::sessions::status::{HookEvent, Status};
use crate::state::{AppState, SseEvent};

/// Header the hook command sets to its per-session `$SUPERMUX_HOOK_TOKEN`.
const HOOK_TOKEN_HEADER: &str = "X-Supermux-Hook-Token";

/// The hook sub-router. Merged at the top level of `http::router` (NO bearer
/// layer — auth is the per-session hook token, validated in [`hook_handler`]).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/_internal/hook", post(hook_handler))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct HookBody {
    /// The supermux session name (`$SUPERMUX_SESSION`); scopes the token check.
    session: String,
    /// The Claude event kind (`pre_tool` | `post_tool` | `notification` | `stop`
    /// | `subagent_stop` | `session_start` | `session_end` | `stop_failure`).
    event: String,
    /// The forwarded Claude hook JSON (hooks-10x v2): the event's STDIN payload,
    /// size-capped by the hook command. Parsed LENIENTLY into [`HookPayload`]
    /// (every field optional; a partial/truncated/odd payload is a no-op, never a
    /// 400). Held in memory only — NEVER persisted (spec §SECURITY). Absent on a
    /// v1 hook command (pre-upgrade sessions) → treated as `{}`.
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
    let body: HookBody =
        serde_json::from_slice(&raw).map_err(|e| AppError::BadRequest(format!("hook body: {e}")))?;
    // The expected token is the session's own (DB is the source of truth, §6.5;
    // survives restart). A missing session row → 401 (no existence oracle).
    let expected = db::sessions::runtime(&state.pool, &body.session)
        .await?
        .map(|rt| rt.hook_token)
        .ok_or(AppError::Unauthorized)?;

    let presented = headers
        .get(HOOK_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // Empty stored token (session never started → no secret minted) can never be
    // authenticated; and the compare is constant-time (§6.5, no timing oracle).
    if expected.is_empty()
        || !constant_time_eq::constant_time_eq(expected.as_bytes(), presented.as_bytes())
    {
        return Err(AppError::Unauthorized);
    }

    // Authenticated. The session's Claude hooks are demonstrably LIVE (this POST
    // reached us), so flag it: the detector now treats the turn state machine +
    // content bank as authoritative and suppresses the raw PTY-heartbeat `Active`
    // fallback for this session — typing at the prompt echoes bytes but must not
    // read as "the agent is working". This fires on EVERY event kind (incl.
    // `SessionStart`, which lands in the boot window before the first prompt), so
    // the flag is set well before the user can type.
    state.mark_hooks_live(&body.session);

    // Fold the turn-state signal in for the events the detector
    // cares about (§3.6 — Notification→Waiting, turn-start→Active, …). Unknown
    // event kinds (e.g. SessionStart/SessionEnd/StopFailure) have NO HookEvent
    // variant and are skipped here — they are handled by the activity/lifecycle
    // dispatch below, NOT by the turn state machine.
    if let Some(event) = HookEvent::from_event_str(&body.event) {
        state.record_hook(&body.session, event);
    }

    // ── hooks-10x: live activity + error + lifecycle from the PAYLOAD ──────────
    // Parse leniently (every field optional); a missing/odd/truncated payload
    // parses to the empty default and is a no-op rather than a 400.
    let payload: HookPayload = body
        .payload
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    apply_payload(&state, &body.session, &body.event, &payload);

    // Re-tick the detector now so the status (e.g. Notification → waiting,
    // SessionEnd → stopped) is broadcast within ~1s, not at the next tier edge.
    state.wake_detector(&body.session);

    Ok(Json(json!({ "ok": true })))
}

/// Derive + store the in-memory activity/error/lifecycle effects of one hook
/// event's PAYLOAD (hooks-10x TRACK 1), broadcasting a `sessions` SSE delta only
/// when the activity/error actually changed (spec §4 — change-only). Pure
/// dispatch on the wire `event` token (accepts both the snake_case form supermux
/// emits and Claude's PascalCase). NOTHING here is persisted to disk/DB.
fn apply_payload(state: &AppState, session: &str, event: &str, payload: &HookPayload) {
    let changed = match event {
        // A tool call started → set the live activity label (`✎ tile.tsx`, …).
        // A payload with no tool name yields no label → leave activity as-is.
        "pre_tool" | "pre_tool_use" | "PreToolUse" => {
            match activity::activity_label(payload) {
                Some((label, kind)) => state.set_activity(session, label, kind),
                None => false,
            }
        }
        // A tool FAILED → transient `✗ {tool} failed`. Claude has no dedicated
        // PostToolUseFailure event, so we ALSO treat a `post_tool` whose payload
        // carries an error as a failure; a clean PostToolUse is a no-op (it falls
        // through to the turn state machine for status, untouched here).
        "post_tool_failure" | "PostToolUseFailure" => {
            state.set_activity(session, activity::failed_label(payload), "failed".into())
        }
        "post_tool" | "post_tool_use" | "PostToolUse"
            if payload.error_type.is_some() || payload.error.is_some() =>
        {
            state.set_activity(session, activity::failed_label(payload), "failed".into())
        }
        // The turn ended → clear the live activity (the error, if any, persists
        // until the next prompt/start).
        "stop" | "Stop" | "subagent_stop" | "SubagentStop" => state.clear_activity(session),
        // A new prompt / a fresh session → the previous error is no longer
        // current (the user is acting again) → clear it.
        "user_prompt" | "user_prompt_submit" | "UserPromptSubmit" => state.clear_error(session),
        // Session lifecycle ───────────────────────────────────────────────────
        // Start: clear a stale error AND any pending forced-stopped override so
        // the detector re-evaluates the freshly-(re)started session freely.
        "session_start" | "SessionStart" => {
            state.clear_forced_status(session);
            state.clear_error(session)
        }
        // End: clear activity AND force Stopped now (the capture classifier can't
        // infer a clean exit). The forced status is applied by the detector loop;
        // we ALSO push the stopped status straight through the DB + watch + SSE so
        // the tile flips immediately, mirroring lifecycle::stop's broadcast.
        "session_end" | "SessionEnd" => {
            let act_changed = state.clear_activity(session);
            force_stopped(state, session);
            act_changed
        }
        // A turn failed with an agent error → record `{type, message}` for the
        // error badge (also clear the now-irrelevant activity).
        "stop_failure" | "StopFailure" => {
            let (etype, msg) = activity::error_info(payload);
            let cleared = state.clear_activity(session);
            let set = state.set_error(session, etype, msg);
            cleared || set
        }
        _ => false,
    };

    if changed {
        broadcast_activity_delta(state, session);
    }
}

/// Force a session `Stopped` from a `SessionEnd` hook (hooks-10x lifecycle).
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
/// open overviews update the live line / error badge without a refetch
/// (hooks-10x §4). Cheap; sent only when the snapshot changed (the caller gates
/// on that). A cleared field is sent as JSON `null` so the client drops it.
fn broadcast_activity_delta(state: &AppState, session: &str) {
    let act = state.session_activity(session).unwrap_or_default();
    let error = act.error.as_ref().map(|(t, m)| json!({ "type": t, "message": m }));
    let _ = state.sse_tx.send(SseEvent {
        event: "sessions".to_string(),
        payload: json!({ "delta": [{
            "name": session,
            // `null` when absent so a client clears the prior value.
            "activity": act.activity,
            "activity_kind": act.activity_kind,
            "error": error,
        }] }),
    });
}

#[cfg(test)]
mod tests {
    //! Endpoint PAYLOAD dispatch (hooks-10x TRACK 1). Drives [`apply_payload`] —
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
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    fn p(json: &str) -> HookPayload {
        serde_json::from_str(json).unwrap()
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
}

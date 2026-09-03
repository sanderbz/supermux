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
use std::time::Instant;

use crate::db;
use crate::notify::{self, NotifEvent};
use crate::error::AppError;
use crate::sessions::activity::{self, HookPayload};
use crate::sessions::connect_ask;
use crate::sessions::elicitation;
use crate::sessions::status::{HookEvent, Status};
use crate::sessions::takeover_ask;
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
    /// The tmux pane the hook fired from (`$TMUX_PANE`, e.g. `"%17"`) — the
    /// WITHIN-session discriminator (S2, §R2.2).
    ///
    /// A session name is NOT enough on a team host: Claude Agent Teams spawns
    /// teammates as sibling panes and tmux applies the SESSION environment to
    /// every pane, so a teammate's hook carries the LEAD's `$SUPERMUX_SESSION`
    /// and `$SUPERMUX_HOOK_TOKEN` with the TEAMMATE's own conversation id
    /// (measured live — `~/team-gap/PHASE0-PROBE.md`). `$TMUX_PANE` is the only
    /// field that separates them, and tmux gives it to us for free.
    ///
    /// `#[serde(default)]` → empty string, for the two cases that legitimately
    /// have no pane: a session whose `settings.json` still holds the previous
    /// hook command (self-heals at the next session start, since `install_hooks`
    /// runs per start and the MARKER replaces the entry in place), and a
    /// non-tmux (native) session, which has no panes at all.
    #[serde(default)]
    pane: String,
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
        // An `idle_prompt` notification is Claude Code's POST-TURN idle ping
        // ("Claude is waiting for your input"), fired while the session sits at its
        // empty `❯` prompt — NOT a needs-you signal (only `permission_prompt` /
        // `agent_needs_input` are; the activity dispatch below keeps that
        // distinction for `waiting_message`). Folding it into the turn machine as a
        // generic Notification lets it read `Waiting` — the roster's red "needs
        // you" — whenever the turn's own `Stop` hook was missed/raced (hooks run
        // `--max-time 1`), so `turn_end` never advanced past `turn_start` and
        // `TurnState::classify`'s `turn_already_ended` guard cannot fire. Record it
        // as a turn END instead: an idle_prompt PROVES the turn is over, so the
        // machine settles straight to Idle without ever passing through Active
        // (unlike merely dropping it). `record_hook` only folds into `TurnState`
        // — no notification, DB write or SSE — so the remap has no collateral.
        let event = if matches!(event, HookEvent::Notification)
            && body
                .payload
                .as_ref()
                .and_then(|p| p.get("notification_type").or_else(|| p.get("notificationType")))
                .and_then(Value::as_str)
                == Some("idle_prompt")
        {
            HookEvent::Stop
        } else {
            event
        };
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

    // Is this POST the LEAD's own event, or one fired by an in-process teammate
    // running under the same pane token? Decided ONCE per POST (the predicate is
    // read twice below).
    //
    // Gated on the EVENT as well as on `agent_type`, and both halves matter.
    // `foreign_agent` is consumed in exactly three places — the lifecycle gate
    // and the `user_prompt` arm inside `apply_payload`, and the pointer gate
    // below — all of which are `is_lifecycle_event` or `is_pointer_event`. The
    // `agent_type` half alone would NOT keep this off the hot path: since the
    // per-agent rows landed, every child tool hook (`pre_tool`, `post_tool`,
    // `subagent_*`) carries an `agent_type` beside its `agent_id` — that is what
    // `touch_agent_row` reads — so a subagent-heavy turn would pay an extra
    // indexed SELECT per tool call on a `--max-time 1` request, for a value
    // those events can never consume.
    let foreign_agent = if (is_lifecycle_event(&body.event) || is_pointer_event(&body.event))
        && has_agent_type(&raw_payload)
    {
        let tracked = db::sessions::cc_conversation_id(&state.pool, &body.session)
            .await
            .ok()
            .flatten();
        is_foreign_agent_payload(&raw_payload, tracked.as_deref())
    } else {
        false
    };

    apply_payload(&state, &body.session, &body.event, &raw_payload, foreign_agent);

    // A live agent file-write becomes a `files` SSE frame, so a file a bot
    // wrote seconds ago appears in the Files surface without a reload. Only the
    // qualifying subset of PostToolUse pays the extra indexed SELECT (every hook
    // already pays one for `verify_hook_token`).
    //
    // Stays AFTER `apply_payload`, as on main: a file-writing PostToolUse must
    // publish its `sessions` activity delta before the `files` frame, or a
    // client sees the file appear on a session that still looks idle.
    emit_agent_file_write(&state, &body.session, &body.event, &raw_payload).await;

    // NEVER follow the pointer for an in-process teammate's own SessionStart OR
    // UserPromptSubmit: those payloads carry the TEAMMATE's session id, so
    // following one would point the lead's recall (and the chat tailer) at the
    // subagent's transcript. A teammate fires UserPromptSubmit every time the
    // lead messages it, so gating only the lifecycle events would leave the same
    // corruption wide open. This complements `attribute_pointer`'s pane truth
    // table, which cannot help here: an IN-PROCESS teammate fires from the
    // lead's own pane, so pane attribution would Adopt its id.
    //
    // ...EXCEPT on a payload that ANNOUNCES a conversation switch. `foreign_agent`
    // is `session_id != cc_conversation_id`, and `track_conversation_pointer` is
    // the ONLY writer of `cc_conversation_id` — so on an `--agent` lead (which
    // carries `agent_type` on its OWN payloads, see `is_foreign_agent_payload`)
    // the gate above was self-latching: the first `/clear` moved Claude to a new
    // conversation, the new id read as a teammate's, the pointer was never
    // followed, and every later event compared against the SAME frozen id. The
    // session then tailed a dead transcript forever ("chat empty" / stale recall)
    // and its real SessionEnd never forced Stopped. There is no self-heal:
    // `clear_stale_resume_link` only rescues a pointer whose FILE is gone, and
    // `/clear` leaves the old transcript on disk.
    //
    // `source` is the field that separates the two cases, and it is Claude's own:
    // an in-process teammate's SessionStart is `"source":"startup"` (captured
    // shape in `is_foreign_agent_payload`), while only the pane's REAL agent can
    // report `clear` or `resume`. `compact` is deliberately NOT here: compaction
    // keeps the same file and the same `sessionId` (see
    // `track_conversation_pointer`), so it needs no pointer move — and admitting
    // it would re-open the teammate hole for a teammate that auto-compacts.
    //
    // Residual, accepted: a claude restarted BY HAND inside the pane reports
    // `source:"startup"` with a fresh id and stays frozen. Narrowing that needs
    // pane truth we do not have here.
    if is_pointer_event(&body.event) && (!foreign_agent || announces_conversation_switch(&raw_payload))
    {
        let id = raw_payload
            .get("session_id")
            .or_else(|| raw_payload.get("sessionId"))
            .and_then(Value::as_str);
        track_conversation_pointer(&state, &body.session, &body.pane, id).await;
    } else if is_pointer_event(&body.event) {
        // The drop that used to be silent. A frozen pointer is invisible in every
        // surface it breaks, so it must leave one line behind.
        tracing::debug!(
            session = %body.session,
            event = %body.event,
            "hook: pointer not followed (payload attributed to an in-process teammate)",
        );
    }

    // Re-tick the detector now so the status (e.g. Notification → waiting,
    // SessionEnd → stopped) is broadcast within ~1s, not at the next tier edge.
    state.wake_detector(&body.session);

    Ok(Json(json!({ "ok": true })))
}

/// The tools whose `PostToolUse` payload names a file the agent just wrote.
const FILE_WRITE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit"];

/// Publish a `files` SSE frame for an agent's own file write.
///
/// The live payload really is `{"tool_name":"Edit","tool_input":{"file_path":
/// "src/tile.tsx"}}` and the `file_path` is RELATIVE, so it must be joined onto
/// the session's `dir` before the company prefix-match runs — otherwise
/// `company_for_path` returns `None` for every agent write and the whole feature
/// is dead on arrival.
///
/// Absolutization here is LEXICAL ONLY — no `canonicalize`, no FS access, no
/// `safe_path`. We never open the file; we only publish a string, and the
/// path-derived company stamp is the gate. That keeps the hook inside its
/// `--max-time 1` budget.
///
/// STATED BLIND SPOT: agents also write through `Bash` (`>`, `sed -i`,
/// `git checkout`, build output). No `PostToolUse` `file_path` exists for those,
/// so this arm cannot see them; the client's visibility-gated refetch backstop
/// covers it until the `notify` watcher lands.
async fn emit_agent_file_write(state: &AppState, session: &str, event: &str, payload: &Value) {
    if !matches!(event, "post_tool" | "post_tool_use" | "PostToolUse") {
        return;
    }
    let tool = payload.get("tool_name").and_then(Value::as_str).unwrap_or("");
    if !FILE_WRITE_TOOLS.contains(&tool) {
        return;
    }
    let Some(file_path) = payload
        .get("tool_input")
        .and_then(|t| t.get("file_path"))
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    else {
        return;
    };
    // One indexed SELECT — it hands us the session's `dir` (and is the only way
    // to absolutize a relative payload path).
    let Ok(Some(sess)) = db::sessions::get(&state.pool, session).await else {
        return;
    };
    let abs = absolutize_hook_path(file_path, &sess.dir);
    crate::files::emit_files_event(state, "write", &abs, None, Some(session)).await;
}

/// Lexically absolutize a hook payload's `file_path` against the session dir.
/// An already-absolute path is returned untouched; a `~` is expanded the same
/// way the files layer expands it.
fn absolutize_hook_path(file_path: &str, dir: &str) -> std::path::PathBuf {
    let expanded = shellexpand::tilde(file_path).into_owned();
    let p = std::path::PathBuf::from(&expanded);
    if p.is_absolute() || dir.is_empty() {
        return p;
    }
    std::path::Path::new(dir).join(p)
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
///
/// **Pane-attributed since S2 (§R2.2).** On a session that HOSTS A REAL TEAM the
/// adoption is no longer unconditional: teammate panes inherit the lead's
/// `$SUPERMUX_SESSION` + `$SUPERMUX_HOOK_TOKEN` from the tmux session
/// environment, so a teammate's `SessionStart` authenticates as the lead and
/// used to repoint it at the teammate's transcript (measured live —
/// `~/team-gap/PHASE0-PROBE.md`; it corrupted `claude --resume` for leads too).
/// The hook now carries `$TMUX_PANE` and only the LEAD's own pane may move the
/// pointer; anything else is filed in the pane map ([`attribute_pointer`] holds
/// the truth table). Sessions that do not host a team are untouched by this.
async fn track_conversation_pointer(
    state: &AppState,
    session: &str,
    pane: &str,
    id: Option<&str>,
) {
    // ── S2: pane attribution, TEAM HOSTS ONLY (§R2.2) ───────────────────────
    //
    // The resolve is the ONLY I/O this adds, and a session that does not host a
    // real team never pays it: `is_team_host` is one DB row plus (only if the
    // polluted `team_name` column is set) one `config.json` read, and it runs on
    // the two pointer events alone — never per hook. A non-team session
    // therefore takes exactly the pre-wave path: base-app parity by
    // construction.
    let host = if crate::sessions::teams::is_team_host(state, session).await {
        Some(TeamHost {
            lead_pane: crate::sessions::teams::resolve_lead_pane(state, session).await,
            tmux_runtime: state.is_tmux_runtime(session).await,
        })
    } else {
        None
    };
    track_pointer_attributed(state, session, pane, id, host.as_ref()).await;
}

/// What the caller learned about a team host this tick. `None` at the call site
/// means "not a team host" — the historical, unattributed path.
#[derive(Debug, Clone)]
struct TeamHost {
    /// [`crate::sessions::teams::resolve_lead_pane`]'s answer.
    lead_pane: Option<String>,
    /// Is the HOST session itself a tmux session? (A native host owns no pane.)
    tmux_runtime: bool,
}

/// The pointer decision + its effects, with the tmux/fs lookups already done and
/// passed in — so every branch of the S2 truth table is exercisable in a unit
/// test without a tmux server or a team on disk.
async fn track_pointer_attributed(
    state: &AppState,
    session: &str,
    pane: &str,
    id: Option<&str>,
    host: Option<&TeamHost>,
) {
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
    if let Some(host) = host {
        // Learn `pane → conversation` either way (§R2.3): the map is pure
        // write-side today and wants the LEAD's pane in it too, so a later
        // merged feed can key every ring the same way.
        state.record_pane_conversation(session, pane, id);
        if attribute_pointer(pane, host.lead_pane.as_deref(), host.tmux_runtime)
            == PointerAction::RecordOnly
        {
            tracing::debug!(
                session = %session,
                pane = %pane,
                lead_pane = ?host.lead_pane,
                "hook from a non-lead/unattributable pane on a team host; \
                 the lead's conversation pointer is left alone"
            );
            return;
        }
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

/// What a pointer-carrying hook is allowed to do to a TEAM HOST's pointer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PointerAction {
    /// Move `sessions.cc_conversation_id` — the historical behaviour.
    Adopt,
    /// Leave the lead's pointer alone; file the id under its pane instead
    /// (§R2.3). NEVER an error: a teammate's conversation is real, it just is
    /// not the lead's.
    RecordOnly,
}

/// The S2 truth table, as a pure function (the tmux/fs I/O lives in the caller,
/// so the DECISION is unit-testable without a tmux server or a team on disk).
///
/// Reached ONLY for a session that hosts a real team.
///
/// * `pane` — `$TMUX_PANE` from the hook body; `""` when the firing process is
///   not inside tmux, or when an old hook command is still installed.
/// * `lead_pane` — [`crate::sessions::teams::resolve_lead_pane`]: the one live
///   pane of the lead's window that no team config claims as a teammate. `None`
///   for a native session (no panes at all) and whenever the discrimination is
///   ambiguous this tick.
/// * `tmux_runtime` — is the HOST session a tmux session? A native host has no
///   pane of its own, which is what makes an empty pane meaningful there.
///
/// The fail-safe direction is always "keep the lead's own conversation": a
/// stale-but-own pointer is honest (the tailer surfaces it as
/// `Reconnecting`/`NoHooks` via `classify_pointer`) and self-heals at the next
/// start, whereas adopting a teammate's conversation silently shows the wrong
/// transcript — and corrupts `claude --resume` for the lead besides.
fn attribute_pointer(pane: &str, lead_pane: Option<&str>, tmux_runtime: bool) -> PointerAction {
    if pane.is_empty() {
        // No pane on a NATIVE host: the host itself has no tmux pane, while
        // Claude spawns every teammate as a tmux pane (they carry a `%id`, and
        // may even live on a different tmux server — measured). So an empty pane
        // on a native team host can only be the lead's own process. Adopting
        // keeps a native lead's pointer live; refusing would freeze the pointer
        // of exactly the lead this wave makes chattable.
        //
        // On a TMUX host an empty pane is unattributable (a pre-upgrade hook
        // command): do not move the pointer. It self-heals at the next session
        // start, when `install_hooks` rewrites the marked entry.
        return if tmux_runtime { PointerAction::RecordOnly } else { PointerAction::Adopt };
    }
    match lead_pane {
        // The lead's own pane: adopt, exactly as before this wave.
        Some(lead) if lead == pane => PointerAction::Adopt,
        // A teammate pane — or a pane we cannot attribute this tick (churn,
        // ambiguous layout, a host that resolves no lead pane). Either way it is
        // NOT provably the lead, so the pointer does not move.
        _ => PointerAction::RecordOnly,
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

/// Record a CHILD's hook against its own per-agent row, when this hook actually
/// came from one.
///
/// `agent_id` is present **iff** the hook fired from inside a subagent — that is
/// Claude Code's own documented rule for the field, and it is the entire
/// admission test here. A main-thread hook is a no-op that allocates nothing.
///
/// Purely ADDITIVE at every call site: the existing `set_activity` /
/// `touch_subagent_tool_hook` / `inc_subagents` / `dec_subagents` calls are left
/// exactly as they are, so the outstanding count, `subagents_live`, the status
/// classifier and the finish-notification gate stay byte-identical. These rows
/// are read only by the SSE delta and the `SessionView` serializer
/// ([`crate::state::AgentRun`]'s display-only invariant).
///
/// Returns whether the row list a reader sees changed, which the arms OR into
/// their own change flag: the rows ride the change-only broadcast, so a row that
/// only this call can produce needs this call to admit it happened.
fn touch_agent_row(state: &AppState, session: &str, payload: &HookPayload) -> bool {
    let Some(id) = payload.agent_id.as_deref().filter(|i| !i.is_empty()) else {
        return false;
    };
    // The same sentence the activity line would show for this call — no new
    // parsing, and `None` for a non-tool event (a `SubagentStart` proves the
    // child exists but says nothing about its work).
    let label = activity::activity_label(payload).map(|(label, _kind)| label);
    state.touch_agent(session, id, payload.agent_type.as_deref(), label)
}

/// Derive + store the in-memory activity/error/lifecycle effects of one hook
/// event's PAYLOAD, broadcasting a `sessions` SSE delta only
/// when the activity/error actually changed (change-only). Pure
/// dispatch on the wire `event` token (accepts both the snake_case form supermux
/// emits and Claude's PascalCase). NOTHING here is persisted to disk/DB.
/// `foreign_agent` is [`is_foreign_agent_payload`], decided once by the caller:
/// true when this payload was fired by an in-process TEAMMATE session rather
/// than by the lead itself.
fn apply_payload(
    state: &AppState,
    session: &str,
    event: &str,
    raw: &Value,
    foreign_agent: bool,
) {
    // The typed view of the same bytes, deserialized BY REFERENCE so nothing is
    // cloned. Both are needed: every arm but the elicitation pair reads named
    // fields, and `requested_schema` is an arbitrary JSON Schema that no fixed
    // struct can hold.
    let payload = &HookPayload::deserialize(raw).unwrap_or_default();

    // An in-process teammate's OWN lifecycle is not the lead's. Since Claude Code
    // 2.1.232 a named subagent in a session with agent teams enabled runs as a
    // teammate with its own Claude session, and its SessionStart/SessionEnd hooks
    // fire under the PARENT pane's `$SUPERMUX_SESSION` token. `TaskStop` on such a
    // teammate emits `SessionEnd` (reason "other"), which used to force the LEAD
    // Stopped mid-turn (and ring the crash notification for a session that never
    // died). Ignore those events entirely here.
    if foreign_agent && is_lifecycle_event(event) {
        // Logged at info: a dropped lifecycle event is invisible in the UI (the
        // lead simply keeps its status), so a misclassified LEAD event would be
        // undiagnosable without this line.
        tracing::info!(
            name = %session,
            event = %event,
            payload_session_id = payload.session_id.as_deref().unwrap_or(""),
            agent_type = payload.agent_type.as_deref().unwrap_or(""),
            "ignoring lifecycle hook from an in-process teammate"
        );
        return;
    }

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
            //
            // AND raise the ANSWERABLE question card via `session.question_request`
            // (T1.5 follow-up): the STRUCTURED payload carries the question's
            // options, so chat can draw the real choices as clickable buttons
            // instead of the generic tool-permission prompt. Structured rather than
            // pty-scraped so it is robust across Claude Code versions (the scrape
            // does not reliably sight this dialog on the current CC). The generic
            // `permission_request` for AskUserQuestion is deliberately suppressed in
            // the `PermissionRequest` arm below so the two cards do not fight.
            let question = if payload.tool_name.as_deref() == Some("AskUserQuestion") {
                let q = activity::first_question(payload).unwrap_or_default();
                notify::notify_event(state, session, NotifEvent::Question(q));
                match activity::question_ask(payload) {
                    Some(ask) => state.set_question_request(session, ask),
                    None => false,
                }
            } else {
                false
            };
            // The store's `connect(service)` affordance (spec §8). This hook is the
            // ONLY thing that raises the card: the tool itself is allow-listed and
            // marker-free (it must NOT stop the turn — chat cannot answer Claude's
            // terminal permission dialog), so it returns while the human answers
            // here. The credential never touches this plane — the card POSTs it
            // straight to the vault.
            let connect = match connect_ask::parse(payload) {
                Some(ask) => state.set_connect_request(session, ask),
                None => false,
            };
            // The Shared Browser connector's `request_human_takeover(reason)`
            // affordance. Unlike `connect` above, this one DOES keep the
            // `requiresUserInteraction` marker and parks the call: the stall IS
            // the drive lock, so the agent cannot touch the page while the human
            // has the wheel. Raise the in-chat "take the wheel" card via
            // `session.browser_takeover`; the panel it opens drives the page.
            let takeover = match takeover_ask::parse(payload, session) {
                Some(ask) => state.set_browser_takeover(session, ask),
                None => false,
            };
            let label = match activity::activity_label(payload) {
                Some((label, kind)) => state.set_activity(session, label, kind),
                None => false,
            };
            // A subagent's own tool calls POST on the shared parent token
            // (anthropics/claude-code#7881). While a subagent is outstanding this
            // keeps its liveness fresh across a long tool call, so a background
            // workflow does not lapse out of `subagents_live` mid-work. No-op (and
            // no allocation) when no subagent is outstanding — a plain turn is
            // unaffected.
            state.touch_subagent_tool_hook(session);
            // …and, when this tool call came from a CHILD, give that child its
            // own row. The line above keeps the parent's aggregate liveness
            // fresh; this one is the only place the answer to "which agents, and
            // what is each doing" comes from. Evaluated BEFORE the `||` chain so
            // a short-circuit can never skip it.
            let child = touch_agent_row(state, session, payload);
            connect || takeover || question || label || child
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
            let cleared = state.clear_permission_request(session) | state.clear_elicitation(session) | state.clear_connect_request(session) | state.clear_browser_takeover(session) | state.clear_question_request(session) | state.clear_waiting_message(session);
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
            let cleared = state.clear_permission_request(session) | state.clear_elicitation(session) | state.clear_connect_request(session) | state.clear_browser_takeover(session) | state.clear_question_request(session) | state.clear_waiting_message(session);
            let failed = if payload.error_type.is_some() || payload.error.is_some() {
                state.set_activity(session, activity::failed_label(payload), "failed".into())
            } else {
                false
            };
            // Keep an outstanding subagent's liveness fresh (see the pre-tool arm).
            state.touch_subagent_tool_hook(session);
            // A child's tool FINISHING is evidence it is still there, so the row
            // stays fresh across a call that spans the quiet threshold.
            let child = touch_agent_row(state, session, payload);
            cleared || failed || child
        }
        // Claude is DISPLAYING a permission dialog for this tool call and is
        // blocked on a human. Fires before any decision; no hook ever reports the
        // outcome, so this state is cleared by whatever happens next (see the
        // clears in the arms around here). A payload with no tool name has
        // nothing to show → no-op.
        "permission_request" | "PermissionRequest" => {
            match activity::permission_ask(payload) {
                // The AskUserQuestion permission dialog is SUPPRESSED as chat's
                // permission card: the pre-tool arm already raised the answerable
                // `question_request` (the question + its real options), and the
                // generic ``Run `AskUserQuestion`?`` card would fight it for the one
                // card slot. The push was already suppressed for this tool
                // (`permission_raises_push`), so nothing else is lost by not
                // recording the permission state at all.
                Some(ask) if ask.tool.trim() == "AskUserQuestion" => false,
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
        "subagent_start" | "SubagentStart" => {
            // The row opens here (label-less until the child's first tool hook),
            // so a subagent that is thinking is already visible instead of
            // appearing only once it touches something.
            let child = touch_agent_row(state, session, payload);
            state.inc_subagents(session) || child
        }
        // The MAIN turn ended → clear the live activity (the error, if any,
        // persists until the next prompt/start). The subagent count is DELIBERATELY
        // NOT force-0'd here any more: a session that dispatched a BACKGROUND
        // workflow keeps its subagents running after the main agent returns to its
        // prompt, and zeroing the count (and tearing down every "still busy"
        // signal) is exactly what made such a session read done/idle while its
        // subagents worked. The count now drains only on `SubagentStop`, and the
        // finished-notification gate is kept fail-safe by
        // `AppState::has_open_subagents` (an outstanding count corroborated by a
        // hook fresh within `SUBAGENT_LIVE_WINDOW`) rather than by this force-0 —
        // so a lost `SubagentStop` still cannot permanently suppress a finish.
        "stop" | "Stop" => {
            let act = state.clear_activity(session);
            let perm = state.clear_permission_request(session) | state.clear_elicitation(session) | state.clear_connect_request(session) | state.clear_browser_takeover(session) | state.clear_question_request(session) | state.clear_waiting_message(session);
            // TRIGGER 3 (B5/T1.5) — unread. The MAIN `Stop` only: `SubagentStop`
            // has its own arm and structurally cannot reach this one, so a Task
            // subagent finishing can never be announced as "the turn is done".
            //
            // The permission clear happens FIRST (above), which is what makes
            // this push's replacement of a pending "needs you" banner causally
            // correct: by the time it lands, the dialog is provably resolved.
            notify::notify_event(state, session, NotifEvent::TurnFinished);
            act || perm
        }
        // A Task sub-agent finished. It shares the parent session token and the
        // MAIN agent is still working, so do NOT wipe the main activity label or
        // end the turn (non-decisive, mirrors turn_end = Stop-only) — but DO
        // decrement the live outstanding count (saturating).
        "subagent_stop" | "SubagentStop" => {
            // Tombstone THIS child's row. Id-keyed, so a duplicated stop removes
            // it once and is a no-op afterwards — it can drive nothing negative
            // and, unlike the count, cannot be pinned by a lost one either.
            //
            // The row's removal is its OWN change signal and must be, because
            // `dec_subagents` reports none when the count is already 0 — the
            // normal case here: no `SubagentStart` fires for a workflow child,
            // and `UserPromptSubmit` zeroes the count under any child that
            // outlives a prompt. Gating the broadcast on the count alone left
            // the finished child on screen, which is the exact ghost these rows
            // exist to abolish.
            let gone = payload
                .agent_id
                .as_deref()
                .filter(|i| !i.is_empty())
                .is_some_and(|id| state.stop_agent(session, id));
            state.dec_subagents(session) || gone
        }
        // A new prompt / a fresh session → the previous error is no longer
        // current (the user is acting again) → clear it, and reset the subagent
        // count for the new turn. All three effects are LEAD state, so a
        // teammate's own UserPromptSubmit (fired every time the lead messages it)
        // must not run them: it would wipe the lead's error badge, zero its
        // outstanding subagent count mid-turn and dismiss a permission ask the
        // lead is still sitting on.
        "user_prompt" | "user_prompt_submit" | "UserPromptSubmit" if !foreign_agent => {
            let err = state.clear_error(session);
            let sub = state.reset_subagents(session);
            // Rows follow the same edge as the count, with one deliberate
            // exception: a child that is PROVABLY still working right now
            // survives the new prompt, exactly as the count's own
            // no-force-0-on-Stop rule protects a background workflow. Everything
            // else belonged to the turn that just ended.
            let pruned = state.prune_agents_for_prompt(session, Instant::now());
            let perm = state.clear_permission_request(session) | state.clear_elicitation(session) | state.clear_connect_request(session) | state.clear_browser_takeover(session) | state.clear_question_request(session) | state.clear_waiting_message(session);
            err || sub || perm || pruned
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
            // A brand-new Claude process inherits no children.
            let dropped = state.clear_agents(session);
            let err = state.clear_error(session);
            let perm = state.clear_permission_request(session) | state.clear_elicitation(session) | state.clear_connect_request(session) | state.clear_browser_takeover(session) | state.clear_question_request(session) | state.clear_waiting_message(session);
            err || perm || dropped
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
            // The session is gone; nothing that ran under it is still ours to
            // claim knowledge of.
            let dropped_rows = state.clear_agents(session);
            let perm_changed =
                state.clear_permission_request(session) | state.clear_elicitation(session) | state.clear_connect_request(session) | state.clear_browser_takeover(session) | state.clear_question_request(session) | state.clear_waiting_message(session);
            // The turn is definitively over when the session ends — drop it so a
            // later restart can't inherit it (belt-and-suspenders with the
            // SessionStart reset above).
            state.reset_turn_state(session);
            // The agent is gone, so its shared-browser context must go with it:
            // otherwise the page outlives the agent, the max-contexts cap
            // becomes a lifetime budget, and the idle reaper — which only fires
            // on an EMPTY context map — never fires again, leaving chrome
            // resident forever. Fire-and-forget; a session that never browsed is
            // a no-op.
            crate::connectors::browser::dispose_on_teardown(&state.browser, session);
            force_stopped(state, session);
            act_changed || sub_changed || perm_changed || dropped_rows
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
        // Claude raised a Notification. The needs-you family carries its message
        // to the ephemeral Waiting line (the status side already flips Waiting
        // via HookEvent::Notification). auth_success / agent_completed etc.
        // surface nothing. Cleared by the same resolution events as `permission`.
        "notification" | "Notification" => match payload.notification_type.as_deref() {
            Some("permission_prompt" | "idle_prompt" | "agent_needs_input") => {
                match payload.message.as_deref() {
                    Some(m) if !m.trim().is_empty() => {
                        state.set_waiting_message(session, m.trim().to_string())
                    }
                    _ => false,
                }
            }
            _ => false,
        },
        _ => false,
    };

    if changed {
        broadcast_activity_delta(state, session);
    }
}

/// True when `event` is one of Claude's session LIFECYCLE events (the ones whose
/// `apply_payload` arms touch the lead's forced status / turn state). Paired with
/// [`is_foreign_agent_payload`] this is the "teammate lifecycle" guard; tool and
/// turn events from a teammate are deliberately NOT filtered, so they still count
/// toward the pane's live activity.
fn is_lifecycle_event(event: &str) -> bool {
    matches!(
        event,
        "session_start" | "SessionStart" | "session_end" | "SessionEnd"
    )
}

/// A payload string field, trimmed to `None` when absent or blank. Read off the
/// RAW value rather than the typed [`HookPayload`], so the teammate check in the
/// handler costs no second deserialize on the hot POST path.
fn payload_str<'a>(raw: &'a Value, key: &str) -> Option<&'a str> {
    raw.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// True when `raw` carries a non-empty `agent_type` (whitespace counts as
/// absent). The cheap first half of [`is_foreign_agent_payload`], used to skip the
/// tie-breaker DB read on the common path.
fn has_agent_type(raw: &Value) -> bool {
    payload_str(raw, "agent_type").is_some()
}

/// A hook payload belongs to an in-process teammate (not the lead) when it carries
/// a non-empty `agent_type` AND its `session_id` is not the lead's own tracked
/// conversation id.
///
/// A teammate shares the pane's `$SUPERMUX_SESSION` (and therefore the hook
/// token), so its events are indistinguishable by transport. Captured shapes:
///   start: {"session_id":"<teammate>","agent_type":"general-purpose","hook_event_name":"SessionStart","source":"startup"}
///   end:   {"session_id":"<teammate>","agent_type":"general-purpose","hook_event_name":"SessionEnd","reason":"other"}
///
/// `agent_type` alone is NOT enough: Claude sets it from the MAIN-THREAD agent
/// type, so a lead launched with `claude --agent <name>` (or with `"agent"` in
/// settings.json) also carries it on its own lifecycle payloads. Masking those
/// would leave a zombie row: no forced Stopped, no teardown, forever. The lead's
/// tracked id (`sessions.cc_conversation_id`) is the tie-breaker; when nothing is
/// tracked yet the payload is accepted as the lead's (first contact establishes
/// the id), so an `--agent` lead self-heals on its first SessionStart /
/// UserPromptSubmit.
/// Does this payload ANNOUNCE that the pane's agent moved to a new conversation
/// file? `SessionStart` carries Claude's own `source`, and only the real agent in
/// the pane can report these two:
///   * `clear` — the human typed `/clear`; Claude opened a new transcript;
///   * `resume` — a terminal-side `--resume` switched files.
///
/// `startup` is EXCLUDED because that is exactly what an in-process teammate
/// fires, and `compact` because compaction does not change the file or the id
/// (admitting it would let a compacting teammate steal the lead's pointer).
fn announces_conversation_switch(raw: &Value) -> bool {
    matches!(payload_str(raw, "source"), Some("clear") | Some("resume"))
}

fn is_foreign_agent_payload(raw: &Value, tracked_cc_id: Option<&str>) -> bool {
    if !has_agent_type(raw) {
        return false;
    }
    // Same camelCase tolerance the typed `session_id` field carries.
    let sid = payload_str(raw, "session_id").or_else(|| payload_str(raw, "sessionId"));
    let tracked = tracked_cc_id.map(str::trim).filter(|t| !t.is_empty());
    match (sid, tracked) {
        // Both known: the lead's own id is the lead's own event.
        (Some(sid), Some(tracked)) => sid != tracked,
        // Nothing tracked yet: give the payload to the lead so it can establish
        // its id (an `--agent` lead would otherwise be masked forever).
        (_, None) => false,
        // A tracked lead id exists and this payload names no session at all, so it
        // demonstrably is not the lead's own conversation.
        (None, Some(_)) => true,
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
            company_id: None,
            payload: json!({
                "name": session,
                "status": Status::Stopped.as_str(),
                "version": version,
            }),
        });
        let _ = state.sse_tx.send(SseEvent {
            event: "sessions".to_string(),
            company_id: None,
            payload: json!({ "delta": [{ "name": session, "status": Status::Stopped.as_str() }] }),
        });
        // AFTER the status flip: SessionEnd means the lead agent is exiting right
        // now, so capture its pid while it is still the pane's foreground job and
        // let the teardown task wait out its death and reap the team's tmux
        // server. This forks tmux, and the tile flip must not wait on that; the
        // agent takes far longer than these few ms to actually leave the pane, and
        // the teardown polls for its death anyway.
        //
        // This runs BEFORE the archive below on purpose: archiving kills the pane,
        // and `lead_pid_of` reads the pane's foreground pgid — once the pane is
        // gone there is no pid left to hand the teardown, and the team's tmux
        // server would leak exactly on the disposable sessions that churn most.
        if crate::sessions::swarm::teardown_enabled(&state) {
            if let Ok(rt) = state.runtime_for(&session).await {
                if let Some(pid) = crate::sessions::swarm::lead_pid_of(rt.as_ref()).await {
                    crate::sessions::swarm::spawn_teardown_for_lead(pid);
                }
            }
        }
        // Disposable (archive_on_stop) sessions archive themselves when their
        // agent ends. Guarded upstream in `apply_payload`: a foreign (teammate)
        // SessionEnd never reaches `force_stopped`, so it can never archive the
        // lead's live session.
        crate::sessions::lifecycle::maybe_archive_on_stop(&state, &session).await;
    });
}

/// Broadcast a `sessions` SSE delta carrying `name`'s current activity/error so
/// open overviews update the live line / error badge without a refetch.
/// Cheap; sent only when the snapshot changed (the caller gates
/// on that). A cleared field is sent as JSON `null` so the client drops it.
pub(crate) fn broadcast_activity_delta(state: &AppState, session: &str) {
    let act = state.session_activity(session).unwrap_or_default();
    let error = act.error.as_ref().map(|(t, m)| json!({ "type": t, "message": m }));
    let permission = act.permission.as_ref().map(|a| {
        json!({ "tool": a.tool, "summary": a.summary, "kind": a.kind, "mode": a.mode })
    });
    // Read the rows ONCE: the two keys below are the list and its length, and
    // reading twice could serialize a count that disagrees with the rows beside
    // it (the sweep runs on read).
    let agents = state.agent_rows_now(session);
    let _ = state.sse_tx.send(SseEvent {
        event: "sessions".to_string(),
        company_id: None,
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
            // The live connect ask (`null` once the connect tool call moved on —
            // the client must drop the card, so this is always present). Names
            // WHICH connector stalled; the credential never rides this plane.
            "connect_request": act.connect_request,
            // The live browser takeover ask (`null` once the human handed the
            // wheel back or the call moved on — the client must drop the card,
            // so this is always present).
            "browser_takeover": act.browser_takeover,
            // The live question ask (`null` once the AskUserQuestion call moved on
            // — the client must drop the card, so this is always present). Carries
            // the question + its real options; the chat card answers by clicking.
            "question_request": act.question_request,
            // The needs-you Notification waiting line (`null` clears — always
            // present). Rendered read-only in the attention region on Waiting.
            "waiting_message": act.waiting_message,
            // Live outstanding-subagent count (display-only parallelism signal).
            // Always present so a drop back to 0 clears the client's clause.
            "subagents": act.subagents,
            // Is a BACKGROUND workflow provably running right now? Always present
            // so the roster updates the "working" bucket/word/face live (and
            // clears it) without a refetch when the signal flips.
            "subagents_live": state.subagents_live(session),
            // HOW MANY children have fresh first-hand evidence — the clause every
            // surface but the chat's working row draws, replacing the raw count
            // beside it: `subagents` is a number a lost `SubagentStop` can pin,
            // this one counts rows that exist only because a hook carrying that
            // exact `agent_id` arrived. …and the rows themselves, for the one
            // surface that lists them. Both always present (0 / `[]` is how a
            // client clears), both display-only: nothing downstream of them
            // reaches the status classifier or the turn boundary.
            "agents_live": agents.len(),
            "agents": agents,
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
            swarm_reaper: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            company_isolation: Vec::new(),
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    #[test]
    fn absolutize_hook_path_joins_a_relative_payload_path() {
        // The live payload's `file_path` is RELATIVE — joining it onto the
        // session dir is what makes the company prefix-match work at all.
        assert_eq!(
            absolutize_hook_path("src/tile.tsx", "/srv/acme/app"),
            std::path::PathBuf::from("/srv/acme/app/src/tile.tsx")
        );
        // An absolute payload path is taken as-is.
        assert_eq!(
            absolutize_hook_path("/srv/acme/app/x.rs", "/srv/acme/app"),
            std::path::PathBuf::from("/srv/acme/app/x.rs")
        );
        // No session dir → whatever we were handed (never a panic).
        assert_eq!(
            absolutize_hook_path("x.rs", ""),
            std::path::PathBuf::from("x.rs")
        );
    }

    /// The hook arm is what makes an AGENT's file write visible live. The frame
    /// must carry the ABSOLUTIZED path and the company that owns it.
    #[tokio::test]
    async fn post_tool_write_emits_a_company_stamped_files_frame() {
        let (state, dir) = test_state().await;
        let root = dir.join("acme");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let company =
            crate::db::companies::create(&state.pool, "acme", "Acme", &root.to_string_lossy())
                .await
                .expect("company row");
        crate::db::sessions::create(
            &state.pool,
            &crate::db::sessions::NewSession {
                name: "researcher".to_string(),
                display_name: "researcher".to_string(),
                dir: root.to_string_lossy().to_string(),
                desc: String::new(),
                provider: "claude".to_string(),
                creator: "test".to_string(),
                flags: String::new(),
                tags: "[]".to_string(),
                branch: String::new(),
                mcp: String::new(),
                worktree: false,
                worktree_repo: String::new(),
                host_id: None,
                runtime: "native".to_string(),
                model: String::new(),
                company_id: Some(company.id),
                archive_on_stop: false,
                config_dir: String::new(),
            },
        )
        .await
        .expect("session row");

        let mut rx = state.sse_tx.subscribe();
        let payload = json!({
            "tool_name": "Edit",
            "tool_input": { "file_path": "src/tile.tsx" },
        });
        emit_agent_file_write(&state, "researcher", "PostToolUse", &payload).await;

        let frame = rx.try_recv().expect("a files frame was published");
        assert_eq!(frame.event, "files");
        assert_eq!(frame.payload["op"], "write");
        assert_eq!(
            frame.payload["path"],
            root.join("src/tile.tsx").to_string_lossy().into_owned(),
            "the relative payload path is joined onto the session dir"
        );
        assert_eq!(frame.payload["session"], "researcher");
        assert_eq!(
            frame.company_id,
            Some(company.id),
            "stamped by PATH with the owning company"
        );

        // A tool that writes no file publishes nothing.
        emit_agent_file_write(
            &state,
            "researcher",
            "PostToolUse",
            &json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } }),
        )
        .await;
        assert!(rx.try_recv().is_err(), "Bash produces no files frame");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// One hook payload, as the raw JSON `apply_payload` takes.
    fn p(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    /// The wall-clock twin of a synthetic `base: Instant` in the row tests.
    /// `agent_rows` takes both clocks — the monotonic one ages the ladder, the
    /// wall-clock one is what goes on the wire — so a test that fabricates `now`
    /// has to fabricate both, and only then are the stamps it asserts readable.
    const WALL: i64 = 1_756_000_000_000;

    /// `state`'s rows for `name` `secs` after `base`, on both clocks at once.
    fn rows_at(
        state: &AppState,
        name: &str,
        base: Instant,
        secs: u64,
    ) -> Vec<crate::state::AgentRow> {
        state.agent_rows(
            name,
            base + std::time::Duration::from_secs(secs),
            WALL + secs as i64 * 1_000,
        )
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

        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);

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

    /// The whole admission rule for a per-agent row, both directions.
    ///
    /// `agent_id` is present iff the hook fired from INSIDE a subagent, so a
    /// child's tool call earns a row carrying that child's own label, and the
    /// byte-identical payload from the main thread earns nothing at all. That
    /// asymmetry is what makes a ghost impossible: no row can exist without a
    /// hook that named the agent.
    #[tokio::test]
    async fn a_child_tool_hook_opens_a_row_and_a_main_thread_one_does_not() {
        let (state, dir) = test_state().await;

        apply_payload(
            &state,
            "child",
            "pre_tool",
            &p(r#"{"agent_id":"a1","agent_type":"general-purpose","tool_name":"Bash","tool_input":{"command":"echo hi","description":"x"}}"#),
            false,
        );
        let rows = state.agent_rows_now("child");
        assert_eq!(rows.len(), 1, "one child hook → exactly one row");
        assert_eq!(rows[0].id, "a1");
        assert_eq!(rows[0].agent_type, "general-purpose");
        assert_eq!(
            rows[0].label.as_deref(),
            Some("⚡ x"),
            "the row wears the child's OWN tool label",
        );

        // The same payload minus the id: the main thread's own Bash call.
        apply_payload(
            &state,
            "main",
            "pre_tool",
            &p(r#"{"tool_name":"Bash","tool_input":{"command":"echo hi","description":"x"}}"#),
            false,
        );
        assert!(
            state.agent_rows_now("main").is_empty(),
            "no agent_id → no row (the main thread is not one of its own children)",
        );
        // …and the activity line it DID set is untouched by any of this.
        assert_eq!(
            state.session_activity("main").and_then(|a| a.activity).as_deref(),
            Some("⚡ x"),
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Rows are ID-KEYED, so `SubagentStop` is idempotent where the count is
    /// merely saturating — and the tombstone it leaves cannot be resurrected by a
    /// straggler hook. The count itself must keep draining exactly as it does
    /// today (this is additive; nothing about the old signal changes).
    #[tokio::test]
    async fn a_duplicate_subagent_stop_removes_the_row_once() {
        let (state, dir) = test_state().await;
        let s = "fanout";
        let now = Instant::now();
        let now_ms = WALL;

        apply_payload(&state, s, "subagent_start", &p(r#"{"agent_id":"a1","agent_type":"Explore"}"#), false);
        apply_payload(&state, s, "subagent_start", &p(r#"{"agent_id":"a2","agent_type":"Explore"}"#), false);
        assert_eq!(state.agent_rows(s, now, now_ms).len(), 2);
        assert_eq!(subagents(&state, s), 2);

        apply_payload(&state, s, "subagent_stop", &p(r#"{"agent_id":"a1"}"#), false);
        let ids: Vec<_> = state.agent_rows(s, now, now_ms).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["a2".to_string()], "only the stopped child leaves");
        assert_eq!(subagents(&state, s), 1);

        // The SAME stop again: a no-op for the row (there is nothing left to
        // remove), while the count decrements again exactly as it always has.
        apply_payload(&state, s, "subagent_stop", &p(r#"{"agent_id":"a1"}"#), false);
        let ids: Vec<_> = state.agent_rows(s, now, now_ms).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["a2".to_string()], "the second stop changes nothing");
        assert_eq!(subagents(&state, s), 0, "the count still drains as it did before");

        // A straggler tool hook for the stopped child — hooks are fire-and-forget
        // POSTs and can land out of order — must NOT bring it back.
        apply_payload(
            &state,
            s,
            "post_tool",
            &p(r#"{"agent_id":"a1","agent_type":"Explore","tool_name":"Read","tool_input":{"file_path":"/x/y.rs"}}"#),
            false,
        );
        let ids: Vec<_> = state.agent_rows(s, now, now_ms).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["a2".to_string()], "a stop is final for that id");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The staleness ladder, as a pure function of `(started, last_evidence, now)`
    /// — `now` is a parameter precisely so this needs no sleeping. There is no
    /// reaper task and no counter to drift: a row is rendered iff it still has
    /// first-hand evidence, and past ten minutes we stop claiming to know
    /// anything about that agent at all.
    #[tokio::test]
    async fn agent_rows_age_from_live_through_quiet_to_gone() {
        let (state, dir) = test_state().await;
        let s = "ladder";
        let base = Instant::now();
        state.agents.entry(s.to_string()).or_default().insert(
            "a1".to_string(),
            crate::state::AgentRun {
                agent_type: "workflow-subagent".to_string(),
                label: Some("⚡ x".to_string()),
                started: base,
                last_evidence: base,
                stopped: false,
            },
        );

        // 30s — live. Well inside the 60s window, so the client renders it
        // normally with its tool label. Both stamps are ABSOLUTE, so they read
        // the same at every `now`: that is what lets the client age the row on
        // its own instead of waiting for a delta to re-resolve a duration.
        let rows = rows_at(&state, s, base, 30);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].started_ms, WALL);
        assert_eq!(rows[0].last_evidence_ms, WALL);

        // 5 min — quiet. Still rendered (an agent inside one long `Bash` is
        // legitimately silent), dimmed, and the copy states the fact.
        let rows = rows_at(&state, s, base, 300);
        assert_eq!(rows.len(), 1, "a quiet row is still a row");
        assert_eq!(rows[0].last_evidence_ms, WALL, "the stamp does not move with `now`");

        // 11 min — gone, and reclaimed on the way through.
        let rows = rows_at(&state, s, base, 660);
        assert!(rows.is_empty(), "past ten minutes we no longer claim to know");
        assert!(!state.agents.contains_key(s), "the empty entry is dropped too");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The prompt edge, with the one deliberate exception. A new prompt drops
    /// everything that belonged to the turn that ended — but a child that is
    /// PROVABLY still working survives it, mirroring the count's own
    /// no-force-0-on-`Stop` rule for background workflows.
    #[tokio::test]
    async fn a_new_prompt_prunes_quiet_rows_and_keeps_working_ones() {
        let (state, dir) = test_state().await;
        let s = "prompted";
        let base = Instant::now();

        // The ladder half, on a synthetic clock: one row 10 min quiet, one 5s.
        {
            let mut runs = state.agents.entry(s.to_string()).or_default();
            for (id, evidence_at) in [
                ("stale", base),
                ("working", base + std::time::Duration::from_secs(595)),
            ] {
                runs.insert(
                    id.to_string(),
                    crate::state::AgentRun {
                        agent_type: "workflow-subagent".to_string(),
                        label: None,
                        started: base,
                        last_evidence: evidence_at,
                        stopped: false,
                    },
                );
            }
        }
        assert!(
            state.prune_agents_for_prompt(s, base + std::time::Duration::from_secs(600)),
            "dropping a row IS a change — the client is holding the longer list",
        );
        let ids: Vec<_> = rows_at(&state, s, base, 600).into_iter().map(|r| r.id).collect();
        assert_eq!(
            ids,
            vec!["working".to_string()],
            "5s-old evidence survives the prompt; 10-min-old does not",
        );

        // The wiring half, on the real clock: the `UserPromptSubmit` arm runs the
        // prune (the finished child goes) without touching the live one.
        let w = "wired";
        apply_payload(&state, w, "subagent_start", &p(r#"{"agent_id":"live","agent_type":"Explore"}"#), false);
        apply_payload(&state, w, "subagent_start", &p(r#"{"agent_id":"done","agent_type":"Explore"}"#), false);
        apply_payload(&state, w, "subagent_stop", &p(r#"{"agent_id":"done"}"#), false);
        apply_payload(&state, w, "user_prompt", &p("{}"), false);
        let ids: Vec<_> = state.agent_rows_now(w).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["live".to_string()], "the prompt arm prunes the finished child");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The cap, and what it evicts. One conversation on this host has 899
    /// subagent transcripts; a fan-out session's map must not grow with every
    /// child it ever spawned. The row evicted is always the one whose evidence
    /// is oldest — which is by construction a quiet or finished child, never one
    /// that is still calling tools.
    #[tokio::test]
    async fn the_row_map_is_capped_and_evicts_the_oldest_evidence() {
        let (state, dir) = test_state().await;
        let s = "swarm";

        // 40 children, oldest first (each `touch` stamps `Instant::now()`, which
        // is monotonic, so insertion order IS evidence order).
        for i in 0..40u32 {
            apply_payload(
                &state,
                s,
                "pre_tool",
                &p(&format!(
                    r#"{{"agent_id":"a{i}","agent_type":"general-purpose","tool_name":"Bash","tool_input":{{"description":"d{i}"}}}}"#
                )),
                false,
            );
        }
        let rows = state.agent_rows_now(s);
        assert_eq!(rows.len(), 32, "the map is capped at 32 rows per session");
        let ids: std::collections::HashSet<_> = rows.iter().map(|r| r.id.as_str()).collect();
        assert!(!ids.contains("a0"), "the oldest evidence was evicted");
        assert!(ids.contains("a39"), "the newest child is always kept");

        // A lifecycle edge drops the lot: a brand-new Claude process inherits no
        // children, and neither does a finished one.
        apply_payload(&state, s, "session_start", &p("{}"), false);
        assert!(state.agent_rows_now(s).is_empty());

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The rows ride the SAME change-only `sessions` delta the count already
    /// does — one key beside it, always present so an empty array clears the
    /// client's list. No new event type, no new endpoint.
    #[tokio::test]
    async fn agent_rows_ride_the_sessions_delta() {
        let (state, dir) = test_state().await;
        let s = "delta-agents";
        let mut rx = state.sse_tx.subscribe();

        apply_payload(
            &state,
            s,
            "pre_tool",
            &p(r#"{"agent_id":"a1","agent_type":"workflow-subagent","tool_name":"Bash","tool_input":{"description":"probe"}}"#),
            false,
        );

        let mut last: Option<Value> = None;
        let mut last_live: Option<i64> = None;
        while let Ok(ev) = rx.try_recv() {
            if ev.event == "sessions" {
                if let Some(d) = ev.payload.get("delta").and_then(|d| d.as_array()).and_then(|a| a.first()) {
                    if d.get("name").and_then(|n| n.as_str()) == Some(s) {
                        last = d.get("agents").cloned();
                        last_live = d.get("agents_live").and_then(|v| v.as_i64());
                    }
                }
            }
        }
        let agents = last.expect("the sessions delta must carry an `agents` key");
        let agents = agents.as_array().expect("`agents` is always an array");
        assert_eq!(agents.len(), 1);
        // The COUNT rides the same frame, and must agree with the list beside it:
        // every surface but the chat's working row draws the clause from this
        // number alone, so a disagreement is a clause that opens a different list.
        assert_eq!(
            last_live,
            Some(agents.len() as i64),
            "`agents_live` is the length of the `agents` beside it",
        );
        assert_eq!(agents[0]["id"], "a1");
        assert_eq!(agents[0]["type"], "workflow-subagent");
        assert_eq!(agents[0]["label"], "⚡ probe");
        // Absolute server-clock stamps, in the same domain as the delta's own
        // `activity_at` — the client ages the row against them and never has to
        // re-anchor a duration against its own clock.
        let now_ms = chrono::Utc::now().timestamp_millis();
        for key in ["started_ms", "last_evidence_ms"] {
            let at = agents[0][key].as_i64().unwrap_or_else(|| panic!("`{key}` is a number"));
            assert!(
                (now_ms - at).abs() < 60_000,
                "`{key}` is a wall-clock stamp near now, not a duration ({at})",
            );
        }

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The stop a change-only broadcast used to swallow.
    ///
    /// `dec_subagents` reports no change when the count is already 0, and 0 is
    /// the NORMAL state under a workflow child (no `SubagentStart` fires for
    /// one). Before the row's own removal reported itself, the tombstone landed
    /// server-side and no delta was sent, so every connected client kept drawing
    /// a child that had finished — the stale clause wearing a new shape.
    #[tokio::test]
    async fn a_stop_at_count_zero_still_broadcasts_the_shorter_list() {
        let (state, dir) = test_state().await;
        let s = "workflow-child";

        // A workflow child: a tool hook carrying its id, and no `SubagentStart`,
        // so the row exists while the count never left 0.
        apply_payload(
            &state,
            s,
            "pre_tool",
            &p(r#"{"agent_id":"a1","agent_type":"workflow-subagent","tool_name":"Bash","tool_input":{"description":"probe"}}"#),
            false,
        );
        assert_eq!(subagents(&state, s), 0, "no SubagentStart fired, so the count is 0");
        assert_eq!(state.agent_rows_now(s).len(), 1);

        let mut rx = state.sse_tx.subscribe();
        apply_payload(&state, s, "subagent_stop", &p(r#"{"agent_id":"a1"}"#), false);

        let mut agents: Option<Value> = None;
        while let Ok(ev) = rx.try_recv() {
            if ev.event == "sessions" {
                if let Some(d) = ev.payload.get("delta").and_then(|d| d.as_array()).and_then(|a| a.first()) {
                    if d.get("name").and_then(|n| n.as_str()) == Some(s) {
                        agents = d.get("agents").cloned();
                    }
                }
            }
        }
        let agents = agents.expect("the stop must broadcast, count or no count");
        assert_eq!(
            agents.as_array().map(Vec::len),
            Some(0),
            "and the array it carries is empty — that is what clears the client",
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The visible order does not move under the reader.
    ///
    /// Only the first six rows of a fan-out are drawn, so the sort key decides
    /// WHICH agents a phone shows. Ordering by recency of evidence made that set
    /// rotate on every hook any child posted; ordering by spawn time (within the
    /// live/quiet bucket) means the only rank change is the one that means
    /// something — a row going quiet and sinking.
    #[tokio::test]
    async fn the_visible_order_holds_when_a_younger_child_posts_a_hook() {
        let (state, dir) = test_state().await;
        let s = "swarm-order";
        let base = Instant::now();
        {
            let mut runs = state.agents.entry(s.to_string()).or_default();
            for (id, started_at) in [("old", base), ("young", base + std::time::Duration::from_secs(5))] {
                runs.insert(
                    id.to_string(),
                    crate::state::AgentRun {
                        agent_type: "workflow-subagent".to_string(),
                        label: None,
                        started: started_at,
                        last_evidence: started_at,
                        stopped: false,
                    },
                );
            }
        }
        let ids = |rows: Vec<crate::state::AgentRow>| -> Vec<String> {
            rows.into_iter().map(|r| r.id).collect()
        };
        assert_eq!(ids(rows_at(&state, s, base, 10)), vec!["old", "young"]);

        // The YOUNGER child posts a tool hook: freshest evidence, and with the
        // old sort it would have jumped the queue.
        state.agents.get_mut(s).unwrap().get_mut("young").unwrap().last_evidence =
            base + std::time::Duration::from_secs(20);
        assert_eq!(
            ids(rows_at(&state, s, base, 20)),
            vec!["old", "young"],
            "a hook from a child must not re-rank the list a reader is scanning",
        );

        // …and the one rank change that IS meaningful: `old` crosses 60s of
        // silence, so it dims and sinks below the child still working.
        assert_eq!(
            ids(rows_at(&state, s, base, 70)),
            vec!["young", "old"],
            "live rows lead; a quiet one sinks",
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn main_stop_no_longer_force_zeroes_the_subagent_count() {
        // The subagents_live fix: a session that dispatched a BACKGROUND workflow
        // keeps its outstanding-subagent count past the MAIN `Stop` (the count now
        // drains only on `SubagentStop`), so the roster + status can still read it
        // as WORKING. Before, `Stop` force-0'd it and the session read done/idle.
        let (state, dir) = test_state().await;
        let s = "lead-stop";

        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        assert_eq!(state.session_activity(s).map(|a| a.subagents), Some(2));
        // The workflow is provably live (open subagent hooks).
        assert!(state.subagents_live(s));

        // The MAIN turn ends. The count MUST survive.
        apply_payload(&state, s, "stop", &p("{}"), false);
        assert_eq!(
            state.session_activity(s).map(|a| a.subagents),
            Some(2),
            "main Stop must NOT force-0 a live background workflow's count"
        );
        assert!(state.subagents_live(s), "the workflow still reads live after main Stop");

        // A SubagentStop drains it — the honest way the count now falls.
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        assert!(
            !state.subagents_live(s),
            "draining every subagent (SubagentStop) ends the live signal"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_subagent_tool_hook_keeps_liveness_fresh_after_stop() {
        // A subagent's own tool calls POST PreToolUse on the parent token after the
        // main Stop; `touch_subagent_tool_hook` keeps the open-subagent liveness
        // fresh through a long subagent tool call, but ONLY while a subagent is
        // outstanding — a plain turn with no subagent is untouched.
        let (state, dir) = test_state().await;

        // No outstanding subagent → a tool hook allocates nothing / not live.
        apply_payload(&state, "plain", "pre_tool", &p(r#"{"tool_name":"Read"}"#), false);
        assert!(!state.subagents_live("plain"));

        // With a subagent outstanding, a parent tool hook refreshes liveness.
        let s = "lead-tool";
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "stop", &p("{}"), false);
        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Bash","tool_input":{"command":"x"}}"#), false);
        assert!(state.subagents_live(s), "a parent tool hook keeps the workflow live");

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
            false,
        );
        let act = state.session_activity(s).unwrap();
        assert_eq!(act.activity.as_deref(), Some("✎ tile.tsx"));
        assert_eq!(act.activity_kind.as_deref(), Some("edit"));

        // Stop clears the live activity; the snapshot prunes empty → None.
        apply_payload(&state, s, "stop", &p("{}"), false);
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
            false,
        );
        assert!(state.session_activity(s).is_some(), "pre_tool set an activity");

        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        assert!(
            state.session_activity(s).is_some(),
            "SubagentStop must NOT clear the main session's activity"
        );

        // The real main Stop still clears it.
        apply_payload(&state, s, "stop", &p("{}"), false);
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
        apply_payload(&state, s, "session_start", &p("{}"), false);
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
        // Parallelism signal: SubagentStart increments, SubagentStop decrements
        // (saturating), a new prompt resets. The main Stop NO LONGER force-0s it
        // (subagents_live fix) — a background workflow's count survives the main
        // turn; a lost SubagentStop is instead reaped by SUBAGENT_LIVE_WINDOW
        // freshness in `subagents_live`, not by zeroing the count here.
        let (state, dir) = test_state().await;
        let s = "lead-2";

        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        assert_eq!(subagents(&state, s), 3, "three subagents started");

        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        assert_eq!(subagents(&state, s), 2, "one finished → 2 outstanding");

        // Saturating: more stops than starts must clamp at 0, never underflow.
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        assert_eq!(subagents(&state, s), 0, "saturating dec floors at 0");

        // A fresh turn resets the count.
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        assert_eq!(subagents(&state, s), 2);
        apply_payload(&state, s, "user_prompt", &p("{}"), false);
        assert_eq!(subagents(&state, s), 0, "a new prompt resets the count");

        // The main Stop leaves the count INTACT now: a session that dispatched a
        // background workflow keeps a truthful count after the main agent returns
        // to its prompt (this is what lets the roster read it as WORKING). The
        // count falls only when its SubagentStops arrive.
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        assert_eq!(subagents(&state, s), 2);
        apply_payload(&state, s, "stop", &p("{}"), false);
        assert_eq!(subagents(&state, s), 2, "main Stop must NOT force-0 the count");
        // Its SubagentStops drain it the honest way.
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        assert_eq!(subagents(&state, s), 0, "SubagentStop drains the count to 0");

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
            false,
        );
        let err = state.session_activity(s).unwrap().error.unwrap();
        assert_eq!(err.0, "rate_limit");
        assert_eq!(err.1, "quota exceeded");

        // The next UserPromptSubmit clears the (now-stale) error.
        apply_payload(&state, s, "user_prompt", &p("{}"), false);
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
        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Bash","tool_input":{"command":"sleep 1"}}"#), false);
        assert!(state.session_activity(s).is_some());

        apply_payload(&state, s, "session_end", &p("{}"), false);
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

        apply_payload(&state, s, "session_start", &p("{}"), false);
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
        apply_payload(&state, s, "post_tool", &p(r#"{"tool_name":"Read"}"#), false);
        assert!(rx.try_recv().is_err(), "clean post_tool must not broadcast");

        // A PreToolUse with no tool name is also a no-op.
        apply_payload(&state, s, "pre_tool", &p("{}"), false);
        assert!(rx.try_recv().is_err(), "tool-less pre_tool must not broadcast");

        // A real activity change DOES broadcast a `sessions` delta.
        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Read","tool_input":{"file_path":"a.rs"}}"#), false);
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

        apply_payload(&state, s, "permission_request", &p(LIVE_PERMISSION_REQUEST), false);

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
        apply_payload(&state, s, "permission_request", &p(LIVE_PERMISSION_REQUEST), false);
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
            apply_payload(&state, s, "permission_request", &p(LIVE_PERMISSION_REQUEST), false);
            assert!(
                state.session_activity(s).and_then(|a| a.permission).is_some(),
                "{event}: precondition — an ask is live"
            );

            let mut rx = state.sse_tx.subscribe();
            apply_payload(&state, s, event, &p(payload), false);
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

        apply_payload(&state, s, "elicitation", &p(LIVE_ELICITATION), false);

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
        apply_payload(&state, s, "elicitation", &p(LIVE_ELICITATION), false);
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
            false,
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
            apply_payload(&state, s, "elicitation", &p(LIVE_ELICITATION), false);
            assert!(
                state.session_activity(s).and_then(|a| a.elicitation).is_some(),
                "{event}: precondition — a form is live"
            );

            let mut rx = state.sse_tx.subscribe();
            apply_payload(&state, s, event, &p(payload), false);
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
        apply_payload(&state, s, "elicitation", &p(LIVE_ELICITATION), false);
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Read","tool_input":{"file_path":"a.rs"}}"#), false);
        assert!(
            state.session_activity(s).and_then(|a| a.elicitation).is_some(),
            "nothing here proves the form was answered"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A live `connect(service)` tool call: the store's credential affordance
    /// (spec §8), MCP-named `mcp__connect__connect`, carrying the connector id as
    /// its `service` argument.
    const LIVE_CONNECT: &str =
        r#"{"session_id":"c0ffee","hook_event_name":"PreToolUse","tool_name":"mcp__connect__connect","tool_input":{"service":"pmcp-notion"}}"#;

    #[tokio::test]
    async fn a_connect_call_raises_the_connect_request_and_rides_the_sessions_delta() {
        // THE round-1 finding (claim 5), executable: before this arm existed a
        // bot could call connect() and NOTHING populated session.connect_request,
        // so the inline Connect card could never raise in production. Now the
        // PreToolUse hook recognises the affordance and sets it.
        let (state, dir) = test_state().await;
        let s = "worker-connect";
        let mut rx = state.sse_tx.subscribe();

        apply_payload(&state, s, "pre_tool", &p(LIVE_CONNECT), false);

        let ask = state
            .session_activity(s)
            .and_then(|a| a.connect_request)
            .expect("the connect tool raised the connect_request");
        assert_eq!(ask.connector_id, "pmcp-notion");

        let d = last_delta(&mut rx, s).expect("a connect ask broadcasts a delta");
        assert_eq!(d["connect_request"]["connector_id"], json!("pmcp-notion"));

        // Re-firing the identical call is not a change → silence.
        apply_payload(&state, s, "pre_tool", &p(LIVE_CONNECT), false);
        assert!(rx.try_recv().is_err(), "an unchanged connect ask must not re-broadcast");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A live `AskUserQuestion` PreToolUse, verbatim off Claude Code 2.1.2xx: the
    /// structured `questions` array with object-options.
    const LIVE_ASK_QUESTION: &str = r#"{"session_id":"c0ffee","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which fruit do you want?","header":"Fruit choice","multiSelect":false,"options":[{"label":"Apple","description":"A crisp and refreshing fruit"},{"label":"Banana","description":"A soft and sweet tropical fruit"},{"label":"Cherry","description":"A small and tart stone fruit"}]}]}}"#;

    /// The `PermissionRequest` Claude raises ~20 ms after the pre-tool leg for the
    /// SAME AskUserQuestion call — the one this app must NOT record as a permission
    /// card (it would fight the answerable question card).
    const LIVE_ASK_QUESTION_PERMISSION: &str = r#"{"session_id":"c0ffee","hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which fruit do you want?"}]}}"#;

    #[tokio::test]
    async fn ask_user_question_raises_an_answerable_question_request_not_a_permission_card() {
        // THE BUG: chat showed a generic ``Run `AskUserQuestion`?`` permission card
        // with dead buttons instead of the real question + its options. The fix
        // surfaces the STRUCTURED question as `question_request` (answerable) and
        // SUPPRESSES the generic permission card for AskUserQuestion so the two do
        // not fight over the one card slot.
        let (state, dir) = test_state().await;
        let s = "worker-question";
        let mut rx = state.sse_tx.subscribe();

        apply_payload(&state, s, "pre_tool", &p(LIVE_ASK_QUESTION), false);
        let ask = state
            .session_activity(s)
            .and_then(|a| a.question_request)
            .expect("the AskUserQuestion pre-tool raised the question_request");
        assert_eq!(ask.question, "Which fruit do you want?");
        assert_eq!(ask.header.as_deref(), Some("Fruit choice"));
        assert_eq!(ask.options, vec!["Apple", "Banana", "Cherry"]);
        assert!(!ask.multi_select);

        let d = last_delta(&mut rx, s).expect("a question ask broadcasts a delta");
        assert_eq!(d["question_request"]["question"], json!("Which fruit do you want?"));
        assert_eq!(d["question_request"]["options"], json!(["Apple", "Banana", "Cherry"]));

        // The permission dialog that follows must NOT record a permission card.
        apply_payload(&state, s, "permission_request", &p(LIVE_ASK_QUESTION_PERMISSION), false);
        assert!(
            state.session_activity(s).and_then(|a| a.permission).is_none(),
            "the AskUserQuestion permission card is suppressed in favour of the question card",
        );
        assert!(
            state.session_activity(s).and_then(|a| a.question_request).is_some(),
            "the answerable question card survives the permission leg",
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_question_request_clears_when_the_call_moves_on() {
        for (event, payload) in [
            ("post_tool", r#"{"tool_name":"AskUserQuestion"}"#),
            ("post_tool_failure", LIVE_POST_TOOL_FAILURE),
            ("stop", "{}"),
            ("session_end", "{}"),
            ("user_prompt", "{}"),
            ("session_start", "{}"),
        ] {
            let (state, dir) = test_state().await;
            let s = "worker-question";
            apply_payload(&state, s, "pre_tool", &p(LIVE_ASK_QUESTION), false);
            assert!(
                state.session_activity(s).and_then(|a| a.question_request).is_some(),
                "{event}: precondition — a question ask is live"
            );

            let mut rx = state.sse_tx.subscribe();
            apply_payload(&state, s, event, &p(payload), false);
            assert!(
                state.session_activity(s).and_then(|a| a.question_request).is_none(),
                "{event} must clear the live question request"
            );
            let d = last_delta(&mut rx, s).unwrap_or_else(|| panic!("{event}: clear broadcasts"));
            assert_eq!(d["question_request"], Value::Null, "{event}: cleared as null");

            state.pool.close().await;
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// A live `request_human_takeover(reason)` call — the Shared Browser
    /// connector's hand-the-wheel affordance, MCP-named
    /// `mcp__browser__request_human_takeover`.
    const LIVE_TAKEOVER: &str = r#"{"session_id":"c0ffee","hook_event_name":"PreToolUse","tool_name":"mcp__browser__request_human_takeover","tool_input":{"reason":"sign in to bank.example and approve the 2FA push"}}"#;

    #[tokio::test]
    async fn a_takeover_call_raises_the_browser_takeover_and_rides_the_sessions_delta() {
        // Phase 3's chat surfacing, executable: the agent asks for a human, and
        // the ask must reach `session.browser_takeover` so chat can draw the
        // "take the wheel" card that opens the takeover panel.
        let (state, dir) = test_state().await;
        let s = "worker-browser";
        let mut rx = state.sse_tx.subscribe();

        apply_payload(&state, s, "pre_tool", &p(LIVE_TAKEOVER), false);

        let ask = state
            .session_activity(s)
            .and_then(|a| a.browser_takeover)
            .expect("the takeover tool raised the browser_takeover ask");
        assert_eq!(ask.session, s, "the panel attaches to the ASKING session");
        assert!(ask.reason.contains("2FA"), "the agent's own sentence: {}", ask.reason);

        let d = last_delta(&mut rx, s).expect("a takeover ask broadcasts a delta");
        assert_eq!(d["browser_takeover"]["session"], json!(s));
        assert!(d["browser_takeover"]["reason"].as_str().unwrap().contains("2FA"));

        // …and it clears when the tool call moves on (same rule as connect).
        apply_payload(&state, s, "post_tool", &p(r#"{"tool_name":"mcp__browser__request_human_takeover"}"#), false);
        assert!(
            state.session_activity(s).and_then(|a| a.browser_takeover).is_none(),
            "the card must not outlive the call"
        );
        let d = last_delta(&mut rx, s).expect("the clear broadcasts too");
        assert_eq!(d["browser_takeover"], Value::Null, "cleared as null");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_notification_carries_its_message_to_the_waiting_line() {
        // The needs-you Notification family (permission_prompt / idle_prompt /
        // agent_needs_input) stashes its `message` on `waiting_message`, which
        // rides the same `sessions` delta and clears on the next resolution
        // event. auth_success / agent_completed surface nothing.
        let (state, dir) = test_state().await;
        let s = "worker-notif";
        let mut rx = state.sse_tx.subscribe();

        // agent_needs_input → the message is carried.
        apply_payload(
            &state,
            s,
            "notification",
            &p(r#"{"notification_type":"agent_needs_input","message":"Claude needs your input"}"#),
            false,
        );
        assert_eq!(
            state.session_activity(s).and_then(|a| a.waiting_message).as_deref(),
            Some("Claude needs your input"),
            "the needs-you message reaches the waiting line",
        );
        let d = last_delta(&mut rx, s).expect("the waiting message broadcasts a delta");
        assert_eq!(d["waiting_message"], json!("Claude needs your input"));

        // A resolution event (the user's next prompt) clears it as null.
        apply_payload(&state, s, "user_prompt", &p("{}"), false);
        assert!(
            state.session_activity(s).and_then(|a| a.waiting_message).is_none(),
            "the line must not outlive the Waiting state",
        );
        let d = last_delta(&mut rx, s).expect("the clear broadcasts too");
        assert_eq!(d["waiting_message"], Value::Null, "cleared as null");

        // auth_success carries no surface — waiting_message stays empty.
        apply_payload(
            &state,
            s,
            "notification",
            &p(r#"{"notification_type":"auth_success","message":"Logged in"}"#),
            false,
        );
        assert!(
            state.session_activity(s).and_then(|a| a.waiting_message).is_none(),
            "auth_success is not a needs-you type — nothing is surfaced",
        );

        // The camel alias is accepted too, and an all-whitespace message is ignored.
        apply_payload(
            &state,
            s,
            "notification",
            &p(r#"{"notificationType":"idle_prompt","message":"   "}"#),
            false,
        );
        assert!(
            state.session_activity(s).and_then(|a| a.waiting_message).is_none(),
            "a blank message surfaces nothing",
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_connect_request_clears_when_the_call_moves_on() {
        // No hook reports the credential outcome (it never touches this plane —
        // the card POSTs it straight to the vault), so "something after it
        // happened" IS the resolution: the tool finishing, the turn ending, the
        // user moving on.
        for (event, payload) in [
            ("post_tool", r#"{"tool_name":"mcp__connect__connect"}"#),
            ("post_tool_failure", LIVE_POST_TOOL_FAILURE),
            ("stop", "{}"),
            ("session_end", "{}"),
            ("user_prompt", "{}"),
            ("session_start", "{}"),
        ] {
            let (state, dir) = test_state().await;
            let s = "worker-connect";
            apply_payload(&state, s, "pre_tool", &p(LIVE_CONNECT), false);
            assert!(
                state.session_activity(s).and_then(|a| a.connect_request).is_some(),
                "{event}: precondition — a connect ask is live"
            );

            let mut rx = state.sse_tx.subscribe();
            apply_payload(&state, s, event, &p(payload), false);
            assert!(
                state.session_activity(s).and_then(|a| a.connect_request).is_none(),
                "{event} must clear the live connect request"
            );
            let d = last_delta(&mut rx, s).unwrap_or_else(|| panic!("{event}: clear broadcasts"));
            assert_eq!(d["connect_request"], Value::Null, "{event}: cleared as null");

            state.pool.close().await;
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[tokio::test]
    async fn permission_request_survives_a_pre_tool_and_a_subagent_stop() {
        // PreToolUse fires BEFORE the permission check, and a subagent finishing
        // says nothing about the main agent's dialog — neither may clear the ask.
        let (state, dir) = test_state().await;
        let s = "worker-perm";
        apply_payload(&state, s, "permission_request", &p(LIVE_PERMISSION_REQUEST), false);
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        assert!(state.session_activity(s).and_then(|a| a.permission).is_some());
        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Read","tool_input":{"file_path":"a.rs"}}"#), false);
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

        apply_payload(&state, s, "post_tool_failure", &p(LIVE_POST_TOOL_FAILURE), false);
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
            false,
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
            false,
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

        track_conversation_pointer(&state, s, "", Some("conv-a")).await;
        assert!(woke(&state, s).await, "the first id is a change — the tailer must re-resolve");
        let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
        assert_eq!(row.cc_conversation_id, "conv-a");

        // A terminal-side `--resume` / `/clear`: the id MOVED.
        track_conversation_pointer(&state, s, "", Some("conv-b")).await;
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

        track_conversation_pointer(&state, s, "", Some("conv-a")).await;
        assert!(woke(&state, s).await);
        for _ in 0..3 {
            track_conversation_pointer(&state, s, "", Some("conv-a")).await;
        }
        assert!(!woke(&state, s).await, "an unchanged id must not wake the tailer");

        // A missing / empty id is a no-op, not a pointer reset.
        track_conversation_pointer(&state, s, "", None).await;
        track_conversation_pointer(&state, s, "", Some("")).await;
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
        track_conversation_pointer(&state, s, "", Some("conv-a")).await;
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
            track_conversation_pointer(&state, s, "", Some(bad)).await;
            let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
            assert_eq!(
                row.cc_conversation_id, "conv-a",
                "{bad:?} must never become the tracked pointer"
            );
            assert!(!woke(&state, s).await, "{bad:?} must not wake the tailer either");
        }

        // …and the real shapes still land.
        track_conversation_pointer(&state, s, "", Some("550e8400-e29b-41d4-a716-446655440000")).await;
        let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
        assert_eq!(row.cc_conversation_id, "550e8400-e29b-41d4-a716-446655440000");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── S2: pane-attributed pointer adoption (§R2.2) ────────────────────────

    /// The truth table, pure. Every branch's fail-safe direction is "keep the
    /// lead's OWN conversation" — never adopt a foreign one.
    #[test]
    fn pane_attribution_only_lets_the_lead_pane_move_a_team_hosts_pointer() {
        use PointerAction::*;
        // A tmux lead firing from its own pane: adopt, exactly as pre-wave.
        assert_eq!(attribute_pointer("%3", Some("%3"), true), Adopt);
        // A teammate pane on the same host: NEVER moves the lead's pointer.
        assert_eq!(attribute_pointer("%7", Some("%3"), true), RecordOnly);
        // Lead pane unresolvable this tick (pane churn / ambiguous layout):
        // a pane we cannot prove is the lead does not get to move the pointer.
        assert_eq!(attribute_pointer("%7", None, true), RecordOnly);
        // Empty pane on a TMUX host = a pre-upgrade hook command, unattributable.
        // Freeze rather than guess; the next session start rewrites the hook.
        assert_eq!(attribute_pointer("", Some("%3"), true), RecordOnly);
        assert_eq!(attribute_pointer("", None, true), RecordOnly);
        // Empty pane on a NATIVE host = the lead itself: a native session has no
        // pane at all, while every teammate is a tmux pane carrying a `%id`.
        // Adopting here is what keeps a native lead's thread live (the live box's
        // shape — see ~/team-gap/PHASE0-PROBE.md).
        assert_eq!(attribute_pointer("", None, false), Adopt);
        // …and a teammate `%id` reaching a native host is still not the lead.
        assert_eq!(attribute_pointer("%7", None, false), RecordOnly);
    }

    #[tokio::test]
    async fn a_teammate_pane_never_repoints_the_lead_but_is_recorded() {
        let (state, dir) = test_state().await;
        let s = "team-lead-1";
        db::sessions::insert_minimal(&state.pool, s, "/tmp", "claude").await.unwrap();
        let host = TeamHost { lead_pane: Some("%3".into()), tmux_runtime: true };

        // The lead's own pane adopts, as always.
        track_pointer_attributed(&state, s, "%3", Some("lead-conv"), Some(&host)).await;
        assert!(woke(&state, s).await);
        let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
        assert_eq!(row.cc_conversation_id, "lead-conv");

        // A teammate's SessionStart: same session name, same hook token, its OWN
        // conversation id. This is the measured live bug (H1). The pointer must
        // not move…
        track_pointer_attributed(&state, s, "%7", Some("mate-conv"), Some(&host)).await;
        let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
        assert_eq!(
            row.cc_conversation_id, "lead-conv",
            "a teammate pane must never repoint the lead"
        );
        assert!(!woke(&state, s).await, "…and must not wake the lead's tailer either");

        // …and must instead be LEARNED as `pane → conversation` (§R2.3), which is
        // what makes a real teammate thread buildable later.
        assert_eq!(state.pane_conversation(s, "%7").as_deref(), Some("mate-conv"));
        assert_eq!(
            state.pane_conversation(s, "%3").as_deref(),
            Some("lead-conv"),
            "the lead's own pane is in the map too, so the map is total"
        );

        // An unattributable (empty) pane on a TMUX team host: also frozen —
        // strictly better than adopting whichever pane happened to fire.
        track_pointer_attributed(&state, s, "", Some("legacy-conv"), Some(&host)).await;
        let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
        assert_eq!(row.cc_conversation_id, "lead-conv");
        assert!(
            state.pane_conversation(s, "").is_none(),
            "an empty pane identifies nothing and must not become a map key"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_native_team_host_still_adopts_its_own_paneless_hook() {
        // The live box's shape: the lead runs native (no tmux pane of its own)
        // while Claude spawns its teammates as tmux panes — on a separate tmux
        // server, even. Refusing an empty pane here would freeze the pointer of
        // exactly the lead S1 just made chattable.
        let (state, dir) = test_state().await;
        let s = "team-lead-native";
        db::sessions::insert_minimal(&state.pool, s, "/tmp", "claude").await.unwrap();
        let host = TeamHost { lead_pane: None, tmux_runtime: false };

        track_pointer_attributed(&state, s, "", Some("lead-conv"), Some(&host)).await;
        let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
        assert_eq!(row.cc_conversation_id, "lead-conv", "a native lead must keep adopting");

        // A teammate pane reaching that native host is still refused + recorded.
        track_pointer_attributed(&state, s, "%12", Some("mate-conv"), Some(&host)).await;
        let row = db::sessions::get(&state.pool, s).await.unwrap().unwrap();
        assert_eq!(row.cc_conversation_id, "lead-conv");
        assert_eq!(state.pane_conversation(s, "%12").as_deref(), Some("mate-conv"));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_non_team_session_adopts_from_any_pane_exactly_as_before() {
        // BASE-APP PARITY. `host = None` is what `track_conversation_pointer`
        // passes for every session that does not host a real team — i.e. all of
        // them, in the base app. No pane is consulted, nothing is recorded, the
        // pointer follows the hook as it always has.
        let (state, dir) = test_state().await;
        let s = "plain-1";
        db::sessions::insert_minimal(&state.pool, s, "/tmp", "claude").await.unwrap();

        // Empty pane (native session, or a pre-upgrade hook command): adopts.
        track_pointer_attributed(&state, s, "", Some("conv-a"), None).await;
        assert!(woke(&state, s).await);
        assert_eq!(
            db::sessions::get(&state.pool, s).await.unwrap().unwrap().cc_conversation_id,
            "conv-a"
        );
        // A pane id (an ordinary tmux session): also adopts — the guard is
        // team-host-scoped, so a plain session is never pane-discriminated.
        track_pointer_attributed(&state, s, "%4", Some("conv-b"), None).await;
        assert!(woke(&state, s).await);
        assert_eq!(
            db::sessions::get(&state.pool, s).await.unwrap().unwrap().cc_conversation_id,
            "conv-b"
        );
        assert!(
            state.pane_conversation(s, "%4").is_none(),
            "a non-team session must not even populate the pane map"
        );

        // And end-to-end through the real entry point (which resolves
        // `is_team_host` itself — false here, since `team_name` is NULL).
        track_conversation_pointer(&state, s, "%9", Some("conv-c")).await;
        assert_eq!(
            db::sessions::get(&state.pool, s).await.unwrap().unwrap().cc_conversation_id,
            "conv-c",
            "the un-teamed path must be byte-identical to pre-wave behaviour"
        );

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

    #[tokio::test]
    async fn teammate_session_end_is_ignored() {
        // Since Claude Code 2.1.232 a named in-process teammate has its OWN Claude
        // session and fires its own lifecycle hooks under the PARENT pane's
        // `$SUPERMUX_SESSION`. `TaskStop` on such a teammate emits SessionEnd with
        // reason "other". It must NOT force the lead Stopped (the lead is still
        // working) and must not touch the lead's live activity.
        let (state, dir) = test_state().await;
        let s = "lead-teammate-end";

        apply_payload(
            &state,
            s,
            "pre_tool",
            &p(r#"{"tool_name":"Bash","tool_input":{"command":"sleep 1"}}"#),
            false,
        );
        assert!(state.session_activity(s).is_some(), "precondition: a live activity");

        apply_payload(
            &state,
            s,
            "session_end",
            &p(r#"{"session_id":"x","agent_type":"general-purpose","reason":"other"}"#),
            // the caller decided this payload is a teammate's (its session_id is
            // not the lead's tracked conversation id)
            true,
        );

        assert!(
            state.session_activity(s).and_then(|a| a.activity).is_some(),
            "a teammate SessionEnd must NOT clear the lead's activity"
        );
        assert_eq!(
            state.take_forced_status(s),
            None,
            "a teammate SessionEnd must NOT force the lead Stopped"
        );

        // The lead's OWN SessionEnd (no agent_type) still forces Stopped.
        apply_payload(&state, s, "session_end", &p("{}"), false);
        assert_eq!(state.take_forced_status(s), Some(Status::Stopped));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn teammate_session_start_is_ignored() {
        // The teammate's startup hook likewise must not read as "the lead
        // rebooted": it would clear the pending forced-stop and wipe the lead's
        // in-progress turn state mid-turn.
        use crate::sessions::status::{HookEvent, TurnState};
        let (state, dir) = test_state().await;
        let s = "lead-teammate-start";

        state.set_error(s, "billing_error".into(), "card declined".into());
        state.set_forced_status(s, Status::Stopped);
        state.record_hook(s, HookEvent::UserPromptSubmit);
        state.record_hook(s, HookEvent::PreToolUse);
        assert_ne!(
            state.turn_state(s),
            TurnState::default(),
            "precondition: a turn is in progress"
        );

        apply_payload(
            &state,
            s,
            "session_start",
            &p(r#"{"session_id":"x","agent_type":"general-purpose","source":"startup"}"#),
            // the caller decided this payload is a teammate's (its session_id is
            // not the lead's tracked conversation id)
            true,
        );

        assert_eq!(
            state.take_forced_status(s),
            Some(Status::Stopped),
            "a teammate SessionStart must NOT clear the lead's forced status"
        );
        assert!(
            state.session_activity(s).and_then(|a| a.error).is_some(),
            "a teammate SessionStart must NOT clear the lead's error"
        );
        assert_ne!(
            state.turn_state(s),
            TurnState::default(),
            "a teammate SessionStart must NOT reset the lead's turn state"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn foreign_agent_payload_needs_both_agent_type_and_a_different_id() {
        // No agent_type at all: always the lead's own payload.
        assert!(!is_foreign_agent_payload(&p(r#"{"session_id":"lead-1"}"#), Some("lead-1")));
        assert!(!is_foreign_agent_payload(&p(r#"{"session_id":"other"}"#), Some("lead-1")));

        // agent_type but nothing tracked yet: accept it as the lead's, so a lead
        // launched as `claude --agent <name>` can establish its own id instead of
        // being masked forever.
        assert!(!is_foreign_agent_payload(
            &p(r#"{"session_id":"lead-1","agent_type":"reviewer"}"#),
            None
        ));
        assert!(!is_foreign_agent_payload(
            &p(r#"{"session_id":"lead-1","agent_type":"reviewer"}"#),
            Some("")
        ));

        // agent_type + the SAME id as the lead's tracked conversation: the
        // `--agent` lead's own lifecycle, must still be handled.
        assert!(!is_foreign_agent_payload(
            &p(r#"{"session_id":"lead-1","agent_type":"reviewer"}"#),
            Some("lead-1")
        ));

        // agent_type + a DIFFERENT id: a real in-process teammate.
        assert!(is_foreign_agent_payload(
            &p(r#"{"session_id":"teammate-9","agent_type":"general-purpose"}"#),
            Some("lead-1")
        ));
        // agent_type, a tracked lead id, and no session_id at all: not the lead's.
        assert!(is_foreign_agent_payload(
            &p(r#"{"agent_type":"general-purpose"}"#),
            Some("lead-1")
        ));

        // An empty / whitespace agent_type counts as ABSENT (never mask a real
        // lifecycle event on it: the failure mode is a zombie session).
        assert!(!is_foreign_agent_payload(
            &p(r#"{"session_id":"teammate-9","agent_type":""}"#),
            Some("lead-1")
        ));
        assert!(!is_foreign_agent_payload(
            &p(r#"{"session_id":"teammate-9","agent_type":"  "}"#),
            Some("lead-1")
        ));
    }

    /// The wedge the `announces_conversation_switch` escape hatch exists for.
    ///
    /// `is_foreign_agent_payload` is CORRECT to call this foreign — it cannot tell
    /// an `--agent` lead's new conversation from a teammate's by id alone — which
    /// is exactly why the pointer gate must not rely on it by itself. Pinned so a
    /// future tightening of the classifier cannot silently re-freeze the pointer.
    #[test]
    fn an_agent_leads_own_post_clear_start_still_classifies_as_foreign() {
        assert!(is_foreign_agent_payload(
            &p(r#"{"session_id":"conv-B","agent_type":"reviewer","source":"clear"}"#),
            Some("conv-A")
        ));
    }

    /// `/clear` and a terminal-side `--resume` are the two switches only the pane's
    /// REAL agent can announce, so they release the pointer gate. `startup` must
    /// NOT: that is the captured shape of an in-process teammate's SessionStart,
    /// and admitting it would re-open the transcript-stealing bug the filter fixed.
    /// `compact` must not either — compaction keeps the same file and id, so there
    /// is nothing to follow and a compacting teammate would steal the pointer.
    #[test]
    fn only_clear_and_resume_announce_a_conversation_switch() {
        assert!(announces_conversation_switch(&p(r#"{"source":"clear"}"#)));
        assert!(announces_conversation_switch(&p(r#"{"source":"resume"}"#)));

        assert!(!announces_conversation_switch(&p(r#"{"source":"startup"}"#)));
        assert!(!announces_conversation_switch(&p(r#"{"source":"compact"}"#)));
        assert!(!announces_conversation_switch(&p(r#"{"source":""}"#)));
        assert!(!announces_conversation_switch(&p(r#"{}"#)));
        // A teammate's UserPromptSubmit carries no `source` at all, so the every-
        // prompt corruption path stays closed.
        assert!(!announces_conversation_switch(
            &p(r#"{"session_id":"teammate-9","agent_type":"general-purpose"}"#)
        ));
        assert!(!has_agent_type(&p(r#"{"agent_type":" "}"#)));
    }

    #[tokio::test]
    async fn teammate_user_prompt_leaves_the_lead_error_and_subagents_alone() {
        // A teammate fires UserPromptSubmit every time the lead messages it. That
        // is not the lead acting, so it must not clear the lead's error badge nor
        // force-0 its outstanding-subagent count mid-turn.
        let (state, dir) = test_state().await;
        let s = "lead-teammate-prompt";

        state.set_error(s, "billing_error".into(), "card declined".into());
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        assert_eq!(subagents(&state, s), 2, "precondition: two outstanding");

        apply_payload(
            &state,
            s,
            "user_prompt_submit",
            &p(r#"{"session_id":"teammate-9","agent_type":"general-purpose"}"#),
            true,
        );
        assert!(
            state.session_activity(s).and_then(|a| a.error).is_some(),
            "a teammate prompt must NOT clear the lead's error"
        );
        assert_eq!(subagents(&state, s), 2, "a teammate prompt must NOT reset the count");

        // The lead's OWN prompt still does both.
        apply_payload(&state, s, "user_prompt_submit", &p("{}"), false);
        assert!(state.session_activity(s).and_then(|a| a.error).is_none());
        assert_eq!(subagents(&state, s), 0);

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

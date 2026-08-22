//! The trigger table, end-to-end over the REAL hook endpoint.
//!
//! Every push in supermux is now raised at a hook arm. These tests POST hook
//! bodies at `/api/_internal/hook` exactly as the installed hook command does
//! and then read `state.push_attempts` — the ring `send_push_for` writes on
//! every fan-out, muted or not. What lands in that ring IS what would have
//! reached a phone.
//!
//! Two halves, and the second one is the point:
//!
//! * **The table fires.** A permission dialog, Claude's own notice, a turn end,
//!   a turn failure and a real session death each produce exactly one attempt,
//!   in the right category.
//! * **Nothing else does.** The audit's false-positive classes — a drift-heal
//!   commit at session start, the word "approve" in scrollback, 30 s of silence
//!   mid-turn, a restart wiping turn state, a plain shell going idle, `/clear`
//!   and `/exit` bouncing to a shell prompt — are driven here and must produce
//!   ZERO attempts. That is the property the redesign exists for, and it holds
//!   BY CONSTRUCTION: the status detector has no code path to `crate::push`.
//!
//! The subscription is a loopback endpoint on port 1 (reserved/closed
//! everywhere standard) so the fan-out records its attempt without a network.

use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Method, Request};
use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};
use tower::ServiceExt;

const BEARER: &str = "push-trigger-bearer";
const TOK: &str = "push-trigger-hook-token";
const SESSION: &str = "deploy-fix";

/// Long enough for the spawned notify task to finish its DB reads and its
/// (immediately refused) HTTPS connect. Finish pushes additionally wait out
/// `notify::FINISH_GRACE`, so those get their own longer wait.
const SETTLE: Duration = Duration::from_millis(900);

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-pushtrig-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: BEARER.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    db::sessions::insert_minimal(&state.pool, SESSION, "/tmp", "claude")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, SESSION, TOK)
        .await
        .unwrap();
    // A "definitely closed" subscriber: the connect refuses immediately, so the
    // attempt is recorded without burning seconds on a hung handshake.
    db::push::upsert(
        &state.pool,
        "https://127.0.0.1:1/x",
        "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
        "tBHItJI5svbpez7KI4CCXg",
    )
    .await
    .unwrap();
    let app = http::router(state.clone());
    (state, app, dir)
}

async fn hook(app: &axum::Router, event: &str, payload: serde_json::Value) {
    let body = serde_json::json!({ "session": SESSION, "event": event, "payload": payload });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/_internal/hook")
        .header(header::CONTENT_TYPE, "application/json")
        .header("X-Supermux-Hook-Token", TOK)
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200, "the hook endpoint must accept {event}");
}

/// Categories of every recorded attempt, oldest first.
fn categories(state: &AppState) -> Vec<String> {
    let mut v: Vec<String> = state
        .push_attempts
        .snapshot()
        .into_iter()
        .map(|a| a.category)
        .collect();
    v.reverse(); // the snapshot is newest-first
    v
}

async fn cleanup(state: &AppState, dir: std::path::PathBuf) {
    state.pending_pushes.iter().for_each(|e| e.value().abort());
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The VERBATIM live capture (Claude Code 2.1.227, byte-identical on 2.1.231).
fn live_permission_request() -> serde_json::Value {
    serde_json::json!({
        "session_id": "a2a3a5c5",
        "permission_mode": "default",
        "hook_event_name": "PermissionRequest",
        "tool_name": "Bash",
        "tool_input": { "command": "cargo test", "description": "run the test suite" },
        "permission_suggestions": [],
    })
}

// ── the table fires ─────────────────────────────────────────────────────────

#[tokio::test]
async fn a_permission_dialog_pushes_once_and_a_re_fire_does_not() {
    let (state, app, dir) = setup().await;

    hook(&app, "permission_request", live_permission_request()).await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(
        categories(&state),
        vec!["agent_waiting"],
        "the dialog rings once"
    );

    // Claude re-emits the identical dialog payload; the ask comparison dedupes
    // it, so the phone must not buzz again for the same block.
    hook(&app, "permission_request", live_permission_request()).await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(
        categories(&state),
        vec!["agent_waiting"],
        "an identical re-fire must not produce a second push",
    );

    // The body carries the agent's own words, via the same preview the owner
    // can query. (The ring stores title-only by privacy posture.)
    let payload = supermux_server::notify::build_payload(
        &state,
        SESSION,
        &supermux_server::notify::NotifEvent::PermissionAsked,
    )
    .await
    .expect("a payload for a live dialog");
    assert_eq!(payload.title, SESSION);
    assert_eq!(
        payload.body,
        "Needs permission — ⚡ run the test suite (Bash)"
    );
    assert_eq!(payload.tier, supermux_server::notify::Tier::Attention);

    cleanup(&state, dir).await;
}

/// B5/T1.5 — the `Notification` arm is DELIBERATELY not a push trigger, and
/// this test locks that decision down rather than deleting the harvest's
/// coverage of it.
///
/// The integration branch pushed on Claude's own `Notification` hook. Porting
/// that verbatim was rejected on `main`'s own evidence: `status.rs` documents
/// that Claude Code fires `Notification` ~60 s AFTER a turn finishes ("Claude
/// is waiting for your input"), which is exactly why the status classifier
/// already refuses to treat `Notification` as decisive unless it is the newest
/// signal AND a turn is in progress. Wired as a trigger it would buzz the phone
/// a minute after every completed turn, duplicating the `TurnFinished` push
/// that just fired — the precise noise this fase exists to remove.
///
/// `NotifEvent::AgentNotice` stays in the enum and `compose()` still renders it
/// verbatim (see the unit tests in `notify.rs`), so wiring it later is a
/// one-line change behind evidence that the 60 s fire can be told apart.
#[tokio::test]
async fn claudes_own_notice_does_not_push() {
    let (state, app, dir) = setup().await;

    hook(
        &app,
        "notification",
        serde_json::json!({
            "session_id": "a2a3a5c5",
            "hook_event_name": "Notification",
            "message": "Claude is waiting for your input",
        }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;
    assert!(
        categories(&state).is_empty(),
        "a bare Notification must not ring — it also fires ~60s after a finished turn",
    );

    // A real permission dialog, by contrast, does ring: the arm being inert is
    // specific to `Notification`, not a general loss of needs-attention pushes.
    hook(&app, "permission_request", live_permission_request()).await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(categories(&state), vec!["agent_waiting"]);

    cleanup(&state, dir).await;
}

#[tokio::test]
async fn a_finished_turn_pushes_agent_finished_when_the_user_opted_in() {
    let (state, app, dir) = setup().await;
    // The unread tier ships OFF; opt in explicitly so this test measures the
    // TRIGGER rather than the default.
    db::push::set_pref(&state.pool, db::push::NotifCategory::AgentFinished, true)
        .await
        .unwrap();

    hook(
        &app,
        "stop",
        serde_json::json!({ "hook_event_name": "Stop" }),
    )
    .await;
    // The finish waits out the transcript-flush grace before it composes.
    tokio::time::sleep(Duration::from_millis(3000)).await;
    assert_eq!(categories(&state), vec!["agent_finished"]);

    cleanup(&state, dir).await;
}

/// B5 gate G2(b) — `agent_finished` ships **ON**, and the mute machinery is
/// still exercised.
///
/// The integration branch shipped this category default-OFF (`default_on()`).
/// That flip was declined here, because `main` had meanwhile grown three
/// mitigations aimed at exactly the noise it was avoiding: the 2 s trailing
/// coalesce, the 15 s `T_TEAM_FINISH` window for a team lead bouncing through
/// Idle, and `push_should_fire`'s subagent gate. Silently muting a category the
/// user has been receiving — with no UI event to explain it — is a worse
/// trade than the noise those three already suppress. No measurement of
/// residual noise was offered to justify it, so the conservative default wins
/// and an explicit stored pref still decides in both directions.
///
/// What the branch's version really tested is the DIAGNOSTIC: that a muted send
/// records why. That is preserved verbatim by muting explicitly instead of
/// relying on the default.
#[tokio::test]
async fn a_muted_category_records_why_it_did_not_ring() {
    let (state, app, dir) = setup().await;

    // The default is ON (see above), so mute it explicitly — the point of this
    // test is the ring's answer, not which way the default points.
    db::push::set_pref(&state.pool, db::push::NotifCategory::AgentFinished, false)
        .await
        .unwrap();

    hook(&app, "stop", serde_json::json!({})).await;
    tokio::time::sleep(Duration::from_millis(3000)).await;

    let snap = state.push_attempts.snapshot();
    let row = snap.first().expect("a muted attempt is still recorded");
    assert_eq!(row.category, "agent_finished");
    assert!(row.muted);
    assert_eq!(
        row.reason.as_deref(),
        Some("global:agent_finished"),
        "'why didn't my phone ring' must stay answerable",
    );
    assert_eq!(row.attempted, 0, "a muted send never touches the network");

    cleanup(&state, dir).await;
}

/// The other half of the same gate: with nothing touched, a finished turn DOES
/// ring. This is the assertion that would fail if someone reinstated
/// `default_on()` without saying so.
#[tokio::test]
async fn a_finished_turn_rings_by_default() {
    let (state, app, dir) = setup().await;

    hook(&app, "stop", serde_json::json!({})).await;
    tokio::time::sleep(Duration::from_millis(3000)).await;

    let snap = state.push_attempts.snapshot();
    let row = snap.first().expect("the finish was attempted");
    assert_eq!(row.category, "agent_finished");
    assert!(
        !row.muted,
        "agent_finished ships ON (gate G2b); the branch's default_on() flip was declined",
    );

    cleanup(&state, dir).await;
}

#[tokio::test]
async fn a_failed_turn_pushes_the_error_pair() {
    let (state, app, dir) = setup().await;

    hook(
        &app,
        "stop_failure",
        serde_json::json!({
            "hook_event_name": "StopFailure",
            "error_type": "rate_limit",
            "message": "You've reached your usage limit",
        }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(categories(&state), vec!["agent_error"]);

    cleanup(&state, dir).await;
}

#[tokio::test]
async fn a_session_that_dies_pushes_but_the_user_typing_clear_or_exit_never_does() {
    // The single most-hated false positive: the user's own keystroke ringing
    // their own phone. `clear` / `logout` / `prompt_input_exit` are the human
    // at the keyboard; only an unexplained end is a death.
    for reason in ["clear", "logout", "prompt_input_exit"] {
        let (state, app, dir) = setup().await;
        hook(&app, "session_end", serde_json::json!({ "reason": reason })).await;
        tokio::time::sleep(SETTLE).await;
        assert!(
            categories(&state).is_empty(),
            "SessionEnd reason={reason} is the user acting — it must never push",
        );
        cleanup(&state, dir).await;
    }

    for payload in [
        serde_json::json!({ "reason": "other" }),
        serde_json::json!({}),
    ] {
        let (state, app, dir) = setup().await;
        hook(&app, "session_end", payload.clone()).await;
        tokio::time::sleep(SETTLE).await;
        assert_eq!(
            categories(&state),
            vec!["agent_stopped"],
            "a real death ({payload}) must push",
        );
        cleanup(&state, dir).await;
    }
}

#[tokio::test]
async fn a_subagent_finishing_is_never_announced_as_the_turn_being_done() {
    // `SubagentStop` shares the parent's hook token and arrives constantly on a
    // multi-agent turn. It has its own arm and structurally cannot reach the
    // `Stop` arm — this pins that it stays that way.
    let (state, app, dir) = setup().await;
    db::push::set_pref(&state.pool, db::push::NotifCategory::AgentFinished, true)
        .await
        .unwrap();

    hook(&app, "subagent_start", serde_json::json!({})).await;
    hook(&app, "subagent_stop", serde_json::json!({})).await;
    hook(&app, "subagent_stop", serde_json::json!({})).await;
    tokio::time::sleep(Duration::from_millis(3000)).await;
    assert!(categories(&state).is_empty(), "a subagent is not the turn");

    cleanup(&state, dir).await;
}

// ── nothing else does ───────────────────────────────────────────────────────

/// The audit's whole false-positive family, killed BY CONSTRUCTION.
///
/// Class 1 (a drift-heal commit at session start), 2 (the word "approve"
/// sitting in Claude's scrollback), 3 (30 s of silence mid-turn), 4 (a restart
/// wiping turn state and re-classifying), 5 (a plain shell going idle) and 6
/// (`/exit` bouncing to a shell prompt) were all ONE bug wearing six hats: the
/// status detector could reach the push transport. Enumerating the six as
/// behavioural tests would only ever sample that surface — regex banks, the PTY
/// heartbeat, the idle timeout and restart re-classification can produce
/// transitions this test would not think to script.
///
/// So the pin is structural, not behavioural — but B5/T2 made it a *scoped*
/// structural pin rather than a total one, and the difference is deliberate.
///
/// The harvest's version asserted that the detector could not reach the push
/// module AT ALL, which it achieved by deleting the detector path outright.
/// That was rejected: `codex` / `shell` panes emit no hooks, so the
/// detector is their ONLY route to a notification, and deleting it would have
/// silently ended notifications for every non-Claude session. It also would
/// have taken the 15 s team-finish window and the subagent gate with it.
///
/// What survives is the property that actually mattered. The CLASSIFIER
/// (`status.rs`) and the terminal layer (`pty.rs`) still have no edge to push
/// whatsoever — no transition they compute can notify anything, because there
/// is nothing there to call. `auto_actions.rs` keeps exactly one, behind
/// `notify::provider_emits_hooks`, and `notify_one_writer.rs` pins that a
/// hook-capable session never takes it.
#[test]
fn the_status_classifier_has_no_edge_to_the_push_transport() {
    for file in ["src/sessions/status.rs", "src/sessions/pty.rs"] {
        let src = std::fs::read_to_string(file).unwrap_or_else(|e| panic!("{file}: {e}"));
        // Strip comments so the doc-comments EXPLAINING the absence don't trip
        // the check that enforces it.
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in ["crate::push", "send_push", "notify_event", "NotifCategory"] {
            assert!(
                !code.contains(forbidden),
                "{file} references `{forbidden}` — the status classifier must not be able to \
                 notify anything. Push triggers belong at the hook arms (`crate::notify`).",
            );
        }
    }
}

/// The detector's single remaining edge is GATED, and this pins the gate rather
/// than the absence.
///
/// A future edit that reaches `send_push_for` from a second place in
/// `auto_actions.rs`, or that drops the provider check, reintroduces the
/// two-writer race — which is silent at runtime. Counting the edge here is what
/// makes that edit loud.
#[test]
fn the_detectors_only_push_edge_is_behind_the_provider_gate() {
    let src = std::fs::read_to_string("src/sessions/auto_actions.rs").unwrap();
    let code: String = src
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");

    assert_eq!(
        code.matches("send_push_for").count(),
        1,
        "the detector fallback sends from exactly one place; a second is a \
         second writer of pending_pushes",
    );
    assert!(
        code.contains("provider_emits_hooks"),
        "the detector's push path must be gated on `notify::provider_emits_hooks` \
         — without it, Claude sessions get two competing writers and the loser's \
         push vanishes silently",
    );
}

#[tokio::test]
async fn nothing_but_the_table_touches_the_ring_over_a_full_turn() {
    // A realistic turn — prompt, tools, a subagent, a tool failure, tool
    // boundaries — carries a dozen hook events and must produce exactly ZERO
    // notifications. Only the table's own arms may ring.
    let (state, app, dir) = setup().await;
    db::push::set_pref(&state.pool, db::push::NotifCategory::AgentFinished, true)
        .await
        .unwrap();

    hook(
        &app,
        "session_start",
        serde_json::json!({ "session_id": "conv-1" }),
    )
    .await;
    hook(
        &app,
        "user_prompt",
        serde_json::json!({ "session_id": "conv-1" }),
    )
    .await;
    for _ in 0..3 {
        hook(
            &app,
            "pre_tool",
            serde_json::json!({ "tool_name": "Read", "tool_input": { "file_path": "a.rs" } }),
        )
        .await;
        hook(
            &app,
            "post_tool",
            serde_json::json!({ "tool_name": "Read" }),
        )
        .await;
    }
    hook(&app, "subagent_start", serde_json::json!({})).await;
    hook(&app, "subagent_stop", serde_json::json!({})).await;
    hook(
        &app,
        "post_tool_failure",
        serde_json::json!({ "tool_name": "Read", "error": "File does not exist." }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;

    assert!(
        categories(&state).is_empty(),
        "a turn in progress must be silent; got {:?}",
        categories(&state),
    );

    cleanup(&state, dir).await;
}

#[tokio::test]
async fn a_finish_is_not_pushed_to_a_session_the_user_is_already_watching() {
    // The calm tier is suppressed across devices when the session is being
    // viewed anywhere — the user watched it land, a phone buzz adds nothing.
    // v1 signal: a chat store is attached (true while a chat WS is up, plus the
    // tailer's idle grace).
    let (state, app, dir) = setup().await;
    db::push::set_pref(&state.pool, db::push::NotifCategory::AgentFinished, true)
        .await
        .unwrap();

    let _viewer = state.chat_store_for(SESSION);
    hook(&app, "stop", serde_json::json!({})).await;
    tokio::time::sleep(Duration::from_millis(3000)).await;
    assert!(
        categories(&state).is_empty(),
        "a finish must not ring a phone for a session on screen; got {:?}",
        categories(&state),
    );

    // A BLOCKING event is never server-suppressed: it blocks the agent, and the
    // worst case is the device layer eating the banner on the one device that
    // is already looking.
    hook(&app, "permission_request", live_permission_request()).await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(
        categories(&state),
        vec!["agent_waiting"],
        "needs-attention is never server-suppressed",
    );

    // Detach the viewer → the finish rings again.
    state.drop_chat_store(SESSION);
    hook(&app, "user_prompt", serde_json::json!({})).await;
    hook(&app, "stop", serde_json::json!({})).await;
    tokio::time::sleep(Duration::from_millis(3000)).await;
    assert_eq!(
        categories(&state),
        vec!["agent_waiting", "agent_finished"],
        "with nobody watching, the finish rings",
    );

    cleanup(&state, dir).await;
}

// ── "what would my phone say right now" ─────────────────────────────────────

async fn preview(app: &axum::Router, query: &str) -> serde_json::Value {
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/push/preview?{query}"))
        .header(header::AUTHORIZATION, format!("Bearer {BEARER}"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200, "preview {query}");
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn the_preview_endpoint_reads_the_closing_line_off_disk_verbatim() {
    // The case that matters for an actual phone notification: nobody has a chat
    // WS attached, so the in-memory ring is empty and the body has to come from
    // the transcript on disk. The `Stop` push waits out a transcript-flush
    // grace precisely so this read finds the final entry.
    let (state, app, dir) = setup().await;

    // Point the session at a temp project dir with a real-shaped transcript.
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    db::sessions::set_dir(&state.pool, SESSION, work.to_str().unwrap())
        .await
        .unwrap();
    let conv = "550e8400-e29b-41d4-a716-446655440000";
    db::sessions::track_cc_conversation_id(&state.pool, SESSION, conv)
        .await
        .unwrap();

    let proj = supermux_server::sessions::resumable::project_dir_for(work.to_str().unwrap());
    std::fs::create_dir_all(&proj).unwrap();
    let transcript = proj.join(format!("{conv}.jsonl"));
    let closing = "DONE-MARKER-7 all checks pass";
    std::fs::write(
        &transcript,
        format!(
            "{}\n{}\n",
            serde_json::json!({
                "type": "user", "uuid": "u1", "timestamp": "2026-08-16T10:00:00.000Z",
                "message": { "role": "user", "content": [{ "type": "text", "text": "ship it" }] },
            }),
            serde_json::json!({
                "type": "assistant", "uuid": "a1", "timestamp": "2026-08-16T10:00:05.000Z",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": closing }] },
            }),
        ),
    )
    .unwrap();

    let v = preview(&app, &format!("session={SESSION}&event=stop")).await;
    assert_eq!(
        v["data"]["payload"]["body"], closing,
        "the lock screen shows the agent's ACTUAL closing line, verbatim",
    );
    assert_eq!(v["data"]["payload"]["tier"], "unread");
    assert_eq!(v["data"]["payload"]["tag"], format!("session:{SESSION}"));
    // …and it says whether it would actually ring, which the ring cannot.
    // `agent_finished` ships ON (gate G2b — see
    // `a_finished_turn_rings_by_default`), so an untouched install previews as
    // un-muted.
    assert_eq!(v["data"]["muted"], false, "the unread tier ships ON");
    assert_eq!(v["data"]["muted_reason"], serde_json::Value::Null);

    let _ = std::fs::remove_file(&transcript);
    cleanup(&state, dir).await;
}

#[tokio::test]
async fn the_preview_shows_the_live_dialog_and_the_badge() {
    let (state, app, dir) = setup().await;
    hook(&app, "permission_request", live_permission_request()).await;
    tokio::time::sleep(SETTLE).await;

    let v = preview(&app, &format!("session={SESSION}&event=permission")).await;
    assert_eq!(
        v["data"]["payload"]["body"],
        "Needs permission — ⚡ run the test suite (Bash)"
    );
    assert_eq!(
        v["data"]["payload"]["url"],
        format!("/focus/{SESSION}#pending")
    );
    assert_eq!(v["data"]["payload"]["renotify"], true);
    assert_eq!(
        v["data"]["payload"]["badge"], 1,
        "one bot is blocked on the human"
    );
    assert_eq!(v["data"]["muted"], false);

    cleanup(&state, dir).await;
}

#[tokio::test]
async fn a_session_the_user_muted_stays_silent_and_the_ring_names_the_bot() {
    // The per-bot opt-in: `off` mutes every session-scoped tier, and the
    // diagnostics say WHICH layer did it.
    let (state, app, dir) = setup().await;
    db::sessions::set_notif_policy(
        &state.pool,
        SESSION,
        supermux_server::notify::NotifPolicy::Off,
    )
    .await
    .unwrap();

    hook(&app, "permission_request", live_permission_request()).await;
    tokio::time::sleep(SETTLE).await;

    let snap = state.push_attempts.snapshot();
    let row = snap.first().expect("a muted attempt is still recorded");
    assert!(row.muted);
    assert_eq!(row.reason.as_deref(), Some("session:off"));

    cleanup(&state, dir).await;
}

#[tokio::test]
async fn attention_only_mutes_the_calm_tier_and_keeps_the_blocking_one() {
    let (state, app, dir) = setup().await;
    db::push::set_pref(&state.pool, db::push::NotifCategory::AgentFinished, true)
        .await
        .unwrap();
    db::sessions::set_notif_policy(
        &state.pool,
        SESSION,
        supermux_server::notify::NotifPolicy::Attention,
    )
    .await
    .unwrap();

    hook(&app, "stop", serde_json::json!({})).await;
    tokio::time::sleep(Duration::from_millis(3000)).await;
    let snap = state.push_attempts.snapshot();
    assert!(snap[0].muted, "a finish is muted on an attention-only bot");
    assert_eq!(snap[0].reason.as_deref(), Some("session:attention"));

    hook(&app, "permission_request", live_permission_request()).await;
    tokio::time::sleep(SETTLE).await;
    let snap = state.push_attempts.snapshot();
    assert!(!snap[0].muted, "a blocking dialog still rings");
    assert_eq!(snap[0].category, "agent_waiting");

    cleanup(&state, dir).await;
}

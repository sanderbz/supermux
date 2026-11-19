//! `cc_conversation_id` tracking on `/api/_internal/hook` must follow the LEAD's
//! conversation only.
//!
//! An in-process teammate (Claude Code >= 2.1.232) runs under the parent pane's
//! `$SUPERMUX_SESSION` and hook token, and fires its own `SessionStart` /
//! `UserPromptSubmit` with its OWN `session_id` plus an `agent_type`. Following
//! those would point "this session" prompt-recall at the teammate's transcript.
//! This drives the real handler end to end (the unit tests in `hooks::tests` only
//! reach `apply_payload`, which does not run the tracking block at all).

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt; // for `oneshot`

const BEARER: &str = "dashboard-bearer-secret";
const TOK: &str = "hook-token-of-the-lead";
const SESSION: &str = "lead";

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-hooktrack-{}", uuid::Uuid::new_v4()));
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
        company_isolation: Vec::new(),
        human_auth: Default::default(),
        swarm_reaper: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);

    db::sessions::insert_minimal(&state.pool, SESSION, "/tmp", "shell").await.unwrap();
    db::sessions::ensure_runtime(&state.pool, SESSION, TOK).await.unwrap();

    let app = http::router(state.clone());
    (state, app, dir)
}

/// POST one hook event with the session's real token and a raw payload object.
async fn post_hook(app: &axum::Router, event: &str, payload: serde_json::Value) -> StatusCode {
    let body = serde_json::json!({ "session": SESSION, "event": event, "payload": payload });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/_internal/hook")
        .header(header::CONTENT_TYPE, "application/json")
        .header("X-Supermux-Hook-Token", TOK)
        .body(Body::from(body.to_string()))
        .unwrap();
    app.clone().oneshot(req).await.unwrap().status()
}

async fn tracked(state: &AppState) -> String {
    db::sessions::cc_conversation_id(&state.pool, SESSION)
        .await
        .unwrap()
        .unwrap_or_default()
}

#[tokio::test]
async fn teammate_hooks_do_not_move_the_lead_conversation_id() {
    let (state, app, dir) = setup().await;

    // 1. The lead's own SessionStart (no agent_type) establishes the id.
    assert_eq!(
        post_hook(&app, "session_start", serde_json::json!({ "session_id": "lead-conv-1" })).await,
        StatusCode::OK
    );
    assert_eq!(tracked(&state).await, "lead-conv-1", "the lead's own SessionStart tracks");

    // 2. A teammate's SessionStart: its own id + an agent_type, must be ignored.
    assert_eq!(
        post_hook(
            &app,
            "session_start",
            serde_json::json!({
                "session_id": "teammate-conv-9",
                "agent_type": "general-purpose",
                "source": "startup",
            }),
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        tracked(&state).await,
        "lead-conv-1",
        "a teammate SessionStart must not move the lead's conversation id"
    );

    // 3. A teammate's UserPromptSubmit (fired whenever the lead messages it) is
    //    the other event that writes the id, and must be ignored too.
    assert_eq!(
        post_hook(
            &app,
            "user_prompt_submit",
            serde_json::json!({
                "session_id": "teammate-conv-9",
                "agent_type": "general-purpose",
                "prompt": "go",
            }),
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        tracked(&state).await,
        "lead-conv-1",
        "a teammate UserPromptSubmit must not move the lead's conversation id"
    );

    // 4. The lead's own prompt on a NEW conversation (a /clear or compaction
    //    forks a fresh transcript) still moves it: the guard must not over-reach.
    assert_eq!(
        post_hook(
            &app,
            "user_prompt_submit",
            serde_json::json!({ "session_id": "lead-conv-2", "prompt": "hi" }),
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        tracked(&state).await,
        "lead-conv-2",
        "the lead's own UserPromptSubmit still tracks the fresh conversation"
    );

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_agent_lead_tracks_and_keeps_its_own_lifecycle() {
    // A lead launched as `claude --agent <name>` carries agent_type on its OWN
    // payloads. With nothing tracked yet it is accepted (first contact
    // establishes the id), and from then on its id matches, so its lifecycle is
    // never masked: no zombie row, teardown / archive-on-stop still run.
    let (state, app, dir) = setup().await;

    assert_eq!(
        post_hook(
            &app,
            "session_start",
            serde_json::json!({
                "session_id": "agent-lead-1",
                "agent_type": "reviewer",
                "source": "startup",
            }),
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        tracked(&state).await,
        "agent-lead-1",
        "an --agent lead establishes its id on first contact"
    );

    // Its own SessionEnd now matches the tracked id, so it still forces Stopped.
    assert_eq!(
        post_hook(
            &app,
            "session_end",
            serde_json::json!({
                "session_id": "agent-lead-1",
                "agent_type": "reviewer",
                "reason": "other",
            }),
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        state.take_forced_status(SESSION),
        Some(supermux_server::sessions::status::Status::Stopped),
        "an --agent lead's own SessionEnd must still force Stopped"
    );

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// Combined-branch guard: the teammate-hooks filter must short-circuit the
/// archive-on-stop path.
///
/// Two units meet here. `archive_on_stop` (the scheduler's disposable-session
/// marker) makes `hooks::force_stopped` archive the row the moment a `SessionEnd`
/// settles it to `stopped`. The teammate filter drops a lifecycle payload that
/// belongs to an in-process teammate before `force_stopped` ever runs. Without
/// that filter, one `TaskStop` on a subagent would archive the LEAD's live
/// session out from under the user: exactly the damage the fix exists to prevent,
/// now with a permanent consequence rather than a recoverable status flip.
///
/// The lead's OWN `SessionEnd` at the end is the control: it proves the row was
/// genuinely archivable the whole time, so the first half is not vacuous.
#[tokio::test]
async fn a_teammate_session_end_never_archives_a_live_archive_on_stop_session() {
    let (state, app, dir) = setup().await;

    // A scheduler-booted disposable session: flagged, live, not archived.
    sqlx::query("UPDATE sessions SET archive_on_stop = 1 WHERE name = ?")
        .bind(SESSION)
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(
        db::sessions::archive_pending(&state.pool, SESSION).await.unwrap(),
        "fixture: the session must start out flagged and archivable"
    );

    // The lead's own SessionStart establishes the tracked conversation id, which
    // is what makes the teammate's id below read as foreign.
    assert_eq!(
        post_hook(&app, "session_start", serde_json::json!({ "session_id": "lead-conv-1" })).await,
        StatusCode::OK
    );

    // A teammate's SessionEnd (its own id + an agent_type) — what `TaskStop` on
    // an in-process subagent emits.
    assert_eq!(
        post_hook(
            &app,
            "session_end",
            serde_json::json!({
                "session_id": "teammate-conv-9",
                "agent_type": "general-purpose",
                "reason": "other",
            }),
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        state.take_forced_status(SESSION),
        None,
        "a teammate SessionEnd must not force the lead Stopped"
    );
    // `force_stopped` archives on a detached task, so absence needs a real
    // window, not just one yield. Poll for the same budget the positive control
    // below gets, and fail on the first sight of an archive.
    for _ in 0..100 {
        assert_eq!(
            db::sessions::is_archived(&state.pool, SESSION).await.unwrap(),
            Some(false),
            "a teammate SessionEnd must never archive the lead's live session"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    // Control: the lead's own SessionEnd still archives it.
    assert_eq!(
        post_hook(
            &app,
            "session_end",
            serde_json::json!({ "session_id": "lead-conv-1", "reason": "other" }),
        )
        .await,
        StatusCode::OK
    );
    let mut archived = false;
    for _ in 0..100 {
        if db::sessions::is_archived(&state.pool, SESSION).await.unwrap() == Some(true) {
            archived = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(archived, "the lead's own SessionEnd must still auto-archive the flagged session");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// REGRESSION (the self-latching pointer). The teammate filter is
/// `session_id != cc_conversation_id`, and the tracking block is the ONLY writer
/// of `cc_conversation_id` — so for a lead that carries `agent_type` on its own
/// payloads (`claude --agent <name>`), the first real conversation switch used to
/// freeze the pointer permanently: the new id read as a teammate's, the pointer
/// was not followed, and every later event was compared against the same stale
/// id. The session then tailed a DEAD transcript forever (chat empty / stale
/// recall) and its real `SessionEnd` never forced Stopped.
///
/// `/clear` announces itself with `"source":"clear"`, which only the pane's real
/// agent can report. Driven through the real handler because the gate lives in
/// the handler, not in `apply_payload`.
#[tokio::test]
async fn an_agent_lead_follows_its_own_conversation_switch_after_clear() {
    let (state, app, dir) = setup().await;

    // First contact establishes the id (nothing tracked yet).
    post_hook(
        &app,
        "session_start",
        serde_json::json!({ "session_id": "conv-a", "agent_type": "reviewer", "source": "startup" }),
    )
    .await;
    assert_eq!(tracked(&state).await, "conv-a");

    // The human types `/clear`: Claude opens a NEW transcript and says so.
    assert_eq!(
        post_hook(
            &app,
            "session_start",
            serde_json::json!({
                "session_id": "conv-b",
                "agent_type": "reviewer",
                "source": "clear",
            }),
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        tracked(&state).await,
        "conv-b",
        "an --agent lead's post-/clear conversation must be followed, or chat and \
         recall tail a dead transcript forever"
    );

    // ...and because the pointer moved, the lead's lifecycle is un-masked again:
    // its own SessionEnd on the NEW conversation forces Stopped (before the fix
    // this compared against the frozen `conv-a` and was dropped as a teammate's).
    post_hook(
        &app,
        "session_end",
        serde_json::json!({ "session_id": "conv-b", "agent_type": "reviewer", "reason": "other" }),
    )
    .await;
    assert_eq!(
        state.take_forced_status(SESSION),
        Some(supermux_server::sessions::status::Status::Stopped),
        "the un-frozen pointer must restore the lead's lifecycle handling"
    );

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The escape hatch must NOT re-open the hole it sits next to: an in-process
/// teammate's `SessionStart` is `"source":"startup"`, and a teammate's
/// `UserPromptSubmit` (fired every time the lead messages it) carries no `source`
/// at all. Neither may move a lead that already has an id.
#[tokio::test]
async fn a_teammate_start_still_cannot_move_a_tracked_pointer() {
    let (state, app, dir) = setup().await;

    post_hook(&app, "session_start", serde_json::json!({ "session_id": "lead-conv" })).await;
    assert_eq!(tracked(&state).await, "lead-conv");

    for payload in [
        serde_json::json!({
            "session_id": "teammate-9",
            "agent_type": "general-purpose",
            "source": "startup",
        }),
        // A teammate that auto-compacted. Compaction keeps the SAME file and id,
        // so there is nothing to follow and this must stay filtered.
        serde_json::json!({
            "session_id": "teammate-9",
            "agent_type": "general-purpose",
            "source": "compact",
        }),
    ] {
        post_hook(&app, "session_start", payload).await;
        assert_eq!(tracked(&state).await, "lead-conv", "a teammate must never move the pointer");
    }

    post_hook(
        &app,
        "user_prompt_submit",
        serde_json::json!({ "session_id": "teammate-9", "agent_type": "general-purpose" }),
    )
    .await;
    assert_eq!(tracked(&state).await, "lead-conv");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

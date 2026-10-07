//! Hook-token auth scoping.
//! The `/api/_internal/hook` endpoint authenticates with the PER-SESSION
//! `X-Supermux-Hook-Token`, never the dashboard bearer. Asserts:
//!   * session A's token cannot mark session B (cross-session → 401),
//!   * the correct per-session token is accepted and the event is recorded,
//!   * the dashboard bearer grants no access to this endpoint,
//!   * an unknown session / missing token → 401.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt; // for `oneshot`

const BEARER: &str = "dashboard-bearer-secret";
const TOK_A: &str = "hook-token-of-session-a";
const TOK_B: &str = "hook-token-of-session-b";

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-hookauth-{}", uuid::Uuid::new_v4()));
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
        swarm_reaper: Default::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        company_isolation: Vec::new(),
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);

    // Two sessions, each with its OWN hook token.
    db::sessions::insert_minimal(&state.pool, "alpha", "/tmp", "shell")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, "alpha", TOK_A)
        .await
        .unwrap();
    db::sessions::insert_minimal(&state.pool, "bravo", "/tmp", "shell")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, "bravo", TOK_B)
        .await
        .unwrap();

    let app = http::router(state.clone());
    (state, app, dir)
}

/// POST a hook with an optional hook-token header and optional bearer.
async fn post_hook(
    app: &axum::Router,
    session: &str,
    event: &str,
    hook_token: Option<&str>,
    bearer: Option<&str>,
) -> StatusCode {
    post_payload(
        app,
        session,
        event,
        serde_json::Value::Null,
        hook_token,
        bearer,
    )
    .await
}

async fn post_payload(
    app: &axum::Router,
    session: &str,
    event: &str,
    payload: serde_json::Value,
    hook_token: Option<&str>,
    bearer: Option<&str>,
) -> StatusCode {
    let mut b = Request::builder()
        .method(Method::POST)
        .uri("/api/_internal/hook")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = hook_token {
        b = b.header("X-Supermux-Hook-Token", t);
    }
    if let Some(t) = bearer {
        b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let body =
        serde_json::json!({ "session": session, "event": event, "payload": payload }).to_string();
    let resp = app
        .clone()
        .oneshot(b.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    resp.status()
}

#[tokio::test]
async fn cross_session_hook_token_is_denied() {
    let (_state, app, dir) = setup().await;
    // A's token, B's session → 401 (leaked token of A cannot mark B).
    let st = post_hook(&app, "bravo", "notification", Some(TOK_A), None).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn correct_token_is_accepted_and_records_event() {
    let (state, app, dir) = setup().await;
    let st = post_hook(&app, "alpha", "notification", Some(TOK_A), None).await;
    assert_eq!(st, StatusCode::OK);
    // The event is folded into the session's turn state for the detector.
    let turn = state.turn_state("alpha");
    assert!(
        turn.notification.is_some(),
        "notification must be recorded: {turn:?}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn dashboard_bearer_does_not_grant_hook_access() {
    let (_state, app, dir) = setup().await;
    // Valid dashboard bearer but NO hook token → 401 (the bearer is not consulted).
    let st = post_hook(&app, "alpha", "notification", None, Some(BEARER)).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    // Even using the bearer string AS the hook token must fail.
    let st = post_hook(&app, "alpha", "notification", Some(BEARER), Some(BEARER)).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn missing_token_and_unknown_session_are_denied() {
    let (_state, app, dir) = setup().await;
    // No hook token at all.
    assert_eq!(
        post_hook(&app, "alpha", "notification", None, None).await,
        StatusCode::UNAUTHORIZED
    );
    // Unknown session (no row → no token to validate against) → 401, not 404, so
    // the endpoint is not an existence oracle.
    assert_eq!(
        post_hook(&app, "ghost", "notification", Some(TOK_A), None).await,
        StatusCode::UNAUTHORIZED
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn unknown_event_kind_is_ignored_not_rejected() {
    let (state, app, dir) = setup().await;
    // Authenticated but unrecognised event → 200 no-op (never trips a tool call).
    let st = post_hook(&app, "alpha", "some_future_event", Some(TOK_A), None).await;
    assert_eq!(st, StatusCode::OK);
    let turn = state.turn_state("alpha");
    assert!(
        turn.user_prompt.is_none()
            && turn.pre_tool.is_none()
            && turn.post_tool.is_none()
            && turn.stop.is_none()
            && turn.subagent_stop.is_none()
            && turn.notification.is_none(),
        "unknown event must not record: {turn:?}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

// Exercise the authenticated HTTP path as well as the detector: payload-only
// cards must agree with the status machine that feeds the live roster/header.
fn detected(state: &AppState, capture: &str) -> supermux_server::sessions::status::Status {
    use supermux_server::sessions::status::{Status, StatusDetector};
    let mut detector = StatusDetector::for_provider("claude");
    detector.force(Status::Active);
    detector.detect(
        capture,
        std::time::Instant::now(),
        state.turn_state("alpha"),
        true,
    )
}

async fn event(app: &axum::Router, name: &str, payload: serde_json::Value) {
    assert_eq!(
        post_payload(app, "alpha", name, payload, Some(TOK_A), None).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn direct_permission_after_a_completed_turn_waits_until_actual_resolution() {
    use supermux_server::sessions::status::Status;
    let (state, app, dir) = setup().await;
    event(&app, "Stop", serde_json::json!({})).await;
    assert_eq!(detected(&state, "❯"), Status::Idle);
    let ask = serde_json::json!({"tool_name":"Bash", "tool_input":{"command":"echo fixture"}});
    event(&app, "PermissionRequest", ask.clone()).await;
    assert!(state.turn_state("alpha").permission_request.is_some());
    assert!(state
        .session_activity("alpha")
        .unwrap()
        .permission
        .is_some());
    assert_eq!(
        detected(&state, "❯"),
        Status::Waiting,
        "a missed turn-start must not hide a real permission dialog"
    );
    event(&app, "Notification", serde_json::json!({"notification_type":"permission_prompt", "message":"Permission is still required"})).await;
    assert_eq!(
        detected(&state, "❯"),
        Status::Waiting,
        "a later notification does not resolve the dialog"
    );
    event(
        &app,
        "PostToolUseFailure",
        serde_json::json!({"tool_name":"Bash", "error":"Command failed"}),
    )
    .await;
    assert_eq!(detected(&state, "❯"), Status::Active);
    assert!(state
        .session_activity("alpha")
        .unwrap()
        .permission
        .is_none());
    event(&app, "PermissionRequest", ask).await;
    assert_eq!(detected(&state, "❯"), Status::Waiting);
    event(&app, "Stop", serde_json::json!({})).await;
    assert_eq!(detected(&state, "❯"), Status::Idle);
    assert!(state
        .session_activity("alpha")
        .is_none_or(|a| a.permission.is_none()));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn main_failure_ends_the_turn_clears_dialogs_and_preserves_background_work() {
    use supermux_server::sessions::status::Status;
    let (state, app, dir) = setup().await;
    event(&app, "UserPromptSubmit", serde_json::json!({})).await;
    event(
        &app,
        "SubagentStart",
        serde_json::json!({"agent_id":"background-child", "agent_type":"worker"}),
    )
    .await;
    state.mark_subagent_active("alpha");
    event(&app, "PreToolUse", serde_json::json!({"tool_name":"AskUserQuestion", "tool_input":{"questions":[{"question":"Continue?", "options":[{"label":"Yes"},{"label":"No"}]}]}})).await;
    event(
        &app,
        "PermissionRequest",
        serde_json::json!({"tool_name":"Bash", "tool_input":{"command":"echo fixture"}}),
    )
    .await;
    event(&app, "Notification", serde_json::json!({"notification_type":"permission_prompt", "message":"Waiting for permission"})).await;
    let before = state.session_activity("alpha").unwrap();
    assert!(
        before.permission.is_some()
            && before.question_request.is_some()
            && before.waiting_message.is_some()
    );
    assert!(before.subagents > 0 && state.subagents_live("alpha"));
    event(
        &app,
        "StopFailure",
        serde_json::json!({"error":"rate_limit", "error_details":"Try again shortly."}),
    )
    .await;
    assert!(state.turn_state("alpha").stop.is_some());
    assert_eq!(
        detected(&state, "Working… esc to interrupt"),
        Status::Idle,
        "scrollback spinner must not revive a failed main turn"
    );
    let after = state.session_activity("alpha").unwrap();
    assert_eq!(
        after.error,
        Some(("rate_limit".into(), "Try again shortly.".into()))
    );
    assert!(
        after.activity.is_none()
            && after.permission.is_none()
            && after.question_request.is_none()
            && after.waiting_message.is_none()
    );
    assert_eq!(
        after.subagents, before.subagents,
        "a main failure does not cancel independent children"
    );
    assert!(state.subagents_live("alpha"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn child_and_teammate_failures_cannot_end_or_replace_the_main_turn() {
    use supermux_server::sessions::status::Status;
    let (state, app, dir) = setup().await;
    db::sessions::set_cc_conversation_id(&state.pool, "alpha", "main-conversation")
        .await
        .unwrap();
    event(&app, "UserPromptSubmit", serde_json::json!({})).await;
    event(&app, "PreToolUse", serde_json::json!({"tool_name":"AskUserQuestion", "tool_input":{"questions":[{"question":"Continue?", "options":[{"label":"Yes"}]}]}})).await;
    event(
        &app,
        "PermissionRequest",
        serde_json::json!({"tool_name":"Bash", "tool_input":{"command":"echo fixture"}}),
    )
    .await;
    state.set_activity("alpha", "Main work is running".into(), "bash".into());
    state.set_error("alpha", "main-error".into(), "Existing main error".into());
    let turn = state.turn_state("alpha");
    let before = state.session_activity("alpha").unwrap();
    for payload in [
        serde_json::json!({"agent_id":"child", "error":"rate_limit", "error_details":"Child failed"}),
        serde_json::json!({"agent_type":"teammate", "session_id":"different-conversation", "error":"rate_limit", "error_details":"Teammate failed"}),
    ] {
        event(&app, "StopFailure", payload).await;
        assert_eq!(state.turn_state("alpha"), turn);
        let after = state.session_activity("alpha").unwrap();
        assert_eq!(after.activity, before.activity);
        assert_eq!(after.activity_kind, before.activity_kind);
        assert_eq!(after.error, before.error);
        assert_eq!(after.permission, before.permission);
        assert_eq!(after.question_request, before.question_request);
        assert_eq!(
            detected(&state, "Working… esc to interrupt"),
            Status::Waiting
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn named_main_agent_failure_with_the_tracked_conversation_still_ends_its_turn() {
    use supermux_server::sessions::status::Status;
    let (state, app, dir) = setup().await;
    db::sessions::set_cc_conversation_id(&state.pool, "alpha", "main-conversation")
        .await
        .unwrap();
    event(
        &app,
        "UserPromptSubmit",
        serde_json::json!({"session_id":"main-conversation", "agent_type":"named-main"}),
    )
    .await;
    event(&app, "StopFailure", serde_json::json!({"session_id":"main-conversation", "agent_type":"named-main", "error":"billing_error", "error_details":"Account needs attention"})).await;
    assert!(state.turn_state("alpha").stop.is_some());
    assert_eq!(detected(&state, "Working… esc to interrupt"), Status::Idle);
    assert_eq!(
        state.session_activity("alpha").unwrap().error,
        Some(("billing_error".into(), "Account needs attention".into()))
    );
    let _ = std::fs::remove_dir_all(dir);
}

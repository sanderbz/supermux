//! Hook-token auth scoping (TECH_PLAN §3.6, §6.5, §7.1; M5b, Eng P1 #3 / Codex
//! #4). The `/api/_internal/hook` endpoint authenticates with the PER-SESSION
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
        tls: TlsConfig::default(),
        auth_token: BEARER.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);

    // Two sessions, each with its OWN hook token.
    db::sessions::insert_minimal(&state.pool, "alpha", "/tmp", "shell").await.unwrap();
    db::sessions::ensure_runtime(&state.pool, "alpha", TOK_A).await.unwrap();
    db::sessions::insert_minimal(&state.pool, "bravo", "/tmp", "shell").await.unwrap();
    db::sessions::ensure_runtime(&state.pool, "bravo", TOK_B).await.unwrap();

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
    let body = serde_json::json!({ "session": session, "event": event }).to_string();
    let resp = app.clone().oneshot(b.body(Body::from(body)).unwrap()).await.unwrap();
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
    assert!(turn.notification.is_some(), "notification must be recorded: {turn:?}");
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

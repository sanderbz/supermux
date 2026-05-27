//! `POST /api/teams/start` (AT-D "Start a team") wire-contract coverage.
//!
//! The happy path boots a real Claude session in tmux (not viable in CI), so
//! these tests pin the parts that DON'T need a live agent:
//!   * auth — the start route sits behind the bearer layer (401 unauthenticated),
//!   * validation — an empty/missing goal 400s (a team needs a goal),
//!   * the per-session Agent-Teams OPT-IN mechanism the endpoint relies on
//!     (`set_force_agent_teams` flips the per-session override that
//!     `lifecycle::start` ORs with the global pref) — proven directly against
//!     `AppState`, since that flag is the load-bearing AT-D ↔ AT-B coordination.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "teams-start-test-token";

async fn test_state() -> (AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-teams-start-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
    };
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

async fn send(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
    auth: bool,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if auth {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    }
    let req = match body {
        Some(b) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            builder.body(Body::from(b.to_string())).unwrap()
        }
        None => builder.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

#[tokio::test]
async fn start_team_requires_auth() {
    let (state, _dir) = test_state().await;
    let app = http::router(state);
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/teams/start",
        Some(json!({ "task": "ship it" })),
        false,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn start_team_rejects_empty_goal() {
    let (state, _dir) = test_state().await;
    let app = http::router(state);
    // Blank goal → 400 (a team needs a goal). Validated BEFORE any session is
    // created, so this never touches tmux.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/teams/start",
        Some(json!({ "task": "   " })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "blank goal must 400; got {body}");
}

#[tokio::test]
async fn start_team_route_is_distinct_from_list() {
    // AT-D must NOT clobber AT-B's `GET /api/teams` (the list). GET still returns
    // the (empty) list envelope; the start route is POST-only.
    let (state, _dir) = test_state().await;
    let app = http::router(state);
    let (status, body) = send(&app, Method::GET, "/api/teams", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["data"], json!([]), "no teams yet → empty array");
}

#[tokio::test]
async fn force_agent_teams_flag_is_per_session_and_independent_of_global_pref() {
    // The load-bearing AT-D ↔ AT-B coordination: the start endpoint sets a
    // per-session override so ONE lead gets Agent Teams even while the GLOBAL
    // pref is OFF. Prove the flag mechanics directly (the happy-path boot needs
    // a real agent, but this invariant is testable in isolation).
    let (state, _dir) = test_state().await;

    // Global pref defaults OFF; the flag is unset for any session.
    assert!(!db::prefs::agent_teams_enabled(&state.pool).await);
    assert!(!state.force_agent_teams("lead-a"));

    // Setting it flips ONLY that session, not the global pref, not other sessions.
    state.set_force_agent_teams("lead-a");
    assert!(state.force_agent_teams("lead-a"), "flagged lead is opted in");
    assert!(!state.force_agent_teams("lead-b"), "other sessions unaffected");
    assert!(
        !db::prefs::agent_teams_enabled(&state.pool).await,
        "the global pref is NOT touched by the per-session opt-in"
    );

    // forget_session clears it (no leak across session churn).
    state.forget_session("lead-a");
    assert!(!state.force_agent_teams("lead-a"), "cleared on forget_session");
}

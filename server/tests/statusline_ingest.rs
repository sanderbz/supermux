//! `POST /api/_internal/statusline` — the statusline tap's inbound WIRING.
//!
//! The parsing and the change gate are unit-tested in
//! `sessions::chat::statusline`; this pins the parts only a real router can
//! prove: the per-session hook-token auth (same scope rule as
//! `/api/_internal/hook` — a leaked token of A cannot write B), the `sessions`
//! SSE delta the snapshot rides out on, and the change gate actually being
//! applied at the endpoint rather than merely existing on the type.
//!
//! The body used here is the payload captured LIVE from Claude Code 2.1.232 on
//! this host (Task 6 Step 1): `model` is an object, and
//! `context_window.used_percentage` is `null` on an idle window.

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::TryRecvError;
use tower::ServiceExt; // for `oneshot`

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

const BEARER: &str = "dashboard-bearer-secret";
const TOK_A: &str = "hook-token-of-session-a";
const TOK_B: &str = "hook-token-of-session-b";

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-slingest-{}", uuid::Uuid::new_v4()));
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
    db::sessions::insert_minimal(&state.pool, "alpha", "/tmp", "claude").await.unwrap();
    db::sessions::ensure_runtime(&state.pool, "alpha", TOK_A).await.unwrap();
    db::sessions::insert_minimal(&state.pool, "bravo", "/tmp", "claude").await.unwrap();
    db::sessions::ensure_runtime(&state.pool, "bravo", TOK_B).await.unwrap();
    let app = http::router(state.clone());
    (state, app, dir)
}

/// The live 2.1.232 statusline payload, with `used_percentage` overridable.
fn payload(version: &str) -> String {
    json!({
        "session_id": "72a819d8-0e4d-40f4-bce8-aec8033a75fd",
        "version": version,
        "model": {"id": "claude-opus-5[1m]", "display_name": "Opus 5 (1M context)"},
        "cost": {"total_cost_usd": 0.0, "total_duration_ms": 857},
        "context_window": {"context_window_size": 1000000, "used_percentage": null},
        "exceeds_200k_tokens": false
    })
    .to_string()
}

async fn post(
    app: &axum::Router,
    session: &str,
    token: Option<&str>,
    body: String,
) -> StatusCode {
    let mut b = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/_internal/statusline?session={session}"))
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = token {
        b = b.header("X-Supermux-Hook-Token", t);
    }
    app.clone()
        .oneshot(b.body(Body::from(body)).unwrap())
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn tap_rides_the_sessions_delta_and_is_change_gated() {
    let (state, app, dir) = setup().await;
    let mut rx = state.sse_tx.subscribe();

    assert_eq!(
        post(&app, "alpha", Some(TOK_A), payload("2.1.232")).await,
        StatusCode::OK
    );
    let ev = rx.try_recv().expect("first tap broadcasts");
    assert_eq!(ev.event, "sessions");
    let item = &ev.payload["delta"][0];
    assert_eq!(item["name"], json!("alpha"));
    assert_eq!(item["statusline"]["model_id"], json!("claude-opus-5[1m]"));
    assert_eq!(item["statusline"]["version"], json!("2.1.232"));
    assert_eq!(
        item["statusline"]["context_pct"],
        Value::Null,
        "a null used_percentage must stay null on the wire, not become 0%"
    );

    // The tap fires EVERY turn; an unchanged line must not fan out again.
    assert_eq!(
        post(&app, "alpha", Some(TOK_A), payload("2.1.232")).await,
        StatusCode::OK
    );
    assert!(
        matches!(rx.try_recv(), Err(TryRecvError::Empty)),
        "an identical statusline must not re-broadcast to every connected client"
    );

    // A real change does broadcast.
    assert_eq!(
        post(&app, "alpha", Some(TOK_A), payload("2.1.233")).await,
        StatusCode::OK
    );
    let ev = rx.try_recv().expect("a changed statusline broadcasts");
    assert_eq!(ev.payload["delta"][0]["statusline"]["version"], json!("2.1.233"));

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn tap_auth_is_scoped_per_session_exactly_like_the_hook() {
    let (state, app, dir) = setup().await;
    // A's token, B's session → 401, and nothing recorded for B.
    assert_eq!(
        post(&app, "bravo", Some(TOK_A), payload("2.1.232")).await,
        StatusCode::UNAUTHORIZED
    );
    assert!(state.statusline("bravo").is_none());
    // The dashboard bearer is not a hook token.
    let st = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/_internal/statusline?session=alpha")
                .header(header::AUTHORIZATION, format!("Bearer {BEARER}"))
                .body(Body::from(payload("2.1.232")))
                .unwrap(),
        )
        .await
        .unwrap()
        .status();
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    // Unknown session → 401 (no existence oracle), never a 404.
    assert_eq!(
        post(&app, "ghost", Some(TOK_A), payload("2.1.232")).await,
        StatusCode::UNAUTHORIZED
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_clipped_body_is_a_200_no_op_not_a_broken_status_line() {
    // `head -c 16384` can cut the JSON mid-object. The tap must swallow it: a
    // 4xx would surface to the user as a broken status line every turn.
    let (state, app, dir) = setup().await;
    let clipped = payload("2.1.232");
    let clipped = clipped[..clipped.len() / 2].to_string();
    assert_eq!(
        post(&app, "alpha", Some(TOK_A), clipped).await,
        StatusCode::OK
    );
    assert!(
        state.statusline("alpha").is_none(),
        "an unparseable body must record nothing at all"
    );
    let _ = std::fs::remove_dir_all(dir);
}

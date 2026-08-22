//! T4 — `PATCH /api/sessions/{name}/seen`: the cross-device seen cursor.
//!
//! B2's attention model is entirely client-side — `use-attention.ts` keeps the
//! whole cursor map under one localStorage key. That is fast and offline-safe,
//! and it stays. What it cannot do is follow you: read a session on the desktop
//! and the phone still shows an unread dot until you open it there too.
//!
//! This endpoint persists the cursor. The body is EXACTLY B2's `SeenCursor`
//! shape (`{ ts, count?, epoch? }`, `ts` in server-clock ms), because this is a
//! persistence layer for a model that already exists rather than a second one.
//!
//! Two properties carry the weight, and both are asserted here:
//!
//! * **Monotonic.** A regressive cursor is a no-op, so a laptop tab waking from
//!   sleep and replaying its hour-old cursor cannot un-read on the phone every
//!   session the user has since caught up on. It is a 200, not an error —
//!   nothing is wrong, the client's view was simply older.
//! * **Auth-scoped.** The dashboard bearer authorises it; the per-session hook
//!   token does not. Hooks report what the AGENT did, and where a HUMAN last
//!   looked is not something an agent may assert.

use std::path::PathBuf;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const BEARER: &str = "seen-cursor-bearer";
const HOOK_TOKEN: &str = "seen-cursor-hook-token";

fn temp_config() -> (Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-seen-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: BEARER.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: WsConfig::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        human_auth: Default::default(),
    };
    (config, dir)
}

async fn setup() -> (AppState, axum::Router, PathBuf) {
    let (config, dir) = temp_config();
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    for name in ["alpha", "beta"] {
        db::sessions::insert_minimal(&state.pool, name, dir.to_str().unwrap(), "claude")
            .await
            .unwrap();
        db::sessions::ensure_runtime(&state.pool, name, HOOK_TOKEN)
            .await
            .unwrap();
    }
    let app = http::router(state.clone());
    (state, app, dir)
}

/// Send a PATCH with an explicit set of auth headers, so each row of the matrix
/// differs only in how it authenticates.
async fn patch_seen(
    app: &axum::Router,
    name: &str,
    body: Value,
    auth: Option<&str>,
    hook_token: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(Method::PATCH)
        .uri(format!("/api/sessions/{name}/seen"))
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(a) = auth {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {a}"));
    }
    if let Some(t) = hook_token {
        builder = builder.header("X-Supermux-Hook-Token", t);
    }
    let resp = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

// ── the auth-scoping matrix ─────────────────────────────────────────────────

#[tokio::test]
async fn an_unauthenticated_patch_is_401() {
    let (_state, app, dir) = setup().await;
    let (status, _) = patch_seen(&app, "alpha", json!({ "ts": 1_000 }), None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_wrong_bearer_is_401() {
    let (_state, app, dir) = setup().await;
    let (status, _) =
        patch_seen(&app, "alpha", json!({ "ts": 1_000 }), Some("not-the-token"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

/// The hook token authenticates the AGENT. Where the HUMAN last looked is not
/// an agent's claim to make, so it must buy nothing here — including for its
/// OWN session, which is the case a naive "is this token valid?" check passes.
#[tokio::test]
async fn a_session_scoped_hook_token_cannot_write_any_seen_cursor() {
    let (state, app, dir) = setup().await;

    // Its own session…
    let (status, _) = patch_seen(&app, "alpha", json!({ "ts": 1_000 }), None, Some(HOOK_TOKEN)).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a hook token must not assert where a human looked, even for its own session",
    );
    // …and another session, the cross-session case.
    let (status, _) = patch_seen(&app, "beta", json!({ "ts": 1_000 }), None, Some(HOOK_TOKEN)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let row = db::sessions::get(&state.pool, "alpha").await.unwrap().unwrap();
    assert_eq!(row.seen_ts, None, "nothing was written by a refused request");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_unknown_session_is_404_not_a_silent_noop() {
    let (_state, app, dir) = setup().await;
    let (status, _) =
        patch_seen(&app, "no-such-session", json!({ "ts": 1_000 }), Some(BEARER), None).await;
    // 404, not 200 — a typo'd name and a regressive cursor both produce "0 rows
    // affected", and the client must be able to tell them apart.
    assert_eq!(status, StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(dir);
}

// ── monotonicity ────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_cursor_advances_and_round_trips_on_the_row() {
    let (state, app, dir) = setup().await;

    let (status, body) = patch_seen(
        &app,
        "alpha",
        json!({ "ts": 1_700_000_000_000i64, "count": 42, "epoch": 3 }),
        Some(BEARER),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["advanced"], json!(true));

    let row = db::sessions::get(&state.pool, "alpha").await.unwrap().unwrap();
    assert_eq!(row.seen_ts, Some(1_700_000_000_000));
    assert_eq!(row.seen_count, Some(42), "the seq-domain count is stored as sent");
    assert_eq!(row.seen_epoch, Some(3), "the epoch travels with the count");

    let _ = std::fs::remove_dir_all(dir);
}

/// The property that protects the phone from a stale tab.
#[tokio::test]
async fn a_regressive_cursor_is_a_noop_with_a_200() {
    let (state, app, dir) = setup().await;

    patch_seen(
        &app,
        "alpha",
        json!({ "ts": 2_000, "count": 10, "epoch": 1 }),
        Some(BEARER),
        None,
    )
    .await;

    // A laptop tab waking from sleep replays its older cursor.
    let (status, body) = patch_seen(
        &app,
        "alpha",
        json!({ "ts": 1_000, "count": 5, "epoch": 1 }),
        Some(BEARER),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "nothing is WRONG — the view was just older");
    assert_eq!(
        body["data"]["advanced"],
        json!(false),
        "the response says plainly that nothing moved",
    );

    let row = db::sessions::get(&state.pool, "alpha").await.unwrap().unwrap();
    assert_eq!(row.seen_ts, Some(2_000), "the newer cursor survived");
    assert_eq!(
        row.seen_count,
        Some(10),
        "count and epoch must not be half-written by a rejected cursor",
    );
    assert_eq!(row.seen_epoch, Some(1));

    let _ = std::fs::remove_dir_all(dir);
}

/// An identical cursor is not an advance either. Two devices replaying the same
/// read must not thrash the row.
#[tokio::test]
async fn an_identical_cursor_does_not_advance() {
    let (_state, app, dir) = setup().await;
    let body = json!({ "ts": 5_000 });
    patch_seen(&app, "alpha", body.clone(), Some(BEARER), None).await;
    let (status, second) = patch_seen(&app, "alpha", body, Some(BEARER), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["data"]["advanced"], json!(false));
    let _ = std::fs::remove_dir_all(dir);
}

/// `count` and `epoch` are optional — a session with no chat store attached has
/// a position in time but no entry count, and that is a legitimate cursor.
#[tokio::test]
async fn a_timestamp_only_cursor_is_valid() {
    let (state, app, dir) = setup().await;
    let (status, body) =
        patch_seen(&app, "alpha", json!({ "ts": 9_000 }), Some(BEARER), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["advanced"], json!(true));

    let row = db::sessions::get(&state.pool, "alpha").await.unwrap().unwrap();
    assert_eq!(row.seen_ts, Some(9_000));
    assert_eq!(row.seen_count, None, "absent stays absent — never coerced to 0");
    assert_eq!(row.seen_epoch, None);
    let _ = std::fs::remove_dir_all(dir);
}

/// The cursor rides the session row, so a device that has never seen this
/// session starts correct instead of showing everything unread (T4.3).
#[tokio::test]
async fn the_stored_cursor_is_emitted_on_the_session_view() {
    let (state, app, dir) = setup().await;
    patch_seen(
        &app,
        "alpha",
        json!({ "ts": 7_777, "count": 12, "epoch": 2 }),
        Some(BEARER),
        None,
    )
    .await;

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/sessions")
                .header(header::AUTHORIZATION, format!("Bearer {BEARER}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let alpha = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "alpha")
        .expect("alpha is listed");

    assert_eq!(alpha["seen_ts"], json!(7_777));
    assert_eq!(alpha["seen_count"], json!(12));
    assert_eq!(alpha["seen_epoch"], json!(2));

    // A session that has never been read reports null, not 0 — "never seen" and
    // "seen at the epoch" are different, and `tierFor` treats only the former as
    // not-unread.
    let beta = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "beta")
        .expect("beta is listed");
    assert_eq!(beta["seen_ts"], Value::Null);

    let _ = std::fs::remove_dir_all(state.config.data_dir.clone());
    let _ = std::fs::remove_dir_all(dir);
}

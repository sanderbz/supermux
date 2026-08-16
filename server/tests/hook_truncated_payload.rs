//! A hook payload larger than the command's 16 KB cap must still deliver its
//! EVENT.
//!
//! The installed hook command is
//! `D=$(head -c 16384); … -d "{\"session\":…,\"event\":…,\"payload\":$D}"`.
//! `$D` is spliced in RAW, so a payload over the cap is cut mid-token and the
//! whole body — not just the payload — becomes invalid JSON. Before the
//! salvage in `hooks::salvage_truncated_body` that was a 400 *before* auth:
//! `mark_hooks_live`, `record_hook` and `apply_payload` never ran, so the turn
//! state machine silently missed the tool boundary on precisely the biggest
//! tool calls (a 40 KB `Write`), leaving a stale activity label and — since
//! the chat data plane landed — a "waiting for permission" row on screen for a
//! tool that had already finished.
//!
//! These tests reproduce the wire bytes exactly: build a realistic oversized
//! payload, apply the same `head -c 16384` byte cut, splice it into the same
//! template.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt; // for `oneshot`

const BEARER: &str = "dashboard-bearer-secret";
const TOK: &str = "hook-token-of-session-a";

/// The exact cap the installed hook command applies to Claude's STDIN.
const HOOK_PAYLOAD_CAP: usize = 16384;

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-hooktrunc-{}", uuid::Uuid::new_v4()));
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
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    db::sessions::insert_minimal(&state.pool, "alpha", "/tmp", "shell")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, "alpha", TOK)
        .await
        .unwrap();
    let app = http::router(state.clone());
    (state, app, dir)
}

/// A `PreToolUse` payload for a big `Write` — the case the hook command's own
/// doc comment names as the field that overflows the cap.
fn oversized_write_payload() -> String {
    let content = "x".repeat(40_000);
    serde_json::json!({
        "session_id": "cc-conv-1",
        "hook_event_name": "PreToolUse",
        "tool_name": "Write",
        "tool_input": { "file_path": "/repo/src/big.rs", "content": content },
    })
    .to_string()
}

/// Reproduce `head -c N` — a BYTE cut, with no regard for token boundaries.
fn head_c(s: &str, n: usize) -> String {
    String::from_utf8_lossy(&s.as_bytes()[..n.min(s.len())]).into_owned()
}

/// Build the body byte-for-byte the way `claude_config::hook_command` does.
fn hook_body(session: &str, event: &str, payload_slice: &str) -> String {
    format!(r#"{{"session":"{session}","event":"{event}","payload":{payload_slice}}}"#)
}

async fn post(app: &axum::Router, body: String) -> StatusCode {
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/_internal/hook")
        .header(header::CONTENT_TYPE, "application/json")
        .header("X-Supermux-Hook-Token", TOK)
        .body(Body::from(body))
        .unwrap();
    app.clone().oneshot(req).await.unwrap().status()
}

/// The premise: the capped body really is invalid JSON. If this ever stops
/// holding (e.g. the payload gets framed so truncation is safe) the salvage
/// path can be retired — but not before.
#[tokio::test]
async fn a_capped_oversized_payload_is_invalid_json() {
    let capped = head_c(&oversized_write_payload(), HOOK_PAYLOAD_CAP);
    let body = hook_body("alpha", "pre_tool", &capped);
    let err = serde_json::from_str::<serde_json::Value>(&body)
        .expect_err("the truncated body must be invalid JSON — that is the whole bug");
    assert!(
        format!("{err}").contains("Unterminated") || format!("{err}").contains("EOF"),
        "unexpected parse error: {err}"
    );
}

/// The fix: the event still lands (200) and still drives the turn state
/// machine + the hooks-live flag, with the unusable payload dropped.
#[tokio::test]
async fn truncated_payload_still_delivers_the_event() {
    let (state, app, dir) = setup().await;
    let capped = head_c(&oversized_write_payload(), HOOK_PAYLOAD_CAP);
    let status = post(&app, hook_body("alpha", "pre_tool", &capped)).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a truncated payload must not cost us the event"
    );
    let turn = state.turn_state("alpha");
    assert!(
        turn.pre_tool.is_some(),
        "the tool boundary must reach the turn state machine: {turn:?}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// Auth is still enforced on the salvaged envelope — the salvage must not
/// become a way around the per-session token.
#[tokio::test]
async fn truncated_payload_still_requires_the_hook_token() {
    let (_state, app, dir) = setup().await;
    let capped = head_c(&oversized_write_payload(), HOOK_PAYLOAD_CAP);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/_internal/hook")
        .header(header::CONTENT_TYPE, "application/json")
        .header("X-Supermux-Hook-Token", "wrong-token")
        .body(Body::from(hook_body("alpha", "pre_tool", &capped)))
        .unwrap();
    let status = app.clone().oneshot(req).await.unwrap().status();
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

/// An UNDERSIZED payload keeps its full-fidelity path: the activity label is
/// derived from the payload, proving the salvage only kicks in when the strict
/// parse fails.
#[tokio::test]
async fn intact_payload_still_drives_the_activity_label() {
    let (state, app, dir) = setup().await;
    let payload = serde_json::json!({
        "tool_name": "Write",
        "tool_input": { "file_path": "/repo/src/small.rs", "content": "hi" },
    })
    .to_string();
    let status = post(&app, hook_body("alpha", "pre_tool", &payload)).await;
    assert_eq!(status, StatusCode::OK);
    let label = state
        .session_activity("alpha")
        .and_then(|a| a.activity)
        .unwrap_or_default();
    assert!(
        label.contains("small.rs"),
        "an intact payload must still produce the activity label, got {label:?}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// A genuinely malformed body (not our truncation shape) is still a 400 — the
/// salvage must not turn the endpoint into a garbage sink.
#[tokio::test]
async fn unrelated_garbage_is_still_rejected() {
    let (_state, app, dir) = setup().await;
    assert_eq!(
        post(&app, "not json at all".to_string()).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post(&app, r#"{"event":"pre_tool","payload":{}}"#.to_string()).await,
        StatusCode::BAD_REQUEST,
        "a body with no session must not be salvaged into one"
    );
    let _ = std::fs::remove_dir_all(dir);
}

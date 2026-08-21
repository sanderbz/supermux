//! Zero-effort on-device keyboard-band measurement sink.
//!
//! `POST /api/_internal/kbdebug` is a tiny, best-effort append-only log used to
//! collect the iOS composer's REAL keyboard-open geometry from the owner's own
//! device. The offline screenshot rig cannot render the real iOS soft keyboard,
//! so the band-fix geometry can only be validated against numbers measured on a
//! physical device — but the flag-gated kbdebug chip uses `position: fixed` and
//! scrolls out of view the instant the keyboard opens, so a screenshot never
//! captures the keyboard-OPEN state. This endpoint is the server-side channel:
//! the overlay (`components/dev/kbdebug-overlay.tsx`) POSTs its live snapshot
//! here on the keyboard-open transition, and each body is appended — with a
//! server receive timestamp — as ONE JSON line to `<data_dir>/kbdebug.log`.
//!
//! **Auth.** This route is mounted on the BEARER-protected router (see
//! `http::protected_router`), so it is gated by the same dashboard bearer the
//! rest of `/api/*` uses — the token the browser already holds on
//! `window._SUPERMUX_AUTH_TOKEN`. It is NOT open. (The per-session
//! `X-Supermux-Hook-Token` used by the other `/api/_internal/*` routes is a
//! pane-side secret the browser never has, so the bearer is the right gate for
//! a browser-originated POST.)
//!
//! **Best-effort, no DB.** A malformed / non-JSON / oversized body is a 204
//! no-op, never a 400 — a debug probe must never surface an error to the app.
//! A failed file write is swallowed too. No parsing of the snapshot shape: the
//! body is stored verbatim so the client can evolve its fields freely.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use serde_json::Value;
use std::io::Write;

use crate::state::AppState;

/// Filename of the append-only snapshot log under `<data_dir>`.
const KBDEBUG_LOG_FILE: &str = "kbdebug.log";

/// Cap on a single accepted body. A real snapshot is ~1-2 KB; anything past this
/// is ignored rather than logged (defensive — the sink is best-effort, not a
/// general upload endpoint).
const MAX_BODY: usize = 64 * 1024;

/// The kbdebug sink sub-router. Merged onto the BEARER-protected router so the
/// dashboard bearer gates it.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/_internal/kbdebug", post(ingest))
        .with_state(state)
}

/// Append one snapshot line. Always 204 (even on a bad body / failed write): a
/// debug probe must never raise an error in the app.
async fn ingest(State(state): State<AppState>, body: Bytes) -> StatusCode {
    if body.is_empty() || body.len() > MAX_BODY {
        return StatusCode::NO_CONTENT;
    }
    // Only accept a well-formed JSON object; ignore anything else silently.
    let snap: Value = match serde_json::from_slice(&body) {
        Ok(Value::Object(map)) => Value::Object(map),
        _ => return StatusCode::NO_CONTENT,
    };

    let line = serde_json::json!({
        "server_ts": chrono::Utc::now().to_rfc3339(),
        "snapshot": snap,
    });

    let path = state.config.data_dir.join(KBDEBUG_LOG_FILE);
    // Best-effort append; a write failure is swallowed (no DB, no retry).
    if let Ok(serialized) = serde_json::to_string(&line) {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(f, "{serialized}");
        }
    }
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use axum::body::to_bytes;
    use axum::http::Request;
    use tower::ServiceExt;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-kbdebug-test-{}", uuid::Uuid::new_v4()));
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
            github_token: None,
            statusline_tap: false,
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    #[tokio::test]
    async fn well_formed_object_is_appended_as_one_line() {
        let (state, dir) = test_state().await;
        let app = router_for(state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/_internal/kbdebug")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(r#"{"bandPx":42,"vvh":"640px"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let _ = to_bytes(resp.into_body(), usize::MAX).await.unwrap();

        let log = std::fs::read_to_string(dir.join(KBDEBUG_LOG_FILE)).unwrap();
        assert_eq!(log.lines().count(), 1);
        let parsed: Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
        assert!(parsed.get("server_ts").is_some());
        assert_eq!(parsed["snapshot"]["bandPx"], 42);

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn malformed_body_is_a_noop_not_an_error() {
        let (state, dir) = test_state().await;
        let app = router_for(state.clone());
        for bad in ["not json", "[1,2,3]", "\"a string\"", ""] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/_internal/kbdebug")
                        .body(axum::body::Body::from(bad))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        }
        // No file created (or empty) — nothing malformed was logged.
        let path = dir.join(KBDEBUG_LOG_FILE);
        if path.exists() {
            assert!(std::fs::read_to_string(&path).unwrap().is_empty());
        }

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

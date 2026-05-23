//! Archive end-to-end (TECH_PLAN §3.2.5).
//!
//! Verifies the contract the overview's "Archive removes the row" bug-fix
//! depends on:
//!   1. `POST /api/sessions/{name}/archive` flips `archived = 1` SYNCHRONOUSLY
//!      — the very next `GET /api/sessions` MUST NOT include the row.
//!   2. The archive call broadcasts a `sessions` SSE delta carrying
//!      `archived: true` so every connected tab drops the tile from its
//!      cached list without waiting for a refetch.
//!
//! No tmux needed: the row never has to be started for the archive contract
//! to hold (the file-write + tmux teardown that DO need tmux all live in the
//! spawned task and don't affect either assertion below).

use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

const TOKEN: &str = "archive-removes-token";

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-archive-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    (state, app, dir)
}

async fn req(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    let r = match body {
        Some(v) => {
            b = b.header(header::CONTENT_TYPE, "application/json");
            b.body(Body::from(v.to_string())).unwrap()
        }
        None => b.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(r).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, json)
}

#[tokio::test]
async fn archive_drops_session_from_list_endpoint_synchronously() {
    let (_state, app, _dir) = setup().await;
    let name = format!("arch{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);

    // Create the session (no tmux start needed — list filters on the row alone).
    let (status, _) = req(
        &app,
        Method::POST,
        "/api/sessions",
        Some(serde_json::json!({
            "name": name, "provider": "shell", "dir": "/tmp",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Sanity: row is in the list before archive.
    let (status, body) = req(&app, Method::GET, "/api/sessions", None).await;
    assert_eq!(status, StatusCode::OK);
    let arr = body
        .get("data")
        .and_then(|d| d.as_array())
        .expect("envelope { ok, data: [] }");
    assert!(
        arr.iter().any(|s| s.get("name").and_then(|n| n.as_str()) == Some(name.as_str())),
        "pre-archive list should contain {name}: {body:?}"
    );

    // Archive — must flip `archived = 1` synchronously BEFORE returning 202.
    let (status, _) = req(
        &app,
        Method::POST,
        &format!("/api/sessions/{name}/archive"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    // The IMMEDIATELY-next GET must NOT include the archived row — this is the
    // overview-refresh-after-archive bug the fix targets. No sleep: if the
    // implementation reverts to flipping `archived` in the spawned task, the
    // row will still be present here and this assertion fails.
    let (status, body) = req(&app, Method::GET, "/api/sessions", None).await;
    assert_eq!(status, StatusCode::OK);
    let arr = body
        .get("data")
        .and_then(|d| d.as_array())
        .expect("envelope { ok, data: [] }");
    assert!(
        !arr.iter().any(|s| s.get("name").and_then(|n| n.as_str()) == Some(name.as_str())),
        "post-archive list must drop {name}: {body:?}"
    );
}

#[tokio::test]
async fn archive_broadcasts_sessions_delta_with_archived_true() {
    let (state, app, _dir) = setup().await;
    let name = format!("brc{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);

    let (status, _) = req(
        &app,
        Method::POST,
        "/api/sessions",
        Some(serde_json::json!({
            "name": name, "provider": "shell", "dir": "/tmp",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Subscribe AFTER the create burst so the channel is clean.
    let mut rx = state.sse_tx.subscribe();

    // Archive — synchronously fires the `sessions` delta the UI drops on.
    let (status, _) = req(
        &app,
        Method::POST,
        &format!("/api/sessions/{name}/archive"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    // Drain events for up to ~1s looking for the archive delta. The detector's
    // own `sessions` / `status` events from the in-flight shutdown may interleave;
    // we only care that the archive delta itself reaches subscribers.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut saw_archive = false;
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
            Ok(Ok(ev)) if ev.event == "sessions" => {
                let deltas = ev
                    .payload
                    .get("delta")
                    .and_then(|d| d.as_array())
                    .cloned()
                    .unwrap_or_default();
                for d in deltas {
                    let is_target = d.get("name").and_then(|n| n.as_str()) == Some(name.as_str());
                    let archived = d.get("archived").and_then(|a| a.as_bool()) == Some(true);
                    if is_target && archived {
                        saw_archive = true;
                        break;
                    }
                }
                if saw_archive {
                    break;
                }
            }
            Ok(Ok(_)) => continue, // ignore other event types
            Ok(Err(_)) | Err(_) => continue, // channel lagged or no event
        }
    }
    assert!(
        saw_archive,
        "expected a `sessions` SSE delta with archived=true for {name}",
    );
}

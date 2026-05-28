//! Browse + restore/purge archived sessions (feat-archive-recover).
//!
//! Archive is a soft delete (`archived = 1`, never DELETE); this verifies the
//! recovery surface built on top of it:
//!   1. `GET /api/sessions/archived` lists archived rows (and ONLY archived
//!      rows — the live list stays clean).
//!   2. `POST .../unarchive` restores a row to the live list + drops it from
//!      the archived list.
//!   3. `DELETE .../purge` permanently removes an ARCHIVED row from BOTH lists,
//!      and refuses (409) a non-archived (live) session.
//!
//! No tmux needed — every assertion is on the DB row alone (the file-write +
//! tmux teardown in archive's spawned task don't affect list membership).

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

const TOKEN: &str = "archive-recover-token";

async fn setup() -> (axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-recover-{}", uuid::Uuid::new_v4()));
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
            github_token: None,
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    (http::router(state), dir)
}

async fn req(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
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
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, json)
}

/// Does the `{ ok, data: [...] }` envelope list contain a session named `name`?
fn list_has(body: &Value, name: &str) -> bool {
    body.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .any(|s| s.get("name").and_then(|n| n.as_str()) == Some(name))
        })
        .unwrap_or(false)
}

async fn create(app: &axum::Router, name: &str) {
    let (status, _) = req(
        app,
        Method::POST,
        "/api/sessions",
        Some(serde_json::json!({ "name": name, "provider": "shell", "dir": "/tmp" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create {name}");
}

async fn archive(app: &axum::Router, name: &str) {
    let (status, _) = req(app, Method::POST, &format!("/api/sessions/{name}/archive"), None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "archive {name}");
}

#[tokio::test]
async fn archived_list_endpoint_round_trips_with_main_list() {
    let (app, _dir) = setup().await;
    let name = format!("rec{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);

    create(&app, &name).await;

    // Pre-archive: in the main list, NOT in the archived list.
    let (_, main) = req(&app, Method::GET, "/api/sessions", None).await;
    assert!(list_has(&main, &name), "main list should contain live {name}");
    let (status, arch) = req(&app, Method::GET, "/api/sessions/archived", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!list_has(&arch, &name), "archived list must NOT contain live {name}");

    // Archive → flips. Now in archived list (with archived=true), gone from main.
    archive(&app, &name).await;

    let (_, main) = req(&app, Method::GET, "/api/sessions", None).await;
    assert!(!list_has(&main, &name), "main list must drop archived {name}");

    let (status, arch) = req(&app, Method::GET, "/api/sessions/archived", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(list_has(&arch, &name), "archived list must contain {name}: {arch:?}");
    let row = arch
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.iter().find(|s| s.get("name").and_then(|n| n.as_str()) == Some(name.as_str())))
        .expect("archived row present");
    assert_eq!(
        row.get("archived").and_then(|v| v.as_bool()),
        Some(true),
        "archived row must carry archived=true"
    );

    // Unarchive (Restore) → back in main, gone from archived.
    let (status, _) = req(&app, Method::POST, &format!("/api/sessions/{name}/unarchive"), None).await;
    assert_eq!(status, StatusCode::OK);

    let (_, main) = req(&app, Method::GET, "/api/sessions", None).await;
    assert!(list_has(&main, &name), "unarchive must restore {name} to main list");
    let (_, arch) = req(&app, Method::GET, "/api/sessions/archived", None).await;
    assert!(!list_has(&arch, &name), "unarchive must drop {name} from archived list");
}

#[tokio::test]
async fn purge_permanently_removes_archived_session_from_both_lists() {
    let (app, dir) = setup().await;
    let name = format!("prg{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);

    create(&app, &name).await;
    archive(&app, &name).await;

    // Drop a fake scrollback dump so the best-effort file cleanup has work to do.
    let archives = dir.join("archives");
    std::fs::create_dir_all(&archives).unwrap();
    let dump = archives.join(format!("{name}-12345.log"));
    std::fs::write(&dump, "scrollback").unwrap();

    // Sanity: it's in the archived list before purge.
    let (_, arch) = req(&app, Method::GET, "/api/sessions/archived", None).await;
    assert!(list_has(&arch, &name), "row should be in archived list pre-purge");

    // Purge — permanent DELETE of the archived row.
    let (status, body) = req(&app, Method::DELETE, &format!("/api/sessions/{name}/purge"), None).await;
    assert_eq!(status, StatusCode::OK, "purge body: {body:?}");
    assert_eq!(body.get("ok").and_then(|v| v.as_bool()), Some(true));

    // Gone from BOTH lists, and GET by name is a 404 (the row is really gone).
    let (_, arch) = req(&app, Method::GET, "/api/sessions/archived", None).await;
    assert!(!list_has(&arch, &name), "purge must drop {name} from archived list");
    let (_, main) = req(&app, Method::GET, "/api/sessions", None).await;
    assert!(!list_has(&main, &name), "purge must keep {name} out of main list");
    let (status, _) = req(&app, Method::GET, &format!("/api/sessions/{name}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "purged session must 404 by name");

    // The archived scrollback dump file is best-effort removed.
    assert!(!dump.exists(), "purge should remove the scrollback dump");

    // Purging again (now gone) is a 404.
    let (status, _) = req(&app, Method::DELETE, &format!("/api/sessions/{name}/purge"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "double-purge must 404");
}

#[tokio::test]
async fn purge_refuses_a_non_archived_session() {
    let (app, _dir) = setup().await;
    let name = format!("liv{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);

    // Live (never archived) session.
    create(&app, &name).await;

    // Purge must REFUSE with 409 — it may never nuke a live/visible session.
    let (status, body) = req(&app, Method::DELETE, &format!("/api/sessions/{name}/purge"), None).await;
    assert_eq!(status, StatusCode::CONFLICT, "purge of live session must 409: {body:?}");
    assert_eq!(body.get("ok").and_then(|v| v.as_bool()), Some(false));

    // The session is untouched — still in the live list.
    let (_, main) = req(&app, Method::GET, "/api/sessions", None).await;
    assert!(list_has(&main, &name), "refused purge must leave {name} live");

    // Purging a session that doesn't exist at all is a 404.
    let (status, _) = req(&app, Method::DELETE, "/api/sessions/ghost-xyz/purge", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "purge of missing session must 404");
}

#[tokio::test]
async fn archived_endpoints_require_auth() {
    let (app, _dir) = setup().await;

    // Both the list and the purge route are behind the bearer layer.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/sessions/archived")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri("/api/sessions/x/purge")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

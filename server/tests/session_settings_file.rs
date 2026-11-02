//! `settings_file` on `POST /api/sessions` (migration 0048).
//!
//! Pins the wire contract the operator dispatcher depends on: a valid absolute
//! path to a regular file is stored; anything else is a 400 that leaves NO row
//! behind; an absent field keeps the old behaviour exactly; and the stored file
//! is merged into the overlay the launch passes as `--settings`.

use std::path::{Path, PathBuf};

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "session-settings-file-token";

/// A fresh temp dir, created. Process- and time-unique so parallel tests never
/// share one (same shape as `resumable`'s test helper).
fn temp_dir(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "supermux-setfile-{tag}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn setup() -> (AppState, axum::Router, PathBuf) {
    let dir = temp_dir("data");
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        statusline_tap: false,
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        isolation_mode: Default::default(),
        company_isolation: Vec::new(),
        human_auth: Default::default(),
        swarm_reaper: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    (state, app, dir)
}

/// Send an authenticated request; returns (status, parsed-JSON-body).
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

use supermux_server::sessions::connector_config;

/// The path that rides `--settings` in a finished launch.
fn settings_flag(words: &[String]) -> Option<&str> {
    let i = words.iter().position(|w| w == "--settings")?;
    words.get(i + 1).map(String::as_str)
}

#[tokio::test]
async fn valid_settings_file_is_stored_and_merged_into_the_overlay() {
    let (state, app, data) = setup().await;
    let files = temp_dir("files");
    let file = files.join("operator-settings.json");
    std::fs::write(
        &file,
        json!({ "claudeMdExcludes": ["/home/x/CLAUDE.md"], "idleCompaction": false }).to_string(),
    )
    .unwrap();
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({
            "name": "lean-operator",
            "dir": "/tmp",
            "provider": "claude",
            "settings_file": file.to_string_lossy(),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let row = db::sessions::get(&state.pool, "lean-operator").await.unwrap().unwrap();
    assert_eq!(row.settings_file, file.to_string_lossy());

    // A plain session with nothing else would launch without an overlay; the
    // settings file alone is enough to write one.
    let fin = connector_config::assemble(&state, "lean-operator")
        .await
        .unwrap()
        .expect("a settings file activates the overlay");
    let overlay = settings_flag(&fin.launch_flags).expect("overlay rides --settings");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(overlay).unwrap()).unwrap();
    assert_eq!(v["claudeMdExcludes"], json!(["/home/x/CLAUDE.md"]));
    assert_eq!(v["idleCompaction"], json!(false));

    let _ = std::fs::remove_dir_all(files);
    let _ = std::fs::remove_dir_all(data);
}

#[tokio::test]
async fn absent_settings_file_keeps_the_plain_launch() {
    let (state, app, data) = setup().await;
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "plain", "dir": "/tmp", "provider": "claude" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let row = db::sessions::get(&state.pool, "plain").await.unwrap().unwrap();
    assert_eq!(row.settings_file, "");
    assert!(
        connector_config::assemble(&state, "plain").await.unwrap().is_none(),
        "no settings file and no other tier: byte-identical launch"
    );
    let _ = std::fs::remove_dir_all(data);
}

/// Every refusal is a 400 AND leaves no row, so the caller can retry the same
/// name without a 409.
#[tokio::test]
async fn bad_settings_files_are_refused_with_400_and_no_row() {
    let (state, app, data) = setup().await;
    let dir = temp_dir("dir");
    let cases: Vec<(&str, String)> = vec![
        ("rel", "operator-settings.json".to_string()),
        ("gone", "/nonexistent-supermux-settings.json".to_string()),
        ("dir", dir.to_string_lossy().to_string()),
        ("meta", "/tmp/evil; rm -rf /".to_string()),
        ("subst", "/tmp/$(whoami).json".to_string()),
    ];
    for (name, value) in cases {
        let (status, body) = send(
            &app,
            Method::POST,
            "/api/sessions",
            Some(json!({
                "name": name,
                "dir": "/tmp",
                "provider": "claude",
                "settings_file": value,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{value:?} must be refused: {body}");
        assert!(
            !db::sessions::exists(&state.pool, name).await.unwrap(),
            "{value:?} must leave no session row"
        );
    }
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(data);
}

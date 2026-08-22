//! `DELETE /api/claude/statusline` — what the FILE-level uninstall actually does.
//!
//! The pure core (`uninstall_with`) is unit-tested and correct: a wrapper we are
//! no longer the outermost of is a documented NO-OP. This file pins what the
//! endpoint around that core must therefore do, which only a real settings file
//! can prove:
//!
//!   * a no-op must be REPORTED as one — answering `installed: false` while our
//!     wrapper is still in the file (and still POSTing every turn) is a lie the
//!     operator acts on;
//!   * a no-op must not delete the `supermux-statusline.json` sidecar. The
//!     sidecar exists precisely for the case where the wrapper's embedded
//!     original is later lost; throwing it away on an uninstall that removed
//!     nothing destroys the only remaining copy of the user's own command;
//!   * a no-op must not rewrite `settings.json` at all — a rewrite renormalizes
//!     key order and formatting of a file we did not change.
//!
//! Own test binary on purpose: it sets `CLAUDE_CONFIG_DIR` for the whole
//! process, and cargo runs each integration file in its own process.

use std::fs;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::sessions::chat::statusline;
use supermux_server::state::AppState;
use supermux_server::{db, http};

const TOKEN: &str = "statusline-uninstall-token";

async fn delete_statusline(app: &axum::Router) -> (StatusCode, Value) {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri("/api/claude/statusline")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn uninstall_reports_the_truth_and_keeps_the_sidecar_when_it_removed_nothing() {
    let cfg = std::env::temp_dir().join(format!("sm-sluninst-cfg-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&cfg).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &cfg);
    let settings_path = cfg.join("settings.json");
    let sidecar_path = cfg.join("supermux-statusline.json");

    let data_dir = std::env::temp_dir().join(format!("sm-sluninst-data-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&data_dir).unwrap();
    let config = Config {
        data_dir: data_dir.clone(),
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
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());

    // ── case 1: another tool became the outermost wrapper of OURS ────────────
    let ours = statusline::wrap_command("~/bin/mystatus.sh");
    let theirs = format!("their-tap | ( {ours} )");
    let foreign_settings = json!({
        "theme": "dark",
        "statusLine": {"type": "command", "command": theirs, "padding": 0}
    });
    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&foreign_settings).unwrap(),
    )
    .unwrap();
    let sidecar = json!({"marker":"supermux-statusline","mode":"wrap",
                         "original":{"type":"command","command":"~/bin/mystatus.sh","padding":0}});
    fs::write(&sidecar_path, serde_json::to_string(&sidecar).unwrap()).unwrap();
    let settings_bytes_before = fs::read(&settings_path).unwrap();

    let (status, body) = delete_statusline(&app).await;
    assert_eq!(status, StatusCode::OK, "the safety valve never errors");
    assert_eq!(
        body["data"]["changed"],
        json!(false),
        "we removed nothing — say so"
    );
    assert_eq!(
        body["data"]["installed"],
        json!(true),
        "our wrapper is STILL in the file and still POSTing every turn; reporting \
         `installed: false` is a lie the operator acts on"
    );
    assert_eq!(
        fs::read(&settings_path).unwrap(),
        settings_bytes_before,
        "an uninstall that removed nothing must not rewrite the user's settings file"
    );
    assert!(
        sidecar_path.exists(),
        "the sidecar is the last copy of the user's own command — a no-op uninstall \
         must not delete it"
    );

    // ── case 2: we ARE the outermost wrapper — a real uninstall ──────────────
    let mine = json!({
        "theme": "dark",
        "statusLine": {"type": "command", "command": ours, "padding": 0}
    });
    fs::write(&settings_path, serde_json::to_string(&mine).unwrap()).unwrap();
    let (status, body) = delete_statusline(&app).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["changed"], json!(true));
    assert_eq!(body["data"]["installed"], json!(false));
    let after: Value = serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
    assert_eq!(
        after["statusLine"],
        json!({"type":"command","command":"~/bin/mystatus.sh","padding":0}),
        "the user's own command comes back exactly"
    );
    assert!(
        !sidecar_path.exists(),
        "our wrapper is provably gone, so the sidecar has no job left"
    );

    let _ = fs::remove_dir_all(&cfg);
    let _ = fs::remove_dir_all(&data_dir);
}

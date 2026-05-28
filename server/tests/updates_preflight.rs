//! Integration tests for the v0.3.0 in-UI updater.
//!
//! Pins the `/api/version` JSON shape, the auth gate, and the always-200
//! contract (a blocked state is information, not an error). The deep preflight
//! logic (per-BlockedReason variants, InstallMode detection) is exercised in
//! `src/updates/tests.rs` + `src/updates/preflight.rs` doctests — this file is
//! the wire-contract guard the frontend hook depends on.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::updates::release::LatestRelease;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

const TOKEN: &str = "test-token-updates-123";

async fn test_app() -> (axum::Router, AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-updates-test-{}", uuid::Uuid::new_v4()));
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
    let router = http::router(state.clone());
    (router, state, dir)
}

#[tokio::test]
async fn version_requires_auth() {
    let (app, _state, dir) = test_app().await;
    let resp = app
        .oneshot(Request::builder().uri("/api/version").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn version_returns_200_with_envelope_shape() {
    let (app, state, dir) = test_app().await;
    // Seed a known release so the JSON shape test isn't network-dependent.
    state
        .updates
        .release_cache
        .seed(LatestRelease {
            tag: "v9.9.9".into(),
            sha: "main".into(),
            body: "test body".into(),
            html_url: "https://example.invalid/releases/tag/v9.9.9".into(),
            published_at: Some("2026-01-01T00:00:00Z".into()),
        })
        .await;

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/version")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["ok"], true);
    let data = &v["data"];

    // Required keys for the frontend hook.
    assert!(data["current"].is_object(), "missing data.current");
    assert!(data["current"]["sha"].is_string());
    assert!(data["current"]["build_time"].is_string());
    assert!(data["latest"].is_object(), "missing data.latest (we seeded one)");
    assert_eq!(data["latest"]["tag"], "v9.9.9");
    assert!(data["update_available"].is_boolean());
    assert!(data["blocked_reasons"].is_array());
    assert!(data["install_mode"].is_object());
    assert!(data["install_mode"]["kind"].is_string());
    assert!(data["manageable"].is_boolean());

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn version_endpoint_is_200_even_with_blocked_reasons() {
    // The contract is "always 200 — blocked state is information, not error".
    // Without a seeded release the preflight will report a NoLatestRelease
    // BlockedReason; the endpoint must still answer 200.
    let (app, _state, dir) = test_app().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/version")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["ok"], true);
    let reasons = v["data"]["blocked_reasons"].as_array().expect("array");
    // We can't assert exact length here — the test host might also lack cargo
    // or be on a non-main branch — but we should at least see something.
    assert!(!reasons.is_empty(), "expected ≥1 blocked reason without a seeded release");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn update_start_refuses_when_preflight_is_blocked() {
    // No release seeded, dev environment → preflight is definitely blocked.
    let (app, _state, dir) = test_app().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/update/start")
                .method("POST")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // 409 Conflict — "your preconditions aren't met".
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["ok"], false);
    assert!(v["blocked_reasons"].is_array());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn update_progress_404_on_unknown_job() {
    let (app, _state, dir) = test_app().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/update/progress/no-such-job")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(dir);
}

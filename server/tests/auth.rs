//! Integration tests for the bearer-auth middleware (TECH_PLAN §6.1, M1
//! acceptance). Covers: missing token = 401, wrong token = 401, correct token =
//! 200 + `[]`.

use amux_server::config::{Config, ProviderDefaults, TlsConfig};
use amux_server::state::AppState;
use amux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "secret-test-token-123";

/// Build a router backed by an isolated temp-dir database with a known token.
async fn test_app() -> (axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("amux-auth-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    (http::router(state), dir)
}

#[tokio::test]
async fn missing_token_is_401() {
    let (app, dir) = test_app().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn wrong_token_is_401() {
    let (app, dir) = test_app().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .header(header::AUTHORIZATION, "Bearer not-the-real-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn correct_token_is_200_and_empty_array() {
    let (app, dir) = test_app().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], b"[]", "empty session list serializes to []");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn query_token_also_accepted() {
    // `?_token=` is the legacy curl convenience form (§3.4).
    let (app, dir) = test_app().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/sessions?_token={TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn health_is_public_no_auth() {
    // `/api/health` is mounted outside the auth layer (§6.1).
    let (app, dir) = test_app().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let _ = std::fs::remove_dir_all(dir);
}

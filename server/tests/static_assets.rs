//! Integration tests for the embedded-frontend layer (TECH_PLAN §3.2 line 153,
//! §8.1 — review finding R4-01).
//!
//! These guard the path the M24a/M24b Playwright e2e missed (it ran against the
//! Vite dev server, never the embedded binary): the release binary MUST serve
//! the SPA at `GET /` with `window._SUPERMUX_AUTH_TOKEN` injected, fall back to the
//! SPA shell for client-side routes, and still 404 unknown `/api/*` routes
//! rather than silently returning HTML.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "embed-test-token-abc";

async fn test_app() -> (axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-embed-test-{}", uuid::Uuid::new_v4()));
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
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    (http::router(state), dir)
}

async fn body_string(resp: axum::response::Response) -> String {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tokio::test]
async fn root_serves_spa_with_injected_token() {
    let (app, dir) = test_app().await;
    let resp = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let ctype = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(ctype.starts_with("text/html"), "GET / must be HTML, got {ctype}");

    let html = body_string(resp).await;
    assert!(html.contains("<div id=\"root\">"), "served HTML must be the SPA shell");
    // R4-01: the SPA reads `window._SUPERMUX_AUTH_TOKEN`; if it is not injected,
    // every HTTP call 401s and every WS first-frame auth fails.
    assert!(
        html.contains(&format!("window._SUPERMUX_AUTH_TOKEN=\"{TOKEN}\"")),
        "GET / must inject the auth token; got:\n{html}"
    );
    // The server deliberately does NOT inject `window._SUPERMUX_BASE_URL`: the
    // server-served SPA is same-origin with its own API, so it must use relative
    // URLs (see the rationale in `src/static_assets.rs`).
    assert!(
        !html.contains("window._SUPERMUX_BASE_URL="),
        "base URL must NOT be injected (same-origin SPA)"
    );
    assert!(html.contains("window._SUPERMUX_VERSION="), "must inject version");

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn spa_fallback_serves_shell_for_client_routes() {
    // A client-side route like `/board` has no server route — the SPA shell is
    // served so the front-end router resolves it.
    let (app, dir) = test_app().await;
    let resp = app
        .oneshot(Request::builder().uri("/board").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let html = body_string(resp).await;
    assert!(html.contains("<div id=\"root\">"), "client route must fall back to SPA shell");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn unknown_api_route_404s_not_html() {
    // The SPA fallback must NOT swallow `/api/*` — a missing API route is a
    // genuine 404, not a page navigation.
    let (app, dir) = test_app().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/does-not-exist")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let html = body_string(resp).await;
    assert!(
        !html.contains("<div id=\"root\">"),
        "a missing /api route must not return the SPA shell"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn root_is_public_no_auth_required() {
    // The SPA shell is public (no bearer) — it is what bootstraps the token.
    let (app, dir) = test_app().await;
    let resp = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    // No Authorization header, yet 200 — the static layer is on the public router.
    assert_eq!(resp.status(), StatusCode::OK);
    let _ = std::fs::remove_dir_all(dir);
}

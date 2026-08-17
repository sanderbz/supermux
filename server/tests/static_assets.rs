//! Integration tests for the embedded-frontend layer.
//!
//! These guard the path the Playwright e2e suites missed (they ran against the
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
            statusline_tap: false,
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
    // A client-side route has no server route — the SPA shell is served so the
    // front-end router resolves it.
    //
    // `/board` used to be the example here. Fase B2 removed that PAGE, and the
    // route now resolves to a client-side redirect to `/` — which is still the
    // SPA shell as far as this test is concerned, and is exactly why the
    // assertion had to move to a route the app actually renders: a fallback test
    // that names a redirect proves nothing about the fallback.
    let (app, dir) = test_app().await;
    let resp = app
        .oneshot(Request::builder().uri("/files").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let html = body_string(resp).await;
    assert!(html.contains("<div id=\"root\">"), "client route must fall back to SPA shell");

    // …and the REMOVED page's route is still served (it redirects client-side),
    // so a bookmark lands on the app rather than on a 404 from the static server.
    let (app, dir2) = test_app().await;
    let gone = app
        .oneshot(Request::builder().uri("/board").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(gone.status(), StatusCode::OK, "an old /board bookmark still reaches the SPA");
    let _ = std::fs::remove_dir_all(dir2);

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

/// The frontend's size budget is stated in GZIPPED bytes, so the wire has to
/// actually be compressed or the gate polices a number nobody transfers. Before
/// `static_assets::compression()` the binary sent no `Content-Encoding` at all:
/// the entry chunk went out at 551,022 bytes against a 147 KB budget.
///
/// Asserted as a PROPERTY (the bytes shrink, and the identity path still
/// works), not as "a layer is installed".
#[tokio::test]
async fn assets_are_compressed_on_the_wire() {
    let (app, dir) = test_app().await;

    async fn get(app: &axum::Router, uri: &str, accept: Option<&str>) -> (Vec<u8>, axum::http::HeaderMap) {
        let mut req = Request::builder().uri(uri);
        if let Some(a) = accept {
            req = req.header(header::ACCEPT_ENCODING, a);
        }
        let resp = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes().to_vec();
        (bytes, headers)
    }

    // Identity: unchanged behaviour for a client that asks for nothing.
    let (plain, plain_headers) = get(&app, "/", None).await;
    assert!(
        plain_headers.get(header::CONTENT_ENCODING).is_none(),
        "a client that asked for no encoding must get identity bytes"
    );
    assert!(
        String::from_utf8_lossy(&plain).contains("<div id=\"root\">"),
        "the identity path must still serve the SPA shell"
    );

    // Brotli: negotiated, flagged, varied on — and genuinely smaller.
    let (br, br_headers) = get(&app, "/", Some("br")).await;
    assert_eq!(
        br_headers.get(header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()),
        Some("br"),
        "an `Accept-Encoding: br` request must come back brotli-encoded"
    );
    assert!(
        br_headers
            .get(header::VARY)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().contains("accept-encoding")),
        "a negotiated response must Vary on accept-encoding or a shared cache poisons"
    );
    assert!(
        br.len() < plain.len(),
        "compression must actually shrink the wire: br {} B vs identity {} B",
        br.len(),
        plain.len()
    );

    // Gzip too — Safari/older clients and every curl default.
    let (gz, gz_headers) = get(&app, "/", Some("gzip")).await;
    assert_eq!(
        gz_headers.get(header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()),
        Some("gzip"),
    );
    assert!(gz.len() < plain.len(), "gzip must shrink the wire too");

    // …and the validator is WEAK, because one URL now has three
    // representations and a strong ETag would claim they are byte-identical.
    if let Some(etag) = br_headers.get(header::ETAG).and_then(|v| v.to_str().ok()) {
        assert!(
            etag.starts_with("W/\""),
            "a content-negotiated response needs a weak validator, got {etag}"
        );
    }

    let _ = std::fs::remove_dir_all(dir);
}

/// woff2 is a Brotli container. Re-compressing it burns CPU to ADD bytes, so
/// the predicate must leave `font/*` alone — the reason `compression()` does not
/// just use `DefaultPredicate` on its own.
#[tokio::test]
async fn fonts_are_not_recompressed() {
    let (app, dir) = test_app().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/fonts/JetBrainsMonoNerdFontMono-Regular-core.woff2")
                .header(header::ACCEPT_ENCODING, "gzip, br")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // Only meaningful when the frontend bundle is actually embedded; a
    // checkout without `scripts/build.sh` serves the SPA shell here instead.
    if resp.status() == StatusCode::OK
        && resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.contains("font"))
    {
        assert!(
            resp.headers().get(header::CONTENT_ENCODING).is_none(),
            "woff2 is already Brotli-compressed — re-encoding it is pure loss"
        );
    }
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

/// The `/api` plane must be compressed too.
///
/// #84 wired `CompressionLayer` onto the *static* sub-router only, so every JSON
/// body still shipped identity. `GET /api/sessions` is the hero-path payload —
/// ~50 KB on a live roster, refetched on a 30s staleTime plus every SSE-driven
/// invalidate — and gzips ~9x. On a Fast-3G waterfall that one missing header
/// was 0.25s of time-to-content.
///
/// Probed on `/api/kbd-groups` rather than `/api/sessions`: it is on the SAME
/// bearer-gated router, and its first GET seeds the four default accessory
/// groups, so the body is deterministically well over the predicate's 32-byte
/// floor without this test having to spawn a pty. Asserted as a PROPERTY (the
/// bytes shrink, the identity path still works), not as "a layer is installed".
#[tokio::test]
async fn api_json_is_compressed_on_the_wire() {
    let (app, dir) = test_app().await;

    async fn get_api(app: &axum::Router, accept: Option<&str>) -> (Vec<u8>, axum::http::HeaderMap) {
        let mut req = Request::builder()
            .uri("/api/kbd-groups")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
        if let Some(a) = accept {
            req = req.header(header::ACCEPT_ENCODING, a);
        }
        let resp = app.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "the probe route must be reachable with the bearer");
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes().to_vec();
        (bytes, headers)
    }

    // Identity still works — a client that negotiates nothing gets plain JSON.
    let (plain, plain_headers) = get_api(&app, None).await;
    assert!(
        plain_headers.get(header::CONTENT_ENCODING).is_none(),
        "no Accept-Encoding must still mean identity bytes"
    );
    assert!(
        plain.len() > 32,
        "the probe body must clear the compressor's 32-byte floor, got {} B",
        plain.len()
    );

    // gzip: negotiated, flagged, varied on — and genuinely smaller.
    let (gz, gz_headers) = get_api(&app, Some("gzip")).await;
    assert_eq!(
        gz_headers.get(header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()),
        Some("gzip"),
        "an `/api` GET with `Accept-Encoding: gzip` must come back gzip-encoded"
    );
    assert!(
        gz_headers
            .get(header::VARY)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().contains("accept-encoding")),
        "a negotiated /api response must Vary on accept-encoding or a shared cache poisons"
    );
    assert!(
        gz.len() < plain.len(),
        "compression must actually shrink the wire: gzip {} B vs identity {} B",
        gz.len(),
        plain.len()
    );

    // …and brotli, which is what every modern browser sends first.
    let (br, br_headers) = get_api(&app, Some("br,gzip")).await;
    assert_eq!(
        br_headers.get(header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()),
        Some("br"),
    );
    assert!(br.len() < plain.len(), "brotli must shrink the wire too");

    let _ = std::fs::remove_dir_all(dir);
}

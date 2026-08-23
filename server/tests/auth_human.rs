//! P3a integration tests — the human identity plane end to end through the real
//! router, with the Google OIDC exchange behind a mock (no live Google).
//!
//! Security paths covered (design §3):
//!   * full login on an allowlisted host mints a Secure/HttpOnly cookie that then
//!     authenticates a protected route (rows 11–15);
//!   * an unknown email → 403, no self-provisioning (row 16);
//!   * a login on a non-allowlisted host is refused (row 14);
//!   * CSRF is required on a cookie-borne state-changing route (row 10);
//!   * `?_token=<human>` never elevates — only the owner bearer authenticates
//!     via the query path (row 2);
//!   * the owner-bearer path is unaffected by enabling human-auth;
//!   * logout revokes the cookie; expired/revoked sessions never authenticate.

use std::sync::Arc;

use supermux_server::auth_human::oidc::MockOidcVerifier;
use supermux_server::config::{CompanyHost, Config, HumanAuthConfig, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use tower::ServiceExt;

const TOKEN: &str = "owner-secret-token";
const HOST: &str = "acme.test";
const COMPANY_ID: i64 = 1;

fn human_auth_cfg() -> HumanAuthConfig {
    HumanAuthConfig {
        google_client_id: Some("client-123.apps.googleusercontent.com".to_string()),
        google_client_secret: Some("google-secret".to_string()),
        owner_email: None,
        company_hosts: vec![CompanyHost {
            host: HOST.to_string(),
            company_id: COMPANY_ID,
            redirect_uri: format!("https://{HOST}/auth/callback"),
            ephemeral: false,
        }],
        owner_hosts: Vec::new(),
        cookie_key: b"cookie-key-cookie-key-cookie-key0".to_vec(),
        csrf_key: b"csrf-key0-csrf-key0-csrf-key0-csr".to_vec(),
        invite_key: b"invite-key0-invite-key0-invite-k".to_vec(),
        session_ttl_secs: 3600,
        base_domain: None,
    }
}

fn config_with(dir: &std::path::Path, human_auth: HumanAuthConfig) -> Config {
    Config {
        data_dir: dir.to_path_buf(),
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
        human_auth,
    }
}

/// A router + state with human-auth ENABLED and a mock verifier that resolves a
/// fixed set of codes → emails. Seeds `alice@acme.test` (member, company 1).
async fn enabled_app() -> (axum::Router, AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-humanauth-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = config_with(&dir, human_auth_cfg());
    let pool = db::init(&config).await.expect("db init");
    db::human_users::insert(&pool, "alice@acme.test", "Alice", Some(COMPANY_ID), "member")
        .await
        .expect("seed alice");
    let state = AppState::new(pool, config);

    let mock = Arc::new(MockOidcVerifier::new());
    mock.insert("good-code", "alice@acme.test", None, None);
    mock.insert("unknown-email-code", "eve@evil.test", None, None);
    state.human_auth.set_verifier(mock);

    let app = http::router(state.clone());
    (app, state, dir)
}

/// Pull a query param value from a URL string.
fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Read a `Set-Cookie` cookie's value (up to the first `;`).
fn set_cookie(resp: &axum::response::Response, name: &str) -> Option<String> {
    for hv in resp.headers().get_all(header::SET_COOKIE) {
        let s = hv.to_str().ok()?;
        if let Some(rest) = s.strip_prefix(&format!("{name}=")) {
            let val = rest.split(';').next().unwrap_or("");
            return Some(val.to_string());
        }
    }
    None
}

/// Drive /auth/login → /auth/callback with `code`, returning the callback response.
async fn login_flow(app: &axum::Router, code: &str) -> axum::response::Response {
    let login = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/login")
                .header(header::HOST, HOST)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::FOUND, "login should 302 to Google");
    let loc = login
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let state = query_param(&loc, "state").expect("state in authorize url");

    app.clone()
        .oneshot(
            Request::builder()
                .uri(format!("/auth/callback?code={code}&state={state}"))
                .header(header::HOST, HOST)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn full_login_mints_cookie_and_authenticates() {
    let (app, _state, dir) = enabled_app().await;
    let cb = login_flow(&app, "good-code").await;
    assert_eq!(cb.status(), StatusCode::FOUND, "callback 302 to /");
    let cookie = set_cookie(&cb, "supermux_hsess").expect("session cookie set");
    assert!(!cookie.is_empty());
    // Manual §67: the Set-Cookie carries the security attributes.
    let raw = cb
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .find(|s| s.starts_with("supermux_hsess="))
        .unwrap();
    assert!(raw.contains("HttpOnly"), "session cookie HttpOnly: {raw}");
    assert!(raw.contains("Secure"), "session cookie Secure: {raw}");
    assert!(raw.contains("SameSite=Lax"), "session cookie SameSite: {raw}");
    assert!(raw.contains("Path=/"), "session cookie Path: {raw}");

    // The cookie now authenticates a protected route.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "human cookie authenticates GET");

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn unknown_email_is_403_no_self_provision() {
    let (app, _state, dir) = enabled_app().await;
    let cb = login_flow(&app, "unknown-email-code").await;
    assert_eq!(cb.status(), StatusCode::FORBIDDEN, "unknown email → 403");
    assert!(set_cookie(&cb, "supermux_hsess").is_none(), "no cookie for a 403");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn login_on_unlisted_host_is_refused() {
    let (app, _state, dir) = enabled_app().await;
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/login")
                .header(header::HOST, "not-allowlisted.test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN, "unlisted host refused");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn csrf_required_on_state_changing_route() {
    let (app, _state, dir) = enabled_app().await;
    let cb = login_flow(&app, "good-code").await;
    let cookie = set_cookie(&cb, "supermux_hsess").unwrap();
    let csrf = set_cookie(&cb, "supermux_csrf").expect("csrf cookie set");

    // POST without the CSRF header → 403 (blocked in the auth middleware).
    let no_csrf = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/companies")
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(no_csrf.status(), StatusCode::FORBIDDEN, "POST without CSRF → 403");

    // POST WITH the CSRF header passes the middleware (handler may then 4xx on
    // body, but never 403 from the CSRF gate).
    let with_csrf = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/companies")
                .header(header::COOKIE, format!("supermux_hsess={cookie}; supermux_csrf={csrf}"))
                .header("x-supermux-csrf", &csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(
        with_csrf.status(),
        StatusCode::FORBIDDEN,
        "valid CSRF passes the gate (got {})",
        with_csrf.status()
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn human_token_in_query_does_not_elevate() {
    let (app, _state, dir) = enabled_app().await;
    let cb = login_flow(&app, "good-code").await;
    let cookie = set_cookie(&cb, "supermux_hsess").unwrap();

    // Presenting the human session token via ?_token= (the owner-only query path)
    // with NO cookie must NOT authenticate — humans authenticate solely by cookie.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/sessions?_token={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "?_token=<human> is 401");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn owner_bearer_unaffected_by_human_auth() {
    let (app, _state, dir) = enabled_app().await;
    // Bearer owner still 200.
    let ok = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    // ?_token=<owner> still 200 (owner legacy path).
    let ok2 = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/sessions?_token={TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ok2.status(), StatusCode::OK);
    // No creds → 401.
    let no = app
        .clone()
        .oneshot(Request::builder().uri("/api/sessions").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(no.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn logout_revokes_the_cookie() {
    let (app, _state, dir) = enabled_app().await;
    let cb = login_flow(&app, "good-code").await;
    let cookie = set_cookie(&cb, "supermux_hsess").unwrap();
    let csrf = set_cookie(&cb, "supermux_csrf").unwrap();

    // Sanity: authenticated before logout.
    let before = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(before.status(), StatusCode::OK);

    // Logout (CSRF-protected).
    let out = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/auth/logout")
                .header(header::COOKIE, format!("supermux_hsess={cookie}; supermux_csrf={csrf}"))
                .header("x-supermux-csrf", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(out.status(), StatusCode::OK);

    // The cookie no longer authenticates.
    let after = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(after.status(), StatusCode::UNAUTHORIZED, "revoked cookie → 401");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn expired_and_revoked_sessions_never_resolve() {
    let dir = std::env::temp_dir().join(format!("supermux-humanexp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = config_with(&dir, human_auth_cfg());
    let pool = db::init(&config).await.unwrap();
    let uid = db::human_users::insert(&pool, "bob@acme.test", "Bob", Some(COMPANY_ID), "member")
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();

    // Already-expired session.
    db::human_sessions::insert(&pool, uid, "hash-expired", Some(COMPANY_ID), "csrf", now - 100, now - 10)
        .await
        .unwrap();
    assert!(
        db::human_sessions::resolve_valid(&pool, "hash-expired", now)
            .await
            .unwrap()
            .is_none(),
        "expired session must not resolve"
    );

    // Valid session, then revoked.
    db::human_sessions::insert(&pool, uid, "hash-live", Some(COMPANY_ID), "csrf", now, now + 3600)
        .await
        .unwrap();
    assert!(db::human_sessions::resolve_valid(&pool, "hash-live", now).await.unwrap().is_some());
    assert!(db::human_sessions::revoke_by_token_hash(&pool, "hash-live", now).await.unwrap());
    assert!(
        db::human_sessions::resolve_valid(&pool, "hash-live", now)
            .await
            .unwrap()
            .is_none(),
        "revoked session must not resolve"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn disabled_config_makes_auth_routes_inert_and_owner_byte_identical() {
    let dir = std::env::temp_dir().join(format!("supermux-humandis-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // Default (inert) human_auth.
    let config = config_with(&dir, HumanAuthConfig::default());
    assert!(!config.human_auth.enabled());
    let pool = db::init(&config).await.unwrap();
    let state = AppState::new(pool, config);
    let app = http::router(state);

    // /auth/login is inert (404).
    let login = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/login")
                .header(header::HOST, HOST)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::NOT_FOUND, "login inert when disabled");

    // Owner bearer still works; no creds still 401.
    let ok = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    let no = app
        .clone()
        .oneshot(Request::builder().uri("/api/sessions").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(no.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

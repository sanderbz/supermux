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
        swarm_reaper: Default::default(),
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

// ── POST /auth/profile — a colleague names themselves ─────────────────────────
//
// The invite flow mints a session for an owner-seeded `human_users` row whose
// `display_name` is a placeholder. Until the colleague can set it, they are
// nameless in the group chat and their avatar has no monogram — which is exactly
// the owner-reported "an invited user must give their name". These pin the route
// and every refusal it owes.

/// POST /auth/profile with the given cookie/csrf pair and body.
async fn post_profile(
    app: &axum::Router,
    cookie: Option<&str>,
    csrf_header: Option<&str>,
    body: &str,
) -> axum::response::Response {
    let mut req = Request::builder()
        .method("POST")
        .uri("/auth/profile")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(c) = cookie {
        req = req.header(header::COOKIE, c);
    }
    if let Some(x) = csrf_header {
        req = req.header("x-supermux-csrf", x);
    }
    app.clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn profile_sets_own_display_name_and_me_reflects_it() {
    let (app, state, dir) = enabled_app().await;
    let cb = login_flow(&app, "good-code").await;
    let cookie = set_cookie(&cb, "supermux_hsess").unwrap();
    let csrf = set_cookie(&cb, "supermux_csrf").unwrap();
    let cookies = format!("supermux_hsess={cookie}; supermux_csrf={csrf}");

    let resp = post_profile(
        &app,
        Some(&cookies),
        Some(&csrf),
        r#"{"display_name":"  Alice Anderson  "}"#,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK, "happy path 200");

    // The row is updated — and it is the SESSION's row, trimmed.
    let user = db::human_users::get_by_email(&state.pool, "alice@acme.test")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(user.display_name, "Alice Anderson", "trimmed + stored");

    // `/auth/me` now carries the name the SPA draws its avatar + chat rows from.
    let me = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/me")
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(me.status(), StatusCode::OK);
    let body = axum::body::to_bytes(me.into_body(), 64 * 1024).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["authenticated"], serde_json::json!(true));
    assert_eq!(v["identity"]["display_name"], serde_json::json!("Alice Anderson"));
    assert_eq!(v["identity"]["company_id"], serde_json::json!(COMPANY_ID));
    assert_eq!(v["identity"]["role"], serde_json::json!("member"));

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn profile_requires_csrf_and_a_session() {
    let (app, state, dir) = enabled_app().await;
    let cb = login_flow(&app, "good-code").await;
    let cookie = set_cookie(&cb, "supermux_hsess").unwrap();
    let csrf = set_cookie(&cb, "supermux_csrf").unwrap();
    let cookies = format!("supermux_hsess={cookie}; supermux_csrf={csrf}");

    // No CSRF header at all → 403.
    let no_csrf = post_profile(&app, Some(&cookies), None, r#"{"display_name":"Mallory"}"#).await;
    assert_eq!(no_csrf.status(), StatusCode::FORBIDDEN, "missing CSRF → 403");

    // A WRONG CSRF value → 403 too (double-submit, not mere presence).
    let bad_csrf = post_profile(
        &app,
        Some(&cookies),
        Some("not-the-csrf-token"),
        r#"{"display_name":"Mallory"}"#,
    )
    .await;
    assert_eq!(bad_csrf.status(), StatusCode::FORBIDDEN, "wrong CSRF → 403");

    // Anonymous (no cookie) → 401, whatever CSRF is presented.
    let anon = post_profile(&app, None, Some(&csrf), r#"{"display_name":"Mallory"}"#).await;
    assert_eq!(anon.status(), StatusCode::UNAUTHORIZED, "anon → 401");

    // The owner BEARER is a token, not a person: it has no session cookie here,
    // so it cannot rename anybody through this route either.
    let owner = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/auth/profile")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"display_name":"Mallory"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(owner.status(), StatusCode::UNAUTHORIZED, "bearer-only → 401");

    // None of the refusals wrote anything.
    let user = db::human_users::get_by_email(&state.pool, "alice@acme.test")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(user.display_name, "Alice", "no refusal may write");

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn profile_validates_length() {
    let (app, state, dir) = enabled_app().await;
    let cb = login_flow(&app, "good-code").await;
    let cookie = set_cookie(&cb, "supermux_hsess").unwrap();
    let csrf = set_cookie(&cb, "supermux_csrf").unwrap();
    let cookies = format!("supermux_hsess={cookie}; supermux_csrf={csrf}");

    // Empty / whitespace-only → 400.
    for body in [r#"{"display_name":""}"#, r#"{"display_name":"   "}"#] {
        let resp = post_profile(&app, Some(&cookies), Some(&csrf), body).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "empty name → 400: {body}");
    }

    // 65 chars → 400; exactly 64 → OK (the boundary is inclusive).
    let too_long = format!(r#"{{"display_name":"{}"}}"#, "a".repeat(65));
    let resp = post_profile(&app, Some(&cookies), Some(&csrf), &too_long).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "65 chars → 400");

    let at_limit = format!(r#"{{"display_name":"{}"}}"#, "b".repeat(64));
    let resp = post_profile(&app, Some(&cookies), Some(&csrf), &at_limit).await;
    assert_eq!(resp.status(), StatusCode::OK, "64 chars accepted");
    let user = db::human_users::get_by_email(&state.pool, "alice@acme.test")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(user.display_name, "b".repeat(64));

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn profile_is_inert_when_the_human_surface_is_not_configured() {
    let dir = std::env::temp_dir().join(format!("supermux-profdis-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = config_with(&dir, HumanAuthConfig::default());
    let pool = db::init(&config).await.unwrap();
    let state = AppState::new(pool, config);
    let app = http::router(state);

    let resp = post_profile(&app, None, None, r#"{"display_name":"Anyone"}"#).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "inert → 404");
    let _ = std::fs::remove_dir_all(dir);
}

// ── GET /api/companies is fenced to the member's OWN company ──────────────────
//
// The client draws the member's scope chip (mark + name) from this list. It is
// ALSO the surface that would leak the existence of every other tenant if it
// were not fenced, so the fence is pinned here as a regression rather than
// assumed from `list_handler`'s filter.

#[tokio::test]
async fn companies_list_shows_a_member_only_their_own_company() {
    let (app, state, dir) = enabled_app().await;
    // Two real companies; alice is seeded into COMPANY_ID (1).
    let mine = db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let theirs = db::companies::create(&state.pool, "initech", "Initech", "/tmp/initech")
        .await
        .unwrap();
    assert_eq!(mine.id, COMPANY_ID, "alice's seeded company id");

    let cb = login_flow(&app, "good-code").await;
    let cookie = set_cookie(&cb, "supermux_hsess").unwrap();

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/companies")
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 256 * 1024).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let rows = v["data"].as_array().expect("data is an array");
    assert_eq!(rows.len(), 1, "a member sees exactly one company: {v}");
    assert_eq!(rows[0]["id"], serde_json::json!(mine.id));
    assert_eq!(rows[0]["display_name"], serde_json::json!("Acme"));

    // The OWNER still sees both (the fence is scoped, not global).
    let owner = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/companies")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(owner.into_body(), 256 * 1024).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["data"].as_array().unwrap().len(), 2, "owner sees both");

    // And a direct fetch of the OTHER company is the uniform hide-existence 404.
    let foreign = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/companies/{}", theirs.id))
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(foreign.status(), StatusCode::NOT_FOUND, "cross-company → 404");

    let _ = std::fs::remove_dir_all(dir);
}

// ── the anonymous `/auth/me` answer — what the LOGIN GATE may offer ───────────
//
// Owner-reported: on a company host with Google OIDC configured and verified
// "Ready", the sign-in screen still showed only "This is a private workspace /
// Access key". `GET /auth/login` worked the whole time; the SPA just could not
// know, because the anonymous `/auth/me` answer was `{authenticated:false}` and
// nothing else.
//
// These drive the REAL router with real `Host` headers and assert the parity
// that makes the button honest: `login.google` is true exactly where
// `/auth/login` 302s, and false wherever it would 404 or 403.

/// `GET /auth/me` with no credentials, from `host`.
async fn anon_me(app: &axum::Router, host: &str) -> serde_json::Value {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/me")
                .header(header::HOST, host)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "/auth/me always answers 200");
    let body = axum::body::to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn anon_me_offers_google_exactly_where_login_would_302() {
    let (app, _state, dir) = enabled_app().await;

    // The owner's case: Google configured, on the allowlisted company host.
    let v = anon_me(&app, HOST).await;
    assert_eq!(v["authenticated"], serde_json::json!(false));
    assert_eq!(v["login"]["google"], serde_json::json!(true), "{v}");
    // …and that promise is kept: the same host really does start the flow.
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
    assert_eq!(login.status(), StatusCode::FOUND, "the button's target 302s");

    // A host nobody allowlisted: `/auth/login` is a 403 there, so no button.
    let v = anon_me(&app, "evil.example.com").await;
    assert_eq!(v["login"]["google"], serde_json::json!(false), "{v}");
    let refused = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/login")
                .header(header::HOST, "evil.example.com")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN, "parity with the bit");

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn anon_me_never_leaks_config_and_the_signed_in_answer_is_unchanged() {
    let (app, _state, dir) = enabled_app().await;

    // The anonymous answer carries the bit and NOTHING else — no client id, no
    // redirect URI, no host allowlist.
    let v = anon_me(&app, HOST).await;
    let rendered = v.to_string();
    for leak in ["client-123", "googleusercontent", "google-secret", "callback"] {
        assert!(!rendered.contains(leak), "{leak} leaked into {rendered}");
    }
    let top: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(top.len(), 2, "authenticated + login only: {top:?}");

    // An AUTHENTICATED answer is untouched: no capability block rides along —
    // somebody already signed in is never offered a way to sign in again.
    let cb = login_flow(&app, "good-code").await;
    let cookie = set_cookie(&cb, "supermux_hsess").unwrap();
    let me = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/me")
                .header(header::HOST, HOST)
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(me.into_body(), 64 * 1024).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["authenticated"], serde_json::json!(true));
    assert!(v.get("login").is_none(), "no login block for a member: {v}");

    // The owner bearer is likewise unchanged.
    let owner = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/me")
                .header(header::HOST, HOST)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(owner.into_body(), 64 * 1024).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["authenticated"], serde_json::json!(true));
    assert!(v.get("login").is_none(), "no login block for the owner: {v}");

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn anon_me_on_an_invite_only_box_offers_no_google() {
    // The quick-tunnel shape: an allowlisted host and signing keys, but no
    // Google client — `/auth/login` is a 404, so the gate keeps its
    // access-key-and-invite-link face, byte for byte as before.
    let dir = std::env::temp_dir().join(format!("supermux-humaninv-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut cfg = human_auth_cfg();
    cfg.google_client_id = None;
    cfg.google_client_secret = None;
    let config = config_with(&dir, cfg);
    assert!(!config.human_auth.enabled());
    assert!(config.human_auth.invite_enabled(), "invites still live");
    let pool = db::init(&config).await.unwrap();
    let app = http::router(AppState::new(pool, config));

    let v = anon_me(&app, HOST).await;
    assert_eq!(v["authenticated"], serde_json::json!(false));
    assert_eq!(v["login"]["google"], serde_json::json!(false), "{v}");

    let _ = std::fs::remove_dir_all(dir);
}

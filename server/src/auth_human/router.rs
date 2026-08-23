//! The PUBLIC `/auth/*` login surface (design §P3a). Merged OUTSIDE the bearer
//! layer, beside the public router. Inert when human-auth is not configured.

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

use super::oidc::{generate_pkce, ExchangeParams};
use super::{
    cookie_value, csrf_hash, csrf_matches, mint_opaque_token, sha256_hex, sign_cookie,
    verify_cookie, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE,
};

const GOOGLE_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";

/// Build the public `/auth/*` sub-router (no bearer layer).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/auth/login", get(login))
        .route("/auth/callback", get(callback))
        .route("/auth/invite", get(invite))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct LoginQuery {
    /// Optional explicit host; otherwise the inbound `Host` header is used.
    host: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InviteQuery {
    /// The signed magic-link token (`base64url(payload).hmac_hex`).
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    /// Google error passthrough (e.g. `access_denied`).
    error: Option<String>,
}

/// Resolve the effective initiating host: the `Host` header, else `?host=`.
fn effective_host(headers: &HeaderMap, override_host: Option<&str>) -> Option<String> {
    if let Some(h) = override_host {
        let h = h.trim();
        if !h.is_empty() {
            return Some(h.to_string());
        }
    }
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `GET /auth/login` — start the OIDC flow: mint `state`+PKCE+`nonce`, bind them
/// to the inbound (allowlisted) Host, 302 to Google.
async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<LoginQuery>,
) -> Response {
    let cfg = state.human_auth_cfg();
    if !cfg.enabled() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let host = match effective_host(&headers, q.host.as_deref()) {
        Some(h) => h,
        None => return (StatusCode::BAD_REQUEST, "missing host").into_response(),
    };
    // Per-host allowlist: refuse to start a flow for an unlisted Host.
    let entry = match cfg.host_entry(&host) {
        Some(e) => e.clone(),
        None => return (StatusCode::FORBIDDEN, "host not allowlisted").into_response(),
    };
    let client_id = cfg.google_client_id.clone().unwrap_or_default();

    let (verifier, challenge) = generate_pkce();
    let nonce = mint_opaque_token();
    let csrf_state = state.human_auth.flows.insert(
        verifier,
        nonce.clone(),
        host.clone(),
        entry.redirect_uri.clone(),
    );

    let authorize = format!(
        "{base}?response_type=code&client_id={cid}&redirect_uri={ruri}\
         &scope={scope}&state={st}&code_challenge={cc}&code_challenge_method=S256&nonce={nonce}",
        base = GOOGLE_AUTHORIZE_URL,
        cid = urlencode(&client_id),
        ruri = urlencode(&entry.redirect_uri),
        scope = urlencode("openid email"),
        st = urlencode(&csrf_state),
        cc = urlencode(&challenge),
        nonce = urlencode(&nonce),
    );
    redirect_to(&authorize)
}

/// `GET /auth/callback` — validate `state`, exchange the code server-side, verify
/// the id_token, resolve the email to an allowlisted `human_users` row, mint a
/// session cookie, 302 to `/`.
async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Response {
    let cfg = state.human_auth_cfg();
    if !cfg.enabled() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    if let Some(err) = q.error.as_deref() {
        return (StatusCode::FORBIDDEN, format!("oauth error: {err}")).into_response();
    }
    let host = match effective_host(&headers, None) {
        Some(h) => h,
        None => return (StatusCode::BAD_REQUEST, "missing host").into_response(),
    };
    let (code, csrf_state) = match (q.code.as_deref(), q.state.as_deref()) {
        (Some(c), Some(s)) if !c.is_empty() && !s.is_empty() => (c, s),
        _ => return (StatusCode::BAD_REQUEST, "missing code/state").into_response(),
    };

    // Validate + CONSUME the flow (single-use, TTL, host-bound).
    let flow = match state.human_auth.flows.consume(csrf_state, &host) {
        Some(f) => f,
        None => return (StatusCode::BAD_REQUEST, "invalid or expired state").into_response(),
    };

    // Exchange + verify (server-side; PKCE verifier + nonce checked).
    let verifier = state.human_auth.verifier();
    let identity = match verifier
        .exchange_and_verify(ExchangeParams {
            code,
            pkce_verifier: &flow.pkce_verifier,
            redirect_uri: &flow.redirect_uri,
            expected_nonce: &flow.nonce,
        })
        .await
    {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!(error = %e, "oidc exchange/verify failed");
            return (StatusCode::FORBIDDEN, "authentication failed").into_response();
        }
    };

    // Allowlist: no human_users row → 403 (no self-provisioning).
    let user = match crate::db::human_users::get_by_email(&state.pool, &identity.email).await {
        Ok(Some(u)) => u,
        Ok(None) => return (StatusCode::FORBIDDEN, "not authorized").into_response(),
        Err(e) => {
            tracing::error!(error = %e, "human_users lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "error").into_response();
        }
    };

    // Host ↔ company binding: a scoped colleague may only mint on their own
    // company's host (owner/admin, company_id NULL, may mint on any allowlisted host).
    // Defense-in-depth: a scoped session MUST be bound to an allowlisted company
    // host — so if the mint host is not an allowlisted `company_hosts` entry at
    // all, REJECT rather than falling through and minting an unbound session.
    if let Some(uc) = user.company_id {
        match cfg.host_entry(&host) {
            Some(entry) if entry.company_id == uc => {}
            Some(_) => return (StatusCode::FORBIDDEN, "wrong host for company").into_response(),
            None => return (StatusCode::FORBIDDEN, "host not allowlisted for company").into_response(),
        }
    }

    // Mint the session (rotate, store sha256(token) + hmac(csrf), set cookies).
    mint_session_response(&state, &cfg, user.id, user.company_id).await
}

/// The SHARED session-mint tail: rotate prior sessions, store `sha256(token)` +
/// `hmac(csrf)` in `human_sessions`, set the `supermux_hsess` + `supermux_csrf`
/// cookies, 302 to `/`. Called IDENTICALLY by the Google callback and the
/// magic-link `/auth/invite` route — so an invite mints a byte-identical session
/// to a Google login (same cookies, same CSRF, same DB row shape).
async fn mint_session_response(
    state: &AppState,
    cfg: &crate::config::HumanAuthConfig,
    user_id: i64,
    company_id: Option<i64>,
) -> Response {
    let now = chrono::Utc::now().timestamp();
    let ttl = cfg.ttl_secs();
    let token = mint_opaque_token();
    let token_hash = sha256_hex(&token);
    let csrf_token = mint_opaque_token();
    let csrf_stored = csrf_hash(&cfg.csrf_key, &csrf_token);

    let _ = crate::db::human_sessions::revoke_all_for_user(&state.pool, user_id, now).await;
    if let Err(e) = crate::db::human_sessions::insert(
        &state.pool,
        user_id,
        &token_hash,
        company_id,
        &csrf_stored,
        now,
        now + ttl,
    )
    .await
    {
        tracing::error!(error = %e, "human_sessions insert failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, "error").into_response();
    }

    let cookie = sign_cookie(&cfg.cookie_key, &token);
    let mut resp = redirect_to("/");
    let h = resp.headers_mut();
    append_cookie(
        h,
        &format!("{SESSION_COOKIE}={cookie}; Path=/; Max-Age={ttl}; Secure; HttpOnly; SameSite=Lax"),
    );
    // Readable CSRF companion (double-submit); NOT HttpOnly so the SPA can echo it.
    append_cookie(
        h,
        &format!("{CSRF_COOKIE}={csrf_token}; Path=/; Max-Age={ttl}; Secure; SameSite=Lax"),
    );
    resp
}

/// `GET /auth/invite?token=…` — the PUBLIC magic-link consume (design §3.3), the
/// zero-config quick-tunnel alternative to Google. Gated on `invite_enabled()`.
///
/// Steps (uniform 400/403, fail-closed, no oracle):
///   1. Verify the token's HMAC (constant-time) + expiry against `invite_key`.
///   2. Require the inbound Host be an allowlisted `host_entry` whose `company_id`
///      == the token's — the SAME host↔company binding as the Google callback
///      (rejects a token replayed on a different/forged host).
///   3. Load `human_users::get(user_id)`; require `row.company_id == token.company_id`
///      (a deleted/revoked human ⇒ no row ⇒ 403).
///   4. Mint the IDENTICAL session as the callback (`mint_session_response`), 302 `/`.
async fn invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<InviteQuery>,
) -> Response {
    let cfg = state.human_auth_cfg();
    // Gate on the INVITE surface (not Google `enabled()`): inert otherwise.
    if !cfg.invite_enabled() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let token = match q.token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(t) => t,
        None => return (StatusCode::BAD_REQUEST, "bad request").into_response(),
    };

    // 1. Verify HMAC (constant-time) + expiry.
    let now = chrono::Utc::now().timestamp();
    let claims = match super::invite::verify_invite_token(&cfg.invite_key, token, now) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "bad request").into_response(),
    };

    // 2. Host↔company binding: the inbound Host must be an allowlisted company
    //    host for exactly the token's company (parity with `callback`).
    let host = match effective_host(&headers, None) {
        Some(h) => h,
        None => return (StatusCode::BAD_REQUEST, "bad request").into_response(),
    };
    match cfg.host_entry(&host) {
        Some(entry) if entry.company_id == claims.company_id => {}
        _ => return (StatusCode::FORBIDDEN, "forbidden").into_response(),
    }

    // 3. The human_users row must still exist AND still be fenced to the token's
    //    company (a deleted/revoked human ⇒ no row ⇒ 403; a re-homed row ⇒ 403).
    let user = match crate::db::human_users::get(&state.pool, claims.user_id).await {
        Ok(Some(u)) => u,
        Ok(None) => return (StatusCode::FORBIDDEN, "forbidden").into_response(),
        Err(e) => {
            tracing::error!(error = %e, "human_users lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "error").into_response();
        }
    };
    if user.company_id != Some(claims.company_id) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    // 4. Mint the IDENTICAL session as the Google callback.
    mint_session_response(&state, &cfg, user.id, user.company_id).await
}

/// `POST /auth/logout` — revoke the session, clear the cookies. CSRF-protected
/// (double-submit) since it is a cookie-borne state change.
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let cfg = state.human_auth_cfg();
    let cookie_header = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let raw = cookie_value(cookie_header, SESSION_COOKIE);

    // `human_surface_active()`: logout must revoke an invite-minted session too.
    if cfg.human_surface_active() {
        if let Some(raw) = raw {
            if let Some(token) = verify_cookie(&cfg.cookie_key, raw) {
                let now = chrono::Utc::now().timestamp();
                let token_hash = sha256_hex(&token);
                // CSRF check: presented header must match the session's stored hash.
                if let Ok(Some(sess)) =
                    crate::db::human_sessions::resolve_valid(&state.pool, &token_hash, now).await
                {
                    let presented = headers
                        .get(CSRF_HEADER)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let stored = sess.csrf_hash.as_deref().unwrap_or("");
                    if !csrf_matches(&cfg.csrf_key, presented, stored) {
                        return (StatusCode::FORBIDDEN, "missing or invalid CSRF token")
                            .into_response();
                    }
                    let _ =
                        crate::db::human_sessions::revoke_by_token_hash(&state.pool, &token_hash, now)
                            .await;
                }
            }
        }
    }

    let mut resp = (StatusCode::OK, Json(json!({"ok": true}))).into_response();
    let h = resp.headers_mut();
    append_cookie(h, &format!("{SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"));
    append_cookie(h, &format!("{CSRF_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax"));
    resp
}

/// `GET /auth/me` — the resolved identity for the SPA. Owner (bearer) or human
/// (cookie); `{authenticated:false}` when neither. NEVER returns the admin token.
async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    // Owner via bearer.
    if let Some(auth) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(tok) = auth
            .trim()
            .strip_prefix("Bearer ")
            .or_else(|| auth.trim().strip_prefix("bearer "))
        {
            if super::ct_eq(state.config.auth_token.as_str(), tok.trim())
                || crate::auth::token_matches(&state.config.auth_token, tok.trim())
            {
                return Json(json!({
                    "authenticated": true,
                    "identity": { "role": "owner", "company_id": serde_json::Value::Null }
                }))
                .into_response();
            }
        }
    }

    // Human via cookie. `human_surface_active()` (not `enabled()`) so an
    // invite-minted (non-Google) session resolves for `/auth/me` too.
    let cfg = state.human_auth_cfg();
    if cfg.human_surface_active() {
        let cookie_header = headers
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if let Some(raw) = cookie_value(cookie_header, SESSION_COOKIE) {
            if let Some(token) = verify_cookie(&cfg.cookie_key, raw) {
                let now = chrono::Utc::now().timestamp();
                let token_hash = sha256_hex(&token);
                if let Ok(Some(sess)) =
                    crate::db::human_sessions::resolve_valid(&state.pool, &token_hash, now).await
                {
                    let user = crate::db::human_users::get(&state.pool, sess.user_id)
                        .await
                        .ok()
                        .flatten();
                    let (email, display_name) = user
                        .map(|u| (u.email, u.display_name))
                        .unwrap_or_default();
                    return Json(json!({
                        "authenticated": true,
                        "identity": {
                            "user_id": sess.user_id,
                            "email": email,
                            "display_name": display_name,
                            "company_id": sess.company_id,
                            "role": sess.role,
                        }
                    }))
                    .into_response();
                }
            }
        }
    }

    (StatusCode::OK, Json(json!({"authenticated": false}))).into_response()
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn redirect_to(location: &str) -> Response {
    let mut resp = StatusCode::FOUND.into_response();
    if let Ok(v) = HeaderValue::from_str(location) {
        resp.headers_mut().insert(header::LOCATION, v);
    }
    resp
}

fn append_cookie(headers: &mut HeaderMap, value: &str) {
    if let Ok(v) = HeaderValue::from_str(value) {
        headers.append(header::SET_COOKIE, v);
    }
}

/// Minimal percent-encoding for URL query components (RFC 3986 unreserved kept).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod invite_tests {
    use super::*;
    use crate::auth_human::invite::mint_invite_token;
    use crate::config::{CompanyHost, Config, HumanAuthConfig};
    use crate::state::AppState;
    use axum::http::StatusCode;

    const QUICK_HOST: &str = "calm-frog-1234.trycloudflare.com";
    const INVITE_KEY: &[u8] = b"invite-key-invite-key-invite-key";
    const FAR_FUTURE: i64 = 4_102_444_800; // 2100-01-01

    /// Build an AppState on the invite (quick-tunnel) path: the quick host is a
    /// `company_hosts` entry for company 1, the invite/cookie/csrf keys are set,
    /// and Google is UNCONFIGURED (so `enabled()` is false, `invite_enabled()` true).
    async fn invite_state(with_surface: bool) -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-invite-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let human_auth = if with_surface {
            HumanAuthConfig {
                company_hosts: vec![CompanyHost {
                    host: QUICK_HOST.into(),
                    company_id: 1,
                    redirect_uri: format!("https://{QUICK_HOST}/auth/callback"),
                    ephemeral: true,
                }],
                cookie_key: b"cookie-key-cookie-key-cookie-key".to_vec(),
                csrf_key: b"csrf-key-csrf-key-csrf-key-csrf!!".to_vec(),
                invite_key: INVITE_KEY.to_vec(),
                ..Default::default()
            }
        } else {
            HumanAuthConfig::default()
        };
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "owner-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth,
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    /// Create company id 1 + a member fenced to it (fresh db ⇒ ids start at 1).
    async fn seed_member(state: &AppState) -> i64 {
        let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
            .await
            .unwrap();
        assert_eq!(co.id, 1, "fresh db company id");
        crate::db::human_users::insert(&state.pool, "bob@acme.test", "Bob", Some(1), "member")
            .await
            .unwrap()
    }

    fn host_headers(host: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        h
    }

    async fn call_invite(state: &AppState, host: &str, token: &str) -> Response {
        invite(
            State(state.clone()),
            host_headers(host),
            Query(InviteQuery {
                token: Some(token.to_string()),
            }),
        )
        .await
    }

    async fn cleanup(state: AppState, dir: std::path::PathBuf) {
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Set-Cookie names present on the response (for the happy-path assertion).
    fn set_cookie_names(resp: &Response) -> Vec<String> {
        resp.headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|s| s.split('=').next().map(str::to_string))
            .collect()
    }

    // ── happy path: mints the IDENTICAL session as the Google callback ──────────
    #[tokio::test]
    async fn invite_happy_path_mints_a_session_and_302s() {
        let (state, dir) = invite_state(true).await;
        let uid = seed_member(&state).await;
        let token = mint_invite_token(INVITE_KEY, uid, 1, FAR_FUTURE);

        let resp = call_invite(&state, QUICK_HOST, &token).await;
        assert_eq!(resp.status(), StatusCode::FOUND, "302 to /");
        let names = set_cookie_names(&resp);
        assert!(names.iter().any(|n| n == SESSION_COOKIE), "session cookie set: {names:?}");
        assert!(names.iter().any(|n| n == CSRF_COOKIE), "csrf cookie set: {names:?}");

        // A live human_sessions row exists for the user, scoped to company 1.
        let now = chrono::Utc::now().timestamp();
        // The cookie carries the token whose sha256 keys the row; instead assert a
        // live session exists for the user by re-minting semantics: list via the
        // roster status (active) is simplest.
        let rows = crate::db::human_users::list_by_company(&state.pool, 1, now)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "active", "session is live after invite");
        cleanup(state, dir).await;
    }

    // ── rejection: the token replayed on a DIFFERENT / forged host ──────────────
    #[tokio::test]
    async fn invite_rejects_wrong_host() {
        let (state, dir) = invite_state(true).await;
        let uid = seed_member(&state).await;
        let token = mint_invite_token(INVITE_KEY, uid, 1, FAR_FUTURE);
        // A host that is not the allowlisted company host ⇒ 403.
        let resp = call_invite(&state, "evil.example.com", &token).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        cleanup(state, dir).await;
    }

    // ── rejection: token's company_id ≠ the host's company ──────────────────────
    #[tokio::test]
    async fn invite_rejects_wrong_company_token() {
        let (state, dir) = invite_state(true).await;
        let uid = seed_member(&state).await;
        // Token claims company 2, but QUICK_HOST is allowlisted for company 1.
        let token = mint_invite_token(INVITE_KEY, uid, 2, FAR_FUTURE);
        let resp = call_invite(&state, QUICK_HOST, &token).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN, "host↔company mismatch");
        cleanup(state, dir).await;
    }

    // ── rejection: a deleted / never-existent human ⇒ 403 (revocation) ──────────
    #[tokio::test]
    async fn invite_rejects_deleted_human() {
        let (state, dir) = invite_state(true).await;
        let _uid = seed_member(&state).await;
        // A valid, correctly-signed token for a user id that has no row.
        let token = mint_invite_token(INVITE_KEY, 999, 1, FAR_FUTURE);
        let resp = call_invite(&state, QUICK_HOST, &token).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN, "no human row ⇒ 403");
        cleanup(state, dir).await;
    }

    // ── rejection: an expired / tampered token ⇒ 400 (uniform, no oracle) ───────
    #[tokio::test]
    async fn invite_rejects_expired_and_tampered_token() {
        let (state, dir) = invite_state(true).await;
        let uid = seed_member(&state).await;
        // Expired (exp in the past).
        let expired = mint_invite_token(INVITE_KEY, uid, 1, 1_000);
        assert_eq!(
            call_invite(&state, QUICK_HOST, &expired).await.status(),
            StatusCode::BAD_REQUEST
        );
        // Tampered signature.
        let good = mint_invite_token(INVITE_KEY, uid, 1, FAR_FUTURE);
        let (payload, sig) = good.rsplit_once('.').unwrap();
        let last = sig.chars().last().unwrap();
        let bad = format!("{payload}.{}{}", &sig[..sig.len() - 1], if last == 'a' { 'b' } else { 'a' });
        assert_eq!(
            call_invite(&state, QUICK_HOST, &bad).await.status(),
            StatusCode::BAD_REQUEST
        );
        // Missing token param.
        let resp = invite(
            State(state.clone()),
            host_headers(QUICK_HOST),
            Query(InviteQuery { token: None }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        cleanup(state, dir).await;
    }

    // ── gating: the invite surface is inert without `invite_enabled()` ──────────
    #[tokio::test]
    async fn invite_is_404_when_surface_inactive() {
        let (state, dir) = invite_state(false).await;
        assert!(!state.human_auth_cfg().invite_enabled());
        let token = mint_invite_token(INVITE_KEY, 1, 1, FAR_FUTURE);
        let resp = call_invite(&state, QUICK_HOST, &token).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        cleanup(state, dir).await;
    }
}

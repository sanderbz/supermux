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
    let cfg = &state.config.human_auth;
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
    let cfg = &state.config.human_auth;
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
    if let Some(uc) = user.company_id {
        if let Some(entry) = cfg.host_entry(&host) {
            if entry.company_id != uc {
                return (StatusCode::FORBIDDEN, "wrong host for company").into_response();
            }
        }
    }

    // Mint: rotate (revoke prior sessions), store sha256(token) + hmac(csrf).
    let now = chrono::Utc::now().timestamp();
    let ttl = cfg.ttl_secs();
    let token = mint_opaque_token();
    let token_hash = sha256_hex(&token);
    let csrf_token = mint_opaque_token();
    let csrf_stored = csrf_hash(&cfg.csrf_key, &csrf_token);

    let _ = crate::db::human_sessions::revoke_all_for_user(&state.pool, user.id, now).await;
    if let Err(e) = crate::db::human_sessions::insert(
        &state.pool,
        user.id,
        &token_hash,
        user.company_id,
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

/// `POST /auth/logout` — revoke the session, clear the cookies. CSRF-protected
/// (double-submit) since it is a cookie-borne state change.
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let cfg = &state.config.human_auth;
    let cookie_header = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let raw = cookie_value(cookie_header, SESSION_COOKIE);

    if cfg.enabled() {
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

    // Human via cookie.
    let cfg = &state.config.human_auth;
    if cfg.enabled() {
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

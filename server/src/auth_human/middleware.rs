//! The `AuthContext` resolver — the P3a replacement for the bearer-only
//! `auth_middleware`.
//!
//! Resolution order (owner wins, and the owner path stays byte-identical to
//! before P3a):
//!   1. **Owner** — a valid bearer (or the legacy `?_token=`) matching
//!      `config.auth_token`. The `?_token=` fallback authenticates ONLY the owner
//!      bearer; a human can never elevate through it (design §3 row 2).
//!   2. **Human** — a valid, non-revoked, non-expired session **cookie** whose
//!      sha256 matches a `human_sessions` row. Cookies are read ONLY from the
//!      `Cookie:` header, never the query string. On a state-changing method the
//!      double-submit CSRF header is required (design §3 row 10).
//!   3. Neither → `401` on protected routes.
//!
//! The resolved identity is stamped as a request extension [`AuthContext`] for
//! downstream (P3b/P3c) scoping. This slice only produces it.

use axum::extract::{Request, State};
use axum::http::{header, Method};
use axum::middleware::Next;
use axum::response::Response;

use crate::auth;
use crate::error::AppError;
use crate::state::AppState;

use super::{
    cookie_value, csrf_matches, sha256_hex, verify_cookie, CSRF_HEADER, SESSION_COOKIE,
};

/// The identity carried on every authenticated request.
#[derive(Debug, Clone)]
pub enum AuthContext {
    /// The omniscient owner (valid bearer / `?_token=`).
    Owner,
    /// A scoped human colleague, resolved from a session cookie.
    Human {
        user_id: i64,
        /// `None` = owner/admin-all human (bypasses scoping); `Some` = fenced to a company.
        company_id: Option<i64>,
        role: String,
    },
}

/// True for the HTTP methods that mutate state (CSRF-relevant for cookie auth).
fn is_state_changing(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

/// Resolve `AuthContext` (owner bearer, else human cookie), stamp it as a request
/// extension, else `401`. Supersedes [`crate::auth::auth_middleware`].
pub async fn auth_context_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    // 1. Owner — the EXISTING bearer / ?_token path, unchanged and winning.
    if let Some(tok) = auth::extract_token(&req) {
        if auth::token_matches(&state.config.auth_token, &tok) {
            let mut req = req;
            req.extensions_mut().insert(AuthContext::Owner);
            return Ok(next.run(req).await);
        }
    }

    // 2. Human — only when the login surface is configured, and only from a
    //    cookie (never the query string / ?_token). Extract every needed value
    //    as an OWNED, Send type BEFORE the DB await — holding `&Request` (whose
    //    `Body` is not `Sync`) across the await would make the middleware future
    //    !Send.
    if state.config.human_auth.enabled() {
        let cookie_header = req
            .headers()
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let is_mutating = is_state_changing(req.method());
        let csrf_header = req
            .headers()
            .get(CSRF_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if let Some(ctx) =
            resolve_human(&state, cookie_header, is_mutating, csrf_header).await?
        {
            let mut req = req;
            req.extensions_mut().insert(ctx);
            return Ok(next.run(req).await);
        }
    }

    // 3. Neither.
    tracing::warn!(path = %req.uri().path(), "auth rejected (no owner bearer, no valid human cookie)");
    Err(AppError::Unauthorized)
}

/// Try to resolve a human identity from the request's session cookie. Returns
/// `Ok(Some(ctx))` on a live session (CSRF already enforced for mutating
/// methods), `Ok(None)` when there is no usable cookie/session, and `Err` only to
/// surface a CSRF failure as `403` (so it is distinguishable from "no identity").
async fn resolve_human(
    state: &AppState,
    cookie_header: Option<String>,
    is_mutating: bool,
    csrf_header: Option<String>,
) -> Result<Option<AuthContext>, AppError> {
    let cfg = &state.config.human_auth;

    // Cookie header → our session cookie → verify HMAC → inner opaque token.
    let cookie_header = match cookie_header {
        Some(h) => h,
        None => return Ok(None),
    };
    let raw = match cookie_value(&cookie_header, SESSION_COOKIE) {
        Some(v) => v,
        None => return Ok(None),
    };
    let token = match verify_cookie(&cfg.cookie_key, raw) {
        Some(t) => t,
        None => return Ok(None), // bad signature — treated as no identity
    };

    // DB: sha256(token) → a live (non-revoked, non-expired) session.
    let now = chrono::Utc::now().timestamp();
    let token_hash = sha256_hex(&token);
    let sess = match crate::db::human_sessions::resolve_valid(&state.pool, &token_hash, now).await {
        Ok(Some(s)) => s,
        Ok(None) => return Ok(None),
        Err(e) => {
            tracing::error!(error = %e, "human_sessions resolve failed");
            return Ok(None); // fail-closed
        }
    };

    // CSRF on state-changing methods (double-submit).
    if is_mutating {
        let presented = csrf_header.as_deref().unwrap_or("");
        let stored = sess.csrf_hash.as_deref().unwrap_or("");
        if !csrf_matches(&cfg.csrf_key, presented, stored) {
            return Err(AppError::Forbidden(
                "missing or invalid CSRF token".to_string(),
            ));
        }
    }

    Ok(Some(AuthContext::Human {
        user_id: sess.user_id,
        company_id: sess.company_id,
        role: sess.role,
    }))
}

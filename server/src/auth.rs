//! Bearer-token auth middleware.
//!
//! Applied to every protected route. Public routes (manifest, sw, icons,
//! `/api/health`) are mounted on a separate router that is NOT wrapped by this
//! layer — so this function contains no path carve-outs.
//!
//! Security invariants:
//!   * **No localhost bypass.** The peer address is never consulted; an earlier
//!     `/api`+`/ws` loopback carve-out was a CVE class and is gone.
//!   * **Constant-time compare** via [`constant_time_eq`], so token validation
//!     leaks no timing signal.

use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::Response;

use crate::error::AppError;
use crate::state::AppState;

/// Validate the bearer token, else 401.
pub async fn auth_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let presented = extract_token(&req);
    match presented {
        Some(tok) if token_matches(&state.config.auth_token, &tok) => Ok(next.run(req).await),
        other => {
            tracing::warn!(path = %req.uri().path(), token_present = other.is_some(), "auth rejected");
            Err(AppError::Unauthorized)
        }
    }
}

/// Pull the token from `Authorization: Bearer <tok>` (canonical) or, for legacy
/// curl convenience, the `?_token=` query parameter.
fn extract_token(req: &Request) -> Option<String> {
    if let Some(value) = req.headers().get(AUTHORIZATION) {
        if let Ok(s) = value.to_str() {
            let s = s.trim();
            if let Some(rest) = s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer ")) {
                let rest = rest.trim();
                if !rest.is_empty() {
                    return Some(rest.to_string());
                }
            }
        }
    }
    if let Some(query) = req.uri().query() {
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            if key == "_token" && !value.is_empty() {
                return Some(value.into_owned());
            }
        }
    }
    None
}

/// Constant-time token comparison. `constant_time_eq` is itself
/// length-aware and does not early-return on the first differing byte.
fn token_matches(expected: &str, presented: &str) -> bool {
    constant_time_eq::constant_time_eq(expected.as_bytes(), presented.as_bytes())
}

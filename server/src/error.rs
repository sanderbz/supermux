//! Typed request errors.
//!
//! Every handler returns `Result<_, AppError>`. The [`IntoResponse`] impl maps
//! each variant to a status code and a `{ ok: false, error: "..." }` JSON body,
//! matching the documented HTTP envelope.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    /// The contract itself is retired, not the request. Used by the
    /// `/api/schedules` read-shim on every write verb (spec §5.2): a stale PWA
    /// bundle must be told to reload rather than redirected — a 307/308 on POST
    /// re-plays a mutating body against a DIFFERENT contract.
    #[error("{0}")]
    Gone(String),
    /// A quota the caller can act on: it is not wrong, it has simply had
    /// enough. Distinct from `BadRequest` because the right response is "delete
    /// one and try again", not "fix your payload" — and an agent reads the
    /// status before it reads the sentence.
    #[error("too many: {0}")]
    TooManyRequests(String),
    /// The disk cannot hold what was asked for. 507 rather than 400: the
    /// request is well-formed and the caller did nothing wrong — the box is
    /// full. Refusing a 9 GB upload in the first 50 ms is kinder than dying at
    /// 90 %, and the sentence names both numbers so the person can act.
    #[error("insufficient storage: {0}")]
    InsufficientStorage(String),
    /// Something the request depends on is missing or not answering — the
    /// request itself is fine. Carries a stable machine `code` (e.g.
    /// `browser_unavailable`) next to the readable sentence, so a client can
    /// branch on it instead of string-matching, and it is never a 500: a 500
    /// says "supermux broke", which is not what happened.
    #[error("{message}")]
    Unavailable {
        status: StatusCode,
        code: &'static str,
        message: String,
    },
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    fn status(&self) -> StatusCode {
        match self {
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Gone(_) => StatusCode::GONE,
            AppError::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            AppError::InsufficientStorage(_) => StatusCode::INSUFFICIENT_STORAGE,
            AppError::Unavailable { status, .. } => *status,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        // Never leak internal error detail to the client; log it instead.
        let message = match &self {
            AppError::Internal(err) => {
                tracing::error!(error = %err, "internal error");
                "internal server error".to_string()
            }
            other => other.to_string(),
        };
        let body = match &self {
            AppError::Unavailable { code, .. } => {
                Json(json!({ "ok": false, "error": message, "code": code, "detail": message }))
            }
            _ => Json(json!({ "ok": false, "error": message })),
        };
        (status, body).into_response()
    }
}

/// Map sqlx errors: a missing row becomes a 404, everything else is internal.
impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        match err {
            sqlx::Error::RowNotFound => AppError::NotFound("row not found".to_string()),
            other => AppError::Internal(other.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unavailable_carries_its_status_code_and_detail() {
        let resp = AppError::Unavailable {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "browser_unavailable",
            message: "no browser".into(),
        }
        .into_response();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], "browser_unavailable");
        assert_eq!(v["error"], "no browser");
        assert_eq!(v["detail"], "no browser");
    }
}

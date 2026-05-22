//! Typed request errors (TECH_PLAN §3.2.1, §3.4).
//!
//! Every handler returns `Result<_, AppError>`. The [`IntoResponse`] impl maps
//! each variant to a status code and a `{ ok: false, error: "..." }` JSON body,
//! matching the HTTP envelope in §3.4.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    fn status(&self) -> StatusCode {
        match self {
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
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
        let body = Json(json!({ "ok": false, "error": message }));
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

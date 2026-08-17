//! Request extractors shared by the AGENT-FACING hook routes.
//!
//! ## Why a second JSON extractor exists
//!
//! Every `/api/hook/*` endpoint is documented to its caller as a copy-pasteable
//! `curl`, and the shipped documentation — `agents/supermux-schedule.md`,
//! `scheduler::runner::confirm_footer`, `board::dispatch::footer` — writes the
//! body with `-d '{…}'`. `curl -d` defaults to
//! `Content-Type: application/x-www-form-urlencoded`, and axum's [`axum::Json`]
//! extractor answers **415 with a plain-text body** for anything that is not
//! exactly `application/json`.
//!
//! That combination shipped a contract that fails on its own first example:
//! `curl -fsS` exits 22, the response body is not JSON, and the agent — which
//! only ever sees this documentation — gets nothing it can act on. It also
//! violates the fase B4 T7.2 rule that "a rejected request is a 400/401/429
//! with a readable message": a bare 415 is neither.
//!
//! [`LenientJson`] is the same fix `hooks.rs` already applies by hand to the
//! Claude status hook (see its `hook_handler` doc: a 415 there was invisible
//! *and* fatal). This lifts that one-off into a reusable extractor so the
//! scheduler and board hooks — the two routes whose documentation an agent
//! reads and pastes — get it too:
//!
//! * the body is parsed as JSON **whatever the `Content-Type` says**, so the
//!   documented `-d` form works and a proxy that rewrites the header cannot
//!   sever the route;
//! * a body that is not valid JSON is a **400 with a readable sentence**, in the
//!   same `{ ok: false, error: … }` envelope every other error uses.
//!
//! ### Why this is not a CSRF hole
//!
//! Accepting `application/x-www-form-urlencoded` makes these routes reachable by
//! a cross-origin HTML form (a "simple request", no preflight). It buys an
//! attacker nothing: every hook route authenticates on the
//! `X-Supermux-Hook-Token` header, which is NOT a CORS-simple header — a browser
//! must preflight to send it, and the preflight is refused. A form POST
//! therefore arrives unauthenticated and is answered 401 exactly as it is today.

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use serde::de::DeserializeOwned;

use crate::error::AppError;

/// `Json<T>`, minus the `Content-Type` gate. See the module doc.
#[derive(Debug, Clone, Copy, Default)]
pub struct LenientJson<T>(pub T);

impl<S, T> FromRequest<S> for LenientJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(req, state)
            .await
            .map_err(|e| AppError::BadRequest(format!("could not read the request body: {e}")))?;
        if bytes.is_empty() {
            return Err(AppError::BadRequest(
                "expected a JSON object body (send it with curl's -d or --json)".into(),
            ));
        }
        serde_json::from_slice(&bytes).map(LenientJson).map_err(|e| {
            AppError::BadRequest(format!(
                "the body is not the JSON this endpoint expects: {e}"
            ))
        })
    }
}

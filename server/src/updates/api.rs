//! HTTP endpoints for the in-UI updater.
//!
//! All four routes are bearer-protected (same AUTH_TOKEN as the rest of
//! `/api/*`). Mounted from `http::router` via `updates::router_for`.
//!
//! Wire shapes are pinned by `tests::api_shape` so the frontend hook can rely
//! on them without spelunking the source.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use http::StatusCode;
use serde_json::json;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};

use crate::error::AppError;
use crate::state::AppState;

use super::exec::{self, UpdateEvent, UpdateStep};
use super::preflight;
use super::release::ReleaseCache;

/// Build the updates sub-router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/version", get(get_version))
        .route("/api/version/refresh", post(post_refresh))
        .route("/api/update/start", post(post_start))
        .route("/api/update/progress/{job_id}", get(get_progress))
        .with_state(state)
}

/// `GET /api/version`: current binary identity + latest release + preflight.
///
/// ALWAYS 200, even when blocked: the UI distinguishes "up to date",
/// "update available", and "update available but blocked" entirely from the
/// `update_available` / `blocked_reasons` fields. Failing this endpoint with
/// a non-200 would make the Settings → Updates section render an error state
/// for a perfectly benign "GitHub unreachable" case.
async fn get_version(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    let cache = state.updates.release_cache.clone();
    // Use the cached value when fresh; only kick off a network fetch when the
    // cache is stale or empty. We deliberately do NOT block the response on a
    // slow fetch. If the cache is empty AND the fetch is slow, return null
    // and let the UI re-poll.
    let latest = cache.get_or_fetch().await;
    let snap = preflight::run_preflight(latest);
    Ok(Json(json!({ "ok": true, "data": snap })))
}

/// `POST /api/version/refresh`: force-refresh the cached latest release.
async fn post_refresh(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    let cache: std::sync::Arc<ReleaseCache> = state.updates.release_cache.clone();
    let result = cache.force_refresh().await;
    let (latest, fetch_error) = match result {
        Ok(Some(r)) => (Some(r), None),
        Ok(None) => (cache.cached().await, Some("no published releases on the repository".to_string())),
        Err(e) => (cache.cached().await, Some(e.to_string())),
    };
    let snap = preflight::run_preflight(latest);
    Ok(Json(json!({ "ok": true, "data": snap, "fetch_error": fetch_error })))
}

/// `POST /api/update/start`: kick off an update.
///
/// Re-runs the preflight at call time so a stale "no blockers" snapshot from a
/// minute ago can't sneak the update past a now-dirty working tree. Refuses
/// (409) on any blocked reason. The response body carries the same blocked
/// reasons the UI already shows.
async fn post_start(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let cache = state.updates.release_cache.clone();
    let latest = cache.get_or_fetch().await;
    let snap = preflight::run_preflight(latest);

    if !snap.blocked_reasons.is_empty() {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "ok": false,
                "error": "update blocked. See blocked_reasons.",
                "blocked_reasons": snap.blocked_reasons,
            })),
        )
            .into_response());
    }

    // Resolve via the SAME helper preflight uses, so the two can never disagree
    // (a divergent 2-step copy here used to 500 on installs preflight had passed
    // because it lacked preflight's CWD-walk fallback). If it's still None we
    // refuse with 409: preflight above should already have surfaced NoRepoDir,
    // so this is a belt-and-suspenders guard that never returns a 500.
    let Some(repo) = preflight::detect_repo_dir() else {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "ok": false,
                "error": "update blocked: no source clone on the server to build from.",
            })),
        )
            .into_response());
    };

    let job_id = state.updates.jobs.create();
    let registry = state.updates.jobs.clone();
    let id = job_id.clone();
    let current_sha = super::version::CURRENT_SHA.to_string();

    exec::spawn_update_task(registry, id, repo, current_sha)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "ok": true, "data": { "job_id": job_id } })),
    )
        .into_response())
}

/// `GET /api/update/progress/:job_id`: SSE stream of [`UpdateEvent`]s for the
/// given job. Unknown id ⇒ 404. The handler immediately replays the LATEST
/// known event so a late-joining client sees the current state without waiting.
async fn get_progress(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let Some((rx, latest)) = state.updates.jobs.subscribe(&job_id).await else {
        return Err(AppError::NotFound(format!("update job {job_id}")));
    };
    let stream = event_stream(rx, latest);
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

/// Adapt a broadcast receiver into an SSE event stream; replay the latest
/// known event first so a fresh subscriber sees the current state immediately.
fn event_stream(
    rx: tokio::sync::broadcast::Receiver<UpdateEvent>,
    latest: Option<UpdateEvent>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let preamble = ::futures_util::stream::iter(latest.into_iter().map(|ev| Ok(to_sse_event(&ev))));
    let live = BroadcastStream::new(rx).filter_map(|res| match res {
        Ok(ev) => {
            // Close the stream after a terminal event so the client knows to
            // stop reconnecting.
            let close_after = matches!(
                ev.step,
                UpdateStep::Done | UpdateStep::Failed | UpdateStep::RolledBack
            );
            let ev = to_sse_event(&ev);
            if close_after {
                Some(Ok(ev))
            } else {
                Some(Ok(ev))
            }
        }
        Err(_) => None,
    });
    preamble.chain(live)
}

fn to_sse_event(ev: &UpdateEvent) -> Event {
    let data = serde_json::to_string(ev).unwrap_or_else(|_| "null".to_string());
    Event::default().event("update").data(data)
}


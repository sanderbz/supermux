//! In-UI update mechanism (v0.3.0).
//!
//! The supermux dashboard exposes a self-service updater under
//! Settings → Updates: the panel shows the running version, polls the latest
//! GitHub release, and (when an upgrade is safe to apply) offers a 1-click
//! "Update now" that triggers the same root-side path-unit pipeline as
//! `scripts/deploy-self.sh` and streams the install progress back as SSE.
//!
//! ## Modules
//!
//! * [`version`]: compile-time version baked by `build.rs`
//!   (`SUPERMUX_VERSION_TAG`/`_SHA`/`_BUILD_TIME` via `option_env!`).
//! * [`release`]: typed `LatestRelease` + the cached fetch from
//!   `api.github.com/repos/sanderbz/supermux/releases/latest`. 6-hour TTL:
//!   long enough that a million dashboards do not spam GitHub, short enough
//!   that a new tag surfaces the same day.
//! * [`preflight`]: `InstallMode` detection + every `BlockedReason` that can
//!   keep the "Update now" button disabled. Each reason carries the actionable
//!   English copy the UI renders verbatim.
//! * [`api`]: the four endpoints (`GET /api/version`,
//!   `POST /api/version/refresh`, `POST /api/update/start`,
//!   `GET /api/update/progress/:job_id`).
//! * [`exec`]: the tokio task that fast-forwards the source clone to
//!   `origin/main`, writes the path-unit marker file (so the root runner builds
//!   the now-updated clone), and owns the broadcast channel keyed by job_id that
//!   the SSE endpoint tails.
//!
//! ## Why GitHub + path-unit (not a binary delta)
//!
//! Supermux is OSS and self-hosted; users already trust the GitHub release
//! channel and the path-unit pipeline (built + battle-tested in v0.2.0). The
//! updater is a thin UX layer over both. We add zero new trust boundaries.

pub mod api;
pub mod exec;
pub mod preflight;
pub mod release;
pub mod version;

#[cfg(test)]
mod tests;

use axum::Router;
use std::sync::Arc;

use crate::state::AppState;

/// Build the updates sub-router. Mounted on the bearer-protected router by
/// `http::router` so the same AUTH_TOKEN gates `/api/version*` + `/api/update*`.
pub fn router_for(state: AppState) -> Router {
    api::router(state)
}

/// Process-wide updates registry: cached latest release + in-flight job table.
///
/// Cheap to clone (an `Arc`) and lives on `AppState`. The single instance is
/// created in `AppState::new` so every handler shares the same cache + job
/// registry. Without this an SSE `/progress` subscriber would be looking at a
/// different broadcast channel than the `/start` writer that spawned the task.
#[derive(Clone)]
pub struct UpdatesState {
    pub release_cache: Arc<release::ReleaseCache>,
    pub jobs: Arc<exec::JobRegistry>,
}

impl UpdatesState {
    pub fn new() -> Self {
        Self {
            release_cache: Arc::new(release::ReleaseCache::new()),
            jobs: Arc::new(exec::JobRegistry::new()),
        }
    }
}

impl Default for UpdatesState {
    fn default() -> Self {
        Self::new()
    }
}

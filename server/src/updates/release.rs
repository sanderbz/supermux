//! Fetch + cache the latest GitHub release.
//!
//! Why a 1-hour TTL:
//!   GitHub's unauthenticated rate limit is 60 requests/hour per IP. supermux
//!   makes NO other GitHub calls, so one `/releases/latest` fetch per instance
//!   per hour is negligible against that quota even when a handful of
//!   tabs/devices share an outbound IP. The panel polls `/api/version` every
//!   30s while open, but those polls hit this cache; only one fetch per hour
//!   actually reaches GitHub. The win: a freshly published release surfaces in
//!   the UI within an hour automatically, instead of being invisible for up to
//!   6 hours unless the user manually clicks "Check now" (which calls
//!   force_refresh and bypasses the TTL). A short TTL is the right trade-off
//!   for an update-notification surface; the quota headroom is enormous.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// Cache TTL. See module doc for the trade-off.
const TTL: Duration = Duration::from_secs(60 * 60);

/// Outbound request timeout. A user clicking "Refresh" must not hang the page
/// for minutes if GitHub is slow / unreachable; we bail in 5s and the UI shows
/// the prior cached value (or no badge at all if there is none).
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// `User-Agent` GitHub asks every API client to set. The repo URL is the right
/// "where did this come from" pointer for an op trying to reach us.
const USER_AGENT: &str = concat!(
    "supermux-server/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/sanderbz/supermux)"
);

/// The subset of GitHub's `releases/latest` JSON we care about. We rename to
/// the friendly `tag` + `sha` outbound; ingress reads via the
/// [`GithubReleaseWire`] shim so the public field names don't change just
/// because GitHub's wire names did.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LatestRelease {
    /// The release tag (e.g. `v0.3.0`). On the GitHub wire this is `tag_name`;
    /// the consumer sees `tag` because that's what the rest of the codebase
    /// calls it (`VersionInfo::tag`).
    pub tag: String,
    /// The release's target commit. Usually a branch name (`main`) for a
    /// freshly cut release. May be empty.
    pub sha: String,
    /// Release notes body (markdown). The UI renders it via MarkdownViewer.
    pub body: String,
    /// Browser URL for the release page on GitHub.
    pub html_url: String,
    /// Publish timestamp (ISO-8601 string from GitHub).
    pub published_at: Option<String>,
}

/// Wire-shape shim for GitHub's actual field names (`tag_name`,
/// `target_commitish`). Kept private so the rest of the codebase only ever
/// touches the friendly [`LatestRelease`] surface.
#[derive(Debug, Deserialize)]
struct GithubReleaseWire {
    tag_name: String,
    #[serde(default)]
    target_commitish: String,
    #[serde(default)]
    body: String,
    html_url: String,
    published_at: Option<String>,
}

impl From<GithubReleaseWire> for LatestRelease {
    fn from(w: GithubReleaseWire) -> Self {
        Self {
            tag: w.tag_name,
            sha: w.target_commitish,
            body: w.body,
            html_url: w.html_url,
            published_at: w.published_at,
        }
    }
}

/// Process-wide cache for the latest release. `None` = never fetched.
///
/// Wrapped in `RwLock` so concurrent `/api/version` reads do not serialize
/// against each other; only the single fetch that refills the cache takes a
/// write lock. The `Instant` is the time the value was stored; entries older
/// than `TTL` are treated as stale and re-fetched on the next read.
pub struct ReleaseCache {
    slot: RwLock<Option<(LatestRelease, Instant)>>,
}

impl ReleaseCache {
    pub fn new() -> Self {
        Self { slot: RwLock::new(None) }
    }

    /// Return the cached release if fresh; otherwise fetch, cache, and return
    /// it. On any fetch failure (network, 5xx, parse) returns `None` AND keeps
    /// whatever is currently cached. A transient outage must not blank the
    /// "Up to date" banner the user is already looking at.
    pub async fn get_or_fetch(self: &Arc<Self>) -> Option<LatestRelease> {
        if let Some((rel, t)) = self.slot.read().await.clone() {
            if t.elapsed() < TTL {
                return Some(rel);
            }
        }
        self.force_refresh().await.ok().flatten()
    }

    /// Force a network fetch, regardless of cache freshness. Returns `Ok(Some)`
    /// on success, `Ok(None)` when the request succeeded but produced no usable
    /// release (a brand-new repo with no published releases yet: GitHub
    /// answers 404), and `Err` for transport-level failures.
    pub async fn force_refresh(self: &Arc<Self>) -> Result<Option<LatestRelease>, FetchError> {
        let release = fetch_latest().await?;
        if let Some(ref r) = release {
            let mut w = self.slot.write().await;
            *w = Some((r.clone(), Instant::now()));
        }
        Ok(release)
    }

    /// The cached value WITHOUT re-fetching. Used by `/api/version` so a
    /// brand-new connection sees the last good payload immediately, then the
    /// background refresh kicks in if it's stale.
    pub async fn cached(&self) -> Option<LatestRelease> {
        self.slot.read().await.as_ref().map(|(r, _)| r.clone())
    }

    /// Test-only helper: seed a release directly into the cache so tests can
    /// drive the `update_available` / `blocked_reasons` logic without ever
    /// touching the network. Gated on `debug_assertions` (not `cfg(test)`) so
    /// integration tests in `tests/` (which compile against the optimised
    /// library, not its `cfg(test)` form) can call it.
    #[cfg(debug_assertions)]
    pub async fn seed(&self, release: LatestRelease) {
        let mut w = self.slot.write().await;
        *w = Some((release, Instant::now()));
    }
}

impl Default for ReleaseCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Errors from the upstream fetch. We map them all to a flat `String` for the
/// UI; operators see "GitHub unreachable" rather than a backtrace.
#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("network error: {0}")]
    Network(String),
    #[error("github responded {0}")]
    HttpStatus(u16),
    #[error("could not parse github response: {0}")]
    Parse(String),
}

/// One GET request to the latest-release endpoint. Returns `Ok(Some)` on a
/// 200 with a parseable body, `Ok(None)` on a 404 (repo with no releases yet),
/// and `Err` on anything else.
///
/// Authentication: anonymous by default (the OSS path, fine for a public
/// repo). If `SUPERMUX_GITHUB_TOKEN` is set in the process environment, send
/// it as a Bearer token. This covers two cases:
///   1. A user self-hosting their own private fork: without auth GitHub
///      returns 404 ("Couldn't reach GitHub" in the UI) for a private repo.
///   2. A shared-IP deployment that hits the 60-req/hour unauthenticated rate
///      limit. Authenticated requests get 5,000 req/hour, so even a noisy
///      caller never exhausts the quota.
/// There is deliberately no UI for this; it's a quiet env-var-only knob.
/// See `docs/SELF_HOST_DEV.md` "Advanced: private repos / rate limits".
async fn fetch_latest() -> Result<Option<LatestRelease>, FetchError> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| FetchError::Network(e.to_string()))?;

    let mut req = client
        .get("https://api.github.com/repos/sanderbz/supermux/releases/latest")
        .header("Accept", "application/vnd.github+json")
        // GitHub's documented "I am stable, don't return preview fields" header.
        .header("X-GitHub-Api-Version", "2022-11-28");

    // Optional bearer auth. Only sent when the env var is set + non-empty, so
    // the default behaviour (anonymous fetch against a public repo) is byte-
    // identical to v0.3.0. Lowercase `Bearer ` per GitHub's docs.
    if let Ok(token) = std::env::var("SUPERMUX_GITHUB_TOKEN") {
        let token = token.trim();
        if !token.is_empty() {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| FetchError::Network(e.to_string()))?;

    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(FetchError::HttpStatus(status.as_u16()));
    }
    let wire: GithubReleaseWire = resp
        .json()
        .await
        .map_err(|e| FetchError::Parse(e.to_string()))?;
    Ok(Some(wire.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cached_returns_seeded_value_without_network() {
        let cache = Arc::new(ReleaseCache::new());
        let rel = LatestRelease {
            tag: "v0.3.0".into(),
            sha: "main".into(),
            body: "test".into(),
            html_url: "https://example.invalid".into(),
            published_at: None,
        };
        cache.seed(rel.clone()).await;
        // `cached()` reads the slot directly. No network.
        let got = cache.cached().await.expect("cached value");
        assert_eq!(got, rel);
    }

    #[tokio::test]
    async fn get_or_fetch_returns_fresh_cache_without_network() {
        let cache = Arc::new(ReleaseCache::new());
        let rel = LatestRelease {
            tag: "v9.9.9".into(),
            sha: "main".into(),
            body: String::new(),
            html_url: "https://example.invalid".into(),
            published_at: None,
        };
        cache.seed(rel.clone()).await;
        // `get_or_fetch` should hit the cache (TTL just elapsed = 0s); a real
        // network call to api.github.com would either succeed or fail, but
        // either way it would NOT return our seeded `v9.9.9`.
        let got = cache.get_or_fetch().await.expect("hit cache");
        assert_eq!(got.tag, "v9.9.9");
    }
}

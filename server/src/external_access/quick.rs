//! The zero-config Cloudflare **quick tunnel** seam (design §4.1).
//!
//! `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate` opens an
//! anonymous tunnel and prints an ephemeral `https://<random>.trycloudflare.com`
//! URL to **stderr** — no account, no token, no DNS, no config file. The URL is
//! only knowable by reading that stderr, and the process must stay alive for the
//! tunnel to stay up, so a quick tunnel is a **supervised tokio child** behind a
//! mockable seam (NOT a systemd unit — `systemd --user` is unavailable on this
//! box, and a unit's stdout goes to a journal we cannot easily read).
//!
//! [`RealQuickTunnelHost`] spawns + stderr-scans; [`MockQuickTunnelHost`] returns
//! a canned URL so the whole provisioning flow is testable WITHOUT a live tunnel.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use once_cell::sync::Lazy;
use regex::Regex;
use tokio::io::{AsyncBufReadExt, BufReader};

/// A live quick tunnel: the public URL + the child we own (SIGTERM on stop/drop).
#[derive(Debug)]
pub struct QuickTunnelHandle {
    /// `https://<random>.trycloudflare.com`.
    pub url: String,
    /// `<random>.trycloudflare.com` (the `CompanyHost` key).
    pub host: String,
    /// The supervised `cloudflared` child. `None` for a test/fake handle.
    child: Option<tokio::process::Child>,
    /// Unix seconds when it was started.
    pub started_at: i64,
}

impl QuickTunnelHandle {
    /// Is the child still alive? Best-effort — `true` when we cannot tell (a fake
    /// handle with no child reports alive so tests can assert `active`). A real
    /// child that has exited reports `false`, so `status` is honest.
    pub fn is_alive(&mut self) -> bool {
        match &mut self.child {
            None => true,
            Some(child) => matches!(child.try_wait(), Ok(None)),
        }
    }

    /// SIGTERM the child (best-effort). Consumes the handle.
    pub async fn terminate(mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
}

impl Drop for QuickTunnelHandle {
    fn drop(&mut self) {
        // Best-effort SIGTERM if the handle is dropped without an explicit stop
        // (e.g. process teardown). `start_kill` is non-blocking.
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

/// A quick-tunnel failure. Never panics; surfaced honestly by `status`.
#[derive(Debug, thiserror::Error)]
pub enum QuickError {
    #[error("could not spawn cloudflared: {0}")]
    Spawn(String),
    #[error("cloudflared did not print a trycloudflare URL in time")]
    NoUrl,
}

/// The mockable quick-tunnel surface (parallels
/// [`super::systemd::ConnectorHost`]).
#[async_trait]
pub trait QuickTunnelHost: Send + Sync {
    /// Spawn `cloudflared tunnel --url <local_url> --no-autoupdate`, scan stderr
    /// for the trycloudflare URL (bounded timeout), return the handle. Never panics.
    async fn start(&self, bin: &Path, local_url: &str) -> Result<QuickTunnelHandle, QuickError>;
    /// SIGTERM the child; best-effort.
    async fn stop(&self, handle: QuickTunnelHandle);
}

/// How long to wait for cloudflared to print its URL before giving up.
const URL_SCAN_TIMEOUT: Duration = Duration::from_secs(30);

/// The `https://<x>.trycloudflare.com` matcher. A SIMPLE anchored pattern with no
/// bounded `{m,n}` quantifier (per the repo's grep/regex OOM guidance) — it runs
/// against short stderr lines only.
static TRYCLOUDFLARE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com").unwrap());

/// Extract the first trycloudflare URL from a single stderr line, if present.
/// Pure + unit-testable (no process). Returns the matched `https://…` URL.
pub fn extract_trycloudflare_url(line: &str) -> Option<String> {
    TRYCLOUDFLARE_RE
        .find(&line.to_ascii_lowercase())
        .map(|m| m.as_str().to_string())
}

/// The real host: `tokio::process::Command` + stderr scan.
pub struct RealQuickTunnelHost;

#[async_trait]
impl QuickTunnelHost for RealQuickTunnelHost {
    async fn start(&self, bin: &Path, local_url: &str) -> Result<QuickTunnelHandle, QuickError> {
        let mut child = tokio::process::Command::new(bin)
            .arg("tunnel")
            .arg("--url")
            .arg(local_url)
            .arg("--no-autoupdate")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| QuickError::Spawn(e.to_string()))?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| QuickError::Spawn("no stderr pipe".to_string()))?;

        // Scan stderr line-by-line for the URL, bounded by a timeout. On timeout
        // (or EOF without a URL) SIGTERM the child and report NoUrl.
        let scan = async {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(url) = extract_trycloudflare_url(&line) {
                    return Some(url);
                }
            }
            None
        };

        match tokio::time::timeout(URL_SCAN_TIMEOUT, scan).await {
            Ok(Some(url)) => {
                let host = host_of(&url);
                Ok(QuickTunnelHandle {
                    url,
                    host,
                    child: Some(child),
                    started_at: chrono::Utc::now().timestamp(),
                })
            }
            _ => {
                // Timed out or stderr closed with no URL — tear the child down.
                let _ = child.start_kill();
                let _ = child.wait().await;
                Err(QuickError::NoUrl)
            }
        }
    }

    async fn stop(&self, handle: QuickTunnelHandle) {
        handle.terminate().await;
    }
}

/// Strip the scheme from a `https://host` URL, returning the bare host.
fn host_of(url: &str) -> String {
    url.strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url)
        .trim_end_matches('/')
        .to_string()
}

// ── test double ──────────────────────────────────────────────────────────────

/// Returns a canned URL and records start/stop calls, so the provisioning flow is
/// testable without a live tunnel or network.
#[cfg(test)]
pub struct MockQuickTunnelHost {
    pub url: String,
    pub starts: std::sync::atomic::AtomicUsize,
    pub stops: std::sync::atomic::AtomicUsize,
    /// When set, `start` returns this error instead of a handle.
    pub fail: Option<()>,
}

#[cfg(test)]
impl MockQuickTunnelHost {
    pub fn with_url(url: &str) -> Self {
        Self {
            url: url.to_string(),
            starts: std::sync::atomic::AtomicUsize::new(0),
            stops: std::sync::atomic::AtomicUsize::new(0),
            fail: None,
        }
    }
    pub fn start_count(&self) -> usize {
        self.starts.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub fn stop_count(&self) -> usize {
        self.stops.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
#[async_trait]
impl QuickTunnelHost for MockQuickTunnelHost {
    async fn start(&self, _bin: &Path, _local_url: &str) -> Result<QuickTunnelHandle, QuickError> {
        self.starts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.fail.is_some() {
            return Err(QuickError::NoUrl);
        }
        let url = self.url.clone();
        let host = host_of(&url);
        Ok(QuickTunnelHandle {
            url,
            host,
            child: None, // no real process in tests
            started_at: chrono::Utc::now().timestamp(),
        })
    }

    async fn stop(&self, handle: QuickTunnelHandle) {
        self.stops.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        handle.terminate().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A representative cloudflared stderr banner (verified against the real CLI
    /// output shape). The URL sits inside a boxed banner line.
    #[test]
    fn scanner_extracts_url_from_a_representative_banner() {
        let banner = "2026-08-23T12:00:00Z INF |  https://calm-frog-1234.trycloudflare.com   |";
        assert_eq!(
            extract_trycloudflare_url(banner).as_deref(),
            Some("https://calm-frog-1234.trycloudflare.com")
        );
        // A plain (unboxed) info line also matches.
        let plain = "INF +--- https://neat-owl-7.trycloudflare.com ---+";
        assert_eq!(
            extract_trycloudflare_url(plain).as_deref(),
            Some("https://neat-owl-7.trycloudflare.com")
        );
    }

    #[test]
    fn scanner_ignores_unrelated_lines() {
        assert!(extract_trycloudflare_url("INF Starting tunnel").is_none());
        assert!(extract_trycloudflare_url("https://example.com/not-cf").is_none());
        assert!(extract_trycloudflare_url("").is_none());
    }

    #[test]
    fn host_of_strips_scheme_and_trailing_slash() {
        assert_eq!(host_of("https://calm-frog.trycloudflare.com/"), "calm-frog.trycloudflare.com");
        assert_eq!(host_of("https://x.trycloudflare.com"), "x.trycloudflare.com");
    }

    #[tokio::test]
    async fn mock_start_returns_the_canned_url_and_counts() {
        let mock = MockQuickTunnelHost::with_url("https://mock-host-1.trycloudflare.com");
        let handle = mock
            .start(Path::new("/bin/true"), "http://localhost:8823")
            .await
            .expect("mock start ok");
        assert_eq!(handle.url, "https://mock-host-1.trycloudflare.com");
        assert_eq!(handle.host, "mock-host-1.trycloudflare.com");
        assert_eq!(mock.start_count(), 1);
        mock.stop(handle).await;
        assert_eq!(mock.stop_count(), 1);
    }
}

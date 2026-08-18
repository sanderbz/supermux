//! Outbound operator alerts: a Slack-compatible incoming webhook fired when a
//! schedule run ends in `error`.
//!
//! **Why.** The existing failure signal for a schedule is a web push
//! (`push::send_push_for`), which reaches nobody on a host with zero
//! subscriptions, plus a `schedule_runs` row nobody reads until they look. A
//! boot schedule that failed to start its session was invisible for hours. An
//! incoming webhook needs no device registration and no app: point
//! `alert_webhook_url` at a Slack/Mattermost/whatever incoming hook and the
//! failure shows up in a channel within seconds.
//!
//! **Scope.** All schedule kinds (`boot`, `shell`, `tmux`) alert on
//! `status == "error"` only; successes would be noise for a 5-minute cron. Best
//! effort throughout: the sender is spawned off the run loop, never blocks it,
//! and a failed POST is a `warn!` and nothing more. Unset config = feature off.
//!
//! **Flood control.** One alert per schedule per [`COOLDOWN`], kept in memory
//! (a restart forgets it, which is the right bias: after a restart the operator
//! wants to hear about it again). The cooldown is stamped when the attempt is
//! made, not when it succeeds, so a webhook that is itself broken cannot turn a
//! 1-minute cron into a retry storm.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, Utc};

use crate::db::schedules::Schedule;
use crate::state::AppState;

/// Minimum gap between two alerts for the SAME schedule id.
pub const COOLDOWN: Duration = Duration::from_secs(30 * 60);

/// How long the webhook POST may take before it is abandoned.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Longest failure note carried into the alert text (matches the scheduler's
/// own 500-char note cap; notes from other callers may not be trimmed yet).
const NOTE_MAX_CHARS: usize = 500;

/// Last attempt per schedule id. In-memory on purpose (see the module docs).
fn last_attempt() -> &'static Mutex<HashMap<String, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// May a schedule whose last alert attempt was `last` alert again at `now`?
pub fn should_send(last: Option<Instant>, now: Instant) -> bool {
    match last {
        None => true,
        Some(prev) => now.saturating_duration_since(prev) >= COOLDOWN,
    }
}

/// Trim a note to [`NOTE_MAX_CHARS`], slicing on a char boundary.
fn truncate_note(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() <= NOTE_MAX_CHARS {
        return s.to_string();
    }
    let mut out: String = s.chars().take(NOTE_MAX_CHARS).collect();
    out.push('…');
    out
}

/// Escape the three characters Slack treats as mrkdwn markup in a `text`
/// field. Without this a schedule titled `<!channel>` pings the whole
/// workspace, and any `<`, `>` or `&` renders as link syntax. Slack's rule is
/// exactly these three, and `&` has to go first or the later replacements
/// would be escaped twice.
fn escape_mrkdwn(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The one-line message posted to the webhook.
pub fn alert_text(sched: &Schedule, note: &str, at: DateTime<Utc>) -> String {
    let when = at.format("%Y-%m-%d %H:%M:%SZ");
    let head = format!(
        "supermux schedule '{}' ({}, {}) errored at {when}",
        escape_mrkdwn(&sched.title),
        sched.kind,
        sched.id
    );
    let note = escape_mrkdwn(&truncate_note(note));
    if note.is_empty() {
        head
    } else {
        format!("{head}: {note}")
    }
}

/// Reduce a `reqwest::Error` to its failure class.
///
/// Every send, connect and timeout error reqwest builds is stamped with the
/// request URL, and its `Display` prints it ("error sending request for url
/// (https://hooks.slack.com/services/...)"). That URL IS the credential here,
/// so no `reqwest::Error` may ever reach a log, an anyhow chain or a caller.
/// This is the only way one leaves [`post_webhook`].
fn error_class(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "connect failed"
    } else if e.is_builder() {
        "malformed url or client config"
    } else if e.is_body() {
        "body error"
    } else if e.is_decode() {
        "decode error"
    } else if e.is_request() {
        "request failed"
    } else {
        "transport error"
    }
}

/// POST `{"text": ...}` to an incoming-webhook URL (Slack's shape, which
/// Mattermost and the ops scripts here also accept).
///
/// The returned error never carries the URL: see [`error_class`].
pub async fn post_webhook(url: &str, text: &str) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| anyhow!("http client build failed: {}", error_class(&e)))?;
    let req = client
        .post(url)
        .json(&serde_json::json!({ "text": text }))
        .build()
        .map_err(|e| anyhow!("webhook request build failed: {}", error_class(&e)))?;
    let resp = client
        .execute(req)
        .await
        .map_err(|e| anyhow!("webhook post failed: {}", error_class(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        // The body can carry the provider's reason ("invalid_token"); the URL
        // never gets logged, it IS the credential.
        let body = resp.text().await.unwrap_or_default();
        bail!("webhook replied {status}: {}", truncate_note(&body));
    }
    Ok(())
}

/// Alert on a failed schedule run. Silent when no webhook is configured or the
/// per-schedule cooldown is still running. Never returns an error: the caller
/// is the run loop, and an alert that fails must not change the run's outcome.
pub async fn schedule_error(state: &AppState, sched: &Schedule, note: &str) {
    let Some(url) = state.config.alert_webhook_url.clone() else {
        return;
    };
    {
        let now = Instant::now();
        let mut map = match last_attempt().lock() {
            Ok(m) => m,
            Err(poisoned) => poisoned.into_inner(),
        };
        if !should_send(map.get(&sched.id).copied(), now) {
            tracing::debug!(schedule = %sched.id, "alert webhook held by cooldown");
            return;
        }
        // Drop entries whose cooldown has expired: they can no longer hold
        // anything back, and without this the map grows for the process
        // lifetime with every schedule id ever seen (deleted ones included).
        map.retain(|_, t| now.saturating_duration_since(*t) < COOLDOWN);
        map.insert(sched.id.clone(), now);
    }
    let text = alert_text(sched, note, Utc::now());
    match post_webhook(&url, &text).await {
        Ok(()) => tracing::info!(schedule = %sched.id, "schedule error alert sent"),
        Err(e) => tracing::warn!(schedule = %sched.id, error = %e, "schedule error alert failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn sched(title: &str, id: &str, kind: &str) -> crate::db::schedules::Schedule {
        let mut s = crate::db::schedules::Schedule {
            id: id.into(),
            title: title.into(),
            session: String::new(),
            command: String::new(),
            prompt: String::new(),
            kind: kind.into(),
            boot_dir: String::new(),
            boot_provider: "claude".into(),
            boot_worktree: 0,
            sched_type: "recurring".into(),
            recurrence: None,
            run_at: None,
            next_run: None,
            last_run: None,
            enabled: 1,
            run_count: 0,
            schedule_expr: Some("every 1m".into()),
            watch: 0,
            watch_timeout: 120,
            done_pattern: None,
            done_action: "disable".into(),
            confirm_finish: 0,
            bypass_permissions: 0,
            created: 0,
            updated: 0,
            deleted: None,
        };
        s.session = "sess".into();
        s
    }

    #[test]
    fn alert_text_names_the_schedule_and_the_failure() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-08-17T04:30:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let text = alert_text(&sched("nightly sweep", "SCHED-7", "boot"), "boot start failed", at);
        assert!(text.contains("nightly sweep"), "{text}");
        assert!(text.contains("SCHED-7"), "{text}");
        assert!(text.contains("boot"), "{text}");
        assert!(text.contains("boot start failed"), "{text}");
        assert!(text.contains("2026-08-17"), "{text}");
    }

    #[test]
    fn alert_text_caps_a_runaway_note() {
        let at = chrono::Utc::now();
        let text = alert_text(&sched("t", "SCHED-1", "shell"), &"x".repeat(2000), at);
        assert!(text.chars().count() < 700, "note not capped: {} chars", text.chars().count());
        assert!(text.ends_with('…'), "{text}");
    }

    #[test]
    fn alert_text_without_a_note_is_still_readable() {
        let at = chrono::Utc::now();
        let text = alert_text(&sched("t", "SCHED-1", "tmux"), "  ", at);
        assert!(!text.ends_with(": "), "{text}");
        assert!(text.contains("SCHED-1"), "{text}");
    }

    #[test]
    fn cooldown_allows_the_first_alert_and_then_holds() {
        let t0 = Instant::now();
        assert!(should_send(None, t0), "first alert must go out");
        assert!(!should_send(Some(t0), t0 + Duration::from_secs(60)));
        assert!(!should_send(Some(t0), t0 + COOLDOWN - Duration::from_secs(1)));
        assert!(should_send(Some(t0), t0 + COOLDOWN));
        assert!(should_send(Some(t0), t0 + COOLDOWN + Duration::from_secs(1)));
    }

    #[tokio::test]
    async fn post_webhook_sends_a_slack_shaped_json_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await
                .unwrap();
            sock.flush().await.unwrap();
            req
        });

        post_webhook(&format!("http://{addr}/hook"), "supermux schedule 'x' errored")
            .await
            .expect("post");
        let req = server.await.unwrap();
        assert!(req.starts_with("POST /hook "), "{req}");
        assert!(req.contains("application/json"), "{req}");
        assert!(
            req.contains(r#"{"text":"supermux schedule 'x' errored"}"#),
            "{req}"
        );
    }

    #[tokio::test]
    async fn post_webhook_reports_a_non_2xx_reply() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = sock.read(&mut buf).await.unwrap();
            let _ = sock
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 3\r\n\r\nbad")
                .await;
        });

        let err = post_webhook(&format!("http://{addr}/hook"), "boom")
            .await
            .expect_err("500 must surface");
        assert!(format!("{err}").contains("500"), "{err}");
    }

    /// The URL is the credential. A transport failure is the most likely
    /// failure path, and reqwest stamps the URL into that error's Display, so
    /// this asserts the error we hand back is scrubbed.
    #[tokio::test]
    async fn post_webhook_error_never_carries_the_url() {
        // Bind then drop, so the port is (almost certainly) closed and the
        // connect fails immediately.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let url = format!("http://{addr}/services/T000/B000/SUPERSECRETTOKEN");
        let err = post_webhook(&url, "boom")
            .await
            .expect_err("a closed port must fail");
        for rendered in [format!("{err}"), format!("{err:?}"), format!("{err:#}")] {
            assert!(!rendered.contains(&url), "url leaked: {rendered}");
            assert!(!rendered.contains("SUPERSECRETTOKEN"), "token leaked: {rendered}");
            assert!(!rendered.contains(&addr.to_string()), "host leaked: {rendered}");
        }
    }

    #[tokio::test]
    async fn post_webhook_rejects_a_malformed_url_without_echoing_it() {
        let err = post_webhook("not-a-url://%%%/SUPERSECRETTOKEN", "boom")
            .await
            .expect_err("a malformed url must fail");
        let rendered = format!("{err:#}");
        assert!(!rendered.contains("SUPERSECRETTOKEN"), "url leaked: {rendered}");
    }

    #[test]
    fn alert_text_escapes_slack_mrkdwn_in_the_title_and_note() {
        let at = chrono::Utc::now();
        let text = alert_text(
            &sched("<!channel> R&D <b>", "SCHED-9", "boot"),
            "failed on <stdin> & gave up",
            at,
        );
        assert!(text.contains("&lt;!channel&gt; R&amp;D &lt;b&gt;"), "{text}");
        assert!(text.contains("&lt;stdin&gt; &amp; gave up"), "{text}");
        assert!(!text.contains("<!channel>"), "{text}");
    }
}

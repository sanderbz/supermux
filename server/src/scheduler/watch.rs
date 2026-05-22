//! Watch-mode poller (TECH_PLAN §3.8; feature-extract §4.6).
//!
//! After a `watch=1` tmux schedule fires, [`spawn`] polls the target session's
//! scrollback every 5s for up to `watch_timeout` seconds, isolates the NEW output
//! (relative to the pre-send capture via a tail anchor), and matches it against
//! `done_pattern` (regex, case-insensitive; substring fallback on a bad regex).
//! On a match it fires `done_action`:
//!
//! - `disable`            → set `enabled = 0`, log the run `done`.
//! - `notify`             → SSE alert only, log the run `done`.
//! - `command:<text>`     → send `<text>` to the session, then disable, log `done`.

use std::time::Duration;

use chrono::Utc;
use regex::RegexBuilder;
use serde_json::json;

use crate::db;
use crate::db::schedules::Schedule;
use crate::sessions;
use crate::state::{AppState, SseEvent};

/// Spawn the background watcher for a just-fired schedule.
pub fn spawn(state: AppState, sched: Schedule, pre_output: String) {
    tokio::spawn(async move {
        poll(state, sched, pre_output).await;
    });
}

async fn poll(state: AppState, sched: Schedule, pre_output: String) {
    let timeout = sched.watch_timeout.max(1) as u64;
    let anchor = tail_anchor(&pre_output);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);

    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if tokio::time::Instant::now() >= deadline {
            tracing::debug!(schedule = %sched.id, "watch timed out without match");
            return;
        }
        let capture = match sessions::lifecycle::peek(&state, &sched.session, 200).await {
            Ok(c) => c,
            Err(e) => {
                tracing::debug!(schedule = %sched.id, error = %e, "watch capture failed");
                continue;
            }
        };
        let new_output = delta(&capture, &anchor);
        if let Some(pat) = sched.done_pattern.as_deref() {
            if !pat.is_empty() && matches(&new_output, pat) {
                fire_done(&state, &sched).await;
                return;
            }
        }
    }
}

/// The tail anchor: last 100 chars of the last 200 chars of the pre-output. Used
/// to locate where new output begins in a later capture.
fn tail_anchor(pre: &str) -> String {
    let last200: String = {
        let chars: Vec<char> = pre.chars().collect();
        let start = chars.len().saturating_sub(200);
        chars[start..].iter().collect()
    };
    let chars: Vec<char> = last200.chars().collect();
    let start = chars.len().saturating_sub(100);
    chars[start..].iter().collect()
}

/// Output produced AFTER the anchor (everything if the anchor isn't found).
fn delta(capture: &str, anchor: &str) -> String {
    if anchor.is_empty() {
        return capture.to_string();
    }
    match capture.rfind(anchor) {
        Some(idx) => capture[idx + anchor.len()..].to_string(),
        None => capture.to_string(),
    }
}

/// Regex match (case-insensitive); falls back to a substring search if the
/// pattern doesn't compile.
fn matches(haystack: &str, pattern: &str) -> bool {
    match RegexBuilder::new(pattern).case_insensitive(true).build() {
        Ok(re) => re.is_match(haystack),
        Err(_) => haystack.to_lowercase().contains(&pattern.to_lowercase()),
    }
}

/// Apply `done_action` and record a `done` run.
async fn fire_done(state: &AppState, sched: &Schedule) {
    let action = sched.done_action.as_str();
    let mut note = format!("watch matched: {action}");

    if let Some(text) = action.strip_prefix("command:") {
        let _ = sessions::lifecycle::send_text(state, &sched.session, text).await;
        let _ = db::schedules::set_enabled(&state.pool, &sched.id, false).await;
        note = format!("watch matched; sent follow-up + disabled: {text}");
    } else if action == "disable" {
        let _ = db::schedules::set_enabled(&state.pool, &sched.id, false).await;
    }
    // `notify` (and any other value) is alert-only.

    let _ = db::schedules::insert_run(&state.pool, &sched.id, Utc::now().timestamp(), "done", &note).await;
    let _ = state.sse_tx.send(SseEvent {
        event: "alerts".to_string(),
        payload: json!({
            "level": "info",
            "source": "scheduler",
            "schedule": sched.id,
            "detail": format!("Watch complete: {}", sched.title),
        }),
    });
}

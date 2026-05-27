//! Watch-mode poller (TECH_PLAN §3.8; feature-extract §4.6).
//!
//! After a `watch=1` tmux schedule fires, [`spawn`] watches the target session
//! for the agent finishing its turn via TWO complementary signals — whichever
//! fires first wins:
//!
//! 1. **Structural status transition (apex signal; the 100x fix).** Subscribe to
//!    the per-session status [`watch::Sender`] the [`StatusDetector`] already
//!    publishes on every flap-confirmed transition (Active→Idle via the Stop
//!    hook for Claude sessions, content-bank/heartbeat fallback for everything
//!    else). When the watcher observes an `idle` post-send (i.e. with a version
//!    strictly newer than the baseline captured at watch start), that IS the
//!    "agent is done" signal — no `done_pattern` required. This is the same
//!    primitive [`agents::wait`](crate::agents::wait) uses for
//!    `?state=done`/`?state=idle` long-polls, so it is battle-tested.
//! 2. **Legacy content regex (kept additive).** Every 5s the watcher still
//!    polls `tmux capture-pane`, isolates the NEW output (relative to the
//!    pre-send capture via a tail anchor), and matches it against
//!    `done_pattern` (regex, case-insensitive; substring fallback on a bad
//!    regex). This is the original v2 behavior — preserved for shell jobs and
//!    for users who configured a literal sentinel (`✓ done`, `BUILD SUCCESS`).
//!
//! Either signal triggers `done_action`:
//!
//! - `disable`            → set `enabled = 0`, log the run `done`.
//! - `notify`             → SSE alert only, log the run `done`.
//! - `command:<text>`     → send `<text>` to the session, then disable, log `done`.
//!
//! [`StatusDetector`]: crate::sessions::status::StatusDetector

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

    // ── Structural status signal subscription (the 100x fix) ─────────────────
    // Subscribe to the session's per-session status watch channel BEFORE the
    // first poll iteration. Capture the version observed RIGHT NOW as the
    // baseline so we only fire on an idle transition that happened AFTER the
    // schedule's send: if the session was already idle (sitting at a prompt)
    // when watch::spawn ran, that baseline idle does NOT count — we wait for
    // the NEXT idle, which is the genuine "turn just finished" edge.
    let status_tx = state.status_watch_for(&sched.session);
    let mut status_rx = status_tx.subscribe();
    let baseline_version = status_rx.borrow().1;

    loop {
        // Race the 5s legacy poll against any structural status transition.
        // `status_rx.changed()` fires the moment the detector commits ANY new
        // status (M5b: flap-debounced, DB-first then watch send), so an idle
        // transition reaches us within ~50ms of being decided — orders of
        // magnitude faster than the legacy 5s poll, and works with ZERO
        // configured `done_pattern`.
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            changed = status_rx.changed() => {
                if changed.is_err() {
                    // Sender dropped (session deleted mid-watch): nothing to
                    // wait for. Treat as a timeout — schedule will simply not
                    // fire done_action, same as a pre-existing watch_timeout.
                    tracing::debug!(schedule = %sched.id, "watch: status sender dropped (session gone)");
                    return;
                }
                let (status, version) = status_rx.borrow_and_update().clone();
                if status == "idle" && version != baseline_version {
                    tracing::debug!(
                        schedule = %sched.id,
                        session = %sched.session,
                        version,
                        "watch fired on status→idle transition (structural signal)"
                    );
                    fire_done(&state, &sched, "status→idle").await;
                    return;
                }
                // Any other transition (active, waiting, …): keep watching.
                // We DELIBERATELY do not treat `waiting` as "done" — a session
                // blocked on the user is the opposite of finished; the user
                // needs to act, then the agent will resume and eventually idle.
                continue;
            }
        }

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
                fire_done(&state, &sched, "regex").await;
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

/// Apply `done_action` and record a `done` run. `signal` describes WHICH path
/// fired (`"status→idle"` for the structural transition, `"regex"` for the
/// legacy `done_pattern` match) so an operator can tell from the audit ledger
/// which signal ultimately recognized the agent finished.
async fn fire_done(state: &AppState, sched: &Schedule, signal: &str) {
    let action = sched.done_action.as_str();
    let mut note = format!("watch matched ({signal}): {action}");

    if let Some(text) = action.strip_prefix("command:") {
        let _ = sessions::lifecycle::send_text(state, &sched.session, text).await;
        let _ = db::schedules::set_enabled(&state.pool, &sched.id, false).await;
        note = format!("watch matched ({signal}); sent follow-up + disabled: {text}");
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

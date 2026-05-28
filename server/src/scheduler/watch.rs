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
//! - `notify`             → phone push (`ScheduleFinished`) + SSE alert, log `done`.
//! - `command:<text>`     → send `<text>` to the session, then disable, log `done`.
//!
//! All three are deduped by a per-schedule fire-guard so the structural signal,
//! the regex match, and the agent-confirm hook (`/api/hook/schedule/done`) can
//! never double-fire. On timeout a `notify` schedule still pushes a "still
//! running" heads-up rather than going silent ([`notify_timeout`]).
//!
//! [`StatusDetector`]: crate::sessions::status::StatusDetector

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::Utc;
use regex::RegexBuilder;
use serde_json::json;

use crate::db;
use crate::db::schedules::Schedule;
use crate::sessions;
use crate::state::{AppState, SseEvent};

/// Per-schedule "already fired this watch cycle" guard. Completion can be
/// observed by TWO independent paths — the watch loop's status→idle transition
/// and the agent-confirm hook (`/api/hook/schedule/done`) — which would
/// otherwise double-fire `done_action` (a duplicate push, or a duplicate
/// `command:` send). This collapses them to one. `reset_fire` clears the flag at
/// the start of each watch cycle so a recurring schedule fires again next time.
fn fire_guard() -> &'static Mutex<HashSet<String>> {
    static G: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Begin a fresh watch cycle for `id`: clear any prior "fired" flag.
fn reset_fire(id: &str) {
    if let Ok(mut g) = fire_guard().lock() {
        g.remove(id);
    }
}

/// Claim the single "done" for `id` this cycle. Returns `true` exactly once;
/// later callers (the other signal) get `false` and must skip. A poisoned lock
/// fails OPEN (fires) — a missed dedup is a duplicate ping, never a lost one.
fn claim_fire(id: &str) -> bool {
    match fire_guard().lock() {
        Ok(mut g) => g.insert(id.to_string()),
        Err(_) => true,
    }
}

/// Spawn the background watcher for a just-fired schedule.
pub fn spawn(state: AppState, sched: Schedule, pre_output: String) {
    tokio::spawn(async move {
        poll(state, sched, pre_output).await;
    });
}

/// Fire the schedule's `done_action` because the AGENT explicitly confirmed
/// completion via `/api/hook/schedule/done` (the high-reliability tier). Shares
/// the fire-guard with the watch loop, so confirming a schedule the watch
/// already finished — or confirming twice — is a no-op, not a double push.
pub async fn confirm_done(state: &AppState, sched: &Schedule) {
    fire_done(state, sched, "agent-confirmed").await;
}

async fn poll(state: AppState, sched: Schedule, pre_output: String) {
    // New watch cycle: clear any "fired" flag a prior fire of this (recurring)
    // schedule left behind, so this cycle's completion can fire once.
    reset_fire(&sched.id);

    let timeout = sched.watch_timeout.max(1) as u64;
    let anchor = tail_anchor(&pre_output);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
    // The legacy 5s pane poll only matters when a `done_pattern` is configured;
    // with none, the structural status→idle subscription is the whole signal and
    // we skip the `capture-pane` shell-out entirely (lets the timeout be generous
    // without polling cost for the common no-pattern case).
    let need_capture = sched.done_pattern.as_deref().is_some_and(|p| !p.is_empty());

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
            // Never go dark on a `notify` schedule: tell the user it couldn't
            // confirm completion rather than silently dropping the promise.
            notify_timeout(&state, &sched).await;
            return;
        }
        if need_capture {
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
    // Dedup: the status→idle transition, the regex match, and the agent-confirm
    // hook can all observe the same completion. Only the first fires.
    if !claim_fire(&sched.id) {
        tracing::debug!(schedule = %sched.id, signal, "watch: done already fired this cycle — skipping");
        return;
    }

    let action = sched.done_action.as_str();
    let mut note = format!("watch matched ({signal}): {action}");

    if let Some(text) = action.strip_prefix("command:") {
        let _ = sessions::lifecycle::send_text(state, &sched.session, text).await;
        let _ = db::schedules::set_enabled(&state.pool, &sched.id, false).await;
        note = format!("watch matched ({signal}); sent follow-up + disabled: {text}");
    } else if action == "disable" {
        let _ = db::schedules::set_enabled(&state.pool, &sched.id, false).await;
    } else if action == "notify" {
        // Real phone push (the UI's "Send me notification when done" promise) —
        // previously this path was SSE-only, so nothing reached the device. The
        // per-schedule opt-in IS the gate; the `schedule_finished` category is a
        // global mute, distinct from interactive "agent finished" idle pings.
        let st = state.clone();
        let title = sched.title.clone();
        tokio::spawn(async move {
            let _ = crate::push::send_push_for(
                &st,
                crate::db::push::NotifCategory::ScheduleFinished,
                &format!("schedule '{title}' finished"),
                &format!("'{title}' finished."),
                "/scheduler",
            )
            .await;
        });
    }

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

/// The watch deadline elapsed without observing completion. For a `notify`
/// schedule, push a "still running — couldn't confirm" heads-up instead of
/// returning silently (the old behaviour, which made long jobs feel broken).
/// Deliberately does NOT claim the fire-guard: if the agent later calls the
/// agent-confirm hook, the genuine "finished" push still fires.
async fn notify_timeout(state: &AppState, sched: &Schedule) {
    if sched.done_action != "notify" {
        return;
    }
    let mins = (sched.watch_timeout / 60).max(1);
    let _ = db::schedules::insert_run(
        &state.pool,
        &sched.id,
        Utc::now().timestamp(),
        "timeout",
        &format!("watch timed out after {}s without confirming completion", sched.watch_timeout),
    )
    .await;
    let st = state.clone();
    let title = sched.title.clone();
    tokio::spawn(async move {
        let _ = crate::push::send_push_for(
            &st,
            crate::db::push::NotifCategory::ScheduleFinished,
            &format!("schedule '{title}' still running"),
            &format!("'{title}' hasn't confirmed completion after ~{mins}m — it may still be working."),
            "/scheduler",
        )
        .await;
    });
}

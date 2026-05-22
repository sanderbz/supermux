//! Per-session background watchers (TECH_PLAN §3.6, §3.2.8; M5a).
//!
//! M5a ships the **status detector loop** — one `tokio` task per live session
//! that, every 2s, captures the pane, runs the [`StatusDetector`] fusion rule,
//! and writes the hero data flow:
//!
//! ```text
//! status detector tick (every 2s, per session)
//!   ├─ skip?  pty bytes <2s AND last_status == Active → reuse last_capture
//!   ├─ capture = tmux capture-pane -p -S -30   (ANSI-stripped, last 30 lines)
//!   ├─ status  = detector.detect(capture, last_pty, last_hook)
//!   ├─ UPDATE session_runtime SET last_capture = ?            (ALWAYS)
//!   └─ if status changed: UPDATE last_status / last_status_at  (+ M5b: watch+SSE)
//! ```
//!
//! `last_capture` is the single canonical source the `SessionView.preview_lines`
//! builder reads (CEO #1) — written every tick, classification or not.
//!
//! **M5b SEAMS** (clearly marked below): the `last_hook` signal, the
//! `status_watch` `send_replace`, the SSE `sessions` delta, and the 50ms flap
//! debounce all extend this loop without rewriting it. The detector core
//! ([`super::status`]) is complete; this file only adds plumbing.
//!
//! **Locking (§3.2.5).** The tick is read-only on the tmux server
//! (`capture-pane`) and MUST NOT take the per-session `SessionLock`, or a chatty
//! `send` burst would starve detection.

use std::time::Duration;

use tokio::time::{interval, MissedTickBehavior};

use crate::db;
use crate::state::AppState;

use super::status::{self, StatusDetector};
use super::tmux::Tmux;

/// Detector cadence (§3.6 — "runs every 2s").
const TICK: Duration = Duration::from_secs(2);

/// Spawn detector loops for every existing (non-archived) session. Called once
/// from `main.rs` on boot so a restarted server resumes detection — the
/// cold-start path (§3.2.8): each fresh [`StatusDetector`] reads the cold-start
/// PTY sentinel until a real byte (M4) or a confirming capture arrives.
pub async fn spawn_all(state: &AppState) {
    let names = match db::sessions::list(&state.pool).await {
        Ok(sessions) => sessions.into_iter().map(|s| s.name).collect::<Vec<_>>(),
        Err(e) => {
            tracing::warn!(error = %e, "status detector: failed to list sessions on boot");
            return;
        }
    };
    for name in names {
        spawn_status_loop(state.clone(), name);
    }
}

/// Spawn the 2s status detector loop for one session. Idempotent at the
/// system level: the loop self-terminates the moment the session row is gone
/// (delete/archive), so churn never leaks tasks. Safe to call once per session
/// (boot via [`spawn_all`], create via `sessions::create`).
pub fn spawn_status_loop(state: AppState, name: String) {
    tokio::spawn(async move {
        // Cold-start init (§3.2.8): detector begins Unknown; its first heartbeat
        // is the cold-start sentinel from `AppState::last_pty`.
        let mut detector = StatusDetector::new();
        let mut ticker = interval(TICK);
        // Skip (don't burst) ticks missed while a capture-pane ran long.
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;

            // Stop the loop when the session is deleted/archived (the row is the
            // lifetime anchor — §3.2.5 cleanup).
            match db::sessions::exists(&state.pool, &name).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(e) => {
                    tracing::debug!(name = %name, error = %e, "status detector: exists() failed");
                    continue;
                }
            }

            if let Err(e) = tick(&state, &name, &mut detector).await {
                tracing::debug!(name = %name, error = %e, "status detector tick");
            }
        }

        tracing::debug!(name = %name, "status detector loop ended (session gone)");
    });
}

/// One detector tick. Public so an integration test can drive a single tick
/// deterministically (rather than waiting on the 2s interval).
pub async fn tick(state: &AppState, name: &str, detector: &mut StatusDetector) -> anyhow::Result<()> {
    let last_pty = state.last_pty(name);

    // M5b SEAM — hook signal:
    //   let last_hook = state.last_hook_event(name);
    // M5a always passes None (no hook source yet); the detector branch is stubbed.
    let last_hook = None;

    // capture-pane skip optimization (§3.6 [P2] #7). Dormant in M5a until M4
    // feeds the heartbeat (the sentinel makes this always false), but wired so
    // the optimization activates the instant the reader lands.
    if status::should_skip_capture(last_pty, detector.last_status()) {
        return Ok(());
    }

    let tmux = Tmux::new(name);
    if !tmux.exists().await.unwrap_or(false) {
        // Not running: the detector cannot capture. Leave the status untouched —
        // a never-started session stays Unknown (API renders 'stopped'), and the
        // explicit 'Any → Stopped' transition + side-effects on tmux death are a
        // separate auto-actions concern deferred past the M5a core (§3.6).
        return Ok(());
    }

    let raw = tmux.capture_pane(status::CAPTURE_LINES).await?;
    let capture = status::prepare_capture(&raw);

    let prev = detector.last_status();
    let new_status = detector.detect(&capture, last_pty, last_hook);

    // last_capture writeback — ALWAYS (canonical preview source, CEO #1).
    db::sessions::set_last_capture(&state.pool, name, &capture).await?;

    // On status change: persist last_status / last_status_at.
    if new_status != prev {
        db::sessions::set_last_status(&state.pool, name, new_status.as_str()).await?;

        // M5b SEAM — broadcast the transition:
        //   let tx = state.status_watch_for(name);
        //   let (_, ver) = *tx.borrow();
        //   tx.send_replace((new_status.as_str().into(), ver + 1));   // wait primitive
        // ALSO emit the SSE `sessions` delta (status changed OR tail6 changed),
        // coalesced behind a 50ms flap debounce.
    }

    // M5b SEAM — preview delta: when status is unchanged but the last-6 lines
    // changed, M5b still emits an SSE `sessions` delta carrying preview_lines so
    // tiles re-render without a status flip.

    Ok(())
}

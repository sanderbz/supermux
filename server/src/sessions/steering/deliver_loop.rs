//! Single-flight, exactly-once steering delivery (TECH_PLAN §3.9; M9).
//!
//! One task per session subscribes to the session's status
//! [`watch`](tokio::sync::watch) channel (the same channel the detector drives
//! and `agents::wait` reads). On every transition INTO `waiting` or `idle` — the
//! agent's turn boundary — it dequeues ONE message via the transactional
//! [`db::steering::pop_oldest`] pop and sends it through `sessions::send_text`,
//! then drains the remaining backlog one-per-boundary on subsequent ticks.
//!
//! **Event-driven, not polling (§6 cross-cutting).** Delivery is woken by the
//! watch channel, not a busy poll. A low-frequency 60s safety tick (§3.9) covers
//! the case where a message is queued while the session is *already* idle (no
//! transition fires), so a steer is never stranded.
//!
//! **Exactly-once (Eng concurrency #3).** [`db::steering::pop_oldest`] runs the
//! `SELECT id … LIMIT 1 / DELETE WHERE id=?` pair inside one transaction, so a
//! message is removed before it is sent and can never be delivered twice. The
//! loop is single-flight: it awaits each `send_text` before the next iteration,
//! so two deliveries never overlap for one session.

use std::time::Duration;

use tokio::time::{interval, MissedTickBehavior};

use crate::db;
use crate::sessions::lifecycle;
use crate::state::AppState;

/// Safety re-check interval — catches messages queued while already at a turn
/// boundary (no watch transition fires in that case). §3.9 lists 60s.
const SAFETY_TICK: Duration = Duration::from_secs(60);

/// Status values that mark an agent turn boundary (deliverable window).
fn is_boundary(status: &str) -> bool {
    matches!(status, "waiting" | "idle")
}

/// Spawn the per-session delivery loop. Idempotent at the system level: the loop
/// self-terminates the moment the session row is gone (delete/archive), and when
/// the watch sender is dropped (`forget_session`), so churn never leaks tasks.
/// Safe to call once per session (boot via [`spawn_all`], create via
/// `sessions::create`).
pub fn spawn(state: AppState, name: String) {
    tokio::spawn(async move {
        let mut rx = state.status_watch_for(&name).subscribe();

        let mut ticker = interval(SAFETY_TICK);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        // Deliver any backlog that may already be eligible at startup.
        if is_boundary(&rx.borrow().0) {
            drain_one(&state, &name).await;
        }

        loop {
            // Stop when the session is gone (the row is the lifetime anchor).
            match db::sessions::exists(&state.pool, &name).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(e) => {
                    tracing::debug!(name = %name, error = %e, "steering: exists() failed");
                    continue;
                }
            }

            tokio::select! {
                changed = rx.changed() => {
                    if changed.is_err() {
                        // Watch sender dropped (session deleted): end the loop.
                        break;
                    }
                    let status = rx.borrow_and_update().0.clone();
                    if is_boundary(&status) {
                        // Single-flight: await delivery before looping again.
                        drain_one(&state, &name).await;
                    }
                }
                _ = ticker.tick() => {
                    // Safety re-check: deliver if a message was queued while the
                    // session was already idle/waiting (no transition fired).
                    if is_boundary(&rx.borrow().0) {
                        drain_one(&state, &name).await;
                    }
                }
            }
        }

        tracing::debug!(name = %name, "steering deliver loop ended (session gone)");
    });
}

/// Pop exactly one queued message (transactional) and deliver it. Logs and
/// re-queues are avoided: the message is removed inside the transaction, so a
/// `send_text` failure drops it (matching v2's at-most-once delivery semantics —
/// we never want a failed steer to wedge the queue or double-fire).
async fn drain_one(state: &AppState, name: &str) {
    match db::steering::pop_oldest(&state.pool, name).await {
        Ok(Some(text)) => {
            if let Err(e) = lifecycle::send_text(state, name, &text).await {
                tracing::warn!(name = %name, error = %e, "steering: delivery send_text failed");
            } else {
                tracing::debug!(name = %name, "steering: delivered one queued message");
            }
        }
        Ok(None) => {} // queue empty
        Err(e) => tracing::debug!(name = %name, error = %e, "steering: pop_oldest failed"),
    }
}

/// Spawn delivery loops for every existing (non-archived) session. Called once
/// from `main.rs` on boot so a restarted server resumes delivery.
pub async fn spawn_all(state: &AppState) {
    let names = match db::sessions::list(&state.pool).await {
        Ok(sessions) => sessions.into_iter().map(|s| s.name).collect::<Vec<_>>(),
        Err(e) => {
            tracing::warn!(error = %e, "steering: failed to list sessions on boot");
            return;
        }
    };
    for name in names {
        spawn(state.clone(), name);
    }
}

//! Per-session background watchers (TECH_PLAN §3.6, §3.2.8; M5a core + M5b fusion).
//!
//! One `tokio` task per live session that captures the pane, runs the
//! [`StatusDetector`] fusion rule, and writes the hero data flow:
//!
//! ```text
//! status detector tick (every 2s, or sooner on a hook wake)
//!   ├─ skip?  pty bytes <2s AND last_status == Active → reuse last_capture
//!   ├─ capture = tmux capture-pane -p -S -30   (ANSI-stripped, last 30 lines)
//!   ├─ status  = detector.detect(capture, last_pty, last_hook)   ← M5b: hook signal
//!   ├─ UPDATE session_runtime SET last_capture = ?               (ALWAYS)
//!   ├─ if status changed (confirmed stable for 50ms — flap debounce):
//!   │      UPDATE last_status / last_status_at
//!   │      status_watch[name].send_replace((status, ver+1))      ← wait primitive
//!   │      SSE  { type:'status',   payload:{name,status,version} }
//!   └─ if status changed OR tail6 changed:
//!          SSE  { type:'sessions', payload:{delta:[{name,status?,preview_lines?}]} }
//! ```
//!
//! `last_capture` is the single canonical source the `SessionView.preview_lines`
//! builder reads (CEO #1) — written every tick, classification or not.
//!
//! **M5b layer (this file).** The `last_hook` signal, the per-session
//! [`watch::Sender`](tokio::sync::watch) `send_replace`, the SSE `status` +
//! `sessions` deltas, the 50ms flap debounce, and the sub-second hook wake all
//! live here. The detector core ([`super::status`]) is the pure classifier; this
//! file is its plumbing.
//!
//! **Locking (§3.2.5).** The tick is read-only on the tmux server
//! (`capture-pane`) and MUST NOT take the per-session `SessionLock`, or a chatty
//! `send` burst would starve detection.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::time::{interval, MissedTickBehavior};

use crate::db;
use crate::state::{AppState, SseEvent};

use super::status::{self, Status, StatusDetector};
use super::tmux::Tmux;

/// Detector cadence (§3.6 — "runs every 2s"). A hook wake can re-tick sooner.
const TICK: Duration = Duration::from_secs(2);

/// Flap debounce (§3.7): on a detected transition, re-confirm against fresh
/// signals after this window and only commit a status that held stable, so a
/// burst of conflicting hooks/heartbeats can't broadcast a state it immediately
/// leaves. 50ms ≪ the 2s tick, so steady-state latency is unaffected.
const FLAP_DEBOUNCE: Duration = Duration::from_millis(50);

/// How many trailing lines the tile preview surfaces (§3.6 hero flow, §3.4).
/// Sized to feed BOTH preview modes from one capture: the static tile shows
/// the bottom 6 (CSS-clipped via container height + fade mask), and the
/// Settings → Expanded-text hover mode reveals the full ~20-line tail.
const PREVIEW_LINES: usize = 20;

/// Reconcile every persisted session's stored status against tmux reality on
/// boot. The `session_runtime.last_status` column keeps its last-known value
/// across a server restart (and a machine reboot), so a session that read
/// `active`/`idle`/`waiting` before the restart still reads that way afterwards
/// — even though a reboot wipes every tmux session, leaving the pty genuinely
/// dead. The overview would then show a dead session as healthy, and peeking it
/// opens a WebSocket that reconnects forever (the tmux pane is gone).
///
/// This runs once, before the server starts serving, so the overview is correct
/// from the first paint: for every session row whose `supermux-<name>` tmux
/// session does NOT exist, the status is forced to `stopped` (the existing
/// "not running" state the stopped-session UI already handles — the `Status`
/// enum's [`Status::Stopped`]). A session whose tmux pane genuinely exists is
/// left untouched: the 2s detector loop classifies it live.
///
/// Session rows are NEVER deleted here — a stopped session stays in the DB so
/// the user can resume it.
pub async fn reconcile_on_boot(state: &AppState) {
    let sessions = match db::sessions::list(&state.pool).await {
        Ok(sessions) => sessions,
        Err(e) => {
            tracing::warn!(error = %e, "status reconcile: failed to list sessions on boot");
            return;
        }
    };
    for s in sessions {
        let tmux = Tmux::new(&s.name);
        // A failed `has-session` probe is treated as "not running" — the pane
        // cannot be served either way, so `stopped` is the safe, correct status.
        let alive = tmux.exists().await.unwrap_or(false);
        if alive {
            continue;
        }
        if let Err(e) =
            db::sessions::set_last_status(&state.pool, &s.name, Status::Stopped.as_str()).await
        {
            tracing::warn!(name = %s.name, error = %e, "status reconcile: set_last_status failed");
            continue;
        }
        tracing::info!(name = %s.name, "status reconcile: tmux pane gone → stopped");
    }
}

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
/// OR archived (R1-1 — `exists_active` filters `archived = 0`), so churn never
/// leaks tasks. Safe to call once per session (boot via [`spawn_all`], create
/// via `sessions::create`).
pub fn spawn_status_loop(state: AppState, name: String) {
    tokio::spawn(async move {
        // R1-1/R1-2: register this loop as a live per-session task. The guard
        // decrements the count on drop (loop exit), so `archive`/`delete` can
        // wait for every loop to stop before running `forget_session`.
        let _task = state.session_task_guard(&name);
        // Cold-start init (§3.2.8): detector begins Unknown; its first heartbeat
        // is the cold-start sentinel from `AppState::last_pty`. The tick body
        // reconciles the detector's internal `last_status` against the DB on
        // every iteration while we are still `Unknown`, so the
        // "Unknown stays Unknown" cold-start guard in `classify` does NOT pin a
        // session whose persisted status the start-handler later set to
        // `active` (a one-shot seed-on-spawn would miss it — `spawn_status_loop`
        // is called from `sessions::create` BEFORE `start` sets `active`, so a
        // seed at spawn time would always see `unknown`).
        let mut detector = StatusDetector::new();
        // Per-session broadcast memo: the last preview tail we pushed over SSE, so
        // a tick re-emits a `sessions` delta only when the visible tail changed.
        let mut last_tail: Option<Vec<String>> = None;

        let mut ticker = interval(TICK);
        // Skip (don't burst) ticks missed while a capture-pane ran long.
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        // Sub-second wake: the hook endpoint pings this so a real Claude
        // notification surfaces well within the §3.6 "1s" bound, not at the next
        // 2s edge. `notify_one` parks a permit, so a wake between ticks is kept.
        let wake = state.detector_wake_for(&name);

        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = wake.notified() => {}
            }

            // Stop the loop when the session is deleted OR archived (R1-1: the
            // *live* row is the lifetime anchor — `exists_active` filters
            // `archived = 0`, so an archived session terminates this loop just
            // like a deleted one and the detector task is not leaked forever).
            match db::sessions::exists_active(&state.pool, &name).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(e) => {
                    tracing::debug!(name = %name, error = %e, "status detector: exists_active() failed");
                    continue;
                }
            }

            if let Err(e) = tick(&state, &name, &mut detector, &mut last_tail).await {
                tracing::debug!(name = %name, error = %e, "status detector tick");
            }
        }

        tracing::debug!(name = %name, "status detector loop ended (session gone)");
    });
}

/// One detector tick. Public so an integration test can drive a single tick
/// deterministically (rather than waiting on the 2s interval). `last_tail` carries
/// the previously-broadcast preview tail across ticks for the §3.6 "status OR
/// tail6 changed" SSE rule.
pub async fn tick(
    state: &AppState,
    name: &str,
    detector: &mut StatusDetector,
    last_tail: &mut Option<Vec<String>>,
) -> anyhow::Result<()> {
    // While the detector's internal status is still `Unknown` (cold-start), pull
    // the persisted `last_status` from the DB and force it in. This satisfies
    // the "Unknown stays Unknown" cold-start guard in `classify` so a session
    // that the start-handler set to `active` can legitimately downgrade to
    // `idle` on the first tick the heartbeat reports silence — without this
    // sync the DB would stay frozen at the boot-time `active` value forever
    // (the canonical "always grey / always wrong" overview bug).
    if detector.last_status() == Status::Unknown {
        if let Ok(Some(rt)) = db::sessions::runtime(&state.pool, name).await {
            if let Some(seed) = parse_status(&rt.last_status) {
                detector.force(seed);
            }
        }
    }

    let last_pty = state.last_pty(name);
    // M5b: the apex fusion signal — a fresh Claude hook event outranks the regex
    // bank + heartbeat inside `detect` (§3.6).
    let last_hook = state.last_hook_event(name);

    // capture-pane skip optimization (§3.6 [P2] #7): once M4's reader feeds the
    // heartbeat, a streaming-Active session keeps its status + recent preview
    // without a shell-out. Until then the sentinel keeps this false.
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

    // M5a heartbeat wire-up. The PTY reader is what stamps `pty_heartbeat` (so
    // the detector's heartbeat branch fires) and is normally spawned on the
    // first WS subscribe via `AppState::pty_for`. Kicking it from here means a
    // session that NOBODY has opened the focus tab for still has a live
    // byte-flow signal — without this, an unviewed running session reads dead
    // on the overview ("always grey") until somebody opens its focus terminal.
    // `ensure_started` is idempotent + race-safe (OnceCell), so re-calling it
    // every tick is free after the first success. Errors are best-effort: a
    // failure here is logged at debug, not fatal — the regex bank still classifies.
    if let Err(e) = state.pty_for(name).await {
        tracing::debug!(name = %name, error = %e, "status detector: pty_for failed (heartbeat may be stale)");
    }

    // ONE capture with `-e` (escapes preserved): the detector + plain preview
    // read the ANSI-stripped form, the colour-true tile preview reads the raw
    // form. A single shell-out feeds both — no extra `capture-pane` per tick.
    let raw_ansi = tmux.capture_pane_ansi(status::CAPTURE_LINES).await?;
    let capture = status::prepare_capture(&raw_ansi);
    let capture_ansi = status::prepare_capture_ansi(&raw_ansi);

    let prev = detector.last_status();
    let new_status = detector.detect(&capture, last_pty, last_hook);

    // last_capture writeback — ALWAYS (canonical preview source, CEO #1).
    db::sessions::set_last_capture(&state.pool, name, &capture, &capture_ansi).await?;

    let tail = tail_lines(&capture);
    let tail_ansi = tail_lines(&capture_ansi);
    let tail_changed = last_tail.as_ref() != Some(&tail);

    // ── status transition: flap-debounce, then commit + broadcast ─────────────
    let mut committed: Option<Status> = None;
    if new_status != prev {
        // Re-confirm the transition against fresh fast signals (hook + heartbeat)
        // after a short settle. A transient flap (e.g. a stale-by-now hook) that
        // reverts is suppressed; only a status that still holds is broadcast.
        tokio::time::sleep(FLAP_DEBOUNCE).await;
        let confirmed = detector.detect(&capture, state.last_pty(name), state.last_hook_event(name));
        if confirmed != prev {
            // DB first, THEN the watch send — a `wait` handler that subscribed
            // late reads the persisted status as its baseline, so no transition is
            // lost regardless of subscribe timing (Eng P0 #2; see agents::wait).
            db::sessions::set_last_status(&state.pool, name, confirmed.as_str()).await?;
            let version = {
                let tx = state.status_watch_for(name);
                let next = tx.borrow().1.wrapping_add(1);
                tx.send_replace((confirmed.as_str().to_string(), next));
                next
            };
            // SSE `status` event — every status change (M5b acceptance).
            broadcast(state, "status", json!({
                "name": name,
                "status": confirmed.as_str(),
                "version": version,
            }));
            committed = Some(confirmed);
        }
        // If `confirmed == prev` the flap is suppressed; `detector.last_status` is
        // already back to `prev`, so the next tick starts from a clean baseline.
    }

    // ── SSE `sessions` delta — when status committed OR the tail changed ───────
    if committed.is_some() || tail_changed {
        let mut item = serde_json::Map::new();
        item.insert("name".into(), Value::String(name.to_string()));
        if let Some(s) = committed {
            item.insert("status".into(), Value::String(s.as_str().to_string()));
        }
        if tail_changed {
            item.insert(
                "preview_lines".into(),
                Value::Array(tail.iter().cloned().map(Value::String).collect()),
            );
            // Colour-true tail — escapes intact — for the ANSI tile preview.
            item.insert(
                "preview_ansi".into(),
                Value::Array(tail_ansi.iter().cloned().map(Value::String).collect()),
            );
            *last_tail = Some(tail);
        }
        broadcast(state, "sessions", json!({ "delta": [Value::Object(item)] }));
    }

    Ok(())
}

/// Last [`PREVIEW_LINES`] lines of the (already ANSI-stripped) capture — the tile
/// preview tail surfaced over SSE, matching `SessionView::preview_lines` (§3.4).
fn tail_lines(capture: &str) -> Vec<String> {
    if capture.is_empty() {
        return Vec::new();
    }
    let lines: Vec<&str> = capture.lines().collect();
    let start = lines.len().saturating_sub(PREVIEW_LINES);
    lines[start..].iter().map(|s| s.to_string()).collect()
}

/// Inverse of [`Status::as_str`] — parse the persisted token back into a
/// [`Status`] so the detector loop can seed its internal `last_status` from the
/// DB on spawn. Unknown tokens (including the literal `"unknown"`) return
/// `None`, so the cold-start path keeps `Unknown` as its detector state.
fn parse_status(s: &str) -> Option<Status> {
    match s {
        "active" => Some(Status::Active),
        "waiting" => Some(Status::Waiting),
        "idle" => Some(Status::Idle),
        "stopped" => Some(Status::Stopped),
        // `starting` is a transient lifecycle marker (set by
        // `lifecycle::start` before the agent UI settles). Seeding the detector
        // with `Starting` would let the cold-start "hold current status"
        // fallback freeze the tile on `starting`; map it to `Unknown` instead so
        // the first decisive capture/heartbeat/hook signal flips the tile out
        // of booting promptly.
        "starting" => None,
        _ => None,
    }
}

/// Publish an SSE event (best-effort; dropped if there are no subscribers).
fn broadcast(state: &AppState, event: &str, payload: Value) {
    let _ = state.sse_tx.send(SseEvent {
        event: event.to_string(),
        payload,
    });
}

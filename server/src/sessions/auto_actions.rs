//! Per-session background watchers (TECH_PLAN §3.6, §3.2.8; M5a core + M5b fusion).
//!
//! One `tokio` task per live session that captures the pane, runs the
//! [`StatusDetector`] fusion rule, and writes the hero data flow:
//!
//! ```text
//! status detector tick (ADAPTIVE cadence, or sooner on a hook wake — M-CADENCE:
//!   1s hot-active / 2s active / 4s idle / 5s waiting)
//!   ├─ skip?  pty bytes <2s AND last_status == Active AND preview < tier
//!   │         → reuse last_capture
//!   ├─ capture = tmux capture-pane -p -S -30   (ANSI-stripped, last 30 lines)
//!   ├─ status  = detector.detect(capture, last_pty, turn_state) ← hook turn-state signal
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

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::db;
use crate::state::{AppState, SseEvent};

use super::status::{self, Status, StatusDetector};
use super::tmux::Tmux;

/// Detector cadence floor (§3.6 — "runs every 2s" baseline). The loop no longer
/// uses a single fixed interval: after each tick it computes an ADAPTIVE delay
/// via [`status::cadence_for`] (1s hot-active / 2s active / 4s idle / 5s waiting,
/// M-CADENCE). This constant is the safe fallback delay used only when a tick
/// errors out before it can report a status (so a persistent failure can't
/// hot-spin). A hook wake can still re-tick sooner than any computed delay.
const FALLBACK_DELAY: Duration = Duration::from_secs(2);

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

/// Spawn the adaptive-cadence status detector loop for one session (M-CADENCE:
/// 1s hot-active / 2s active / 4s idle / 5s waiting). Idempotent at the
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
        // When we last actually ran a capture. The capture-skip optimization is
        // bounded by this so a continuously streaming agent still re-captures +
        // re-broadcasts its live tail instead of freezing the overview preview for
        // the whole duration of its work. The bound is now the session's CURRENT
        // cadence tier (M-CADENCE) — not a fixed 4s — so a 1s-tier hot session
        // re-captures within ~1s. Seed it "stale" so the very first tick captures.
        let mut last_capture_at = Instant::now() - status::MAX_PREVIEW_STALENESS;

        // Sub-second wake: the hook endpoint pings this so a real Claude
        // notification surfaces well within the §3.6 "1s" bound, not at the next
        // tier edge. `notify_one` parks a permit, so a wake between ticks is kept.
        let wake = state.detector_wake_for(&name);

        // Adaptive delay until the NEXT tick (M-CADENCE). Starts at the floor so
        // the first sleep is short; after each tick it is recomputed from the
        // observed status + hot-set membership via `status::cadence_for`.
        let mut delay = FALLBACK_DELAY;

        loop {
            // ADAPTIVE pacing: sleep the computed tier delay, but a hook wake can
            // cut it short for the §3.6 sub-second path. `sleep` (vs a fixed
            // `interval`) is what lets the cadence change every iteration; a wake
            // simply re-ticks now and the next delay is recomputed as usual, so
            // missed-tick behaviour is inherently "skip, don't burst".
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
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
                    // R1-9 sibling-hardening: this loop's `tokio::select!` runs at
                    // the TOP of the body so a `continue` here is already throttled
                    // by the sleep / wake on the next iteration. Defence-in-depth:
                    // reset the delay to the floor and sleep it on Err so a future
                    // refactor that flips the check above the select cannot
                    // re-introduce a CPU hot-spin on a persistent DB error.
                    tracing::debug!(name = %name, error = %e, "status detector: exists_active() failed");
                    delay = FALLBACK_DELAY;
                    tokio::time::sleep(delay).await;
                    continue;
                }
            }

            match tick(
                &state,
                &name,
                &mut detector,
                &mut last_tail,
                &mut last_capture_at,
            )
            .await
            {
                // Recompute the next-tick cadence from the JUST-observed status +
                // live hot-set membership (M-CADENCE tiers): 1s hot-active /
                // 2s active / 4s idle / 5s waiting. A `tick` that skipped its
                // capture still reports the held status, so the cadence is correct.
                Ok(observed) => {
                    delay = status::cadence_for(observed, state.is_hot(&name));
                }
                Err(e) => {
                    tracing::debug!(name = %name, error = %e, "status detector tick");
                    // Unknown post-error status → use the safe floor, never a
                    // hot-spin.
                    delay = FALLBACK_DELAY;
                }
            }
        }

        tracing::debug!(name = %name, "status detector loop ended (session gone)");
    });
}

/// One detector tick. Public so an integration test can drive a single tick
/// deterministically (rather than waiting on the interval). `last_tail` carries
/// the previously-broadcast preview tail across ticks for the §3.6 "status OR
/// tail6 changed" SSE rule. `last_capture_at` is the time of the last actual
/// `capture-pane`, used to bound the capture-skip optimization so the live
/// preview never freezes while an agent streams (see [`status::should_skip_capture_within`]).
///
/// Returns the session's status AS OF THIS TICK (the detector's `last_status`
/// after the tick, whether it ran a capture or held on a skip). The loop feeds
/// it into [`status::cadence_for`] to pick the NEXT adaptive delay (M-CADENCE),
/// and the tick records it into the shared recency tracker for the hot-set rank.
pub async fn tick(
    state: &AppState,
    name: &str,
    detector: &mut StatusDetector,
    last_tail: &mut Option<Vec<String>>,
    last_capture_at: &mut Instant,
) -> anyhow::Result<Status> {
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

    // hooks-10x lifecycle: a `SessionEnd` hook may have forced this session
    // `Stopped` (a clean exit the capture classifier cannot infer). Apply +
    // consume the override so the detector holds `Stopped` this tick instead of
    // re-deriving `active`; `SessionStart` clears the override so a re-launched
    // session is re-evaluated freely. We force BEFORE the capture so the held
    // status flows through the normal change/broadcast path below.
    if let Some(forced) = state.take_forced_status(name) {
        detector.force(forced);
    }

    let last_pty = state.last_pty(name);
    // The apex fusion signal — the per-session TURN STATE (newest instant of each
    // turn-relevant hook). The turn state machine inside `detect` marks the
    // session Active for the whole turn (incl. a silent think), outranking the
    // regex bank + heartbeat (§3.6; the "busy while thinking" fix).
    let turn = state.turn_state(name);

    // Record this session's CURRENT (held) status into the shared recency tracker
    // BEFORE the skip check, so the hot-set ranking sees a streaming session as
    // recently-active even on the ticks it skips its capture. Cheap O(1) write.
    let held = detector.last_status();
    state.record_recency(name, held);

    // The capture-skip staleness is bound to this session's CURRENT cadence tier
    // (M-CADENCE) rather than a fixed 4s: a 1s-tier hot-active session must
    // re-capture within ~1s during streaming, otherwise the old fixed bound would
    // let it skip three 1s ticks in a row and defeat the hot tier. Idle/waiting
    // sessions are not `Active`, so they never reach the staleness check and stay
    // cheap regardless. A tiny margin avoids re-capturing one tick too early.
    let tier = status::cadence_for(held, state.is_hot(name));

    // capture-pane skip optimization (§3.6 [P2] #7): once M4's reader feeds the
    // heartbeat, a streaming-Active session keeps its status without a shell-out.
    // BOUNDED by the per-tier preview staleness so a session that streams every
    // tick still re-captures within its cadence and its live tail keeps refreshing
    // on the overview (otherwise the preview freezes for the whole duration of the
    // agent's work — the reported mobile/desktop bug).
    if status::should_skip_capture_within(last_pty, held, last_capture_at.elapsed(), tier) {
        return Ok(held);
    }

    let tmux = Tmux::new(name);
    if !tmux.exists().await.unwrap_or(false) {
        // Not running: the detector cannot capture. Leave the status untouched —
        // a never-started session stays Unknown (API renders 'stopped'), and the
        // explicit 'Any → Stopped' transition + side-effects on tmux death are a
        // separate auto-actions concern deferred past the M5a core (§3.6).
        return Ok(held);
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
    // Stamp the capture time the moment a shell-out succeeds so the per-tier skip
    // bound (status::cadence_for) measures from the last REAL capture.
    *last_capture_at = Instant::now();
    let capture = status::prepare_capture(&raw_ansi);
    let capture_ansi = status::prepare_capture_ansi(&raw_ansi);

    let prev = detector.last_status();
    let new_status = detector.detect(&capture, last_pty, turn);

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
        let confirmed = detector.detect(&capture, state.last_pty(name), state.turn_state(name));
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

    // ── R1: session→board reaction on a COMMITTED status transition ────────────
    // Fires only on the genuine, flap-confirmed transition edge (`committed`),
    // never every tick — that is the one-shot guard the plan asks for. When the
    // session OWNS a `doing` issue:
    //   * → idle (agent finished its turn): post ONE system comment + set the
    //     `needs_review` flag. FLAG ONLY — the card is NOT auto-moved out of
    //     `doing` and the next issue is NOT auto-picked (plan §C, safe default).
    //   * sustained → waiting (agent blocked on the user): set `awaiting_input`
    //     so the board can badge "needs you".
    // No-op when the session owns no `doing` issue. emit_board after a change so
    // open boards reflect the new flag without a manual refetch.
    if let Some(s) = committed {
        if let Err(e) = react_to_transition(state, name, s).await {
            tracing::debug!(name = %name, error = %e, "board reaction on status transition failed");
        }
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

    // Re-record recency with the status the detector settled on this tick (after
    // a flap-suppressed transition reverts, `last_status` is back to `prev`). This
    // is what the loop's `cadence_for` reads to pick the next adaptive delay, and
    // what the hot-set ranks — so a session that just went active climbs the
    // recency order immediately rather than on the following tick.
    let observed = detector.last_status();
    state.record_recency(name, observed);

    Ok(observed)
}

/// R1 session→board reaction (plan §C.3). Called on a COMMITTED status
/// transition for `session`, with `new` being the status it just transitioned
/// INTO. Resolves the issue the session OWNS in the `doing` column
/// (`db::board::doing_issue_for_session`) and applies the safe-default side-effect:
///
/// * `Idle` — the agent finished its turn. Post a single SYSTEM comment
///   (author `system`) AND set the issue's `needs_review` flag, so the board can
///   badge the card "needs review". We do NOT move the column and do NOT auto-pick
///   the next issue (plan open-question 5 default). Guarded by `needs_review == 0`
///   so a flicker idle→active→idle while the issue is still unreviewed cannot post
///   a second comment (one-shot per review cycle, mirroring the `notified` latch).
/// * `Waiting` — the agent is blocked on the user (the existing →Waiting alert
///   edge). Set `awaiting_input` so the board badges "needs you". Idempotent:
///   re-setting an already-set flag is a cheap no-op write, and we skip the
///   emit_board when nothing changed.
///
/// Any other transition (e.g. → active, → stopped) is a no-op here. A session
/// that owns no `doing` issue is a no-op (the common case).
async fn react_to_transition(state: &AppState, session: &str, new: Status) -> anyhow::Result<()> {
    // Only idle / waiting / active carry a board side-effect; bail before the DB
    // hit otherwise (e.g. → stopped would needlessly probe the board).
    if !matches!(new, Status::Idle | Status::Waiting | Status::Active) {
        return Ok(());
    }
    let Some(issue) = db::board::doing_issue_for_session(&state.pool, session).await? else {
        return Ok(()); // session owns no `doing` issue — nothing to react to.
    };

    match new {
        Status::Idle => {
            // One-shot per review cycle: skip if the card is already flagged for
            // review (we'd otherwise post a duplicate "went idle" comment if the
            // agent re-entered idle before a human cleared the flag).
            if issue.needs_review != 0 {
                return Ok(());
            }
            db::board::insert_comment(
                &state.pool,
                &issue.id,
                "system",
                "agent went idle — turn finished, needs review",
            )
            .await?;
            db::board::patch_issue(
                &state.pool,
                &issue.id,
                &[db::board::IssueField::NeedsReview(1)],
            )
            .await?;
            // Forensic trail, mirroring the board mutation handlers' audit rows.
            let _ = db::audit::log(
                &state.pool,
                &format!("agent:{session}"),
                "issue.needs_review",
                &issue.id,
                json!({ "session": session, "transition": "idle" }),
            )
            .await;
            crate::board::emit_board(state).await;
        }
        Status::Waiting => {
            // Idempotent: only write + re-publish when the flag actually flips on.
            if issue.awaiting_input == 0 {
                db::board::patch_issue(
                    &state.pool,
                    &issue.id,
                    &[db::board::IssueField::AwaitingInput(1)],
                )
                .await?;
                let _ = db::audit::log(
                    &state.pool,
                    &format!("agent:{session}"),
                    "issue.awaiting_input",
                    &issue.id,
                    json!({ "session": session, "transition": "waiting" }),
                )
                .await;
                crate::board::emit_board(state).await;
            }
        }
        Status::Active => {
            // The agent resumed working — clear a stale "needs you" badge so the
            // board doesn't keep showing `awaiting_input` after the user replied
            // (the same confidently-wrong-state problem R2 fights for liveness).
            // `needs_review` is intentionally left for a human to clear.
            if issue.awaiting_input != 0 {
                db::board::patch_issue(
                    &state.pool,
                    &issue.id,
                    &[db::board::IssueField::AwaitingInput(0)],
                )
                .await?;
                crate::board::emit_board(state).await;
            }
        }
        _ => {}
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

#[cfg(test)]
mod board_reaction_tests {
    //! R1 session→board reaction unit tests. Drive [`react_to_transition`]
    //! directly (the same one-shot side-effect the committed-transition edge in
    //! [`tick`] invokes) so the board reaction is exercised without a live tmux.

    use super::*;
    use crate::config::Config;
    use crate::db::board::NewIssue;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("supermux-react-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    /// Seed a session row + a `doing` agent issue owned by that session.
    async fn seed_session_with_doing_issue(state: &AppState, session: &str, issue_id: &str) {
        db::sessions::insert_minimal(&state.pool, session, "/tmp", "claude")
            .await
            .unwrap();
        db::board::insert_issue(
            &state.pool,
            &NewIssue {
                id: issue_id.to_string(),
                title: format!("issue {issue_id}"),
                desc: String::new(),
                status: "doing".into(),
                session: Some(session.to_string()),
                creator: String::new(),
                due: None,
                due_time: None,
                owner_type: "agent".into(),
                pos: 0.0,
                notified: 0,
            },
        )
        .await
        .unwrap();
    }

    /// True if at least one `board` SSE event is waiting on `rx`.
    fn saw_board_event(rx: &mut tokio::sync::broadcast::Receiver<SseEvent>) -> bool {
        let mut seen = false;
        while let Ok(ev) = rx.try_recv() {
            if ev.event == "board" {
                seen = true;
            }
        }
        seen
    }

    #[tokio::test]
    async fn idle_posts_one_system_comment_sets_needs_review_no_column_move() {
        let (state, dir) = test_state().await;
        seed_session_with_doing_issue(&state, "worker-2", "B-1").await;
        let mut rx = state.sse_tx.subscribe();

        react_to_transition(&state, "worker-2", Status::Idle).await.unwrap();

        // Exactly ONE system comment from author `system`.
        let comments = db::board::comments_for(&state.pool, "B-1").await.unwrap();
        assert_eq!(comments.len(), 1, "exactly one system comment posted");
        assert_eq!(comments[0].author, "system");

        // needs_review set; column NOT moved (still `doing`), no auto-pickup.
        let issue = db::board::get_issue(&state.pool, "B-1").await.unwrap().unwrap();
        assert_eq!(issue.needs_review, 1, "needs_review flag set");
        assert_eq!(issue.status, "doing", "column NOT auto-moved (safe default)");
        assert_eq!(issue.awaiting_input, 0, "idle does not touch awaiting_input");

        assert!(saw_board_event(&mut rx), "emit_board fired after the reaction");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn repeated_idle_does_not_post_a_second_comment() {
        let (state, dir) = test_state().await;
        seed_session_with_doing_issue(&state, "worker-2", "B-1").await;

        react_to_transition(&state, "worker-2", Status::Idle).await.unwrap();
        // A second idle while the card is still unreviewed must NOT re-comment
        // (one-shot per review cycle, guarded by needs_review == 0).
        react_to_transition(&state, "worker-2", Status::Idle).await.unwrap();

        let comments = db::board::comments_for(&state.pool, "B-1").await.unwrap();
        assert_eq!(comments.len(), 1, "still exactly one comment after a re-idle");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn waiting_sets_awaiting_input_no_comment() {
        let (state, dir) = test_state().await;
        seed_session_with_doing_issue(&state, "worker-2", "B-1").await;
        let mut rx = state.sse_tx.subscribe();

        react_to_transition(&state, "worker-2", Status::Waiting).await.unwrap();

        let issue = db::board::get_issue(&state.pool, "B-1").await.unwrap().unwrap();
        assert_eq!(issue.awaiting_input, 1, "awaiting_input flag set");
        assert_eq!(issue.needs_review, 0, "waiting does not flag needs_review");
        // Waiting is a flag-only signal — no system comment.
        assert!(db::board::comments_for(&state.pool, "B-1").await.unwrap().is_empty());
        assert!(saw_board_event(&mut rx), "emit_board fired");

        // Agent resuming (→active) clears the stale awaiting_input badge.
        react_to_transition(&state, "worker-2", Status::Active).await.unwrap();
        let issue = db::board::get_issue(&state.pool, "B-1").await.unwrap().unwrap();
        assert_eq!(issue.awaiting_input, 0, "→active clears awaiting_input");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn no_side_effect_when_session_owns_no_doing_issue() {
        let (state, dir) = test_state().await;
        // Session exists but owns NO doing issue (issue is in `todo`).
        db::sessions::insert_minimal(&state.pool, "worker-2", "/tmp", "claude")
            .await
            .unwrap();
        db::board::insert_issue(
            &state.pool,
            &NewIssue {
                id: "B-1".into(),
                title: "todo issue".into(),
                desc: String::new(),
                status: "todo".into(), // NOT doing
                session: Some("worker-2".into()),
                creator: String::new(),
                due: None,
                due_time: None,
                owner_type: "agent".into(),
                pos: 0.0,
                notified: 0,
            },
        )
        .await
        .unwrap();
        let mut rx = state.sse_tx.subscribe();

        react_to_transition(&state, "worker-2", Status::Idle).await.unwrap();
        react_to_transition(&state, "worker-2", Status::Waiting).await.unwrap();

        let issue = db::board::get_issue(&state.pool, "B-1").await.unwrap().unwrap();
        assert_eq!(issue.needs_review, 0, "no flag — issue is not doing");
        assert_eq!(issue.awaiting_input, 0);
        assert!(db::board::comments_for(&state.pool, "B-1").await.unwrap().is_empty());
        assert!(!saw_board_event(&mut rx), "no emit_board when nothing reacted");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

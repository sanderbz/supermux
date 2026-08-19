//! Per-session background watchers.
//!
//! One `tokio` task per live session that captures the pane, runs the
//! [`StatusDetector`] fusion rule, and writes the hero data flow:
//!
//! ```text
//! status detector tick (ADAPTIVE cadence, or sooner on a hook wake:
//!   1s hot-active / 2s active / 4s idle / 5s waiting)
//!   ├─ skip?  pty bytes <2s AND last_status == Active AND preview < tier
//!   │         → reuse last_capture
//!   ├─ capture = tmux capture-pane -p -S -30   (ANSI-stripped, last 30 lines)
//!   ├─ status  = detector.detect(capture, last_pty, turn_state, has_hooks) ← hook turn-state signal
//!   ├─ UPDATE session_runtime SET last_capture = ?               (ALWAYS)
//!   ├─ if status changed (confirmed stable for 50ms — flap debounce):
//!   │      UPDATE last_status / last_status_at
//!   │      status_watch[name].send_replace((status, ver+1))      ← wait primitive
//!   │      SSE  { type:'status',   payload:{name,status,version} }
//!   └─ if status changed OR tail6 changed OR the chat tail changed:
//!          SSE  { type:'sessions', payload:{delta:[{name,status?,preview_lines?,chat_tail?}]} }
//! ```
//!
//! `chat_tail` (fase A2) is the one-line-per-side summary of the session's chat
//! ring — last prompt + last assistant line. It rides THIS delta rather than any
//! new request, is read from memory only (never a transcript file read), and is
//! change-gated + debounced by [`ChatTailGate`].
//!
//! `last_capture` is the single canonical source the `SessionView.preview_lines`
//! builder reads — written every tick, classification or not.
//!
//! The `last_hook` signal, the per-session
//! [`watch::Sender`](tokio::sync::watch) `send_replace`, the SSE `status` +
//! `sessions` deltas, the 50ms flap debounce, and the sub-second hook wake all
//! live here. The detector core ([`super::status`]) is the pure classifier; this
//! file is its plumbing.
//!
//! **Locking.** The tick is read-only on the tmux server
//! (`capture-pane`) and MUST NOT take the per-session `SessionLock`, or a chatty
//! `send` burst would starve detection.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::db;
use crate::db::hosts::{Host, HostStatus};
use crate::state::{AppState, SseEvent};

use super::chat::store::{ChatStore, ChatTail};
use super::lifecycle::HealStart;
use super::runtime::RUNTIME_NATIVE;
use super::status::{self, Status, StatusDetector};
use super::tmux::Tmux;
use super::transport::{HostId, Transport};

/// Detector cadence floor ("runs every 2s" baseline). The loop no longer
/// uses a single fixed interval: after each tick it computes an ADAPTIVE delay
/// via [`status::cadence_for`] (1s hot-active / 2s active / 4s idle / 5s waiting).
/// This constant is the safe fallback delay used only when a tick
/// errors out before it can report a status (so a persistent failure can't
/// hot-spin). A hook wake can still re-tick sooner than any computed delay.
const FALLBACK_DELAY: Duration = Duration::from_secs(2);

/// Flap debounce: on a detected transition, re-confirm against fresh
/// signals after this window and only commit a status that held stable, so a
/// burst of conflicting hooks/heartbeats can't broadcast a state it immediately
/// leaves. 50ms ≪ the 2s tick, so steady-state latency is unaffected.
const FLAP_DEBOUNCE: Duration = Duration::from_millis(50);

/// How many trailing lines the tile preview surfaces.
/// Sized to feed BOTH preview modes from one capture: the static tile shows
/// the bottom 6 (CSS-clipped via container height + fade mask), and the
/// Settings → Expanded-text hover mode reveals the full ~20-line tail.
const PREVIEW_LINES: usize = 20;

/// Floor between two `chat_tail` publications for ONE session.
///
/// A landing transcript batch is 30-100 entries (a0-findings: tool-heavy turns
/// flush per completed message), and every one of them can move the tail. The
/// tile shows a single line, so publishing per entry would be a fan-out storm to
/// every connected SSE client for no visible difference. One per second is
/// already faster than the detector's own idle cadence.
const CHAT_TAIL_MIN_INTERVAL: Duration = Duration::from_secs(1);

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
/// Extended to reconcile REMOTE hosts too. Local sessions
/// (`host_id IS NULL`) keep the existing per-session `has-session` probe path
/// (byte-for-byte unchanged). Remote sessions are handled per-host: for every
/// row in `hosts` (non-soft-deleted), we run ONE `tmux ls` over the host's SSH
/// transport (5s per-host timeout) and reconcile every session with
/// `host_id = host.id` against that single listing. On per-host timeout or SSH
/// failure, the host is marked `Unreachable` and its sessions are marked
/// `unknown` (we can't claim they're stopped — the remote tmux server may still
/// be alive; we simply don't know). Best-effort per-host: an unreachable host
/// never blocks boot — at worst it costs ~5s wall-clock before its sessions are
/// flagged unknown.
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

    // ── LOCAL pass (host_id IS NULL) — existing behaviour, unchanged ──────────
    // The remote-aware iteration below explicitly skips local sessions, so the
    // local loop is the sole writer for the local fleet (no double-write).
    for s in sessions.iter().filter(|s| s.host_id.is_none()) {
        // NATIVE rows get the same treatment as tmux ones, via the holder probe.
        // The native pty holder is `setsid`-detached and survives a daemon
        // restart exactly as the tmux server does, so hardcoding `stopped` here
        // was a LIE with teeth: the overview showed a live agent as stopped, and
        // pressing Start on it skipped the spawn (the terminal really is alive)
        // but still typed the launch command — straight into the running agent's
        // composer. `start()` now refuses that too, but the honest status is the
        // real fix.
        //
        // The probe is deliberately non-destructive (`meta.json` pid + `kill 0`
        // + the `exit` marker): connecting to the holder's socket would evict
        // whatever daemon connection is being established alongside this pass.
        let alive = if s.runtime == RUNTIME_NATIVE {
            crate::sessions::native::holder_alive(&s.name, &state.config.data_dir)
        } else {
            let tmux = Tmux::new(&s.name);
            // A failed `has-session` probe is treated as "not running" — the pane
            // cannot be served either way, so `stopped` is the safe, correct status.
            tmux.exists().await.unwrap_or(false)
        };
        if alive {
            continue;
        }
        if let Err(e) =
            db::sessions::set_last_status(&state.pool, &s.name, Status::Stopped.as_str()).await
        {
            tracing::warn!(name = %s.name, error = %e, "status reconcile: set_last_status failed");
            continue;
        }
        tracing::info!(name = %s.name, runtime = %s.runtime, "status reconcile: terminal gone → stopped");
        // Consume the death-badge EDGE for native rows found dead at boot: the
        // detector's auto-heal fires on `set_error`'s first-set edge, and
        // without this a daemon restart would "discover" every long-dead
        // session anew and try to heal it. Pre-setting the badge here (with
        // the real reason when the exit marker has one) both explains the
        // stop in the UI and makes the detector's later set_error a no-op.
        // Sessions that were RUNNING at shutdown are healed deliberately by
        // the post-update audit, which snapshots before this pass.
        if s.runtime == RUNTIME_NATIVE {
            DEATH_SEEN.insert(s.name.clone(), ());
            if let Some(d) =
                crate::sessions::native::death_marker(&s.name, &state.config.data_dir)
            {
                if d.unexpected {
                    state.set_error(
                        &s.name,
                        HOLDER_DIED.to_string(),
                        format!("terminal died: {}", d.reason),
                    );
                }
            }
        }
    }

    // ── REMOTE pass — per-host `tmux ls` with a 5s timeout each ──────────────
    // List once outside the per-host loop so a hosts-table read failure short-
    // circuits with one warning instead of N. An empty hosts table is the
    // pre-remote fleet and skips this pass entirely — boot stays at the local-only
    // cost (asserted by the empty-hosts test in `reattach_multi_host`).
    let hosts = match db::hosts::list(&state.pool).await {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(error = %e, "status reconcile: failed to list hosts on boot");
            return;
        }
    };
    if hosts.is_empty() {
        return;
    }

    // Index sessions by host_id once so each per-host pass is O(sessions_on_host)
    // instead of O(all_sessions). A host with no sessions still gets a single
    // probe (lets us flip its reachability status on boot — cheap warm-up).
    let mut by_host: std::collections::HashMap<i64, Vec<&db::sessions::Session>> =
        std::collections::HashMap::new();
    for s in sessions.iter().filter(|s| s.host_id.is_some()) {
        if let Some(hid) = s.host_id {
            by_host.entry(hid).or_default().push(s);
        }
    }

    for host in &hosts {
        let host_sessions: Vec<&db::sessions::Session> =
            by_host.get(&host.id).cloned().unwrap_or_default();
        // Per-host 5s wall-clock cap. A hung SSH (broken master, network
        // partition) can't stall boot for more than this — total worst-case
        // boot time is `5s × N_hosts` (the acceptance bound).
        let outcome = tokio::time::timeout(
            HOST_REATTACH_TIMEOUT,
            reconcile_host(state, host, &host_sessions),
        )
        .await;
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::warn!(host = %host.name, error = %e, "status reconcile: host probe failed");
                mark_host_and_sessions_unknown(state, host, &host_sessions).await;
            }
            Err(_) => {
                tracing::warn!(
                    host = %host.name,
                    timeout_secs = HOST_REATTACH_TIMEOUT.as_secs(),
                    "status reconcile: host probe timed out",
                );
                mark_host_and_sessions_unknown(state, host, &host_sessions).await;
            }
        }
    }
}

/// Per-host reattach budget ("reattach completes within
/// 5s × N_hosts worst case"). One `tmux ls` over an SSH ControlMaster is sub-ms
/// once the master is warm; this generous cap exists only for the cold/broken
/// master and is small enough that an all-down fleet still boots in seconds.
const HOST_REATTACH_TIMEOUT: Duration = Duration::from_secs(5);

/// Reconcile every session row on one remote host against ONE `tmux ls` listing.
///
/// * Run `tmux ls -F #{session_name}` over an ad-hoc `Transport::Ssh` for this
///   host. TODO: replace the ad-hoc transport with `HostPool.transport_for`
///   so the ControlMaster lifecycle is centrally managed (warm/backoff/etc.).
///   Constructing the transport inline keeps the seam intact (the spawn_command
///   argv is identical) without leaking the not-yet-merged pool type into the
///   boot path.
/// * Parse the output for `supermux-<name>` session names.
/// * For every session row with `host_id = host.id`:
///     - DB row exists, tmux session in the listing → leave status as-is (the
///       detector loop will re-classify it within the first 2s tick).
///     - DB row exists, tmux session NOT in the listing → write `stopped` (the
///       same outcome as the local `has-session = false` branch above).
///     - tmux session in the listing but NO DB row → ignored (that is a future
///       "connect-orphan" UX, not a boot-time reattach concern).
/// * Bumps the host's `status` to `Reachable` on a clean run.
///
/// On error (SSH failure, parse error, DB write error) returns `Err` and the
/// caller (the outer reconcile loop) flips the host to `Unreachable` + flags
/// every session on it as `unknown`.
async fn reconcile_host(
    state: &AppState,
    host: &Host,
    host_sessions: &[&db::sessions::Session],
) -> anyhow::Result<()> {
    let transport = adhoc_ssh_transport(state, host);
    // `tmux ls` with a strict format so we don't have to parse the human-
    // readable columns (which include attach state, window count, etc.).
    // Match the local-pass safety net: a never-started remote tmux server
    // exits non-zero on `list-sessions` ("no server running"); treat that
    // as "no sessions" (Ok empty), not an error, so a host with zero live
    // tmux sessions still flips to `Reachable`.
    let alive_names = match list_remote_supermux_sessions(&transport).await {
        Ok(names) => names,
        Err(e) => {
            // Distinguish a TMUX_NO_SERVER from a real SSH failure: the
            // remote `tmux` exits with stderr containing "no server running"
            // / "error connecting" when the daemon is simply not up. That's
            // a healthy host with no sessions, not an unreachable host.
            let msg = format!("{e:#}");
            if is_tmux_no_server(&msg) {
                HashSet::new()
            } else {
                return Err(e);
            }
        }
    };

    // Reconcile DB rows for this host.
    for s in host_sessions {
        let bare = s.name.as_str();
        let tmux_name = format!("supermux-{bare}");
        if alive_names.contains(&tmux_name) {
            // Live on the remote — detector loop will refine the status on its
            // first tick. Leave the persisted row alone.
            continue;
        }
        if let Err(e) =
            db::sessions::set_last_status(&state.pool, bare, Status::Stopped.as_str()).await
        {
            tracing::warn!(name = %bare, host = %host.name, error = %e, "status reconcile: set_last_status failed");
            continue;
        }
        tracing::info!(name = %bare, host = %host.name, "status reconcile: remote tmux pane gone → stopped");
    }

    // Reachable: the probe came back cleanly. Stamping this here also bumps
    // `last_seen`, so the FE host list shows a fresh "last reachable" right
    // after a server restart even before the user clicks Check.
    if !matches!(HostStatus::from_str(&host.status), Some(HostStatus::Reachable)) {
        if let Err(e) =
            db::hosts::update_status(&state.pool, host.id, HostStatus::Reachable).await
        {
            tracing::debug!(host = %host.name, error = %e, "status reconcile: update_status(Reachable) failed");
        }
    } else {
        // Already reachable — still bump last_seen so the UI clock advances.
        let _ = db::hosts::update_status(&state.pool, host.id, HostStatus::Reachable).await;
    }
    Ok(())
}

/// Construct an ad-hoc `Transport::Ssh` for one host without HostPool (which
/// lands in a parallel branch that may not yet be merged).
///
/// TODO: replace with `state.host_pool.transport_for(host.id)` once
/// `HostPool` is in tree — this function should disappear. The control_path
/// convention here (`<data_dir>/ssh-control/cm-<host_id>`) matches the path
/// HostPool will own, so an existing master (if any) is re-used; if no master
/// is up yet, ssh opens one on first use under `ControlMaster=auto`.
fn adhoc_ssh_transport(state: &AppState, host: &Host) -> Transport {
    let control_path: PathBuf = state
        .config
        .data_dir
        .join("ssh-control")
        .join(format!("cm-{}", host.id));
    Transport::Ssh {
        host_id: HostId(host.id),
        ssh_target: host.ssh_target.clone(),
        control_path,
    }
}

/// Run `tmux list-sessions -F #{session_name}` over `transport` and return the
/// set of session names prefixed `supermux-` (every supermux tmux session uses
/// that prefix — see `tmux.rs` module docs). A non-supermux session on the
/// remote (e.g. an operator's manual `tmux new-session`) is filtered out so we
/// never claim it.
async fn list_remote_supermux_sessions(transport: &Transport) -> anyhow::Result<HashSet<String>> {
    // `tmux` binary lookup: LOCAL would normally use `which::which`, but the
    // reconcile path is only invoked here on REMOTE hosts (the local pass
    // above uses the existing `Tmux::exists` flow). The bare `"tmux"` lets the
    // remote shell resolve it via the remote PATH — same convention as
    // `Tmux::program_for_transport` for `Transport::Ssh`.
    let out = transport
        .spawn_command("tmux", &["list-sessions", "-F", "#{session_name}"])
        // The outer `tokio::time::timeout` cancels the future on a hung
        // ssh, but that alone doesn't reap the child. `kill_on_drop` ensures
        // a stalled ssh subprocess is killed when the future is dropped, so a
        // partition-induced hang doesn't leak ssh PIDs every boot.
        .kill_on_drop(true)
        .output()
        .await?;
    if !out.status.success() {
        return Err(anyhow::anyhow!(
            "tmux list-sessions failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let names = stdout
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.starts_with("supermux-"))
        .map(|l| l.to_string())
        .collect();
    Ok(names)
}

/// True when a tmux error means "the remote tmux daemon is not running" — the
/// healthy "no sessions" outcome, not a transport failure. Matches the literal
/// strings tmux emits on `list-sessions` against a cold server.
fn is_tmux_no_server(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("no server running")
        || e.contains("error connecting to") // tmux-3.x sock-not-found phrasing
        || e.contains("failed to connect to server")
}

/// On a host probe failure (timeout or SSH error): mark the host `Unreachable`
/// and every session on that host `unknown`. We DO NOT mark them `stopped` —
/// the remote tmux server may very well still be alive; we just can't tell from
/// here, so the safe, honest answer is `unknown` (the UI renders this neutrally
/// and the detector loop will re-classify once connectivity returns).
async fn mark_host_and_sessions_unknown(
    state: &AppState,
    host: &Host,
    host_sessions: &[&db::sessions::Session],
) {
    if let Err(e) =
        db::hosts::update_status(&state.pool, host.id, HostStatus::Unreachable).await
    {
        tracing::debug!(host = %host.name, error = %e, "status reconcile: update_status(Unreachable) failed");
    }
    for s in host_sessions {
        if let Err(e) =
            db::sessions::set_last_status(&state.pool, &s.name, Status::Unknown.as_str()).await
        {
            tracing::warn!(name = %s.name, host = %host.name, error = %e, "status reconcile: set_last_status(unknown) failed");
        }
    }
}

/// Spawn detector loops for every existing (non-archived) session. Called once
/// from `main.rs` on boot so a restarted server resumes detection — the
/// cold-start path: each fresh [`StatusDetector`] reads the cold-start
/// PTY sentinel until a real byte or a confirming capture arrives.
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

/// Spawn the adaptive-cadence status detector loop for one session
/// (1s hot-active / 2s active / 4s idle / 5s waiting). Idempotent at the
/// system level: the loop self-terminates the moment the session row is gone
/// OR archived (`exists_active` filters `archived = 0`), so churn never
/// leaks tasks. Safe to call once per session (boot via [`spawn_all`], create
/// via `sessions::create`).
pub fn spawn_status_loop(state: AppState, name: String) {
    tokio::spawn(async move {
        // Register this loop as a live per-session task. The guard
        // decrements the count on drop (loop exit), so `archive`/`delete` can
        // wait for every loop to stop before running `forget_session`.
        let _task = state.session_task_guard(&name);
        // Cold-start init: detector begins Unknown; its first heartbeat
        // is the cold-start sentinel from `AppState::last_pty`. The tick body
        // reconciles the detector's internal `last_status` against the DB on
        // every iteration while we are still `Unknown`, so the
        // "Unknown stays Unknown" cold-start guard in `classify` does NOT pin a
        // session whose persisted status the start-handler later set to
        // `active` (a one-shot seed-on-spawn would miss it — `spawn_status_loop`
        // is called from `sessions::create` BEFORE `start` sets `active`, so a
        // seed at spawn time would always see `unknown`).
        // Provider is fixed for a session's lifetime; read it ONCE so the
        // detector can use provider-specific capture heuristics (Codex's TUI
        // differs from Claude's). An empty read (row not yet visible) defaults to
        // the generic/Claude banks — harmless, and Codex rows exist by the time
        // `create`/`spawn_all` start this loop.
        let provider = db::sessions::get(&state.pool, &name)
            .await
            .ok()
            .flatten()
            .map(|s| s.provider)
            .unwrap_or_default();
        let mut detector = StatusDetector::for_provider(&provider);
        // Per-session broadcast memo: the last preview tail we pushed over SSE, so
        // a tick re-emits a `sessions` delta only when the visible tail changed.
        let mut last_tail: Option<Vec<String>> = None;
        // When we last actually ran a capture. The capture-skip optimization is
        // bounded by this so a continuously streaming agent still re-captures +
        // re-broadcasts its live tail instead of freezing the overview preview for
        // the whole duration of its work. The bound is now the session's CURRENT
        // cadence tier — not a fixed 4s — so a 1s-tier hot session
        // re-captures within ~1s. Seed it "stale" so the very first tick captures.
        let mut last_capture_at = Instant::now() - status::MAX_PREVIEW_STALENESS;
        // Per-session memo for the A2 chat tail: what we last put on the delta
        // and when. Lives here (not in `AppState`) because the detector loop is
        // already the one-per-session actor that owns delta publication.
        let mut chat_tail = ChatTailGate::new();

        // Sub-second wake: the hook endpoint pings this so a real Claude
        // notification surfaces well within the "1s" bound, not at the next
        // tier edge. `notify_one` parks a permit, so a wake between ticks is kept.
        let wake = state.detector_wake_for(&name);

        // Adaptive delay until the NEXT tick. Starts at the floor so
        // the first sleep is short; after each tick it is recomputed from the
        // observed status + hot-set membership via `status::cadence_for`.
        let mut delay = FALLBACK_DELAY;

        loop {
            // ADAPTIVE pacing: sleep the computed tier delay, but a hook wake can
            // cut it short for the sub-second path. `sleep` (vs a fixed
            // `interval`) is what lets the cadence change every iteration; a wake
            // simply re-ticks now and the next delay is recomputed as usual, so
            // missed-tick behaviour is inherently "skip, don't burst".
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = wake.notified() => {}
            }

            // Stop the loop when the session is deleted OR archived (the
            // *live* row is the lifetime anchor — `exists_active` filters
            // `archived = 0`, so an archived session terminates this loop just
            // like a deleted one and the detector task is not leaked forever).
            match db::sessions::exists_active(&state.pool, &name).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(e) => {
                    // Sibling-hardening: this loop's `tokio::select!` runs at
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
                &mut chat_tail,
            )
            .await
            {
                // Recompute the next-tick cadence from the JUST-observed status +
                // live hot-set membership: 1s hot-active /
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
/// the previously-broadcast preview tail across ticks for the "status OR
/// tail6 changed" SSE rule. `last_capture_at` is the time of the last actual
/// `capture-pane`, used to bound the capture-skip optimization so the live
/// preview never freezes while an agent streams (see [`status::should_skip_capture_within`]).
/// `chat_tail` is the per-session A2 chat-tail gate (change + 1s debounce), also
/// carried across ticks.
///
/// Returns the session's status AS OF THIS TICK (the detector's `last_status`
/// after the tick, whether it ran a capture or held on a skip). The loop feeds
/// it into [`status::cadence_for`] to pick the NEXT adaptive delay,
/// and the tick records it into the shared recency tracker for the hot-set rank.
pub async fn tick(
    state: &AppState,
    name: &str,
    detector: &mut StatusDetector,
    last_tail: &mut Option<Vec<String>>,
    last_capture_at: &mut Instant,
    chat_tail: &mut ChatTailGate,
) -> anyhow::Result<Status> {
    // While the detector's internal status is still `Unknown` (cold-start), pull
    // the persisted `last_status` from the DB and force it in. This satisfies
    // the "Unknown stays Unknown" cold-start guard in `classify` so a session
    // that the start-handler set to `active` can legitimately downgrade to
    // `idle` on the first tick the heartbeat reports silence — without this
    // sync the DB would stay frozen at the boot-time `active` value forever
    // (the canonical "always grey / always wrong" overview bug).
    // The status PERSISTED in the DB right now. Used both for the cold-start seed
    // below and — critically — as the reconciliation baseline at commit time: the
    // detector is the authoritative source of truth, so when its settled
    // classification disagrees with the persisted row we re-commit even if the
    // detector's own in-memory `prev == new` (no internal transition edge). That
    // self-heals an EXTERNAL write that clobbered the row out from under the
    // detector — e.g. `lifecycle::start` unconditionally writes `active` after the
    // agent UI is ready, but an agent that boots straight to an idle prompt is
    // `idle`; the detector classified `idle` on its first (pre-`active`) tick, so
    // its `prev` is already `idle` and a plain edge-only commit would never
    // correct the clobbered `active`, freezing the card on a false `active`.
    let persisted = db::sessions::runtime(&state.pool, name)
        .await
        .ok()
        .flatten()
        .and_then(|rt| parse_status(&rt.last_status));
    if detector.last_status() == Status::Unknown {
        if let Some(seed) = persisted {
            detector.force(seed);
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
    // regex bank + heartbeat (the "busy while thinking" fix).
    let turn = state.turn_state(name);

    // Record this session's CURRENT (held) status into the shared recency tracker
    // BEFORE the skip check, so the hot-set ranking sees a streaming session as
    // recently-active even on the ticks it skips its capture. Cheap O(1) write.
    let held = detector.last_status();
    state.record_recency(name, held);

    // The capture-skip staleness is bound to this session's CURRENT cadence tier
    // rather than a fixed 4s: a 1s-tier hot-active session must
    // re-capture within ~1s during streaming, otherwise the old fixed bound would
    // let it skip three 1s ticks in a row and defeat the hot tier. Idle/waiting
    // sessions are not `Active`, so they never reach the staleness check and stay
    // cheap regardless. A tiny margin avoids re-capturing one tick too early.
    let tier = status::cadence_for(held, state.is_hot(name));

    // capture-pane skip optimization: once the PTY reader feeds the
    // heartbeat, a streaming-Active session keeps its status without a shell-out.
    // BOUNDED by the per-tier preview staleness so a session that streams every
    // tick still re-captures within its cadence and its live tail keeps refreshing
    // on the overview (otherwise the preview freezes for the whole duration of the
    // agent's work — the reported mobile/desktop bug).
    // …but NEVER skip while the persisted row says `stopped` and this detector
    // still holds something else. That disagreement has exactly one cause: an
    // external writer flipped the row without a reason — the pty reader's
    // stream-dead path, which persists `stopped` ~100 ms after a holder dies and
    // then rings this loop. Skipping there is what stretched "status says
    // stopped, error says nothing" — a crash rendered as a deliberate Stop —
    // from a tick into seconds. The capture the skip saves is precisely the one
    // that would find `rt.alive() == false` and stamp the reason.
    let row_says_dead = persisted == Some(Status::Stopped) && held != Status::Stopped;
    if !row_says_dead
        && status::should_skip_capture_within(last_pty, held, last_capture_at.elapsed(), tier)
    {
        return Ok(held);
    }

    // Runtime seam — the detector only ever needs liveness + one capture, both
    // backend-agnostic. A runtime that can't be resolved reads as "not running",
    // exactly like a failed `has-session` probe.
    let rt = match state.runtime_for(name).await {
        Ok(rt) => rt,
        Err(_) => return Ok(held),
    };
    if !rt.alive().await {
        // The terminal is gone. When the backend can PROVE it (and say why), the
        // session must flip to `stopped` NOW — that is the only way a session
        // whose terminal died MID-RUN ever leaves its last status: the boot
        // reconcile probes liveness once at startup, and the classifier below
        // works off a capture, which can only ever yield active/waiting/idle. A
        // native session whose holder crashed used to sit on `active` with a
        // blank screen until somebody resumed it by hand.
        if let Some(death) = rt.death().await {
            return force_stopped_on_death(state, name, detector, persisted, death).await;
        }
        // No proof (tmux, or a native session that never had a holder): leave the
        // status untouched — a never-started session stays Unknown (API renders
        // 'stopped'), and the explicit 'Any → Stopped' transition + side-effects
        // on tmux death are a separate auto-actions concern deferred past the
        // current core.
        return Ok(held);
    }
    // Alive again (a Resume, or a holder that came back): drop the "holder died"
    // badge this loop raised, so the card is not stuck on a stale crash notice
    // for a session that has no Claude hooks to clear it.
    //
    // …UNLESS the last auto-heal came back WITHOUT its agent (`auto_heal`'s
    // `Ok(false)` arm). A failed `claude --resume` leaves a bash prompt on the
    // pty, so "the terminal is alive" is true and meaningless — clearing on it
    // is precisely what turned a ghost session green again one tick after the
    // heal admitted failure.
    //
    // THE RELEASE CONDITION IS AGENT EVIDENCE, NOT "A PROGRAM IS RUNNING". This
    // used to also clear on `shell_is_foreground() == Some(false)`, on the
    // assumption that a failed resume always drops to bash. It does not:
    // `claude --resume '<stale name>'` does not exit, it sits in claude's
    // interactive Resume picker — which IS a program, so the escape hatch fired
    // on the very next ~2s tick and the honest `resume failed: <link>` badge
    // never reached a single client. A CLAUDE latch now only opens on a capture
    // that shows the provider's own UI (`lifecycle::agent_at_the_wheel`, which
    // excludes the picker and the trust dialog), deferred to the capture this
    // tick is about to take (below).
    //
    // The strict rule is scoped to the provider that needs it
    // (`agent_evidence_required`): every other provider's failed restart really
    // does leave a shell, and their "agent UI" is a bash prompt nothing can
    // match — so applying it to them would latch a badge that could never
    // clear.
    let heal_latched = heal_failed_pending(name) && agent_evidence_required(name);
    if !heal_failed_pending(name)
        || (!heal_latched && rt.shell_is_foreground().await == Some(false))
    {
        clear_holder_death_badge(state, name);
    }

    // Heartbeat wire-up. The PTY reader is what stamps `pty_heartbeat` (so
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
    let raw_ansi = rt.capture_ansi(status::CAPTURE_LINES).await?;
    // A BLANK capture from a backend that admits it has no view of the terminal
    // is a placeholder, not a screen. Persisting it would overwrite the stored
    // preview with nothing — the blank overview cards a daemon restart produced
    // while a session's holder was dead (the native grid starts empty, and its
    // capture calls deliberately answer rather than hang when no holder is
    // there). Hold everything: no writeback, no classification, no broadcast.
    // The status stays whatever it was, and the tick that follows the first real
    // attach refreshes it.
    if raw_ansi.trim().is_empty() && !rt.capture_is_authoritative().await {
        // …but only for so long. The hold is there to survive the SECONDS a
        // fresh daemon needs to attach and replay; a session that is still
        // non-authoritative a minute later has a holder that answers the
        // liveness probe (we got past `rt.alive()` above) and yet has never once
        // served this daemon a grid. Holding forever is the silent freeze this
        // whole wave is about — a card that keeps its last preview and its last
        // status while nothing at all is behind it. So the hold is BOUNDED, and
        // past the bound the session is treated as a death: badge, `stopped`,
        // and the Resume affordance the user needs.
        let waited = {
            let mut slot = BLANK_HOLD
                .entry(name.to_string())
                .or_insert_with(|| BlankHold { since: Instant::now(), warned: false });
            let waited = slot.since.elapsed();
            if waited >= BLANK_HOLD_MAX && !slot.warned {
                slot.warned = true;
                tracing::warn!(
                    name = %name,
                    held_secs = waited.as_secs(),
                    "status detector: the grid has never become authoritative — giving up on \
                     the hold and reporting the terminal as gone",
                );
            }
            waited
        };
        if waited < BLANK_HOLD_MAX {
            tracing::debug!(
                name = %name,
                "status detector: blank capture from a runtime with no live terminal \
                 view — keeping the stored preview",
            );
            return Ok(held);
        }
        let death = crate::sessions::runtime::TerminalDeath {
            reason: "grid never became authoritative (holder unreachable)".to_string(),
            unexpected: true,
        };
        return force_stopped_on_death(state, name, detector, persisted, death).await;
    }
    // A real capture: this session's view is healthy again, so the next blank
    // one starts its own hold from scratch.
    BLANK_HOLD.remove(name);
    // Stamp the capture time the moment a shell-out succeeds so the per-tier skip
    // bound (status::cadence_for) measures from the last REAL capture.
    *last_capture_at = Instant::now();
    let capture = status::prepare_capture(&raw_ansi);
    let capture_ansi = status::prepare_capture_ansi(&raw_ansi);

    // The claude latch, released on AGENT evidence (see the alive branch above).
    // This is the first point in the tick where a capture exists, so it is the
    // first point where "the agent is back" can be answered honestly.
    if heal_latched && crate::sessions::lifecycle::agent_at_the_wheel(&capture) {
        tracing::info!(
            name = %name,
            "the agent is at the wheel again after a failed heal — clearing the terminal-died badge",
        );
        clear_holder_death_badge(state, name);
    }

    // Whether this session's Claude hooks are live (we have seen ≥1 hook POST).
    // A hooked session is authoritative off the turn state machine + content bank,
    // so the detector suppresses the raw heartbeat `Active` fallback for it —
    // typing at the prompt echoes bytes but must not flip the card to busy.
    let has_hooks = state.has_hooks(name);
    let prev = detector.last_status();
    let new_status = detector.detect(&capture, last_pty, turn, has_hooks);

    // THE FREEZE, reconciled with what is actually on the screen.
    //
    // The overwhelmingly common login is the one this app did not start: Claude
    // Code hit an expired credential and the user typed `/login` into the
    // terminal. A freeze that only existed for API-driven flows would leave
    // exactly those sessions exposed to the auto-heal that kills the PKCE
    // verifier they are holding. This tick already has the capture, so the
    // reconciliation is one pure classification and no extra I/O.
    super::login::observe(name, &capture);

    // last_capture writeback — ALWAYS (canonical preview source).
    db::sessions::set_last_capture(&state.pool, name, &capture, &capture_ansi).await?;

    let tail = tail_lines(&capture);
    let tail_ansi = tail_lines(&capture_ansi);
    let tail_changed = last_tail.as_ref() != Some(&tail);

    // ── status transition: flap-debounce, then commit + broadcast ─────────────
    // Commit when EITHER the detector's own classification changed this tick
    // (`new_status != prev`, the normal edge) OR the detector's settled status
    // disagrees with what is PERSISTED (`new_status != persisted`, the drift case
    // — an external writer such as `lifecycle::start` clobbered the row). The
    // detector is authoritative, so a drift must be healed even without an
    // internal edge, otherwise a clobbered row freezes the card on a wrong status.
    // `Unknown` is the cold-start non-decision — never a status to persist or
    // broadcast — so it never counts as a drift (a never-classified session must
    // not clobber a persisted row with `unknown`).
    let drifted = new_status != Status::Unknown && Some(new_status) != persisted;
    let mut committed: Option<Status> = None;
    if new_status != prev || drifted {
        // Re-confirm against fresh fast signals (hook + heartbeat) after a short
        // settle. A transient flap (e.g. a stale-by-now hook) that reverts is
        // suppressed; only a status that still holds is broadcast.
        tokio::time::sleep(FLAP_DEBOUNCE).await;
        let confirmed = detector.detect(
            &capture,
            state.last_pty(name),
            state.turn_state(name),
            state.has_hooks(name),
        );
        // Commit when the confirmed status is a real change from the prior
        // broadcast baseline — either the in-memory `prev` (edge) or the persisted
        // row (drift heal) — and is a decisive status (never broadcast `Unknown`).
        let confirmed_drift = confirmed != Status::Unknown && Some(confirmed) != persisted;
        if confirmed != prev || confirmed_drift {
            // DB first, THEN the watch send — a `wait` handler that subscribed
            // late reads the persisted status as its baseline, so no transition is
            // lost regardless of subscribe timing (see agents::wait).
            db::sessions::set_last_status(&state.pool, name, confirmed.as_str()).await?;
            let version = {
                let tx = state.status_watch_for(name);
                let next = tx.borrow().1.wrapping_add(1);
                tx.send_replace((confirmed.as_str().to_string(), next));
                next
            };
            // SSE `status` event — every status change.
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

    // ── session→board reaction on a COMMITTED status transition ──────────────
    // Fires only on the genuine, flap-confirmed transition edge (`committed`),
    // never every tick — that is the required one-shot guard. When the
    // session OWNS a `doing` issue:
    //   * → idle (agent finished its turn): post ONE system comment + set the
    //     `needs_review` flag. FLAG ONLY — the card is NOT auto-moved out of
    //     `doing` and the next issue is NOT auto-picked (safe default).
    //   * sustained → waiting (agent blocked on the user): set `awaiting_input`
    //     so the board can badge "needs you".
    // No-op when the session owns no `doing` issue. emit_board after a change so
    // open boards reflect the new flag without a manual refetch.
    // A committed turn-end (idle/stopped) means the turn is over and no Task
    // subagents can be in flight — reset the best-effort outstanding-subagent
    // count so any drift self-corrects EVERY turn instead of accumulating. The
    // count is fed by best-effort `--max-time 1` hook curls: an occasional lost
    // SubagentStop, or a turn whose UserPromptSubmit/Stop reset hook never fired,
    // would otherwise leave the count stuck high (the "I spawned 3 but it shows 6"
    // drift). The detector's turn-end is the reliable server-side correction
    // signal. Not Waiting — a subagent may still run while the main agent is
    // blocked on the user. Computed BEFORE the push gate (which re-reads the count
    // after its debounce) and surfaced on the `sessions` delta below so the
    // `· N subagents` clause clears promptly even on a pure-drift idle (one with
    // no `Stop` hook to broadcast the zero).
    let subagents_reset =
        matches!(committed, Some(s) if turn_ends_subagents(s)) && state.reset_subagents(name);

    if let Some(s) = committed {
        if let Err(e) = react_to_transition(state, name, s).await {
            tracing::debug!(name = %name, error = %e, "board reaction on status transition failed");
        }
        // ── PUSH: phone notification on a blocked/error transition ─────────────
        // Fires ONLY on the genuine, flap-confirmed transition edge (`committed`),
        // so it is inherently debounced to one push per transition INTO the state
        // — never every tick. The send is spawned so the detector tick is not
        // blocked on network I/O to the push service.
        maybe_push_on_transition(state, name, s);
    }

    // ── A2 chat tail for the tile (zero new requests: it rides this delta) ────
    // Sampled from the in-memory ring only — see `ChatTailGate::poll`. Sampled
    // HERE, after the capture-skip early return, so it shares the delta the tick
    // was already going to send; a tick that skipped its capture emits no delta
    // at all, and the next real tick carries the newest tail anyway.
    let chat_tail = chat_tail.poll(state.chat_store(name).as_deref());

    // ── SSE `sessions` delta — when status committed OR a tail changed ─────────
    // `chat_tail` joins the trigger for the same reason `preview_lines` is one:
    // the transcript lands in batches up to ~30s after the pane went quiet
    // (a0-findings: text-only first-visible p50 31.4s), so gating it behind a
    // pane-tail change would strand the last turn's summary until the NEXT
    // keystroke. The gate above already guarantees this fires at most once per
    // second per session and only on a real change.
    if committed.is_some() || tail_changed || chat_tail.is_some() {
        let mut item = serde_json::Map::new();
        item.insert("name".into(), Value::String(name.to_string()));
        if let Some(s) = committed {
            item.insert("status".into(), Value::String(s.as_str().to_string()));
        }
        // Surface the drift-reset so connected clients clear the `· N subagents`
        // clause on a pure-drift turn-end (the tick delta otherwise omits the
        // count, which the change-only `broadcast_activity_delta` carries).
        if subagents_reset {
            item.insert("subagents".into(), json!(0));
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
            // mode-shift: the permission mode is parsed from the SAME capture, so
            // carry it on the delta whenever the tail changes — the ⋯ menu's
            // live-checked radio then tracks the TRUE mode (e.g. when the user
            // cycles via Shift+Tab in the terminal directly) with no extra capture.
            item.insert(
                "mode".into(),
                Value::String(status::parse_mode(&capture).as_str().to_string()),
            );
            *last_tail = Some(tail);
        }
        // The chat one-liner pair for the tile. Absent key = "unchanged" (never
        // "empty"), exactly like `preview_lines`.
        if let Some(t) = chat_tail {
            match serde_json::to_value(&t) {
                Ok(v) => {
                    item.insert("chat_tail".into(), v);
                }
                // Unreachable for three owned strings + an i64; a serialisation
                // failure must cost the chat tail, never the whole delta.
                Err(e) => tracing::debug!(name = %name, error = %e, "chat_tail serialize failed"),
            }
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

/// How long the detector will keep a session's stored preview (and its status)
/// while the runtime says its grid has NEVER become authoritative. Generous
/// against the honest cause — a daemon that has just restarted has to connect,
/// replay up to 8 MiB and only then counts as attached, and the pump's reconnect
/// backoff is jittered up to 5 s — and short enough that a session nothing can
/// serve does not sit there looking alive for the rest of the day.
pub const BLANK_HOLD_MAX: Duration = Duration::from_secs(60);

/// Since when each session has been serving blank, non-authoritative captures.
#[derive(Debug, Clone, Copy)]
struct BlankHold {
    since: Instant,
    /// The WARN is emitted once per hold, not once per 2 s tick.
    warned: bool,
}

/// In-memory on purpose: the hold is about THIS daemon's view of the session,
/// and a daemon restart legitimately starts the clock again.
static BLANK_HOLD: once_cell::sync::Lazy<dashmap::DashMap<String, BlankHold>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Test-only: pretend `name`'s blank hold started [`BLANK_HOLD_MAX`] ago.
#[cfg(test)]
pub(crate) fn expire_blank_hold(name: &str) {
    let since = Instant::now()
        .checked_sub(BLANK_HOLD_MAX + Duration::from_secs(1))
        .unwrap_or_else(Instant::now);
    BLANK_HOLD.insert(name.to_string(), BlankHold { since, warned: false });
}

/// The error type for the "your session's terminal died under it" badge. Rides
/// the same in-memory `{type, message}` channel the hook-fed agent errors use
/// (`rate_limit`, `billing_error`), so it appears on the overview card AND in
/// the focus header with no new wire field; the frontend labels it
/// "Terminal died" and puts the full reason in the tooltip.
pub const HOLDER_DIED: &str = "holder_died";

/// Force `session` to `Stopped` because its terminal is PROVABLY gone, pushing
/// the flip through the same triplet every other lifecycle writer uses — DB,
/// the status watch (the `wait` primitive's baseline), and the SSE `status` +
/// `sessions` events — so overview tiles and the focus screen flip to the
/// stopped UI (with its Resume/Start affordance) within one tick instead of
/// showing a live-looking blank terminal forever.
///
/// IDEMPOTENT: the detector keeps ticking on a stopped session, so everything is
/// gated on the PERSISTED status. Only the transition writes and broadcasts;
/// subsequent ticks are a pair of in-memory reads.
///
/// An `unexpected` death (a holder that crashed or was killed, as opposed to a
/// child that exited) also raises the in-memory error badge carrying the
/// reason — the difference between the user seeing "holder died: panic: …" and
/// seeing nothing at all.
async fn force_stopped_on_death(
    state: &AppState,
    name: &str,
    detector: &mut StatusDetector,
    persisted: Option<Status>,
    death: crate::sessions::runtime::TerminalDeath,
) -> anyhow::Result<Status> {
    // Keep the detector's own baseline in step, so the tick after a resume sees
    // `stopped → active` as a real edge.
    detector.force(Status::Stopped);
    state.record_recency(name, Status::Stopped);

    if death.unexpected {
        let message = format!("terminal died: {}", death.reason);
        if state.set_error(name, HOLDER_DIED.to_string(), message.clone()) {
            broadcast(state, "sessions", json!({ "delta": [{
                "name": name,
                "error": { "type": HOLDER_DIED, "message": message },
            }] }));
        }
        // AUTO-HEAL triggers on the DEATH_SEEN edge, not the persisted-status
        // edge: the native reader's stream-death path (pty.rs) persists
        // `stopped` within ~100ms of a holder dying — long before this tick —
        // so `persisted == Stopped` below is the NORMAL case for a fresh death
        // and a bottom-of-function spawn never ran (caught live in E2E: badge
        // appeared, heal never fired). Nor is the badge-change edge safe: a
        // boot-time badge with a slightly different message would re-trigger
        // `set_error`. DEATH_SEEN is explicit: first observer of this death
        // (detector here, or `reconcile_on_boot` pre-inserting at boot) claims
        // the edge; the entry clears on the next alive tick.
        if DEATH_SEEN.insert(name.to_string(), ()).is_none() {
            spawn_auto_heal(state, name, &death.reason);
        }
    }

    if persisted == Some(Status::Stopped) {
        return Ok(Status::Stopped);
    }
    tracing::warn!(
        name = %name,
        reason = %death.reason,
        unexpected = death.unexpected,
        "status detector: terminal is gone → stopped",
    );
    db::sessions::set_last_status(&state.pool, name, Status::Stopped.as_str()).await?;
    let version = {
        let tx = state.status_watch_for(name);
        let next = tx.borrow().1.wrapping_add(1);
        tx.send_replace((Status::Stopped.as_str().to_string(), next));
        next
    };
    broadcast(state, "status", json!({
        "name": name,
        "status": Status::Stopped.as_str(),
        "version": version,
    }));
    broadcast(state, "sessions", json!({
        "delta": [{ "name": name, "status": Status::Stopped.as_str() }],
    }));
    // A dead terminal ends the turn: no Task subagent can still be running.
    if state.reset_subagents(name) {
        broadcast(state, "sessions", json!({ "delta": [{ "name": name, "subagents": 0 }] }));
    }
    maybe_push_on_transition(state, name, Status::Stopped);

    // (The auto-heal spawn lives on the badge edge near the top of this
    // function — see the comment there for why the persisted-status edge is
    // the wrong trigger.)
    Ok(Status::Stopped)
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-HEAL — one automatic restart after a terminal dies under a running agent
// ─────────────────────────────────────────────────────────────────────────────

/// No second automatic restart for the same session inside this window. The
/// point is a SINGLE recovery from a one-off fault, never a flapping loop: a
/// session whose terminal dies again right after a heal has something
/// systematically wrong with it (a crashing agent, a full disk, an OOM-happy
/// host), and hammering it makes that worse while hiding it from the user
/// behind a card that keeps looking healthy.
pub const AUTO_HEAL_COOLDOWN: Duration = Duration::from_secs(10 * 60);

/// When each session was last auto-healed. In-memory on purpose: the cooldown
/// exists to stop a flap within one daemon's lifetime, and a daemon restart is
/// itself a legitimate reason to try again (that is what the post-update audit
/// does).
/// Death events the daemon has already SEEN (and, if eligible, healed) — the
/// auto-heal edge. Inserted by the detector on a fresh death and PRE-inserted
/// by `reconcile_on_boot` for sessions found dead at boot, so a daemon restart
/// can never re-discover a long-dead session and heal it. Cleared on the next
/// alive tick (same place the death badge clears), so a future death of the
/// same session is a new edge.
static DEATH_SEEN: once_cell::sync::Lazy<dashmap::DashMap<String, ()>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

static LAST_HEAL: once_cell::sync::Lazy<dashmap::DashMap<String, Instant>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Why a heal did or did not happen. Returned rather than logged-and-forgotten
/// so the post-update audit can COUNT outcomes and the tests can assert them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Heal {
    /// A restart ran and the session is live again.
    Healed,
    /// A restart ran and failed — the session stays stopped, badge and all.
    Failed,
    /// `recovery.auto_heal` is off.
    Disabled,
    /// Another heal for this session landed less than [`AUTO_HEAL_COOLDOWN`]
    /// ago.
    Cooldown,
    /// This session is not one we will restart unattended (see
    /// [`heal_is_supported`]).
    Unsupported,
    /// The row is gone or archived — nothing to heal.
    Gone,
    /// A `/login` is in flight. Restarting now would kill the PKCE verifier that
    /// only exists inside the running process, so the code the user is copying
    /// out of their browser right this second would fail — and the failure would
    /// read as "Authentication failed: Invalid authorization code", with nothing
    /// in the UI able to connect it to a helpful restart.
    Frozen,
    /// The session stopped being the thing this heal was for while the heal was
    /// deciding: the user pressed Stop or Resume, or another lifecycle op holds
    /// the session lock. Their action wins.
    Superseded,
}

impl Heal {
    /// The wire/UI identifier. Stable strings: they reach the sessions delta and
    /// the recovery UI, and `BRAND.md` §6h pairs each with the sentence the user
    /// reads (B5/T8.2).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Healed => "healed",
            Self::Failed => "failed",
            Self::Disabled => "disabled",
            Self::Cooldown => "cooldown",
            Self::Unsupported => "unsupported",
            Self::Gone => "gone",
            Self::Frozen => "frozen",
            Self::Superseded => "superseded",
        }
    }

    /// Did the session actually come back?
    pub const fn healed(self) -> bool {
        matches!(self, Self::Healed)
    }

    /// The one sentence the user reads for this outcome.
    ///
    /// Before B5 every one of these was a `tracing` line, so a user looking at
    /// "Terminal died" could not tell "we tried and it is on cooldown" from
    /// "auto-heal is off" from "this session type cannot be healed" — three
    /// different situations with three different next actions, all rendered as
    /// the same silence. Each sentence names what happened AND what to do.
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Healed => "The terminal came back.",
            Self::Failed => "The restart ran but the terminal did not come back. Try Restart.",
            Self::Disabled => "Auto-recovery is off. Turn it on in Settings, or press Restart.",
            Self::Cooldown => "This session was recovered a moment ago. Try Restart instead.",
            Self::Unsupported => "This session type cannot be recovered in place. Try Restart.",
            Self::Gone => "This session is archived or no longer exists.",
            Self::Frozen => "This session is signing in. Finish the login first — restarting now would invalidate the login code.",
            Self::Superseded => "Something else changed this session first — nothing was done.",
        }
    }
}

/// Fire-and-forget [`auto_heal`]. The detector tick must not block on a `start`
/// (which spawns a holder, waits for the agent's boot gate and can take
/// seconds); every other session's classification would stall behind it.
fn spawn_auto_heal(state: &AppState, name: &str, reason: &str) {
    let state = state.clone();
    let name = name.to_string();
    let reason = reason.to_string();
    tokio::spawn(async move {
        auto_heal(&state, &name, &reason).await;
    });
}

/// Can this session be restarted unattended WITHOUT losing the user's place?
///
/// * `claude` — only with a resume link (`cc_session_name` or
///   `cc_conversation_id`). `start` turns that into `claude --resume …`, so the
///   heal lands the user back in the same conversation. Without one, a heal
///   would silently open a BLANK Claude wearing the dead session's name, which
///   is worse than an honest "Terminal died" badge with a Resume button.
/// * `shell` — a shell has no conversation to lose; a restart is just a fresh
///   prompt, which is exactly what the user would do by hand.
/// * everything else (`codex`, …) — restarted fresh. Their launchers
///   own their own session continuity; supermux's job is to get the terminal
///   back.
///
/// A resume LINK is not the same thing as a resumable CONVERSATION. When the
/// link is a bare conversation id, `claude --resume <id>` reads
/// `<project>/<id>.jsonl`; if that file is not there — a stale id, a `/clear`, a
/// session whose transcript persistence was off — claude prints "No conversation
/// found with session ID: …" and EXITS, leaving a bash prompt wearing the dead
/// session's name. So the file's existence is the cheapest available proof that
/// the link still means something, checked here rather than discovered after we
/// have already reported success. (A `cc_session_name` link resolves through
/// claude's own name index, which we do not own, so it is left to the
/// post-restart readiness proof in [`auto_heal`].)
fn heal_is_supported(s: &db::sessions::Session) -> bool {
    if s.provider != "claude" {
        return true;
    }
    if !s.cc_session_name.trim().is_empty() {
        return true;
    }
    if s.cc_conversation_id.trim().is_empty() {
        // No link at all: a restart cannot LOSE a place it never had, but it
        // also cannot RESTORE one, so the automatic layer declines. The
        // auto-wake seam reads this case differently (see [`dead_resume_link`]).
        return false;
    }
    dead_resume_link(s).is_none()
}

/// The conversation id this row still points at whose transcript is no longer on
/// disk — i.e. a link that `claude --resume` will answer with "No conversation
/// found with session ID: …" before EXITING, leaving a bash prompt wearing the
/// session's name.
///
/// Split out of [`heal_is_supported`] because the two callers need different
/// answers for one of its cases. Both refuse a PROVABLY dead link. But
/// `heal_is_supported` also refuses a claude row with NO link at all (an
/// automatic restart there is a fresh session, which is not a heal), while
/// [`crate::sessions::lifecycle::send_harness_text`]'s auto-wake must allow it:
/// starting a claude session that has never had a conversation is the ordinary
/// first send, and it loses nothing. So the seam asks this narrower question —
/// "is the row pointing at something that is gone?" — and `None` means "waking
/// it is honest".
pub(crate) fn dead_resume_link(s: &db::sessions::Session) -> Option<&str> {
    if s.provider != "claude" {
        return None;
    }
    // A `cc_session_name` link resolves through claude's own name index, which
    // we do not own — it is left to the post-restart readiness proof.
    if !s.cc_session_name.trim().is_empty() {
        return None;
    }
    let conv = s.cc_conversation_id.trim();
    if conv.is_empty() {
        return None;
    }
    if crate::sessions::resumable::project_dir_for(&s.dir)
        .join(format!("{conv}.jsonl"))
        .exists()
    {
        return None;
    }
    Some(conv)
}

/// Attempt ONE automatic recovery of `name` after its terminal died.
///
/// Guards, in order — each one is a reason to stay stopped rather than restart:
///
/// 1. the row still exists, is not archived, is NATIVE and is LOCAL (tmux is out
///    of scope for this wave: its `death()` is `None`, so it never gets here,
///    and a remote row has no local holder to heal);
/// 2. [`heal_is_supported`] — a restart must not lose the user's place;
/// 3. `recovery.auto_heal` is on (default ON, operator can disable);
/// 4. no other heal for this session within [`AUTO_HEAL_COOLDOWN`]. The stamp is
///    taken BEFORE the restart, so a heal that itself dies (or two callers
///    racing — a detector tick and the boot audit) can never produce a second
///    attempt inside the window.
///
/// On success the [`HOLDER_DIED`] badge is cleared and the session flows through
/// `start`'s ordinary `starting → active` broadcasts, so the user sees a session
/// that simply came back. The death is NOT hidden: it stays in `holder.log`, in
/// the session dir's crash evidence, and in the WARN line this writes.
/// Forget this session's heal cooldown, so the next [`auto_heal`] runs
/// immediately (B5/T8.1).
///
/// The ONLY caller is the manual `POST /api/sessions/{name}/recover` rung. The
/// cooldown exists to stop the AUTOMATIC layer from thrashing a session that
/// dies repeatedly; a human pressing a button, having already seen the badge,
/// is not that loop. Making them wait out a timer they cannot see would be the
/// worst version of this feature.
pub fn clear_heal_cooldown(name: &str) {
    LAST_HEAL.remove(name);
    // A human driving the recovery ladder starts from a clean slate: the
    // "the last heal came back without its agent" latch is about the AUTOMATIC
    // layer's own history, not about what the user is entitled to try.
    HEAL_FAILED.remove(name);
}

pub async fn auto_heal(state: &AppState, name: &str, reason: &str) -> Heal {
    let s = match db::sessions::get(&state.pool, name).await {
        Ok(Some(s)) if s.archived == 0 => s,
        Ok(_) => return Heal::Gone,
        Err(e) => {
            tracing::warn!(name = %name, error = %e, "auto-heal: could not read the session row");
            return Heal::Gone;
        }
    };
    // THE LOGIN FREEZE, checked before anything else this function could do.
    // `lifecycle::send_*` refuses writes while a login is in flight; this is the
    // other half — the restart. It comes before the runtime/support checks so a
    // frozen session reports the reason a human can act on ("finish the login")
    // rather than an incidental one.
    if super::login::is_frozen(name) {
        tracing::info!(name = %name, "auto-heal: skipped — a login is in flight");
        return Heal::Frozen;
    }
    if s.runtime != RUNTIME_NATIVE || s.host_id.is_some() {
        return Heal::Unsupported;
    }
    if !heal_is_supported(&s) {
        tracing::info!(
            name = %name,
            provider = %s.provider,
            "auto-heal: skipped — a claude session with no resume link would come back empty",
        );
        return Heal::Unsupported;
    }
    if !db::prefs::auto_heal_enabled(&state.pool).await {
        tracing::info!(name = %name, "auto-heal: skipped — recovery.auto_heal is off");
        return Heal::Disabled;
    }
    // Claim the window BEFORE doing anything slow. One atomic map entry op, so
    // two racing callers (a detector tick and the boot audit) can not both win.
    // `Instant` is monotonic-since-boot and can underflow on subtraction, hence
    // the explicit occupied/vacant match rather than an `or_insert(now - window)`.
    {
        use dashmap::mapref::entry::Entry;
        match LAST_HEAL.entry(name.to_string()) {
            Entry::Occupied(mut slot) => {
                let since = slot.get().elapsed();
                if since < AUTO_HEAL_COOLDOWN {
                    tracing::warn!(
                        name = %name,
                        reason = %reason,
                        since_last_secs = since.as_secs(),
                        "auto-heal: NOT restarting — already healed this session recently; \
                         it stays stopped with the terminal-died badge",
                    );
                    return Heal::Cooldown;
                }
                slot.insert(Instant::now());
            }
            Entry::Vacant(slot) => {
                slot.insert(Instant::now());
            }
        }
    }

    // THE USER WINS. Everything above (the row read, the pref read, the cooldown
    // claim) is `await`ed, and a person watching their session die reacts inside
    // that window: they press Stop, or Resume, or delete it. Re-read the state
    // now, as late as possible, and restart only a session that is still exactly
    // what the death stamped — `stopped`, with no lifecycle op of its own in
    // flight. Without this an auto-heal could resurrect a session the user had
    // just deliberately stopped, which reads as the daemon fighting them.
    if !still_death_stamped(state, name).await {
        tracing::info!(
            name = %name,
            "auto-heal: skipped — the session moved on while we were deciding (a Stop, a \
             Resume, or another lifecycle op is in flight)",
        );
        return Heal::Superseded;
    }

    tracing::warn!("auto-heal: restarting '{name}' after terminal death ({reason})");
    match run_heal_start(state, name).await {
        // A SPAWN IS NOT A HEAL. `start` returns Ok as soon as the pane exists,
        // and its `ready` flag — the poll that waits for the provider's own UI
        // (the `❯` prompt / "? for shortcuts"), i.e. provider-level proof the
        // agent is at the wheel — used to be DISCARDED here. When the resume
        // link was stale, `claude --resume` printed "No conversation found with
        // session ID: …" and exited, leaving bash on the pty; we cleared the
        // badge anyway, the API reported idle with error=null, the tile went
        // green and the chat panel mounted a composer over a session with no
        // agent in it. Delegated prompts were then swallowed by that bash
        // ("GHOST-DELEGATE-PROBE: command not found") while the product claimed
        // health — work destroyed silently, which is the one failure mode a
        // recovery feature must never have.
        Ok(HealStart::Superseded) => {
            // The atomic precondition inside `start_if_stopped` saw the row move
            // off `stopped` under the lock — a user Stop/Resume/delete landed in
            // the window between our decision and the restart. THE USER WINS; we
            // did not spawn anything.
            tracing::info!(
                name = %name,
                "auto-heal: skipped under the lock — the session was changed by \
                 another op just before the restart",
            );
            Heal::Superseded
        }
        Ok(HealStart::Started(true)) => {
            // The AGENT is serving again: drop the crash badge the detector
            // raised. `start` already broadcast `starting → active`.
            clear_holder_death_badge(state, name);
            tracing::info!(name = %name, "auto-heal: '{name}' is back up");
            Heal::Healed
        }
        Ok(HealStart::Started(false)) => {
            // The terminal came back; the agent did not. Keep the honest badge
            // (the frontend renders `holder_died` as "Terminal died" WITH the
            // inline Resume affordance — the one error a user can act on) and
            // say why, naming the link that failed so the next step is obvious.
            stamp_heal_failed(state, name, &s);
            // Honor `Heal::Failed`'s contract at the daemon layer: the row must
            // end `stopped`, not the `active` a bare `start` persists the moment
            // the pane exists. `start_if_stopped` already restores this on the
            // real path; re-asserting it here keeps the contract even if a start
            // regresses, and is exactly what a false-active consumer (the roster
            // dot, the board live-check, the detector's `prev` seed) reads.
            let _ = db::sessions::set_last_status(&state.pool, name, "stopped").await;
            tracing::error!(
                name = %name,
                cc_conversation_id = %s.cc_conversation_id,
                cc_session_name = %s.cc_session_name,
                "auto-heal: the pane came back but the agent never did — NOT clearing the \
                 badge; the session is a bare shell wearing its name",
            );
            Heal::Failed
        }
        Err(e) => {
            stamp_heal_failed(state, name, &s);
            let _ = db::sessions::set_last_status(&state.pool, name, "stopped").await;
            tracing::error!(
                name = %name,
                error = %e,
                "auto-heal: restart FAILED — the session stays stopped with its badge",
            );
            Heal::Failed
        }
    }
}

/// Sessions whose last heal ran but did NOT bring the agent back.
///
/// The latch exists because the detector's alive tick clears the `holder_died`
/// badge on any live terminal — and after a failed resume the terminal IS live,
/// it is just a bash prompt. Without this the honest badge survived for one tick
/// (~2s) and the ghost went green again. Cleared the moment a program actually
/// owns the pty again (the alive tick probes it), on a successful heal, and on a
/// manual recovery.
/// The value is "releasing this latch needs AGENT evidence" — true for the
/// provider whose failed resume does not drop to a shell (see
/// [`agent_evidence_required`]).
static HEAL_FAILED: once_cell::sync::Lazy<dashmap::DashMap<String, bool>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Is `name` sitting on a heal that came back without its agent?
fn heal_failed_pending(name: &str) -> bool {
    HEAL_FAILED.contains_key(name)
}

/// Does `name`'s latch need AGENT evidence to open, or is "a program owns the
/// pty" enough?
///
/// Only `claude` needs the strict rule, and only because of one screen:
/// `claude --resume '<stale>'` does not exit, it parks in claude's interactive
/// Resume picker — a live program that satisfies `shell_is_foreground() ==
/// Some(false)`, which is how the honest `resume failed: <link>` badge was wiped
/// on the very next ~2 s tick and never reached a client.
///
/// Every other provider's failed restart really does leave a shell, and their
/// "agent UI" is a bash prompt that `agent_ui_visible` cannot match — so
/// applying the strict rule to them would latch a badge that nothing could ever
/// clear. Narrowest fix that closes the bug and cannot invent a new one.
fn agent_evidence_required(name: &str) -> bool {
    HEAL_FAILED.get(name).map(|v| *v).unwrap_or(false)
}

/// Re-raise the terminal-died badge with the reason a heal failed, and latch it
/// so the next alive tick does not wipe it off a pane that is only a shell.
pub(crate) fn stamp_heal_failed(state: &AppState, name: &str, s: &db::sessions::Session) {
    HEAL_FAILED.insert(name.to_string(), s.provider == "claude");
    let link = if !s.cc_session_name.trim().is_empty() {
        s.cc_session_name.trim()
    } else {
        s.cc_conversation_id.trim()
    };
    let message = if s.provider == "claude" && !link.is_empty() {
        format!("terminal died; resume failed: {link}")
    } else {
        "terminal died; the restart ran but the agent did not come back".to_string()
    };
    if state.set_error(name, HOLDER_DIED.to_string(), message.clone()) {
        broadcast(state, "sessions", json!({ "delta": [{
            "name": name,
            "error": { "type": HOLDER_DIED, "message": message },
        }] }));
    }
}

/// Is `name` still in the state a terminal death leaves behind — persisted
/// `stopped`, and nobody else mid-operation on it?
///
/// The lock probe is the half that catches a Stop or a Resume the user started a
/// moment ago: every mutating lifecycle op holds the per-session lock for its
/// whole duration (a Stop can take seconds), and the row it is going to write
/// has not been written yet. `try_lock` never blocks and the guard is dropped
/// immediately — this is a probe, not a claim; `start` takes the lock properly
/// when we go on to call it.
async fn still_death_stamped(state: &AppState, name: &str) -> bool {
    let lock = state.lock_for(name);
    if lock.try_lock().is_err() {
        return false;
    }
    matches!(
        db::sessions::runtime(&state.pool, name).await.ok().flatten(),
        Some(rt) if rt.last_status == Status::Stopped.as_str(),
    )
}

/// The restart itself — the very same entry point the user's Resume button
/// takes, so a healed claude session resumes its conversation exactly as a
/// manual Resume would.
///
/// Returns the [`HealStart`] outcome: `Started(ready)` — whether the provider's
/// own UI was observed within the wait-for-ready window — or `Superseded` when the
/// atomic under-lock precondition saw a user beat the daemon to the session. The
/// `ready` flag is the provider-level proof the heal is judged on — see
/// [`auto_heal`] for what discarding it cost.
async fn run_heal_start(state: &AppState, name: &str) -> anyhow::Result<HealStart> {
    #[cfg(test)]
    {
        HEAL_ATTEMPTS
            .entry(name.to_string())
            .and_modify(|n| *n += 1)
            .or_insert(1);
        // Test hook, compiled out of production builds: a lib test has no
        // `pty-holder` binary to spawn, and the guard semantics (one attempt,
        // then a cooldown) are what the tests are about — not `start`'s own
        // behaviour, which has its own tests. Defaults to ON so no unrelated
        // test can accidentally launch a session from a heal. The dry run
        // reports READY: it stands in for a restart that worked, so a test about
        // the guards is not also a test about a failed resume.
        if HEAL_DRY_RUN.load(std::sync::atomic::Ordering::Relaxed) {
            let ready = HEAL_DRY_RUN_READY.load(std::sync::atomic::Ordering::Relaxed);
            // Faithfully mirror the one `start` behaviour the failure path has to
            // undo: a real `start` persists `active` the instant the pane exists,
            // BEFORE it knows whether the agent took the wheel. Stamp it here on
            // the not-ready path so the `Heal::Failed` status-restore is genuinely
            // exercised (otherwise the row is trivially already-`stopped` and the
            // regression can't be seen).
            if !ready {
                let _ = db::sessions::set_last_status(&state.pool, name, "active").await;
            }
            return Ok(HealStart::Started(ready));
        }
    }
    Ok(crate::sessions::lifecycle::start_if_stopped(state, name).await?)
}

/// Test-only: what the dry-run restart reports for `ready`. Flipped false by the
/// test that drives the "the pane came back, the agent did not" path.
#[cfg(test)]
static HEAL_DRY_RUN_READY: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);

/// Test-only: how many times [`run_heal_start`] was entered, per session.
#[cfg(test)]
static HEAL_ATTEMPTS: once_cell::sync::Lazy<dashmap::DashMap<String, u32>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Dry-run gate for the heal's restart, TEST-ONLY: the only reader is the
/// `.load()` inside [`run_heal_start`]'s `#[cfg(test)]` block, so production
/// never consults it (the real heal always calls the real restart) and the
/// former `#[cfg(not(test))] = false` twin was a dead static kept for symmetry.
/// A true default once shipped a no-op auto-heal (caught live in E2E: the death
/// badge appeared but the session never restarted); tests default it ON so
/// unrelated tests can't spawn real sessions, and the one end-to-end heal test
/// flips it off explicitly.
#[cfg(test)]
static HEAL_DRY_RUN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Test-only: forget `name`'s cooldown stamp and attempt count.
#[cfg(test)]
pub(crate) fn reset_heal_state(name: &str) {
    LAST_HEAL.remove(name);
    HEAL_ATTEMPTS.remove(name);
    HEAL_FAILED.remove(name);
}

/// Test-only: how many heal attempts `name` has had.
#[cfg(test)]
pub(crate) fn heal_attempts(name: &str) -> u32 {
    HEAL_ATTEMPTS.get(name).map(|n| *n).unwrap_or(0)
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-UPDATE ATTACH AUDIT
// ─────────────────────────────────────────────────────────────────────────────

/// How long the audit waits after boot before judging anything. The native
/// pump's reconnect backoff is randomised up to 5s and an attach has to replay
/// the spool before it counts, so a verdict taken any earlier would fail
/// sessions that were merely still settling. 20s is comfortably past that and
/// still inside the window an operator watches a deploy.
pub const AUDIT_DELAY: Duration = Duration::from_secs(20);

/// One session the audit will hold to account: it was RUNNING when this daemon
/// (or the previous one) went down, so after an update it had better be
/// attached again.
#[derive(Debug, Clone)]
pub struct AuditTarget {
    pub name: String,
    /// The persisted `last_status` as it was BEFORE `reconcile_on_boot` rewrote
    /// it — the whole point of snapshotting separately.
    pub was: String,
}

/// What one audit pass found. Every field is in the single summary line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditSummary {
    /// Sessions that were running at shutdown and got checked.
    pub checked: usize,
    /// …of those, still attached (or with a live holder) afterwards.
    pub reattached: usize,
    /// …of those, not attached but successfully auto-healed.
    pub healed: usize,
    /// …of those, still down (heal disabled, in cooldown, unsupported, failed).
    pub failed: usize,
    /// …of those, mid-START when the audit looked: not a verdict, and never a
    /// heal (see [`post_update_audit`]).
    pub skipped: usize,
}

/// Which sessions the post-update audit should check.
///
/// MUST be called BEFORE [`reconcile_on_boot`], which rewrites `last_status` to
/// `stopped` for every session it finds dead — after that pass the "was it
/// running at shutdown?" fact is gone. Native + local only: tmux sessions are
/// out of scope for this wave and a remote row has no local holder to attach to.
pub async fn snapshot_for_audit(state: &AppState) -> Vec<AuditTarget> {
    let sessions = match db::sessions::list(&state.pool).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "post-update audit: could not list sessions");
            return Vec::new();
        }
    };
    let runtimes = match db::sessions::list_runtimes(&state.pool).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "post-update audit: could not list session runtimes");
            return Vec::new();
        }
    };
    let status_by_name: std::collections::HashMap<&str, &str> = runtimes
        .iter()
        .map(|r| (r.name.as_str(), r.last_status.as_str()))
        .collect();

    sessions
        .iter()
        .filter(|s| s.archived == 0 && s.runtime == RUNTIME_NATIVE && s.host_id.is_none())
        .filter_map(|s| {
            let was = *status_by_name.get(s.name.as_str())?;
            // Only a session that was RUNNING owes us a re-attach. `starting`
            // counts: a deploy that lands mid-start must not lose that session.
            if !matches!(was, "active" | "idle" | "waiting" | "starting") {
                return None;
            }
            Some(AuditTarget {
                name: s.name.clone(),
                was: was.to_string(),
            })
        })
        .collect()
}

/// Schedule the one-shot post-update attach audit. Returns immediately; the
/// audit itself runs [`AUDIT_DELAY`] later, off the boot path.
pub fn spawn_post_update_audit(state: &AppState, targets: Vec<AuditTarget>) {
    let state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(AUDIT_DELAY).await;
        post_update_audit(&state, &targets).await;
    });
}

/// EVERY update must leave an explicit trail: for each session that was running
/// when the daemon went down, prove it is attached again — and if it is not, say
/// so and try to fix it.
///
/// A session passes when THIS daemon's pump is attached to its holder, or when
/// the non-destructive holder probe says the holder + child are still up (the
/// pump may simply not have dialled yet for a session nobody has opened). Both
/// checks are filesystem/in-memory only; neither dials the holder's socket,
/// which would evict a live daemon connection.
///
/// A failure gets a WARN naming the session and — when the holder left one — the
/// reason it recorded, then the same [`auto_heal`] the detector uses, cooldown
/// and pref included. One INFO summary line is emitted ALWAYS, even for zero
/// sessions, so "the audit ran and found nothing wrong" is distinguishable from
/// "the audit never ran".
pub async fn post_update_audit(state: &AppState, targets: &[AuditTarget]) -> AuditSummary {
    let mut summary = AuditSummary {
        checked: targets.len(),
        ..Default::default()
    };
    for t in targets {
        let name = t.name.as_str();
        let ok = crate::sessions::native::attached(name)
            || crate::sessions::native::holder_alive(name, &state.config.data_dir);
        if ok {
            summary.reattached += 1;
            continue;
        }
        // MID-START is not a failure. `snapshot_for_audit` deliberately includes
        // `starting` sessions, and a start that is still running has by
        // definition no holder to be attached to yet — the holder is what it is
        // busy spawning. WARNing about that would be noise, and healing it would
        // be worse: `auto_heal` → `start` blocks on the very lock the running
        // start holds, then starts the session a SECOND time behind it.
        if is_mid_start(state, name).await {
            tracing::info!("post-update audit: '{name}' is mid-start — no verdict");
            summary.skipped += 1;
            continue;
        }
        let reason = crate::sessions::native::death_reason(name, &state.config.data_dir)
            .unwrap_or_else(|| "no exit marker — the holder vanished".to_string());
        tracing::warn!("post-update audit: '{name}' failed to re-attach ({reason})");
        match auto_heal(state, name, &reason).await {
            Heal::Healed => summary.healed += 1,
            _ => summary.failed += 1,
        }
    }
    tracing::info!(
        "post-update audit: {} sessions checked, {} re-attached, {} healed, {} failed, \
         {} skipped (mid-start)",
        summary.checked,
        summary.reattached,
        summary.healed,
        summary.failed,
        summary.skipped,
    );
    summary
}

/// Is a `start` for `name` running RIGHT NOW? Two independent signs, either of
/// which means "come back later": the per-session lifecycle lock is held (a
/// mutating op is in flight — `start` holds it end to end), or the persisted row
/// still says `starting`.
async fn is_mid_start(state: &AppState, name: &str) -> bool {
    let lock = state.lock_for(name);
    if lock.try_lock().is_err() {
        return true;
    }
    matches!(
        db::sessions::runtime(&state.pool, name).await.ok().flatten(),
        Some(rt) if rt.last_status == "starting",
    )
}

/// Drop the [`HOLDER_DIED`] badge once the session's terminal is serving again.
/// Only ever clears OUR badge: an agent error from a `StopFailure` hook is a
/// different fact with a different lifecycle (cleared by the next prompt).
fn clear_holder_death_badge(state: &AppState, name: &str) {
    // The terminal is alive again: the death is history — release the
    // DEATH_SEEN edge so a FUTURE death of this session is a fresh heal edge,
    // and the failed-heal latch with it.
    DEATH_SEEN.remove(name);
    HEAL_FAILED.remove(name);
    let ours = state
        .session_activity(name)
        .and_then(|a| a.error)
        .is_some_and(|(t, _)| t == HOLDER_DIED);
    if ours && state.clear_error(name) {
        broadcast(state, "sessions", json!({ "delta": [{ "name": name, "error": null }] }));
    }
}

/// Session→board reaction. Called on a COMMITTED status
/// transition for `session`, with `new` being the status it just transitioned
/// INTO. Resolves the issue the session OWNS in the `doing` column
/// (`db::board::doing_issue_for_session`) and applies the safe-default side-effect:
///
/// * `Idle` — the agent finished its turn. Post a single SYSTEM comment
///   (author `system`) AND set the issue's `needs_review` flag, so the board can
///   badge the card "needs review". We do NOT move the column and do NOT auto-pick
///   the next issue (safe default). Guarded by `needs_review == 0`
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
            // The agent resumed working — clear BOTH attention flags
            // ("active → clear both"). A running agent is neither blocked
            // (`awaiting_input`) nor finished-and-awaiting-review (`needs_review`):
            // it picked the work back up, so both stale badges come down. Only
            // write + re-publish when at least one flag actually flips off.
            if issue.awaiting_input != 0 || issue.needs_review != 0 {
                db::board::patch_issue(
                    &state.pool,
                    &issue.id,
                    &[
                        db::board::IssueField::AwaitingInput(0),
                        db::board::IssueField::NeedsReview(0),
                    ],
                )
                .await?;
                crate::board::emit_board(state).await;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Phone notification on a status transition edge. Called from [`tick`] on the
/// `committed` (flap-confirmed) transition ONLY. Each branch maps to ONE
/// user-facing category the operator can independently mute in Settings →
/// Notifications:
///
/// * `Waiting` → `agent_waiting` ("agent {name} needs you"). Blocked on the
///   user.
/// * `Idle` → `agent_finished` ("agent {name} finished"). Turn done, ready for
///   review — the "groene status" the user explicitly asked to be pinged on.
/// * `Stopped` → `agent_stopped` ("agent {name} stopped"). The tmux pane went
///   away.
/// * Anything else (Active / Starting / Unknown) is intentionally silent — not
///   a user-actionable edge.
///
/// **Trailing-coalesce debounce.** Instead of firing immediately, the
/// send is scheduled after a quiet window — each fresh transition for this
/// session CANCELS the prior pending send (via the abort handle in
/// `state.pending_pushes`) and schedules a new one. At expiry the timer task
/// re-reads the session's persisted status and only fires if it still maps to
/// the same category. That collapses two real patterns into one notification:
/// (1) the `Starting → Active → Idle` bootup flurry where Idle wins after a
/// second or two, and (2) the team-lead-bouncing-through-Idle pattern where a
/// lead orchestrating teammates pulses Idle every few seconds — we want one
/// "team finished" ping after things actually settle, not six in a minute.
///
/// The body for Waiting is enriched via [`AppState::push_reason_for`] (set
/// once a blocked reason / last_error is captured); a generic
/// fallback covers cold-start. `send_push_for` itself no-ops cheaply when
/// nobody is subscribed OR the category is muted.
/// A committed status that means the turn is over, so the live outstanding-
/// subagent count must be 0. Used to self-correct best-effort count drift at
/// every turn end (idle/stopped), independent of whether the per-turn reset
/// hooks fired. `Waiting` is excluded: a subagent can still be running while the
/// main agent is blocked on the user mid-turn.
fn turn_ends_subagents(s: Status) -> bool {
    matches!(s, Status::Idle | Status::Stopped)
}

/// Whether a settled transition into `cat` should actually send, given the
/// session's freshly re-read persisted `last_status` and live outstanding
/// `subagents` count. Pure so the debounce decision is unit-testable.
fn push_should_fire(cat: crate::db::push::NotifCategory, last_status: &str, subagents: u32) -> bool {
    use crate::db::push::NotifCategory;
    let cat_matches = matches!(
        (cat, last_status),
        (NotifCategory::AgentWaiting, "waiting")
            | (NotifCategory::AgentFinished, "idle")
            | (NotifCategory::AgentStopped, "stopped"),
    );
    // The finished ping is held while Task subagents are still in flight: a
    // multi-agent turn that momentarily reads idle between subagent dispatches
    // must not cry "finished". Only AgentFinished is gated — a genuine
    // needs-you (Waiting) or stopped signal always tells. Fail-safe: the count
    // is force-0'd on the main Stop, so a lost SubagentStop can never
    // permanently suppress a real finish.
    cat_matches && !(matches!(cat, NotifCategory::AgentFinished) && subagents > 0)
}

/// The detector's push path — now the FALLBACK, not the primary (B5/T2.2).
///
/// **Why this is gated.** `notify::notify_event` (the hook-anchored path) and
/// this function perform the identical `pending_pushes.remove().abort()` +
/// `insert()` dance on the same `DashMap`. A Claude session drives BOTH for one
/// logical turn boundary — the `Stop` hook fires one, the detector observes
/// `Idle` ~2 s later and fires the other — so left ungated they abort each
/// other's timers in whichever order they happen to land. The failure is
/// SILENT: a dropped push is indistinguishable from a muted one, and the
/// surviving push may be composed by the wrong writer with different copy.
/// (`tests/notify_one_writer.rs` pins this.)
///
/// So there is exactly one writer per session, chosen by provider:
///
/// * `claude` (including board / scheduler sessions) → the hook path owns it.
///   This function returns early, having touched nothing.
/// * `codex` / `shell` → no hooks exist, so this remains their ONLY
///   route to a notification and stays fully live.
///
/// The two behaviours this path had grown that the hook path lacked — the 15 s
/// team-finish window and `push_should_fire`'s subagent gate — moved into
/// `notify.rs` (T2.3) BEFORE this demotion, not after, so nothing was lost in
/// transit. The gate is one predicate (`notify::provider_emits_hooks`), which
/// is what makes gate G2(a) reversible without a revert.
pub fn maybe_push_on_transition(state: &AppState, name: &str, new: Status) {
    use crate::db::push::NotifCategory;
    let cat = match new {
        Status::Waiting => NotifCategory::AgentWaiting,
        Status::Idle => NotifCategory::AgentFinished,
        Status::Stopped => NotifCategory::AgentStopped,
        _ => return,
    };

    // The provider read is a cheap PK lookup, but it is async and this function
    // is sync, so the check rides inside the spawned task below rather than
    // gating here. Reading it here would mean either blocking the detector loop
    // or making every caller async for a branch that is usually `return`.

    // Two timers: the default 2s quiet window handles the bootup flurry; a
    // longer 15s window is used ONLY for "agent finished" on a team-tagged
    // session, where the lead can legitimately bounce in and out of Idle every
    // few seconds while it dispatches teammates. The longer window holds the
    // ping until the lead has been idle long enough that the team is actually
    // done. Waiting and Stopped keep the short window even on team leads —
    // those are unambiguous "you need to act" signals and shouldn't be delayed.
    const T_DEFAULT: Duration = Duration::from_secs(2);
    const T_TEAM_FINISH: Duration = Duration::from_secs(15);

    // B5/T2.2 — the one-writer gate runs BEFORE anything touches
    // `pending_pushes`, and that ordering is the whole fix.
    //
    // The provider read is async and this function is sync (the detector loop
    // calls it from a tick), so the gate rides in an outer task whose ONLY job
    // is to decide. The debounce dance — cancel-prior, spawn, install — happens
    // inside it, after the decision. Gating any later would mean this path had
    // already aborted and removed the HOOK path's pending handle on its way to
    // discovering it should not have run: the observable symptom is zero
    // pushes for a turn that produced two writers, which is exactly what
    // `notify_one_writer.rs` caught.
    let gate_state = state.clone();
    let gate_name = name.to_string();
    tokio::spawn(async move {
        // A lookup that fails falls through to the fallback: an unknown
        // provider losing its notifications entirely is worse than an
        // occasional duplicate.
        let hooked = match db::sessions::get(&gate_state.pool, &gate_name).await {
            Ok(Some(row)) => crate::notify::provider_emits_hooks(&row.provider),
            _ => false,
        };
        if hooked {
            tracing::trace!(
                name = %gate_name,
                "detector push skipped — this provider's notifications are hook-anchored",
            );
            return;
        }

        // From here down this session has no hook path, so this IS its single
        // writer and the original debounce applies unchanged.
        //
        // Cancel any prior pending send for this session FIRST, then install
        // the new task. Using `remove` (rather than `insert` + checking the
        // return) lets us abort the prior handle before the new one is even
        // spawned — there's no detector-loop concurrency for a single session,
        // so no thread can squeeze a second insert in between.
        if let Some((_, prev)) = gate_state.pending_pushes.remove(&gate_name) {
            prev.abort();
        }

        let task_state = gate_state.clone();
        let task_name = gate_name.clone();
        let handle = tokio::spawn(async move {

        let delay = if matches!(cat, NotifCategory::AgentFinished)
            && db::sessions::team_name(&task_state.pool, &task_name).await.ok().flatten().is_some()
        {
            T_TEAM_FINISH
        } else {
            T_DEFAULT
        };
        tokio::time::sleep(delay).await;

        // The timer fires only after `delay` of quiet. Re-read the persisted
        // status: if the session has since transitioned OUT of the category
        // this push was for, drop the send. (A later transition into a
        // notify-worthy state will have scheduled its OWN debounce task.)
        let still_matches = match db::sessions::runtime(&task_state.pool, &task_name).await {
            Ok(Some(rt)) => push_should_fire(
                cat,
                rt.last_status.as_str(),
                task_state.subagents(&task_name),
            ),
            _ => false,
        };
        if !still_matches {
            // Drop the entry once we've decided not to send, so a future
            // transition's `remove(...).abort()` doesn't try to cancel a stale
            // already-completed task.
            task_state.pending_pushes.remove(&task_name);
            return;
        }

        // Re-read the freshest reason (it may have arrived via a hook during
        // the quiet window) so the notification body reflects whatever's
        // current at the moment of send.
        let (title, body) = match cat {
            NotifCategory::AgentWaiting => (
                format!("agent {task_name} needs you"),
                task_state.push_reason_for(&task_name, Status::Waiting),
            ),
            NotifCategory::AgentFinished => (
                format!("agent {task_name} finished"),
                "Turn done — ready for your review.".to_string(),
            ),
            NotifCategory::AgentStopped => (
                format!("agent {task_name} stopped"),
                task_state.push_reason_for(&task_name, Status::Stopped),
            ),
            // Other categories are not produced by maybe_push_on_transition.
            _ => return,
        };
        let url = format!("/focus/{task_name}");
        // B5/T1.4 — the payload shape. The tier is derived from the category
        // rather than hard-coded: `AgentFinished` is the calm review-when-you-can
        // tier, the other two genuinely interrupt. Passing the session lets the
        // per-bot policy mute this lane, which is what that control is for.
        let tier = match cat {
            NotifCategory::AgentFinished => crate::notify::Tier::Unread,
            NotifCategory::AgentStopped => crate::notify::Tier::Error,
            _ => crate::notify::Tier::Attention,
        };
        let payload = crate::notify::PushPayload::simple(title, body, url, tier);
        let n = crate::push::send_push_for(&task_state, cat, &payload, Some(&task_name)).await;
        if n > 0 {
            tracing::debug!(
                name = %task_name,
                category = cat.as_str(),
                devices = n,
                "push sent after debounce settle",
            );
        }
        // The scheduled task has completed: clear its slot so the map doesn't
        // grow unboundedly. A new transition between the send finishing and
        // this remove will simply overwrite the slot, which is correct.
            task_state.pending_pushes.remove(&task_name);
        });

        // Spawn → insert ordering note. We `tokio::spawn` BEFORE installing the
        // abort handle, but the spawned task's first action is
        // `tokio::time::sleep(delay).await` with `delay >= 2s`, so it cannot
        // reach its `pending_pushes.remove(...)` bookkeeping until well after
        // the insert below has completed. Stale-slot scenarios are therefore
        // unreachable as long as both `T_DEFAULT` and `T_TEAM_FINISH` stay well
        // above scheduler-poll latency.
        gate_state
            .pending_pushes
            .insert(gate_name.clone(), handle.abort_handle());
    });
}

/// Last [`PREVIEW_LINES`] lines of the (already ANSI-stripped) capture — the tile
/// preview tail surfaced over SSE, matching `SessionView::preview_lines`.
fn tail_lines(capture: &str) -> Vec<String> {
    if capture.is_empty() {
        return Vec::new();
    }
    let lines: Vec<&str> = capture.lines().collect();
    let start = lines.len().saturating_sub(PREVIEW_LINES);
    lines[start..].iter().map(|s| s.to_string()).collect()
}

/// Publication policy for the tile chat tail on the `sessions` SSE delta.
///
/// One per session, owned by that session's detector loop — which is what makes
/// the debounce per-session by construction (a busy session cannot throttle a
/// quiet one).
///
/// Two gates, in order:
/// 1. **change** — the same rule `preview_lines` uses: the delta carries what
///    changed, and an idle session ticks forever;
/// 2. **debounce** — at most one publication per [`CHAT_TAIL_MIN_INTERVAL`].
///
/// A suppressed tail is never "lost": it is simply not recorded as published, so
/// the next tick past the window ships whatever the tail is *then* — the newest
/// truth rather than a replay of a batch's intermediate states.
///
/// `None` in ⇒ `None` out. A session with no chat store (nobody attached) and a
/// store whose ring is empty (or was just cleared by a resync) both omit the key
/// rather than publishing an empty tail: on the wire, "empty chat" is a claim,
/// and it is the exact claim A2's staleness work exists to stop making.
pub struct ChatTailGate {
    last: Option<ChatTail>,
    last_sent_at: Option<Instant>,
}

impl Default for ChatTailGate {
    fn default() -> Self {
        Self::new()
    }
}

impl ChatTailGate {
    /// A gate that has never published: the first non-empty tail it sees ships
    /// immediately (a fresh detector loop must not sit on the tail for a second).
    pub fn new() -> Self {
        Self { last: None, last_sent_at: None }
    }

    /// Sample the session's ring and decide whether this tick publishes.
    ///
    /// Takes the NON-creating [`AppState::chat_store`](crate::state::AppState::chat_store)
    /// result: a session nobody has a chat client on must not grow a store (and
    /// therefore an in-memory transcript) just because its detector ticked. The
    /// read is a `DashMap` hit plus a ring walk under the store's own mutex —
    /// **never** a file read (a full recall scan per tile per tick would flood
    /// the blocking pool; the live corpus is 8.9 MB).
    fn poll(&mut self, store: Option<&ChatStore>) -> Option<ChatTail> {
        self.poll_at(Instant::now(), store.and_then(|s| s.tail_summary()))
    }

    /// [`poll`](Self::poll) with the clock and the sample injected — the whole
    /// policy, as a pure function, so the tests need no tmux and no sleeping.
    fn poll_at(&mut self, now: Instant, current: Option<ChatTail>) -> Option<ChatTail> {
        let current = current?;
        if self.last.as_ref() == Some(&current) {
            return None;
        }
        if let Some(sent) = self.last_sent_at {
            if now.duration_since(sent) < CHAT_TAIL_MIN_INTERVAL {
                // Deliberately does NOT update `last`: the change is still
                // pending, so a later tick publishes the tail as it stands then.
                return None;
            }
        }
        self.last = Some(current.clone());
        self.last_sent_at = Some(now);
        Some(current)
    }
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
    //! Session→board reaction unit tests. Drive [`react_to_transition`]
    //! directly (the same one-shot side-effect the committed-transition edge in
    //! [`tick`] invokes) so the board reaction is exercised without a live tmux.

    use super::*;
    use crate::config::Config;
    use crate::db::board::NewIssue;
    use crate::db::push::NotifCategory;

    #[test]
    fn turn_end_resets_the_subagent_count_drift() {
        // The detector self-corrects best-effort count drift at a committed
        // turn-end. Idle/Stopped ⇒ no subagents can be in flight ⇒ reset. Active
        // (subagents running) and Waiting (main blocked, subagent may still run)
        // must NOT reset.
        assert!(turn_ends_subagents(Status::Idle), "idle = turn done → reset");
        assert!(turn_ends_subagents(Status::Stopped), "stopped → reset");
        assert!(!turn_ends_subagents(Status::Active), "active = subagents may be running");
        assert!(!turn_ends_subagents(Status::Waiting), "waiting = subagent may still run");
        assert!(!turn_ends_subagents(Status::Starting));
    }

    #[test]
    fn finished_push_is_gated_on_zero_subagents() {
        // The "agent finished" ping must NOT fire while Task subagents are still
        // outstanding — even if the status momentarily read idle on a missed-hook
        // edge. It fires only once the count is genuinely 0 (the count is force-0'd
        // on the main Stop, so this can never permanently suppress a real finish).
        assert!(push_should_fire(NotifCategory::AgentFinished, "idle", 0), "idle + 0 subagents → fire");
        assert!(!push_should_fire(NotifCategory::AgentFinished, "idle", 3), "idle + subagents in flight → hold");
        assert!(!push_should_fire(NotifCategory::AgentFinished, "active", 0), "status moved on → no fire");

        // Subagents must NOT suppress a genuine needs-you / stopped signal.
        assert!(push_should_fire(NotifCategory::AgentWaiting, "waiting", 5), "waiting always tells, subagents or not");
        assert!(push_should_fire(NotifCategory::AgentStopped, "stopped", 2), "stopped always tells");
    }

    pub(super) async fn test_state() -> (AppState, std::path::PathBuf) {
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
            swarm_reaper: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            extra_origins: Vec::new(),
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
                board_id: "main".into(),
                team_task_id: None,
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
                board_id: "main".into(),
                team_task_id: None,
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

#[cfg(test)]
mod boot_reconcile_tests {
    //! Boot reconcile for NATIVE rows. The native pty holder is `setsid`-
    //! detached and survives a daemon restart (that is the whole point of the
    //! split), so boot must PROBE it like it probes tmux — hardcoding `stopped`
    //! showed a live agent as stopped, and pressing Start on that row skipped the
    //! spawn (the terminal really was alive) while still typing the launch
    //! command into the running agent.
    use super::board_reaction_tests::test_state;
    use super::*;
    use crate::sessions::native::spool;

    /// Write the on-disk state a holder leaves behind: `meta.json` with a pid
    /// that is alive (our own) or not, plus the `exit` marker for a dead one.
    fn fake_holder_state(dir: &std::path::Path, name: &str, running: bool) {
        let sdir = spool::session_dir(dir, name);
        std::fs::create_dir_all(&sdir).unwrap();
        let pid = std::process::id();
        spool::write_meta(
            &sdir,
            &spool::Meta {
                session: name.into(),
                pid: if running { pid } else { 0 },
                cols: 80,
                rows: 24,
                // A live holder's sidecar records when its child really started;
                // the probe now checks that, because a LIVE pid alone is no
                // proof of identity once pids get recycled.
                started_at: crate::sessions::native::runtime::proc_start_unix(pid).unwrap_or(0),
                command: "claude".into(),
            },
        )
        .unwrap();
        if running {
            spool::clear_exit(&sdir);
        } else {
            spool::mark_exit(&sdir, 0);
        }
    }

    async fn native_row(state: &AppState, name: &str, status: &str) {
        let inp = crate::sessions::CreateInput {
            name: name.into(),
            display_name: None,
            dir: Some("/tmp".into()),
            desc: None,
            provider: Some("claude".into()),
            creator: None,
            flags: None,
            bypass_permissions: None,
            tags: None,
            branch: None,
            mcp: None,
            worktree: None,
            host_id: None,
            runtime: Some("native".into()),
        };
        crate::sessions::create(state, inp).await.expect("create");
        db::sessions::set_last_status(&state.pool, name, status).await.unwrap();
    }

    #[tokio::test]
    async fn boot_keeps_a_native_session_whose_holder_survived_and_stops_the_rest() {
        let (state, dir) = test_state().await;
        native_row(&state, "survivor", "active").await;
        native_row(&state, "goner", "active").await;
        fake_holder_state(&dir, "survivor", true);
        fake_holder_state(&dir, "goner", false);

        reconcile_on_boot(&state).await;

        let survivor = db::sessions::runtime(&state.pool, "survivor").await.unwrap().unwrap();
        assert_eq!(
            survivor.last_status, "active",
            "a native session whose holder survived must keep its status — the \
             detector re-classifies it on its next tick",
        );
        let goner = db::sessions::runtime(&state.pool, "goner").await.unwrap().unwrap();
        assert_eq!(goner.last_status, "stopped", "a dead holder reconciles to stopped");

        crate::sessions::native::forget("survivor");
        crate::sessions::native::forget("goner");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A native row that never spawned a holder at all (no `meta.json`) is
    /// stopped — the probe must not fail OPEN into "alive".
    #[tokio::test]
    async fn boot_stops_a_native_session_that_never_had_a_holder() {
        let (state, dir) = test_state().await;
        native_row(&state, "never-ran", "idle").await;

        reconcile_on_boot(&state).await;

        let row = db::sessions::runtime(&state.pool, "never-ran").await.unwrap().unwrap();
        assert_eq!(row.last_status, "stopped");
        crate::sessions::native::forget("never-ran");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod chat_tail_tests {
    //! The `chat_tail` delta key (fase A2, Task 5).
    //!
    //! [`ChatTailGate`] is the whole publication policy — change gate + debounce
    //! — as a pure function of `(now, current tail)`, so it is tested without a
    //! tmux, a tailer, or a clock that actually ticks. The tick body only reads
    //! the ring and inserts what the gate returns.

    use super::*;
    use crate::sessions::chat::store::ChatTail;

    fn tail(user: &str, agent: &str, ts: i64) -> ChatTail {
        // The B2 counter fields are fixed here: this module's tests are about
        // the GATE (change detection + debounce), and a moving epoch would make
        // every tail "changed".
        ChatTail {
            user: user.into(),
            agent: agent.into(),
            ts,
            entry_count: 0,
            last_entry_ts: ts,
            epoch: 0,
        }
    }

    #[test]
    #[allow(non_snake_case)] // the plan names this test; keep it greppable
    fn delta_carries_chat_tail_only_when_it_CHANGED() {
        let t0 = Instant::now();
        let mut gate = ChatTailGate::new();

        // No ring (nobody is watching this session's chat) → the key is omitted
        // entirely. An empty `chat_tail` on the wire would read as "this chat is
        // empty", which is exactly the lie A2 exists to prevent.
        assert_eq!(gate.poll_at(t0, None), None);

        let first = tail("run the tests", "running them now", 10);
        assert_eq!(
            gate.poll_at(t0, Some(first.clone())),
            Some(first.clone()),
            "the first tail must publish"
        );

        // Unchanged, well past the debounce window → still omitted. This is the
        // `preview_lines` gate's shape: the delta carries what CHANGED, and the
        // detector ticks every 1-5s forever on an idle session.
        assert_eq!(gate.poll_at(t0 + Duration::from_secs(5), Some(first.clone())), None);
        assert_eq!(gate.poll_at(t0 + Duration::from_secs(30), Some(first)), None);

        // A changed agent line publishes again.
        let next = tail("run the tests", "3 failed", 20);
        assert_eq!(
            gate.poll_at(t0 + Duration::from_secs(31), Some(next.clone())),
            Some(next.clone())
        );

        // A ring that went empty (a resync cleared it) must NOT blank the tile:
        // the field is omitted, and the client keeps the last value it has.
        assert_eq!(gate.poll_at(t0 + Duration::from_secs(60), None), None);

        // Wire shape pin — the tile reads `user`/`agent`/`ts`; fase B2 T5 added
        // the three unread-cursor fields (`entry_count` seq-domain,
        // `last_entry_ts` on CC's clock for display, `epoch` so the count is
        // only ever compared against itself). All six are asserted, so a field
        // cannot be added to the wire without a decision being recorded here.
        assert_eq!(
            serde_json::to_value(&next).unwrap(),
            json!({
                "user": "run the tests",
                "agent": "3 failed",
                "ts": 20,
                "entry_count": 0,
                "last_entry_ts": 20,
                "epoch": 0
            })
        );
    }

    #[test]
    fn chat_tail_publication_is_debounced_to_at_most_one_per_second_per_session() {
        // A landing batch is 30-100 entries (a0: tool-heavy turns) and every one
        // of them moves the tail. One SSE broadcast per entry would be a fan-out
        // storm to EVERY connected client, for a tile that shows one line.
        assert_eq!(CHAT_TAIL_MIN_INTERVAL, Duration::from_secs(1));

        let t0 = Instant::now();
        let mut gate = ChatTailGate::new();
        let first = tail("go", "a0", 0);
        assert_eq!(gate.poll_at(t0, Some(first.clone())), Some(first));

        let mut published = 0;
        for i in 1..=100u64 {
            // 100 distinct tails inside 500ms.
            let t = t0 + Duration::from_millis(i * 5);
            if gate.poll_at(t, Some(tail("go", &format!("a{i}"), i as i64))).is_some() {
                published += 1;
            }
        }
        assert_eq!(published, 0, "a landing batch must cost AT MOST one broadcast per second");

        // Suppressed is not lost: the next tick past the window ships the NEWEST
        // tail (the intermediate ones were never the truth for longer than 5ms).
        let latest = tail("go", "a100", 100);
        assert_eq!(
            gate.poll_at(t0 + Duration::from_millis(1_001), Some(latest.clone())),
            Some(latest.clone())
        );
        // …and the fresh publication re-arms the window.
        assert_eq!(gate.poll_at(t0 + Duration::from_millis(1_500), Some(tail("go", "a101", 101))), None);

        // "per session": the gate lives in the per-session detector loop, so a
        // busy session can never throttle a quiet one.
        let mut other = ChatTailGate::new();
        let o = tail("other", "b0", 1);
        assert_eq!(other.poll_at(t0 + Duration::from_millis(1), Some(o.clone())), Some(o));
    }
}

#[cfg(test)]
mod dead_holder_tests {
    //! The two detector-side halves of the blank-screen incident.
    //!
    //! A native session's holder died mid-run. The boot reconcile had already
    //! happened, and the running detector classifies off the CAPTURE — which can
    //! only ever yield active/waiting/idle — so the session kept its last status
    //! forever: a card that said "active", a focus screen that said nothing at
    //! all, and 500s on input, for half an hour. Meanwhile the daemon kept
    //! writing the empty grid's capture over the session's stored preview, which
    //! is what emptied the overview card as well.

    use super::board_reaction_tests::test_state;
    use super::*;
    use crate::sessions::native::spool;
    use std::time::Instant;

    async fn native_row(state: &AppState, name: &str, status: &str) {
        let inp = crate::sessions::CreateInput {
            name: name.into(),
            display_name: None,
            dir: Some("/tmp".into()),
            desc: None,
            provider: Some("claude".into()),
            creator: None,
            flags: None,
            bypass_permissions: None,
            tags: None,
            branch: None,
            mcp: None,
            worktree: None,
            host_id: None,
            runtime: Some("native".into()),
        };
        crate::sessions::create(state, inp).await.expect("create");
        db::sessions::set_last_status(&state.pool, name, status).await.unwrap();
    }

    /// One detector tick, driven directly (the loop's cadence is not under test).
    async fn one_tick(state: &AppState, name: &str, seed: Status) -> Status {
        let mut detector = StatusDetector::for_provider("claude");
        detector.force(seed);
        let mut last_tail = None;
        // "stale" so the capture-skip optimization never hides the path.
        let mut last_capture_at = Instant::now() - Duration::from_secs(60);
        // A fresh gate per driven tick. These sessions have no chat ring, so
        // `poll` answers `None` and the `chat_tail` key never reaches the delta
        // — the holder-death assertions below are unaffected by fase A2.
        let mut chat_tail = ChatTailGate::new();
        tick(
            state,
            name,
            &mut detector,
            &mut last_tail,
            &mut last_capture_at,
            &mut chat_tail,
        )
        .await
        .expect("tick")
    }

    fn drain(rx: &mut tokio::sync::broadcast::Receiver<SseEvent>) -> Vec<SseEvent> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            out.push(ev);
        }
        out
    }

    /// (b) A REAL holder, killed mid-run without a chance to write its exit
    /// marker — the production shape. The very next detector tick must flip the
    /// session to `stopped` (DB + status watch + SSE, the same triplet every
    /// other lifecycle writer uses) and surface WHY.
    #[tokio::test]
    async fn a_holder_that_dies_mid_run_is_forced_stopped_with_a_reason() {
        let (state, dir) = test_state().await;
        native_row(&state, "crasher", "active").await;

        // A real holder + a real child on a real pty.
        let args = crate::sessions::native::holder::Args {
            session: "crasher".to_string(),
            dir: spool::session_dir(&dir, "crasher"),
            socket: spool::socket_path(&dir, "crasher"),
            cols: 80,
            rows: 24,
            command: "sleep 300".to_string(),
        };
        let holder = tokio::spawn(async move {
            let _ = crate::sessions::native::holder::run(args).await;
        });
        let rt = state.runtime_for("crasher").await.expect("native runtime");
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && !rt.alive().await {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(rt.alive().await, "the holder never came up");
        let pid = rt.pane_pid().await.unwrap().expect("child pid");

        // Kill it the way the incident did: the holder goes before it can write
        // anything, and its child goes with it. What is left is exactly what the
        // daemon woke up to — a stale `meta.json`, a socket nobody listens on,
        // and NO exit marker.
        //
        // The holder here runs as a task rather than a process (there is no
        // `pty-holder` binary in a unit test), and aborting that task leaves its
        // own inner tasks — the accept loop and the pty pump — alive, so the
        // daemon-side connection would never drop on its own. `stop_pump` stands
        // in for the socket dying with a real holder process; every other fact
        // the probe reads is genuine.
        holder.abort();
        // SAFETY: plain libc call; an already-reaped pid yields ESRCH.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
        crate::sessions::native::runtime_for("crasher", &dir).stop_pump();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && rt.alive().await {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!rt.alive().await, "the probe still calls a dead holder alive");
        assert!(
            spool::read_exit(&spool::session_dir(&dir, "crasher")).is_none(),
            "precondition: this is the NO-exit-marker crash path",
        );

        let mut sse = state.sse_tx.subscribe();
        let observed = one_tick(&state, "crasher", Status::Active).await;

        assert_eq!(observed, Status::Stopped, "the tick must settle on stopped");
        let row = db::sessions::runtime(&state.pool, "crasher").await.unwrap().unwrap();
        assert_eq!(row.last_status, "stopped", "the DB must say stopped");
        assert_eq!(
            state.status_watch_for("crasher").borrow().0,
            "stopped",
            "the wait primitive must see the transition",
        );

        let events = drain(&mut sse);
        assert!(
            events.iter().any(|e| e.event == "status"
                && e.payload["status"] == "stopped"
                && e.payload["name"] == "crasher"),
            "an SSE status event must flip connected clients to the stopped UI",
        );

        // …and the user is told WHY, instead of being shown nothing.
        let error = state
            .session_activity("crasher")
            .and_then(|a| a.error)
            .expect("a crashed holder must raise the error badge");
        assert_eq!(error.0, HOLDER_DIED);
        assert!(
            error.1.contains("terminal died"),
            "the badge must carry the reason, got {:?}",
            error.1,
        );

        // IDEMPOTENT: the loop keeps ticking on a stopped session, and must not
        // re-broadcast the same transition every few seconds.
        let mut sse = state.sse_tx.subscribe();
        assert_eq!(one_tick(&state, "crasher", Status::Stopped).await, Status::Stopped);
        assert!(
            !drain(&mut sse).iter().any(|e| e.event == "status"),
            "a second tick on an already-stopped session must be silent",
        );

        crate::sessions::native::forget("crasher");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// (c) A daemon that has never attached holds an EMPTY grid, and its capture
    /// calls answer from it rather than hanging (a stopped session must never
    /// block a capture). Persisting that answer is what blanked the overview
    /// cards after a restart: the good preview was overwritten with nothing.
    #[tokio::test]
    async fn an_unattached_daemon_never_blanks_the_stored_preview() {
        let (state, dir) = test_state().await;
        native_row(&state, "preview", "idle").await;
        db::sessions::set_last_capture(&state.pool, "preview", "real screen", "real screen")
            .await
            .unwrap();

        // A holder that PROBES alive (fresh pid + honest metadata) but that this
        // daemon has no connection to — there is no socket to dial, so the pump
        // never attaches and the grid stays empty. This is the deploy/restart
        // window, and the window in which a dead holder's session lived.
        let sdir = spool::session_dir(&dir, "preview");
        std::fs::create_dir_all(&sdir).unwrap();
        let pid = std::process::id();
        spool::write_meta(
            &sdir,
            &spool::Meta {
                session: "preview".into(),
                pid,
                cols: 80,
                rows: 24,
                started_at: crate::sessions::native::runtime::proc_start_unix(pid).unwrap_or(0),
                command: "claude".into(),
            },
        )
        .unwrap();

        let rt = state.runtime_for("preview").await.expect("native runtime");
        assert!(rt.alive().await, "precondition: the holder probes alive");
        assert!(
            !rt.capture_is_authoritative().await,
            "precondition: nothing has ever attached, so the grid is a placeholder",
        );
        assert!(rt.capture_ansi(status::CAPTURE_LINES).await.unwrap().trim().is_empty());

        let observed = one_tick(&state, "preview", Status::Idle).await;

        let row = db::sessions::runtime(&state.pool, "preview").await.unwrap().unwrap();
        assert_eq!(
            row.last_capture, "real screen",
            "a blank placeholder capture must NEVER overwrite a real preview",
        );
        assert_eq!(row.last_capture_ansi, "real screen");
        assert_eq!(observed, Status::Idle, "the held status survives the skipped tick");

        crate::sessions::native::forget("preview");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// (d) …but the hold is BOUNDED. The same "holder probes alive, nothing has
    /// ever attached" state, left alone for [`BLANK_HOLD_MAX`], is not a session
    /// that is still settling — it is one nothing can serve, and holding its
    /// preview and status for ever is precisely the silent freeze the user sat
    /// in front of. Past the bound the detector reports it as gone.
    #[tokio::test]
    async fn a_blank_grid_that_never_becomes_authoritative_stops_being_held() {
        let (state, dir) = test_state().await;
        native_row(&state, "frozen", "active").await;
        db::sessions::set_last_capture(&state.pool, "frozen", "real screen", "real screen")
            .await
            .unwrap();
        let sdir = spool::session_dir(&dir, "frozen");
        std::fs::create_dir_all(&sdir).unwrap();
        let pid = std::process::id();
        spool::write_meta(
            &sdir,
            &spool::Meta {
                session: "frozen".into(),
                pid,
                cols: 80,
                rows: 24,
                started_at: crate::sessions::native::runtime::proc_start_unix(pid).unwrap_or(0),
                command: "claude".into(),
            },
        )
        .unwrap();

        // Inside the window: held, exactly as the test above pins.
        assert_eq!(one_tick(&state, "frozen", Status::Active).await, Status::Active);
        let row = db::sessions::runtime(&state.pool, "frozen").await.unwrap().unwrap();
        assert_eq!(row.last_status, "active", "the hold keeps the status while it lasts");
        assert_eq!(row.last_capture, "real screen");

        // Past it: a death-equivalent, with the badge that names the evidence.
        expire_blank_hold("frozen");
        assert_eq!(one_tick(&state, "frozen", Status::Active).await, Status::Stopped);
        let row = db::sessions::runtime(&state.pool, "frozen").await.unwrap().unwrap();
        assert_eq!(row.last_status, "stopped", "an endless blank must surface as stopped");
        assert_eq!(
            row.last_capture, "real screen",
            "…and it still must not overwrite the preview with blanks",
        );
        let error = state.session_activity("frozen").and_then(|a| a.error);
        let (kind, message) = error.expect("the user must be told why it stopped");
        assert_eq!(kind, HOLDER_DIED);
        assert!(
            message.contains("never became authoritative"),
            "the badge must name the evidence, got {message:?}",
        );

        BLANK_HOLD.remove("frozen");
        crate::sessions::native::forget("frozen");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod recovery_tests {
    //! The two automatic recoveries of this wave, plus the audit that proves an
    //! update did not quietly leave a session behind.
    //!
    //! * ORPHAN REAPING — a holder that dies while its CHILD survives leaves the
    //!   child reparented to `init` with a live pid in `meta.json` and no `exit`
    //!   marker. `Spool::create` refuses to run over exactly that state, so the
    //!   holder a Resume spawns bailed out and the Resume failed. The reap runs
    //!   in `start`, in front of the spawn.
    //! * AUTO-HEAL — one automatic restart after an UNEXPECTED death, guarded by
    //!   a pref, a support check and a per-session cooldown so a flapping session
    //!   stays stopped (visibly, with its badge) instead of looping.
    //! * POST-UPDATE AUDIT — one pass, ~20s after boot, over the sessions that
    //!   were running at shutdown, ending in a single summary line.

    use super::board_reaction_tests::test_state;
    use super::*;
    use crate::sessions::native::spool;

    /// A native, local session row — inserted directly (not via
    /// `sessions::create`) so no detector loop races the assertions.
    async fn native_row(state: &AppState, name: &str, provider: &str, status: &str) {
        db::sessions::insert_minimal(&state.pool, name, "/tmp", provider)
            .await
            .unwrap();
        db::sessions::set_runtime(&state.pool, name, RUNTIME_NATIVE)
            .await
            .unwrap();
        // `set_last_status` is a plain UPDATE — the `session_runtime` row has to
        // exist first (in production `start` creates it).
        db::sessions::ensure_runtime(&state.pool, name, "test-token")
            .await
            .unwrap();
        db::sessions::set_last_status(&state.pool, name, status)
            .await
            .unwrap();
    }

    /// Give a claude row a REAL resumable conversation.
    ///
    /// `heal_is_supported` now requires the transcript `claude --resume <id>`
    /// would read: a link to a conversation that is not on disk is exactly how
    /// the ghost session was born (claude prints "No conversation found with
    /// session ID: …" and exits, leaving bash on the pty). Points
    /// `CLAUDE_CONFIG_DIR` at a scratch root — every caller holds `test_serial`,
    /// and hands the root back so it can be unset.
    fn with_transcript(session_dir: &str, conv: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "supermux-cc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::env::set_var("CLAUDE_CONFIG_DIR", &root);
        let proj = crate::sessions::resumable::project_dir_for(session_dir);
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join(format!("{conv}.jsonl")), b"{}\n").unwrap();
        root
    }

    /// Undo [`with_transcript`].
    fn drop_transcript(root: PathBuf) {
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(root);
    }

    /// `/proc/<pid>/stat` field 4. Used to WAIT for the orphan to be reparented
    /// to `init`, which is the fact that makes it an orphan.
    fn ppid(pid: u32) -> Option<u32> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let rest = &stat[stat.rfind(')')? + 1..];
        rest.split_whitespace().nth(1)?.parse().ok()
    }

    fn alive(pid: u32) -> bool {
        // SAFETY: plain libc call with signal 0 — nothing is delivered.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    /// Fork a REAL process that outlives its parent: `sh` backgrounds `sleep`
    /// and exits, so the sleep is reparented to `init`. That is precisely the
    /// shape a holder that died without taking its child down leaves behind.
    fn spawn_real_orphan() -> u32 {
        spawn_real_orphan_running("sleep 300")
    }

    /// [`spawn_real_orphan`] running an arbitrary command (which must not
    /// contain single quotes), so a test can make the orphan survive `SIGTERM`
    /// and reach the escalation path.
    ///
    /// `setsid` is what makes it a faithful stand-in: the holder's child calls
    /// `setsid` too, so its pgid EQUALS its pid, which is the assumption the
    /// whole `killpg`-the-group reap rests on. A background job in a
    /// non-interactive shell inherits its parent's (already dead) group instead,
    /// and would prove nothing about the real path.
    fn spawn_real_orphan_running(command: &str) -> u32 {
        // The redirections matter: a background job that inherits our stdout
        // pipe keeps it open, and `output()` would block on EOF for the whole
        // 300s.
        // Explicitly bash, twice: `/bin/sh` is dash on Debian/Ubuntu (this box
        // AND the CI runners), and dash resets `trap "" TERM` in subshell
        // children — the SIGTERM the re-proof test expects to be ignored killed
        // the orphan and the test failed everywhere sh==dash. Bash keeps the
        // ignore-disposition across the background fork.
        let out = std::process::Command::new("bash")
            .arg("-c")
            .arg(format!(
                "setsid bash -c '{command}' </dev/null >/dev/null 2>&1 & echo $!"
            ))
            .output()
            .expect("fork an orphan");
        let pid: u32 = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .expect("orphan pid");
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && ppid(pid) != Some(1) {
            std::thread::sleep(Duration::from_millis(20));
        }
        pid
    }

    /// THE GAP, end to end. A crashed holder + a surviving child; `Spool::create`
    /// refuses to run over it (asserted, so this test fails loudly if that
    /// refusal is ever weakened rather than silently testing nothing); `start`
    /// reaps the orphan, preserves the crashed spool as evidence, and a fresh
    /// holder comes up on the cleared dir with the session live again.
    #[tokio::test]
    async fn start_reaps_an_orphaned_child_and_brings_a_new_holder_up() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        native_row(&state, "orphaned", "shell", "active").await;
        let sdir = spool::session_dir(&dir, "orphaned");
        std::fs::create_dir_all(&sdir).unwrap();

        let orphan = spawn_real_orphan();
        assert_eq!(ppid(orphan), Some(1), "precondition: reparented to init");

        // What the dead holder left on disk: its last screen, a sidecar naming
        // the still-live child, and NO exit marker.
        std::fs::write(spool::spool_path(&sdir), b"the screen when it crashed").unwrap();
        spool::write_meta(
            &sdir,
            &spool::Meta {
                session: "orphaned".into(),
                pid: orphan,
                cols: 80,
                rows: 24,
                started_at: crate::sessions::native::runtime::proc_start_unix(orphan).unwrap_or(0),
                command: "bash".into(),
            },
        )
        .unwrap();
        spool::clear_exit(&sdir);

        // PRECONDITION — the refusal this whole fix exists to clear.
        let refused = spool::Spool::create(&sdir);
        let err = refused.err().expect("Spool::create must refuse a live pid");
        assert!(
            err.to_string().contains("refusing to truncate"),
            "unexpected refusal text: {err}",
        );
        assert!(
            spool::spool_path(&sdir).exists(),
            "the refusal must leave the crashed spool intact",
        );

        // The `pty-holder` binary `start` execs does not exist in a lib test, so
        // point the spawn at a harmless no-op and stand the REAL holder up here
        // instead — the moment the reap has cleared the dir, exactly as the
        // exec'd one would. `Spool::create` inside `holder::run` is the same
        // refusal path, so this only succeeds if the reap really worked.
        // (No other test calls `NativeSession::spawn`, so the env var is safe.)
        std::env::set_var("SUPERMUX_HOLDER_BIN", "/bin/true");
        let hargs = crate::sessions::native::holder::Args {
            session: "orphaned".to_string(),
            dir: sdir.clone(),
            socket: spool::socket_path(&dir, "orphaned"),
            cols: 80,
            rows: 24,
            command: "sleep 300".to_string(),
        };
        let meta_path = sdir.join("meta.json");
        let holder = tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(20);
            while Instant::now() < deadline && meta_path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let _ = crate::sessions::native::holder::run(hargs).await;
        });

        let started = crate::sessions::lifecycle::start(&state, "orphaned", None).await;
        assert!(started.is_ok(), "start must recover: {:?}", started.err());

        // The orphan is gone…
        assert!(!alive(orphan), "the orphaned child must have been reaped");
        // …its screen was PRESERVED, not deleted…
        let evidence = sdir.join(crate::sessions::native::CRASHED_SPOOL);
        assert_eq!(
            std::fs::read_to_string(&evidence).unwrap(),
            "the screen when it crashed",
            "the crashed run's spool must be kept aside as evidence",
        );
        // …and a NEW holder owns the session now.
        let meta = spool::read_meta(&sdir).expect("the new holder wrote its sidecar");
        assert_ne!(meta.pid, orphan, "a new child, not the reaped one");
        assert!(alive(meta.pid), "the new child is running");
        let rt = state.runtime_for("orphaned").await.unwrap();
        assert!(rt.alive().await, "the session must be live again");

        // SAFETY: plain libc call; an already-reaped pid yields ESRCH.
        unsafe {
            libc::killpg(meta.pid as i32, libc::SIGKILL);
            libc::kill(orphan as i32, libc::SIGKILL);
        }
        holder.abort();
        std::env::remove_var("SUPERMUX_HOLDER_BIN");
        crate::sessions::native::forget("orphaned");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The reap must be INERT for a session that is genuinely serving — it is
    /// reached on every native `start`, including the "wake an already-running
    /// session" one, and killing that session's process group would be the worst
    /// bug in this wave.
    #[tokio::test]
    async fn reap_never_touches_a_live_session_or_a_clean_stop() {
        let (_state, dir) = test_state().await;
        let sdir = spool::session_dir(&dir, "live");
        std::fs::create_dir_all(&sdir).unwrap();
        let me = std::process::id();
        std::fs::write(spool::spool_path(&sdir), b"live bytes").unwrap();
        spool::write_meta(
            &sdir,
            &spool::Meta {
                session: "live".into(),
                pid: me,
                cols: 80,
                rows: 24,
                started_at: crate::sessions::native::runtime::proc_start_unix(me).unwrap_or(0),
                command: "bash".into(),
            },
        )
        .unwrap();
        spool::clear_exit(&sdir);
        assert!(
            crate::sessions::native::runtime::probe_alive(&sdir),
            "precondition: this session probes ALIVE",
        );

        assert!(
            crate::sessions::native::reap_orphan("live", &dir).await.unwrap().is_none(),
            "a live session must never be reaped",
        );
        assert!(spool::read_meta(&sdir).is_some(), "meta.json survives");
        assert!(spool::spool_path(&sdir).exists(), "out.raw survives");

        // A CLEAN stop → start cycle (marker written, pid gone) is likewise not
        // an orphan: `Spool::create` has no quarrel with it, so nothing moves.
        let sdir = spool::session_dir(&dir, "stopped");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(spool::spool_path(&sdir), b"old bytes").unwrap();
        spool::write_meta(
            &sdir,
            &spool::Meta {
                session: "stopped".into(),
                pid: 0,
                cols: 80,
                rows: 24,
                started_at: 0,
                command: "bash".into(),
            },
        )
        .unwrap();
        spool::mark_exit(&sdir, 0);
        assert!(
            crate::sessions::native::reap_orphan("stopped", &dir).await.unwrap().is_none(),
            "a cleanly stopped session is not an orphan",
        );
        assert!(spool::spool_path(&sdir).exists(), "its spool is left alone");
        assert!(spool::read_exit(&sdir).is_some(), "its exit marker is left alone");

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Write the sidecar a dead holder leaves behind for `name`: it names
    /// `pid` as the still-live child and (honestly) when that pid started.
    fn write_orphan_meta(dir: &std::path::Path, name: &str, pid: u32) {
        let sdir = spool::session_dir(dir, name);
        std::fs::create_dir_all(&sdir).unwrap();
        spool::write_meta(
            &sdir,
            &spool::Meta {
                session: name.into(),
                pid,
                cols: 80,
                rows: 24,
                started_at: crate::sessions::native::runtime::proc_start_unix(pid).unwrap_or(0),
                command: "bash".into(),
            },
        )
        .unwrap();
        spool::clear_exit(&sdir);
    }

    /// THE TOCTOU. `SIGTERM` … 600 ms … `SIGKILL` is a window in which the pid
    /// can be freed and handed to somebody else, and the proof that authorised
    /// the kill was taken BEFORE it. So the proof is re-taken, and a pid that is
    /// no longer provably ours is left alone — a missed kill is recoverable,
    /// `SIGKILL`ing a stranger's process group is not.
    #[tokio::test]
    async fn the_sigkill_escalation_re_proves_the_pid_first() {
        let (_state, dir) = test_state().await;
        // An orphan that IGNORES SIGTERM, so the reap has to reach the
        // escalation branch to have any effect at all.
        let orphan = spawn_real_orphan_running("trap \"\" TERM; while :; do sleep 1; done");
        assert_eq!(ppid(orphan), Some(1), "precondition: reparented to init");
        write_orphan_meta(&dir, "toctou", orphan);

        // Honest for the first proof (so the SIGTERM is sent), a stranger by the
        // time the escalation asks again.
        crate::sessions::native::reap_hooks::vanish_after("toctou", 1);
        let reaped = crate::sessions::native::reap_orphan("toctou", &dir)
            .await
            .expect("an orphaned session is still reaped")
            .expect("there was an orphan to reap");
        crate::sessions::native::reap_hooks::clear("toctou");

        assert!(reaped.signalled, "the first, honest proof authorised the SIGTERM");
        assert!(
            !reaped.killed,
            "the escalation must NOT fire once the pid stopped being provably ours",
        );
        assert!(
            alive(orphan),
            "a pid that is no longer ours must survive the reap untouched",
        );

        // SAFETY: plain libc call; an already-reaped pid yields ESRCH.
        unsafe {
            libc::killpg(orphan as i32, libc::SIGKILL);
            libc::kill(orphan as i32, libc::SIGKILL);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// UNPROVABLE is not "probably fine". A live pid whose identity cannot be
    /// established means the session dir may still belong to a running agent:
    /// clearing `meta.json` there lifts `Spool::create`'s refusal and puts a
    /// SECOND agent on one session. The reap refuses, and `start` fails visibly.
    #[tokio::test]
    async fn an_unprovable_identity_refuses_the_reap_instead_of_clearing_it() {
        let (state, dir) = test_state().await;
        native_row(&state, "unprovable", "shell", "stopped").await;
        let orphan = spawn_real_orphan();
        write_orphan_meta(&dir, "unprovable", orphan);
        let sdir = spool::session_dir(&dir, "unprovable");
        std::fs::write(spool::spool_path(&sdir), b"somebody may still own this").unwrap();

        crate::sessions::native::reap_hooks::unprovable("unprovable");
        let refused = crate::sessions::native::reap_orphan("unprovable", &dir)
            .await
            .expect_err("an unprovable live pid must refuse the reap");
        assert_eq!(
            refused,
            crate::sessions::native::ReapRefused::UnprovableIdentity { pid: orphan },
        );
        assert!(alive(orphan), "nothing may be signalled");
        assert!(spool::read_meta(&sdir).is_some(), "the sidecar must be left in place");
        assert!(
            spool::spool_path(&sdir).exists(),
            "and the spool must not be rotated aside",
        );

        // …and the start it is guarding fails LOUDLY rather than starting a
        // second agent on this dir.
        let err = crate::sessions::lifecycle::start(&state, "unprovable", None)
            .await
            .expect_err("start must not proceed over an unprovable session dir");
        assert!(
            err.to_string().contains("can not be proven"),
            "the error must say why, got {err}",
        );
        crate::sessions::native::reap_hooks::clear("unprovable");

        // SAFETY: plain libc call; an already-reaped pid yields ESRCH.
        unsafe {
            libc::kill(orphan as i32, libc::SIGKILL);
        }
        crate::sessions::native::forget("unprovable");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// ONE heal per death, then a cooldown. The second death inside the window
    /// must leave the session stopped (badge and all) rather than start a
    /// restart loop against something that is systematically broken.
    /// The E2E-caught race: the native reader persists `stopped` ~100ms after a
    /// holder dies, so by the detector's tick `persisted == Stopped` already —
    /// the heal must fire anyway (DEATH_SEEN edge), exactly once; and a boot
    /// that pre-inserted the edge (long-dead session) must suppress it.
    #[tokio::test]
    async fn the_heal_edge_survives_a_racing_stopped_write_and_respects_boot_preseed() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        native_row(&state, "racer", "shell", "stopped").await;
        reset_heal_state("racer");
        DEATH_SEEN.remove("racer");
        let death = || crate::sessions::runtime::TerminalDeath {
            reason: "holder is gone (test)".into(),
            unexpected: true,
        };
        let mut det = StatusDetector::new();
        // First observation with the status ALREADY persisted as Stopped (the
        // race): the heal must still be spawned once.
        force_stopped_on_death(&state, "racer", &mut det, Some(Status::Stopped), death())
            .await
            .unwrap();
        // The spawn is fire-and-forget; give it a beat.
        for _ in 0..50 {
            if heal_attempts("racer") == 1 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(heal_attempts("racer"), 1, "heal must fire despite persisted==Stopped");
        // Repeat ticks: edge already claimed → no second heal.
        force_stopped_on_death(&state, "racer", &mut det, Some(Status::Stopped), death())
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        assert_eq!(heal_attempts("racer"), 1, "repeat ticks must not re-heal");

        // Boot pre-seed: a session found dead AT BOOT must never heal via the
        // detector edge.
        native_row(&state, "longdead", "shell", "stopped").await;
        reset_heal_state("longdead");
        DEATH_SEEN.insert("longdead".to_string(), ());
        force_stopped_on_death(&state, "longdead", &mut det, Some(Status::Stopped), death())
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        assert_eq!(heal_attempts("longdead"), 0, "boot-preseeded edge must suppress the heal");
        DEATH_SEEN.remove("racer");
        DEATH_SEEN.remove("longdead");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn auto_heal_fires_once_then_holds_off_for_the_cooldown() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        // `stopped` is what a terminal death leaves behind, and what `auto_heal`
        // now re-reads before restarting anything (a user Stop must win).
        native_row(&state, "flapper", "claude", "stopped").await;
        db::sessions::set_cc_conversation_id(&state.pool, "flapper", "conv-1")
            .await
            .unwrap();
        // A resume LINK is not a resumable CONVERSATION — the heal now requires
        // the transcript the link names to exist. See `with_transcript`.
        let cc = with_transcript("/tmp", "conv-1");
        reset_heal_state("flapper");

        assert_eq!(
            auto_heal(&state, "flapper", "panic: boom").await,
            Heal::Healed,
            "the first unexpected death earns one restart",
        );
        assert_eq!(heal_attempts("flapper"), 1);

        assert_eq!(
            auto_heal(&state, "flapper", "panic: boom again").await,
            Heal::Cooldown,
            "a second death inside the cooldown must NOT restart again",
        );
        assert_eq!(
            heal_attempts("flapper"),
            1,
            "the restart path must not have been entered a second time",
        );

        reset_heal_state("flapper");
        drop_transcript(cc);
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The operator's off-switch. `recovery.auto_heal = off` means a dead
    /// terminal stays dead until a human presses Resume.
    #[tokio::test]
    async fn the_pref_disables_auto_heal_and_defaults_on() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        native_row(&state, "prefless", "shell", "stopped").await;
        reset_heal_state("prefless");

        assert!(
            db::prefs::auto_heal_enabled(&state.pool).await,
            "an unconfigured install must default to ON",
        );

        db::prefs::set_auto_heal_enabled(&state.pool, false).await.unwrap();
        assert!(!db::prefs::auto_heal_enabled(&state.pool).await);
        assert_eq!(
            auto_heal(&state, "prefless", "signal: SIGKILL").await,
            Heal::Disabled,
        );
        assert_eq!(heal_attempts("prefless"), 0, "nothing was restarted");

        db::prefs::set_auto_heal_enabled(&state.pool, true).await.unwrap();
        assert_eq!(auto_heal(&state, "prefless", "signal: SIGKILL").await, Heal::Healed);
        assert_eq!(heal_attempts("prefless"), 1);

        reset_heal_state("prefless");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A claude session with no resume link would come back as a BLANK claude
    /// wearing the dead session's name — worse than an honest badge. tmux and
    /// remote rows are likewise out of scope.
    #[tokio::test]
    async fn auto_heal_refuses_what_it_can_not_restore() {
        let (state, dir) = test_state().await;
        native_row(&state, "linkless", "claude", "active").await;
        native_row(&state, "tmuxy", "shell", "active").await;
        db::sessions::set_runtime(&state.pool, "tmuxy", "tmux").await.unwrap();
        reset_heal_state("linkless");
        reset_heal_state("tmuxy");

        assert_eq!(
            auto_heal(&state, "linkless", "holder is gone").await,
            Heal::Unsupported,
            "claude without a resume link stays stopped",
        );
        assert_eq!(
            auto_heal(&state, "tmuxy", "holder is gone").await,
            Heal::Unsupported,
            "tmux rows are untouched by this wave",
        );
        assert_eq!(
            auto_heal(&state, "no-such-session", "holder is gone").await,
            Heal::Gone,
        );
        assert_eq!(heal_attempts("linkless"), 0);
        assert_eq!(heal_attempts("tmuxy"), 0);

        reset_heal_state("linkless");
        reset_heal_state("tmuxy");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A SPAWN IS NOT A HEAL.
    ///
    /// `start` returns Ok the moment the pane exists; its `ready` flag is the
    /// provider-level proof (the poll for claude's own `❯` / "? for shortcuts")
    /// and it used to be discarded. With a stale resume link, `claude --resume`
    /// printed "No conversation found with session ID: …" and exited, leaving
    /// bash on the pty — and the heal cleared the crash badge anyway. The API
    /// then reported idle with error=null, the tile went green, the chat panel
    /// mounted a composer, and a delegated prompt was swallowed by that bash
    /// (`GHOST-DELEGATE-PROBE: command not found`) while the product claimed
    /// health. This pins the honest outcome instead.
    #[tokio::test]
    async fn a_restart_that_does_not_bring_the_agent_back_is_not_a_heal() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        native_row(&state, "ghost", "claude", "stopped").await;
        db::sessions::set_cc_conversation_id(&state.pool, "ghost", "conv-stale")
            .await
            .unwrap();
        let cc = with_transcript("/tmp", "conv-stale");
        reset_heal_state("ghost");
        // The detector's badge, exactly as `force_stopped_on_death` raises it.
        state.set_error("ghost", HOLDER_DIED.to_string(), "terminal died: panic".into());

        // The restart runs; the agent does not come up.
        HEAL_DRY_RUN_READY.store(false, std::sync::atomic::Ordering::Relaxed);
        let outcome = auto_heal(&state, "ghost", "panic: boom").await;
        HEAL_DRY_RUN_READY.store(true, std::sync::atomic::Ordering::Relaxed);

        assert_eq!(
            outcome,
            Heal::Failed,
            "a pane with no agent in it is not a recovered session",
        );
        assert_eq!(heal_attempts("ghost"), 1, "the restart was still attempted");

        let (kind, message) = state
            .session_activity("ghost")
            .and_then(|a| a.error)
            .expect("the terminal-died badge must SURVIVE a failed heal");
        assert_eq!(kind, HOLDER_DIED, "…as holder_died, so the Resume affordance shows");
        assert!(
            message.contains("resume failed") && message.contains("conv-stale"),
            "the badge must name what failed, got {message:?}",
        );
        assert!(
            heal_failed_pending("ghost"),
            "the latch must hold the badge against the next alive tick — a failed \
             resume leaves a LIVE bash prompt, so 'the terminal is alive' is true \
             and meaningless",
        );

        // REGRESSION (codex #5). `start` persists `active` the instant the pane
        // exists — the dry-run stub above mirrors that on the not-ready path — so a
        // failed heal that only restored the badge left the ROW reading `active`
        // (green tile, live board dot, and a seed the detector could settle to
        // `idle`). `Heal::Failed`'s contract is that the session stays stopped: the
        // status must be restored to `stopped`, not just the badge re-raised.
        let status = db::sessions::runtime(&state.pool, "ghost")
            .await
            .unwrap()
            .expect("runtime row")
            .last_status;
        assert_eq!(
            status, "stopped",
            "a failed heal must leave the row STOPPED, never the `active` a bare \
             start wrote before it knew the agent never came up",
        );

        // The agent coming back for real (or a human driving the ladder) releases it.
        clear_holder_death_badge(&state, "ghost");
        assert!(!heal_failed_pending("ghost"));
        assert!(state.session_activity("ghost").and_then(|a| a.error).is_none());

        reset_heal_state("ghost");
        drop_transcript(cc);
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// REGRESSION (codex #4). The old auto-heal probed `try_lock` and re-read
    /// status in a helper, DROPPED the lock, then called `start`, which
    /// re-acquired it — a TOCTOU window in which a user Stop/Resume could land and
    /// be silently undone by the restart. `start_if_stopped` re-reads status UNDER
    /// the very lock it will start under, so a change that arrives while it is
    /// waiting for the lock is seen: it bails `Superseded` rather than resurrect a
    /// session the owner just acted on. This drives that exact interleaving — a
    /// status flip performed WHILE the restart is blocked on the held lock.
    #[tokio::test]
    async fn start_if_stopped_honors_a_status_change_that_races_the_lock() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        native_row(&state, "raced", "claude", "stopped").await;

        // Stand in for an in-flight lifecycle op (a user Stop/Resume) that holds
        // the per-session lock — the same lock `start_if_stopped` must take.
        let lock = state.lock_for("raced");
        let guard = lock.lock().await;

        // The daemon decides to heal and calls the atomic start. It BLOCKS on the
        // lock we are holding, exactly where `start` would.
        let bg = {
            let state = state.clone();
            tokio::spawn(async move {
                crate::sessions::lifecycle::start_if_stopped(&state, "raced").await
            })
        };
        // Let the task park on the lock before we mutate under it.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // The racing user action lands: the row moves off `stopped`. Under the OLD
        // probe-then-separately-start design this happened AFTER the death-stamp
        // check and was lost; here the authoritative re-check is still to come.
        db::sessions::set_last_status(&state.pool, "raced", "active")
            .await
            .unwrap();

        // Release — `start_if_stopped` now takes the lock and re-reads status.
        drop(guard);

        let outcome = bg.await.unwrap().unwrap();
        assert_eq!(
            outcome,
            HealStart::Superseded,
            "the under-lock re-check must catch the racing change and refuse to \
             start — the user wins, no ghost is resurrected",
        );
        // Nothing was spawned: the precondition short-circuited before `start`.
        let status = db::sessions::runtime(&state.pool, "raced")
            .await
            .unwrap()
            .expect("runtime row")
            .last_status;
        assert_eq!(status, "active", "the user's state stands, untouched by the heal");

        reset_heal_state("raced");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A resume LINK is not a resumable CONVERSATION.
    ///
    /// The cheap guard that stops the ghost before a pane is even spawned: when
    /// the link is a bare conversation id, `claude --resume <id>` reads
    /// `<project>/<id>.jsonl` — no file, no resume, and a heal would hand the
    /// user a bash prompt wearing the session's name. An honest "Terminal died"
    /// card with a Resume button is strictly better than that.
    #[tokio::test]
    async fn a_conversation_id_with_no_transcript_is_not_a_resume_link() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        native_row(&state, "stale", "claude", "stopped").await;
        db::sessions::set_cc_conversation_id(&state.pool, "stale", "conv-gone")
            .await
            .unwrap();
        // A project dir that exists but does NOT hold this conversation — the
        // `/clear`-then-die case, and the stale-id case.
        let cc = with_transcript("/tmp", "some-other-conversation");
        reset_heal_state("stale");

        assert_eq!(
            auto_heal(&state, "stale", "panic: boom").await,
            Heal::Unsupported,
            "a link to a conversation that is not on disk must not earn a restart",
        );
        assert_eq!(heal_attempts("stale"), 0, "nothing was spawned");

        // Put the conversation where claude would look for it: now it heals.
        let proj = crate::sessions::resumable::project_dir_for("/tmp");
        std::fs::write(proj.join("conv-gone.jsonl"), b"{}\n").unwrap();
        reset_heal_state("stale");
        assert_eq!(
            auto_heal(&state, "stale", "panic: boom").await,
            Heal::Healed,
            "…and a link that still means something does",
        );

        reset_heal_state("stale");
        drop_transcript(cc);
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The two questions the auto-wake seam and the auto-heal ask are NOT the
    /// same question, and collapsing them either way is a bug.
    ///
    /// `heal_is_supported` refuses a claude row with no link at all: an
    /// automatic restart there is a FRESH session, which is not a recovery.
    /// `dead_resume_link` — what `lifecycle::send_harness_text`'s auto-wake
    /// consults — must NOT refuse that row: a first `/send` to a claude session
    /// that has never had a conversation is the ordinary case and loses nothing.
    /// Both must refuse the row that points at a transcript which is gone,
    /// because THAT restart hands the user a bash prompt wearing the session's
    /// name and eats whatever is typed next.
    #[tokio::test]
    async fn a_dead_link_is_refused_everywhere_but_a_missing_one_only_by_the_heal() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        native_row(&state, "fresh", "claude", "stopped").await;
        native_row(&state, "gone", "claude", "stopped").await;
        native_row(&state, "kept", "claude", "stopped").await;
        native_row(&state, "shelly", "shell", "stopped").await;
        for (name, conv) in [("gone", "conv-vanished"), ("kept", "conv-here")] {
            db::sessions::set_cc_conversation_id(&state.pool, name, conv).await.unwrap();
        }
        let cc = with_transcript("/tmp", "conv-here");

        let row = |n: &'static str| {
            let pool = state.pool.clone();
            async move { db::sessions::get(&pool, n).await.unwrap().unwrap() }
        };

        let fresh = row("fresh").await;
        assert_eq!(
            dead_resume_link(&fresh),
            None,
            "a claude row with no link at all is a first start, not a dead link",
        );
        assert!(!heal_is_supported(&fresh), "…but it is still not a HEAL");

        let gone = row("gone").await;
        assert_eq!(
            dead_resume_link(&gone),
            Some("conv-vanished"),
            "the seam must NAME the conversation that is no longer on disk",
        );
        assert!(!heal_is_supported(&gone));

        let kept = row("kept").await;
        assert_eq!(dead_resume_link(&kept), None, "a link with its transcript still there is live");
        assert!(heal_is_supported(&kept));

        let shelly = row("shelly").await;
        assert_eq!(dead_resume_link(&shelly), None, "non-claude rows own their own continuity");

        drop_transcript(cc);
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// THE LATCH RELEASE. `stamp_heal_failed` raises the honest
    /// `resume failed: <link>` badge and latches it against the detector's alive
    /// tick. That tick used to open the latch on `shell_is_foreground() ==
    /// Some(false)` — "a program owns the pty" — on the assumption that a failed
    /// resume always drops to bash.
    ///
    /// It does not. `claude --resume '<stale name>'` does not exit; it sits in
    /// claude's interactive Resume picker, which IS a program. So the release
    /// fired on the very next ~2 s tick and the badge never reached a single
    /// client: a 130 s poll of `GET /api/sessions/<n>` saw error=null from +7 s
    /// on. The release condition is now AGENT evidence, and these are the two
    /// captures that must be told apart.
    #[test]
    fn the_resume_picker_is_not_evidence_that_the_agent_came_back() {
        let picker = "\n Resume a conversation\n\n ❯ 1. fix the parser   2h ago\n   2. spike   3d ago\n";
        assert!(
            !crate::sessions::lifecycle::agent_at_the_wheel(picker),
            "the Resume picker draws ❯ and is a running program — it is not the agent \
             back at the wheel, and treating it as such is what wiped the badge",
        );

        let trust = "Do you trust the files in this folder?\n ❯ 1. Yes, I trust this folder\n";
        assert!(
            !crate::sessions::lifecycle::agent_at_the_wheel(trust),
            "the first-run trust gate is a program too, and nothing is at the wheel behind it",
        );

        assert!(
            crate::sessions::lifecycle::agent_at_the_wheel("╭─────╮\n│ > try \"fix\" │\n? for shortcuts"),
            "claude's own composer IS the evidence",
        );
        assert!(
            !crate::sessions::lifecycle::agent_at_the_wheel("user@host:~/work$ "),
            "and a bare shell prompt never was",
        );
    }

    /// …and the strict rule is scoped to the provider that needs it.
    ///
    /// A non-claude session's failed restart really does leave a shell, and a
    /// bash prompt is a screen no `agent_ui_visible` heuristic can match — so
    /// demanding agent evidence there would latch a badge nothing could ever
    /// clear, which is a worse bug than the one being fixed.
    #[tokio::test]
    async fn only_claude_latches_need_agent_evidence_to_release() {
        let (state, dir) = test_state().await;
        native_row(&state, "cc", "claude", "stopped").await;
        native_row(&state, "sh", "shell", "stopped").await;
        reset_heal_state("cc");
        reset_heal_state("sh");

        for name in ["cc", "sh"] {
            let s = db::sessions::get(&state.pool, name).await.unwrap().unwrap();
            stamp_heal_failed(&state, name, &s);
            assert!(heal_failed_pending(name), "the badge is latched either way");
        }
        assert!(agent_evidence_required("cc"), "the Resume-picker trap is claude's alone");
        assert!(
            !agent_evidence_required("sh"),
            "a shell session keeps the original 'a program owns the pty' release",
        );

        reset_heal_state("cc");
        reset_heal_state("sh");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// THE REAL THING. Every other heal test stops at the guard and returns
    /// through the dry-run hook, which proves the guards and nothing about the
    /// recovery. This one turns the hook OFF and drives an actual restart: a
    /// session whose holder died (crash marker, no live pid) goes through
    /// `auto_heal` → `lifecycle::start` → a REAL holder on a REAL pty, and comes
    /// out the other side attached, with an authoritative grid.
    #[tokio::test]
    async fn auto_heal_really_restarts_a_dead_session_end_to_end() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        // `stopped` + a crash marker is exactly what `force_stopped_on_death`
        // leaves behind before it spawns the heal.
        native_row(&state, "healme", "shell", "stopped").await;
        reset_heal_state("healme");
        let sdir = spool::session_dir(&dir, "healme");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(spool::spool_path(&sdir), b"the screen when it died").unwrap();
        spool::mark_exit_reason(&sdir, -1, "panic: injected");

        let rt = state.runtime_for("healme").await.unwrap();
        assert!(!rt.alive().await, "precondition: the session is dead");

        // Same rig as the orphan test: `start` execs `SUPERMUX_HOLDER_BIN`, and
        // a lib test has no `pty-holder` binary — so point it at a no-op and
        // stand the real holder up here the moment `spawn` clears the marker.
        std::env::set_var("SUPERMUX_HOLDER_BIN", "/bin/true");
        let hargs = crate::sessions::native::holder::Args {
            session: "healme".to_string(),
            dir: sdir.clone(),
            socket: spool::socket_path(&dir, "healme"),
            cols: 80,
            rows: 24,
            command: "sleep 300".to_string(),
        };
        let exit_marker = sdir.join("exit");
        let holder = tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(20);
            while Instant::now() < deadline && exit_marker.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let _ = crate::sessions::native::holder::run(hargs).await;
        });

        HEAL_DRY_RUN.store(false, std::sync::atomic::Ordering::Relaxed);
        let outcome = auto_heal(&state, "healme", "panic: injected").await;
        HEAL_DRY_RUN.store(true, std::sync::atomic::Ordering::Relaxed);

        assert_eq!(outcome, Heal::Healed, "the restart must actually have worked");
        assert_eq!(heal_attempts("healme"), 1);
        assert!(rt.alive().await, "the healed session must be serving again");
        assert!(
            rt.capture_is_authoritative().await,
            "a healed session's grid must be REAL — an attach that never happened, or a \
             delta the daemon had to reject, would leave it a blank placeholder",
        );
        let meta = spool::read_meta(&sdir).expect("the new holder wrote its sidecar");
        assert!(alive(meta.pid), "a live child on a real pty");

        // SAFETY: plain libc call; an already-reaped pid yields ESRCH.
        unsafe {
            libc::killpg(meta.pid as i32, libc::SIGKILL);
        }
        holder.abort();
        std::env::remove_var("SUPERMUX_HOLDER_BIN");
        reset_heal_state("healme");
        crate::sessions::native::forget("healme");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The user outranks the heal. Everything before the restart is `await`ed,
    /// and a person whose session just died reacts inside that window — so the
    /// state is re-read as late as possible and a session that has moved on (a
    /// Stop, a Resume, any lifecycle op holding the session lock) is left alone.
    #[tokio::test]
    async fn a_user_action_inside_the_heal_window_wins() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        native_row(&state, "raced", "shell", "stopped").await;

        // (a) The row moved off the death-stamped `stopped` — a Resume landed.
        reset_heal_state("raced");
        db::sessions::set_last_status(&state.pool, "raced", "active").await.unwrap();
        assert_eq!(
            auto_heal(&state, "raced", "panic: boom").await,
            Heal::Superseded,
            "a session that is running again must not be restarted under the user",
        );
        assert_eq!(heal_attempts("raced"), 0, "the restart path was never entered");

        // (b) The row still says stopped, but a lifecycle op holds the session
        //     lock — a Stop in flight, whose own write has not landed yet.
        reset_heal_state("raced");
        db::sessions::set_last_status(&state.pool, "raced", "stopped").await.unwrap();
        let lock = state.lock_for("raced");
        let guard = lock.lock().await;
        assert_eq!(
            auto_heal(&state, "raced", "panic: boom").await,
            Heal::Superseded,
            "a heal must never queue up behind the user's own Stop and undo it",
        );
        assert_eq!(heal_attempts("raced"), 0);
        drop(guard);

        // …and with nothing in the way it heals as before.
        reset_heal_state("raced");
        assert_eq!(auto_heal(&state, "raced", "panic: boom").await, Heal::Healed);

        reset_heal_state("raced");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The audit must not judge — or heal — a session that is MID-START. Its
    /// holder is the thing the running `start` is busy spawning, so "not
    /// attached" says nothing, and healing it would block on the very lock that
    /// start holds and then start the session a second time behind it.
    #[tokio::test]
    async fn the_audit_skips_a_session_that_is_mid_start() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        native_row(&state, "starting-up", "shell", "starting").await;
        native_row(&state, "locked-up", "shell", "stopped").await;
        reset_heal_state("starting-up");
        reset_heal_state("locked-up");

        // One is mid-start by its ROW, the other by holding the session lock.
        let lock = state.lock_for("locked-up");
        let guard = lock.lock().await;
        let targets = vec![
            AuditTarget { name: "starting-up".into(), was: "starting".into() },
            AuditTarget { name: "locked-up".into(), was: "active".into() },
        ];
        assert_eq!(
            post_update_audit(&state, &targets).await,
            AuditSummary { checked: 2, skipped: 2, ..Default::default() },
            "a start in flight is not a failed re-attach",
        );
        assert_eq!(heal_attempts("starting-up"), 0);
        assert_eq!(heal_attempts("locked-up"), 0);
        drop(guard);

        reset_heal_state("starting-up");
        reset_heal_state("locked-up");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The audit's target list is taken BEFORE the boot reconcile rewrites
    /// statuses, and covers only the sessions that owe us a re-attach: native,
    /// local, and running at shutdown.
    #[tokio::test]
    async fn the_audit_snapshot_only_takes_running_native_local_sessions() {
        let (state, dir) = test_state().await;
        native_row(&state, "was-active", "claude", "active").await;
        native_row(&state, "was-waiting", "claude", "waiting").await;
        native_row(&state, "was-stopped", "claude", "stopped").await;
        native_row(&state, "was-tmux", "claude", "active").await;
        db::sessions::set_runtime(&state.pool, "was-tmux", "tmux").await.unwrap();

        let mut names: Vec<String> = snapshot_for_audit(&state)
            .await
            .into_iter()
            .map(|t| t.name)
            .collect();
        names.sort();
        assert_eq!(names, ["was-active", "was-waiting"]);

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The audit's verdict + the single summary line every update must leave
    /// behind: one session that came back on its own, one that did not and was
    /// healed, one that did not and could not be (claude, no resume link).
    #[tokio::test]
    async fn the_audit_counts_reattached_healed_and_failed() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        native_row(&state, "audit-up", "claude", "active").await;
        native_row(&state, "audit-heal", "claude", "active").await;
        db::sessions::set_cc_conversation_id(&state.pool, "audit-heal", "conv-9")
            .await
            .unwrap();
        // `audit-heal` is the one that CAN be restored: its conversation is on
        // disk. `audit-lost` has no link at all and stays unrestorable.
        let cc = with_transcript("/tmp", "conv-9");
        native_row(&state, "audit-lost", "claude", "active").await;
        reset_heal_state("audit-heal");
        reset_heal_state("audit-lost");

        // `audit-up` has a holder that probes ALIVE (our own pid, honest
        // sidecar) — the deploy-survival case the audit must pass silently.
        let sdir = spool::session_dir(&dir, "audit-up");
        std::fs::create_dir_all(&sdir).unwrap();
        let me = std::process::id();
        spool::write_meta(
            &sdir,
            &spool::Meta {
                session: "audit-up".into(),
                pid: me,
                cols: 80,
                rows: 24,
                started_at: crate::sessions::native::runtime::proc_start_unix(me).unwrap_or(0),
                command: "claude".into(),
            },
        )
        .unwrap();
        spool::clear_exit(&sdir);
        // The other two left an exit marker with a reason — the WARN's source.
        for name in ["audit-heal", "audit-lost"] {
            let sdir = spool::session_dir(&dir, name);
            std::fs::create_dir_all(&sdir).unwrap();
            spool::mark_exit_reason(&sdir, -1, "panic: attempt to subtract with overflow");
        }
        assert_eq!(
            crate::sessions::native::death_reason("audit-heal", &dir).as_deref(),
            Some("panic: attempt to subtract with overflow"),
            "the WARN must be able to name the reason the holder recorded",
        );

        let targets = snapshot_for_audit(&state).await;
        assert_eq!(targets.len(), 3);
        // The snapshot is taken BEFORE `reconcile_on_boot`; by the time the
        // audit runs, the reconcile has stamped every dead session `stopped`.
        // Reproduce that here, because the heal refuses to restart a session
        // whose row is anything else (a user Stop inside the window wins).
        for name in ["audit-heal", "audit-lost"] {
            db::sessions::set_last_status(&state.pool, name, "stopped").await.unwrap();
        }
        let summary = post_update_audit(&state, &targets).await;

        assert_eq!(
            summary,
            AuditSummary {
                checked: 3,
                reattached: 1,
                healed: 1,
                failed: 1,
                skipped: 0,
            },
        );
        assert_eq!(heal_attempts("audit-heal"), 1, "the lost session was restarted");
        assert_eq!(heal_attempts("audit-lost"), 0, "…the unrestorable one was not");

        // Always ONE line, even with nothing to check.
        assert_eq!(
            post_update_audit(&state, &[]).await,
            AuditSummary::default(),
            "an empty audit still runs and still reports",
        );

        reset_heal_state("audit-heal");
        reset_heal_state("audit-lost");
        drop_transcript(cc);
        crate::sessions::native::forget("audit-up");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

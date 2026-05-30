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
//!   └─ if status changed OR tail6 changed:
//!          SSE  { type:'sessions', payload:{delta:[{name,status?,preview_lines?}]} }
//! ```
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

    // ── LOCAL tmux→DB ADOPTION pass (orphan recovery) ─────────────────────────
    // The pass above is DB→tmux (mark dead rows stopped). The INVERSE — a LIVE
    // local `supermux-*` tmux pane with NO DB row — was previously ignored, so a
    // running agent whose row was lost (a renamed/deleted row while the agent kept
    // running, OR the server coming back against a different data.db across the
    // restarts that happen during self-deploy) became a permanent ORPHAN: it
    // burned CPU forever, invisible to the UI and impossible to stop from it. This
    // is exactly the "all sessions dead in the UI while ~10 claude agents peg the
    // box" failure. We RE-ADOPT such panes: insert a minimal session row + runtime
    // (fresh hook token) so the normal machinery picks them up — `spawn_all`
    // (called right after this in main) starts a status loop for every DB row, and
    // the detector re-arms pipe-pane on first WS connect. Purely additive: we only
    // CREATE links, never kill a pane. Best-effort — one bad pane never aborts boot.
    let db_names: std::collections::HashSet<String> =
        sessions.iter().map(|s| s.name.clone()).collect();
    match super::tmux::list_local_supermux_sessions().await {
        Ok(live) => {
            for (bare, dir) in live {
                if db_names.contains(&bare) {
                    continue; // already tracked
                }
                // Guard: only adopt names that are valid supermux slugs, and skip
                // the internal `paste-*` buffer-session artifact (a transient
                // helper session, never a real agent — see Tmux::paste_via_buffer).
                if !super::valid_name(&bare) || bare.starts_with("paste-") {
                    continue;
                }
                let dir = if dir.is_empty() { "/".to_string() } else { dir };
                // Adopted as a `claude` session (the only provider supermux spawns
                // as a long-lived pane); `creator="adopted"` records the provenance
                // so the row is distinguishable from a user-created one.
                if let Err(e) =
                    db::sessions::insert_adopted(&state.pool, &bare, &dir, "claude").await
                {
                    tracing::warn!(name = %bare, error = %e, "orphan adopt: insert_adopted failed");
                    continue;
                }
                let hook_token = super::gen_hook_token();
                if let Err(e) =
                    db::sessions::ensure_runtime(&state.pool, &bare, &hook_token).await
                {
                    tracing::warn!(name = %bare, error = %e, "orphan adopt: ensure_runtime failed");
                    continue;
                }
                state.hook_tokens.insert(bare.clone(), hook_token);
                // Leave status at its default — the status loop spawned by
                // `spawn_all` will classify it (Active/Idle/Waiting) on its first
                // tick from a real capture.
                tracing::info!(name = %bare, dir = %dir, "orphan adopt: re-linked live tmux pane → DB");
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "orphan adopt: list_local_supermux_sessions failed");
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
        let mut detector = StatusDetector::new();
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
    if status::should_skip_capture_within(last_pty, held, last_capture_at.elapsed(), tier) {
        return Ok(held);
    }

    let tmux = Tmux::new(name);
    if !tmux.exists().await.unwrap_or(false) {
        // Not running: the detector cannot capture. Leave the status untouched —
        // a never-started session stays Unknown (API renders 'stopped'), and the
        // explicit 'Any → Stopped' transition + side-effects on tmux death are a
        // separate auto-actions concern deferred past the current core.
        return Ok(held);
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
    let raw_ansi = tmux.capture_pane_ansi(status::CAPTURE_LINES).await?;
    // Stamp the capture time the moment a shell-out succeeds so the per-tier skip
    // bound (status::cadence_for) measures from the last REAL capture.
    *last_capture_at = Instant::now();
    let capture = status::prepare_capture(&raw_ansi);
    let capture_ansi = status::prepare_capture_ansi(&raw_ansi);

    // Whether this session's Claude hooks are live (we have seen ≥1 hook POST).
    // A hooked session is authoritative off the turn state machine + content bank,
    // so the detector suppresses the raw heartbeat `Active` fallback for it —
    // typing at the prompt echoes bytes but must not flip the card to busy.
    let has_hooks = state.has_hooks(name);
    let prev = detector.last_status();
    let new_status = detector.detect(&capture, last_pty, turn, has_hooks);

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
pub fn maybe_push_on_transition(state: &AppState, name: &str, new: Status) {
    use crate::db::push::NotifCategory;
    let cat = match new {
        Status::Waiting => NotifCategory::AgentWaiting,
        Status::Idle => NotifCategory::AgentFinished,
        Status::Stopped => NotifCategory::AgentStopped,
        _ => return,
    };

    // Two timers: the default 2s quiet window handles the bootup flurry; a
    // longer 15s window is used ONLY for "agent finished" on a team-tagged
    // session, where the lead can legitimately bounce in and out of Idle every
    // few seconds while it dispatches teammates. The longer window holds the
    // ping until the lead has been idle long enough that the team is actually
    // done. Waiting and Stopped keep the short window even on team leads —
    // those are unambiguous "you need to act" signals and shouldn't be delayed.
    const T_DEFAULT: Duration = Duration::from_secs(2);
    const T_TEAM_FINISH: Duration = Duration::from_secs(15);

    // Cancel any prior pending send for this session FIRST, then install the
    // new task. Using `remove` (rather than `insert` + checking the return)
    // lets us abort the prior handle before the new one is even spawned —
    // there's no detector-loop concurrency for a single session, so no thread
    // can squeeze a second insert in between.
    if let Some((_, prev)) = state.pending_pushes.remove(name) {
        prev.abort();
    }

    let task_state = state.clone();
    let task_name = name.to_string();
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
            Ok(Some(rt)) => matches!(
                (cat, rt.last_status.as_str()),
                (NotifCategory::AgentWaiting, "waiting")
                    | (NotifCategory::AgentFinished, "idle")
                    | (NotifCategory::AgentStopped, "stopped"),
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
        let n = crate::push::send_push_for(&task_state, cat, &title, &body, &url).await;
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
    // `tokio::time::sleep(delay).await` with `delay >= 2s`, so it cannot reach
    // its `pending_pushes.remove(...)` bookkeeping until well after the insert
    // below has completed on the calling task. Stale-slot scenarios are
    // therefore unreachable as long as both `T_DEFAULT` and `T_TEAM_FINISH`
    // stay well above scheduler-poll latency.
    state.pending_pushes.insert(name.to_string(), handle.abort_handle());
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
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
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

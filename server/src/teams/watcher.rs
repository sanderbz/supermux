//! Agent-Teams watcher loop (AT-B §3.2): keeps the live [`Team`] snapshot fresh
//! and broadcasts it over the existing SSE channel.
//!
//! **Why both a watcher AND a slow safety poll (§3 / §8).** FSEvents can be
//! missed (debounced, dropped under churn) and the experimental Claude schema
//! WILL drift; a slow unconditional re-scan guarantees the snapshot self-heals.
//! When the `notify` crate is available we wake on `~/.claude/teams` changes for
//! sub-second freshness; the periodic tick runs regardless.
//!
//! **`%id` validation EVERY tick (§3.2).** tmux pane ids are a server-global
//! reused counter, so config.json's `tmuxPaneId` is re-read and re-validated
//! against the lead window's live panes on every tick — never cached across
//! ticks. A `%id` absent from the live set is dropped immediately. We also use
//! the live-pane scan to MAP a team to the supermux session hosting its lead:
//! whichever `supermux-<name>` window contains the team's member panes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use crate::db;
use crate::sessions::tmux::Tmux;
use crate::state::{AppState, SseEvent};

use super::model::Team;
use super::scan;

/// Slow safety re-scan cadence. Tolerates missed FSEvents + schema drift; cheap
/// (a directory walk + a few `tmux list-panes`), so 3s is comfortable.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Debounce window after an FS event before re-scanning, so a burst of writes
/// (config + N task files + inboxes during a team spin-up) collapses to one scan.
const FS_DEBOUNCE: Duration = Duration::from_millis(400);

/// Spawn the teams watcher (fire-and-forget). Idempotent to call once at boot.
/// Does NOT gate on the `experimental.agent_teams` setting: the on-disk files
/// exist (and should be surfaced) whenever Claude wrote them; the setting only
/// controls whether supermux ENABLES the feature for new sessions (§3.1). When
/// no team files exist, each tick is a cheap empty scan and broadcasts nothing.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        // Best-effort FS watcher; the poll loop runs regardless of whether it
        // arms successfully (e.g. the teams dir doesn't exist yet).
        let fs_wake = Arc::new(Notify::new());
        let _watcher = arm_fs_watcher(fs_wake.clone());

        let mut last_payload: Option<serde_json::Value> = None;
        let mut tick = tokio::time::interval(POLL_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            // Wake on either the slow poll OR an FS event (debounced).
            tokio::select! {
                _ = tick.tick() => {}
                _ = fs_wake.notified() => {
                    tokio::time::sleep(FS_DEBOUNCE).await;
                }
            }

            let teams = scan_and_enrich(&state).await;
            let payload = serde_json::to_value(&teams).unwrap_or(serde_json::Value::Null);

            // Change-only broadcast (keep it cheap — spec §4 cadence rule). The
            // first non-empty scan always publishes; thereafter only on a diff.
            if last_payload.as_ref() != Some(&payload) {
                let _ = state.sse_tx.send(SseEvent {
                    event: "teams".to_string(),
                    payload: payload.clone(),
                });
                last_payload = Some(payload);
            }
        }
    });
}

/// Scan the on-disk team files, then enrich each team with live tmux truth:
/// validate every member `%id` against the lead window's live panes and map the
/// team to the supermux session hosting its lead. The public single-shot used by
/// both the watcher tick and `GET /api/teams`.
pub async fn scan_and_enrich(state: &AppState) -> Vec<Team> {
    let mut teams = scan::scan_teams(&scan::claude_config_dir());
    if teams.is_empty() {
        return teams;
    }

    // Build `supermux-<name> → live pane ids` ONCE per tick for the live claude
    // sessions, so a team's panes can be located + validated against the right
    // window. We never cache this across ticks (the whole point of §3.2).
    let pane_map = live_pane_map(state).await;

    for team in &mut teams {
        // Find which supermux window owns this team's member panes. The lead's
        // own pane + the teammate panes all live in ONE window (the lead's), so
        // the session whose live pane set contains the most of our members is the
        // host. This is the robust team→lead map (cwd/leadSessionId are softer).
        let host = host_session_for(team, &pane_map);
        let live_ids: &[String] = host
            .as_deref()
            .and_then(|h| pane_map.get(h))
            .map(Vec::as_slice)
            .unwrap_or(&[]);

        // §3.2: re-validate every `%id` against the host's live panes THIS tick.
        scan::validate_pane_ids(team, live_ids);
        scan::map_lead_session(team, |_| host.clone());
    }

    teams
}

/// The supermux session whose live pane set best contains `team`'s member panes.
/// `None` when no candidate window contains any of them (e.g. an orphaned team,
/// or panes that churned this tick).
fn host_session_for(team: &Team, pane_map: &HashMap<String, Vec<String>>) -> Option<String> {
    let member_panes: Vec<&str> = team
        .members
        .iter()
        .filter_map(|m| m.tmux_pane_id.as_deref())
        .collect();
    if member_panes.is_empty() {
        return None;
    }
    let mut best: Option<(String, usize)> = None;
    for (sess, panes) in pane_map {
        let hits = member_panes.iter().filter(|id| panes.iter().any(|p| p == *id)).count();
        if hits == 0 {
            continue;
        }
        match &best {
            Some((_, b)) if *b >= hits => {}
            _ => best = Some((sess.clone(), hits)),
        }
    }
    best.map(|(s, _)| s)
}

/// Map every live (tmux-present) supermux session to its window's pane ids. Only
/// `supermux-<name>` sessions are consulted (the team panes live inside one).
/// Best-effort: a session whose `list-panes` fails is skipped.
async fn live_pane_map(state: &AppState) -> HashMap<String, Vec<String>> {
    let mut map = HashMap::new();
    let sessions = match db::sessions::list(&state.pool).await {
        Ok(s) => s,
        Err(e) => {
            tracing::debug!(error = %e, "teams watcher: session list failed; no pane validation this tick");
            return map;
        }
    };
    for s in sessions {
        // Teams are Claude-only; skip shell/codex hosts.
        if s.provider != "claude" {
            continue;
        }
        let tmux = Tmux::new(&s.name);
        if let Ok(ids) = tmux.list_pane_ids().await {
            if !ids.is_empty() {
                map.insert(s.name, ids);
            }
        }
    }
    map
}

/// Arm a best-effort `notify` recursive watcher on `~/.claude/teams`, pinging
/// `wake` on any change. Returns the watcher handle (kept alive by the caller);
/// `None` when it could not be armed (dir absent / platform error) — the slow
/// poll then carries the load. The watch is intentionally coarse (the whole
/// teams subtree); precise event routing isn't needed since the tick re-scans.
fn arm_fs_watcher(wake: Arc<Notify>) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};

    let teams = scan::teams_dir();
    // Watch the PARENT (`~/.claude`) too so the first-ever creation of the
    // `teams/` dir is caught even though it doesn't exist yet at boot.
    let root = scan::claude_config_dir();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            wake.notify_one();
        }
    })
    .ok()?;

    // Ensure the root exists so the watch can attach (don't fail if it can't).
    let _ = std::fs::create_dir_all(&root);
    let mut armed = false;
    if watcher.watch(&root, RecursiveMode::Recursive).is_ok() {
        armed = true;
    }
    // Also explicitly watch the teams dir if it already exists (belt + braces).
    if teams.exists() {
        let _ = watcher.watch(&teams, RecursiveMode::Recursive);
        armed = true;
    }
    if armed {
        Some(watcher)
    } else {
        tracing::debug!("teams FS watcher could not arm; falling back to slow poll only");
        None
    }
}

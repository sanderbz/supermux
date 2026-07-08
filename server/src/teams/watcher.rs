//! Agent-Teams watcher loop: keeps the live [`Team`] snapshot fresh
//! and broadcasts it over the existing SSE channel.
//!
//! **Why both a watcher AND a slow safety poll.** FSEvents can be
//! missed (debounced, dropped under churn) and the experimental Claude schema
//! WILL drift; a slow unconditional re-scan guarantees the snapshot self-heals.
//! When the `notify` crate is available we wake on `~/.claude/teams` changes for
//! sub-second freshness; the periodic tick runs regardless.
//!
//! **`%id` validation EVERY tick.** tmux pane ids are a server-global
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

use super::model::{MemberStatus, Team};
use super::scan;

/// Slow safety re-scan cadence. Tolerates missed FSEvents + schema drift; cheap
/// (a directory walk + a few `tmux list-panes`), so 3s is comfortable.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Debounce window after an FS event before re-scanning, so a burst of writes
/// (config + N task files + inboxes during a team spin-up) collapses to one scan.
const FS_DEBOUNCE: Duration = Duration::from_millis(400);

/// How many CONSECUTIVE ticks a previously-detected team must be absent before
/// supermux deregisters its board. FSEvents can be dropped and a
/// half-written `config.json` can momentarily fail to parse — a team that
/// flickers absent for a tick or two is almost certainly a transient glitch, not
/// an ended team. Only after `DEREGISTER_AFTER_ABSENT_TICKS` straight misses (≈
/// `POLL_INTERVAL` × this) do we tear the board down (a CASCADE delete of its
/// cards), so the policy is conservative against a missed event.
const DEREGISTER_AFTER_ABSENT_TICKS: u32 = 3;

/// Spawn the teams watcher (fire-and-forget). Idempotent to call once at boot.
/// Does NOT gate on the `experimental.agent_teams` setting: the on-disk files
/// exist (and should be surfaced) whenever Claude wrote them; the setting only
/// controls whether supermux ENABLES the feature for new sessions. When
/// no team files exist, each tick is a cheap empty scan and broadcasts nothing.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        // Best-effort FS watcher; the poll loop runs regardless of whether it
        // arms successfully (e.g. the teams dir doesn't exist yet).
        let fs_wake = Arc::new(Notify::new());
        let _watcher = arm_fs_watcher(fs_wake.clone());

        let mut last_payload: Option<serde_json::Value> = None;
        // Deregister safety: per team, how many CONSECUTIVE ticks it has been
        // absent from the detected set. Reset to 0 the instant a team reappears;
        // a team is only torn down after DEREGISTER_AFTER_ABSENT_TICKS straight
        // misses (guards against a transient FS glitch / missed FSEvents).
        let mut absent_ticks: HashMap<String, u32> = HashMap::new();
        let mut tick = tokio::time::interval(POLL_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            // Wake on the slow poll, an FS event (debounced), OR an explicit
            // wake from lifecycle::archive/unarchive (a lead's archived flag
            // flipping is invisible to the FS watch, so without this wake the
            // overview would lag up to 30s before the team disappears).
            tokio::select! {
                _ = tick.tick() => {}
                _ = fs_wake.notified() => {
                    tokio::time::sleep(FS_DEBOUNCE).await;
                }
                _ = state.teams_wake.notified() => {}
            }

            let teams = scan_and_enrich(&state).await;
            let payload = serde_json::to_value(&teams).unwrap_or(serde_json::Value::Null);

            // Wire the detected teams onto their OWN boards: register each
            // team's board idempotently + mirror its on-disk tasks as cards, then
            // (conservatively) deregister boards whose team has ended. Runs every
            // tick regardless of the SSE change-detection below (a team's task
            // files can change without the `teams` DTO diffing — e.g. a task
            // description edit doesn't alter member status — so the board must
            // reconcile independently). Defensive: each team's reconcile swallows
            // its own errors; one bad team never blocks the rest or the broadcast.
            let mut board_changed = false;
            for team in &teams {
                board_changed |= super::board_sync::reconcile_team(&state, team).await;
            }
            board_changed |=
                reconcile_deregistrations(&state, &teams, &mut absent_ticks).await;
            if board_changed {
                crate::board::emit_board(&state).await;
            }

            // Change-only broadcast (keep it cheap). The
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
    // window. We never cache this across ticks (the whole point of pane-id reuse).
    let pane_map = live_pane_map(state).await;

    for team in &mut teams {
        // Map team → supermux session via a multi-key resolver that tolerates
        // the (common) state where no teammate has a tmuxPaneId yet: lead just
        // booted but hasn't invoked Spawn, in-process teammates, half-written
        // config.json mid-write, transient pane churn between watcher ticks.
        // Pane-id intersection (the docstring's original promise) is
        // kept as the strongest signal AND the final fallback.
        let host = resolve_host_session(state, team, &pane_map).await;

        let live_ids: &[String] = host
            .as_deref()
            .and_then(|h| pane_map.get(h))
            .map(Vec::as_slice)
            .unwrap_or(&[]);

        // Re-validate every `%id` against the host's live panes THIS tick.
        scan::validate_pane_ids(team, live_ids);
        scan::map_lead_session(team, |_| host.clone());

        // Drop any member the user has dismissed (supermux-side hide). Loaded
        // ONCE per team per tick (small table). Unconditional, regardless of
        // live/offline, so a live-case removal (kill pane THEN dismiss) sticks
        // across the tick before the killed pane fully leaves the live set.
        // See [`crate::db::teams_dismissed`] for the no-auto-rearm limitation.
        match db::teams_dismissed::list_for_team(&state.pool, &team.team_name).await {
            Ok(dismissed) => retain_undismissed(team, &dismissed),
            Err(e) => {
                tracing::debug!(
                    error = %e,
                    team = %team.team_name,
                    "teams watcher: dismissed-set load failed; showing all members this tick",
                );
            }
        }

        // Persist the team_name backlink on the host session so
        // `lifecycle::archive` knows which `~/.claude/teams/<name>/` dir to
        // park in `.archived/` when the user archives the session. Only fires
        // when host resolved AND the value would change (cheap dedupe avoids
        // an UPDATE-per-tick on a steady-state team).
        if let Some(host_name) = host.as_deref() {
            persist_team_name(state, host_name, &team.team_name).await;
        }
    }

    // Post-process the whole set (pure, order matters): (1) hide lead-only teams
    // whose roster is empty after the lead-filter + dismiss-filter — a solo
    // session is not a team and already renders as a plain tile; THEN (2) collapse
    // duplicate host mappings so at most one team card points at any given
    // supermux session (orphaned `session-<uuid>` dirs from restarts all cwd-match
    // the one live session — without this they triple the card). Empty-roster drop
    // runs FIRST so those orphans are gone before dedup even looks at hosts.
    let teams = drop_rosterless(teams);
    dedup_by_host(teams)
}

/// Drop every team whose roster is EMPTY (fix 1). After the per-team loop has
/// filtered out the lead entry (`scan_one_team`) and the user's dismissed members
/// (`retain_undismissed`), a team with no members left is a solo session, not a
/// team — it already renders as a normal SessionTile, so surfacing it as a team
/// card is the lead-only-orphan duplicate. Pure over `Vec<Team>` (unit-testable).
fn drop_rosterless(teams: Vec<Team>) -> Vec<Team> {
    teams.into_iter().filter(|t| !t.members.is_empty()).collect()
}

/// Enforce "at most one team per host session" (fix 2). When 2+ teams resolved to
/// the SAME `Some(lead_supermux_session)`, keep the winner and drop the rest;
/// teams with host `None` are never dropped. Pure over `Vec<Team>`.
///
/// Winner = the max of [`dedup_rank_key`]: most live members, then most members
/// total, then newest `created_at`, then lexically smallest `team_name`. The last
/// tier makes the choice fully deterministic (no true ties between distinct teams).
fn dedup_by_host(teams: Vec<Team>) -> Vec<Team> {
    use std::collections::HashMap;

    // First pass: the winning index for each resolved host (None hosts ignored).
    let mut winner: HashMap<String, usize> = HashMap::new();
    for (i, t) in teams.iter().enumerate() {
        let Some(host) = t.lead_supermux_session.clone() else {
            continue;
        };
        let replace = match winner.get(&host) {
            Some(&best) => dedup_rank_key(t) > dedup_rank_key(&teams[best]),
            None => true,
        };
        if replace {
            winner.insert(host, i);
        }
    }

    // Second pass: keep host=None teams and the per-host winners only.
    teams
        .into_iter()
        .enumerate()
        .filter(|(i, t)| match t.lead_supermux_session.as_deref() {
            None => true,
            Some(host) => winner.get(host) == Some(i),
        })
        .map(|(_, t)| t)
        .collect()
}

/// A team's LIVE member count (status != Offline). A real team with live
/// teammates beats an empty/dead orphan in the host-dedup tiebreak.
fn live_member_count(team: &Team) -> usize {
    team.members
        .iter()
        .filter(|m| m.status != MemberStatus::Offline)
        .count()
}

/// The host-dedup ranking key — HIGHER is better, so the winner is the max.
/// Tiebreak chain (best first): most live members, then most members total, then
/// newest `created_at`, then lexically smallest `team_name` (wrapped in
/// [`std::cmp::Reverse`] so a smaller name yields a LARGER key).
fn dedup_rank_key(team: &Team) -> (usize, usize, i64, std::cmp::Reverse<String>) {
    (
        live_member_count(team),
        team.members.len(),
        team.created_at,
        std::cmp::Reverse(team.team_name.clone()),
    )
}

/// Drop every member the user has dismissed (supermux-side hide). Pure, so the
/// filter policy is unit-testable apart from the DB. Unconditional, regardless
/// of a member's live/offline state, so the live-case removal (kill pane THEN
/// dismiss) sticks across the tick before the killed pane leaves the live set.
/// A no-op when `dismissed` is empty.
fn retain_undismissed(team: &mut Team, dismissed: &[String]) {
    if dismissed.is_empty() {
        return;
    }
    team.members
        .retain(|m| !dismissed.iter().any(|d| d == &m.agent_id));
}

/// Cheap-deduped UPDATE: only fire when the session's current team_name
/// differs from the team we just mapped to it. A DB error is logged at debug
/// and swallowed — the cleanup-on-archive degrades to "leaves a stale config
/// behind" (the previous-band-aid worst case), never to a broken tick.
async fn persist_team_name(state: &AppState, session_name: &str, team_name: &str) {
    match db::sessions::team_name(&state.pool, session_name).await {
        Ok(Some(cur)) if cur == team_name => return,
        Ok(_) => {}
        Err(e) => {
            tracing::debug!(error = %e, session = %session_name, "teams watcher: read team_name failed");
            return;
        }
    }
    if let Err(e) = db::sessions::set_team_name(&state.pool, session_name, Some(team_name)).await {
        tracing::debug!(
            error = %e,
            session = %session_name,
            team = %team_name,
            "teams watcher: persist team_name failed",
        );
    }
}

/// Resolve a team's host supermux session, trying cheapest signals first so the
/// mapping survives transient teammate-pane churn AND the new-team window before
/// any teammate is spawned. Order:
///   (1) `leadSessionId` as a supermux name — a cheap O(1) fast path, but
///       Claude Code assigns its OWN session UUID here (FIX-TEAMS ground truth:
///       viral-news-hunt), so this rarely fires; the live-map presence check
///       means a non-matching UUID just falls through.
///   (2) `team_name` as a supermux name — another cheap fast path. As of Claude
///       Code v2.1.178 the team is auto-named `session-<id8>` (it's the session's
///       single implicit team — supermux no longer picks the name), so this too
///       essentially never matches a supermux session name and falls through.
///       Kept only because it's a free hashmap probe that would still win if a
///       future Claude build ever named a team after its host.
///   (3) Pane-id intersection — THE authoritative signal once teammates have
///       spawned: for any teammate `%id` live in the roster, find the supermux
///       session whose window contains it. Does NOT depend on `leadSessionId` or
///       the team name matching anything (the FIX-TEAMS bug 2 case, and what
///       makes the v2.1.178 auto-naming a non-issue for detection).
///   (4) Canonical-cwd match — last resort: a member's `cwd` matching a live
///       Claude DB session's `dir` (handles the moment when teammates exist on
///       disk but their panes haven't shown up in tmux yet, e.g. mid-spawn).
async fn resolve_host_session(
    state: &AppState,
    team: &Team,
    pane_map: &HashMap<String, Vec<String>>,
) -> Option<String> {
    // (1) leadSessionId-as-supermux-name. Trust if present in the live map.
    let lead_id = team.lead_session.trim();
    if !lead_id.is_empty() && pane_map.contains_key(lead_id) {
        return Some(lead_id.to_string());
    }
    // (2) team_name-as-supermux-name.
    if pane_map.contains_key(&team.team_name) {
        return Some(team.team_name.clone());
    }
    // (3) Pane-id intersection — the FIX-TEAMS bug 2 fix path. When the lead's
    //     `leadSessionId` is a Claude UUID (NOT the supermux name) and the
    //     team-name doesn't match a live session either, we still have a strong
    //     signal: any teammate `%id` from config that is actually present in
    //     some live `supermux-*` window IS the host. Locates the host without
    //     trusting the lead-id key at all.
    if let Some(host) = host_session_for(team, pane_map) {
        return Some(host);
    }
    // (4) Canonical-cwd match. A member's `cwd` (raw from config.json) matched
    //     against the live Claude sessions' `dir` — the lead's working directory
    //     IS the team's working directory, so the supermux session whose `dir`
    //     equals a teammate's cwd is the host. Last resort because it scans the
    //     session list (cheap, but later than the in-pane-map checks above).
    cwd_match_session(state, team).await
}

/// Find a live Claude session whose `dir` matches the team's authoritative host
/// cwd. Used as the final host-session fallback when neither `leadSessionId`, the
/// team-name, nor pane-id intersection resolves. A thin DB wrapper over the pure
/// [`match_host_by_cwd`]: a DB error or no match yields `None` — the team is then
/// surfaced as unmapped (a calm UI state, never wrong).
async fn cwd_match_session(state: &AppState, team: &Team) -> Option<String> {
    let sessions = match db::sessions::list(&state.pool).await {
        Ok(s) => s,
        Err(e) => {
            tracing::debug!(error = %e, "teams watcher: cwd-match session list failed");
            return None;
        }
    };
    match_host_by_cwd(
        team,
        sessions
            .iter()
            .map(|s| (s.name.as_str(), s.dir.as_str(), s.provider.as_str())),
    )
}

/// Pure cwd→session matcher (no DB), so the host-attribution policy is unit
/// testable. Given the live sessions as `(name, dir, provider)` triples, return
/// the first `provider == "claude"` session whose `dir` equals the team's host
/// cwd.
///
/// **The lead's cwd is authoritative.** We match on `team.lead_cwd` FIRST — it is
/// the team's true working directory. Only when it is empty (an in-process lead,
/// or a drifted config with no lead cwd) do we fall back to the pre-fix behavior
/// of scanning the teammates' cwds. A teammate can legitimately work in a
/// worktree/subdir that collides with an UNRELATED session's dir, so a teammate
/// cwd must never win host attribution over the lead's own cwd.
///
/// Normalization matches the rest of the resolver: trailing `/` stripped,
/// case-insensitive compare.
fn match_host_by_cwd<'a>(
    team: &Team,
    sessions: impl Iterator<Item = (&'a str, &'a str, &'a str)>,
) -> Option<String> {
    // Authoritative candidate: the lead's own cwd. Fall back to the unique
    // non-empty teammate cwds ONLY when the lead cwd is unknown.
    let lead = team.lead_cwd.trim();
    let candidates: Vec<String> = if !lead.is_empty() {
        vec![lead.trim_end_matches('/').to_string()]
    } else {
        let mut cwds: Vec<String> = team
            .members
            .iter()
            .map(|m| m.cwd.trim())
            .filter(|c| !c.is_empty())
            .map(|c| c.trim_end_matches('/').to_string())
            .collect();
        cwds.sort();
        cwds.dedup();
        cwds
    };
    if candidates.is_empty() {
        return None;
    }
    for (name, dir, provider) in sessions {
        if provider != "claude" {
            continue;
        }
        let s_dir = dir.trim_end_matches('/');
        if s_dir.is_empty() {
            continue;
        }
        if candidates.iter().any(|c| c.eq_ignore_ascii_case(s_dir)) {
            return Some(name.to_string());
        }
    }
    None
}

/// Tear down team boards whose team has ENDED, conservatively. For
/// every `kind='team'` board in the DB whose `team_name` is NOT in this tick's
/// detected set, bump a per-team consecutive-absence counter; once a team has
/// been absent for [`DEREGISTER_AFTER_ABSENT_TICKS`] straight ticks, delete its
/// board (CASCADE-deleting its cards). A team that reappears resets its counter,
/// so a transient FS glitch / missed FSEvents never tears a live team's board
/// down. Returns `true` if any board was removed (so the caller re-publishes).
async fn reconcile_deregistrations(
    state: &AppState,
    teams: &[Team],
    absent_ticks: &mut HashMap<String, u32>,
) -> bool {
    use std::collections::HashSet;

    let detected: HashSet<&str> = teams.iter().map(|t| t.team_name.as_str()).collect();

    // The set of team boards currently registered (the only candidates for
    // deregistration). A DB error → skip this tick's deregister pass entirely
    // (never tear a board down on an unknown DB state).
    let boards = match db::boards::list(&state.pool).await {
        Ok(b) => b,
        Err(e) => {
            tracing::debug!(error = %e, "teams watcher: board list failed; skipping deregister pass");
            return false;
        }
    };

    let mut removed = false;
    // Track which team boards we saw so we can prune stale counter entries.
    let mut seen_team_boards: HashSet<String> = HashSet::new();

    for board in &boards {
        let Some(team_name) = board.team_name.as_deref() else {
            continue; // the fixed main board has no team_name.
        };
        seen_team_boards.insert(team_name.to_string());

        if detected.contains(team_name) {
            // Present this tick → reset its absence streak.
            absent_ticks.remove(team_name);
            continue;
        }

        // Absent this tick → bump the streak; deregister once it crosses the bar.
        let n = absent_ticks.entry(team_name.to_string()).or_insert(0);
        *n += 1;
        if *n >= DEREGISTER_AFTER_ABSENT_TICKS {
            if super::board_sync::deregister_team(state, team_name).await {
                removed = true;
            }
            // The team is gone, so drop its dismissals so the table stays bounded
            // to live teams. Best-effort: a DB error just leaves stale rows
            // behind (harmless; they only match a team that no longer exists).
            if let Err(e) = db::teams_dismissed::prune_team(&state.pool, team_name).await {
                tracing::debug!(error = %e, team = %team_name, "teams watcher: prune dismissals on deregister failed");
            }
            absent_ticks.remove(team_name);
        }
    }

    // Prune counters for teams whose board no longer exists (deregistered, or a
    // board deleted out from under us) so the map can't grow unbounded.
    absent_ticks.retain(|k, _| seen_team_boards.contains(k));

    removed
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::teams::board_sync;
    use crate::teams::model::{Member, MemberStatus, Team, TeamTask};
    use std::path::PathBuf;

    async fn test_state() -> (AppState, PathBuf) {
        let dir = std::env::temp_dir()
            .join(format!("supermux-teamwatch-test-{}", uuid::Uuid::new_v4()));
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
        let pool = db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    fn team(name: &str) -> Team {
        Team {
            team_name: name.to_string(),
            lead_session: "lead".into(),
            lead_supermux_session: None,
            lead_cwd: String::new(),
            members: vec![Member {
                name: "alice".into(),
                agent_id: "alice@sq".into(),
                model: "opus".into(),
                color: "blue".into(),
                tmux_pane_id: Some("%1".into()),
                is_active: true,
                status: MemberStatus::Working,
                cwd: String::new(),
            }],
            tasks: vec![TeamTask {
                id: "01".into(),
                subject: "build".into(),
                description: "d".into(),
                status: "pending".into(),
                assigned_to: "alice".into(),
                blocks: vec![],
                blocked_by: vec![],
            }],
            created_at: 0,
        }
    }

    /// The board is only deregistered after DEREGISTER_AFTER_ABSENT_TICKS
    /// CONSECUTIVE absent ticks — a single missed tick does NOT tear it down, and
    /// a reappearance resets the streak (conservative against transient glitches).
    #[tokio::test]
    async fn deregister_only_after_consecutive_absent_ticks() {
        let (state, dir) = test_state().await;
        let alpha = team("alpha");

        // Register alpha's board (one detected tick of the real reconcile path).
        board_sync::reconcile_team(&state, &alpha).await;
        assert!(db::boards::get_by_team(&state.pool, "alpha").await.unwrap().is_some());

        let mut absent: HashMap<String, u32> = HashMap::new();

        // Absent for (N-1) ticks → board MUST survive (transient absence).
        for tick in 1..DEREGISTER_AFTER_ABSENT_TICKS {
            let removed = reconcile_deregistrations(&state, &[], &mut absent).await;
            assert!(!removed, "no removal on tick {tick} (< threshold)");
            assert!(
                db::boards::get_by_team(&state.pool, "alpha").await.unwrap().is_some(),
                "board survives transient absence at tick {tick}"
            );
        }

        // A reappearance BEFORE the threshold resets the streak.
        assert!(!reconcile_deregistrations(&state, &[alpha.clone()], &mut absent).await);
        assert!(
            absent.get("alpha").is_none(),
            "reappearance clears the absence counter"
        );
        assert!(db::boards::get_by_team(&state.pool, "alpha").await.unwrap().is_some());

        // Now stay absent for the FULL threshold of consecutive ticks → removed.
        let mut removed_at = None;
        for tick in 1..=DEREGISTER_AFTER_ABSENT_TICKS {
            if reconcile_deregistrations(&state, &[], &mut absent).await {
                removed_at = Some(tick);
                break;
            }
        }
        assert_eq!(
            removed_at,
            Some(DEREGISTER_AFTER_ABSENT_TICKS),
            "removed exactly on the Nth consecutive absent tick"
        );
        assert!(
            db::boards::get_by_team(&state.pool, "alpha").await.unwrap().is_none(),
            "ended team's board torn down after N consecutive misses"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── FIX-TEAMS bug 2: lead not mapped when leadSessionId is a UUID ───────────

    /// Helper: build a team whose `leadSessionId` is a Claude UUID (NOT a
    /// supermux name) and whose members carry the lead's cwd. Mirrors the
    /// ground-truth viral-news-hunt config from FIX-TEAMS.
    fn uuid_lead_team(team_name: &str, cwd: &str, pane_ids: &[&str]) -> Team {
        use super::super::model::{Member, MemberStatus};
        Team {
            team_name: team_name.into(),
            lead_session: "8a7e1f9e-10f5-4e9c-a9de-29201ec5708f".into(),
            lead_supermux_session: None,
            // Empty: these fixtures exercise the teammate-cwd FALLBACK path.
            lead_cwd: String::new(),
            members: pane_ids
                .iter()
                .enumerate()
                .map(|(i, pid)| Member {
                    name: format!("m{i}"),
                    agent_id: format!("m{i}@{team_name}"),
                    model: "opus".into(),
                    color: "blue".into(),
                    tmux_pane_id: Some((*pid).to_string()),
                    is_active: true,
                    status: MemberStatus::Working,
                    cwd: cwd.into(),
                })
                .collect(),
            tasks: vec![],
            created_at: 0,
        }
    }

    /// FIX-TEAMS bug 2: pane-id intersection resolves the host EVEN when
    /// `leadSessionId` is a UUID that doesn't match any supermux session.
    /// Reproduces the viral-news-hunt scenario where (1) lead-id is `8a7e…`,
    /// (2) team_name `viral-news-hunt` is NOT a session, but (3) teammate
    /// panes `%123/%124` ARE live in the supermux session that hosts the lead.
    #[tokio::test]
    async fn resolve_host_via_pane_intersection_when_lead_id_is_uuid() {
        let (state, dir) = test_state().await;
        let mut team = uuid_lead_team("viral-news-hunt", "/opt/projects/ipc-astro",
                                       &["%123", "%124"]);
        // The live supermux-`ipc-astro` window contains both teammate panes
        // (the lead's split-window children) — pane intersection MUST win even
        // though neither the UUID lead-id nor the team_name matches.
        let mut pane_map: HashMap<String, Vec<String>> = HashMap::new();
        pane_map.insert(
            "ipc-astro".into(),
            vec!["%1".into(), "%123".into(), "%124".into()],
        );
        // A red herring — another live session with NO teammate panes.
        pane_map.insert("supermux-dev".into(), vec!["%7".into()]);

        let host = resolve_host_session(&state, &team, &pane_map).await;
        assert_eq!(host.as_deref(), Some("ipc-astro"));

        // And the watcher's overall enrichment uses that host's pane list to
        // validate %ids — both teammate panes survive validate_pane_ids.
        scan::validate_pane_ids(&mut team, &pane_map["ipc-astro"]);
        assert_eq!(team.members[0].tmux_pane_id.as_deref(), Some("%123"));
        assert_eq!(team.members[1].tmux_pane_id.as_deref(), Some("%124"));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// FIX-TEAMS bug 2 final fallback: when no teammate pane has shown up in
    /// the live pane map yet (a fresh team mid-spawn), a member's `cwd` can
    /// still map the team to its host supermux session via the session row's
    /// `dir` — so the "Lead not mapped" placeholder doesn't flash during the
    /// spawn window even with a UUID lead-id.
    #[tokio::test]
    async fn resolve_host_via_cwd_match_when_pane_map_is_empty() {
        let (state, dir) = test_state().await;
        // Register a real session whose dir matches the team's member cwd.
        let _ = crate::sessions::create(
            &state,
            crate::sessions::CreateInput {
                name: "ipc-astro".into(),
                display_name: None,
                dir: Some("/opt/projects/ipc-astro".into()),
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
            },
        )
        .await
        .unwrap();

        let team = uuid_lead_team("viral-news-hunt", "/opt/projects/ipc-astro", &["%999"]);
        // Empty pane map → cwd-match is the only remaining signal.
        let pane_map: HashMap<String, Vec<String>> = HashMap::new();

        let host = resolve_host_session(&state, &team, &pane_map).await;
        assert_eq!(host.as_deref(), Some("ipc-astro"));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Archive cleanup unit: `persist_team_name` upserts the host → team
    /// backlink so a later `lifecycle::archive(host)` can move
    /// `~/.claude/teams/<name>/` into `.archived/`. Dedupes when the value
    /// hasn't changed so a steady-state team doesn't UPDATE every tick.
    ///
    /// User-facing rule: archive a team-host session → its on-disk team
    /// config is parked in `.archived/`, so the next scan can't surface a
    /// ghost team that shadows a new team spawned in the same cwd.
    #[tokio::test]
    async fn persist_team_name_writes_then_dedupes() {
        let (state, dir) = test_state().await;
        crate::sessions::create(
            &state,
            crate::sessions::CreateInput {
                name: "team-alpha-lead".into(),
                display_name: None,
                dir: Some("/opt/projects/alpha".into()),
                desc: Some("Team lead — alpha".into()),
                provider: Some("claude".into()),
                creator: Some("team".into()),
                flags: None,
                bypass_permissions: None,
                tags: Some(vec!["team".into()]),
                branch: None,
                mcp: None,
                worktree: None,
                host_id: None,
            },
        )
        .await
        .unwrap();

        // Initial: no backlink.
        assert_eq!(
            db::sessions::team_name(&state.pool, "team-alpha-lead").await.unwrap(),
            None,
        );

        // First persist writes the value.
        persist_team_name(&state, "team-alpha-lead", "viral-news-hunt").await;
        assert_eq!(
            db::sessions::team_name(&state.pool, "team-alpha-lead").await.unwrap(),
            Some("viral-news-hunt".to_string()),
        );

        // Second persist with the SAME value is a no-op (dedupe).
        persist_team_name(&state, "team-alpha-lead", "viral-news-hunt").await;
        assert_eq!(
            db::sessions::team_name(&state.pool, "team-alpha-lead").await.unwrap(),
            Some("viral-news-hunt".to_string()),
        );

        // Different value → updates (a new team took over this host).
        persist_team_name(&state, "team-alpha-lead", "viral-telecom-angle").await;
        assert_eq!(
            db::sessions::team_name(&state.pool, "team-alpha-lead").await.unwrap(),
            Some("viral-telecom-angle".to_string()),
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A truly orphaned team (no UUID match, no name match, no pane match, no
    /// cwd match) stays unmapped — the watcher SURFACES it (so the user can see
    /// the on-disk team) but the card renders the calm "unmapped" placeholder.
    /// Regression guard: the new fallbacks must not invent a wrong mapping.
    #[tokio::test]
    async fn truly_orphaned_team_stays_unmapped() {
        let (state, dir) = test_state().await;
        let team = uuid_lead_team("ghost-team", "/no/such/dir", &["%999"]);
        let pane_map: HashMap<String, Vec<String>> = HashMap::new();

        let host = resolve_host_session(&state, &team, &pane_map).await;
        assert!(host.is_none(), "no false positive when nothing matches");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── lead-cwd host attribution (pure match_host_by_cwd) ──────────────────────

    /// Build a team with an explicit `lead_cwd` and a single teammate whose cwd
    /// may differ (the worktree/subdir case). Panes irrelevant to cwd matching.
    fn lead_cwd_team(team_name: &str, lead_cwd: &str, teammate_cwd: &str) -> Team {
        use super::super::model::{Member, MemberStatus};
        Team {
            team_name: team_name.into(),
            lead_session: "some-uuid".into(),
            lead_supermux_session: None,
            lead_cwd: lead_cwd.into(),
            members: vec![Member {
                name: "m0".into(),
                agent_id: format!("m0@{team_name}"),
                model: "opus".into(),
                color: "blue".into(),
                tmux_pane_id: Some("%0".into()),
                is_active: true,
                status: MemberStatus::Working,
                cwd: teammate_cwd.into(),
            }],
            tasks: vec![],
            created_at: 0,
        }
    }

    /// Sessions as the pure helper consumes them: `(name, dir, provider)`.
    fn sess(rows: &[(&str, &str, &str)]) -> Vec<(String, String, String)> {
        rows.iter()
            .map(|(n, d, p)| (n.to_string(), d.to_string(), p.to_string()))
            .collect()
    }

    /// THE regression test for the mis-attribution bug: a teammate works in a
    /// worktree (`dirB`) that coincides with an UNRELATED session's dir (App),
    /// while the lead's cwd (`dirA`) is the true host (Full). The resolver MUST
    /// pick Full (matched by the lead's cwd), never App (the teammate's cwd).
    #[test]
    fn match_host_prefers_lead_cwd_over_teammate_cwd() {
        let dir_a = "/home/p/projects/mobsters-united";
        let dir_b = "/home/p/projects/mobsters-united/game.mobsters-united.com";
        let team = lead_cwd_team("session-37a40788", dir_a, dir_b);
        let rows = sess(&[
            ("Mobsters-United-Full", dir_a, "claude"),
            ("Mobsters-United-Game", dir_b, "claude"),
        ]);

        let host = match_host_by_cwd(
            &team,
            rows.iter().map(|(n, d, p)| (n.as_str(), d.as_str(), p.as_str())),
        );
        assert_eq!(host.as_deref(), Some("Mobsters-United-Full"));
        assert_ne!(host.as_deref(), Some("Mobsters-United-Game"));
    }

    /// Fallback: when `lead_cwd` is empty (in-process lead / schema drift), the
    /// teammate cwd still resolves the host — preserves the pre-fix behavior.
    #[test]
    fn match_host_falls_back_to_teammate_cwd_when_lead_cwd_empty() {
        let dir_b = "/opt/projects/ipc-astro";
        let team = lead_cwd_team("t", "", dir_b);
        let rows = sess(&[
            ("other", "/opt/projects/unrelated", "claude"),
            ("ipc-astro", dir_b, "claude"),
        ]);

        let host = match_host_by_cwd(
            &team,
            rows.iter().map(|(n, d, p)| (n.as_str(), d.as_str(), p.as_str())),
        );
        assert_eq!(host.as_deref(), Some("ipc-astro"));
    }

    /// No session dir matches the lead cwd (nor, in fallback, any teammate) →
    /// `None`. The team surfaces unmapped rather than pinning to a wrong host.
    #[test]
    fn match_host_returns_none_when_nothing_matches() {
        let team = lead_cwd_team("t", "/no/such/dir", "/also/nope");
        let rows = sess(&[("live", "/opt/projects/real", "claude")]);
        let host = match_host_by_cwd(
            &team,
            rows.iter().map(|(n, d, p)| (n.as_str(), d.as_str(), p.as_str())),
        );
        assert!(host.is_none());
    }

    /// The `provider == "claude"` filter and trailing-slash/case normalization
    /// are preserved: a non-claude session with the same dir is skipped, and a
    /// dir differing only by a trailing slash / letter case still matches.
    #[test]
    fn match_host_filters_provider_and_normalizes_dir() {
        let team = lead_cwd_team("t", "/home/P/Proj", "");
        // A shell session with the exact dir must NOT win (provider filter).
        let rows = sess(&[
            ("shell-host", "/home/P/Proj", "shell"),
            ("claude-host", "/home/p/proj/", "claude"),
        ]);
        let host = match_host_by_cwd(
            &team,
            rows.iter().map(|(n, d, p)| (n.as_str(), d.as_str(), p.as_str())),
        );
        assert_eq!(host.as_deref(), Some("claude-host"));
    }

    /// The dismissed-teammate filter: given members [alice, bob] with bob
    /// dismissed, only alice survives; nothing dismissed → both survive.
    #[test]
    fn retain_undismissed_drops_dismissed_members() {
        use super::super::model::{Member, MemberStatus};
        let mk = |agent: &str| Member {
            name: agent.split('@').next().unwrap().into(),
            agent_id: agent.into(),
            model: "opus".into(),
            color: "blue".into(),
            tmux_pane_id: None,
            is_active: false,
            status: MemberStatus::Offline,
            cwd: String::new(),
        };
        let mut t = team("sq");
        t.members = vec![mk("alice@sq"), mk("bob@sq")];

        // Nothing dismissed → both survive (and the empty-set fast path is a no-op).
        retain_undismissed(&mut t, &[]);
        assert_eq!(t.members.len(), 2);

        // bob dismissed → only alice remains.
        retain_undismissed(&mut t, &["bob@sq".to_string()]);
        let ids: Vec<&str> = t.members.iter().map(|m| m.agent_id.as_str()).collect();
        assert_eq!(ids, vec!["alice@sq"]);
    }

    /// prune-on-deregister: once a team crosses the absence threshold and its
    /// board is torn down, its dismissals are pruned too (table stays bounded).
    #[tokio::test]
    async fn deregister_prunes_team_dismissals() {
        let (state, dir) = test_state().await;
        let alpha = team("alpha");
        board_sync::reconcile_team(&state, &alpha).await;

        // Record a dismissal for the team.
        db::teams_dismissed::dismiss(&state.pool, "alpha", "bob@alpha", 1)
            .await
            .unwrap();
        assert_eq!(
            db::teams_dismissed::list_for_team(&state.pool, "alpha").await.unwrap(),
            vec!["bob@alpha"],
        );

        // Stay absent for the full threshold → board torn down AND dismissals pruned.
        let mut absent: HashMap<String, u32> = HashMap::new();
        for _ in 0..DEREGISTER_AFTER_ABSENT_TICKS {
            reconcile_deregistrations(&state, &[], &mut absent).await;
        }
        assert!(
            db::boards::get_by_team(&state.pool, "alpha").await.unwrap().is_none(),
            "board deregistered after the threshold",
        );
        assert!(
            db::teams_dismissed::list_for_team(&state.pool, "alpha").await.unwrap().is_empty(),
            "the deregistered team's dismissals are pruned",
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A detected team is never deregistered, and its absence counter never grows.
    #[tokio::test]
    async fn detected_team_is_never_deregistered() {
        let (state, dir) = test_state().await;
        let alpha = team("alpha");
        board_sync::reconcile_team(&state, &alpha).await;

        let mut absent: HashMap<String, u32> = HashMap::new();
        for _ in 0..(DEREGISTER_AFTER_ABSENT_TICKS + 5) {
            let removed =
                reconcile_deregistrations(&state, &[alpha.clone()], &mut absent).await;
            assert!(!removed, "a present team is never torn down");
        }
        assert!(db::boards::get_by_team(&state.pool, "alpha").await.unwrap().is_some());
        assert!(absent.is_empty(), "present team accrues no absence");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── fix: one team card per session (drop_rosterless + dedup_by_host) ─────────

    /// A member with an explicit status. `is_active` tracks the status so the
    /// fixture stays self-consistent (offline == not active).
    fn member_with(agent: &str, status: MemberStatus) -> Member {
        Member {
            name: agent.split('@').next().unwrap_or(agent).into(),
            agent_id: agent.into(),
            model: "opus".into(),
            color: "blue".into(),
            tmux_pane_id: None,
            is_active: status != MemberStatus::Offline,
            status,
            cwd: String::new(),
        }
    }

    /// A team with an explicit host, roster, and `created_at` for the pure
    /// post-processing transforms (no tmux/DB).
    fn host_team(name: &str, host: Option<&str>, members: Vec<Member>, created_at: i64) -> Team {
        Team {
            team_name: name.into(),
            lead_session: "lead".into(),
            lead_supermux_session: host.map(str::to_string),
            lead_cwd: String::new(),
            members,
            tasks: vec![],
            created_at,
        }
    }

    /// fix 1: a team whose roster is empty (all-lead-only, after the lead filter +
    /// dismiss filter) is dropped; a team whose only member is OFFLINE-but-present
    /// is kept — offline is not the same as absent.
    #[test]
    fn drop_rosterless_removes_empty_and_keeps_offline_member() {
        let empty = host_team("empty", Some("Full"), vec![], 0);
        let offline = host_team(
            "offline",
            Some("Full"),
            vec![member_with("a@offline", MemberStatus::Offline)],
            0,
        );
        let out = drop_rosterless(vec![empty, offline]);
        let names: Vec<&str> = out.iter().map(|t| t.team_name.as_str()).collect();
        assert_eq!(names, vec!["offline"], "empty dropped; offline-but-present kept");
    }

    /// fix 2, tier 1: same host → the team with more LIVE members (status !=
    /// Offline) wins; a dead orphan loses even if it were newer.
    #[test]
    fn dedup_by_host_keeps_more_live_members() {
        let dead = host_team(
            "dead",
            Some("Full"),
            vec![member_with("a@dead", MemberStatus::Offline)],
            100,
        );
        let live = host_team(
            "live",
            Some("Full"),
            vec![member_with("a@live", MemberStatus::Working)],
            1,
        );
        let out = dedup_by_host(vec![dead, live]);
        let names: Vec<&str> = out.iter().map(|t| t.team_name.as_str()).collect();
        assert_eq!(names, vec!["live"], "a live teammate beats a dead orphan");
    }

    /// fix 2, tier 2: equal live count → more members TOTAL wins.
    #[test]
    fn dedup_by_host_breaks_tie_on_total_members() {
        let more = host_team(
            "more",
            Some("Full"),
            vec![
                member_with("a@more", MemberStatus::Working),
                member_with("b@more", MemberStatus::Offline),
            ],
            1,
        );
        let fewer = host_team(
            "fewer",
            Some("Full"),
            vec![member_with("a@fewer", MemberStatus::Working)],
            100,
        );
        // Both have exactly 1 live member; `more` has 2 total → it wins.
        let out = dedup_by_host(vec![more, fewer]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].team_name, "more", "equal live → more total members wins");
    }

    /// fix 2, tier 3: equal live AND total → newest `created_at` wins.
    #[test]
    fn dedup_by_host_breaks_tie_on_created_at() {
        let old = host_team(
            "old",
            Some("Full"),
            vec![member_with("a@old", MemberStatus::Working)],
            100,
        );
        let new = host_team(
            "new",
            Some("Full"),
            vec![member_with("a@new", MemberStatus::Working)],
            200,
        );
        let out = dedup_by_host(vec![old, new]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].team_name, "new", "equal roster → newest created_at wins");
    }

    /// fix 2, tier 4: full tie on live/total/created_at → lexically smallest
    /// `team_name` wins (the final deterministic tiebreak).
    #[test]
    fn dedup_by_host_breaks_tie_on_team_name() {
        let b = host_team(
            "bbb",
            Some("Full"),
            vec![member_with("a@bbb", MemberStatus::Working)],
            50,
        );
        let a = host_team(
            "aaa",
            Some("Full"),
            vec![member_with("a@aaa", MemberStatus::Working)],
            50,
        );
        // Insertion order is bbb-then-aaa to prove the winner is chosen by the
        // key, not by position.
        let out = dedup_by_host(vec![b, a]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].team_name, "aaa", "full tie → smallest team_name wins");
    }

    /// fix 2: dedup only collapses teams that SHARE a host — a team mapping to a
    /// different host is untouched, and a team with host `None` is never dropped
    /// (two unmapped teams both survive even though they share `None`).
    #[test]
    fn dedup_by_host_leaves_other_hosts_and_none_alone() {
        let full_a = host_team(
            "full-a",
            Some("Full"),
            vec![member_with("a@full-a", MemberStatus::Working)],
            2,
        );
        let full_b = host_team(
            "full-b",
            Some("Full"),
            vec![member_with("a@full-b", MemberStatus::Offline)],
            1,
        );
        let other = host_team(
            "other",
            Some("Other"),
            vec![member_with("a@other", MemberStatus::Working)],
            1,
        );
        let unmapped1 = host_team(
            "unmapped-1",
            None,
            vec![member_with("a@unmapped-1", MemberStatus::Working)],
            1,
        );
        let unmapped2 = host_team(
            "unmapped-2",
            None,
            vec![member_with("a@unmapped-2", MemberStatus::Working)],
            1,
        );
        let out = dedup_by_host(vec![full_a, full_b, other, unmapped1, unmapped2]);
        let mut names: Vec<&str> = out.iter().map(|t| t.team_name.as_str()).collect();
        names.sort();
        assert_eq!(
            names,
            vec!["full-a", "other", "unmapped-1", "unmapped-2"],
            "Full collapses to its live winner; a different host and both host=None teams survive",
        );
    }

    /// The exact reported scenario: one live session with THREE orphaned lead-only
    /// `session-<uuid>` dirs, all cwd-mapped to it. drop_rosterless removes all
    /// three (empty rosters) BEFORE dedup runs, so nothing is left to collapse and
    /// the session renders as a plain tile (zero team cards).
    #[test]
    fn combined_three_lead_only_teams_sharing_a_host_all_disappear() {
        let t1 = host_team("session-0a0af9dd", Some("Mobsters-United-Full"), vec![], 3);
        let t2 = host_team("session-2dbb48ec", Some("Mobsters-United-Full"), vec![], 2);
        let t3 = host_team("session-37a40788", Some("Mobsters-United-Full"), vec![], 1);
        let out = dedup_by_host(drop_rosterless(vec![t1, t2, t3]));
        assert!(
            out.is_empty(),
            "all three lead-only cards vanish (empty-drop before dedup)",
        );
    }
}

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

/// How many CONSECUTIVE ticks a previously-detected team must be absent before
/// supermux deregisters its board (AT-G §3). FSEvents can be dropped and a
/// half-written `config.json` can momentarily fail to parse — a team that
/// flickers absent for a tick or two is almost certainly a transient glitch, not
/// an ended team. Only after `DEREGISTER_AFTER_ABSENT_TICKS` straight misses (≈
/// `POLL_INTERVAL` × this) do we tear the board down (a CASCADE delete of its
/// cards), so the policy is conservative against a missed event.
const DEREGISTER_AFTER_ABSENT_TICKS: u32 = 3;

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
        // AT-G deregister safety: per team, how many CONSECUTIVE ticks it has been
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

            // AT-G — wire the detected teams onto their OWN boards: register each
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
        // Map team → supermux session via a multi-key resolver that tolerates
        // the (common) state where no teammate has a tmuxPaneId yet: lead just
        // booted but hasn't invoked Spawn, in-process teammates, half-written
        // config.json mid-write, transient pane churn between watcher ticks.
        // Pane-id intersection (the docstring's original promise; AT-B v1) is
        // kept as the strongest signal AND the final fallback.
        let host = resolve_host_session(state, team, &pane_map).await;

        let live_ids: &[String] = host
            .as_deref()
            .and_then(|h| pane_map.get(h))
            .map(Vec::as_slice)
            .unwrap_or(&[]);

        // §3.2: re-validate every `%id` against the host's live panes THIS tick.
        scan::validate_pane_ids(team, live_ids);
        scan::map_lead_session(team, |_| host.clone());

        // Persist the team_name backlink on the host session so
        // `lifecycle::archive` knows which `~/.claude/teams/<name>/` dir to
        // park in `.archived/` when the user archives the session. Only fires
        // when host resolved AND the value would change (cheap dedupe avoids
        // an UPDATE-per-tick on a steady-state team).
        if let Some(host_name) = host.as_deref() {
            persist_team_name(state, host_name, &team.team_name).await;
        }
    }

    teams
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
///   (1) `leadSessionId` as a supermux name — true when Start-a-team set it, but
///       per FIX-TEAMS ground truth (viral-news-hunt) Claude often writes a UUID
///       there instead; the live-map presence check guards against that case.
///   (2) `team_name` as a supermux name — Start-a-team's `gen_team_name` often
///       matches the supermux session name directly (`team-supermux`, etc.).
///   (3) Pane-id intersection — for any teammate `%id` known to be live in the
///       roster, find the supermux session whose window contains it. Authoritative
///       once teammates have spawned, AND it does NOT depend on `leadSessionId`
///       matching the supermux name (the FIX-TEAMS bug 2 case).
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

/// Find a live Claude session whose `dir` matches one of `team`'s members' cwd.
/// Used as the final host-session fallback when neither `leadSessionId`, the
/// team-name, nor pane-id intersection resolves. A DB error or no match yields
/// `None` — the team is then surfaced as unmapped (a calm UI state, never wrong).
async fn cwd_match_session(state: &AppState, team: &Team) -> Option<String> {
    // Collect the unique non-empty member cwds (typically all the same — the
    // lead's dir — but defensive against a future per-teammate-worktree shape).
    let mut cwds: Vec<&str> = team
        .members
        .iter()
        .map(|m| m.cwd.trim())
        .filter(|c| !c.is_empty())
        .collect();
    cwds.sort();
    cwds.dedup();
    if cwds.is_empty() {
        return None;
    }
    let sessions = match db::sessions::list(&state.pool).await {
        Ok(s) => s,
        Err(e) => {
            tracing::debug!(error = %e, "teams watcher: cwd-match session list failed");
            return None;
        }
    };
    for s in &sessions {
        if s.provider != "claude" {
            continue;
        }
        let s_dir = s.dir.trim_end_matches('/');
        if s_dir.is_empty() {
            continue;
        }
        if cwds.iter().any(|c| c.trim_end_matches('/').eq_ignore_ascii_case(s_dir)) {
            return Some(s.name.clone());
        }
    }
    None
}

/// Tear down team boards whose team has ENDED (AT-G §3), conservatively. For
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
        };
        let pool = db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    fn team(name: &str) -> Team {
        Team {
            team_name: name.to_string(),
            lead_session: "lead".into(),
            lead_supermux_session: None,
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
                dir: Some("/opt/projects/ipc-astro".into()),
                desc: None,
                provider: Some("claude".into()),
                creator: None,
                flags: None,
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
                dir: Some("/opt/projects/alpha".into()),
                desc: Some("Team lead — alpha".into()),
                provider: Some("claude".into()),
                creator: Some("team".into()),
                flags: None,
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
}

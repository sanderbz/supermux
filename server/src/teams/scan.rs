//! File-driven Agent-Teams scanner (AT-B §3.2/§3.3).
//!
//! Reads the on-disk team files Claude Code writes under `~/.claude` and builds
//! the in-memory [`Team`] model. Two layers, split so the PURE file→Team parse
//! is unit-testable against a temp dir with no tmux/DB:
//!
//! 1. [`scan_teams`] — pure: list `teams/*/config.json`, parse config + tasks +
//!    inboxes, derive each member's `status` (§3.3). NO `%id` validation, NO
//!    lead→supermux mapping (those need live tmux / the session set).
//! 2. [`validate_pane_ids`] / [`map_lead_session`] — the live enrichment the
//!    watcher applies each tick: drop a member's `%id` (→ Offline) the instant it
//!    is gone from the lead's window, and resolve the hosting supermux session.
//!
//! **Defensive everywhere (§3 / §6).** Any missing/partial file or parse error
//! skips ONLY that team/member and is logged at debug — never a panic, never a
//! blanked snapshot. An experimental Claude feature WILL drift; we tolerate it.

use std::path::{Path, PathBuf};

use super::model::{
    Member, MemberStatus, RawInboxMessage, RawMember, RawTask, RawTeamConfig, Team, TeamTask,
};

/// Resolve Claude's config directory: `$CLAUDE_CONFIG_DIR` (Claude Code's own
/// override — also what tests target) else `~/.claude`. Mirrors
/// [`crate::claude_config`]'s resolver so hooks + teams read the same root.
pub fn claude_config_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        let d = d.trim();
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
}

/// The `teams/` directory under the resolved Claude config dir.
pub fn teams_dir() -> PathBuf {
    claude_config_dir().join("teams")
}

/// The `tasks/` directory under the resolved Claude config dir.
pub fn tasks_dir() -> PathBuf {
    claude_config_dir().join("tasks")
}

/// Scan every `teams/*/config.json` under `base` (the Claude config dir) into
/// the file-derived [`Team`] model. PURE: no tmux, no DB. `%id`s come straight
/// from config.json (un-validated — the watcher validates them per tick); lead→
/// supermux mapping is left `None` (filled by [`map_lead_session`]).
///
/// A team dir with no/invalid `config.json`, or an empty roster, is skipped.
pub fn scan_teams(base: &Path) -> Vec<Team> {
    let teams_root = base.join("teams");
    let tasks_root = base.join("tasks");
    let mut out = Vec::new();

    let entries = match std::fs::read_dir(&teams_root) {
        Ok(e) => e,
        // No teams dir yet (the common case until a team is started) → no teams.
        Err(_) => return out,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let team_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        match scan_one_team(&path, &tasks_root, &team_name) {
            Some(team) => out.push(team),
            None => tracing::debug!(team = %team_name, "skipping team: no parseable config/members"),
        }
    }

    // Deterministic order so the SSE/API payload + tests are stable.
    out.sort_by(|a, b| a.team_name.cmp(&b.team_name));
    out
}

/// Build one [`Team`] from a single `teams/<team_name>/` directory. `None` when
/// the config is missing/unparseable or the roster is empty.
fn scan_one_team(team_dir: &Path, tasks_root: &Path, team_name: &str) -> Option<Team> {
    let config = read_config(&team_dir.join("config.json"))?;
    if config.members.is_empty() {
        return None;
    }

    let tasks = read_tasks(&tasks_root.join(team_name));
    let inbox_dir = team_dir.join("inboxes");

    // FIX-TEAMS bug 1 (phantom "team-lead" chip): Claude writes the LEAD as a
    // members[] entry alongside the real teammates (agentType="orchestrator",
    // tmuxPaneId=""). The lead ALREADY renders as the full SessionTile via
    // `lead_supermux_session`; surfacing it again as a teammate chip is the
    // duplicate the user sees. Filter it before materializing — by agentId
    // match (the canonical, version-stable key) AND by role marker (belt +
    // braces against schema drift / missing leadAgentId).
    let lead_agent_id = config.lead_agent_id.trim().to_string();
    let members = config
        .members
        .into_iter()
        .filter(|m| !is_lead_entry(m, &lead_agent_id))
        .map(|m| resolve_member(m, &inbox_dir, &tasks))
        .collect();

    Some(Team {
        team_name: team_name.to_string(),
        lead_session: config.lead_session_id,
        lead_supermux_session: None,
        members,
        tasks: tasks.into_iter().map(TeamTask::from).collect(),
    })
}

/// Should this `members[]` entry be DROPPED as the lead's own roster row (not a
/// teammate)? Three orthogonal signals; ANY hit filters the entry so a schema
/// rename in one of them can't re-surface the phantom chip:
///   (a) `agent_id == lead_agent_id` — the canonical match when Claude writes
///       a top-level `leadAgentId`.
///   (b) `agent_type == "orchestrator"` — the role marker Claude writes for the
///       lead row even when `leadAgentId` is absent.
///   (c) empty `tmux_pane_id` AND empty `backend_type` AND empty `color` —
///       the lead row has none of these (its pane is the lead's own window,
///       not a split), so a member with all three blank is structurally the
///       lead, not a teammate. This catches forward-drifted configs that
///       drop the role marker.
fn is_lead_entry(m: &RawMember, lead_agent_id: &str) -> bool {
    let aid = m.agent_id.trim();
    if !lead_agent_id.is_empty() && aid.eq_ignore_ascii_case(lead_agent_id) {
        return true;
    }
    if m.agent_type.trim().eq_ignore_ascii_case("orchestrator") {
        return true;
    }
    // Structural fallback: the lead's roster row has no pane, no backend, no
    // color (a real teammate ALWAYS has at minimum a tmuxPaneId once spawned,
    // plus a backendType the lead lacks). Don't filter a member that just hasn't
    // spawned yet — gate on the conjunction of all three blank fields.
    let no_pane = m.tmux_pane_id.trim().is_empty();
    let no_backend = m.backend_type.trim().is_empty();
    let no_color = m.color.trim().is_empty();
    no_pane && no_backend && no_color
}

/// Parse a `config.json`. Returns `None` (logged) on any read/parse failure so a
/// malformed file skips just that team.
fn read_config(path: &Path) -> Option<RawTeamConfig> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<RawTeamConfig>(&text) {
        Ok(c) => Some(c),
        Err(e) => {
            tracing::debug!(path = %path.display(), error = %e, "unparseable team config.json");
            None
        }
    }
}

/// Read every `NN.json` under `tasks/<team>/`, skipping `.lock` and any
/// unparseable file. Sorted by id for a stable payload. A missing dir → no tasks.
fn read_tasks(dir: &Path) -> Vec<RawTask> {
    let mut tasks = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return tasks,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Only `*.json`, never the `.lock` companion.
        let is_json = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        let is_lock = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".lock"))
            .unwrap_or(false);
        if !is_json || is_lock {
            continue;
        }
        match std::fs::read_to_string(&path).ok().and_then(|t| {
            serde_json::from_str::<RawTask>(&t)
                .map_err(|e| tracing::debug!(path = %path.display(), error = %e, "unparseable task json"))
                .ok()
        }) {
            Some(t) => tasks.push(t),
            None => continue,
        }
    }
    tasks.sort_by(|a, b| a.id.cmp(&b.id));
    tasks
}

/// Resolve one roster member into the supermux [`Member`], deriving its live
/// status (§3.3) from `is_active` + its in-progress task + the idle/shutdown
/// /needs-input signal in its inbox.
fn resolve_member(raw: RawMember, inbox_dir: &Path, tasks: &[RawTask]) -> Member {
    let pane = if raw.tmux_pane_id.trim().is_empty() {
        None
    } else {
        Some(raw.tmux_pane_id.trim().to_string())
    };

    let inbox = read_inbox(&inbox_dir.join(format!("{}.json", raw.name)));
    let signal = latest_signal(&inbox);
    let has_in_progress = tasks.iter().any(|t| {
        t.status.eq_ignore_ascii_case("in_progress")
            && member_owns_task(&raw, t)
    });

    let status = derive_status(raw.is_active, has_in_progress, signal);

    Member {
        name: raw.name,
        agent_id: raw.agent_id,
        model: raw.model,
        color: raw.color,
        tmux_pane_id: pane,
        is_active: raw.is_active,
        status,
        cwd: raw.cwd,
    }
}

/// Does `task` belong to `member`? Matches the task's assignee against the
/// member name OR its `agent_id` (`name@team`). When the task has no assignee at
/// all we DON'T attribute it (so an in_progress unassigned task doesn't make
/// every member read "working").
fn member_owns_task(member: &RawMember, task: &RawTask) -> bool {
    let a = task.assigned_to.trim();
    if a.is_empty() {
        return false;
    }
    a.eq_ignore_ascii_case(member.name.trim())
        || a.eq_ignore_ascii_case(member.agent_id.trim())
}

/// Read an inbox `{member}.json` array. Missing/unparseable → empty (no signal).
fn read_inbox(path: &Path) -> Vec<RawInboxMessage> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<RawInboxMessage>>(&t).ok())
        .unwrap_or_default()
}

/// A coarse control signal decoded from an inbox message's `text` (§3.3: the
/// idle/shutdown/needs-input signals are JSON ENCODED INSIDE `text`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InboxSignal {
    Idle,
    NeedsYou,
    Shutdown,
}

/// Scan the inbox newest-last for the most recent control signal in any
/// message's `text`. Returns `None` when no message carries one (plain chat).
///
/// The inbox is a chronological array; we walk it in REVERSE so the LATEST
/// signal wins (a later "working again" / chat message after an idle signal
/// means the idle is stale — but absent a positive "working" marker we simply
/// take the most recent recognizable signal).
fn latest_signal(inbox: &[RawInboxMessage]) -> Option<InboxSignal> {
    inbox.iter().rev().find_map(|m| parse_signal(&m.text))
}

/// Decode a control signal from a message's `text`. Tolerant: tries JSON first
/// (`{"type":"idle"}`, `{"signal":"needs_input"}`, …) then — for SHORT texts
/// only — falls back to a substring sniff so a schema rename doesn't blind us.
/// Returns `None` for an ordinary chat line.
///
/// ## Length-gating the substring fallback
/// The lead routinely sends teammates multi-paragraph briefs that mention
/// "shutdown" ("do NOT request shutdown"), "waiting" ("waiting on the API"),
/// etc. as plain English. The old code substring-matched these and demoted
/// the teammate to Offline / NeedsYou immediately. The fix: only treat the
/// substring fallback as authoritative when the text is short enough to be
/// a genuine control-message-shaped string (≤ [`SHORT_SIGNAL_LEN`] chars).
/// The earliest known control formats ("shutdown requested",
/// "agent is now idle", `{"type":"idle"}`) all fit comfortably; long briefs
/// don't, so they fall through to `None` and the member's status is derived
/// from `is_active` + the task list instead.
const SHORT_SIGNAL_LEN: usize = 80;

fn parse_signal(text: &str) -> Option<InboxSignal> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    // 1. Structured: the signal is JSON inside `text`.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
        // Accept several common key spellings for the kind.
        let kind = v
            .get("type")
            .or_else(|| v.get("signal"))
            .or_else(|| v.get("kind"))
            .or_else(|| v.get("event"))
            .and_then(|x| x.as_str());
        if let Some(k) = kind {
            if let Some(sig) = classify(k) {
                return Some(sig);
            }
        }
    }
    // 2. Best-effort substring sniff — ONLY for short, control-shaped texts.
    //    A multi-paragraph brief that happens to contain "shutdown" must not
    //    be misread as a Shutdown signal.
    if t.len() > SHORT_SIGNAL_LEN {
        return None;
    }
    classify(t)
}

/// Map a raw kind/keyword string to an [`InboxSignal`] (case-insensitive,
/// substring). Order matters: `needs`/`input`/`waiting`/`approval` → NeedsYou
/// takes precedence (it's the attention-first state), then shutdown, then idle.
fn classify(s: &str) -> Option<InboxSignal> {
    let l = s.to_ascii_lowercase();
    if l.contains("needs_input")
        || l.contains("needs-you")
        || l.contains("needs_you")
        || l.contains("need_input")
        || l.contains("awaiting")
        || l.contains("waiting")
        || l.contains("approval")
        || l.contains("blocked")
    {
        Some(InboxSignal::NeedsYou)
    } else if l.contains("shutdown") || l.contains("shut_down") || l.contains("terminated") {
        Some(InboxSignal::Shutdown)
    } else if l.contains("idle") {
        Some(InboxSignal::Idle)
    } else {
        None
    }
}

/// Derive a member's [`MemberStatus`] from its roster liveness + in-progress
/// task + the latest inbox signal (§3.3):
///   * NeedsYou signal → `NeedsYou` (loud, attention-first — wins always).
///   * not active OR shutdown signal → `Offline`.
///   * active + in_progress task (and no idle signal) → `Working`.
///   * active + idle signal, OR active with nothing to do → `Idle`.
fn derive_status(
    is_active: bool,
    has_in_progress: bool,
    signal: Option<InboxSignal>,
) -> MemberStatus {
    // Needs-input is the attention state — surface it even if the roster flag
    // lags (the whole reason we read files: roster liveness can be stale).
    if signal == Some(InboxSignal::NeedsYou) {
        return MemberStatus::NeedsYou;
    }
    if !is_active || signal == Some(InboxSignal::Shutdown) {
        return MemberStatus::Offline;
    }
    if signal == Some(InboxSignal::Idle) {
        return MemberStatus::Idle;
    }
    if has_in_progress {
        MemberStatus::Working
    } else {
        MemberStatus::Idle
    }
}

/// Validate each member's `%id` against `live_pane_ids` (the lead window's panes
/// THIS tick). Any `%id` not present is DROPPED (`tmux_pane_id = None`) and the
/// member's live status is demoted to `Offline` — a freed pane id may have been
/// re-handed to an unrelated pane, so we must never trust a stale one (§3.2).
///
/// `NeedsYou` is preserved even with a dropped pane: the attention signal came
/// from the inbox file, not the pane, and we don't want to swallow "needs you"
/// just because the pane id churned mid-tick.
pub fn validate_pane_ids(team: &mut Team, live_pane_ids: &[String]) {
    for m in &mut team.members {
        let live = m
            .tmux_pane_id
            .as_deref()
            .map(|id| live_pane_ids.iter().any(|p| p == id))
            .unwrap_or(false);
        if !live {
            m.tmux_pane_id = None;
            if m.status != MemberStatus::NeedsYou {
                m.status = MemberStatus::Offline;
            }
        }
    }
}

/// Record the hosting supermux session for a team's lead (§3.2). Maps via, in
/// order: an exact `supermux-<name>` derivation, the `leadSessionId`, or a cwd
/// match — whichever `resolver` returns first. Left `None` when unmapped (the
/// team is still surfaced, just without a clickable lead session).
pub fn map_lead_session(team: &mut Team, resolver: impl Fn(&Team) -> Option<String>) {
    team.lead_supermux_session = resolver(team);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("supermux-teams-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// Write a full team fixture under `base`: config + tasks + inboxes.
    fn seed_team(base: &Path, team: &str) {
        let tdir = base.join("teams").join(team);
        fs::create_dir_all(tdir.join("inboxes")).unwrap();
        let config = serde_json::json!({
            "leadSessionId": "lead-abc",
            "members": [
                { "name": "alice", "agentId": "alice@sq", "model": "opus",
                  "color": "blue", "tmuxPaneId": "%1", "cwd": "/x", "isActive": true,
                  "backendType": "claude" },
                { "name": "bob", "agentId": "bob@sq", "model": "sonnet",
                  "color": "green", "tmuxPaneId": "%2", "cwd": "/y", "isActive": true,
                  "backendType": "claude" },
                { "name": "carol", "agentId": "carol@sq", "model": "opus",
                  "color": "red", "tmuxPaneId": "%3", "cwd": "/z", "isActive": false,
                  "backendType": "claude" }
            ]
        });
        fs::write(tdir.join("config.json"), config.to_string()).unwrap();

        // Tasks: one in_progress for alice, one pending unassigned.
        let tasksd = base.join("tasks").join(team);
        fs::create_dir_all(&tasksd).unwrap();
        fs::write(
            tasksd.join("01.json"),
            serde_json::json!({
                "id": "01", "subject": "do thing", "description": "d",
                "status": "in_progress", "assignedTo": "alice",
                "blocks": [], "blockedBy": []
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            tasksd.join("02.json"),
            serde_json::json!({
                "id": "02", "subject": "later", "status": "pending"
            })
            .to_string(),
        )
        .unwrap();
        // A `.lock` companion must be ignored.
        fs::write(tasksd.join("01.json.lock"), "x").unwrap();

        // Inboxes: bob signalled idle; carol untouched.
        fs::write(
            tdir.join("inboxes").join("bob.json"),
            serde_json::json!([
                { "from": "alice", "text": "hi", "summary": "", "timestamp": "t1",
                  "color": "blue", "read": true },
                { "from": "system", "text": "{\"type\":\"idle\"}", "summary": "",
                  "timestamp": "t2", "color": "", "read": false }
            ])
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn scans_a_full_team_and_derives_status() {
        let base = tmp();
        seed_team(&base, "squad");
        let teams = scan_teams(&base);
        assert_eq!(teams.len(), 1);
        let t = &teams[0];
        assert_eq!(t.team_name, "squad");
        assert_eq!(t.lead_session, "lead-abc");
        assert_eq!(t.members.len(), 3);
        // Tasks: the `.lock` is skipped, the 2 json files are read, sorted by id.
        assert_eq!(t.tasks.len(), 2);
        assert_eq!(t.tasks[0].id, "01");
        assert_eq!(t.tasks[0].assigned_to, "alice");

        let alice = t.members.iter().find(|m| m.name == "alice").unwrap();
        let bob = t.members.iter().find(|m| m.name == "bob").unwrap();
        let carol = t.members.iter().find(|m| m.name == "carol").unwrap();

        // alice: active + her in_progress task → Working.
        assert_eq!(alice.status, MemberStatus::Working);
        assert_eq!(alice.tmux_pane_id.as_deref(), Some("%1"));
        // bob: active but inbox idle signal → Idle.
        assert_eq!(bob.status, MemberStatus::Idle);
        // carol: isActive=false → Offline.
        assert_eq!(carol.status, MemberStatus::Offline);

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn needs_you_signal_is_loud_and_survives_pane_drop() {
        let base = tmp();
        let tdir = base.join("teams").join("sq");
        fs::create_dir_all(tdir.join("inboxes")).unwrap();
        fs::write(
            tdir.join("config.json"),
            serde_json::json!({
                "leadSessionId": "L",
                "members": [{ "name": "ann", "agentId": "ann@sq", "tmuxPaneId": "%9",
                              "isActive": true }]
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            tdir.join("inboxes").join("ann.json"),
            serde_json::json!([
                { "text": "{\"signal\":\"needs_input\"}" }
            ])
            .to_string(),
        )
        .unwrap();

        let mut teams = scan_teams(&base);
        assert_eq!(teams[0].members[0].status, MemberStatus::NeedsYou);

        // %9 is NOT in the live set → pane dropped, but NeedsYou survives.
        validate_pane_ids(&mut teams[0], &["%1".to_string()]);
        assert_eq!(teams[0].members[0].tmux_pane_id, None);
        assert_eq!(teams[0].members[0].status, MemberStatus::NeedsYou);

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn validate_pane_ids_drops_stale_and_demotes_to_offline() {
        let base = tmp();
        seed_team(&base, "squad");
        let mut teams = scan_teams(&base);
        // Only %1 is live; %2 (bob) is gone.
        validate_pane_ids(&mut teams[0], &["%1".to_string()]);
        let alice = teams[0].members.iter().find(|m| m.name == "alice").unwrap();
        let bob = teams[0].members.iter().find(|m| m.name == "bob").unwrap();
        assert_eq!(alice.tmux_pane_id.as_deref(), Some("%1"));
        assert_eq!(alice.status, MemberStatus::Working);
        // bob's %2 is gone → pane None + status Offline (was Idle).
        assert_eq!(bob.tmux_pane_id, None);
        assert_eq!(bob.status, MemberStatus::Offline);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn missing_teams_dir_yields_no_teams() {
        let base = tmp();
        assert!(scan_teams(&base).is_empty());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn unparseable_config_skips_only_that_team() {
        let base = tmp();
        seed_team(&base, "good");
        // A second team with a broken config.json.
        let bad = base.join("teams").join("bad");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join("config.json"), "not { json").unwrap();
        // A third team with an empty roster.
        let empty = base.join("teams").join("empty");
        fs::create_dir_all(&empty).unwrap();
        fs::write(
            empty.join("config.json"),
            serde_json::json!({ "leadSessionId": "x", "members": [] }).to_string(),
        )
        .unwrap();

        let teams = scan_teams(&base);
        assert_eq!(teams.len(), 1, "only the good team survives");
        assert_eq!(teams[0].team_name, "good");
        let _ = fs::remove_dir_all(base);
    }

    // ── FIX-TEAMS bug 1: phantom "team-lead" chip ───────────────────────────────
    // Ground truth (~/.claude/teams/viral-news-hunt/config.json on the live
    // server) showed Claude writes the LEAD as members[0] with
    // agentType="orchestrator", tmuxPaneId="", and the team's leadAgentId
    // pointing at it. The scan must filter that row OUT — the lead already
    // renders as the SessionTile via `lead_supermux_session`, so listing it
    // again as a teammate chip is the duplicate the user reported.

    #[test]
    fn lead_member_filtered_by_lead_agent_id_match() {
        let base = tmp();
        let tdir = base.join("teams").join("vh");
        fs::create_dir_all(tdir.join("inboxes")).unwrap();
        let config = serde_json::json!({
            "leadSessionId": "8a7e1f9e-10f5-4e9c-a9de-29201ec5708f",
            "leadAgentId": "team-lead@vh",
            "members": [
                // The phantom orchestrator row — must be filtered.
                { "name": "team-lead", "agentId": "team-lead@vh",
                  "agentType": "orchestrator", "tmuxPaneId": "", "cwd": "/p",
                  "model": "claude-opus-4-7" },
                // A real teammate — must survive.
                { "name": "data-hunter", "agentId": "data-hunter@vh",
                  "agentType": "claude", "tmuxPaneId": "%123", "color": "blue",
                  "isActive": true, "backendType": "tmux", "cwd": "/p",
                  "model": "claude-opus-4-7" }
            ]
        });
        fs::write(tdir.join("config.json"), config.to_string()).unwrap();

        let teams = scan_teams(&base);
        assert_eq!(teams.len(), 1);
        let t = &teams[0];
        assert_eq!(t.members.len(), 1, "phantom lead row filtered out");
        assert_eq!(t.members[0].name, "data-hunter");
        // Real teammate carries its cwd onto the supermux Member (for the
        // host-session cwd-match fallback in the watcher).
        assert_eq!(t.members[0].cwd, "/p");

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn lead_member_filtered_by_orchestrator_role_when_no_lead_agent_id() {
        // Defensive: even without `leadAgentId`, the agentType=orchestrator
        // marker filters the row — schema-drift safety.
        let base = tmp();
        let tdir = base.join("teams").join("sq");
        fs::create_dir_all(tdir.join("inboxes")).unwrap();
        let config = serde_json::json!({
            "leadSessionId": "any-uuid",
            "members": [
                { "name": "boss", "agentId": "boss@sq",
                  "agentType": "orchestrator", "tmuxPaneId": "" },
                { "name": "alice", "agentId": "alice@sq",
                  "agentType": "claude", "tmuxPaneId": "%1",
                  "isActive": true, "backendType": "tmux" }
            ]
        });
        fs::write(tdir.join("config.json"), config.to_string()).unwrap();
        let teams = scan_teams(&base);
        assert_eq!(teams[0].members.len(), 1);
        assert_eq!(teams[0].members[0].name, "alice");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn lead_member_filtered_by_structural_blanks_fallback() {
        // Pure forward-drift fallback: no leadAgentId, no agentType, but the
        // row has no pane / backend / color (the lead's signature shape). It's
        // filtered — a real teammate would carry at least one of those.
        let base = tmp();
        let tdir = base.join("teams").join("sq2");
        fs::create_dir_all(tdir.join("inboxes")).unwrap();
        let config = serde_json::json!({
            "leadSessionId": "x",
            "members": [
                { "name": "lead-ish", "agentId": "lead-ish@sq2" },
                { "name": "bob", "agentId": "bob@sq2",
                  "tmuxPaneId": "%2", "color": "red", "backendType": "tmux",
                  "isActive": true }
            ]
        });
        fs::write(tdir.join("config.json"), config.to_string()).unwrap();
        let teams = scan_teams(&base);
        assert_eq!(teams[0].members.len(), 1);
        assert_eq!(teams[0].members[0].name, "bob");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn unspawned_real_teammate_is_not_filtered_as_lead() {
        // A teammate written into config BEFORE its pane spawns (no tmuxPaneId
        // yet) but WITH a color or backendType is still a real teammate —
        // the structural fallback only fires when ALL three are blank.
        let base = tmp();
        let tdir = base.join("teams").join("sq3");
        fs::create_dir_all(tdir.join("inboxes")).unwrap();
        let config = serde_json::json!({
            "leadSessionId": "x",
            "members": [
                { "name": "starting", "agentId": "starting@sq3",
                  "tmuxPaneId": "", "color": "blue", "isActive": false }
            ]
        });
        fs::write(tdir.join("config.json"), config.to_string()).unwrap();
        let teams = scan_teams(&base);
        assert_eq!(teams[0].members.len(), 1, "unspawned teammate kept");
        assert_eq!(teams[0].members[0].name, "starting");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn map_lead_session_records_resolver_result() {
        let base = tmp();
        seed_team(&base, "squad");
        let mut teams = scan_teams(&base);
        map_lead_session(&mut teams[0], |_| Some("worker-1".to_string()));
        assert_eq!(teams[0].lead_supermux_session.as_deref(), Some("worker-1"));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn signal_classification_prefers_needs_you() {
        assert_eq!(parse_signal("{\"type\":\"idle\"}"), Some(InboxSignal::Idle));
        assert_eq!(
            parse_signal("{\"type\":\"needs_input\"}"),
            Some(InboxSignal::NeedsYou)
        );
        assert_eq!(
            parse_signal("{\"type\":\"shutdown\"}"),
            Some(InboxSignal::Shutdown)
        );
        // Plain chat → no signal.
        assert_eq!(parse_signal("hey can you look at this"), None);
        // Substring fallback when not valid JSON — short control-shaped text.
        assert_eq!(parse_signal("agent is now idle"), Some(InboxSignal::Idle));
    }

    /// Regression: a multi-paragraph teammate brief from the lead routinely
    /// contains words like "shutdown" ("do NOT request shutdown"), "waiting",
    /// "blocked". Before the length gate, parse_signal substring-matched these
    /// and demoted the live teammate to Offline / NeedsYou. The gate ensures
    /// long bodies fall through to None and the member's status is derived
    /// from is_active + task progress instead.
    #[test]
    fn signal_ignores_long_brief_that_mentions_signal_words() {
        let brief = "You are tokio-scout on team rust-async-research. Your library: \
                     tokio. Angle you own: runtime internals — scheduler, work-stealing, \
                     reactor. Run 10 iterations × 30s: print time, share one fact, sleep. \
                     Stay alive — do NOT request shutdown. The lead will shut you down \
                     explicitly. Begin now and stream output to your pane.";
        assert!(brief.len() > 80, "test fixture must be long enough to exercise the gate");
        assert_eq!(
            parse_signal(brief),
            None,
            "long brief mentioning 'shutdown' must not be misclassified as Shutdown",
        );

        // A teammate's task_assignment JSON likewise should not match.
        let task_msg = r#"{"type":"task_assignment","taskId":"1","subject":"Research tokio runtime","description":"Owner: tokio-scout. Run 10 iterations × 30s, then deliver a 200-word brief and SendMessage."}"#;
        assert_eq!(parse_signal(task_msg), None);

        // Short JSON-shaped signals still classify (these are the real wire format).
        assert_eq!(
            parse_signal("{\"type\":\"shutdown\"}"),
            Some(InboxSignal::Shutdown),
        );
    }
}

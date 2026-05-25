//! Claude Code **Agent Teams** on-disk config reader (Agent Teams plan §3.2/§3.5,
//! milestone AT-E).
//!
//! A Claude "agent team" is a LEAD session that spawns N teammate Claude sessions
//! as sibling tmux split-window PANES inside the lead's window. Claude Code writes
//! the team layout to `~/.claude/teams/{team}/config.json` regardless of supermux
//! env — that file is the SOURCE OF TRUTH for `members[].tmuxPaneId`, the team's
//! `leadSessionId`, and per-member metadata.
//!
//! This module resolves a `(team, member)` to its current tmux pane id (`%id`) and
//! the LEAD's bare supermux session name, then VALIDATES the `%id` still lives in
//! the lead's window before anyone streams it — tmux pane ids are a reused
//! server-global counter, so a freed `%id` can be re-handed to an unrelated pane.
//! Never cache a `%id`: re-read on every resolve (the plan's "re-read every tick"
//! rule, applied per-attach here).
//!
//! Everything here is DEFENSIVE: this is an experimental Claude Code feature whose
//! schema may drift, so unknown fields are ignored (`serde` default) and any parse
//! failure becomes a clean `Err`, never a panic.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use super::tmux;

/// One teammate as recorded in `config.json` `members[]`. Only the fields AT-E
/// needs are typed; the rest of the (drift-prone) schema is ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct TeamMember {
    /// The member's stable name/id within the team (matches the `{member}` URL
    /// segment). Claude may key this as `name` or `id` depending on version, so
    /// both are accepted (see [`TeamMember::matches`]).
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    /// The tmux pane id (`%id`) of this teammate's split-window pane. Absent for
    /// an `in-process` teammate (which has no pane — supermux forces `tmux` mode,
    /// so a live team's members should carry this).
    #[serde(rename = "tmuxPaneId", default)]
    pub tmux_pane_id: Option<String>,
}

impl TeamMember {
    /// Does this member match the requested `member` key (by `name` OR `id`)?
    fn matches(&self, member: &str) -> bool {
        self.name.as_deref() == Some(member) || self.id.as_deref() == Some(member)
    }

    /// The display/key for this member (prefers `name`, falls back to `id`).
    pub fn key(&self) -> Option<&str> {
        self.name.as_deref().or(self.id.as_deref())
    }
}

/// The shape of `~/.claude/teams/{team}/config.json` AT-E reads. Drift-tolerant:
/// unknown top-level fields are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct TeamConfig {
    /// The lead Claude session id. supermux maps this to a `supermux-<name>`
    /// session; see [`lead_session`](Self::lead_session) for the resolution.
    #[serde(rename = "leadSessionId", default)]
    pub lead_session_id: Option<String>,
    /// Some Claude versions record the lead under a different key — accept either.
    #[serde(rename = "leadName", default)]
    pub lead_name: Option<String>,
    #[serde(default)]
    pub members: Vec<TeamMember>,
}

impl TeamConfig {
    /// The lead's BARE supermux session name (no `supermux-` prefix). supermux
    /// runs the lead inside `supermux-<name>`, so the lead session id Claude
    /// records IS the bare name we validate panes against. Prefer `leadSessionId`,
    /// fall back to `leadName`.
    pub fn lead_session(&self) -> Option<&str> {
        self.lead_session_id
            .as_deref()
            .or(self.lead_name.as_deref())
    }

    /// Find the member by key (`name` or `id`).
    pub fn member(&self, member: &str) -> Option<&TeamMember> {
        self.members.iter().find(|m| m.matches(member))
    }
}

/// `~/.claude` (honouring `CLAUDE_CONFIG_DIR`), mirroring `claude_config` /
/// `resumable`'s resolution so a custom config dir is respected uniformly.
fn claude_config_dir() -> PathBuf {
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

/// Path to a team's config: `~/.claude/teams/{team}/config.json`.
pub fn team_config_path(team: &str) -> PathBuf {
    claude_config_dir()
        .join("teams")
        .join(team)
        .join("config.json")
}

/// Read + parse `~/.claude/teams/{team}/config.json`. Defensive: a missing file
/// or malformed JSON is an `Err` (callers surface it as a clean WS close), never
/// a panic. NEVER cached — read fresh so a `%id` is always current.
pub fn read_team_config(team: &str) -> Result<TeamConfig> {
    let path = team_config_path(team);
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("reading team config {}", path.display()))?;
    serde_json::from_str::<TeamConfig>(&raw)
        .with_context(|| format!("parsing team config {}", path.display()))
}

/// A resolved + VALIDATED teammate pane, ready to stream.
#[derive(Debug, Clone)]
pub struct ResolvedPane {
    /// The lead's bare supermux session name (window the pane lives in).
    pub lead_session: String,
    /// The validated tmux pane id (`%id`).
    pub pane_id: String,
}

impl ResolvedPane {
    /// The pane-unique STREAM KEY for the registry + FIFO/log basenames:
    /// `{lead}/{member}`. Distinct per teammate, stable across the team's life,
    /// and (after the streamer's sanitize) a safe flat filename.
    pub fn stream_key(&self, member: &str) -> String {
        format!("{}/{}", self.lead_session, member)
    }
}

/// Resolve `(team, member)` → a live, validated [`ResolvedPane`] (Agent Teams
/// §3.2/§3.5). Steps, in order:
///   1. Read `config.json` FRESH (never cached — pane ids are reused).
///   2. Resolve the member's `tmuxPaneId` and the team's lead session.
///   3. VALIDATE the `%id` still exists in the lead's window
///      (`tmux list-panes -t supermux-<lead>`) — a stale id is refused, never
///      streamed.
///
/// `pane_override` lets a caller (e.g. AT-F2's frontend, which already has the
/// `%id` from the team model/SSE) skip config parsing for the pane id while still
/// going through validation — but the lead session must come from config either
/// way (it's what we validate membership against).
pub async fn resolve_member_pane(
    team: &str,
    member: &str,
    pane_override: Option<&str>,
) -> Result<ResolvedPane> {
    let cfg = read_team_config(team)?;
    let lead = cfg
        .lead_session()
        .ok_or_else(|| anyhow!("team '{team}' config has no lead session id"))?
        .to_string();

    let pane_id = match pane_override {
        Some(p) if !p.trim().is_empty() => p.trim().to_string(),
        _ => cfg
            .member(member)
            .and_then(|m| m.tmux_pane_id.clone())
            .ok_or_else(|| {
                anyhow!("team '{team}' member '{member}' has no tmuxPaneId (in-process or absent)")
            })?,
    };

    // Validate against the LEAD's live window — a reused/stale id is refused.
    if !tmux::pane_in_session(&lead, &pane_id)
        .await
        .with_context(|| format!("validating pane {pane_id} in lead session {lead}"))?
    {
        return Err(anyhow!(
            "pane '{pane_id}' is not present in lead session '{lead}' (stale id or pane gone)"
        ));
    }

    Ok(ResolvedPane {
        lead_session: lead,
        pane_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_config_and_resolves_member_fields() {
        // The drift-tolerant parse: extra fields ignored, member found by `name`,
        // pane id + lead session extracted.
        let json = r#"{
            "leadSessionId": "myproj",
            "someUnknownFutureField": 42,
            "members": [
                {"name": "worker-1", "tmuxPaneId": "%17", "color": "blue"},
                {"name": "worker-2", "tmuxPaneId": "%18"}
            ]
        }"#;
        let cfg: TeamConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.lead_session(), Some("myproj"));
        let m = cfg.member("worker-1").unwrap();
        assert_eq!(m.tmux_pane_id.as_deref(), Some("%17"));
        assert!(cfg.member("nope").is_none());
    }

    #[test]
    fn member_matches_by_id_when_name_absent() {
        let json = r#"{"leadName":"lead","members":[{"id":"m1","tmuxPaneId":"%3"}]}"#;
        let cfg: TeamConfig = serde_json::from_str(json).unwrap();
        // lead falls back to leadName; member matches by id.
        assert_eq!(cfg.lead_session(), Some("lead"));
        assert_eq!(cfg.member("m1").unwrap().tmux_pane_id.as_deref(), Some("%3"));
    }

    #[test]
    fn stream_key_is_lead_slash_member() {
        let rp = ResolvedPane {
            lead_session: "teamA".into(),
            pane_id: "%9".into(),
        };
        assert_eq!(rp.stream_key("worker-1"), "teamA/worker-1");
    }

    #[test]
    fn missing_members_default_to_empty() {
        // A config with no members array still parses (defensive default).
        let cfg: TeamConfig = serde_json::from_str(r#"{"leadSessionId":"x"}"#).unwrap();
        assert!(cfg.members.is_empty());
    }
}

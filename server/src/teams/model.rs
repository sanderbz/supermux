//! On-disk Agent-Teams file schema + the supermux in-memory team model (AT-B
//! §3.2/§3.3).
//!
//! Claude Code writes these files under `~/.claude` REGARDLESS of supermux —
//! they are the authoritative source of truth for a team's membership, tasks,
//! and per-member liveness (teammate panes are spawned by Claude Code's
//! `split-window`, so they have NO supermux hook token / DB row and could never
//! authenticate a hook; §3.4). supermux reads these files, never writes them.
//!
//! **Defensive by construction.** Every deserialized struct uses `serde`
//! defaults so a partial/old/forward-drifted file parses into a best-effort
//! value instead of erroring — an experimental Claude feature WILL drift its
//! schema, and a single malformed field must never blank a whole team
//! (§3 "skip that team/member, never panic"). Unknown fields are ignored.

use serde::{Deserialize, Serialize};

// ── on-disk schema (what Claude Code writes) ──────────────────────────────────

/// `~/.claude/teams/{sanitized}/config.json` — the team roster Claude Code
/// writes when a lead spawns teammates. Only the fields supermux consumes are
/// modeled; everything else is ignored (`serde` drops unknown keys by default).
///
/// Claude Code writes camelCase JSON (`leadSessionId`, `tmuxPaneId`, …); the
/// `rename_all` keeps our snake_case Rust fields aligned to it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTeamConfig {
    /// The lead Claude session id. One of the team→lead mapping handles (§3.2).
    #[serde(default)]
    pub lead_session_id: String,
    /// The lead's agent id, e.g. `"team-lead@viral-news-hunt"` — Claude writes
    /// the LEAD into `members[]` as an orchestrator entry alongside the real
    /// teammates. We filter it out when materializing the supermux roster (it
    /// already renders as the full SessionTile via `lead_supermux_session`;
    /// surfacing it AGAIN as a chip is the phantom-chip bug from FIX-TEAMS).
    #[serde(default)]
    pub lead_agent_id: String,
    /// The team's roster. A missing/absent array → an empty team (skipped).
    #[serde(default)]
    pub members: Vec<RawMember>,
}

/// One `members[]` entry from `config.json`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawMember {
    #[serde(default)]
    pub name: String,
    /// `"{name}@{team}"` per Claude Code's convention.
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub color: String,
    /// The tmux pane id, e.g. `"%1"`. A server-global REUSED counter — never
    /// cached across ticks; validated against the lead's live panes each tick
    /// (§3.2). Empty/absent for an in-process or not-yet-spawned member.
    #[serde(default)]
    pub tmux_pane_id: String,
    /// Working directory of the teammate.
    #[serde(default)]
    pub cwd: String,
    /// Claude Code's own liveness flag for the member. Combined with the live
    /// `%id` check + the inbox idle/shutdown signal to derive `status` (§3.3).
    #[serde(default)]
    pub is_active: bool,
    /// `"claude"` etc. Surfaced as-is; we don't gate on it.
    #[serde(default)]
    pub backend_type: String,
    /// Claude's role marker. The LEAD row carries `"team-lead"` (verified on CC
    /// 2.1.156 from a live `config.json`; other builds wrote `"orchestrator"` or
    /// `"leader"`) and is filtered out of the roster — it already renders as the
    /// SessionTile, not a teammate chip (FIX-TEAMS bug 1). Real teammates carry
    /// NO `agentType` field at all (absent → ""). All lead spellings are accepted,
    /// used belt-and-braces alongside the `agent_id == lead_agent_id` filter for
    /// forward-compat with schema drift.
    #[serde(default)]
    pub agent_type: String,
}

/// `~/.claude/tasks/{team}/NN.json` — one shared task. supermux mirrors these
/// read-only for the roll-up + (later) the team board. camelCase to match
/// Claude's `blockedBy`; the assignee aliases cover its naming drift.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTask {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub description: String,
    /// `pending` | `in_progress` | `completed` (other strings pass through).
    #[serde(default)]
    pub status: String,
    /// The member name/agent this task is assigned to, when Claude records it.
    /// Field name varies across Claude versions; accept the common spellings.
    #[serde(default, alias = "assignee", alias = "assigned_to", alias = "owner")]
    pub assigned_to: String,
    #[serde(default)]
    pub blocks: Vec<String>,
    #[serde(default)]
    pub blocked_by: Vec<String>,
}

/// One `~/.claude/teams/{team}/inboxes/{member}.json` array entry. The idle /
/// shutdown SIGNAL is JSON ENCODED INSIDE `text` (§3.3) — we parse `text`
/// leniently for it; a plain chat line just has no signal.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawInboxMessage {
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub read: bool,
}

// ── supermux model (the DTO the SSE / GET /api/teams serve) ────────────────────

/// A member's derived live status (§3.3). Wire token is snake_case so the
/// frontend can switch on a stable string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberStatus {
    /// Active AND has an in-progress task (or active with no idle signal).
    Working,
    /// Active but signalled idle (idle JSON in its inbox), or active-no-task.
    Idle,
    /// A needs-input signal in the inbox — the one loud, attention-first state.
    NeedsYou,
    /// `is_active=false` or its `%id` is gone — no live status to trust.
    Offline,
}

impl Default for MemberStatus {
    fn default() -> Self {
        MemberStatus::Offline
    }
}

/// One resolved team member (the SSE/API shape).
#[derive(Debug, Clone, Serialize)]
pub struct Member {
    pub name: String,
    pub agent_id: String,
    pub model: String,
    pub color: String,
    /// The tmux pane id from config.json (`%1`). Re-read every tick; `None` when
    /// absent in config OR not present in the lead's live panes this tick (§3.2).
    pub tmux_pane_id: Option<String>,
    /// Claude Code's roster liveness flag, surfaced verbatim.
    pub is_active: bool,
    /// Derived live status (§3.3).
    pub status: MemberStatus,
    /// The member's working directory (raw, from config.json). Server-side
    /// signal only — used by the host-session resolver to match teammates to
    /// the supermux session whose `dir` they live under (FIX-TEAMS bug 2,
    /// when `leadSessionId` is a Claude UUID rather than the supermux name).
    /// Empty when absent; not currently surfaced in the wire response shape.
    #[serde(skip_serializing)]
    pub cwd: String,
}

/// One shared task (the SSE/API shape).
#[derive(Debug, Clone, Serialize)]
pub struct TeamTask {
    pub id: String,
    pub subject: String,
    pub description: String,
    pub status: String,
    pub assigned_to: String,
    pub blocks: Vec<String>,
    pub blocked_by: Vec<String>,
}

/// A fully-resolved team — the unit supermux broadcasts + serves.
#[derive(Debug, Clone, Serialize)]
pub struct Team {
    /// The sanitized team directory name (`~/.claude/teams/<team_name>/`).
    pub team_name: String,
    /// The lead Claude session id (config.json `leadSessionId`). Per FIX-TEAMS
    /// ground truth this is a Claude UUID (not the supermux session name), so
    /// it is NOT directly the host session — see [`Self::lead_supermux_session`].
    pub lead_session: String,
    /// The supermux session that hosts the lead, when we could map it
    /// (`supermux-<name>`); `None` when unmapped (§3.2 — still surfaced).
    pub lead_supermux_session: Option<String>,
    pub members: Vec<Member>,
    pub tasks: Vec<TeamTask>,
}

impl From<RawTask> for TeamTask {
    fn from(r: RawTask) -> Self {
        TeamTask {
            id: r.id,
            subject: r.subject,
            description: r.description,
            status: r.status,
            assigned_to: r.assigned_to,
            blocks: r.blocks,
            blocked_by: r.blocked_by,
        }
    }
}

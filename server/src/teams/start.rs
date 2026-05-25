//! "Start a team" — spin up a Claude Agent-Teams LEAD session from supermux
//! (AT-D, plan §10d / §11-D).
//!
//! ## Why this is lead-driven (the research finding)
//! Claude Code (v2.1.x, the version supermux ships against) has **no CLI flag or
//! config to pre-seed a team roster** — there is no `--team`, no `--teammates`,
//! no members JSON. The only documented way a team forms is **in-conversation**:
//! the LEAD session uses its built-in agent-team tools to spawn teammates, which
//! Claude Code lands as `tmux split-window` panes (when `teammateMode:"tmux"`)
//! and records under `~/.claude/teams/<team>/config.json`. (`claude --agents
//! <json>` defines custom *subagent prompts*, NOT a persistent tmux team; and
//! `claude agents` is the background-session manager, also not a team pre-seed.)
//!
//! So the robust mechanism that works **today** is: create a normal Claude LEAD
//! session with Agent Teams ENABLED for it, boot it, and send a **seed prompt**
//! that instructs the lead to form a team of N teammates (with the requested
//! goal and, optionally, a per-teammate model). Detection (AT-B) then picks the
//! team up from the on-disk files and the TEAM CARD (AT-F1) renders it. This
//! module owns ONLY the start flow; it never writes team files itself.
//!
//! ## How the per-session enable works (coordinating with AT-B's gating)
//! AT-B gates the env injection on the GLOBAL `experimental.agent_teams` pref.
//! "Start a team" is an EXPLICIT opt-in, so we set a per-session override flag
//! ([`AppState::set_force_agent_teams`]) BEFORE booting the lead; `lifecycle::start`
//! reads `global_pref OR force_flag`, so the lead gets
//! `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `teammateMode:"tmux"` even while the
//! global pref is OFF — without duplicating or fighting AT-B's mechanism.

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::sessions::{self, lifecycle, CreateInput, SessionView};
use crate::state::AppState;

/// Hard bounds on the teammate count so a typo / hostile client can't ask the
/// lead to fork an absurd number of real Claude processes (each ≈ the ~7× cost
/// the plan surfaces calmly). The lead itself is the +1.
const MIN_TEAMMATES: u32 = 1;
const MAX_TEAMMATES: u32 = 8;
/// Default when the client omits a count (a small, sane crew).
const DEFAULT_TEAMMATES: u32 = 3;

/// `POST /api/teams/start` body. All fields but `task` are optional.
#[derive(Debug, Clone, Deserialize)]
pub struct StartTeamInput {
    /// The team's goal / intent. Becomes the heart of the seed prompt. Required.
    pub task: String,
    /// How many TEAMMATES the lead should spawn (the lead is extra). Clamped to
    /// [`MIN_TEAMMATES`]..=[`MAX_TEAMMATES`]; defaults to [`DEFAULT_TEAMMATES`].
    #[serde(default)]
    pub teammates: Option<u32>,
    /// Optional model alias applied to EVERY teammate (e.g. `"opus"`, `"sonnet"`,
    /// a full model id). Threaded into the seed prompt as guidance; trimmed +
    /// length-bounded. `None`/blank ⇒ let the lead pick the default.
    #[serde(default)]
    pub model: Option<String>,
    /// Optional working directory for the lead (defaults to the server home, as
    /// the normal create path does). The team's panes inherit the lead's cwd.
    #[serde(default)]
    pub dir: Option<String>,
    /// Optional explicit lead session name. When omitted a unique
    /// `team-<suffix>` name is generated. Validated like any session name.
    #[serde(default)]
    pub name: Option<String>,
}

/// `POST /api/teams/start` success payload: the created LEAD [`SessionView`] (so
/// the UI can navigate to `/focus/<name>`) plus the resolved teammate count and a
/// `team: true` marker.
#[derive(Debug, Serialize)]
pub struct StartTeamResult {
    pub team: bool,
    /// Resolved (clamped) teammate count actually requested of the lead.
    pub teammates: u32,
    /// The LEAD session — reuse the normal session view so the client can route
    /// to it exactly like any freshly-created session.
    pub lead: SessionView,
}

/// Clamp + default the requested teammate count.
fn resolve_teammates(requested: Option<u32>) -> u32 {
    requested
        .unwrap_or(DEFAULT_TEAMMATES)
        .clamp(MIN_TEAMMATES, MAX_TEAMMATES)
}

/// Sanitize the optional per-teammate model: trim, drop if empty, bound length
/// (model aliases/ids are short — a long value is almost certainly junk and we
/// never want it spliced into the prompt). Only a conservative char set is kept
/// so the value can be safely embedded in the seed-prompt text.
fn sanitize_model(model: Option<&str>) -> Option<String> {
    let m = model?.trim();
    if m.is_empty() || m.len() > 64 {
        return None;
    }
    if m.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
    {
        Some(m.to_string())
    } else {
        None
    }
}

/// Build the seed prompt that instructs the LEAD to form the team. Kept plain,
/// imperative, and provider-agnostic so it works with whatever team tooling the
/// installed Claude Code exposes (the lead reads its own tools at runtime). The
/// `task` is the user's goal verbatim; `teammates` and the optional `model` are
/// the structured asks.
pub fn build_seed_prompt(task: &str, teammates: u32, model: Option<&str>) -> String {
    let task = task.trim();
    let model_line = match model {
        Some(m) => format!(" Use the model `{m}` for each teammate."),
        None => String::new(),
    };
    format!(
        "You are the LEAD of an agent team. Form a team of {teammates} teammate{plural} \
         to work on this goal together:\n\n{task}\n\n\
         Create the {teammates} teammate{plural} now using your agent-team tools, give each a \
         clear role and an initial task toward the goal, then coordinate them to completion.{model_line}",
        teammates = teammates,
        plural = if teammates == 1 { "" } else { "s" },
        task = task,
        model_line = model_line,
    )
}

/// Generate a unique-ish lead session name (`team-<6 base36>`). The caller
/// re-checks existence via `sessions::create`, which 409s on a collision.
fn gen_team_name() -> String {
    let suffix: String = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(6)
        .collect();
    format!("team-{suffix}")
}

/// Start a team: create the LEAD session (provider=claude), flag it for Agent
/// Teams (per-session opt-in, even if the global pref is OFF), boot it, and send
/// the seed prompt that tells it to form the team.
///
/// Defensive: the goal must be non-empty; the count is clamped; a name collision
/// surfaces as the create path's 409. The lead is created BEFORE the force-flag is
/// set and BEFORE boot so a half-failed start leaves a normal (startable) session
/// row, not a wedged one.
pub async fn start_team(
    state: &AppState,
    input: StartTeamInput,
) -> Result<StartTeamResult, AppError> {
    let task = input.task.trim().to_string();
    if task.is_empty() {
        return Err(AppError::BadRequest(
            "a team needs a goal — `task` must not be empty".into(),
        ));
    }
    if task.len() > 8_000 {
        return Err(AppError::BadRequest(
            "team goal is too long (max 8000 chars)".into(),
        ));
    }

    let teammates = resolve_teammates(input.teammates);
    let model = sanitize_model(input.model.as_deref());

    let name = match input.name.as_deref().map(str::trim) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => gen_team_name(),
    };

    // 1. Create the LEAD as a normal Claude session (reuses `sessions::create` —
    //    name validation, runtime+hook-token seeding, detector + steering loops).
    let lead = sessions::create(
        state,
        CreateInput {
            name: name.clone(),
            dir: input.dir,
            desc: Some(format!("Team lead — {}", short_desc(&task))),
            provider: Some("claude".into()),
            creator: Some("team".into()),
            flags: None,
            tags: Some(vec!["team".into()]),
            branch: None,
            mcp: None,
            worktree: None,
        },
    )
    .await?;

    // 2. Per-session opt-in: this lead gets the Agent Teams env at boot even if
    //    the global `experimental.agent_teams` pref is OFF (AT-D explicit opt-in;
    //    `lifecycle::start` ORs this flag with the global pref). Set BEFORE start.
    state.set_force_agent_teams(&lead.name);

    // 3. Boot the lead and send the seed prompt that forms the team. `start`
    //    injects `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + writes
    //    `teammateMode:"tmux"` (because the force flag is now set), waits for the
    //    agent UI, then delivers the prompt.
    let seed = build_seed_prompt(&task, teammates, model.as_deref());
    lifecycle::start(state, &lead.name, Some(&seed)).await?;

    // Re-read the lead view so the client gets the post-boot status (the create
    // view was captured before boot). Non-fatal: fall back to the create view.
    let lead = sessions::get(state, &lead.name).await.unwrap_or(lead);

    Ok(StartTeamResult {
        team: true,
        teammates,
        lead,
    })
}

/// A short single-line description from the (possibly multi-line) goal for the
/// session row's `desc`.
fn short_desc(task: &str) -> String {
    let first = task.lines().next().unwrap_or("").trim();
    if first.chars().count() > 60 {
        let truncated: String = first.chars().take(57).collect();
        format!("{truncated}…")
    } else {
        first.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teammate_count_is_clamped_and_defaulted() {
        assert_eq!(resolve_teammates(None), DEFAULT_TEAMMATES);
        assert_eq!(resolve_teammates(Some(0)), MIN_TEAMMATES);
        assert_eq!(resolve_teammates(Some(1)), 1);
        assert_eq!(resolve_teammates(Some(4)), 4);
        assert_eq!(resolve_teammates(Some(99)), MAX_TEAMMATES);
    }

    #[test]
    fn model_is_sanitized() {
        assert_eq!(sanitize_model(Some("opus")), Some("opus".into()));
        assert_eq!(sanitize_model(Some("claude-sonnet-4-6")), Some("claude-sonnet-4-6".into()));
        assert_eq!(sanitize_model(Some("  sonnet  ")), Some("sonnet".into()));
        assert_eq!(sanitize_model(None), None);
        assert_eq!(sanitize_model(Some("")), None);
        assert_eq!(sanitize_model(Some("   ")), None);
        // Reject prompt-injection-y / shell-y values.
        assert_eq!(sanitize_model(Some("opus; rm -rf /")), None);
        assert_eq!(sanitize_model(Some("a model with spaces")), None);
        // Over-length junk rejected.
        assert_eq!(sanitize_model(Some(&"x".repeat(100))), None);
    }

    #[test]
    fn seed_prompt_contains_goal_and_count() {
        let p = build_seed_prompt("ship the redesign", 3, None);
        assert!(p.contains("ship the redesign"), "goal must be present");
        assert!(p.contains("team of 3 teammates"), "count must be present (plural)");
        assert!(!p.contains("model `"), "no model line when model is None");
    }

    #[test]
    fn seed_prompt_singular_and_model() {
        let p = build_seed_prompt("do a thing", 1, Some("opus"));
        assert!(p.contains("team of 1 teammate "), "singular phrasing for 1");
        assert!(p.contains("model `opus`"), "model guidance included");
    }

    #[test]
    fn seed_prompt_trims_goal() {
        let p = build_seed_prompt("   spaced goal   ", 2, None);
        assert!(p.contains("\nspaced goal\n"), "goal is trimmed");
    }

    #[test]
    fn short_desc_truncates_long_first_line() {
        let long = "a".repeat(100);
        let d = short_desc(&long);
        assert!(d.ends_with('…'));
        assert!(d.chars().count() <= 58);
    }

    #[test]
    fn gen_team_name_is_valid_and_prefixed() {
        let n = gen_team_name();
        assert!(n.starts_with("team-"));
        assert!(crate::sessions::valid_name(&n), "generated name must be a valid session name");
    }
}

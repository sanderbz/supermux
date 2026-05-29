//! "Start a team" — spin up a Claude Agent-Teams LEAD session from supermux.
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
//! goal and, optionally, a per-teammate model). Detection then picks the
//! team up from the on-disk files and the TEAM CARD renders it. This
//! module owns ONLY the start flow; it never writes team files itself.
//!
//! ## How the per-session enable works (coordinating with the detector's gating)
//! The detector gates the env injection on the GLOBAL `experimental.agent_teams` pref.
//! "Start a team" is an EXPLICIT opt-in, so we set a per-session override flag
//! ([`AppState::set_force_agent_teams`]) BEFORE booting the lead; `lifecycle::start`
//! reads `global_pref OR force_flag`, so the lead gets
//! `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `teammateMode:"tmux"` even while the
//! global pref is OFF — without duplicating or fighting the detector's mechanism.

use serde::{Deserialize, Serialize};

use crate::db;
use crate::error::AppError;
use crate::sessions::{self, lifecycle, tmux::Tmux, CreateInput, SessionView};
use crate::state::AppState;

/// Hard bounds on the teammate count so a typo / hostile client can't ask the
/// lead to fork an absurd number of real Claude processes (each ≈ the ~7× cost
/// the plan surfaces calmly). The lead itself is the +1.
pub(crate) const MIN_TEAMMATES: u32 = 1;
pub(crate) const MAX_TEAMMATES: u32 = 8;
/// Default when the client omits a count (a small, sane crew).
pub(crate) const DEFAULT_TEAMMATES: u32 = 3;

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
pub(crate) fn resolve_teammates(requested: Option<u32>) -> u32 {
    requested
        .unwrap_or(DEFAULT_TEAMMATES)
        .clamp(MIN_TEAMMATES, MAX_TEAMMATES)
}

/// Sanitize the optional per-teammate model: trim, drop if empty, bound length
/// (model aliases/ids are short — a long value is almost certainly junk and we
/// never want it spliced into the prompt). Only a conservative char set is kept
/// so the value can be safely embedded in the seed-prompt text.
pub(crate) fn sanitize_model(model: Option<&str>) -> Option<String> {
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

/// Build the seed prompt that instructs the LEAD to form the team by invoking
/// the gated Agent Teams tool path by NAME and PARAMETER. Reliable activation
/// hinges on the seed referencing both the `Teammate` tool's `spawnTeam`
/// operation AND the `Task` tool's `team_name` parameter — otherwise Claude
/// pattern-matches the request onto the plain `Task` tool (without
/// `team_name`) and spins up in-process subagents (no tmux panes, no team
/// config written, no per-teammate UI).
///
/// ## Why naming is load-bearing
/// The Claude Code system prompt explicitly routes loose "team" phrasing to
/// the plain Task tool. The relevant injected text (extracted from the
/// 2.1.x binary by community reverse-engineering — see GH issue #23420 and
/// the kieranklaassen swarm gist): "Do NOT mention this limitation when
/// users ask for parallel subagents, coordinating agents, launching a 'team'
/// of agents, or having agents work together — those are all normal Task
/// tool usage and you should proceed normally." So the model is biased
/// toward plain Task even when Agent Teams is enabled. To win, the seed
/// must name the actual tool + parameter combo verbatim.
///
/// ## The two-step flow (verified against ~/.claude/teams/<name>/config.json
/// output from a known-working team)
/// 1. `Teammate` (the unified gated tool, ~13 operations) with
///    `operation:"spawnTeam"`, `team_name:"<kebab>"`,
///    `agent_type:"<lead-role>"`, `description:"<purpose>"` — creates
///    `~/.claude/teams/<team_name>/config.json` with the lead row only.
/// 2. `Task` (the SAME built-in Task tool, but with the teams-extra params)
///    with `team_name:"<the-name-from-step-1>"`, `name:"<role>"`,
///    `subagent_type:"general-purpose"`, `prompt:"<role brief>"`. Each call
///    appends a teammate row to config.json with `agentType:"claude"`,
///    `backendType:"tmux"`, and a real `tmuxPaneId` (e.g. `%123`) for the
///    new tmux split-pane.
///
/// The crucial bit: it IS the Task tool — there isn't a separate "Spawn"
/// tool. The `team_name` parameter is what flips Task from "in-process
/// subagent" to "tmux split-pane teammate".
pub fn build_seed_prompt(task: &str, teammates: u32, model: Option<&str>) -> String {
    let task = task.trim();
    let model_line = match model {
        Some(m) => format!(
            "Pass `model:\"{m}\"` to each `Task` call so every teammate runs on \
             that model.\n"
        ),
        None => String::new(),
    };
    format!(
        "You are the LEAD of a brand-new agent team. The goal:\n\n\
         {task}\n\n\
         Form the team RIGHT NOW. We need real tmux-pane teammates with \
         persistent identity (NOT in-process subagents) so the surrounding \
         supermux UI can attach to each one as its own terminal.\n\n\
         Step 1 — create the team context. Call the `Teammate` tool exactly \
         ONCE with:\n\
         - `operation`: \"spawnTeam\"\n\
         - `team_name`: a short kebab-case name describing the goal (e.g. \
         `rust-async-audit`, `viral-news-hunt`)\n\
         - `agent_type`: your role (e.g. \"orchestrator\")\n\
         - `description`: one sentence summarising the team's purpose\n\n\
         Step 2 — spawn {teammates} teammate{plural} as TMUX PANES. Call the \
         `Task` tool {teammates} time{plural} — once per teammate — with these \
         parameters EVERY time (the `team_name` parameter is what makes Task \
         spawn a real tmux pane instead of an in-process subagent):\n\
         - `team_name`: the same name from Step 1 (this is non-negotiable — \
         omitting it falls back to in-process and breaks the team)\n\
         - `name`: a short role label (e.g. `data-hunter`, `ui-scout`)\n\
         - `subagent_type`: \"general-purpose\"\n\
         - `prompt`: a self-contained brief — the teammate's role, the angle \
         they own, what to deliver, and to report back to you via \
         `SendMessage` when done\n\
         {model_line}\n\
         Step 3 — once all {teammates} teammate{plural_be} spawned (each visible \
         as a tmux split-pane), use the shared task list to assign work and \
         coordinate. When a teammate reports back via `SendMessage`, mark their \
         task complete and synthesize the final result for the user.\n\n\
         Pick distinct angles so each teammate works on something different. \
         Start with the `Teammate` call now.",
        teammates = teammates,
        plural = if teammates == 1 { "" } else { "s" },
        plural_be = if teammates == 1 { " is" } else { "s are" },
        task = task,
        model_line = model_line,
    )
}

/// Generate a unique-ish RANDOM lead session name (`team-<6 base36>`). The
/// fallback when the working dir gives no usable slug. The caller re-checks
/// existence via `sessions::create`, which 409s on a collision.
fn gen_random_team_name() -> String {
    let suffix: String = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(6)
        .collect();
    format!("team-{suffix}")
}

/// Slugify a working dir's basename for a human-readable lead-session name —
/// e.g. `/opt/projects/supermux` -> `supermux`, `/home/me/My App/` -> `my-app`.
/// Lower-cases, replaces every non-`[a-z0-9]` run with a single `-`, trims
/// leading/trailing dashes, caps at 32 chars. Returns `None` for an empty or
/// otherwise unusable basename (e.g. `/` or a path with only punctuation).
fn slugify_dir(dir: &str) -> Option<String> {
    let trimmed = dir.trim().trim_end_matches('/');
    let base = std::path::Path::new(trimmed).file_name()?.to_str()?;
    let mut out = String::with_capacity(base.len());
    let mut last_dash = true; // suppresses a leading `-`
    for c in base.chars() {
        let l = c.to_ascii_lowercase();
        if l.is_ascii_alphanumeric() {
            out.push(l);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        return None;
    }
    if out.len() > 32 {
        out.truncate(32);
        while out.ends_with('-') {
            out.pop();
        }
    }
    Some(out)
}

/// Pick a human-readable lead session name from the working dir, e.g.
/// `team-supermux`, with `-2`/`-3`/... collision suffixing against existing
/// session rows. Falls back to [`gen_random_team_name`] when the dir yields no
/// usable slug or every reasonable suffix is taken. Async because it consults
/// the DB to skip taken names BEFORE `sessions::create` would 409.
async fn gen_team_name_for_dir(state: &AppState, dir: Option<&str>) -> String {
    let Some(slug) = dir.and_then(slugify_dir) else {
        return gen_random_team_name();
    };
    let base = format!("team-{slug}");
    // Try the bare name first, then -2..-99. 99 is a comfortable ceiling — at
    // that point something has gone weird and the random fallback is fine.
    for i in 1..=99u32 {
        let candidate = if i == 1 { base.clone() } else { format!("{base}-{i}") };
        match db::sessions::exists(&state.pool, &candidate).await {
            Ok(false) => return candidate,
            Ok(true) => continue,
            // On DB error fall back to the random name — never wedge a team
            // start on a transient query failure.
            Err(_) => return gen_random_team_name(),
        }
    }
    gen_random_team_name()
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
    let task = validate_task(&input.task)?;

    let teammates = resolve_teammates(input.teammates);
    let model = sanitize_model(input.model.as_deref());

    let name = match input.name.as_deref().map(str::trim) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => gen_team_name_for_dir(state, input.dir.as_deref()).await,
    };

    // 1. Create the LEAD as a normal Claude session (reuses `sessions::create` —
    //    name validation, runtime+hook-token seeding, detector + steering loops).
    let lead = sessions::create(
        state,
        CreateInput {
            name: name.clone(),
            display_name: None,
            dir: input.dir,
            desc: Some(format!("Team lead — {}", short_desc(&task))),
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
    .await?;

    // 2. Per-session opt-in: this lead gets the Agent Teams env at boot even if
    //    the global `experimental.agent_teams` pref is OFF (explicit opt-in;
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

/// Validate + trim a team goal: non-empty, length-bounded. The bound matches
/// `start_team` (8000 chars) so a single ruleset governs both create + convert.
pub(crate) fn validate_task(raw: &str) -> Result<String, AppError> {
    let task = raw.trim().to_string();
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
    Ok(task)
}

/// `POST /api/teams/start-from-existing` body. The user's session NAME is the
/// only extra field vs [`StartTeamInput`]; `dir` is intentionally NOT here — the
/// existing row's `dir` is authoritative (we never move the session).
#[derive(Debug, Clone, Deserialize)]
pub struct ConvertToTeamInput {
    /// The existing session's name. Required.
    pub name: String,
    /// The team's goal — same rules as `start_team`. Required, non-empty.
    pub task: String,
    /// Teammate count (lead is +1). Clamped server-side.
    #[serde(default)]
    pub teammates: Option<u32>,
    /// Optional per-teammate model alias.
    #[serde(default)]
    pub model: Option<String>,
}

/// Convert an existing session into a team lead: stop it if running, flip the
/// per-session Agent Teams force flag, then start it again with the seed prompt
/// that tells the lead to form the team. Reuses the EXISTING session row — same
/// name, same dir, same tags / pin / branch / mcp / desc-fields — only the desc
/// is refreshed to read as a team lead and the `team` tag is added (idempotent)
/// so the row presents itself as a team lead even before detection picks it up.
///
/// Errors:
///   * 404 — no session with that name.
///   * 409 — the session is ALREADY a detected team lead.
///   * 422 — the session is archived (archived sessions must be unarchived first).
///   * 400 — empty / oversize task.
///
/// The lifecycle::stop call is BEST-EFFORT: a stop failure short-circuits and
/// surfaces to the client (we'd rather not boot a half-stopped session that may
/// fight a still-living agent for the same tmux name). Once the session is
/// stopped, the rest mirrors `start_team` end-of-flow exactly: set the
/// force-flag, refresh row metadata, and call `lifecycle::start` with the seed.
pub async fn convert_to_team(
    state: &AppState,
    input: ConvertToTeamInput,
) -> Result<StartTeamResult, AppError> {
    let task = validate_task(&input.task)?;
    let teammates = resolve_teammates(input.teammates);
    let model = sanitize_model(input.model.as_deref());

    let name = input.name.trim();
    if name.is_empty() || !sessions::valid_name(name) {
        return Err(AppError::BadRequest(
            "invalid session name (allowed: letters, digits, '_', '.', '-')".into(),
        ));
    }

    // 1. Look up the row (404 if missing) + refuse archived (422-ish: 409
    //    Conflict is the closest AppError variant we own; "archived" reads as a
    //    state conflict the caller must resolve by unarchiving).
    let row = db::sessions::get(&state.pool, name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))?;
    if row.archived != 0 {
        return Err(AppError::Conflict(format!(
            "session '{name}' is archived — unarchive it before making it a team"
        )));
    }
    if row.provider != "claude" {
        // Agent teams is a Claude-only concept (the env + settings hooks are
        // read only by Claude Code). Trying to "team" a shell/codex session is
        // a definitional mismatch — refuse plainly, not silently no-op.
        return Err(AppError::BadRequest(format!(
            "session '{name}' uses provider '{}' — only Claude sessions can become teams",
            row.provider
        )));
    }

    // 2. Refuse if the detector already sees this session as a team lead (no double
    //    conversion). Cheapest signal: ask the watcher to scan + enrich now and
    //    look for a team mapped to this supermux session.
    let teams = crate::teams::scan_and_enrich(state).await;
    if teams.iter().any(|t| t.lead_supermux_session.as_deref() == Some(name)) {
        return Err(AppError::Conflict(format!(
            "session '{name}' is already a team lead"
        )));
    }

    // 3. Stop the agent if it's running. The lifecycle::stop is synchronous
    //    (returns once the session is stopped), so we don't need a separate
    //    settle-poll — by the time it returns, the next start can race-free
    //    create a fresh tmux session under the same name.
    let tmux = Tmux::new(name);
    if tmux.exists().await.unwrap_or(false) {
        lifecycle::stop(state, name).await?;
    }

    // 4. Per-session opt-in flag — same mechanism start_team uses, so this lead boots
    //    with the Agent Teams env even if the global pref is OFF. MUST be set
    //    BEFORE the start() call (start reads it via `force_agent_teams`).
    state.set_force_agent_teams(name);

    // 5. Refresh the row's identity bits so the existing session presents as a
    //    team lead BEFORE detection picks up the on-disk team files. Mirrors what
    //    `sessions::create` writes for a fresh start_team:
    //      - desc → "Team lead — <short_desc(task)>"
    //      - tags → existing ∪ {"team"} (idempotent add, no duplicates)
    //    Failures here are non-fatal: the row stays as it was; the lead still
    //    boots and detection picks it up once the on-disk files exist.
    let new_desc = format!("Team lead — {}", short_desc(&task));
    if let Err(e) = db::sessions::set_desc(&state.pool, name, &new_desc).await {
        tracing::warn!(name = %name, error = %e, "convert_to_team: failed to refresh desc");
    }
    let mut tags: Vec<String> = serde_json::from_str(&row.tags).unwrap_or_default();
    if !tags.iter().any(|t| t == "team") {
        tags.push("team".into());
        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
        if let Err(e) = db::sessions::set_tags(&state.pool, name, &tags_json).await {
            tracing::warn!(name = %name, error = %e, "convert_to_team: failed to add 'team' tag");
        }
    }

    // 6. Boot the lead with the seed prompt — same code path as start_team.
    let seed = build_seed_prompt(&task, teammates, model.as_deref());
    lifecycle::start(state, name, Some(&seed)).await?;

    // 7. Re-read the post-boot view so the client navigates to the up-to-date
    //    session (status flipped to `active` by start()).
    let lead = sessions::get(state, name).await?;

    Ok(StartTeamResult {
        team: true,
        teammates,
        lead,
    })
}

/// A short single-line description from the (possibly multi-line) goal for the
/// session row's `desc`.
pub(crate) fn short_desc(task: &str) -> String {
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
    fn seed_prompt_names_the_actual_agent_teams_tools() {
        // Reliable activation requires naming the gated tool path VERBATIM:
        // the `Teammate` tool's `spawnTeam` operation AND the `Task` tool's
        // `team_name` parameter (the parameter that flips Task from
        // "in-process subagent" to "tmux split-pane teammate"). Without
        // both, Claude's injected system prompt routes loose "team"
        // phrasing back to plain Task (no team_name) and the lead silently
        // creates in-process subagents — no tmux panes, no team config, no
        // per-teammate UI.
        let p = build_seed_prompt("ship the redesign", 3, None);
        assert!(p.contains("ship the redesign"), "goal must be present");
        assert!(p.contains("`Teammate`"), "must name the Teammate tool");
        assert!(p.contains("\"spawnTeam\""), "must name the spawnTeam operation");
        assert!(
            p.contains("team_name") && p.contains("description") && p.contains("agent_type"),
            "must reference spawnTeam's required param names so the model fills them",
        );
        assert!(p.contains("`Task`"), "must name the Task tool (it's the spawn path)");
        assert!(
            p.contains("subagent_type") && p.contains("general-purpose"),
            "must name Task's subagent_type:\"general-purpose\" param so the lead spawns valid teammates",
        );
        // Anti-fallback guard: the most-load-bearing sentence — Task WITHOUT
        // team_name = in-process subagent. Spell it out so the model sees the
        // distinction explicitly.
        assert!(
            p.contains("in-process"),
            "must explicitly contrast in-process vs tmux-pane teammates",
        );
        assert!(!p.contains("Pass `model"), "no model line when model is None");
    }

    #[test]
    fn seed_prompt_singular_and_model() {
        let p = build_seed_prompt("do a thing", 1, Some("opus"));
        // Singular phrasing.
        assert!(p.contains("1 time"), "singular '1 time' phrasing");
        assert!(p.contains("1 teammate is"), "singular 'teammate is' phrasing");
        // Model guidance routed via the Task tool's `model` parameter.
        assert!(
            p.contains("model:\"opus\"") && p.contains("`Task` call"),
            "model line tells the lead to pass model on the Task call",
        );
    }

    #[test]
    fn seed_prompt_plural_phrasing_for_multiple() {
        let p = build_seed_prompt("x", 3, None);
        assert!(p.contains("3 time"), "plural '3 times'");
        assert!(p.contains("3 teammates are"), "plural 'teammates are'");
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
    fn gen_random_team_name_is_valid_and_prefixed() {
        let n = gen_random_team_name();
        assert!(n.starts_with("team-"));
        assert!(crate::sessions::valid_name(&n), "generated name must be a valid session name");
    }

    #[test]
    fn slugify_dir_basics() {
        assert_eq!(slugify_dir("/opt/projects/supermux"), Some("supermux".into()));
        assert_eq!(slugify_dir("/opt/projects/supermux/"), Some("supermux".into()));
        assert_eq!(slugify_dir("/home/me/My App/"), Some("my-app".into()));
        assert_eq!(slugify_dir("/home/me/.config/"), Some("config".into()));
        assert_eq!(slugify_dir("/home/me/__init__.py"), Some("init-py".into()));
        // Edge: root or pure punctuation → no slug, caller falls back to random.
        assert_eq!(slugify_dir("/"), None);
        assert_eq!(slugify_dir("///---"), None);
        // Long: capped at 32, no trailing dash.
        let long = format!("/x/{}", "a".repeat(50));
        let slug = slugify_dir(&long).unwrap();
        assert!(slug.len() <= 32);
        assert!(!slug.ends_with('-'));
    }

    // ── convert-to-team tests ────────────────────────────────────────────────

    use crate::config::Config;
    use crate::sessions::CreateInput;
    use crate::state::AppState;
    use std::path::PathBuf;

    /// Build an in-memory test AppState with a tmp data_dir, mirroring the
    /// pattern used by `teams::watcher::tests::test_state`.
    async fn test_state() -> (AppState, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "supermux-convert-team-test-{}",
            uuid::Uuid::new_v4()
        ));
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

    #[tokio::test]
    async fn convert_404_on_unknown_session() {
        let (state, _dir) = test_state().await;
        let err = convert_to_team(
            &state,
            ConvertToTeamInput {
                name: "ghost".into(),
                task: "do a thing".into(),
                teammates: None,
                model: None,
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound, got {err:?}"
        );
    }

    #[tokio::test]
    async fn convert_rejects_empty_task() {
        let (state, _dir) = test_state().await;
        // Create a session first so the empty-task branch is the one tripped.
        let _ = crate::sessions::create(
            &state,
            CreateInput {
                name: "alpha".into(),
                display_name: None,
                dir: None,
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
        let err = convert_to_team(
            &state,
            ConvertToTeamInput {
                name: "alpha".into(),
                task: "   ".into(),
                teammates: None,
                model: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn convert_rejects_archived_session() {
        let (state, _dir) = test_state().await;
        let _ = crate::sessions::create(
            &state,
            CreateInput {
                name: "beta".into(),
                display_name: None,
                dir: None,
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
        crate::db::sessions::set_archived(&state.pool, "beta", true)
            .await
            .unwrap();
        let err = convert_to_team(
            &state,
            ConvertToTeamInput {
                name: "beta".into(),
                task: "ship the redesign".into(),
                teammates: None,
                model: None,
            },
        )
        .await
        .unwrap_err();
        // Conflict carries the human "archived" message.
        match err {
            AppError::Conflict(msg) => assert!(msg.contains("archived"), "msg: {msg}"),
            other => panic!("expected Conflict on archived, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn convert_rejects_non_claude_provider() {
        let (state, _dir) = test_state().await;
        let _ = crate::sessions::create(
            &state,
            CreateInput {
                name: "shellone".into(),
                display_name: None,
                dir: None,
                desc: None,
                provider: Some("shell".into()),
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
        let err = convert_to_team(
            &state,
            ConvertToTeamInput {
                name: "shellone".into(),
                task: "ship the redesign".into(),
                teammates: None,
                model: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn convert_rejects_bad_name() {
        let (state, _dir) = test_state().await;
        let err = convert_to_team(
            &state,
            ConvertToTeamInput {
                name: "bad name with spaces".into(),
                task: "ship".into(),
                teammates: None,
                model: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }
}

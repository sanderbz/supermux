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
    // Canonical Agent-Teams activation phrasing per the official Claude Code doc
    // (https://code.claude.com/docs/en/agent-teams). The model is fine-tuned to
    // map "Create an agent team" + "Spawn N teammates" to the gated team-
    // formation tools (which write ~/.claude/teams/<team>/config.json + spawn
    // tmux split-pane teammates). Earlier phrasing ("Form a team using your
    // agent-team tools…") pattern-matched onto the regular Task tool instead,
    // so the lead would silently spin up in-process subagents — no real team.
    format!(
        "Create an agent team to work on this goal:\n\n{task}\n\n\
         Spawn {teammates} teammate{plural}, each tackling a different angle of \
         this goal. Give each teammate a clear role + an initial task, then \
         coordinate them via the shared task list and message each other as \
         needed until the goal is complete.{model_line}",
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
    let task = validate_task(&input.task)?;

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
/// so the row presents itself as a team lead even before AT-B detects it.
///
/// Errors:
///   * 404 — no session with that name.
///   * 409 — the session is ALREADY a detected team lead (AT-B sees it).
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

    // 2. Refuse if AT-B already sees this session as a team lead (no double
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

    // 4. Per-session opt-in flag — same mechanism AT-D uses, so this lead boots
    //    with the Agent Teams env even if the global pref is OFF. MUST be set
    //    BEFORE the start() call (start reads it via `force_agent_teams`).
    state.set_force_agent_teams(name);

    // 5. Refresh the row's identity bits so the existing session presents as a
    //    team lead BEFORE AT-B detects the on-disk team files. Mirrors what
    //    `sessions::create` writes for a fresh start_team:
    //      - desc → "Team lead — <short_desc(task)>"
    //      - tags → existing ∪ {"team"} (idempotent add, no duplicates)
    //    Failures here are non-fatal: the row stays as it was; the lead still
    //    boots and AT-B picks it up once the on-disk files exist.
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

    // ── FEAT-CONVERT-TEAM tests ────────────────────────────────────────────────

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
                dir: None,
                desc: None,
                provider: Some("claude".into()),
                creator: None,
                flags: None,
                tags: None,
                branch: None,
                mcp: None,
                worktree: None,
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
                dir: None,
                desc: None,
                provider: Some("claude".into()),
                creator: None,
                flags: None,
                tags: None,
                branch: None,
                mcp: None,
                worktree: None,
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
                dir: None,
                desc: None,
                provider: Some("shell".into()),
                creator: None,
                flags: None,
                tags: None,
                branch: None,
                mcp: None,
                worktree: None,
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

//! Skills + slash-commands (TECH_PLAN §3.4, feature-extract §5.2–§5.4; M9).
//!
//! Skills are markdown files persisted in the `skills` table and, on write, ALSO
//! synced to two filesystem locations so Claude Code picks them up as native
//! `/<name>` slash commands (feature-extract §5.2):
//!   * `~/.supermux/skills/<name>.md`  — supermux's own copy
//!   * `~/.claude/commands/<name>.md` — what Claude reads
//!
//! `GET /api/skills` parses each skill's YAML frontmatter for `description` and
//! `argument-hint` (the convention from §5.4). `GET /api/slash-commands` merges
//! the verbatim claude/codex built-in command list (§5.3) with the user skills,
//! returning `[{cmd, desc}]` for the "/" autocomplete menu.
//!
//! **Path safety.** A skill `name` is constrained to a slug (`[A-Za-z0-9_.-]+`)
//! so a malicious name can never traverse out of the skills directories — there
//! is no path separator in the allowed character set.

use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::Json;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db;
use crate::error::AppError;
use crate::state::AppState;

/// Verbatim built-in claude/codex slash commands (feature-extract §5.3,
/// `_BUILTIN_SLASH_COMMANDS`). Ported in order, no leading slash dropped.
pub const BUILTIN_SLASH_COMMANDS: &[&str] = &[
    "/add-dir",
    "/agents",
    "/batch",
    "/clear",
    "/color",
    "/compact",
    "/config",
    "/context",
    "/copy",
    "/cost",
    "/debug",
    "/diff",
    "/doctor",
    "/effort",
    "/export",
    "/extra-usage",
    "/fast",
    "/feedback",
    "/focus",
    "/help",
    "/hooks",
    "/ide",
    "/init",
    "/login",
    "/logout",
    "/loop",
    "/mcp",
    "/memory",
    "/model",
    "/permissions",
    "/plan",
    "/plugin",
    "/recap",
    "/release-notes",
    "/remote-control",
    "/rename",
    "/resume",
    "/review",
    "/rewind",
    "/sandbox",
    "/schedule",
    "/security-review",
    "/simplify",
    "/skills",
    "/stats",
    "/status",
    "/statusline",
    "/tasks",
    "/terminal-setup",
    "/theme",
    "/ultraplan",
    "/ultrareview",
    "/usage",
    "/vim",
    "/voice",
];

// ── supermux-managed commands (auto-installed on boot; board-integration §C.2) ──
//
// These are commands supermux OWNS and writes to the service user's
// `~/.claude/commands/` automatically — no manual install. They coexist with the
// user's own commands: the managed [`MANAGED_MARKER`] in the frontmatter lets the
// seeder tell its own files apart, so it never clobbers a user-authored command
// that happens to share a name (it skips one it doesn't own and warns).

/// Marker line in a managed command's frontmatter. Its presence is how the seeder
/// identifies a file it owns vs. a co-located user command of the same name —
/// the same coexistence discipline as `claude_config::MARKER` for hooks.
pub const MANAGED_MARKER: &str = "supermux-managed: true";

/// The `/supermux-task` command — the agent's natural surface for writing back to
/// its OWN board issue. Each verb expands to a scoped `curl` against the
/// hook-token board endpoints (board-integration §C.2, server `board/hook.rs`),
/// authed by the per-session `$SUPERMUX_HOOK_TOKEN` and scoped to the issue
/// linked to `$SUPERMUX_SESSION`. This const is the SOURCE OF TRUTH that gets
/// synced to disk on boot (and re-synced on version change — it's idempotent).
pub const SUPERMUX_TASK_NAME: &str = "supermux-task";
pub const SUPERMUX_TASK_SKILL: &str = include_str!("supermux-task.md");

/// The set of commands supermux manages + auto-installs. `(name, content)`.
/// Adding a row here means it's seeded to `~/.claude/commands/<name>.md` on the
/// next boot.
pub const MANAGED_COMMANDS: &[(&str, &str)] = &[(SUPERMUX_TASK_NAME, SUPERMUX_TASK_SKILL)];

/// Skill-name slug rule — no path separators, so a name can never escape the
/// skills directories.
static SKILL_NAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_.-]+$").unwrap());

fn valid_skill_name(name: &str) -> bool {
    // Reject the dot-only traversal tokens (`.`, `..`) outright — the slug regex
    // permits `.`, so without this an all-dots name would slip through as a
    // filename component pointing at the parent directory.
    if name == "." || name == ".." {
        return false;
    }
    !name.is_empty() && name.len() <= 100 && SKILL_NAME_RE.is_match(name)
}

// ── YAML frontmatter (lightweight; only the two convention keys) ──────────────

#[derive(Debug, Default, Serialize)]
struct Frontmatter {
    description: String,
    /// `argument-hint` in YAML → `hint` in the API shape (§5.4).
    hint: String,
}

/// Extract `description` and `argument-hint` from a `--- … ---` frontmatter
/// block. A hand-rolled scan (not a full YAML parser) keeps the dependency
/// surface minimal and covers the exact `key: value` convention from §5.4.
fn parse_frontmatter(content: &str) -> Frontmatter {
    let mut fm = Frontmatter::default();
    let trimmed = content.trim_start();
    let Some(rest) = trimmed.strip_prefix("---") else {
        return fm;
    };
    // The block ends at the next line that is exactly `---`.
    let Some(end) = rest.find("\n---") else {
        return fm;
    };
    let block = &rest[..end];
    for line in block.lines() {
        let line = line.trim();
        if let Some((key, val)) = line.split_once(':') {
            let val = val.trim().trim_matches('"').trim_matches('\'').to_string();
            match key.trim() {
                "description" => fm.description = val,
                "argument-hint" => fm.hint = val,
                _ => {}
            }
        }
    }
    fm
}

// ── filesystem sync ───────────────────────────────────────────────────────────

/// `~/.supermux/skills/<name>.md`.
fn supermux_skill_path(name: &str) -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".supermux").join("skills").join(format!("{name}.md")))
}

/// Claude's commands dir: `$CLAUDE_CONFIG_DIR/commands` (Claude Code's own
/// override — also what tests target) else `~/.claude/commands`. Mirrors
/// [`crate::claude_config`]'s resolver so the hook installer and the command
/// seeder stay in lockstep and tests can point both at a temp dir.
fn claude_commands_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        let d = d.trim();
        if !d.is_empty() {
            return Some(PathBuf::from(d).join("commands"));
        }
    }
    dirs::home_dir().map(|h| h.join(".claude").join("commands"))
}

/// `<claude-config>/commands/<name>.md` (what Claude reads as a `/<name>` command).
fn claude_command_path(name: &str) -> Option<PathBuf> {
    claude_commands_dir().map(|d| d.join(format!("{name}.md")))
}

/// Write the skill markdown to both filesystem locations (best-effort, but a
/// failure is surfaced so the user knows Claude may not see the command).
async fn sync_skill_files(name: &str, content: &str) -> Result<(), AppError> {
    for path in [supermux_skill_path(name), claude_command_path(name)].into_iter().flatten() {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("skill dir {parent:?}: {e}")))?;
        }
        tokio::fs::write(&path, content)
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("write skill {path:?}: {e}")))?;
    }
    Ok(())
}

/// Remove a skill's filesystem copies (best-effort; absence is not an error).
async fn remove_skill_files(name: &str) {
    for path in [supermux_skill_path(name), claude_command_path(name)].into_iter().flatten() {
        let _ = tokio::fs::remove_file(&path).await;
    }
}

// ── managed-command seeding (auto-install on boot) ─────────────────────────────

/// Write one managed command to `<commands-dir>/<name>.md`, idempotently and
/// non-destructively:
///
/// * **Idempotent.** Re-running just rewrites the file — safe on every boot and
///   on a version change (the content is the source of truth). A byte-identical
///   file is a no-op (boot fast-path).
/// * **Coexistence-safe.** If a file of that name already exists and is NOT one
///   supermux owns (it lacks [`MANAGED_MARKER`]), we leave it alone — the user's
///   own `/<name>` command is never clobbered.
///
/// Returns `Ok(true)` if our file is present (written or already current),
/// `Ok(false)` if skipped to preserve a user-authored file. Factored to take the
/// commands dir so tests target a temp dir (mirrors `claude_config::install_hooks_at`).
async fn seed_one_managed_command_at(
    dir: &std::path::Path,
    name: &str,
    content: &str,
) -> Result<bool, AppError> {
    debug_assert!(
        content.contains(MANAGED_MARKER),
        "managed command '{name}' must carry the managed marker in its frontmatter"
    );
    let path = dir.join(format!("{name}.md"));

    // Non-clobber: if a file is already there and it isn't ours, back off.
    if let Ok(existing) = tokio::fs::read_to_string(&path).await {
        if !existing.contains(MANAGED_MARKER) {
            tracing::warn!(
                command = %name,
                path = %path.display(),
                "a user-authored command already exists at this path; not overwriting it with the supermux-managed copy"
            );
            return Ok(false);
        }
        // Already ours and byte-identical → nothing to write.
        if existing == content {
            return Ok(true);
        }
    }

    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("commands dir {dir:?}: {e}")))?;
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("write managed command {path:?}: {e}")))?;
    Ok(true)
}

/// Seed ALL supermux-managed commands into the given commands dir. The seam the
/// boot path and the tests both call.
async fn seed_managed_commands_at(dir: &std::path::Path) {
    for (name, content) in MANAGED_COMMANDS {
        match seed_one_managed_command_at(dir, name, content).await {
            Ok(true) => tracing::info!(command = %name, "seeded supermux-managed command"),
            Ok(false) => {}
            Err(e) => tracing::warn!(command = %name, error = %e, "failed to seed managed command"),
        }
    }
}

/// Seed ALL supermux-managed commands into the service user's
/// `~/.claude/commands/` — called once on server boot so `/supermux-task` (and any
/// future managed command) is present with zero manual steps. Each is written
/// idempotently and never clobbers a co-located user command. A single command
/// failing is logged, not fatal — boot proceeds and the rest still install.
pub async fn seed_managed_commands() {
    let Some(dir) = claude_commands_dir() else {
        tracing::warn!("cannot resolve commands dir; skipping managed-command seed");
        return;
    };
    seed_managed_commands_at(&dir).await;
}

// ── handlers ──────────────────────────────────────────────────────────────────

/// One skill in the list view (§5.4): name + frontmatter-derived fields.
#[derive(Debug, Serialize)]
pub struct SkillListItem {
    pub name: String,
    pub description: String,
    pub hint: String,
}

/// `GET /api/skills` — list with parsed `description` + `argument-hint`.
pub async fn list(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    let rows = db::skills::list(&state.pool).await?;
    let items: Vec<SkillListItem> = rows
        .into_iter()
        .map(|s| {
            let fm = parse_frontmatter(&s.content);
            SkillListItem {
                name: s.name,
                description: fm.description,
                hint: fm.hint,
            }
        })
        .collect();
    Ok(Json(json!({ "ok": true, "data": items })))
}

/// `GET /api/skills/{name}` — full markdown content.
pub async fn get(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let skill = db::skills::get(&state.pool, &name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("skill '{name}'")))?;
    Ok(Json(json!({
        "ok": true,
        "data": { "name": skill.name, "content": skill.content },
    })))
}

#[derive(Debug, Deserialize)]
pub struct SkillBody {
    pub content: String,
}

/// `POST /api/skills/{name}` — create or update; sync to both fs locations.
pub async fn upsert(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<SkillBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    if !valid_skill_name(&name) {
        return Err(AppError::BadRequest(
            "invalid skill name (allowed: letters, digits, '_', '.', '-')".into(),
        ));
    }
    db::skills::upsert(&state.pool, &name, &body.content).await?;
    sync_skill_files(&name, &body.content).await?;
    Ok(Json(json!({ "ok": true, "name": name })))
}

/// `DELETE /api/skills/{name}` — remove from DB + both fs locations.
pub async fn delete(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let removed = db::skills::delete(&state.pool, &name).await?;
    remove_skill_files(&name).await;
    if removed == 0 {
        return Err(AppError::NotFound(format!("skill '{name}'")));
    }
    Ok(Json(json!({ "ok": true })))
}

/// One row of the merged slash-command list.
#[derive(Debug, Serialize)]
pub struct SlashCommand {
    pub cmd: String,
    pub desc: String,
}

/// `GET /api/slash-commands` — built-ins (§5.3) merged with user skills, for the
/// "/" autocomplete menu. Built-ins first (with empty desc), then skills as
/// `/<name>` with their frontmatter description.
pub async fn slash_commands(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut commands: Vec<SlashCommand> = BUILTIN_SLASH_COMMANDS
        .iter()
        .map(|c| SlashCommand {
            cmd: (*c).to_string(),
            desc: String::new(),
        })
        .collect();

    for skill in db::skills::list(&state.pool).await? {
        let fm = parse_frontmatter(&skill.content);
        commands.push(SlashCommand {
            cmd: format!("/{}", skill.name),
            desc: fm.description,
        });
    }

    Ok(Json(json!({ "ok": true, "data": commands })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_extracts_description_and_hint() {
        let md = "---\ndescription: One-line summary\nargument-hint: <usage hint>\n---\nbody\n";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.description, "One-line summary");
        assert_eq!(fm.hint, "<usage hint>");
    }

    #[test]
    fn frontmatter_absent_is_empty() {
        let fm = parse_frontmatter("no frontmatter here");
        assert!(fm.description.is_empty());
        assert!(fm.hint.is_empty());
    }

    #[test]
    fn frontmatter_strips_quotes() {
        let fm = parse_frontmatter("---\ndescription: \"Quoted desc\"\n---\n");
        assert_eq!(fm.description, "Quoted desc");
    }

    #[test]
    fn skill_name_rejects_traversal() {
        assert!(!valid_skill_name("../etc/passwd"));
        assert!(!valid_skill_name("a/b"));
        assert!(valid_skill_name("cso"));
        assert!(valid_skill_name("my-skill_1.0"));
    }

    #[test]
    fn builtin_list_is_complete() {
        // Spot-check the count + a few entries to catch an accidental truncation.
        assert_eq!(BUILTIN_SLASH_COMMANDS.len(), 55);
        assert!(BUILTIN_SLASH_COMMANDS.contains(&"/compact"));
        assert!(BUILTIN_SLASH_COMMANDS.contains(&"/voice"));
    }

    // ── managed-command seeding (AB3) ──────────────────────────────────────────

    fn cmd_temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("supermux-cmd-seed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn supermux_task_template_is_self_describing() {
        // The embedded source of truth must carry the managed marker, the
        // frontmatter description (so it shows in the slash menu), and reference
        // the real env vars + all four hook endpoints with the scoped token.
        let md = SUPERMUX_TASK_SKILL;
        assert!(md.contains(MANAGED_MARKER), "must carry the managed marker");

        let fm = parse_frontmatter(md);
        assert!(!fm.description.is_empty(), "needs a frontmatter description");
        assert!(!fm.hint.is_empty(), "needs an argument-hint");

        // Env vars the curls rely on (present in every pane via build_env).
        for v in ["$SUPERMUX_HOOK_TOKEN", "$SUPERMUX_SESSION", "$SUPERMUX_URL"] {
            assert!(md.contains(v), "template must reference {v}");
        }
        // The scoped auth header.
        assert!(md.contains("X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN"));
        // All four AB1 endpoints are documented.
        for ep in [
            "/api/hook/board/comment",
            "/api/hook/board/status",
            "/api/hook/board/check",
            "/api/hook/board/link",
        ] {
            assert!(md.contains(ep), "template must wrap {ep}");
        }
        // The agent's full status authority (it may set done) is documented.
        assert!(md.contains("\"status\":\"done\""), "must show the done curl");
    }

    #[tokio::test]
    async fn seed_writes_supermux_task_with_expected_curls() {
        let dir = cmd_temp_dir();
        seed_managed_commands_at(&dir).await;

        let path = dir.join("supermux-task.md");
        let written = std::fs::read_to_string(&path).expect("supermux-task.md created on seed");
        assert_eq!(written, SUPERMUX_TASK_SKILL, "seeded file is the source of truth");
        // Spot-check the load-bearing endpoint + header survived to disk.
        assert!(written.contains("/api/hook/board/comment"));
        assert!(written.contains("X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn seed_is_idempotent() {
        let dir = cmd_temp_dir();
        seed_managed_commands_at(&dir).await;
        seed_managed_commands_at(&dir).await;
        seed_managed_commands_at(&dir).await;

        // Exactly one file, content unchanged.
        let entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["supermux-task.md".to_string()]);
        assert_eq!(
            std::fs::read_to_string(dir.join("supermux-task.md")).unwrap(),
            SUPERMUX_TASK_SKILL
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn seed_refreshes_a_stale_managed_copy() {
        // A previous version of OUR command (carries the marker) is overwritten.
        let dir = cmd_temp_dir();
        let stale = format!("---\n{MANAGED_MARKER}\n---\nold managed body\n");
        std::fs::write(dir.join("supermux-task.md"), &stale).unwrap();

        seed_managed_commands_at(&dir).await;

        assert_eq!(
            std::fs::read_to_string(dir.join("supermux-task.md")).unwrap(),
            SUPERMUX_TASK_SKILL,
            "a stale managed copy is refreshed to current"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn seed_does_not_clobber_a_user_command() {
        // A user's own /supermux-task (NO managed marker) must survive untouched.
        let dir = cmd_temp_dir();
        let user_cmd = "---\ndescription: my own thing\n---\nmy custom supermux-task command\n";
        std::fs::write(dir.join("supermux-task.md"), user_cmd).unwrap();

        seed_managed_commands_at(&dir).await;

        assert_eq!(
            std::fs::read_to_string(dir.join("supermux-task.md")).unwrap(),
            user_cmd,
            "a user-authored command of the same name is never clobbered"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

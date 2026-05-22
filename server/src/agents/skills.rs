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

/// `~/.claude/commands/<name>.md` (what Claude reads as a `/<name>` command).
fn claude_command_path(name: &str) -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("commands").join(format!("{name}.md")))
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
}

//! `GET /api/claude/registry?cwd=<dir>` — the read API the manager UI consumes.
//!
//! Returns `{ mcp: [...], skills: [...], commands: [...] }`, each entry tagged
//! with its **scope** and **provenance**, MCP `env`/`headers` values MASKED. This
//! path parses Claude's config FILES directly — it NEVER spawns a process, so it
//! is fast, needs no trust prompt, and keeps the secret values under our control
//! so we can mask them before they ever leave the server (plan §A, §C.2, §C.4).
//!
//! Sources scanned:
//!   * MCP — `~/.claude.json` top-level `mcpServers` (user), its
//!     `projects[<cwd>].mcpServers` (local), and `<cwd>/.mcp.json` (project,
//!     git-tracked). Each project `.mcp.json` server also carries its enable
//!     state from `projects[<cwd>].enabled/disabledMcpjsonServers`.
//!   * skills — `~/.claude/skills/*` (global) + `<cwd>/.claude/skills/*` (project)
//!     + plugin skills (read-only). Symlinks are `lstat`'d and flagged.
//!   * commands — `~/.claude/commands/*.md` (global; DB-backed ones flagged
//!     "supermux-managed") + `<cwd>/.claude/commands/*.md` (project) + built-ins.

use std::path::{Path, PathBuf};

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::skills::{BUILTIN_SLASH_COMMANDS, MANAGED_MARKER};
use crate::db;
use crate::error::AppError;
use crate::state::AppState;

use super::atomic::{claude_config_dir, claude_json_path, mask_mcp_secrets, mcp_json_path};
use super::{Scope, MASKED};

#[derive(Debug, Deserialize)]
pub struct RegistryQuery {
    /// The focused session's working dir. When absent, only global/user sources
    /// are returned (the ⌘K / settings entry point opens global-only).
    #[serde(default)]
    pub cwd: Option<String>,
}

/// One MCP server row, scope+provenance tagged, secrets masked.
#[derive(Debug, Serialize)]
pub struct McpEntry {
    pub name: String,
    pub scope: Scope,
    /// Where it came from: `user` | `local` | `project` (plus read-only future
    /// `cloud`/`plugin`). Distinct from `scope` so the UI can label `local` vs
    /// `user` (both live in `~/.claude.json`) without confusion.
    pub provenance: &'static str,
    pub transport: String,
    /// True only for the git-tracked `.mcp.json` source — the UI shows a loud
    /// "committed to git" warning for these.
    pub committed: bool,
    /// Whether file-based remove is offered (false for read-only sources).
    pub removable: bool,
    /// Project (`.mcp.json`) servers are "pending" until the user trusts them;
    /// `null` for user/local (always active). Derived from
    /// `enabled/disabledMcpjsonServers`.
    pub enabled: Option<bool>,
    /// The full server config with `env`/`headers` VALUES masked. Key names + all
    /// non-secret fields (type/command/args/url) survive.
    pub config: Value,
}

/// One skill row.
#[derive(Debug, Serialize)]
pub struct SkillEntry {
    pub name: String,
    pub scope: &'static str, // "global" | "project" | "plugin"
    pub provenance: &'static str,
    pub description: String,
    pub path: String,
    /// True when the skill dir is a symlink (removing must unlink, not delete the
    /// target — plan open-risk). Carries the link target for the UI.
    pub linked: bool,
    pub link_target: Option<String>,
    pub removable: bool,
}

/// One slash-command row.
#[derive(Debug, Serialize)]
pub struct CommandEntry {
    pub name: String,
    pub scope: &'static str, // "global" | "project" | "builtin" | "plugin"
    pub provenance: &'static str,
    pub description: String,
    pub path: Option<String>,
    /// True for commands supermux owns (DB-backed or carrying the managed marker).
    pub managed: bool,
    pub removable: bool,
}

/// `GET /api/claude/registry` — the grouped, masked, provenance-tagged read.
pub async fn registry(
    State(state): State<AppState>,
    Query(q): Query<RegistryQuery>,
) -> Result<Json<Value>, AppError> {
    let cwd = q.cwd.as_deref().filter(|s| !s.is_empty());

    let mcp = read_mcp(cwd).await;
    let skills = read_skills(cwd).await;
    let commands = read_commands(&state, cwd).await?;

    Ok(Json(json!({
        "ok": true,
        "data": { "mcp": mcp, "skills": skills, "commands": commands },
    })))
}

// ── MCP ─────────────────────────────────────────────────────────────────────

/// Scan all three MCP sources, mask secrets, tag scope+provenance. Read failures
/// (missing/unparseable file) degrade to "no servers from that source" rather
/// than failing the whole registry — the list stays honest about what we could
/// read.
async fn read_mcp(cwd: Option<&str>) -> Vec<McpEntry> {
    let mut out: Vec<McpEntry> = Vec::new();

    // user + local both live in ~/.claude.json.
    let claude_json = super::atomic::read_json_object(&claude_json_path())
        .await
        .unwrap_or_else(|_| json!({}));

    // user scope: top-level mcpServers.
    if let Some(Value::Object(servers)) = claude_json.get("mcpServers") {
        for (name, cfg) in servers {
            out.push(mk_entry(name, cfg, Scope::User, "user", true, None));
        }
    }

    // cloud: account-global claude.ai remote connectors. Always returned (no cwd
    // needed) — see `cloud_entries`.
    out.extend(cloud_entries(&claude_json));

    if let Some(cwd) = cwd {
        // local scope: projects[<resolved cwd>].mcpServers. Claude keys the
        // projects map by the resolved absolute path; try the canonicalized form
        // first, then the raw cwd as a fallback.
        let proj = project_entry(&claude_json, cwd);
        if let Some(Value::Object(servers)) = proj.and_then(|p| p.get("mcpServers")) {
            for (name, cfg) in servers {
                out.push(mk_entry(name, cfg, Scope::Local, "local", true, None));
            }
        }

        // project scope: <cwd>/.mcp.json mcpServers (git-tracked). Enable state
        // for these comes from the same projects[<cwd>] entry.
        let (enabled_list, disabled_list) = enable_lists(proj);
        let mcp_file = super::atomic::read_json_object(&mcp_json_path(cwd))
            .await
            .unwrap_or_else(|_| json!({}));
        if let Some(Value::Object(servers)) = mcp_file.get("mcpServers") {
            for (name, cfg) in servers {
                let enabled = resolve_enabled(name, &enabled_list, &disabled_list);
                out.push(mk_entry(name, cfg, Scope::Project, "project", true, enabled));
            }
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Build one masked, tagged MCP entry.
fn mk_entry(
    name: &str,
    cfg: &Value,
    scope: Scope,
    provenance: &'static str,
    removable: bool,
    enabled: Option<bool>,
) -> McpEntry {
    let transport = cfg
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio")
        .to_string();
    McpEntry {
        name: name.to_string(),
        scope,
        provenance,
        transport,
        committed: scope == Scope::Project,
        removable,
        enabled,
        config: mask_mcp_secrets(cfg, MASKED),
    }
}

/// Account-global claude.ai REMOTE connectors (SUPERMUX-37). These are hosted
/// claude.ai integrations authenticated server-side via the user's Claude account
/// — NOT local processes — so they live in `~/.claude.json` under the
/// `claudeAiMcpEverConnected` array (a list of connector display names), never in
/// any `mcpServers` map, and they are available in EVERY project. The registry
/// previously scanned only the three `mcpServers` sources, so a session could
/// actually USE such a connector while the manager UI never listed it. We read
/// the array generically (whatever names the account has) and surface each as a
/// read-only `cloud`-provenance row
/// (no local file to edit → `removable=false`, `enabled=None` like user/local).
/// Pure over the parsed config so it's unit-testable.
fn cloud_entries(claude_json: &Value) -> Vec<McpEntry> {
    let mut out = Vec::new();
    if let Some(Value::Array(connectors)) = claude_json.get("claudeAiMcpEverConnected") {
        for c in connectors {
            if let Some(name) = c.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                out.push(mk_entry(
                    name,
                    &json!({ "type": "cloud", "remote": true }),
                    Scope::User,
                    "cloud",
                    false,
                    None,
                ));
            }
        }
    }
    out
}

/// Look up `projects[<cwd>]` trying the canonicalized path first (Claude stores
/// the resolved path) then the raw cwd.
fn project_entry<'a>(claude_json: &'a Value, cwd: &str) -> Option<&'a Value> {
    let projects = claude_json.get("projects")?.as_object()?;
    let resolved = std::fs::canonicalize(cwd)
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    if let Some(r) = &resolved {
        if let Some(v) = projects.get(r) {
            return Some(v);
        }
    }
    projects.get(cwd)
}

/// The `enabledMcpjsonServers` / `disabledMcpjsonServers` arrays for a project.
fn enable_lists(proj: Option<&Value>) -> (Vec<String>, Vec<String>) {
    let str_list = |proj: Option<&Value>, key: &str| -> Vec<String> {
        proj.and_then(|p| p.get(key))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    (
        str_list(proj, "enabledMcpjsonServers"),
        str_list(proj, "disabledMcpjsonServers"),
    )
}

/// A `.mcp.json` server is enabled if explicitly enabled, disabled if explicitly
/// disabled, else `None` ("pending — not yet trusted").
fn resolve_enabled(name: &str, enabled: &[String], disabled: &[String]) -> Option<bool> {
    if disabled.iter().any(|n| n == name) {
        Some(false)
    } else if enabled.iter().any(|n| n == name) {
        Some(true)
    } else {
        None
    }
}

// ── skills ────────────────────────────────────────────────────────────────────

async fn read_skills(cwd: Option<&str>) -> Vec<SkillEntry> {
    let mut out: Vec<SkillEntry> = Vec::new();

    // Global: ~/.claude/skills/*
    let global = claude_config_dir().join("skills");
    scan_skill_dir(&global, "global", "global", true, &mut out).await;

    // Project: <cwd>/.claude/skills/*
    if let Some(cwd) = cwd {
        let proj = Path::new(cwd).join(".claude").join("skills");
        scan_skill_dir(&proj, "project", "project", true, &mut out).await;
    }

    // Plugin skills (read-only) — best-effort scan of the plugin cache tree.
    scan_plugin_skills(&mut out).await;

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Scan one skills directory: each child dir containing `SKILL.md` is a skill.
/// `lstat`s every child so symlinked skills are flagged + their target captured.
async fn scan_skill_dir(
    dir: &Path,
    scope: &'static str,
    provenance: &'static str,
    removable: bool,
    out: &mut Vec<SkillEntry>,
) {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        let Ok(link_meta) = tokio::fs::symlink_metadata(&path).await else {
            continue;
        };
        let linked = link_meta.file_type().is_symlink();
        // Resolve through a symlink to confirm it's a dir holding SKILL.md.
        let skill_md = path.join("SKILL.md");
        if !tokio::fs::try_exists(&skill_md).await.unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let description = read_frontmatter_description(&skill_md).await;
        let link_target = if linked {
            tokio::fs::read_link(&path)
                .await
                .ok()
                .map(|t| t.to_string_lossy().into_owned())
        } else {
            None
        };
        out.push(SkillEntry {
            name,
            scope,
            provenance,
            description,
            path: path.to_string_lossy().into_owned(),
            linked,
            link_target,
            removable,
        });
    }
}

/// Plugin skills come from `~/.claude/plugins/cache/<marketplace>/<plugin>/skills/*`
/// (and similar). Read-only; surfaced for honesty. Best-effort, shallow scan.
async fn scan_plugin_skills(out: &mut Vec<SkillEntry>) {
    let cache = claude_config_dir().join("plugins").join("cache");
    let Ok(mut markets) = tokio::fs::read_dir(&cache).await else {
        return;
    };
    while let Ok(Some(market)) = markets.next_entry().await {
        let Ok(mut plugins) = tokio::fs::read_dir(market.path()).await else {
            continue;
        };
        while let Ok(Some(plugin)) = plugins.next_entry().await {
            let skills_dir = plugin.path().join("skills");
            // Plugin skills are read-only (removable=false); managed by /plugin.
            scan_skill_dir(&skills_dir, "plugin", "plugin", false, out).await;
        }
    }
}

/// Pull the `description:` value from a `SKILL.md`/command-`.md` frontmatter block
/// (the lightweight scan skills.rs uses). Returns "" when absent.
async fn read_frontmatter_description(path: &Path) -> String {
    let Ok(content) = tokio::fs::read_to_string(path).await else {
        return String::new();
    };
    frontmatter_value(&content, "description")
}

/// Minimal `--- … ---` frontmatter `key: value` extractor (mirrors
/// `agents::skills::parse_frontmatter`, kept local to avoid widening that module's
/// public surface). Handles the single-line `description:` convention; collapses a
/// multi-line scalar to its first line.
fn frontmatter_value(content: &str, key: &str) -> String {
    let trimmed = content.trim_start();
    let Some(rest) = trimmed.strip_prefix("---") else {
        return String::new();
    };
    let Some(end) = rest.find("\n---") else {
        return String::new();
    };
    let block = &rest[..end];
    for line in block.lines() {
        let line = line.trim();
        if let Some((k, v)) = line.split_once(':') {
            if k.trim() == key {
                return v.trim().trim_matches('"').trim_matches('\'').to_string();
            }
        }
    }
    String::new()
}

// ── commands ──────────────────────────────────────────────────────────────────

async fn read_commands(state: &AppState, cwd: Option<&str>) -> Result<Vec<CommandEntry>, AppError> {
    let mut out: Vec<CommandEntry> = Vec::new();

    // The set of names supermux owns via the `skills` DB table → "managed".
    let db_names: Vec<String> = db::skills::list(&state.pool)
        .await
        .map(|rows| rows.into_iter().map(|s| s.name).collect())
        .unwrap_or_default();

    // Global: ~/.claude/commands/*.md
    let global = claude_config_dir().join("commands");
    scan_command_dir(&global, "global", "global", true, &db_names, &mut out).await;

    // Project: <cwd>/.claude/commands/*.md
    if let Some(cwd) = cwd {
        let proj = Path::new(cwd).join(".claude").join("commands");
        scan_command_dir(&proj, "project", "project", true, &db_names, &mut out).await;
    }

    // Built-ins (read-only, no file) — honest completeness.
    for c in BUILTIN_SLASH_COMMANDS {
        out.push(CommandEntry {
            name: c.trim_start_matches('/').to_string(),
            scope: "builtin",
            provenance: "builtin",
            description: String::new(),
            path: None,
            managed: false,
            removable: false,
        });
    }

    Ok(out)
}

/// Scan one commands directory: each `*.md` is a command. A file carrying the
/// `MANAGED_MARKER` (or whose name is in the `skills` DB) is flagged managed.
async fn scan_command_dir(
    dir: &Path,
    scope: &'static str,
    provenance: &'static str,
    removable: bool,
    db_names: &[String],
    out: &mut Vec<CommandEntry>,
) {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        let content = tokio::fs::read_to_string(&path).await.unwrap_or_default();
        let managed = content.contains(MANAGED_MARKER) || db_names.iter().any(|n| n == &name);
        let description = frontmatter_value(&content, "description");
        out.push(CommandEntry {
            name,
            scope,
            provenance,
            description,
            path: Some(path.to_string_lossy().into_owned()),
            managed,
            removable,
        });
    }
}

/// Resolve a session's working dir to its `~/.claude/projects/<encoded>` form is
/// NOT needed here (registry reads config, not transcripts); kept out on purpose.
#[allow(dead_code)]
fn _unused() -> PathBuf {
    PathBuf::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_extracts_description() {
        let md = "---\ndescription: One-line summary\nargument-hint: <x>\n---\nbody\n";
        assert_eq!(frontmatter_value(md, "description"), "One-line summary");
        assert_eq!(frontmatter_value("no frontmatter", "description"), "");
    }

    #[test]
    fn enabled_resolution() {
        let en = vec!["a".to_string()];
        let dis = vec!["b".to_string()];
        assert_eq!(resolve_enabled("a", &en, &dis), Some(true));
        assert_eq!(resolve_enabled("b", &en, &dis), Some(false));
        assert_eq!(resolve_enabled("c", &en, &dis), None); // pending
    }

    #[test]
    fn cloud_connectors_listed_readonly() {
        // claude.ai remote connectors come from `claudeAiMcpEverConnected`, are
        // read-only, and surface as `cloud` provenance (SUPERMUX-37).
        let cj = json!({
            "claudeAiMcpEverConnected": ["claude.ai Example", "   ", "Other"]
        });
        let e = cloud_entries(&cj);
        assert_eq!(e.len(), 2, "blank entries are skipped");
        assert_eq!(e[0].name, "claude.ai Example");
        assert_eq!(e[0].provenance, "cloud");
        assert_eq!(e[0].transport, "cloud");
        assert_eq!(e[0].scope, Scope::User);
        assert!(!e[0].removable);
        assert_eq!(e[0].enabled, None);
        // No key → nothing (the common case for accounts with no connectors).
        assert!(cloud_entries(&json!({})).is_empty());
    }

    #[test]
    fn project_entry_prefers_resolved_then_raw() {
        // Raw-cwd fallback path (a non-existent dir won't canonicalize).
        let cj = json!({ "projects": { "/no/such/dir": { "mcpServers": { "x": {} } } } });
        let p = project_entry(&cj, "/no/such/dir").unwrap();
        assert!(p.get("mcpServers").is_some());
        assert!(project_entry(&cj, "/other").is_none());
    }
}

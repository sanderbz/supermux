//! Claude tools manager — MCP servers, skills, slash-commands. The READ side
//! parses Claude's config FILES directly (fast, no process spawning, fully
//! under our atomic-write control so we can mask secrets); the `claude` CLI is
//! shelled out to ONLY for the opt-in live health/connected badge
//! (`POST /api/claude/mcp/{name}/check`), never on a plain list-read.
//!
//! **Three MCP scopes, two files** (verified against this host's
//! `~/.claude.json`):
//!   * `user`    → `~/.claude.json` top-level `mcpServers` (all projects)
//!   * `local`   → `~/.claude.json` → `projects[<cwd>].mcpServers` (that cwd only)
//!   * `project` → `<cwd>/.mcp.json` top-level `mcpServers` (GIT-TRACKED — shared)
//! Plus read-only sources surfaced for honesty: plugin skills/commands, supermux-
//! managed commands, and Claude's built-in slash commands.
//!
//! **Secret hygiene (load-bearing).** Every MCP `env`/`headers` VALUE
//! is replaced with a masked sentinel before serialization — raw secret values
//! never reach the client or the logs. Reveal re-fetches the masked preview only;
//! secrets are write-only on the way IN.
//!
//! **Safety.** All config writes go through [`atomic`]'s read → refuse-if-
//! unparseable → merge-own-subtree → temp → fsync → `rename(2)` flow (the exact
//! shape proven in [`crate::claude_config`]); a crash never truncates the file and
//! an unparseable file is left untouched. PROJECT-scope writes are jailed to the
//! session's working dir via [`crate::files::path_safe::resolve_safe`]; the
//! git-tracked `.mcp.json` requires an explicit confirm flag.
//!
//! **Router-registry pattern.** [`router_for`] returns this module's
//! sub-router; `http::router` merges it into the bearer-protected router — one
//! module + one `.merge` line, no shared-file conflict.

pub mod atomic;
pub mod mcp;
pub mod registry;

use axum::routing::{delete, get, post};
use axum::Router;

use crate::state::AppState;

/// The masked sentinel substituted for every MCP `env`/`headers` VALUE on the way
/// out. Mirrors `log_redact::REDACTED` in spirit: the client learns the KEY exists
/// and is set, never the secret itself.
pub const MASKED: &str = "••• set";

/// MCP scope as it appears in the wire API + Claude's `-s/--scope` flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// `~/.claude.json` top-level `mcpServers` — visible in all projects.
    User,
    /// `~/.claude.json` → `projects[<cwd>].mcpServers` — that cwd only, NOT committed.
    Local,
    /// `<cwd>/.mcp.json` — GIT-TRACKED; shared with everyone who clones.
    Project,
}

impl Scope {
    /// The `claude mcp ... -s <scope>` flag value.
    pub fn cli_flag(self) -> &'static str {
        match self {
            Scope::User => "user",
            Scope::Local => "local",
            Scope::Project => "project",
        }
    }
}

/// Build the claude-tools sub-router (bearer-protected; the layer is applied by
/// `http::router`). One module + one `.merge` line — the registry pattern.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        // READ: parse files directly, mask secrets, group by scope+provenance.
        // NEVER spawns a process (no health check here).
        .route("/api/claude/registry", get(registry::registry))
        // MCP mutate: add (guided form OR raw JSON), remove, enable/disable.
        .route("/api/claude/mcp", post(mcp::add))
        .route("/api/claude/mcp/{name}", delete(mcp::remove))
        .route("/api/claude/mcp/{name}/disable", post(mcp::disable))
        .route("/api/claude/mcp/{name}/enable", post(mcp::enable))
        // Opt-in ONLY: live health/connected check, shells out to `claude mcp`.
        // Never run on a plain list — it spawns servers and can hang.
        .route("/api/claude/mcp/{name}/check", post(mcp::check))
        .with_state(state)
}

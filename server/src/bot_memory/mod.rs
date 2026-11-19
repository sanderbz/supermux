//! Bot memory — the tiered core + archival + recall-hook + write-CLI store.
//!
//! **The tradeoff this resolves.** `sessions.memory` (the bot's "Notes it keeps")
//! is the always-loaded CORE, injected read-only into the system prompt at launch
//! (`sessions::lifecycle::role_system_prompt`). That is the token tax the owner
//! chooses to pay, so it is HARD-CAPPED to a small index (see
//! [`crate::sessions::lifecycle`]). Everything larger lives in the ARCHIVAL store
//! this module owns — plain Markdown notes on disk that are NEVER front-loaded. A
//! per-turn recall hook injects only the handful relevant to the current prompt,
//! and a tiny write-back CLI lets the bot append/update its own notes, which the
//! hook re-reads fresh next turn → writes go live with NO relaunch.
//!
//! **Anti-over-engineering.** No vector DB, no graph, no daemon, no embeddings —
//! plain Markdown + lexical scoring, copying the proven Claude Code auto-memory
//! format (frontmatter `name`/`description`/`scope`/`type`/`modified` + a Why/How
//! body + `[[links]]`) verbatim, because the shape is already proven and small.
//!
//! **How it composes.** The recall hook is wired into the SAME per-session
//! `CLAUDE_CONFIG_DIR`/`settings.json` the connector store created
//! (`sessions::connector_config::SessionConfig::apply_memory`), sitting beside the
//! role/notes `--append-system-prompt` block and the connector `--mcp-config`
//! flag pair. The store is keyed by session name (private tier) and the
//! `sessions.role_id` column (shared role tier); recall unions the two.

pub mod recall;
pub mod run;
pub mod store;

use std::path::{Path, PathBuf};

use crate::db::sessions::Session;

/// Root of the archival store: `<data_dir>/bot-memory`.
pub fn root(data_dir: &Path) -> PathBuf {
    data_dir.join("bot-memory")
}

/// Absolute path of the installed recall-hook wrapper (`<data_dir>/bin/
/// bot-memory-recall`), the `command` the per-session `settings.json` hook fires.
pub fn recall_hook_bin(data_dir: &Path) -> PathBuf {
    data_dir.join("bin").join("bot-memory-recall")
}

/// The identity + paths [`crate::sessions::connector_config::SessionConfig::apply_memory`]
/// needs to wire the hook + env into a session's private config dir.
#[derive(Debug, Clone)]
pub struct MemoryParams {
    pub session_name: String,
    /// The shared-tier key (`sessions.role_id`); empty ⇒ private-only bot.
    pub role_key: String,
    /// The store root exported as `BOT_MEMORY_DIR`.
    pub memory_dir: PathBuf,
    /// Absolute path to the recall-hook wrapper.
    pub hook_bin: PathBuf,
}

/// Whether this session participates in bot memory — i.e. it is a "bot", not a
/// plain pane. True when it has a standing job (a company, or a role sentence),
/// a role identity, curated CORE notes, or an existing archival store. A plain
/// session returns false so its launch stays byte-identical (no private config
/// dir, no hook). Once true at launch, the recall hook is present, so
/// mid-session saves go live next turn with no relaunch.
pub fn session_has_memory(s: &Session, data_dir: &Path) -> bool {
    let has_role = s.role_id.as_deref().map(str::trim).is_some_and(|r| !r.is_empty());
    let has_core = !s.memory.trim().is_empty();
    // A bot is a session with a STANDING JOB — one that belongs to a company, or
    // one the owner gave a role. Gating ONLY on "does it already have memory"
    // made the tier unreachable by construction: `role_id` has no production
    // setter, core notes start empty, and the on-disk store can only be written
    // by `supermux-memory`, whose `BOT_MEMORY_*` env is exported by
    // `apply_memory` — which runs only once this returns true. Nothing could
    // bootstrap in. Company-or-role is the product's own definition of bot-ness
    // and it gives the owner a REACHABLE switch: write the role, restart.
    let is_bot = s.company_id.is_some() || !s.desc.trim().is_empty();
    if has_role || has_core || is_bot {
        return true;
    }
    let root = root(data_dir);
    let bot_has = !store::read_index(&bot_dir(&root, &s.name)).is_empty();
    let role_has = s
        .role_id
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .is_some_and(|r| !store::read_index(&role_dir(&root, r)).is_empty());
    bot_has || role_has
}

/// Build the [`MemoryParams`] for a session known to have memory.
pub fn memory_params(s: &Session, data_dir: &Path) -> MemoryParams {
    MemoryParams {
        session_name: s.name.clone(),
        role_key: s
            .role_id
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
        memory_dir: root(data_dir),
        hook_bin: recall_hook_bin(data_dir),
    }
}

/// Whether this session's launch overlay ACTUALLY fires the recall hook — i.e.
/// memory is wired into the agent that is running (or that the next start will
/// resume), not merely eligible for it.
///
/// [`session_has_memory`] answers ELIGIBILITY, and the two diverge for the whole
/// life of a bot that became eligible after its last start: it has no hook, no
/// `Bash(supermux-memory *)` grant and no `BOT_MEMORY_*` env, so it physically
/// cannot save a note. The panel used to read the browse route's `200` as "wired"
/// and told those bots they simply hadn't written anything yet — the opposite of
/// the truth, and the one sentence that keeps the tier looking dead.
///
/// The overlay is rewritten by [`crate::sessions::connector_config::finish`] on
/// every launch, so its current content IS the running agent's wiring. A missing
/// or unreadable file is "not wired": nothing was ever launched with memory.
pub fn recall_hook_wired(data_dir: &Path, session_name: &str) -> bool {
    let path = crate::sessions::connector_config::settings_path(data_dir, session_name);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let hook = recall_hook_bin(data_dir);
    let hook = hook.to_string_lossy();
    // `apply_memory` writes `hooks.UserPromptSubmit = [{ hooks: [{ command }] }]`;
    // match on the command PATH rather than "has any hook", so a session wired
    // with some other hook is not mistaken for a memory-wired one.
    settings
        .get("hooks")
        .and_then(|h| h.get("UserPromptSubmit"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|groups| {
            groups.iter().any(|g| {
                g.get("hooks")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|hooks| {
                        hooks.iter().any(|h| {
                            h.get("command").and_then(serde_json::Value::as_str)
                                == Some(hook.as_ref())
                        })
                    })
            })
        })
}

/// Install (idempotently) the two wrapper scripts into `<data_dir>/bin`, each an
/// `exec` of the currently-running server binary with its hidden subcommand — so
/// the wrappers are always version-matched to the server (no separate artifact),
/// exactly like [`crate::external_edit::install_bridge_script`]:
///   * `bot-memory-recall` → `<server> __memory-recall` (the hook), and
///   * `supermux-memory`   → `<server> __memory-save "$@"` (the write CLI).
///
/// Best-effort: a write failure is logged and leaves memory degraded (no recall /
/// no save) until the next start, never blocks the server.
pub fn install_scripts(data_dir: &Path) {
    let bin_dir = data_dir.join("bin");
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "supermux-server".to_string());

    let recall = bin_dir.join("bot-memory-recall");
    let recall_body = format!("#!/bin/sh\nexec \"{exe}\" __memory-recall\n");
    if let Err(e) = write_executable(&bin_dir, &recall, &recall_body) {
        tracing::warn!(path = %recall.display(), error = %e, "could not install the bot-memory recall hook");
    }

    let cli = bin_dir.join("supermux-memory");
    let cli_body = format!("#!/bin/sh\nexec \"{exe}\" __memory-save \"$@\"\n");
    if let Err(e) = write_executable(&bin_dir, &cli, &cli_body) {
        tracing::warn!(path = %cli.display(), error = %e, "could not install the supermux-memory write CLI");
    }
}

/// Create `dir`, write `path` if changed, chmod 0o755. Mirrors
/// `external_edit::write_executable` (which predates it and stays local to that
/// module); idempotent so a hot restart loop never churns the inode. Shared with
/// [`crate::hook_cli::install_scripts`], which installs the four bot→app hook
/// wrappers into the SAME `<data_dir>/bin` with the same exec-the-server shape —
/// a third copy of this would be one more place for the chmod to drift.
pub(crate) fn write_executable(dir: &Path, path: &Path, contents: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let up_to_date = std::fs::read_to_string(path)
        .map(|cur| cur == contents)
        .unwrap_or(false);
    if !up_to_date {
        std::fs::write(path, contents)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// A session's PRIVATE tier dir: `<root>/bots/<session_name>`.
pub fn bot_dir(root: &Path, session_name: &str) -> PathBuf {
    root.join("bots").join(session_name)
}

/// A role's SHARED tier dir: `<root>/roles/<role_key>`.
pub fn role_dir(root: &Path, role_key: &str) -> PathBuf {
    root.join("roles").join(role_key)
}

/// Which tier a note lives in. Serialized as `scope:` in the note frontmatter and
/// selected by the write CLI's `--scope`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// `bots/<session_name>/` — visible only to that bot. The default for
    /// self-written notes.
    Bot,
    /// `roles/<role_key>/` — visible to every bot sharing the role.
    Role,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Bot => "bot",
            Scope::Role => "role",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "bot" | "private" => Some(Scope::Bot),
            "role" | "shared" => Some(Scope::Role),
            _ => None,
        }
    }
}

/// The note taxonomy, copied from the auto-memory format. Drives the recall
/// score's type weighting (a decision/bugfix outranks a bare reference on a tie).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteType {
    Reference,
    Feedback,
    Decision,
    Bugfix,
}

impl NoteType {
    pub fn as_str(self) -> &'static str {
        match self {
            NoteType::Reference => "reference",
            NoteType::Feedback => "feedback",
            NoteType::Decision => "decision",
            NoteType::Bugfix => "bugfix",
        }
    }

    /// Lenient parse; unknown types degrade to `reference` so a hand-authored or
    /// future note never fails to load.
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "feedback" => NoteType::Feedback,
            "decision" => NoteType::Decision,
            "bugfix" | "bug" | "fix" => NoteType::Bugfix,
            _ => NoteType::Reference,
        }
    }

    /// Recall score multiplier. Actionable, hard-won notes (a decision, a bug's
    /// fix, direct feedback) edge out a neutral reference when lexical scores tie.
    pub fn weight(self) -> f64 {
        match self {
            NoteType::Decision => 1.3,
            NoteType::Bugfix => 1.25,
            NoteType::Feedback => 1.15,
            NoteType::Reference => 1.0,
        }
    }
}

/// A slug: lowercase, alphanumerics and single dashes, bounded length. The note's
/// filename (`<slug>.md`) and its frontmatter `name`. Derived from the title so a
/// re-save of the same title lands on the same file (the dedup key).
pub fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut prev_dash = false;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.extend(c.to_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    // Bound the filename length; keep it whole-word where possible.
    const MAX: usize = 60;
    if out.len() > MAX {
        out.truncate(MAX);
        while out.ends_with('-') {
            out.pop();
        }
    }
    if out.is_empty() {
        "note".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row with every field at its zero value — the shape the gate reads.
    fn plain(name: &str) -> Session {
        Session {
            name: name.into(),
            display_name: name.into(),
            dir: "/tmp".into(),
            desc: String::new(),
            provider: "claude".into(),
            flags: String::new(),
            pinned: 0,
            archived: 0,
            auto_continue: 0,
            auto_continue_msg: String::new(),
            rate_limit_resume_text: String::new(),
            tags: "[]".into(),
            creator: String::new(),
            branch: String::new(),
            worktree: 0,
            worktree_repo: String::new(),
            mcp: String::new(),
            created_at: 0,
            start_count: 0,
            last_started: 0,
            last_send: 0,
            last_send_text: String::new(),
            task_summary: String::new(),
            cc_session_name: String::new(),
            cc_conversation_id: String::new(),
            codex_session_id: String::new(),
            start_error: String::new(),
            team_name: None,
            host_id: None,
            company_id: None,
            mark_pin: None,
            runtime: "native".into(),
            notif: "inherit".into(),
            seen_ts: None,
            seen_count: None,
            seen_epoch: None,
            model: String::new(),
            memory: String::new(),
            skills: "[]".into(),
            role_id: None,
            archive_on_stop: 0,
            config_dir: String::new(),
        }
    }

    /// The gate's whole point: a session with a STANDING JOB is a bot, and a bare
    /// pane is not. Before the widening neither branch could ever be reached from
    /// a fresh install — `role_id` has no setter, core notes start empty, and the
    /// disk branch needs env only `apply_memory` exports — so a new bot could
    /// never enter the tier at all.
    #[test]
    fn a_company_or_a_role_sentence_makes_a_session_a_bot() {
        let data_dir = std::path::Path::new("/nonexistent-supermux-data-dir");

        // No company, no role sentence, no notes → a plain pane, launch untouched.
        let bare = plain("pane");
        assert!(!session_has_memory(&bare, data_dir), "a plain pane stays out of the tier");

        // Belongs to a company → a bot, even with `role_id` and `memory` empty.
        let mut in_company = plain("mena");
        in_company.company_id = Some(7);
        assert!(session_has_memory(&in_company, data_dir), "a company bot is memory-eligible");

        // The owner wrote what it does → a bot. This is the REACHABLE switch: the
        // panel's own "What this bot does" field turns memory on at next start.
        let mut with_role = plain("reviewer");
        with_role.desc = "You review changes for correctness and clarity.".into();
        assert!(session_has_memory(&with_role, data_dir), "a role sentence is a standing job");

        // Whitespace is not a job — the field is trimmed, exactly like the core
        // notes branch beside it.
        let mut blank_role = plain("pane2");
        blank_role.desc = "   \n ".into();
        assert!(!session_has_memory(&blank_role, data_dir), "whitespace desc is not a role");
    }
}

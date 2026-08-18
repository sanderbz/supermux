//! The two lean subcommand entrypoints, dispatched from `main` before any server
//! boot (no DB, no listener) — same discipline as the `__edit` bridge:
//!
//!   * [`run_recall_hook`] — the `UserPromptSubmit` + `SessionStart` hook. Reads
//!     the bot identity from `BOT_MEMORY_*` env, the prompt from the hook's stdin
//!     JSON, and prints the recalled notes to stdout (Claude Code adds a hook's
//!     stdout to the turn's context).
//!   * [`run_save_cli`] — the `supermux-memory save …` write-back. Writes an
//!     archival note the recall hook re-reads fresh next turn (live, no relaunch).
//!
//! Both resolve the store root from `BOT_MEMORY_DIR` (exported at launch), so they
//! need no config file. Both are best-effort for the hook path: a recall failure
//! prints nothing and exits 0 rather than blocking the user's prompt.

use std::io::Read as _;
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use chrono::SecondsFormat;

use super::{bot_dir, role_dir, recall, store, NoteType, Scope};

const ENV_NAME: &str = "BOT_MEMORY_NAME";
const ENV_ROLE: &str = "BOT_MEMORY_ROLE";
const ENV_DIR: &str = "BOT_MEMORY_DIR";

/// `UserPromptSubmit`/`SessionStart` hook body. Never errors out loud: any
/// failure yields no output and a clean exit so a broken store can never wedge a
/// prompt.
pub fn run_recall_hook() -> Result<()> {
    let Some(root) = env_root() else {
        return Ok(());
    };
    let name = std::env::var(ENV_NAME).unwrap_or_default();
    if name.trim().is_empty() {
        return Ok(());
    }
    let role = std::env::var(ENV_ROLE).unwrap_or_default();

    // The hook's stdin is JSON: `{"prompt": "...", ...}` for UserPromptSubmit,
    // `{"source": "...", ...}` for SessionStart (no prompt → baseline prime).
    let prompt = read_prompt_from_stdin();

    let bot = bot_dir(&root, &name);
    let role_path = if role.trim().is_empty() {
        None
    } else {
        Some(role_dir(&root, &role))
    };
    let out = recall::recall(&bot, role_path.as_deref(), &prompt, chrono::Utc::now());
    if !out.is_empty() {
        print!("{out}");
    }
    Ok(())
}

/// Read the hook's stdin JSON and pull the `prompt` string. Missing/unparseable
/// stdin → empty (the `SessionStart` baseline path).
fn read_prompt_from_stdin() -> String {
    let mut buf = String::new();
    if std::io::stdin().read_to_string(&mut buf).is_err() || buf.trim().is_empty() {
        return String::new();
    }
    serde_json::from_str::<serde_json::Value>(&buf)
        .ok()
        .and_then(|v| v.get("prompt").and_then(|p| p.as_str()).map(String::from))
        .unwrap_or_default()
}

/// `supermux-memory save --scope bot|role --type <t> --title "…" --body "…"`.
/// `argv` is everything after the `__memory-save` subcommand (i.e. starts with
/// `save`). Prints `ADD|UPDATE|NOOP <path>` on success.
pub fn run_save_cli(argv: &[String]) -> Result<()> {
    let mut it = argv.iter();
    match it.next().map(String::as_str) {
        Some("save") => {}
        Some(other) => return Err(anyhow!("unknown subcommand '{other}' (only 'save' in v1)")),
        None => return Err(anyhow!("usage: supermux-memory save --type <t> --title <s> --body <s> [--scope bot|role]")),
    }

    let mut scope = Scope::Bot; // default: bots write PRIVATE (owner policy D1)
    let mut note_type = NoteType::Reference;
    let mut title: Option<String> = None;
    let mut body: Option<String> = None;
    while let Some(flag) = it.next() {
        let val = || it.clone().next().cloned();
        match flag.as_str() {
            "--scope" => {
                let v = val().ok_or_else(|| anyhow!("--scope needs a value"))?;
                scope = Scope::parse(&v).ok_or_else(|| anyhow!("--scope must be bot|role"))?;
                it.next();
            }
            "--type" => {
                let v = val().ok_or_else(|| anyhow!("--type needs a value"))?;
                note_type = NoteType::parse(&v);
                it.next();
            }
            "--title" => {
                title = Some(val().ok_or_else(|| anyhow!("--title needs a value"))?);
                it.next();
            }
            "--body" => {
                body = Some(val().ok_or_else(|| anyhow!("--body needs a value"))?);
                it.next();
            }
            other => return Err(anyhow!("unknown flag '{other}'")),
        }
    }

    let title = title.ok_or_else(|| anyhow!("--title is required"))?;
    let body = body.ok_or_else(|| anyhow!("--body is required"))?;
    if title.trim().is_empty() {
        return Err(anyhow!("--title must not be empty"));
    }

    let root = env_root().ok_or_else(|| anyhow!("{ENV_DIR} is not set (run inside a supermux session)"))?;
    let name = std::env::var(ENV_NAME).unwrap_or_default();
    if name.trim().is_empty() {
        return Err(anyhow!("{ENV_NAME} is not set (run inside a supermux session)"));
    }
    let role = std::env::var(ENV_ROLE).unwrap_or_default();

    let dir = store::tier_dir(&root, scope, &name, &role)?;
    let now = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let (outcome, slug) = store::save(&dir, scope, note_type, &title, &body, &now)?;
    println!("{} {}", outcome.as_str(), dir.join(format!("{slug}.md")).display());
    Ok(())
}

/// Resolve the store root from `BOT_MEMORY_DIR`.
fn env_root() -> Option<PathBuf> {
    std::env::var(ENV_DIR)
        .ok()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
}

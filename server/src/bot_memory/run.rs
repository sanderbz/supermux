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

/// `SUPERMUX_BRIEFING_FILE` — the path the launch wrote this session's rendered
/// SessionStart capability briefing to (see `agents::briefing`). One const, two
/// readers; kept here as a literal (rather than importing the server crate item)
/// so this lean subcommand entrypoint stays dependency-thin.
const ENV_BRIEFING_FILE: &str = "SUPERMUX_BRIEFING_FILE";

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
    // `{"hook_event_name":"SessionStart","source":"...", ...}` for SessionStart
    // (no prompt → baseline prime).
    let input = read_hook_input();

    // The capability briefing is paid ONCE per session: emit it on SessionStart
    // only, never on UserPromptSubmit (zero per-turn cost). It is pre-rendered by
    // the launch and read verbatim; a missing/empty file just means no briefing.
    if input.session_start {
        if let Some(text) = read_briefing() {
            let text = text.trim_end();
            if !text.is_empty() {
                println!("{text}");
            }
        }
    }

    let bot = bot_dir(&root, &name);
    let role_path = if role.trim().is_empty() {
        None
    } else {
        Some(role_dir(&root, &role))
    };
    let out = recall::recall(&bot, role_path.as_deref(), &input.prompt, chrono::Utc::now());
    if !out.is_empty() {
        print!("{out}");
    }
    Ok(())
}

/// What the recall hook needs off its stdin: the prompt (empty on SessionStart)
/// and whether this fire is a SessionStart.
struct HookInput {
    prompt: String,
    session_start: bool,
}

/// Read the hook's stdin JSON once and pull both the `prompt` and whether this is
/// a `SessionStart` fire. Missing/unparseable stdin → empty prompt, NOT a
/// SessionStart (so a broken/empty stdin never spuriously re-emits the briefing).
fn read_hook_input() -> HookInput {
    let mut buf = String::new();
    if std::io::stdin().read_to_string(&mut buf).is_err() || buf.trim().is_empty() {
        return HookInput {
            prompt: String::new(),
            session_start: false,
        };
    }
    let v = serde_json::from_str::<serde_json::Value>(&buf).unwrap_or(serde_json::Value::Null);
    let prompt = v
        .get("prompt")
        .and_then(|p| p.as_str())
        .unwrap_or_default()
        .to_string();
    HookInput {
        prompt,
        session_start: is_session_start(&v),
    }
}

/// Whether a hook's stdin JSON is a `SessionStart` fire. Primary signal is the
/// explicit `hook_event_name`; the fallback ("has `source`, no `prompt`") covers
/// a harness that omits the event name — and can never match a `UserPromptSubmit`
/// body, which always carries a `prompt`. Pure, so the classification is testable
/// without a real stdin.
fn is_session_start(v: &serde_json::Value) -> bool {
    let event = v.get("hook_event_name").and_then(|e| e.as_str()).unwrap_or("");
    event == "SessionStart"
        || (event.is_empty() && v.get("source").is_some() && v.get("prompt").is_none())
}

/// Read the pre-rendered SessionStart briefing from `SUPERMUX_BRIEFING_FILE`.
/// Best-effort: an unset var or unreadable file yields `None` (no briefing).
fn read_briefing() -> Option<String> {
    let path = std::env::var(ENV_BRIEFING_FILE).ok()?;
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    std::fs::read_to_string(path).ok()
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

#[cfg(test)]
mod tests {
    use super::is_session_start;
    use serde_json::json;

    #[test]
    fn session_start_detected_by_event_name() {
        assert!(is_session_start(&json!({
            "hook_event_name": "SessionStart",
            "source": "startup"
        })));
        // Even without `source`, the explicit event name is enough.
        assert!(is_session_start(&json!({ "hook_event_name": "SessionStart" })));
    }

    #[test]
    fn user_prompt_submit_is_not_session_start() {
        // The per-turn event MUST NOT re-emit the briefing (zero per-turn cost).
        assert!(!is_session_start(&json!({
            "hook_event_name": "UserPromptSubmit",
            "prompt": "do the thing"
        })));
        // Even an empty prompt on UPS is not a SessionStart via the event name.
        assert!(!is_session_start(&json!({
            "hook_event_name": "UserPromptSubmit",
            "prompt": ""
        })));
    }

    #[test]
    fn session_start_fallback_when_event_name_absent() {
        // A harness that omits the event name: `source` present + no `prompt`.
        assert!(is_session_start(&json!({ "source": "resume" })));
        // …but a body carrying a prompt is a turn, never the fallback.
        assert!(!is_session_start(&json!({ "source": "resume", "prompt": "x" })));
        // An empty object is not a SessionStart (fail closed → no briefing).
        assert!(!is_session_start(&json!({})));
    }
}

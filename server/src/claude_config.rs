//! Claude Code `~/.claude/settings.json` hook installer (TECH_PLAN §3.5, §3.6,
//! §6.5; M5b).
//!
//! amux drives its multi-signal status detector partly off Claude Code
//! `SettingsHook` events: on each tool call / notification / turn end, Claude runs
//! a tiny `curl` that POSTs to `/api/_internal/hook`. [`install_hooks`] writes
//! those hook entries into the user's global `~/.claude/settings.json`.
//!
//! **Three invariants (§3.5 — atomic + non-destructive):**
//! 1. **Idempotent.** Every amux command carries the literal marker
//!    [`MARKER`]; re-installing replaces the marked entry in place rather than
//!    appending a duplicate.
//! 2. **Coexistence-safe.** Only entries that are ours (matcher `"*"` AND a
//!    command containing the marker) are touched — a user's own hooks and any v2
//!    `amux`/cmux hooks pass through unchanged.
//! 3. **Atomic.** We write a sibling temp file, `fsync`, then `rename(2)` over the
//!    original (atomic on POSIX) — a crash mid-write never leaves a truncated
//!    settings file.
//!
//! **Security (§6.5).** The per-session token is delivered to the command through
//! the tmux pane env (`$AMUX_HOOK_TOKEN`), never written into this world-shared
//! file. The command references `$AMUX_HOOK_TOKEN` / `$AMUX_SESSION` / `$AMUX_URL`,
//! all resolved at fire time inside the session's own pane.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{json, Value};

/// Identifiability marker injected into every amux hook command (§3.5). Its
/// presence is how a re-install finds the entry it owns.
const MARKER: &str = "amux3-hook";

/// The five Claude `SettingsHook` events amux installs, paired with the `event`
/// token sent in the POST body (consumed by [`crate::sessions::status::HookEvent`]).
const EVENTS: [(&str, &str); 5] = [
    ("PreToolUse", "pre_tool"),
    ("PostToolUse", "post_tool"),
    ("Notification", "notification"),
    ("Stop", "stop"),
    ("SubagentStop", "subagent_stop"),
];

/// Install (or idempotently refresh) amux's Claude hooks for a session.
///
/// `session_name` is for diagnostics; `hook_token` is the per-session secret —
/// taken to make the caller's mint→install ordering explicit and to refuse a
/// session that would start firing unauthenticated hooks. The token is
/// deliberately NOT written into the global settings file (§6.5); it travels via
/// `$AMUX_HOOK_TOKEN` in the pane env.
pub fn install_hooks(session_name: &str, hook_token: &str) -> Result<()> {
    if hook_token.is_empty() {
        anyhow::bail!("refusing to install hooks for '{session_name}': empty hook token");
    }
    let dir = claude_config_dir();
    tracing::debug!(session = %session_name, dir = %dir.display(), "installing amux3 Claude hooks");
    install_hooks_at(&dir)
}

/// Resolve Claude's config directory: `$CLAUDE_CONFIG_DIR` (Claude Code's own
/// override — also what tests target) else `~/.claude`.
fn claude_config_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        let d = d.trim();
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
}

/// The merge + atomic-write core, factored out so tests can target a temp dir
/// without touching the developer's real `~/.claude`.
fn install_hooks_at(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)
        .with_context(|| format!("creating claude config dir {}", dir.display()))?;
    let path = dir.join("settings.json");

    // Read + parse the existing file. A present-but-unparseable file is left
    // ALONE (we never clobber a user's real settings we failed to understand).
    let mut root: Value = if path.exists() {
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text).with_context(|| {
                format!("{} is not valid JSON; refusing to overwrite it", path.display())
            })?
        }
    } else {
        json!({})
    };

    if !root.is_object() {
        anyhow::bail!(
            "{} is not a JSON object; refusing to overwrite it",
            path.display()
        );
    }

    merge_amux_hooks(&mut root);

    // Atomic write: temp sibling → fsync → rename over the original (§3.5).
    let tmp = dir.join("settings.json.amux3-tmp");
    let body = serde_json::to_string_pretty(&root)? + "\n";
    let mut f = std::fs::File::create(&tmp)
        .with_context(|| format!("creating {}", tmp.display()))?;
    f.write_all(body.as_bytes())?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, &path)
        .with_context(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Set/replace amux's marked entry under each `hooks.<Event>` array, preserving
/// every foreign entry and any other top-level keys.
fn merge_amux_hooks(root: &mut Value) {
    let obj = root.as_object_mut().expect("checked is_object by caller");

    // Ensure `hooks` is an object (a non-object value would be a malformed file;
    // replace only that subtree, never the whole file).
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    for (event_name, event_token) in EVENTS {
        let entry = amux_entry(event_token);
        let arr = hooks.entry(event_name).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr = arr.as_array_mut().unwrap();
        match arr.iter_mut().find(|e| is_amux_entry(e)) {
            Some(slot) => *slot = entry,
            None => arr.push(entry),
        }
    }
}

/// One Claude hook matcher block firing amux's command. `blocking:false` +
/// `--max-time 1` + `|| true` (§6.5) guarantee a down amux-server never stalls a
/// Claude tool call.
fn amux_entry(event_token: &str) -> Value {
    json!({
        "matcher": "*",
        "hooks": [ { "type": "command", "blocking": false, "command": hook_command(event_token) } ]
    })
}

/// The shell command Claude runs for an event. The leading `: amux3-hook;` is a
/// no-op that embeds the [`MARKER`] for idempotent detection without affecting
/// execution. Uses `$AMUX_HOOK_TOKEN` (the per-session secret, NOT the dashboard
/// `$AMUX_TOKEN`) and `$AMUX_URL` (so a reconfigured bind doesn't break hooks).
fn hook_command(event_token: &str) -> String {
    format!(
        ": {MARKER}; curl -fsS --max-time 1 -X POST \
         -H \"X-Amux-Hook-Token: $AMUX_HOOK_TOKEN\" \
         \"$AMUX_URL/api/_internal/hook\" \
         -d \"{{\\\"session\\\":\\\"$AMUX_SESSION\\\",\\\"event\\\":\\\"{event_token}\\\"}}\" || true"
    )
}

/// Is `entry` one amux installed? Matcher `"*"` AND a first command carrying the
/// marker — the §3.5 idempotency predicate.
fn is_amux_entry(entry: &Value) -> bool {
    let matcher_ok = entry.get("matcher").and_then(Value::as_str) == Some("*");
    let command_marked = entry
        .get("hooks")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|h| h.get("command"))
        .and_then(Value::as_str)
        .map(|c| c.contains(MARKER))
        .unwrap_or(false);
    matcher_ok && command_marked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("amux-claude-cfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn read(dir: &Path) -> Value {
        let text = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn fresh_install_writes_all_five_events() {
        let dir = temp_dir();
        install_hooks_at(&dir).unwrap();
        let v = read(&dir);
        let hooks = v["hooks"].as_object().unwrap();
        for (event, token) in EVENTS {
            let arr = hooks[event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{event} should have exactly one entry");
            let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains(MARKER), "{event} command missing marker");
            assert!(cmd.contains("$AMUX_HOOK_TOKEN"), "{event} must use the hook token");
            assert!(!cmd.contains("$AMUX_TOKEN"), "{event} must NOT leak the dashboard bearer");
            assert!(cmd.contains("--max-time 1"), "{event} must bound curl");
            assert!(cmd.contains("|| true"), "{event} must never fail the tool call");
            assert!(cmd.contains(&format!("\\\"event\\\":\\\"{token}\\\"")), "{event} token");
            assert_eq!(arr[0]["hooks"][0]["blocking"], json!(false));
        }
    }

    #[test]
    fn reinstall_is_idempotent() {
        let dir = temp_dir();
        install_hooks_at(&dir).unwrap();
        install_hooks_at(&dir).unwrap();
        install_hooks_at(&dir).unwrap();
        let v = read(&dir);
        for (event, _) in EVENTS {
            let arr = v["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{event}: re-install must not duplicate");
        }
    }

    #[test]
    fn preserves_foreign_hooks_and_keys() {
        let dir = temp_dir();
        // A user's own settings: an unrelated top-level key, a foreign Stop hook,
        // and a foreign PreToolUse matcher amux must not disturb.
        let seed = json!({
            "model": "opus",
            "hooks": {
                "Stop": [ { "matcher": "Bash", "hooks": [ { "type":"command", "command":"echo mine" } ] } ],
                "PreToolUse": [ { "matcher": "*", "hooks": [ { "type":"command", "command":"echo user-pretool" } ] } ]
            }
        });
        std::fs::write(dir.join("settings.json"), serde_json::to_string_pretty(&seed).unwrap()).unwrap();

        install_hooks_at(&dir).unwrap();
        let v = read(&dir);

        // Unrelated key survives.
        assert_eq!(v["model"], json!("opus"));
        // Foreign Stop hook survives; amux's marked Stop entry is appended.
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "foreign Stop hook kept + amux added");
        assert!(stop.iter().any(|e| e["hooks"][0]["command"] == json!("echo mine")));
        assert_eq!(stop.iter().filter(|e| is_amux_entry(e)).count(), 1);
        // The user's `*`-matcher PreToolUse (no marker) is foreign → kept; amux's
        // own `*`-matcher entry is added alongside it.
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2, "foreign user *-hook kept + amux added");
        assert!(pre.iter().any(|e| e["hooks"][0]["command"] == json!("echo user-pretool")));
        assert_eq!(pre.iter().filter(|e| is_amux_entry(e)).count(), 1);
    }

    #[test]
    fn refuses_to_clobber_unparseable_settings() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        std::fs::write(&path, "this is not { valid json").unwrap();
        let err = install_hooks_at(&dir);
        assert!(err.is_err(), "must refuse to overwrite an unparseable file");
        // The original bytes are untouched.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "this is not { valid json");
    }
}

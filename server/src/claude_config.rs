//! Claude Code `~/.claude/settings.json` hook installer (TECH_PLAN §3.5, §3.6,
//! §6.5; M5b).
//!
//! supermux drives its multi-signal status detector partly off Claude Code
//! `SettingsHook` events: on each tool call / notification / turn end, Claude runs
//! a tiny `curl` that POSTs to `/api/_internal/hook`. [`install_hooks`] writes
//! those hook entries into the user's global `~/.claude/settings.json`.
//!
//! **Three invariants (§3.5 — atomic + non-destructive):**
//! 1. **Idempotent.** Every supermux command carries the literal marker
//!    [`MARKER`]; re-installing replaces the marked entry in place rather than
//!    appending a duplicate.
//! 2. **Coexistence-safe.** Only entries that are ours (matcher `"*"` AND a
//!    command containing the marker) are touched — a user's own hooks and any v2
//!    `supermux`/cmux hooks pass through unchanged.
//! 3. **Atomic.** We write a sibling temp file, `fsync`, then `rename(2)` over the
//!    original (atomic on POSIX) — a crash mid-write never leaves a truncated
//!    settings file.
//!
//! **Security (§6.5).** The per-session token is delivered to the command through
//! the tmux pane env (`$SUPERMUX_HOOK_TOKEN`), never written into this world-shared
//! file. The command references `$SUPERMUX_HOOK_TOKEN` / `$SUPERMUX_SESSION` / `$SUPERMUX_URL`,
//! all resolved at fire time inside the session's own pane.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{json, Value};

/// Identifiability marker injected into every supermux hook command (§3.5). Its
/// presence is how a re-install finds the entry it owns.
const MARKER: &str = "supermux-hook";

/// The Claude `SettingsHook` events supermux installs, paired with the `event`
/// token sent in the POST body (consumed by [`crate::sessions::status::HookEvent`]).
///
/// `UserPromptSubmit` is the turn-start signal: it fires the moment the user
/// submits a prompt — BEFORE the model's first (often silent) "thinking" and
/// before any tool call — so the turn state machine in
/// [`crate::sessions::status`] can mark the session `Active` for the whole turn,
/// not just while a tool is running (the "busy while thinking" fix).
/// `SessionStart`/`SessionEnd`/`StopFailure` (hooks-10x TRACK 1) extend the set
/// for the lifecycle + error-badge features: `SessionStart` clears a stale
/// stopped/error, `SessionEnd` forces `Stopped` + clears activity, `StopFailure`
/// records the agent error (`rate_limit`/`billing_error`/…).
const EVENTS: [(&str, &str); 9] = [
    ("UserPromptSubmit", "user_prompt"),
    ("PreToolUse", "pre_tool"),
    ("PostToolUse", "post_tool"),
    ("Notification", "notification"),
    ("Stop", "stop"),
    ("SubagentStop", "subagent_stop"),
    ("SessionStart", "session_start"),
    ("SessionEnd", "session_end"),
    ("StopFailure", "stop_failure"),
];

/// Install (or idempotently refresh) supermux's Claude hooks for a session.
///
/// `session_name` is for diagnostics; `hook_token` is the per-session secret —
/// taken to make the caller's mint→install ordering explicit and to refuse a
/// session that would start firing unauthenticated hooks. The token is
/// deliberately NOT written into the global settings file (§6.5); it travels via
/// `$SUPERMUX_HOOK_TOKEN` in the pane env.
pub fn install_hooks(session_name: &str, hook_token: &str) -> Result<()> {
    if hook_token.is_empty() {
        anyhow::bail!("refusing to install hooks for '{session_name}': empty hook token");
    }
    let dir = claude_config_dir();
    tracing::debug!(session = %session_name, dir = %dir.display(), "installing supermux Claude hooks");
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

    merge_supermux_hooks(&mut root);

    // Atomic write: temp sibling → fsync → rename over the original (§3.5).
    let tmp = dir.join("settings.json.supermux-tmp");
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

/// Write Claude Code's `teammateMode` setting into the global
/// `~/.claude/settings.json` so that, when the experimental Agent Teams feature
/// is enabled (AT-B §3.1), a LEAD session spawns its teammates as **tmux
/// split-panes in the lead's own window** (`"tmux"`) — landing them on
/// supermux's process-pinned socket where we can address/stream them — rather
/// than the `in-process` backend (invisible: no pane to render). Only meaningful
/// alongside `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` injected into the pane env
/// (see [`crate::sessions::lifecycle`]).
///
/// Same three invariants as [`install_hooks`]: idempotent (it just sets one
/// top-level key), coexistence-safe (every other key/hook is preserved), and
/// atomic (temp-sibling → fsync → rename). A present-but-unparseable settings
/// file is left ALONE (never clobbered).
///
/// Non-destructive on disable: passing `enabled = false` does NOT strip the key
/// (a user may have set `teammateMode` themselves, and the env-gate is the real
/// switch) — disable is a no-op here so we never trample a manual setting. The
/// authoritative OFF gate is the absent `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
/// env var.
pub fn install_agent_teams_setting(session_name: &str) -> Result<()> {
    let dir = claude_config_dir();
    tracing::debug!(
        session = %session_name,
        dir = %dir.display(),
        "writing teammateMode=tmux for agent teams"
    );
    set_top_level_string_at(&dir, "teammateMode", "tmux")
}

/// Merge-set a single top-level STRING key in `~/.claude/settings.json`,
/// preserving every other key + the whole `hooks` subtree. Shares the atomic
/// write discipline of [`install_hooks_at`]. Factored out so it is unit-testable
/// against a temp dir.
fn set_top_level_string_at(dir: &Path, key: &str, value: &str) -> Result<()> {
    std::fs::create_dir_all(dir)
        .with_context(|| format!("creating claude config dir {}", dir.display()))?;
    let path = dir.join("settings.json");

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

    // Idempotent: only write when the value actually differs.
    if root.get(key).and_then(Value::as_str) == Some(value) {
        return Ok(());
    }
    root.as_object_mut().unwrap().insert(key.to_string(), json!(value));

    let tmp = dir.join("settings.json.supermux-tmp");
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

/// Set/replace supermux's marked entry under each `hooks.<Event>` array, preserving
/// every foreign entry and any other top-level keys.
fn merge_supermux_hooks(root: &mut Value) {
    let obj = root.as_object_mut().expect("checked is_object by caller");

    // Ensure `hooks` is an object (a non-object value would be a malformed file;
    // replace only that subtree, never the whole file).
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    for (event_name, event_token) in EVENTS {
        let entry = supermux_entry(event_token);
        let arr = hooks.entry(event_name).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr = arr.as_array_mut().unwrap();
        match arr.iter_mut().find(|e| is_supermux_entry(e)) {
            Some(slot) => *slot = entry,
            None => arr.push(entry),
        }
    }
}

/// One Claude hook matcher block firing supermux's command. `blocking:false` +
/// `--max-time 1` + `|| true` (§6.5) guarantee a down supermux-server never stalls a
/// Claude tool call.
fn supermux_entry(event_token: &str) -> Value {
    json!({
        "matcher": "*",
        "hooks": [ { "type": "command", "blocking": false, "command": hook_command(event_token) } ]
    })
}

/// The shell command Claude runs for an event (hooks-10x v2). The leading
/// `: supermux-hook;` is a no-op that embeds the [`MARKER`] for idempotent
/// detection without affecting execution.
///
/// **What's forwarded.** Claude delivers the event's rich JSON on the hook's
/// STDIN. We slurp a SIZE-CAPPED slice (`head -c 16384` — 16KB easily covers
/// `tool_name`/`tool_input.command`/`description`/`file_path`/`pattern`/`message`/
/// `error_type`; the only big field, Edit/Write `content`, is unneeded and may be
/// truncated) and splice it in as the `payload` of the POST body. If STDIN was
/// empty we substitute `{}` so the body stays valid JSON
/// (`{"session":…,"event":…,"payload":{}}`). A truncation can leave `$D`
/// syntactically invalid JSON — the server parses `payload` LENIENTLY (every
/// field optional; a parse failure is a no-op), so a clipped tail never trips a
/// tool call.
///
/// **Robustness.** `--max-time 1` + `|| true` (and `blocking:false` upstream)
/// guarantee a down/slow supermux-server never stalls a Claude tool call.
///
/// **Security (§6.5).** Uses `$SUPERMUX_HOOK_TOKEN` (the per-session secret, NOT
/// the dashboard `$SUPERMUX_TOKEN`) and `$SUPERMUX_URL` (so a reconfigured bind
/// doesn't break hooks). The payload is held in-memory only server-side and is
/// never persisted.
fn hook_command(event_token: &str) -> String {
    // `Content-Type: application/json` is REQUIRED: curl's `-d` defaults to
    // `application/x-www-form-urlencoded`, which axum's `Json` extractor rejects
    // with 415 — so without this header EVERY hook POST silently fails (the
    // `|| true` swallows it) and the turn state machine, the detector's
    // authoritative signal, never receives a single event. That dead-hooks state
    // is what made the heartbeat the de-facto only signal and let typing-echo
    // flip a session to busy. Sending the header makes the hooks actually land.
    format!(
        ": {MARKER}; D=$(head -c 16384); [ -z \"$D\" ] && D='{{}}'; \
         curl -fsS --max-time 1 -X POST \
         -H \"Content-Type: application/json\" \
         -H \"X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN\" \
         \"$SUPERMUX_URL/api/_internal/hook\" \
         -d \"{{\\\"session\\\":\\\"$SUPERMUX_SESSION\\\",\\\"event\\\":\\\"{event_token}\\\",\\\"payload\\\":$D}}\" || true"
    )
}

/// Is `entry` one supermux installed? Matcher `"*"` AND a first command carrying the
/// marker — the §3.5 idempotency predicate.
fn is_supermux_entry(entry: &Value) -> bool {
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
        let d = std::env::temp_dir().join(format!("supermux-claude-cfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn read(dir: &Path) -> Value {
        let text = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn fresh_install_writes_all_events() {
        let dir = temp_dir();
        install_hooks_at(&dir).unwrap();
        let v = read(&dir);
        let hooks = v["hooks"].as_object().unwrap();
        for (event, token) in EVENTS {
            let arr = hooks[event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{event} should have exactly one entry");
            let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains(MARKER), "{event} command missing marker");
            assert!(cmd.contains("$SUPERMUX_HOOK_TOKEN"), "{event} must use the hook token");
            assert!(!cmd.contains("$SUPERMUX_TOKEN"), "{event} must NOT leak the dashboard bearer");
            assert!(cmd.contains("--max-time 1"), "{event} must bound curl");
            assert!(cmd.contains("|| true"), "{event} must never fail the tool call");
            // Content-Type is REQUIRED — axum's Json extractor 415s a curl `-d`
            // POST (default form-urlencoded) without it, silently killing every
            // hook (the regression that left the turn state machine dead).
            assert!(
                cmd.contains("Content-Type: application/json"),
                "{event} must send Content-Type: application/json or the Json extractor 415s it"
            );
            assert!(cmd.contains(&format!("\\\"event\\\":\\\"{token}\\\"")), "{event} token");
            // hooks-10x v2: forward Claude's STDIN JSON as `payload`, size-capped,
            // defaulting to `{}` when empty so the body stays valid JSON.
            assert!(cmd.contains("head -c 16384"), "{event} must size-cap the payload");
            assert!(cmd.contains("D='{}'"), "{event} must default empty stdin to {{}}");
            assert!(cmd.contains("\\\"payload\\\":$D"), "{event} must splice the payload");
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
        // and a foreign PreToolUse matcher supermux must not disturb.
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
        // Foreign Stop hook survives; supermux's marked Stop entry is appended.
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "foreign Stop hook kept + supermux added");
        assert!(stop.iter().any(|e| e["hooks"][0]["command"] == json!("echo mine")));
        assert_eq!(stop.iter().filter(|e| is_supermux_entry(e)).count(), 1);
        // The user's `*`-matcher PreToolUse (no marker) is foreign → kept; supermux's
        // own `*`-matcher entry is added alongside it.
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2, "foreign user *-hook kept + supermux added");
        assert!(pre.iter().any(|e| e["hooks"][0]["command"] == json!("echo user-pretool")));
        assert_eq!(pre.iter().filter(|e| is_supermux_entry(e)).count(), 1);
    }

    #[test]
    fn teammate_mode_sets_top_level_key_and_preserves_hooks() {
        let dir = temp_dir();
        // Seed an existing settings file with hooks + a user key.
        install_hooks_at(&dir).unwrap();
        let before = read(&dir);
        let stop_len = before["hooks"]["Stop"].as_array().unwrap().len();

        set_top_level_string_at(&dir, "teammateMode", "tmux").unwrap();
        let v = read(&dir);
        assert_eq!(v["teammateMode"], json!("tmux"));
        // The hooks subtree is untouched.
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), stop_len);
    }

    #[test]
    fn teammate_mode_is_idempotent() {
        let dir = temp_dir();
        set_top_level_string_at(&dir, "teammateMode", "tmux").unwrap();
        set_top_level_string_at(&dir, "teammateMode", "tmux").unwrap();
        let v = read(&dir);
        assert_eq!(v["teammateMode"], json!("tmux"));
    }

    #[test]
    fn teammate_mode_refuses_unparseable_settings() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        std::fs::write(&path, "not { json").unwrap();
        assert!(set_top_level_string_at(&dir, "teammateMode", "tmux").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not { json");
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

//! Claude Code `~/.claude/settings.json` hook installer (transport-aware).
//!
//! supermux drives its multi-signal status detector partly off Claude Code
//! `SettingsHook` events: on each tool call / notification / turn end, Claude runs
//! a tiny `curl` that POSTs to `/api/_internal/hook`. [`install_hooks`] writes
//! those hook entries into the user's global `~/.claude/settings.json`.
//!
//! **Three invariants — atomic + non-destructive:**
//! 1. **Idempotent.** Every supermux command carries the literal marker
//!    [`MARKER`]; re-installing replaces the marked entry in place rather than
//!    appending a duplicate.
//! 2. **Coexistence-safe.** Only entries that are ours (matcher `"*"` AND a
//!    command containing the marker) are touched — a user's own hooks and any
//!    foreign `supermux`/cmux hooks pass through unchanged.
//! 3. **Atomic.** We write a sibling temp file, then `rename(2)` over the
//!    original (atomic on POSIX same-fs; SFTP RENAME is required atomic per
//!    RFC 5; for SshFileTransport's shell-out `mv` is atomic on the same
//!    filesystem) — a crash mid-write never leaves a truncated settings file.
//!
//! **Transport-aware.** The merge + atomic-write core funnels through a
//! [`FileTransport`] so both the local `~/.claude/settings.json` AND a remote
//! host's `~/.claude/settings.json` (over the [`HostPool`]'s ControlMaster) are
//! served by the same code path. The invariants above hold for both — both
//! transports implement `rename` atomically and `write` to a temp sibling first.
//!
//! **Security.** The per-session token is delivered to the command through
//! the tmux pane env (`$SUPERMUX_HOOK_TOKEN`), never written into this world-shared
//! file. The command references `$SUPERMUX_HOOK_TOKEN` / `$SUPERMUX_SESSION` / `$SUPERMUX_URL`,
//! all resolved at fire time inside the session's own pane.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::files::transport::FileTransport;

/// Identifiability marker injected into every supermux hook command. Its
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
/// `SessionStart`/`SessionEnd`/`StopFailure` extend the set
/// for the lifecycle + error-badge features: `SessionStart` clears a stale
/// stopped/error, `SessionEnd` forces `Stopped` + clears activity, `StopFailure`
/// records the agent error (`rate_limit`/`billing_error`/…).
///
/// `PostToolUseFailure` + `PermissionRequest` are the chat data plane's live
/// overlay (both verified firing on Claude Code 2.1.227 and 2.1.231):
/// * `PostToolUseFailure` — the DEDICATED tool-failure event (payload adds
///   `tool_use_id`, `error`, `is_interrupt`, `duration_ms`); it makes the
///   `error`-carrying-`PostToolUse` heuristic a fallback rather than the only
///   signal.
/// * `PermissionRequest` — fires the moment Claude DISPLAYS a permission dialog,
///   BEFORE any decision, carrying `tool_name` / `tool_input` /
///   `permission_mode`. **Trigger-only, and it must stay that way**: this hook's
///   STDOUT is how a hook decides the dialog, so supermux's entry is observe-only
///   — `-o /dev/null` (plus nothing else printing) keeps it inert, verified live
///   (the dialog displayed and behaved normally) and pinned by
///   `permission_request_command_is_inert_emits_no_stdout`.
const EVENTS: [(&str, &str); 12] = [
    ("UserPromptSubmit", "user_prompt"),
    ("PreToolUse", "pre_tool"),
    ("PostToolUse", "post_tool"),
    ("Notification", "notification"),
    ("Stop", "stop"),
    // A Task sub-agent started/finished. Both POST on the PARENT session's token
    // (subagents share the parent session_id), so they drive the display-only
    // outstanding-subagent count — never the status turn boundary.
    ("SubagentStart", "subagent_start"),
    ("SubagentStop", "subagent_stop"),
    ("SessionStart", "session_start"),
    ("SessionEnd", "session_end"),
    ("StopFailure", "stop_failure"),
    ("PostToolUseFailure", "post_tool_failure"),
    // Observe-only (see the note above): NEVER give this entry stdout.
    ("PermissionRequest", "permission_request"),
];

/// Install (or idempotently refresh) supermux's Claude hooks for a session.
///
/// `session_name` is for diagnostics; `hook_token` is the per-session secret —
/// taken to make the caller's mint→install ordering explicit and to refuse a
/// session that would start firing unauthenticated hooks. The token is
/// deliberately NOT written into the global settings file; it travels via
/// `$SUPERMUX_HOOK_TOKEN` in the pane env.
///
/// `transport` is the [`FileTransport`] to use — `LocalFileTransport` for a
/// local session, a `SshFileTransport` (from the [`HostPool`]) for a remote
/// session. The atomic-rename + marker-based idempotent merge invariants hold
/// across both: both impls implement `rename` atomically on the same filesystem
/// (POSIX `rename(2)` / shell-out `mv -f`).
///
/// `settings_path` is an optional explicit path to the settings file. When
/// `None`, the default is `<claude_config_dir>/settings.json` for the local
/// transport (`$CLAUDE_CONFIG_DIR` env override else `~/.claude`), and the
/// relative `.claude/settings.json` (resolved against the SSH session's $HOME)
/// for a remote transport — both are equivalent to the documented "user-global
/// settings file" path on Claude Code's docs.
pub async fn install_hooks(
    session_name: &str,
    hook_token: &str,
    transport: &dyn FileTransport,
    settings_path: Option<&Path>,
) -> Result<()> {
    if hook_token.is_empty() {
        anyhow::bail!("refusing to install hooks for '{session_name}': empty hook token");
    }
    let path = resolve_settings_path(transport, settings_path);
    tracing::debug!(
        session = %session_name,
        is_local = transport.is_local(),
        path = %path.display(),
        "installing supermux Claude hooks",
    );
    install_hooks_at_path(transport, &path).await
}

/// Resolve Claude's config directory for the LOCAL host: `$CLAUDE_CONFIG_DIR`
/// (Claude Code's own override — also what tests target) else `~/.claude`.
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

/// Resolve the settings file path for the given transport. An explicit
/// `override_path` always wins. Otherwise:
///
/// * Local transport → `<claude_config_dir>/settings.json` (env override or
///   `~/.claude/settings.json`).
/// * Remote transport → `.claude/settings.json` — a relative path that the
///   ssh shell-out resolves against the remote login's `$HOME`. This matches
///   Claude Code's documented "user-global settings" location on the remote.
fn resolve_settings_path(transport: &dyn FileTransport, override_path: Option<&Path>) -> PathBuf {
    if let Some(p) = override_path {
        return p.to_path_buf();
    }
    if transport.is_local() {
        claude_config_dir().join("settings.json")
    } else {
        PathBuf::from(".claude/settings.json")
    }
}

/// The atomic-write + idempotent-merge core, factored out so tests + the
/// `install_agent_teams_setting` path share one code path. Reads `path`
/// through the transport, merges, writes a sibling temp, renames.
async fn install_hooks_at_path(transport: &dyn FileTransport, path: &Path) -> Result<()> {
    let lock = settings_write_lock(path);
    let _guard = lock.lock().await;
    let mut root = read_settings_or_empty(transport, path).await?;
    merge_supermux_hooks(&mut root);
    atomic_write_settings(transport, path, &root).await
}

/// Read + parse the settings file at `path` via the transport. Returns an
/// empty JSON object when the file does not exist or is empty. Returns Err
/// for a present-but-unparseable file (we NEVER clobber a real user's
/// settings we failed to understand) or for a top-level non-object root.
async fn read_settings_or_empty(transport: &dyn FileTransport, path: &Path) -> Result<Value> {
    // `FileTransport::exists` is DEFINITIVE: `Ok(false)` only when the
    // transport proved the file is absent. An indeterminate answer is an
    // `Err` and aborts the install — never an empty object.
    //
    // This used to be `transport.stat(path).await.is_ok()`, which conflated
    // "absent" with "could not ask" and made every stat failure a silent
    // reset of the user's settings.json: `root` became `{}`, the merge added
    // only supermux's hooks, and the atomic write renamed that over the real
    // file, destroying `statusLine`, `permissions`, `env` and the user's own
    // hooks. It was reachable in practice — the remote `stat` shells out to
    // GNU `stat -c` (see `files::transport`), which exits non-zero on a
    // BSD/macOS host, so every session start against such a host wiped the
    // remote settings; a momentarily unavailable ssh mux did the same.
    let exists = transport.exists(path).await.with_context(|| {
        format!(
            "cannot determine whether {} exists; refusing to overwrite it",
            path.display()
        )
    })?;
    let root: Value = if exists {
        let bytes = transport
            .read(path)
            .await
            .with_context(|| format!("reading {}", path.display()))?;
        let text = String::from_utf8(bytes).with_context(|| {
            format!(
                "{} is not valid UTF-8; refusing to overwrite it",
                path.display()
            )
        })?;
        if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text).with_context(|| {
                format!(
                    "{} is not valid JSON; refusing to overwrite it",
                    path.display()
                )
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
    Ok(root)
}

/// Atomic write: serialize `root`, write to a temp sibling, then rename over
/// the original — atomic on POSIX same-fs; SFTP RENAME atomic per
/// RFC 5; SshFileTransport's shell-out `mv` is atomic on the same fs.
///
/// The transport's `write` impls both create parent dirs as needed, so we
/// don't have to pre-create `~/.claude` ourselves.
async fn atomic_write_settings(
    transport: &dyn FileTransport,
    path: &Path,
    root: &Value,
) -> Result<()> {
    let tmp = sibling_tmp(path);
    let body = serde_json::to_string_pretty(root)? + "\n";
    transport
        .write(&tmp, body.as_bytes())
        .await
        .with_context(|| format!("writing {}", tmp.display()))?;
    transport
        .rename(&tmp, path)
        .await
        .with_context(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Compute the sibling temp path used by the atomic write — same directory
/// as `path` so `rename(2)` is same-filesystem (and therefore atomic). The
/// `.supermux-tmp` infix keeps the legacy prefix (a crash-recovery cleanup
/// script globbing `*.supermux-tmp*` still finds leftovers) but the name is
/// made UNIQUE per writer.
///
/// Uniqueness is not cosmetic. `install_hooks` runs on every session start,
/// from independent tasks (HTTP start, scheduler, board dispatch, teams), so
/// two installs can overlap. With one fixed temp name they wrote the SAME
/// temp file and then both renamed it: the loser's `rename` hit ENOENT (that
/// session silently got no hooks) and, worse, one writer's `O_TRUNC` on the
/// temp was visible to the other's rename, briefly publishing a partial
/// settings.json to any Claude Code booting at that instant. A unique name
/// per write makes each temp private; [`settings_write_lock`] then serialises
/// the read→merge→write→rename so neither merge is lost.
fn sibling_tmp(path: &Path) -> PathBuf {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "settings.json".to_string());
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    dir.join(format!(
        "{name}.supermux-tmp.{}.{n}",
        std::process::id()
    ))
}

/// Per-settings-path write lock. The merge is read→modify→write, so two
/// concurrent installs against the same file both read the pre-state and the
/// second rename discards the first one's merge (e.g. the teams task's
/// `teammateMode` + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` silently vanishing
/// because a scheduled session's hook install landed after it). Holding this
/// mutex across the whole sequence makes the merge atomic with respect to
/// other supermux writers in this process.
///
/// Keyed by path string so unrelated files (local vs. a remote's
/// `.claude/settings.json`) never block each other. Note the key is the path
/// only — for remote transports two different hosts share the same relative
/// path, so they serialise with each other; installs are sub-second and rare,
/// so the extra contention is not worth a host-aware key.
fn settings_write_lock(path: &Path) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let key = path.to_string_lossy().into_owned();
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard.entry(key).or_default().clone()
}

/// Write Claude Code's `teammateMode` setting + the
/// `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env entry into the user's
/// `~/.claude/settings.json` so that, when the experimental Agent Teams
/// feature is enabled, a LEAD session spawns its teammates as
/// **tmux split-panes in the lead's own window** (`"tmux"`) — landing them
/// on supermux's process-pinned socket where we can address/stream them —
/// rather than the `in-process` backend (invisible: no pane to render).
/// Only meaningful alongside `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
/// injected into the pane env (see [`crate::sessions::lifecycle`]).
///
/// Same three invariants as [`install_hooks`]: idempotent (it just sets one
/// top-level key + one env var), coexistence-safe (every other key/hook is
/// preserved), and atomic (temp-sibling → rename). A present-but-unparseable
/// settings file is left ALONE (never clobbered).
///
/// Non-destructive on disable: passing `enabled = false` does NOT strip the key
/// (a user may have set `teammateMode` themselves, and the env-gate is the real
/// switch) — disable is a no-op here so we never trample a manual setting. The
/// authoritative OFF gate is the absent `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
/// env var.
pub async fn install_agent_teams_setting(
    session_name: &str,
    transport: &dyn FileTransport,
    settings_path: Option<&Path>,
) -> Result<()> {
    let path = resolve_settings_path(transport, settings_path);
    tracing::debug!(
        session = %session_name,
        is_local = transport.is_local(),
        path = %path.display(),
        "writing teammateMode=tmux + env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 for agent teams"
    );
    set_top_level_string_at(transport, &path, "teammateMode", "tmux").await?;
    // Belt-and-suspenders: ALSO write the env-gate into settings.json's `env`
    // block. The doc (code.claude.com/docs/en/agent-teams) recommends the
    // settings.json `env` path as the most reliable for headless launches —
    // process env (via lifecycle::build_env) and settings.json env BOTH work,
    // but the settings.json route survives spawn paths that don't inherit the
    // process env perfectly. Without this, the team-formation tools never
    // load and the lead silently falls back to the regular Task tool.
    set_env_var_at(transport, &path, "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1").await
}

/// Merge-set `env.<key> = <value>` in the settings file, creating the `env`
/// object if absent. Same atomic + idempotent discipline as
/// [`set_top_level_string_at`]: temp-sibling → rename, only writes when the
/// value differs, preserves every other key + the whole `hooks` subtree.
async fn set_env_var_at(
    transport: &dyn FileTransport,
    path: &Path,
    key: &str,
    value: &str,
) -> Result<()> {
    let lock = settings_write_lock(path);
    let _guard = lock.lock().await;
    let mut root = read_settings_or_empty(transport, path).await?;

    let env_entry = root
        .as_object_mut()
        .unwrap()
        .entry("env".to_string())
        .or_insert_with(|| json!({}));
    if !env_entry.is_object() {
        *env_entry = json!({});
    }
    let env_obj = env_entry.as_object_mut().unwrap();

    // Idempotent: only write when the value actually differs.
    if env_obj.get(key).and_then(Value::as_str) == Some(value) {
        return Ok(());
    }
    env_obj.insert(key.to_string(), json!(value));

    atomic_write_settings(transport, path, &root).await
}

/// Merge-set a single top-level STRING key in the settings file, preserving
/// every other key + the whole `hooks` subtree. Shares the atomic write
/// discipline of [`install_hooks_at_path`]. Factored out so it is
/// unit-testable against a temp dir + the local transport.
async fn set_top_level_string_at(
    transport: &dyn FileTransport,
    path: &Path,
    key: &str,
    value: &str,
) -> Result<()> {
    let lock = settings_write_lock(path);
    let _guard = lock.lock().await;
    let mut root = read_settings_or_empty(transport, path).await?;

    // Idempotent: only write when the value actually differs.
    if root.get(key).and_then(Value::as_str) == Some(value) {
        return Ok(());
    }
    root.as_object_mut()
        .unwrap()
        .insert(key.to_string(), json!(value));

    atomic_write_settings(transport, path, &root).await
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
/// `--max-time 1` + `|| true` guarantee a down supermux-server never stalls a
/// Claude tool call.
fn supermux_entry(event_token: &str) -> Value {
    json!({
        "matcher": "*",
        "hooks": [ { "type": "command", "blocking": false, "command": hook_command(event_token) } ]
    })
}

/// The shell command Claude runs for an event. The leading
/// `: supermux-hook;` is a no-op that embeds the [`MARKER`] for idempotent
/// detection without affecting execution.
///
/// **What's forwarded.** Claude delivers the event's rich JSON on the hook's
/// STDIN. We slurp a SIZE-CAPPED slice (`head -c 16384` — 16KB easily covers
/// `tool_name`/`tool_input.command`/`description`/`file_path`/`pattern`/`message`/
/// `error_type`; the only big field, Edit/Write `content`, is unneeded and may be
/// truncated) and splice it in as the `payload` of the POST body. If STDIN was
/// empty we substitute `{}` so the body stays valid JSON
/// (`{"session":…,"event":…,"payload":{}}`). A truncation cuts `$D` mid-token
/// and therefore invalidates the WHOLE body, not just the payload — the server
/// salvages `session`+`event` from the intact prefix and drops the payload
/// (`hooks::salvage_truncated_body`), and parses `payload` LENIENTLY besides
/// (every field optional; a parse failure is a no-op), so a clipped tail
/// neither loses the event nor trips a tool call.
///
/// **Robustness.** `--max-time 1` + `|| true` (and `blocking:false` upstream)
/// guarantee a down/slow supermux-server never stalls a Claude tool call.
///
/// **Silence.** `-o /dev/null` discards the server's `{"ok":true}` response
/// body: a hook's stdout is fed back into Claude's context as a
/// `hook_success` attachment, so without it every hook fire injected a noise
/// line (measured: 832 of 3397 lines (~25%) of a live transcript).
///
/// **Security.** Uses `$SUPERMUX_HOOK_TOKEN` (the per-session secret, NOT
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
         curl -fsS -o /dev/null --max-time 1 -X POST \
         -H \"Content-Type: application/json\" \
         -H \"X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN\" \
         \"$SUPERMUX_URL/api/_internal/hook\" \
         -d \"{{\\\"session\\\":\\\"$SUPERMUX_SESSION\\\",\\\"event\\\":\\\"{event_token}\\\",\\\"payload\\\":$D}}\" || true"
    )
}

/// Is `entry` one supermux installed? Matcher `"*"` AND a first command carrying the
/// marker — the idempotency predicate.
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
    use crate::files::transport::LocalFileTransport;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("supermux-claude-cfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn read_json(path: &Path) -> Value {
        let text = std::fs::read_to_string(path).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    /// Local-transport convenience wrapper for tests: drive
    /// [`install_hooks_at_path`] against a temp dir's settings.json with the
    /// real [`LocalFileTransport`]. Mirrors the legacy `install_hooks_at(dir)`
    /// helper so the existing golden snapshots stay byte-for-byte stable.
    async fn install_hooks_at(dir: &Path) -> Result<()> {
        let path = dir.join("settings.json");
        let t = LocalFileTransport;
        install_hooks_at_path(&t, &path).await
    }

    /// A settings.json with the shapes a real user has and that a clobber
    /// would destroy: their own Stop hook, a statusLine, permissions, env.
    const USER_SETTINGS: &str = r#"{
      "model": "opus",
      "statusLine": { "type": "command", "command": "~/bin/my-statusline" },
      "permissions": { "allow": ["Bash(git status)"] },
      "env": { "MY_VAR": "1" },
      "hooks": { "Stop": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "notify-send done" } ] } ] }
    }"#;

    fn write_user_settings(dir: &Path) -> PathBuf {
        let path = dir.join("settings.json");
        std::fs::write(&path, USER_SETTINGS).unwrap();
        path
    }

    fn assert_user_keys_intact(v: &Value) {
        assert_eq!(v["model"], json!("opus"), "model must survive");
        assert_eq!(
            v["statusLine"]["command"],
            json!("~/bin/my-statusline"),
            "the user's statusLine must survive (the A2 statusline tap wraps it — losing it loses the original)"
        );
        assert_eq!(v["permissions"]["allow"][0], json!("Bash(git status)"));
        assert_eq!(v["env"]["MY_VAR"], json!("1"));
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert!(
            stop.iter().any(|e| e["hooks"][0]["command"]
                .as_str()
                .is_some_and(|c| c.contains("notify-send"))),
            "the user's own Stop hook must survive"
        );
    }

    /// Delegates everything to the real local transport, but lets a test
    /// break `stat` and/or `exists` independently.
    struct ProbeTransport {
        inner: LocalFileTransport,
        /// `stat` always fails — models a remote whose `stat -c` is not GNU
        /// (macOS/BSD), or a blipped ssh ControlMaster.
        break_stat: bool,
        /// `exists` cannot answer — models the indeterminate case.
        break_exists: bool,
    }

    #[async_trait::async_trait]
    impl FileTransport for ProbeTransport {
        async fn read(&self, path: &Path) -> Result<Vec<u8>> {
            self.inner.read(path).await
        }
        async fn write(&self, path: &Path, content: &[u8]) -> Result<()> {
            self.inner.write(path, content).await
        }
        async fn list_dir(&self, path: &Path) -> Result<Vec<crate::files::transport::DirEntry>> {
            self.inner.list_dir(path).await
        }
        async fn stat(&self, path: &Path) -> Result<crate::files::transport::Stat> {
            if self.break_stat {
                anyhow::bail!("stat: illegal option -- c");
            }
            self.inner.stat(path).await
        }
        async fn delete(&self, path: &Path) -> Result<()> {
            self.inner.delete(path).await
        }
        async fn rename(&self, from: &Path, to: &Path) -> Result<()> {
            self.inner.rename(from, to).await
        }
        async fn exists(&self, path: &Path) -> Result<bool> {
            if self.break_exists {
                anyhow::bail!("ssh: connection closed");
            }
            self.inner.exists(path).await
        }
    }

    /// REGRESSION: existence must not be derived from `stat`. A remote whose
    /// `stat -c` is unsupported (BSD/macOS) used to read as "no settings file
    /// yet" — and since `write` + `rename` still worked, the merge published a
    /// document containing ONLY supermux's hooks over the user's real file, on
    /// every session start.
    #[tokio::test]
    async fn broken_stat_does_not_clobber_existing_settings() {
        let dir = temp_dir();
        let path = write_user_settings(&dir);
        let t = ProbeTransport {
            inner: LocalFileTransport,
            break_stat: true,
            break_exists: false,
        };
        install_hooks_at_path(&t, &path).await.unwrap();
        let v = read_json(&path);
        assert_user_keys_intact(&v);
        assert!(
            v["hooks"]["PreToolUse"].is_array(),
            "the install itself must still have happened"
        );
    }

    /// When the transport genuinely cannot tell whether the file exists, the
    /// install FAILS and the file is left byte-identical. "Could not ask" must
    /// never be merged as "empty".
    #[tokio::test]
    async fn indeterminate_existence_refuses_to_write() {
        let dir = temp_dir();
        let path = write_user_settings(&dir);
        let before = std::fs::read_to_string(&path).unwrap();
        let t = ProbeTransport {
            inner: LocalFileTransport,
            break_stat: false,
            break_exists: true,
        };
        let err = install_hooks_at_path(&t, &path).await.unwrap_err();
        assert!(
            format!("{err:#}").contains("refusing to overwrite"),
            "unexpected error: {err:#}"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            before,
            "settings.json must be untouched when existence is unknown"
        );
    }

    /// Concurrent installs against the same settings file must not lose each
    /// other's merges, must not fight over one temp path, and must leave no
    /// temp files behind. `install_hooks` runs on every session start from
    /// independent tasks (HTTP start, scheduler, board dispatch, teams), so
    /// this overlap is routine.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_installs_do_not_lose_merges() {
        let dir = temp_dir();
        let path = write_user_settings(&dir);
        let mut tasks = Vec::new();
        for i in 0..6 {
            let p = path.clone();
            tasks.push(tokio::spawn(async move {
                let t = LocalFileTransport;
                if i % 2 == 0 {
                    install_hooks_at_path(&t, &p).await
                } else {
                    set_top_level_string_at(&t, &p, &format!("key{i}"), "v").await
                }
            }));
        }
        for t in tasks {
            t.await.unwrap().expect("every concurrent install must succeed");
        }
        let v = read_json(&path);
        assert_user_keys_intact(&v);
        assert!(v["hooks"]["PreToolUse"].is_array(), "hooks lost");
        for i in [1, 3, 5] {
            assert_eq!(
                v[format!("key{i}")],
                json!("v"),
                "concurrent writer {i}'s merge was lost"
            );
        }
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("supermux-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
    }

    #[tokio::test]
    async fn fresh_install_writes_all_events() {
        let dir = temp_dir();
        install_hooks_at(&dir).await.unwrap();
        let v = read_json(&dir.join("settings.json"));
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
            // The response body ({"ok":true}) must be discarded: hook stdout is
            // re-injected into Claude's context as a `hook_success` attachment,
            // and without -o /dev/null it was ~25% of a live transcript.
            assert!(
                cmd.contains("-o /dev/null"),
                "{event} must discard curl stdout or the hook response pollutes Claude's context"
            );
            // Content-Type is REQUIRED — axum's Json extractor 415s a curl `-d`
            // POST (default form-urlencoded) without it, silently killing every
            // hook (the regression that left the turn state machine dead).
            assert!(
                cmd.contains("Content-Type: application/json"),
                "{event} must send Content-Type: application/json or the Json extractor 415s it"
            );
            assert!(cmd.contains(&format!("\\\"event\\\":\\\"{token}\\\"")), "{event} token");
            // Forward Claude's STDIN JSON as `payload`, size-capped,
            // defaulting to `{}` when empty so the body stays valid JSON.
            assert!(cmd.contains("head -c 16384"), "{event} must size-cap the payload");
            assert!(cmd.contains("D='{}'"), "{event} must default empty stdin to {{}}");
            assert!(cmd.contains("\\\"payload\\\":$D"), "{event} must splice the payload");
            assert_eq!(arr[0]["hooks"][0]["blocking"], json!(false));
        }
    }

    #[tokio::test]
    async fn installs_the_subagent_start_hook() {
        // Required so Claude fires a live "a Task subagent began" signal — without
        // it the outstanding-subagent count can only ever decrement. Feeds the
        // display-only parallelism count; never a turn-boundary signal.
        let dir = temp_dir();
        install_hooks_at(&dir).await.unwrap();
        let v = read_json(&dir.join("settings.json"));
        let arr = v["hooks"]["SubagentStart"]
            .as_array()
            .expect("SubagentStart hook installed");
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(
            cmd.contains("\\\"event\\\":\\\"subagent_start\\\""),
            "SubagentStart must POST the subagent_start token"
        );
    }

    #[tokio::test]
    async fn installs_the_post_tool_failure_hook() {
        // Claude Code DOES have a dedicated `PostToolUseFailure` event
        // (live-verified on 2.1.227 + 2.1.231): the payload adds `tool_use_id`,
        // `error`, `is_interrupt`, `duration_ms` to the usual tool fields. Without
        // this entry a failed tool is only visible via the `error`-carrying
        // `PostToolUse` heuristic.
        let dir = temp_dir();
        install_hooks_at(&dir).await.unwrap();
        let v = read_json(&dir.join("settings.json"));
        let arr = v["hooks"]["PostToolUseFailure"]
            .as_array()
            .expect("PostToolUseFailure hook installed");
        assert_eq!(arr.len(), 1);
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(
            cmd.contains("\\\"event\\\":\\\"post_tool_failure\\\""),
            "PostToolUseFailure must POST the post_tool_failure token"
        );
    }

    #[tokio::test]
    async fn installs_the_permission_request_hook() {
        // Fires when Claude DISPLAYS a permission dialog, before any decision —
        // the live "waiting on you, for this tool" signal (payload carries
        // `tool_name`, `tool_input`, `permission_mode`).
        let dir = temp_dir();
        install_hooks_at(&dir).await.unwrap();
        let v = read_json(&dir.join("settings.json"));
        let arr = v["hooks"]["PermissionRequest"]
            .as_array()
            .expect("PermissionRequest hook installed");
        assert_eq!(arr.len(), 1);
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(
            cmd.contains("\\\"event\\\":\\\"permission_request\\\""),
            "PermissionRequest must POST the permission_request token"
        );
    }

    /// SAFETY PIN for the trigger-only `PermissionRequest` entry: a
    /// `PermissionRequest` hook that writes to STDOUT can DECIDE the dialog
    /// (allow/deny) on the user's behalf. supermux's entry must be inert —
    /// observe only. This RUNS the real command in `sh` (pointed at a dead port
    /// so curl fails fast) and asserts it emits not one byte on stdout and
    /// still exits 0, which is exactly what Claude evaluates.
    #[tokio::test]
    async fn permission_request_command_is_inert_emits_no_stdout() {
        let cmd = hook_command("permission_request");
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            // 127.0.0.1:1 refuses instantly → curl errors, `|| true` swallows it.
            .env("SUPERMUX_URL", "http://127.0.0.1:1")
            .env("SUPERMUX_HOOK_TOKEN", "t")
            .env("SUPERMUX_SESSION", "s")
            .stdin(std::process::Stdio::null())
            .output()
            .expect("run the hook command");
        assert!(
            out.stdout.is_empty(),
            "a PermissionRequest hook that prints to stdout can auto-decide the \
             dialog; got {:?}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(out.status.success(), "the hook must always exit 0");
    }

    #[tokio::test]
    async fn upgrade_adds_a_newly_added_event_without_duplicating_or_clobbering() {
        // THE upgrade path: a user already running supermux has a settings.json
        // with the OLD hook set (no SubagentStart / PostToolUseFailure /
        // PermissionRequest). Upgrading the binary + starting any session re-runs
        // install_hooks, which must ADD each new event to the existing config —
        // without duplicating the events already there and without touching the
        // user's own foreign hooks/keys.
        const ADDED_LATER: [(&str, &str); 3] = [
            ("SubagentStart", "subagent_start"),
            ("PostToolUseFailure", "post_tool_failure"),
            ("PermissionRequest", "permission_request"),
        ];
        let dir = temp_dir();
        let path = dir.join("settings.json");

        // 1. Simulate a PRE-UPGRADE install: write the current set, then strip the
        //    later-added events so the file looks like an older supermux version.
        install_hooks_at(&dir).await.unwrap();
        let mut old = read_json(&path);
        for (event, _) in ADDED_LATER {
            old["hooks"].as_object_mut().unwrap().remove(event);
        }
        // 2. Add a foreign top-level key + a foreign Stop hook the user owns.
        old.as_object_mut().unwrap().insert("theirSetting".into(), json!("keep-me"));
        old["hooks"]["Stop"].as_array_mut().unwrap().push(json!({
            "matcher": "*",
            "hooks": [ { "type": "command", "command": "echo their-own-stop-hook" } ]
        }));
        std::fs::write(&path, serde_json::to_string_pretty(&old).unwrap()).unwrap();
        for (event, _) in ADDED_LATER {
            assert!(old["hooks"].get(event).is_none(), "precondition: no {event}");
        }

        // 3. The UPGRADE: a session start re-installs hooks.
        install_hooks_at(&dir).await.unwrap();
        let v = read_json(&path);

        // Each later-added event is now present, exactly once, with its token.
        for (event, token) in ADDED_LATER {
            let arr = v["hooks"][event]
                .as_array()
                .unwrap_or_else(|| panic!("{event} added on upgrade"));
            assert_eq!(arr.len(), 1, "exactly one {event} entry");
            assert!(arr[0]["hooks"][0]["command"].as_str().unwrap().contains(token));
        }

        // No supermux event got duplicated (each has exactly ONE marked entry).
        for (event, _) in EVENTS {
            let arr = v["hooks"][event].as_array().unwrap();
            let marked = arr.iter().filter(|e| is_supermux_entry(e)).count();
            assert_eq!(marked, 1, "{event}: exactly one supermux entry after upgrade");
        }

        // The user's foreign key + foreign Stop hook survived untouched.
        assert_eq!(v["theirSetting"], json!("keep-me"), "foreign top-level key preserved");
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert!(
            stop.iter().any(|e| e["hooks"][0]["command"] == json!("echo their-own-stop-hook")),
            "user's own Stop hook preserved alongside supermux's"
        );
    }

    #[tokio::test]
    async fn reinstall_is_idempotent() {
        let dir = temp_dir();
        install_hooks_at(&dir).await.unwrap();
        install_hooks_at(&dir).await.unwrap();
        install_hooks_at(&dir).await.unwrap();
        let v = read_json(&dir.join("settings.json"));
        for (event, _) in EVENTS {
            let arr = v["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{event}: re-install must not duplicate");
        }
    }

    #[tokio::test]
    async fn preserves_foreign_hooks_and_keys() {
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
        std::fs::write(
            dir.join("settings.json"),
            serde_json::to_string_pretty(&seed).unwrap(),
        )
        .unwrap();

        install_hooks_at(&dir).await.unwrap();
        let v = read_json(&dir.join("settings.json"));

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

    #[tokio::test]
    async fn teammate_mode_sets_top_level_key_and_preserves_hooks() {
        let dir = temp_dir();
        // Seed an existing settings file with hooks + a user key.
        install_hooks_at(&dir).await.unwrap();
        let before = read_json(&dir.join("settings.json"));
        let stop_len = before["hooks"]["Stop"].as_array().unwrap().len();

        let t = LocalFileTransport;
        set_top_level_string_at(&t, &dir.join("settings.json"), "teammateMode", "tmux")
            .await
            .unwrap();
        let v = read_json(&dir.join("settings.json"));
        assert_eq!(v["teammateMode"], json!("tmux"));
        // The hooks subtree is untouched.
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), stop_len);
    }

    #[tokio::test]
    async fn teammate_mode_is_idempotent() {
        let dir = temp_dir();
        let t = LocalFileTransport;
        set_top_level_string_at(&t, &dir.join("settings.json"), "teammateMode", "tmux")
            .await
            .unwrap();
        set_top_level_string_at(&t, &dir.join("settings.json"), "teammateMode", "tmux")
            .await
            .unwrap();
        let v = read_json(&dir.join("settings.json"));
        assert_eq!(v["teammateMode"], json!("tmux"));
    }

    #[tokio::test]
    async fn teammate_mode_refuses_unparseable_settings() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        std::fs::write(&path, "not { json").unwrap();
        let t = LocalFileTransport;
        assert!(set_top_level_string_at(&t, &path, "teammateMode", "tmux")
            .await
            .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not { json");
    }

    #[tokio::test]
    async fn refuses_to_clobber_unparseable_settings() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        std::fs::write(&path, "this is not { valid json").unwrap();
        let err = install_hooks_at(&dir).await;
        assert!(err.is_err(), "must refuse to overwrite an unparseable file");
        // The original bytes are untouched.
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "this is not { valid json"
        );
    }
}

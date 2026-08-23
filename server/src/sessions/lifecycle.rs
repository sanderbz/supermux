//! Session lifecycle: the tmux-backed half of the sessions API.
//!
//! Each mutating op acquires the per-session `tokio::sync::Mutex` from
//! [`AppState::lock_for`] so concurrent sends/starts/stops never race tmux
//! commands. Read-only ops (`peek`) skip the lock per the detector rule.
//!
//! **Hook-token rotation.** Every `start` mints a fresh `SUPERMUX_HOOK_TOKEN`
//! (32 bytes, OsRng) and injects it — with `SUPERMUX_SESSION`/`SUPERMUX_URL`/
//! `TMUX_SESSION_NAME` — into the tmux pane env. The dashboard bearer is NEVER
//! placed in the session environment.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::json;

use crate::db;
use crate::db::sessions::Session;
use crate::error::AppError;
use crate::files::transport::{FileTransport, LocalFileTransport, SshFileTransport};
use crate::state::{AppState, SseEvent};

use super::runtime::SessionRuntime;
use super::status::{self, Mode};
use super::tmux::Tmux;
use super::transport::HostId;

/// Outcome of a `start`/`restart` (returned to the client).
#[derive(Debug, Serialize)]
pub struct StartResult {
    pub name: String,
    /// The tmux session was (re)spawned or already alive.
    pub started: bool,
    /// The agent UI / shell prompt was observed within the wait-for-ready window.
    pub ready: bool,
    /// `supermux-<name>` — the tmux target.
    pub target: String,
}

/// Outcome of a `set_mode` (mode-shift). `mode` is the mode actually observed
/// AFTER the operation (the TRUE mode — the UI reflects truth, not the request):
/// for the cycle it is the re-read capture's parsed mode; for bypass it is what
/// the relaunch set. `converged` is false when the Shift+Tab cycle could not
/// reach the requested target within the retry cap (the UI then shows the real
/// mode and the user can try again).
#[derive(Debug, Serialize)]
pub struct SetModeResult {
    pub name: String,
    /// The mode actually in effect after the op (snake_case wire token).
    pub mode: String,
    /// True when the requested mode was reached; false if the cycle could not
    /// converge (UI reflects `mode`, the real state).
    pub converged: bool,
    /// True when bypass required a clean relaunch (so the UI can show the "session
    /// restarted" confirmation). Always false for the in-place Shift+Tab cycle.
    pub relaunched: bool,
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// The shell to spawn each tmux pane with. `$SHELL`, falling back to bash.
fn user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/bash".to_string())
}

/// Resolve the URL a REMOTE session's hook `curl` should dial back to.
/// Resolution order:
///
/// 1. `$SUPERMUX_REMOTE_URL` env override — handy for ad-hoc reverse tunnels
///    in shell smoke tests. Trimmed; empty is treated as unset.
/// 2. `config.remote_callback_url` from `config.toml`. The canonical
///    deploy-time setting (usually a Tailscale hostname like
///    `https://supermux-server.tailnet.ts.net:8823`).
/// 3. First non-loopback address in `config.extra_binds` — best-effort
///    discovery when the deployer hasn't configured a remote URL but HAS
///    listed a public/Tailscale bind. The scheme matches `scheme` (http or
///    https per TLS config) for consistency with the local callback URL.
/// 4. `config.bind` as the LAST resort. This will only work if the remote
///    can reach the orchestrator's loopback (typical for an SSH
///    reverse-tunnel: `ssh -R 8823:127.0.0.1:8823 host`). The remote will
///    dial its OWN loopback, which the reverse tunnel forwards back.
pub fn effective_remote_callback_url(config: &crate::config::Config, scheme: &str) -> String {
    if let Ok(env) = std::env::var("SUPERMUX_REMOTE_URL") {
        let env = env.trim();
        if !env.is_empty() {
            return env.to_string();
        }
    }
    if let Some(url) = config.remote_callback_url.as_deref() {
        let t = url.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    if let Some(addr) = config
        .extra_binds
        .iter()
        .find(|a| !a.ip().is_loopback())
    {
        return format!("{scheme}://{addr}");
    }
    format!("{scheme}://{}", config.bind)
}

/// Environment variables an agent CLI exports to mark its OWN child processes as
/// nested runs — poison for a supermux pane, and never legitimate in one.
///
/// **The failure this exists for.** Start supermux from inside a Claude Code
/// session (a routine thing for this user: an agent deploying or dogfooding the
/// server) and the daemon's environ carries `CLAUDE_CODE_CHILD_SESSION=1`,
/// `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID=…`. Every pane it spawns inherits
/// them — `Command::envs` ADDS to the parent environment, it does not replace
/// it — so every `claude` we launch believes it is a nested child of the agent
/// that happened to start the daemon. It prints "⚠ Transcript saving is off —
/// inherited CLAUDE_CODE_CHILD_SESSION marker", writes no `.jsonl`, and with no
/// transcript the ENTIRE chat plane (recall, the tailer, the chat renderer) has
/// nothing to read. A whole verification wave was invalidated by exactly this.
///
/// `CLAUDE_CODE_MESSAGING_TOKEN`/`_SOCKET` are on the list for a second reason:
/// they are a live credential + channel belonging to the parent agent, and
/// handing them to every pane we spawn hands every session a way to talk on it.
///
/// Production runs as a systemd daemon, so none of this is a shipping default —
/// but it is a real hazard whenever supermux is started by hand from an agent
/// pane, and the fix is one scrub at startup.
///
/// The list is deliberately CONSERVATIVE: only markers an agent exports about
/// ITSELF. supermux's own per-pane `CLAUDE_CODE_*` injections (see
/// [`build_env`]) are re-set for every pane and must not be listed here.
pub const AGENT_NESTING_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
];

/// Remove [`AGENT_NESTING_ENV`] from THIS process's environment, returning the
/// names that were actually present.
///
/// Called once at startup (`main`), before anything can spawn: scrubbing the
/// daemon's own environ is what makes every downstream spawn path clean at once
/// — the native holder, the tmux server, hook curls, the `$EDITOR` bridge — with
/// no per-path list to keep in sync. The native spawn ALSO drops them from the
/// child (`native::runtime::spawn`), so a var set after boot cannot reach a pane
/// either.
///
/// Safe here: `main` is single-threaded at this point, the same place that
/// already sets `TMUX_TMPDIR`.
pub fn scrub_inherited_agent_env() -> Vec<&'static str> {
    let mut removed = Vec::new();
    for key in AGENT_NESTING_ENV {
        if std::env::var_os(key).is_some() {
            std::env::remove_var(key);
            removed.push(*key);
        }
    }
    removed
}

/// Does a session with this `provider` launch the `claude` binary?
///
/// Mirrors the `_ =>` fallback arm of [`build_launch_command`], which is what
/// makes this an INVERSE list rather than `provider == "claude"`: a legacy or
/// unknown non-shell row falls through to Claude there, so the Claude-only env
/// (transcript persistence) must reach it too or such a row would launch the
/// agent with half its environment. `shell` never reaches the launch builder at
/// all, `codex` launches its own binary and ignores `CLAUDE_CODE_*`, and the
/// RETIRED `kimi` (see [`crate::sessions::RETIRED_PROVIDERS`]) can never be
/// launched again — none of the three is a Claude pane.
fn launches_claude(provider: &str) -> bool {
    !matches!(provider, "codex" | "kimi" | "shell")
}

/// Split a stored `flags` string into words and shell-quote each one for the
/// launch line (SEC-01).
///
/// `flags` is caller-supplied through `POST /api/sessions` and lands in a string
/// that is TYPED INTO A SHELL, so an unquoted `; touch /tmp/pwned` used to run as
/// the service user in the pane. The HTTP boundary now rejects shell
/// metacharacters up front (`sessions::validate_flags`); this is the second,
/// unconditional layer — it covers rows written BEFORE that check existed and the
/// non-HTTP writers (`relaunch_for_bypass`, clone), and it is the layer an
/// auditor can verify without reasoning about every write path.
///
/// Word-splitting is by whitespace, which is exactly how the shell used to split
/// the interpolated string, and the escaper (the same
/// `shell_escape::unix::escape` the SSH transport quotes remote argv with)
/// leaves an ordinary flag word untouched — so every real flags value
/// (`--yolo`, `--ask-for-approval never`, `--permission-mode bypassPermissions`,
/// `--model opus`) renders BYTE-IDENTICALLY to what it rendered before. What
/// changes is only the outcome for a poisoned value: the words arrive as
/// arguments to the agent instead of as commands to the shell.
///
/// Operator config (`provider_defaults.*_flags`) is deliberately NOT run through
/// this: it comes from the server's own config file, it is trusted the way the
/// rest of that file is, and an operator may legitimately have written their own
/// quoting there.
fn quoted_flag_words(flags: &str) -> Vec<String> {
    flags
        .split_whitespace()
        .map(|w| shell_escape::unix::escape(std::borrow::Cow::Borrowed(w)).into_owned())
        .collect()
}

/// Resolve a per-bot MODEL selection to the real `--model` id the provider's CLI
/// accepts, or reject it (migration 0030 / bot identity).
///
/// The model NEVER arrives as free text on the launch line: it is validated
/// against a hardcoded per-provider ALLOWLIST here (SEC-01 — the resolved value
/// is spliced into a shell command line), and only a mapped, known-safe literal
/// is ever emitted. This is the single source of truth shared by the create /
/// config write path (`sessions::mod`, which stores the mapped id) and the launch
/// path ([`build_launch_command`], which trusts a stored id but re-resolves it so
/// a legacy / hand-edited value is dropped rather than shell-injected).
///
/// Contract:
///   * `Ok(None)`      — `model` is empty ⇒ use the provider default (unchanged
///                        behaviour for the whole pre-0030 fleet).
///   * `Ok(Some(id))`  — a validated, allowlisted real model id.
///   * `Err(msg)`      — an unknown selection; the caller maps it to a 400.
///
/// The map is deliberately small and extend-later; the KEY is the user-facing
/// selection and the VALUE is the id the CLI is invoked with. Keeping them
/// separate lets a friendly label diverge from a versioned id without touching
/// callers.
pub(crate) fn resolve_model_flag(provider: &str, model: &str) -> Result<Option<&'static str>, String> {
    let model = model.trim();
    if model.is_empty() {
        return Ok(None);
    }
    // (selection, real --model id). claude aliases already ARE the ids the CLI
    // accepts; codex ids are its accepted model slugs.
    let allow: &[(&str, &str)] = match provider {
        p if launches_claude(p) => &[("opus", "opus"), ("sonnet", "sonnet"), ("haiku", "haiku")],
        "codex" => &[
            ("gpt-5-codex", "gpt-5-codex"),
            ("gpt-5", "gpt-5"),
            ("o3", "o3"),
            ("o4-mini", "o4-mini"),
        ],
        _ => &[],
    };
    match allow.iter().find(|(sel, _)| *sel == model) {
        Some((_, id)) => Ok(Some(id)),
        None => {
            let allowed = allow.iter().map(|(sel, _)| *sel).collect::<Vec<_>>().join(", ");
            if allowed.is_empty() {
                Err(format!("provider '{provider}' does not support a model selection"))
            } else {
                Err(format!(
                    "unknown model '{model}' for provider '{provider}' (allowed: {allowed})"
                ))
            }
        }
    }
}

/// Compose the READ-ONLY role/notes system-prompt block injected at launch
/// (migration 0030 / bot identity), or `None` when this session has neither a
/// role (`desc`) nor notes (`memory`).
///
/// The owner's ask — "sluit rol nu echt aan": until now `desc` ("Standing
/// instructions") was displayed but injected NOWHERE, so the role steered nothing.
/// This turns it into the agent's system prompt at launch. `memory` (the bot's
/// "Notes it keeps") is appended after the role under a clear delimiter. v1 is
/// READ-ONLY — the agent can SEE its role + notes; a write-back path is a later
/// phase and is deliberately not built here.
fn role_system_prompt(s: &Session) -> Option<String> {
    let role = s.desc.trim();
    let notes = s.memory.trim();
    if role.is_empty() && notes.is_empty() {
        return None;
    }
    let mut out = String::new();
    if !role.is_empty() {
        out.push_str(role);
    }
    if !notes.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        // A clearly delimited section so the agent can tell its standing role
        // from the mutable notes it keeps.
        out.push_str("Notes you keep:\n");
        out.push_str(&cap_core_notes(notes));
    }
    Some(out)
}

/// Hard cap on the always-loaded CORE (the bot's `memory` index). Line and char
/// budgets sized to the design's ~1500-token / ~40-line target (~4 chars/token).
const CORE_MAX_LINES: usize = 40;
const CORE_MAX_CHARS: usize = 6_000;

/// Cap the CORE notes to the bounded index the design mandates. The CORE is the
/// token tax paid on EVERY turn, so it must never grow unbounded (audit gap 4):
/// the archival tier — recalled on demand by the bot-memory hook — is where the
/// long tail lives. Truncates on whichever budget bites first (lines or chars)
/// and appends a one-line pointer telling the agent the rest is recallable, so a
/// clipped index reads as deliberate, not broken.
///
/// This is the SERVER-SIDE half of the cap; the bot-panel editor mirrors it so a
/// human sees the same limit while editing (noted for the UI phase — the editor
/// cap is additive and does not exist yet).
fn cap_core_notes(notes: &str) -> String {
    let notes = notes.trim_end();
    let total_lines = notes.lines().count();
    let within_lines = total_lines <= CORE_MAX_LINES;
    let within_chars = notes.chars().count() <= CORE_MAX_CHARS;
    if within_lines && within_chars {
        return notes.to_string();
    }

    // Keep whole lines up to BOTH budgets. The char budget binds the FIRST kept
    // line too: a single wall-of-text line with no newlines (sessions.memory is
    // free text a human/bot edits) must not slip past the cap in full — it is
    // char-truncated to the remaining budget so the always-loaded token tax is
    // genuinely bounded, not just bounded when there happen to be many newlines.
    let mut kept = String::new();
    let mut kept_lines = 0usize;
    let mut clipped = false;
    for line in notes.lines() {
        if kept_lines >= CORE_MAX_LINES {
            break;
        }
        // Chars already spent, plus the newline this line needs (none for the
        // first). Stop if there is no room left for even a separator.
        let used = kept.chars().count();
        let sep = usize::from(kept_lines > 0);
        if used + sep >= CORE_MAX_CHARS {
            break;
        }
        let budget = CORE_MAX_CHARS - used - sep;
        if kept_lines > 0 {
            kept.push('\n');
        }
        if line.chars().count() > budget {
            // Truncate this line (the first line included) to the remaining char
            // budget; the rest is recalled on demand, never front-loaded.
            kept.extend(line.chars().take(budget));
            kept_lines += 1;
            clipped = true;
            break;
        }
        kept.push_str(line);
        kept_lines += 1;
    }
    let dropped = total_lines.saturating_sub(kept_lines);
    if dropped > 0 {
        kept.push_str(&format!("\n…({dropped} more in archival)"));
    } else if clipped {
        kept.push_str("\n…(truncated; more in archival)");
    }
    kept
}

/// Write the composed role/notes block to a per-session instructions file the
/// codex arm points at, returning its path — or `None` when this session has no
/// role/notes (then any stale file from a previous launch is removed, so a
/// cleared role does not keep steering codex). Best-effort: any fs error yields
/// `None` and the launch simply proceeds without role injection.
fn write_codex_role_file(config: &crate::config::Config, s: &Session) -> Option<std::path::PathBuf> {
    let dir = config.data_dir.join("bot-role");
    let path = dir.join(format!("{}.md", s.name));
    match role_system_prompt(s) {
        Some(body) => {
            if std::fs::create_dir_all(&dir).is_err() {
                return None;
            }
            std::fs::write(&path, body).ok().map(|_| path)
        }
        None => {
            let _ = std::fs::remove_file(&path);
            None
        }
    }
}

/// Per-session tmux env. Excludes the dashboard bearer by construction.
///
/// `agent_teams` gates the experimental Claude Code Agent Teams feature:
/// when ON **and** the provider is `claude`, inject
/// `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` so a lead session can spawn teammate
/// panes. Default OFF — it carries the ~7× token cost of N real Claude
/// processes, so it is only injected when the global `experimental.agent_teams`
/// setting is on (read in [`start`] before this is called). NEVER injected for
/// codex/shell sessions (they don't read it, and teams is Claude-only).
fn build_env(
    config: &crate::config::Config,
    name: &str,
    hook_token: &str,
    provider: &str,
    agent_teams: bool,
    host_id: Option<i64>,
) -> HashMap<String, String> {
    let scheme = if config.tls.cert_path.is_some() || config.tls.self_signed {
        "https"
    } else {
        "http"
    };
    let mut env = HashMap::new();
    env.insert("SUPERMUX_SESSION".to_string(), name.to_string());
    env.insert("TMUX_SESSION_NAME".to_string(), name.to_string());
    // A session running on a different machine cannot reach
    // the orchestrator at `127.0.0.1:8823` — its hook curl would just hit its
    // OWN loopback. For remote sessions, route `SUPERMUX_URL` through the
    // configured `remote_callback_url` (Tailscale hostname, reverse-tunnel,
    // or first non-loopback bind) instead. Local sessions keep the original
    // loopback path — by far the common case.
    let callback_url = if host_id.is_some() {
        effective_remote_callback_url(config, scheme)
    } else {
        format!("{scheme}://{}", config.bind)
    };
    env.insert("SUPERMUX_URL".to_string(), callback_url);
    env.insert("SUPERMUX_HOOK_TOKEN".to_string(), hook_token.to_string());
    // Gated, Claude-only opt-in for Agent Teams.
    if agent_teams && provider == "claude" {
        env.insert(
            "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS".to_string(),
            "1".to_string(),
        );
    }
    // THE SECOND HALF OF THE TRANSCRIPT GUARANTEE (the first is
    // [`AGENT_NESTING_ENV`] / [`scrub_inherited_agent_env`]).
    //
    // Without a `.jsonl` transcript the ENTIRE chat plane is blind: the tailer
    // has no file to watch, recall has nothing to read, and the chat renderer
    // shows an empty conversation for a session that is visibly working. Claude
    // prints exactly one line about it — "⚠ Transcript saving is off … restart
    // with CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1" — and then says nothing more.
    //
    // The scrub covers the INHERITANCE path (a supermux started by hand from
    // inside a Claude pane hands every child a `CLAUDE_CODE_CHILD_SESSION`
    // marker). It cannot cover the OTHER two ways persistence ends up off:
    //   • the user turned it off themselves (settings / their own exported env
    //     in `~/.zprofile`, which the launch line sources), and
    //   • a marker that appears in the daemon's environ AFTER the one-shot
    //     startup scrub.
    // Exporting the positive flag per pane closes both: it is read at Claude
    // STARTUP and wins over an inherited marker, so a supermux-spawned session
    // ALWAYS writes a transcript.
    //
    // Same blast radius as the FORCE_SYNC / DISABLE_ALTERNATE_SCREEN siblings
    // below: per-pane, purely additive, and never in [`AGENT_NESTING_ENV`] (the
    // scrub list is markers an agent exports about ITSELF — pinned disjoint by
    // `the_scrub_list_and_the_injected_env_are_disjoint`).
    if launches_claude(provider) {
        env.insert(
            "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE".to_string(),
            "1".to_string(),
        );
    }
    // Tell the shell it's running in a 256-colour xterm-compatible terminal.
    // Without TERM the spawned pane inherits whatever (or nothing) the supermux
    // server saw — often missing or "dumb" — and zsh prompts, `ls --color`,
    // `git status`, etc. silently drop colour. `xterm-256color` is the broadest
    // safe baseline (always present in ncurses); `COLORTERM=truecolor` opts in
    // tools that gate on it (bat, delta, modern prompts) to 24-bit colour.
    // xterm.js parses the resulting SGR sequences and renders them via the
    // 16-colour palette set in the web-side `theme`.
    env.insert("TERM".to_string(), "xterm-256color".to_string());
    env.insert("COLORTERM".to_string(), "truecolor".to_string());
    // Force Claude Code to emit synchronized-output (DECSET 2026) frames.
    //
    // BACKGROUND. Claude Code's Ink renderer batches a full-frame redraw
    // between `\x1b[?2026h` ... `\x1b[?2026l`, so the OUTER terminal can paint
    // one coherent frame instead of seeing every intermediate cursor-move /
    // line-erase mid-redraw. Without sync, those intermediate flushes land in
    // the pipe-pane → broadcast stream and xterm.js paints frame N's bottom
    // row(s) before frame N+1's top arrives — the user sees lines like
    // "Determining…" and "Did 1 search in 7s" / "Allowed by auto mode
    // classifier" stack in TWO positions (the leftover partial plus the next
    // frame's repaint). The exact failure mode is tracked upstream as
    // claude-code#37283, #49086, #51828, #40555, #57145, #55613, #49584.
    //
    // BUT Claude only emits the DEC 2026 sequences when it BELIEVES the outer
    // terminal supports them — and it auto-detects via a HARDCODED TERM list
    // (xterm-ghostty, xterm-kitty, …). `xterm-256color` is NOT on that list,
    // so without this env Claude stays silent on sync — and the duplicate-line
    // bug persists no matter what tmux is configured to do.
    //
    // `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` (Anthropic's documented escape hatch
    // for exactly this case — see #55613, #49584) tells Claude to emit the
    // sequences unconditionally. Paired with the tmux `xterm*:sync` feature
    // (sessions/tmux.rs) those bytes are PASSED THROUGH the pipe-pane instead
    // of being silently dropped, so the broadcast stream carries whole-frame
    // redraws and xterm.js paints coherent frames — no torn lines, no
    // duplicate-looking ghosts.
    //
    // SAFETY of the change:
    //   • Pure additive: an env var the agent OPTIONALLY reads. Sessions
    //     where the agent doesn't recognize it (older Claude, Codex, shell)
    //     just ignore it — no behaviour change.
    //   • Bounded blast radius: scoped to this session's tmux pane via
    //     `tmux new-session -e KEY=VAL` (the per-pane env path); does NOT
    //     pollute the server-wide environment or any other session.
    //   • Symmetric on FAIL: if Claude can't construct the sync sequences for
    //     any reason, it falls back to NOT emitting them — same as today.
    //     There is no "broken sync" failure mode that's worse than today's
    //     no-sync state.
    //   • Cooperates with the tmux feature flag: without `xterm*:sync`
    //     enabled in tmux (sessions/tmux.rs), tmux would drop the sequences
    //     anyway and the env would be a no-op. With BOTH set, the chain
    //     completes: Claude emits → tmux batches → broadcast → xterm.js
    //     paints atomically. Setting only ONE side is harmless.
    env.insert(
        "CLAUDE_CODE_FORCE_SYNC_OUTPUT".to_string(),
        "1".to_string(),
    );
    // Make Claude Code render INLINE (normal screen buffer) instead of taking over
    // the terminal's ALTERNATE screen. THE root fix for the browser-terminal scroll
    // saga.
    //
    // ROOT CAUSE (proven by raw-pty capture on a real 2.1.156): Claude emits
    // `ESC[?1049h` at startup and draws its whole TUI in the alternate-screen buffer,
    // exactly like vim/htop. The alt screen has NO scrollback — so there is simply
    // nothing for a mobile one-finger drag or a desktop wheel to pan. Worse, xterm
    // translates an alt-buffer wheel event into cursor Up/Down keys (its "alternate
    // scroll mode"), which Claude reads as INPUT-HISTORY navigation — so desktop
    // "scroll" cycled prompts instead of moving the viewport. This is why every
    // earlier fix (touch shims, mouse on/off) failed: they patched symptoms of a
    // buffer that has no history. Older Claude rendered inline (normal buffer, with
    // scrollback), which is why scrolling "worked two days ago".
    //
    // CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 makes Claude render inline again.
    // Verified on the box: with it set, no `?1049h` is emitted, the pane reports
    // `alternate_on=0`, and a 60-line print accumulated 63 lines of real, scrollable
    // tmux history (vs 0 on the alt-screen baseline). Native wheel scroll, one-finger
    // touch-pan, and drag-to-select then all operate on the genuine scrollback — no
    // per-interaction hacks. The WS seed is already alt-screen-aware (the tmux capture
    // branches on `alternate_on`): a normal-buffer pane is seeded with a plain capture
    // and NO `?1049h` injection, so the browser xterm stays in the normal buffer with
    // its own working scrollback — no companion change needed.
    //
    // Mouse REPORTING is a separate, client-side concern: Claude still emits DECSET
    // ?1000/?1002/?1006 regardless of buffer, and 2.1.156 IGNORES the documented
    // CLAUDE_CODE_DISABLE_MOUSE env (we used to set it here — a verified no-op, now
    // removed). Mouse tracking is neutralized in web/src/lib/disable-xterm-mouse.ts,
    // the authoritative version-proof fix that keeps touch-scroll + drag-select alive
    // no matter what the agent emits; both buffers need it (mouse mode gates touch and
    // hijacks drag regardless of which buffer is active).
    //
    // Same blast-radius/safety as FORCE_SYNC above: per-pane `-e KEY=VAL`, purely
    // additive, ignored by agents that don't read it (codex/shell). Read at Claude
    // STARTUP — an already-running session must be restarted (the in-UI Restart
    // button) to pick it up.
    env.insert(
        "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN".to_string(),
        "1".to_string(),
    );
    env
}

/// Build the agent launch command sent into the freshly-spawned shell. Profiles
/// are sourced first so `claude`/`codex` are on PATH in a non-login pane.
/// Claude resumes via `cc_session_name` → `cc_conversation_id` → fresh `--name`.
/// Codex starts a fresh interactive session: supermux does not yet persist the
/// session id Codex assigns after startup, so passing a resume argument would be
/// misleading. Its native `codex resume` picker remains available in the pane.
///
/// Returns `(command, resume_intended)`. `resume_intended` is TRUE iff the launch
/// actually carries a `--resume <id|name>` — i.e. the user (via the Resume picker)
/// or a prior run's persisted cc link asked to continue a specific conversation.
/// It is the single source of truth `wait_for_agent_ready` reads to decide whether
/// a resume-picker escape (+ destructive `clear_cc`) is safe: it NEVER is on an
/// intended resume (escaping abandons the exact conversation asked for and wiping
/// the cc link breaks every later Start/Resume too). Always false for codex/shell.
/// `mcp_flags` are the per-session connector flag WORDS computed by the shared
/// seam ([`crate::sessions::connector_config`]) — an empty slice for the whole
/// pre-connector fleet, which yields a BYTE-IDENTICAL launch line. When present
/// they are the `--mcp-config <inline json> --strict-mcp-config` pair; each word
/// is shell-escaped here, and they sit BESIDE the role/notes
/// `--append-system-prompt` pair (neither clobbers the other).
fn build_launch_command(
    config: &crate::config::Config,
    s: &Session,
    mcp_flags: &[String],
) -> (String, bool) {
    let (agent, resume_intended) = match s.provider.as_str() {
        "codex" => {
            // Keep Codex in the normal terminal buffer so the browser terminal
            // retains scrollback. This is Codex CLI's documented TUI flag.
            let mut parts = vec!["codex".to_string(), "--no-alt-screen".to_string()];
            let defaults = config.provider_defaults.codex_flags.trim();
            if !defaults.is_empty() {
                parts.push(defaults.to_string());
            }
            // Per-session flags are caller-supplied → quoted word by word.
            parts.extend(quoted_flag_words(&s.flags));
            // ── bot identity (migration 0030), codex arm ───────────────────
            // Per-bot MODEL via codex's own `--model <id>` flag, allowlist-
            // resolved exactly like the claude arm (never free text).
            if let Ok(Some(id)) = resolve_model_flag(&s.provider, &s.model) {
                parts.push("--model".to_string());
                parts.push(shell_escape::unix::escape(std::borrow::Cow::Borrowed(id)).into_owned());
            }
            // ROLE + NOTES for codex. Codex has no per-launch `--append-system-
            // prompt`, so v1 writes the composed role/notes to a per-session
            // instructions FILE and points codex at it via its config override
            // (`-c experimental_instructions_file="<path>"`). READ-ONLY, same as
            // the claude arm. Best-effort: a write failure just skips injection
            // (the session still launches). CONNECTOR-STORE seam applies here too
            // (see the claude arm's note) — this consumes only its own `-c` pair.
            if let Some(path) = write_codex_role_file(config, s) {
                parts.push("-c".to_string());
                let kv = format!("experimental_instructions_file={:?}", path.display().to_string());
                parts.push(shell_escape::unix::escape(std::borrow::Cow::Owned(kv)).into_owned());
            }
            let codex = parts.join(" ");

            // Codex is an optional provider, so make its first launch
            // self-contained for the service user (and for remote hosts). The
            // official standalone installer is user-scoped and needs no Node
            // runtime. Download it to a file rather than piping into `sh`: a
            // failed curl must never look like a successful empty install.
            // `CODEX_NON_INTERACTIVE=1` suppresses the installer's optional
            // "start now" prompt because supermux owns the subsequent launch.
            //
            // Authentication deliberately happens in the tmux pane. Device
            // auth is suitable for a headless host and leaves the browser
            // terminal showing the URL/code. Once authenticated, subsequent
            // starts skip it through `codex login status`.
            let agent = format!(
                "if ! command -v codex >/dev/null 2>&1; then \
                   printf '\\nCodex CLI is not installed; installing it for this user…\\n'; \
                   _supermux_codex_installer=$(mktemp) && \
                   curl -fsSL https://chatgpt.com/codex/install.sh \
                     -o \"$_supermux_codex_installer\" && \
                   CODEX_NON_INTERACTIVE=1 sh \"$_supermux_codex_installer\"; \
                   _supermux_codex_install_status=$?; \
                   if [ -n \"${{_supermux_codex_installer:-}}\" ]; then \
                     rm -f \"$_supermux_codex_installer\"; \
                   fi; \
                   export PATH=\"$HOME/.local/bin:$PATH\"; hash -r 2>/dev/null || true; \
                   if [ \"$_supermux_codex_install_status\" -ne 0 ]; then \
                     printf '\\nCodex CLI installation failed. Check the output above, then retry this session.\\n'; \
                   fi; \
                 fi; \
                 if command -v codex >/dev/null 2>&1; then \
                   if codex login status >/dev/null 2>&1; then \
                     {codex}; \
                   else \
                     printf '\\nCodex needs a one-time login for this user.\\n'; \
                     codex login --device-auth && {codex}; \
                   fi; \
                 else \
                   printf '\\nCodex CLI is unavailable. Install it and retry this session.\\n'; \
                 fi"
            );
            // Codex has no supermux-driven resume: the command never carries
            // `--resume`, so `wait_for_agent_ready` treats it as a fresh start.
            (agent, false)
        }
        // `shell` never reaches this builder, and a RETIRED provider is refused
        // in `start` long before it gets here (see `is_retired_provider`), so
        // this fallback only ever serves Claude rows.
        _ => {
            let mut parts = vec!["claude".to_string()];
            let defaults = config.provider_defaults.claude_flags.trim();
            if !defaults.is_empty() {
                parts.push(defaults.to_string());
            }
            // Per-session flags are caller-supplied → quoted word by word
            // (SEC-01). Same argv as before for every real flags value; a
            // poisoned one now reaches `claude` as arguments instead of the
            // shell as commands.
            parts.extend(quoted_flag_words(&s.flags));
            // `cc_session_name` / `cc_conversation_id` are charset-validated
            // at the HTTP boundary (see `sessions::valid_cc_id`), so the rule
            // `[A-Za-z0-9._-]{1,128}` holds here. We single-quote the value
            // anyway: the wrap is audit-obvious shell-injection-safe (the
            // validated charset has no single quote), and it survives any
            // stray legacy row from before the boundary check existed.
            let resume_intended = if !s.cc_session_name.is_empty() {
                parts.push("--resume".to_string());
                parts.push(format!("'{}'", s.cc_session_name));
                true
            } else if !s.cc_conversation_id.is_empty() {
                parts.push("--resume".to_string());
                parts.push(format!("'{}'", s.cc_conversation_id));
                true
            } else {
                parts.push("--name".to_string());
                parts.push(s.name.clone());
                false
            };
            // ── bot identity (migration 0030) ──────────────────────────────
            // Per-bot MODEL: fold the stored selection into the launch line as
            // `--model <id>`. Re-resolved through the allowlist (never trusted as
            // free text) so a legacy / hand-edited column value is dropped rather
            // than shell-injected; the id it yields is a known-safe literal, and
            // we single-quote it anyway to keep the argv shape audit-obvious.
            if let Ok(Some(id)) = resolve_model_flag(&s.provider, &s.model) {
                parts.push("--model".to_string());
                parts.push(shell_escape::unix::escape(std::borrow::Cow::Borrowed(id)).into_owned());
            }
            // ROLE + NOTES: inject the session's role (`desc`) and the bot's notes
            // (`memory`) into Claude's SYSTEM PROMPT via `--append-system-prompt`
            // (per-launch, clean, no file to clean up). READ-ONLY in v1. The value
            // is shell-escaped as one word by the same quoting the flags path uses.
            //
            // CONNECTOR-STORE COEXISTENCE SEAM — see
            // docs/superpowers/specs/2026-08-18-connector-store-design.md
            // (branch feat/connector-store). That work injects at THIS SAME point
            // via `--mcp-config <path>` and a `--settings <overlay>` file (with the
            // secret `${VAR}` env in `build_env`; it does NOT repoint
            // `CLAUDE_CONFIG_DIR`). This role/notes injection is designed to COMPOSE with
            // it: it appends its OWN `--append-system-prompt` flag pair and does
            // NOT consume the `--mcp-config` slot or any env slot the connector
            // work needs — a later MCP-config flag simply sits beside this one in
            // `parts`. Keep them as independent flag pairs; do not merge.
            if let Some(sys) = role_system_prompt(s) {
                parts.push("--append-system-prompt".to_string());
                parts.push(shell_escape::unix::escape(std::borrow::Cow::Owned(sys)).into_owned());
            }
            // ── connector store (migration 0031) ───────────────────────────
            // The per-session launch flags — the connector pair (`--mcp-config
            // <inline json> --strict-mcp-config`) and the `--settings <overlay>`
            // flag for the hooks/permissions/kill-switch overlay — computed by the
            // shared seam `connector_config::assemble` from this session's enabled
            // grants (its own + all-agents) and its bot memory. COMPOSES with the
            // role/notes block above: separate, independent flag words appended
            // after it, escaped word by word. Empty for a plain session (no grants,
            // no memory) ⇒ the launch line is byte-identical to the pre-connector
            // fleet. The matching `${VAR}` secret env is injected via `build_env`'s
            // merge in `start_locked` — not here. Note: the overlay is layered via
            // `--settings`, NOT by repointing `CLAUDE_CONFIG_DIR`.
            for word in mcp_flags {
                parts.push(shell_escape::unix::escape(std::borrow::Cow::Borrowed(word)).into_owned());
            }
            (parts.join(" "), resume_intended)
        }
    };
    // "Edit in native editor": point `$EDITOR`/
    // `$VISUAL` at the supermux bridge wrapper so Claude's built-in Ctrl+G
    // (`chat:externalEditor`) opens the browser editor sheet instead of a
    // terminal editor. Exported AFTER the profile sources (a user `~/.zprofile`
    // could set its own EDITOR, which would otherwise win) and BEFORE `{agent}`
    // so the launched provider inherits it. Set once OUTSIDE the provider match —
    // only Claude reads it, but exporting it for codex/shell is harmless (they
    // ignore it). Single-quoted so a data-dir path with spaces never word-splits.
    let bridge = config.data_dir.join("bin/supermux-edit");
    let bridge = bridge.display();
    // Put `<data_dir>/bin` on PATH (AFTER the profile sources so it wins) so the
    // bot-memory write CLI resolves as a bare `supermux-memory` — the name the
    // per-session `allowedTools` grant (`Bash(supermux-memory *)`) auto-approves.
    // Harmless for non-bot panes (an extra dir on PATH); the CLI errors cleanly if
    // BOT_MEMORY_* is unset.
    let bin_dir = config.data_dir.join("bin");
    let bin_dir = bin_dir.display();
    let command = format!(
        "source ~/.zprofile 2>/dev/null; source ~/.bash_profile 2>/dev/null; \
         source ~/.profile 2>/dev/null; export EDITOR='{bridge}' VISUAL='{bridge}'; \
         export PATH='{bin_dir}':\"$PATH\"; {agent}"
    );
    (command, resume_intended)
}

/// True once the Claude/Codex TUI prompt is visible.
fn agent_ui_visible(capture: &str) -> bool {
    capture.contains('❯') || capture.contains('❱') || capture.contains("? for shortcuts")
}

/// AGENT-LEVEL evidence that a provider is actually at the wheel on this pty —
/// the same proof `start`'s readiness poll accepts, minus the two screens that
/// draw `agent_ui_visible`'s `❯` glyph without an agent being ready behind it.
///
/// This exists for the failed-heal latch (`auto_actions`): after
/// `claude --resume <stale>` the pty is NOT a bare shell — claude sits in its
/// interactive Resume picker, which is a live program. "A program owns the pty"
/// therefore proves nothing there, and using it as the release condition is what
/// wiped the honest `resume failed: …` badge one ~2s tick after the heal
/// admitted failure. The picker and the trust dialog are exactly the two
/// captures that must NOT count.
pub(super) fn agent_at_the_wheel(capture: &str) -> bool {
    agent_ui_visible(capture) && !at_resume_picker(capture) && !at_trust_dialog(capture)
}

/// AGENT-LEVEL evidence that the pty is BUSY — the agent has the turn and is
/// mid-work. Claude pins `esc to interrupt` the whole time a turn runs (the
/// modern line is `✻ Thinking… (esc to interrupt · 12s · ↑ 2.1k tokens)`), and
/// Codex's working footer (`◦ Working (Ns • esc to interrupt)`) does too — see
/// `status::CLAUDE_ACTIVE` / `CODEX_ACTIVE`. A send while busy is a legitimate
/// QUEUE, so the send guard must treat this as typeable even when the composer
/// glyph has scrolled out of a short capture.
fn agent_busy(capture: &str) -> bool {
    capture.to_lowercase().contains("esc to interrupt")
}

/// May [`send_harness_text`] type `text`+Enter into the pty showing this CURRENT
/// capture? The SEND-path twin of [`classify_ready_tick`]'s ready arm.
///
/// [`wake_for_send`] already refuses a FIRST send whose wake lands on a boot
/// modal (`start().ready == false`), but an ALREADY-AWAKE retry (`woke == false`)
/// skips the wake entirely — so without this a retry types straight into a
/// resume picker / trust dialog left open on the pty, records `last_send`, and
/// reports a message the modal swallowed as delivered (codex #1, wave-7). The
/// gate is on the CURRENT screen, not on whether we just woke.
///
/// Two screens legitimately receive a send:
///   * the agent is at the wheel — its own prompt with no boot modal over it
///     ([`agent_at_the_wheel`], which itself excludes the picker + trust dialog,
///     and still ADMITS a permission menu so answering one is unchanged); or
///   * the agent is mid-turn/busy ([`agent_busy`]), where a send is a queue.
/// Everything else — the resume picker, the trust dialog, a bare shell the agent
/// exited to — must NOT be typed into.
///
/// CURRENT-SCREEN scoping (wave-8, codex pass 3). The readiness/busy glyphs
/// (`❯`, `esc to interrupt`) must be read off the CURRENT screen, NOT the whole
/// `capture_plain(30)` blob — that blob is scrollback + viewport, so a screen
/// that ENDS at a bare shell but still has an OLDER `❯` / `esc to interrupt`
/// line scrolled up in it would otherwise satisfy the guard and the retry would
/// be typed into the bare shell. So:
///   * the two full-screen BOOT MODALS are rejected over the whole capture —
///     their `❯` is a selection cursor and their identifying TITLE sits at the
///     TOP of the screen, so a bottom-only look would miss the title and wrongly
///     admit the cursor; while
///   * the live-composer / busy-footer glyphs are searched ONLY in the
///     bottom-anchored [`current_screen_tail`] — an agent glyph higher than that
///     is stale scrollback, not the screen we are about to type into.
fn pty_ready_for_send(capture: &str) -> bool {
    if at_resume_picker(capture) || at_trust_dialog(capture) {
        return false;
    }
    let screen = current_screen_tail(capture);
    agent_ui_visible(&screen) || agent_busy(&screen) || codex_ready(&screen)
}

/// True once a READY, EMPTY Codex composer is visible. Codex draws `›` (U+203A),
/// not Claude's `❯`, so [`agent_ui_visible`] is blind to it and the send guard
/// wrongly 409'd every send/delegate to an awake, idle Codex (FIX 2). ORed into
/// [`pty_ready_for_send`] AFTER the picker/trust rejections, so a real Codex
/// resume-picker or folder-trust dialog is still refused first. Keyed (via
/// `status`) on the "Ask Codex to do anything" placeholder and/or the composer
/// model footer — signals a picker/trust dialog never shows — and NEVER on a
/// bare `›` (a `› N.` numbered selector stays non-ready). See
/// [`status::is_codex_ready_composer`].
fn codex_ready(screen: &str) -> bool {
    status::is_codex_ready_composer(screen)
}

/// How many bottom rows of a capture count as the CURRENT interactive screen for
/// the send guard. The composer box, a permission menu, and the busy footer all
/// live in the last handful of rows of a live agent screen; a genuine agent
/// glyph never sits higher than this above the bottom of the current screen. Set
/// well below `status::CAPTURE_LINES` (30) so an old prompt that has scrolled up
/// into the capture can no longer satisfy the guard, yet high enough to clear a
/// permission menu's option list plus its footer.
const SEND_SCREEN_TAIL_LINES: usize = 10;

/// The bottom-anchored slice of `capture` that is the CURRENT interactive region
/// — trailing blank rows dropped (matching [`status::prepare_capture`]), then the
/// last [`SEND_SCREEN_TAIL_LINES`] rows kept. Physical rows, not "non-blank"
/// rows: an interior blank band between a bare shell prompt and older agent
/// output is exactly the buffer that should push that stale output out of range.
fn current_screen_tail(capture: &str) -> String {
    let mut lines: Vec<&str> = capture.lines().collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let start = lines.len().saturating_sub(SEND_SCREEN_TAIL_LINES);
    lines[start..].join("\n")
}

/// Heuristic: are we stuck in a `--resume` session picker (Claude OR Codex)?
///
/// Claude's picker draws "Resume a conversation" / "Select a session" / "…
/// conversation to resume". Codex's native `codex resume` picker (FIX 3) draws a
/// distinct header — "Resume a session" / "Resume a previous session" — so a
/// genuinely-stuck Codex picker is now visible to `should_escape_resume_picker`
/// and can be escaped on a fresh, non-resume-intended start, exactly as Claude's
/// is. All markers are disjoint from the ready-composer signals
/// ("Ask Codex to do anything" + the model footer), so the composer never reads
/// as a picker and a real picker still receives NO injected prompt.
fn at_resume_picker(capture: &str) -> bool {
    let c = capture.to_lowercase();
    c.contains("resume a conversation")
        || c.contains("select a session")
        || c.contains("conversation to resume")
        || c.contains("resume a session")
        || c.contains("resume a previous session")
}

/// Heuristic: is Claude blocking on its first-run "Do you trust the files in
/// this folder?" workspace-trust dialog? This appears the FIRST time Claude is
/// launched in a directory it has never seen (its path is absent from
/// `~/.claude.json`'s `projects`). It is a SEPARATE gate from permission prompts
/// — `--dangerously-skip-permissions` does NOT skip it — so a freshly-cloned
/// project dir (e.g. developing supermux on the server) would otherwise hang
/// here forever, never reaching the `❯` prompt, and the panel shows "claude
/// won't render". We detect it and auto-accept (Enter on the default "Yes, I
/// trust this folder"), which also records the dir as trusted so it never
/// reappears for that path.
fn at_trust_dialog(capture: &str) -> bool {
    let c = capture.to_lowercase();
    (c.contains("trust the files") || c.contains("trust this folder") || c.contains("do you trust"))
        || (c.contains("safety check") && c.contains("trust"))
}

/// Should `wait_for_agent_ready` ESCAPE the resume picker (Escape Escape C-c +
/// `clear_cc`)? Pure so the fix is unit-tested without driving real tmux.
///
/// The escape is an ANTI-HANG fallback for a FRESH start only: a `--name` launch
/// should never sit at Claude's `--resume` picker, so if it somehow does we bail
/// to a usable prompt. On an INTENDED resume it is destructive TWICE over — it
/// abandons the exact conversation the user (or a prior run's cc link) asked to
/// continue, AND `clear_cc` PERMANENTLY wipes the resume handle so every later
/// Start/Resume boots fresh too. So on an intended resume we NEVER escape: we
/// leave the picker for the user (its `❯` cursor trips `agent_ui_visible`, so the
/// session still reads ready) and the cc link is preserved. `already_escaped`
/// gates the one-shot so we don't spam the fallback across poll ticks.
fn should_escape_resume_picker(capture: &str, resume_intended: bool, already_escaped: bool) -> bool {
    !resume_intended && !already_escaped && at_resume_picker(capture)
}

/// What one poll tick of [`wait_for_agent_ready`] should DO for a given capture.
/// Factored out pure so the ready-vs-boot-gate ordering — and, above all, the
/// rule that a MODAL is never "ready" — is unit-tested without driving a real
/// pty.
#[derive(Debug, PartialEq, Eq)]
enum ReadyTick {
    /// The first-run trust dialog is up: Enter to accept, then keep polling.
    AcceptTrust,
    /// A stale resume picker on a FRESH start: escape it once, then keep polling.
    EscapePicker,
    /// The agent's OWN prompt is on screen with no boot modal over it — READY.
    Ready,
    /// Nothing actionable yet — keep polling. Critically this INCLUDES a resume
    /// picker left open on an intended resume (`should_escape_resume_picker`
    /// deliberately does not escape it): the `❯` cursor makes `agent_ui_visible`
    /// true, but the agent is NOT at the wheel behind the modal, so it must not
    /// count as ready. Reporting it ready is what let a stale `--resume` park at
    /// the picker, be recorded as a successful heal, and have the next send typed
    /// (with an Enter) straight into the picker and logged as delivered.
    Wait,
}

/// Decide one tick. Order is trust → picker-escape → ready, matching the boot
/// gates the launch has to clear; the ready arm keys on
/// [`agent_at_the_wheel`] (NOT the bare `agent_ui_visible`) so neither the trust
/// dialog nor the resume picker — both of which draw the `❯` glyph — is ever
/// mistaken for a live prompt.
fn classify_ready_tick(
    capture: &str,
    resume_intended: bool,
    already_escaped: bool,
    trusted: bool,
) -> ReadyTick {
    if !trusted && at_trust_dialog(capture) {
        return ReadyTick::AcceptTrust;
    }
    if should_escape_resume_picker(capture, resume_intended, already_escaped) {
        return ReadyTick::EscapePicker;
    }
    if agent_at_the_wheel(capture) {
        return ReadyTick::Ready;
    }
    ReadyTick::Wait
}

/// Confirm the pane shell is live (and let it print a prompt).
async fn settle_shell(rt: &dyn SessionRuntime) -> bool {
    for _ in 0..10 {
        if rt.alive().await {
            tokio::time::sleep(Duration::from_millis(150)).await;
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Poll `capture-pane` for up to 10s for the agent UI; one resume-picker escape
/// fallback (Escape Escape C-c + clear cc ids — FRESH starts only, see
/// [`should_escape_resume_picker`]), and one trust-dialog auto-accept (Enter on
/// the default "Yes, I trust this folder") so a first-launch in a never-seen
/// project dir does not hang forever.
///
/// `resume_intended` (from [`build_launch_command`]) is TRUE when the launch
/// carried `--resume`. On an intended resume the picker escape is SUPPRESSED: it
/// would abandon the requested conversation and `clear_cc` would permanently break
/// resuming it — the root cause of "Resume of a stopped Claude session doesn't
/// always work". The trust-dialog gate still runs on both paths (auto-accepting is
/// non-destructive and needed so a resume in a never-trusted dir doesn't hang).
async fn wait_for_agent_ready(
    rt: &dyn SessionRuntime,
    state: &AppState,
    name: &str,
    resume_intended: bool,
) -> bool {
    let mut escaped = false;
    let mut trusted = false;
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if let Ok(cap) = rt.capture_plain(40).await {
            // Dismiss the first-run BOOT GATES *before* the ready-check. Both the
            // trust dialog and the resume picker draw a numbered menu whose cursor
            // is `❯` — the exact glyph `agent_ui_visible` keys on — so a ready-check
            // keyed on that glyph alone would declare the session "ready" with a
            // modal still up. Two costs we actually hit in prod:
            //   1. the steering deliver then sends the dispatched task INTO the modal
            //      (a bare Enter just picks "Yes, I trust" / a stale conversation),
            //      so the agent "never got the message"; and
            //   2. the status detector captures the `❯ 1.` menu, matches the WAITING
            //      bank, and flips the card to "needs your input" the instant it is
            //      claimed — before the agent has done anything.
            // Order is trust → resume → ready (see [`classify_ready_tick`]); the
            // ready arm keys on `agent_at_the_wheel`, so a picker left open on an
            // INTENDED resume (which we deliberately do not escape) reads Wait, not
            // Ready — a heal that only reaches the picker is a FAILED heal.
            match classify_ready_tick(&cap, resume_intended, escaped, trusted) {
                ReadyTick::AcceptTrust => {
                    // Default option is "1. Yes, I trust this folder"; a bare Enter
                    // accepts it (and persists the trust so it never reappears).
                    let _ = rt.send_key("Enter").await;
                    trusted = true;
                }
                ReadyTick::EscapePicker => {
                    let _ = rt.send_key("Escape").await;
                    let _ = rt.send_key("Escape").await;
                    let _ = rt.send_key("C-c").await;
                    let _ = db::sessions::clear_cc(&state.pool, name).await;
                    escaped = true;
                }
                ReadyTick::Ready => return true,
                ReadyTick::Wait => {}
            }
        }
    }
    false
}

/// SIGTERM then (after a grace) SIGKILL the pane process group.
async fn hard_kill(pid: u32) {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    let p = Pid::from_raw(pid as i32);
    let _ = kill(p, Signal::SIGTERM);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = kill(p, Signal::SIGKILL);
}

/// Emit an `alerts` SSE event (best-effort; dropped if no subscribers).
fn emit_alert(state: &AppState, name: &str, level: &str, detail: &str) {
    let _ = state.sse_tx.send(SseEvent {
        event: "alerts".to_string(),
        company_id: None,
        payload: json!({ "level": level, "session": name, "detail": detail }),
    });
}

/// Publish a `name → status` transition ourselves: bump the per-session status
/// watch (so a late-subscribing `wait` reads the latest), and broadcast BOTH the
/// `status` and `sessions` SSE deltas so every connected client flips the dot
/// inside ~16ms — well before the 2s detector tick would otherwise carry it.
///
/// `start()` open-codes this exact triplet for `starting`/`active`; `stop()` did
/// NOT, so a stopped session's `stopped` row only reached the client on the next
/// detector tick (or a full refetch) — making Stop feel laggy even after tmux is
/// already gone. Centralising the triplet keeps the two paths consistent (DRY).
fn broadcast_status(state: &AppState, name: &str, status: &str) {
    let version = {
        let tx = state.status_watch_for(name);
        let next = tx.borrow().1.wrapping_add(1);
        tx.send_replace((status.to_string(), next));
        next
    };
    let _ = state.sse_tx.send(SseEvent {
        event: "status".to_string(),
        company_id: None,
        payload: json!({ "name": name, "status": status, "version": version }),
    });
    let _ = state.sse_tx.send(SseEvent {
        event: "sessions".to_string(),
        company_id: None,
        payload: json!({ "delta": [{ "name": name, "status": status }] }),
    });
}

/// Broadcast a `sessions` SSE delta carrying the just-recorded last_send_text +
/// last_send_at. Without this, `set_last_send` only writes the DB; the focus
/// screen's recall affordance would stay stale until the next refetch — the
/// user-visible bug "ik typte een nieuwe prompt maar de bar toont nog de
/// oude". Per-key broadcast volume is bounded by typing speed × number of
/// sessions; the delta payload is tiny (≤8 KB), so this is safe even on big
/// fleets.
///
/// Helper rather than inlining at every `set_last_send` callsite so the wire
/// shape stays in one place.
pub(crate) fn broadcast_send(state: &AppState, name: &str, text: &str, at: i64) {
    let _ = state.sse_tx.send(SseEvent {
        event: "sessions".to_string(),
        company_id: None,
        payload: json!({
            "delta": [{
                "name": name,
                "last_send_text": text,
                "last_send_at": at,
            }]
        }),
    });
}

/// Stop's graceful-exit window. After nudging the agent to exit (`C-c` + `/exit`)
/// we poll on this TIGHT cadence for the pane to die, capping the total wait at
/// [`STOP_GRACE_CAP`]. The cap is deliberately short: tmux teardown
/// (`kill_session`) ALWAYS runs afterward and is definitive, so a long grace only
/// delays a teardown that happens anyway — the very lag that made Stop feel
/// broken (the session lingered in `tmux ls` + the overview for up to 15s).
///
/// Why these values are still safe for `--resume`: Claude persists its session
/// transcript to disk CONTINUOUSLY (every turn), not on exit, so the resume file
/// already exists the moment Stop is pressed. The nudge + brief grace only let an
/// in-flight write flush cleanly; ~1.5s comfortably covers that. If the pane is
/// still alive at the cap we hard-kill the PID (SIGTERM→SIGKILL) before the
/// definitive `kill_session`, so a wedged agent never blocks teardown either.
const STOP_GRACE_POLL: Duration = Duration::from_millis(50);
const STOP_GRACE_CAP: Duration = Duration::from_millis(1_500);

/// Would typing the launch command now land it in a program that is ALREADY
/// running in the session's terminal?
///
/// | `freshly_spawned` | `shell_is_foreground` | result | why |
/// |---|---|---|---|
/// | `true`  | any           | `false` | brand-new terminal: nothing is running |
/// | `false` | `Some(false)` | `true`  | a program owns the pty — do not type at it |
/// | `false` | `Some(true)`  | `false` | shell prompt waiting: this is the recovery path (the agent exited, the terminal did not) |
/// | `false` | `None`        | `false` | backend can not tell (tmux) — historical behaviour, byte-for-byte |
fn agent_already_running(freshly_spawned: bool, shell_is_foreground: Option<bool>) -> bool {
    !freshly_spawned && shell_is_foreground == Some(false)
}

/// Pause between literal text and the `Enter` that submits it, as the session's
/// backend requires ([`SessionRuntime::submit_gap`]).
///
/// MUST be called at every text-then-Enter site. On tmux the gap is `ZERO` and
/// this compiles down to a branch (no sleep, no timer, and — unlike the DB
/// `runtime` lookup this replaced — no query while the per-session lock is
/// held). On the native runtime it is the 50 ms that keeps an Ink TUI from
/// reading text+`\r` as one paste, turning the submit into a newline.
async fn submit_gap(rt: &dyn SessionRuntime) {
    let gap = rt.submit_gap();
    if !gap.is_zero() {
        tokio::time::sleep(gap).await;
    }
}

/// [`submit_gap`], for the one writer that does not go through `send_*`: the
/// login driver (`super::login`) writes to the runtime directly, because the
/// login freeze exists precisely to refuse everybody else — and it needs the
/// same text-then-Enter gap every other site gets.
pub(super) async fn submit_gap_for(rt: &dyn SessionRuntime) {
    submit_gap(rt).await;
}

async fn require_session(state: &AppState, name: &str) -> Result<Session, AppError> {
    db::sessions::get(&state.pool, name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))
}

/// Build the per-spawn OS-sandbox confinement plan for a COMPANY session
/// (companies §4.4), or `None` for a main/PA/tech-admin bot (`company_id` NULL)
/// or when `isolation_mode = off`.
///
/// Resolves the company `root_dir` by a DB read (kept OUT of the pure
/// `build_env`), builds the [`crate::isolation::SandboxSpec`], surfaces the
/// MEASURED level per session (log + `isolation_applied` store for a later
/// badge), and — under `StrictRequired` on a host that enforces nothing —
/// REFUSES to start with a clear error rather than degrading. Under `BestEffort`
/// a `None`/blocked measurement still returns a plan whose `apply_in_child`
/// fails open, so the child execs.
async fn company_confinement(
    state: &AppState,
    s: &Session,
    name: &str,
) -> Result<Option<crate::isolation::ConfinePlan>, AppError> {
    use crate::isolation::IsolationMode;
    // GATE: `company_id IS NULL` ⇒ a main/PA/tech-admin bot ⇒ never confined —
    // `confine()` is simply never reached (no global sandbox to exempt from).
    let Some(cid) = s.company_id else {
        return Ok(None);
    };
    // Escape hatch: `isolation_mode = off` ⇒ no plan ⇒ `confine()` never called.
    if state.isolation.mode() == IsolationMode::Off {
        return Ok(None);
    }
    // StrictRequired fail-closed: refuse to start a company session on a host
    // that enforces no OS sandbox — or one where the startup self-test showed a
    // confined child cannot boot + exec — BEFORE any spawn.
    if let Some(reason) = state.isolation.strict_refusal() {
        return Err(AppError::Conflict(reason));
    }
    // SELF-TEST GATE (companies §4.4, the primary guarantee): if the startup
    // self-test showed a confined child cannot BOOT + EXEC on this host (a broken
    // Landlock allow-list, or a host without a working jail), DISABLE company
    // confinement for this boot so the bot still starts UNCONFINED rather than
    // dying at exec. Under StrictRequired this branch is unreachable (the refusal
    // above already fired); it is the BestEffort fail-open path. The loud one-time
    // warning was already logged by `confinement_self_test`.
    if !state.isolation.confinement_usable() {
        tracing::warn!(
            session = name,
            company = cid,
            "isolation: company agent '{name}' spawning UNCONFINED — the startup self-test \
             showed a confined child cannot boot + exec on this host (Landlock jail not \
             functional / allow-list insufficient). secret-floor still applies; check the \
             allow-list in server/src/isolation.",
        );
        state
            .isolation_applied
            .insert(name.to_string(), crate::isolation::IsolationLevel::None);
        return Ok(None);
    }
    let company = db::companies::get(&state.pool, cid)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("load company {cid}: {e}")))?
        .ok_or_else(|| {
            AppError::Internal(anyhow::anyhow!(
                "session '{name}' references company {cid} that no longer exists"
            ))
        })?;
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    let plan = state
        .isolation
        .plan_for(std::path::Path::new(&company.root_dir), &home);

    // Surface the MEASURED level per session (BestEffort surfaces the measured
    // level, never the requested mode) — log it + stash it for a later UI badge.
    let level = state.isolation.probe().best_level.clone();
    if level.is_enforced() {
        tracing::info!(
            session = name,
            company = cid,
            backend = state.isolation.probe().backend,
            "isolation: company agent confined at {level}",
        );
    } else {
        tracing::warn!(
            session = name,
            company = cid,
            backend = state.isolation.probe().backend,
            "isolation: company agent '{name}' spawning UNCONFINED (measured {level}; \
             fail-open under best-effort). secret-floor still applies; add \
             SystemCallFilter=@sandbox on Linux to enable the kernel jail.",
        );
    }
    state.isolation_applied.insert(name.to_string(), level);
    Ok(plan)
}

/// R2 board↔session link liveness: when a session's lifecycle changes
/// (archive/unarchive/stop/delete), any board card linked to it goes stale —
/// `IssueView::session_live` flips, so an open board would keep showing a
/// confidently-wrong live dot until a manual refetch. Re-publish the board over
/// SSE so every open board updates, but ONLY when the session actually has linked
/// issues (otherwise a board re-publish on every unrelated session op is pure
/// noise). Best-effort: a failed lookup is logged, never fatal to the lifecycle op.
async fn emit_board_if_linked(state: &AppState, name: &str) {
    match db::board::issues_for_session(&state.pool, name).await {
        Ok(issues) if !issues.is_empty() => crate::board::emit_board(state).await,
        Ok(_) => {} // no linked issues — nothing on the board to refresh.
        Err(e) => {
            tracing::debug!(name = %name, error = %e, "emit_board_if_linked: issues_for_session failed")
        }
    }
}

// ── public lifecycle API ────────────────────────────────────────────────────

/// Spawn (or re-attach to) the session's tmux session and launch the agent.
pub async fn start(
    state: &AppState,
    name: &str,
    prompt: Option<&str>,
) -> Result<StartResult, AppError> {
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;
    start_locked(state, name, prompt).await
}

/// Outcome of [`start_if_stopped`]: either we started (carrying `start`'s
/// readiness flag), or the death-stamp precondition no longer held under the lock
/// and we deliberately did nothing.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum HealStart {
    Started(bool),
    Superseded,
}

/// [`start`], made ATOMIC with the "is this still a death-stamped, nobody-else-
/// touched-it session?" precondition the auto-heal depends on.
///
/// The old auto-heal probed `try_lock` + re-read status in a helper, dropped the
/// lock, then called `start`, which re-acquired it — a TOCTOU window in which a
/// user's Stop/Resume/delete could land and be silently undone by the restart.
/// Here the status re-read and the spawn happen under ONE continuous hold of the
/// per-session lock, so any lifecycle op that moved the row off `stopped` before
/// we started is seen and honored: we bail `Superseded` rather than resurrect a
/// session the owner just acted on. THE USER WINS, atomically.
pub(super) async fn start_if_stopped(
    state: &AppState,
    name: &str,
) -> Result<HealStart, AppError> {
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;
    // Authoritative re-check UNDER the lock we are about to start under. `stopped`
    // is exactly the state a terminal death leaves behind; anything else means a
    // user (or another lifecycle op) moved it while the daemon was deciding.
    let still_stopped = matches!(
        db::sessions::runtime(&state.pool, name).await.ok().flatten(),
        Some(rt) if rt.last_status == "stopped",
    );
    if !still_stopped {
        return Ok(HealStart::Superseded);
    }
    let res = start_locked(state, name, None).await?;
    Ok(HealStart::Started(res.ready))
}

/// The body of [`start`], assuming the per-session lock is ALREADY held. Split
/// out so [`start_if_stopped`] can wrap it with an atomic precondition without
/// re-entering the (non-reentrant) lock.
async fn start_locked(
    state: &AppState,
    name: &str,
    prompt: Option<&str>,
) -> Result<StartResult, AppError> {
    let mut s = require_session(state, name).await?;

    // RETIRED PROVIDER GUARD. A row whose provider supermux no longer ships
    // (see `sessions::RETIRED_PROVIDERS`) survives in deployed databases and
    // must stay listable and renderable — but it can never be launched again:
    // the launch builder's fallback arm would boot CLAUDE inside a pane named
    // after the retired agent, which is worse than a refusal. Answer with a
    // 400 that says what happened and what to do, BEFORE any tmux/native spawn,
    // any hook-token rotation or any DB write. Every start path (the HTTP
    // route, `restart`, the scheduler tick, the board's start-agent) funnels
    // through here, so one guard covers all of them.
    if crate::sessions::is_retired_provider(&s.provider) {
        return Err(AppError::BadRequest(format!(
            "session '{name}' uses the retired '{}' provider and can no longer be started; \
             its history stays readable — archive it, or duplicate it onto a supported provider",
            s.provider
        )));
    }

    // NATIVE-BY-DEFAULT MIGRATION. The tmux-less runtime is the product default;
    // a legacy `runtime='tmux'` row upgrades AT THE FIRST FRESH START — i.e. when
    // its tmux pane is gone, so a live pane (and its scrollback) is never yanked
    // from under a running agent. Teams stay tmux (Claude renders teammates as
    // tmux panes) and remote-host sessions stay tmux (a pty holder is local by
    // definition). The flip is durable (column write) + the runtime cache is
    // invalidated so `runtime_for` below builds the native backend immediately.
    // (`force_agent_teams` marks an in-flight team-lead conversion — its start
    // must stay tmux even though `team_name` is only set by detection later.)
    // "Fresh start" covers BOTH shapes a restart takes: the tmux session is
    // fully gone, OR it lingers as a remain-on-exit DEAD pane (the normal
    // stop→start cycle — `stop` leaves the dead pane for capturability). Only a
    // pane with a LIVE agent blocks the migration: this start() is then just a
    // wake/ensure and yanking a running pty is never acceptable.
    //
    // Teams are detected PHYSICALLY (>1 live tmux pane), NOT via `team_name`:
    // with the global agent-teams pref on, Claude writes an IMPLICIT solo team
    // (`session-<id8>`, members = just the lead, in-process) for every plain
    // session, and the watcher stamps `team_name` on those rows — a label that
    // says nothing about tmux panes. Blocking on it froze half the fleet on
    // tmux (found live: a hand-started single session refused to migrate).
    // `start_count > 0` scopes the migration to rows that have RUN before (the
    // legacy fleet being upgraded): a freshly-created row that explicitly chose
    // tmux (tests, tooling, the team-convert flip) gets its first start on the
    // runtime it asked for. New rows default to native at create anyway.
    if s.runtime == crate::sessions::runtime::RUNTIME_TMUX
        && s.start_count > 0
        && s.host_id.is_none()
        && !state.force_agent_teams(name)
    {
        let tmux = Tmux::new(name);
        let texists = tmux.exists().await.unwrap_or(true);
        // A REAL rendered team = more than one live pane → never migrate it.
        let multi_pane = texists
            && tmux
                .list_pane_ids()
                .await
                .map(|p| p.len() > 1)
                .unwrap_or(true);
        // Fresh = no session, a dead pane, OR a pane whose foreground process
        // group is the shell itself (the agent exited back to bash — the shape
        // `stop` actually leaves behind, since /exit ends claude but not the
        // pane's bash). Only a pane with a live FOREGROUND AGENT blocks.
        let mut fresh =
            !texists || (!multi_pane && tmux.pane_dead().await.unwrap_or(false));
        if !fresh && !multi_pane {
            if let Ok(Some(pid)) = tmux.pane_pid().await {
                fresh = crate::sessions::native::runtime::foreground_pgid(pid) == Some(pid);
            }
        }
        if fresh {
            if texists {
                // Kill the dead-pane remnant so the native spawn owns the name.
                let _ = tmux.kill_session().await;
            }
            db::sessions::set_runtime(&state.pool, name, crate::sessions::runtime::RUNTIME_NATIVE)
                .await?;
            state.runtime_invalidate(name);
            s.runtime = crate::sessions::runtime::RUNTIME_NATIVE.to_string();
            state.pty_invalidate(name);
            tracing::info!(session = name, "runtime migrated tmux → native on fresh start");
        }
    }
    // Runtime seam: `runtime_for` returns the backend for the row's `runtime`
    // column, built exactly as `Tmux::new(name)` built it here before.
    let rt = state.runtime_for(name).await?;

    // Rotate the hook token on every start to avoid long-lived env secrets.
    let hook_token = super::gen_hook_token();
    db::sessions::ensure_runtime(&state.pool, name, &hook_token).await?;
    state.hook_tokens.insert(name.to_string(), hook_token.clone());

    // The global experimental Agent Teams gate (default OFF). Read
    // once here; it both injects the env var and writes `teammateMode:"tmux"`.
    // FAIL CLOSED — a read failure reads OFF inside `agent_teams_enabled`.
    //
    // A session that was explicitly spun up as a team LEAD
    // carries a per-session override flag — it gets the Agent Teams env even when
    // the global pref is OFF (an explicit opt-in beats the conservative default).
    // We OR the two so this NEVER fights the global gating: global ON enables it for
    // every Claude session as before; the override only WIDENS it for one flagged
    // lead. The Claude-only guard still lives in `build_env`/the settings install.
    let agent_teams =
        db::prefs::agent_teams_enabled(&state.pool).await || state.force_agent_teams(name);

    // Install the Claude SettingsHook events so the agent reports real status
    // signals. Idempotent + non-destructive; failure is non-fatal — the
    // detector still classifies off the regex bank + pty heartbeat. Only Claude
    // reads `~/.claude/settings.json`, so skip it for codex/shell sessions.
    //
    // When the session is remote (s.host_id is Some), resolve
    // a SshFileTransport from the host pool so the hooks land in the REMOTE
    // host's `~/.claude/settings.json`. Local sessions get a LocalFileTransport
    // (the v1 behaviour, byte-for-byte). The transport's atomic-rename
    // discipline holds across both impls.
    if s.provider == "claude" {
        let transport: Arc<dyn FileTransport> = match s.host_id {
            Some(id) => Arc::new(SshFileTransport::new(state.host_pool.clone(), HostId(id))),
            None => Arc::new(LocalFileTransport),
        };
        if let Err(e) =
            crate::claude_config::install_hooks(name, &hook_token, transport.as_ref(), None).await
        {
            tracing::warn!(name = %name, error = %e, "install_hooks failed; status falls back to regex/heartbeat");
        }
        // When teams is enabled, also force `teammateMode:"tmux"` so a
        // lead spawns teammates as split-panes on supermux's socket (not the
        // invisible in-process backend). Gated + Claude-only; non-fatal on error.
        //
        // ALSO runtime-gated: `teammateMode:"tmux"` tells Claude Code to
        // `split-window` on the tmux server supermux owns. A native session has
        // no tmux window to split into, so writing that setting would point
        // Claude at a multiplexer this session doesn't use. Native sessions skip
        // it (and `teams::start` refuses to convert one, so a native lead can
        // never exist in the first place).
        if agent_teams && s.runtime != super::runtime::RUNTIME_NATIVE {
            if let Err(e) = crate::claude_config::install_agent_teams_setting(
                name,
                transport.as_ref(),
                None,
            )
            .await
            {
                tracing::warn!(name = %name, error = %e, "install_agent_teams_setting failed; teams may use the wrong backend");
            }
        }
    }

    let mut env = build_env(
        &state.config,
        name,
        &hook_token,
        &s.provider,
        agent_teams,
        s.host_id,
    );

    // ── connector store (migration 0031): the shared per-session seam ──────────
    // ONE component owns building this session's private settings OVERLAY:
    // `connector_config::assemble`. It returns `None` (and touches nothing) unless
    // the session has enabled connector grants OR bot memory — so the launch is
    // byte-identical for the pre-connector fleet. When present it yields the env
    // to MERGE over `build_env`'s map (the decrypted `${VAR}` secrets and the
    // account-connector kill switch) and the launch flag words
    // (`--mcp-config … --strict-mcp-config` plus `--settings <overlay>`) threaded
    // into `build_launch_command` below. The overlay is layered via `--settings`,
    // NOT by repointing `CLAUDE_CONFIG_DIR`, so the transcript tailer, statusline,
    // teams, resume, and auth all stay on the real `~/.claude`. Claude-only (codex
    // ignores these flags); best-effort — a failure logs and launches without
    // connectors rather than blocking start.
    let mut connector_flags: Vec<String> = Vec::new();
    if launches_claude(&s.provider) {
        match crate::sessions::connector_config::assemble(state, name).await {
            Ok(Some(cfg)) => {
                env.extend(cfg.env);
                connector_flags = cfg.launch_flags;
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(name = %name, error = %e, "connector launch injection failed; starting without connectors");
            }
        }
    }

    let dir = PathBuf::from(&s.dir);
    let shell = user_shell();

    // ORPHAN REAPING (native, local only). A holder that died while its CHILD
    // survived leaves the child reparented to `init` with `meta.json` still
    // naming its live pid and no `exit` marker — the exact state
    // `Spool::create` REFUSES to run over. That refusal fires inside the holder
    // we are about to spawn, so without this the spawn below would sit out its
    // full timeout and this Resume would fail with "holder did not come up in
    // time" on a session that is perfectly recoverable.
    //
    // `reap_orphan` is a no-op (returns `None`, reads nothing, moves nothing)
    // for a session that probes ALIVE, for one that never had a holder, and for
    // the ordinary stop → start cycle where the recorded pid is simply gone — so
    // the historical start path is untouched. tmux and remote rows never reach
    // it at all.
    //
    // A reap that REFUSES (a live pid whose identity cannot be proven) fails the
    // start on the spot: proceeding would clear a sidecar that may still belong
    // to a running agent, and two agents on one session dir is a far worse
    // outcome than an error the user can see and act on.
    if s.runtime == crate::sessions::runtime::RUNTIME_NATIVE && s.host_id.is_none() {
        // THE BINARY UNDER US. A native start spawns `<this binary> pty-holder`,
        // resolved through `current_exe()` — which turns into `… (deleted)` the
        // moment the inode is replaced (a rebuild, an in-place install). The
        // spawn then fails ENOENT deep inside the runtime and every new session
        // answers a naked 500 with one `spawn pty holder` line in the log.
        // `holder_bin` now recovers by re-probing the installed path; when even
        // that is gone, say so HERE, where the answer is still a sentence on the
        // wire instead of `AppError::Internal`'s deliberate silence.
        if let Err(e) = crate::sessions::native::runtime::holder_bin() {
            tracing::error!(name = %name, error = %e, "start: no pty-holder binary to spawn");
            return Err(AppError::Conflict(format!("{e:#}")));
        }
        match crate::sessions::native::reap_orphan(name, &state.config.data_dir).await {
            Ok(Some(reaped)) => tracing::warn!(
                name = %name,
                pid = reaped.pid,
                signalled = reaped.signalled,
                sigkill = reaped.killed,
                evidence = ?reaped.evidence,
                "start: reaped an orphaned child left by a dead holder before respawning",
            ),
            Ok(None) => {}
            Err(refused) => {
                tracing::error!(name = %name, error = %refused, "start: refusing to reap");
                return Err(AppError::Conflict(refused.to_string()));
            }
        }
    }

    let freshly_spawned = !rt.alive().await;
    if freshly_spawned {
        // A genuinely new pane/pty is about to exist for this name. Drop any
        // cached live pty stream: it is bound to a PRIOR (now-dead) pane,
        // and because the new session reuses the same name the stream's liveness
        // poll would never invalidate it on its own. `stop` already does this on
        // the restart path; this also covers a start that follows an external
        // pane death (auto-wake, a crash the reader hasn't noticed yet) so the
        // first WS attach after start always rebuilds against the NEW pane.
        // A SERVER restart starts with an empty registry and never hits this
        // `freshly_spawned` branch (it re-attaches to the surviving session), so
        // session-survival is untouched.
        //
        // AFTER the spawn, not before: pre-seam the liveness probe was fallible
        // (`tmux has-session` + `?`) and a probe fault propagated BEFORE anything
        // was invalidated. `SessionRuntime::alive` is infallible by contract
        // ("a fault reads as gone"), so a transient probe glitch on a session
        // that is actually running now lands here — and must not tear down that
        // live session's cached stream on the way to a spawn that fails.
        // COMPANY ISOLATION (companies §4.4). Build the per-spawn confinement
        // plan for a company session (`None` for a main/PA bot or under
        // isolation_mode=off) and spawn through the confining seam. On THIS box
        // the probe measures None (the @system-service filter blocks
        // landlock_*), so under BestEffort the plan fails open and the child
        // execs UNCONFINED — behaviour-identical to a NULL-company session.
        let confine_plan = company_confinement(state, &s, name).await?;
        let confinement_degraded = rt.spawn_confined(&dir, &env, &shell, confine_plan).await?;
        if confinement_degraded {
            // FAIL-SAFE landed: the confined holder could not boot under the
            // Landlock jail, so the native runtime retried UNCONFINED to keep the
            // company bot startable. Record the applied level as None so the (P2)
            // badge / logs stay honest about the degraded isolation.
            tracing::error!(
                session = %name,
                company = ?s.company_id,
                "isolation: company agent started UNCONFINED after the confined holder \
                 failed to boot (fail-safe); applied level recorded as None — check the \
                 allow-list in server/src/isolation",
            );
            state
                .isolation_applied
                .insert(name.to_string(), crate::isolation::IsolationLevel::None);
        }
        state.pty_invalidate(name);
    }

    // BOOTING window (overview UX): mark the session `starting` before
    // we shell-launch the agent so the tile renders the neutral "booting…"
    // affordance instead of flashing `unknown`/`stopped`/`active` while the TUI
    // is still printing its splash. The detector loop replaces this with the
    // real classification on its next tick once the agent UI settles.
    //
    // Push it through BOTH the DB (so a `GET /api/sessions` race sees it) AND
    // the status watch + SSE (so connected clients flip the dot inside ~16ms,
    // well before the 2s detector tick lands).
    db::sessions::set_last_status(&state.pool, name, "starting").await?;
    let starting_version = {
        let tx = state.status_watch_for(name);
        let next = tx.borrow().1.wrapping_add(1);
        tx.send_replace(("starting".to_string(), next));
        next
    };
    let _ = state.sse_tx.send(SseEvent {
        event: "status".to_string(),
        company_id: None,
        payload: json!({
            "name": name,
            "status": "starting",
            "version": starting_version,
        }),
    });
    let _ = state.sse_tx.send(SseEvent {
        event: "sessions".to_string(),
        company_id: None,
        payload: json!({ "delta": [{ "name": name, "status": "starting" }] }),
    });

    // DOUBLE-LAUNCH GUARD. `start()` on a session whose terminal is already up
    // skips the spawn but historically still typed the launch command — harmless
    // on tmux (that path is reached when the pane exists but its program died,
    // i.e. a bash prompt is waiting for exactly that command), catastrophic when
    // the program is in fact still RUNNING: `claude --resume …` gets typed into
    // the live agent's composer.
    //
    // The native runtime can reach that state for real — its holder survives a
    // daemon restart, so a post-deploy Start finds `alive() == true` with Claude
    // still at the wheel (that path is also why the boot reconcile now probes
    // native liveness instead of assuming `stopped`).
    //
    // See [`agent_already_running`] for the decision table.
    let already_running =
        agent_already_running(freshly_spawned, rt.shell_is_foreground().await);

    let ready = match s.provider.as_str() {
        "shell" => settle_shell(rt.as_ref()).await,
        _ if already_running => {
            tracing::info!(
                name = %name,
                "start: terminal already running its program — not re-typing the launch command",
            );
            // A program owning the pty IS the ready condition; poking it with the
            // boot-gate keys `wait_for_agent_ready` sends would be input into a
            // live agent.
            true
        }
        _ => {
            // Give the new shell a beat, then launch the agent.
            tokio::time::sleep(Duration::from_millis(300)).await;
            let (cmd, resume_intended) =
                build_launch_command(&state.config, &s, &connector_flags);
            rt.send_text(&cmd).await?;
            submit_gap(rt.as_ref()).await;
            rt.send_key("Enter").await?;
            wait_for_agent_ready(rt.as_ref(), state, name, resume_intended).await
        }
    };

    db::sessions::bump_start(&state.pool, name).await?;

    if !ready {
        // FAILED launch/resume: the pane came back (a bash prompt, or a modal we
        // could not clear such as a stale resume picker) but the AGENT never took
        // the wheel. Persisting `active` here — as this path unconditionally did —
        // is the false-healthy bug: `Heal::Failed`'s contract is that the session
        // STAYS stopped, yet any consumer reading `status` independently of the
        // `holder_died` badge (the roster dot, the board's live check, the
        // detector's own `prev` seed) saw a green `active` row over a shell.
        //
        // Restore `stopped` and broadcast it, and do NOT type `prompt` into
        // whatever is sitting on the pty (that is how a delegated message got
        // swallowed by a bash prompt / typed into the picker). The caller
        // (`wake_for_send`, `auto_heal`) re-stamps the honest `holder_died` badge
        // and reports UNDELIVERED. We do not wake the detector: there is nothing
        // good for it to observe, and a live bash prompt would only tempt it to
        // settle the row back to `idle`.
        db::sessions::set_last_status(&state.pool, name, "stopped").await?;
        broadcast_status(state, name, "stopped");
        return Ok(StartResult {
            name: name.to_string(),
            started: true,
            ready,
            target: rt.target(),
        });
    }

    db::sessions::set_last_status(&state.pool, name, "active").await?;
    // Explicitly publish the `starting → active` transition ourselves. The
    // detector loop can't be trusted to do it: by the time it ticks, it seeds
    // its in-memory `prev` from the DB row we just wrote (`active`), so the
    // first observed tick has `new_status == prev` and emits nothing. Without
    // this explicit broadcast the client cache stays wedged on `starting`
    // until a full `GET /api/sessions` refresh (focus, reconnect, hard reload)
    // pulls the up-to-date row. Mirrors the `starting` triplet ~30 lines above
    // (shared with `stop`'s `stopped` broadcast via `broadcast_status`).
    broadcast_status(state, name, "active");
    // Wake the detector so the BOOTING → real-status transition is broadcast
    // sub-second rather than at the next 2s tick (the tile dot otherwise sits
    // in the booting affordance for up to 2s after the agent UI is ready).
    state.wake_detector(name);

    if let Some(p) = prompt {
        if !p.trim().is_empty() {
            rt.send_text(p).await?;
            submit_gap(rt.as_ref()).await;
            rt.send_key("Enter").await?;
            let (preview, at) = db::sessions::set_last_send(&state.pool, name, p).await?;
            broadcast_send(state, name, &preview, at);
        }
    }

    Ok(StartResult {
        name: name.to_string(),
        started: true,
        ready,
        target: rt.target(),
    })
}

/// Graceful stop (provider exit) → BRIEF grace → hard kill → tmux teardown.
/// Returns once the session is `stopped`; the caller answers 202.
///
/// Stop felt broken because the old grace polled up to 15s before
/// the (always-definitive) `kill_session`, so the tmux session lingered in
/// `tmux ls` + the overview for that whole window. We now nudge the agent, give
/// it only the SHORT [`STOP_GRACE_CAP`] to persist + exit, then tear tmux down
/// promptly — and broadcast `stopped` over SSE immediately so the UI reflects it
/// sub-second. The hard-PID-kill fallback + the definitive `kill_session` safety
/// net are unchanged, so Stop is fast AND never leaves a session half-killed.
pub async fn stop(state: &AppState, name: &str) -> Result<(), AppError> {
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;

    let s = require_session(state, name).await?;

    // Drop the session's shared-browser context (connectors::browser) — BEFORE
    // the early-out below, because an already-dead runtime still leaves the
    // context registered. The agent that owned the page is going away; leaving
    // it keeps a logged-in cookie jar alive, holds a slot against
    // `max_contexts` forever, and — since the idle reaper only fires on an
    // EMPTY context map — keeps chrome running for the life of the process.
    // Fire-and-forget so a wedged browser cannot slow a Stop down; silent for
    // the overwhelmingly common session that never opened a browser at all.
    crate::connectors::browser::dispose_on_teardown(&state.browser, name);

    // Runtime seam — the graceful-exit nudge, the liveness/dead poll, the PID
    // hard-kill and the definitive teardown are all backend-agnostic.
    let rt = state.runtime_for(name).await?;

    if !rt.alive().await {
        db::sessions::set_last_status(&state.pool, name, "stopped").await?;
        broadcast_status(state, name, "stopped");
        emit_board_if_linked(state, name).await;
        return Ok(());
    }

    // 1. Graceful nudge: ask the program to exit. This is NOT removed (resume
    //    relies on Claude's normal-exit flush) — only the wait that follows is
    //    shortened. The 300ms between `C-c` and `/exit` lets the interrupt land
    //    before the slash command, so `/exit` reaches Claude's prompt, not a
    //    mid-stream buffer.
    match s.provider.as_str() {
        "shell" => {
            let _ = rt.send_text("exit").await;
            submit_gap(rt.as_ref()).await;
            let _ = rt.send_key("Enter").await;
        }
        _ => {
            let _ = rt.send_key("C-c").await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let _ = rt.send_text("/exit").await;
            // Without the gap the agent reads `/exit\r` as a paste and never
            // submits it — so the graceful exit silently never happens and every
            // native Stop burns the full `STOP_GRACE_CAP` before the hard kill.
            submit_gap(rt.as_ref()).await;
            let _ = rt.send_key("Enter").await;
        }
    }

    // 2. Wait a BRIEF, capped window for the pane program to exit (session gone
    //    or pane dead), polling on a tight cadence so a clean exit is observed
    //    near-instantly rather than on a coarse 500ms tick. Caps at
    //    `STOP_GRACE_CAP` — teardown happens regardless, so there is no value in
    //    waiting longer.
    let mut graceful = false;
    let deadline = tokio::time::Instant::now() + STOP_GRACE_CAP;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(STOP_GRACE_POLL).await;
        if !rt.alive().await || rt.dead().await.unwrap_or(false) {
            graceful = true;
            break;
        }
    }

    // 3. Hard kill if the grace window elapsed (the agent didn't exit on its own).
    if !graceful {
        if let Ok(Some(pid)) = rt.pane_pid().await {
            hard_kill(pid).await;
        }
    }

    // 4. Definitive teardown. A failure here is surfaced but status still cleans.
    if let Err(e) = rt.kill().await {
        emit_alert(state, name, "error", &format!("stop teardown failed: {e}"));
    }

    // 4b. Invalidate the cached live pty stream. The tmux pane this stream's
    // FIFO/`pipe-pane` was bound to is now dead. A subsequent `start` recreates
    // the SAME tmux session name, so the reader's `tmux has-session` liveness
    // poll would NOT trip — without this the streamer keeps reusing the stale
    // stream, every WS (even a fresh one) replays the OLD pane's last frame, and
    // the new pane's output never appears (the restart-reattach bug). Dropping +
    // shutting it down here means the next attach rebuilds a fresh stream against
    // the NEW pane and any already-open WS reconnects onto it. A SERVER restart
    // never reaches this code path, so session-survival is unaffected.
    state.pty_invalidate(name);

    db::sessions::set_last_status(&state.pool, name, "stopped").await?;
    // Publish `stopped` ourselves (status watch + SSE). The detector
    // can't be relied on for this edge — it reseeds `prev` from the row we just
    // wrote, so its next tick sees `new == prev` and emits nothing, leaving the
    // tile's dot stuck on the pre-stop status until a full refetch. Broadcasting
    // here flips every connected client to `stopped` sub-second, so Stop looks
    // instant even if any residual teardown I/O is still settling. Mirrors the
    // `start()` `starting`/`active` broadcasts (now shared via `broadcast_status`).
    broadcast_status(state, name, "stopped");
    // R2: stopping the agent doesn't archive the row (the link stays live), but
    // the board card mirrors the linked session's state — re-publish so a linked
    // card reflects the now-stopped session rather than a stale running dot.
    emit_board_if_linked(state, name).await;
    Ok(())
}

/// Kill ONE teammate pane inside `name`'s window (`tmux kill-pane -t %id`) —
/// the manual Agent-Teams cleanup primitive. Claude's own graceful teammate
/// shutdown (asking the lead to dismiss a member) is unreliable in practice, so
/// the user gets an explicit per-teammate kill. Now reached only through the
/// remove-a-teammate endpoint ([`crate::teams`]'s `remove_member`), which kills
/// the live pane HERE and then records the supermux-side dismissal — so a kill
/// failure returned here blocks the dismissal (a still-running agent is never
/// hidden).
///
/// Guards, in order (see [`super::teams::validate_teammate_pane`]):
///   * 404 — the session doesn't exist, its tmux window is gone, or `pane_id`
///     is not one of THIS window's live panes (a stale/reused id or another
///     session's pane is never killable through this session).
///   * 400 — `pane_id` is the LEAD pane (killing it would end the whole team;
///     the lead tile's Stop owns that path).
///
/// INVARIANT: we deliberately do NOT touch `~/.claude/teams/*/config.json` —
/// editing it mid-session is unsupported by Claude Code — so the Claude-side
/// roster keeps its member entry until the lead session ends. The "remove"
/// endpoint's dismissal is what hides the member from supermux's view; killing
/// the pane just makes that immediate instead of leaving a lingering dead chip.
pub async fn kill_teammate_pane(
    state: &AppState,
    name: &str,
    pane_id: &str,
) -> Result<(), AppError> {
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;

    let s = require_session(state, name).await?;
    // Respect the session's transport (local vs remote-host SSH) like the WS
    // attach path does — a remote lead's panes live on the remote box.
    let transport = match s.host_id {
        Some(h) => Some(state.host_pool.transport_for(h).await?),
        None => None,
    };
    let tmux = match transport.as_deref() {
        Some(t) => Tmux::new_on(t, name),
        None => Tmux::new(name),
    };
    if !tmux.exists().await? {
        return Err(AppError::NotFound(format!(
            "session '{name}' has no live tmux session"
        )));
    }

    // Membership + lead guard. `list_pane_ids` scopes the check to THIS
    // session's window; `resolve_lead_pane` is the config-based lead
    // discrimination (authoritative when it resolves; the validator falls back
    // to the first-listed pane otherwise, so the lead guard never disarms).
    let live = tmux.list_pane_ids().await?;
    let lead_pane = super::teams::resolve_lead_pane(state, name).await;
    super::teams::validate_teammate_pane(&live, lead_pane.as_deref(), pane_id)?;

    let pane = match transport.as_deref() {
        Some(t) => Tmux::for_pane_on(t, name, pane_id.to_string()),
        None => Tmux::for_pane(name, pane_id.to_string()),
    };
    pane.kill_pane().await?;
    Ok(())
}

/// Refuse text that would forge one of supermux's own transcript wrappers.
///
/// One rule, one message, shared by every untrusted-text delivery path — the
/// same `agents::delegate::wrapper_markup` the delegate endpoint and the
/// schedule hook already answer 400 with, so "may I write this string" has a
/// single answer everywhere. See [`send_text`] for why this is a provenance
/// question rather than an escaping one.
fn reject_wrapper_markup(text: &str) -> Result<(), AppError> {
    if crate::agents::delegate::wrapper_markup(text) {
        return Err(AppError::BadRequest(
            "text may not contain supermux wrapper markup — <supermux-delegation> and \
             <supermux-schedule> are provenance claims only the harness may write"
                .into(),
        ));
    }
    Ok(())
}

/// Send literal text followed by Enter. Auto-wakes a stopped session.
///
/// **This is the UNTRUSTED-TEXT door, and it is where wrapper forgery is
/// stopped.** Everything that is not the harness itself arrives here: the chat
/// composer and `POST /api/sessions/{name}/send`, the steering deliver loop, a
/// schedule's `command:` follow-up, a boot job's second line, the board
/// dispatcher. `<supermux-delegation>` / `<supermux-schedule>` are supermux's
/// own PROVENANCE claims — `recall.rs::classify_prompt_body` and the chat
/// renderer read them back as "Message from ●someone" / "Sent by schedule ⏱" —
/// so a caller that could type one would be forging authenticated arrivals.
///
/// Until now the guard lived only in `agents::delegate` and `scheduler::hook`,
/// i.e. in two of the three writers, and the parity corpus recorded the gap as
/// if it were the design ("the forgery is stopped where it is written"). It was
/// not: an ordinary send — typed into the real composer, no privileges — put a
/// fake `Message from ●ceo-root` divider in another agent's transcript. In a
/// product whose premise is agents talking to agents, that gives fabricated
/// provenance to injected instructions, and the realistic attacker is not a
/// hostile human but one agent echoing web/tool content into another session.
///
/// The refusal is server-side and at the FUNNEL, not per handler, so a new
/// endpoint cannot reintroduce the hole by forgetting a check. The one caller
/// allowed to write a wrapper is the harness itself, through
/// [`send_harness_text`] — named so the exception is visible at the call site.
///
/// KNOWN RESIDUE, recorded rather than papered over: raw keystrokes on the pty
/// WebSocket are the user's own keyboard and are not filtered, so a person can
/// still type a wrapper into their own pane. That is a user forging a label in
/// their own transcript, not one session forging provenance in another's.
pub async fn send_text(state: &AppState, name: &str, text: &str) -> Result<(), AppError> {
    reject_wrapper_markup(text)?;
    send_harness_text(state, name, text, None, None).await
}

/// [`send_text`] for the CHAT composer's `POST /send`, carrying the client's
/// idempotency key. `send_id` (minted per message in
/// `web/.../use-pending-sends.ts` and reused verbatim on every retry) lets the
/// server recognise a re-POST of a message it already typed — a Retry over a
/// false failure, or over a dropped response — and make it a NO-OP instead of a
/// second prompt in the agent's queue. `None` keeps the un-deduped behaviour for
/// callers with no client id.
pub async fn send_chat_text(
    state: &AppState,
    name: &str,
    text: &str,
    send_id: Option<&str>,
) -> Result<(), AppError> {
    reject_wrapper_markup(text)?;
    send_harness_text(state, name, text, None, send_id).await
}

/// [`send_chat_text`] for a message sent by an authenticated HUMAN colleague
/// (P3c). The author is server-resolved from `AuthContext` (P3a) and stamped into
/// a `<supermux-human>` provenance wrapper — NEVER trusted from the request body.
///
/// The composer text is first refused if it already carries wrapper markup (a
/// forged human/delegation/schedule claim), exactly as an owner send is; only
/// THEN is the clean text wrapped and handed to the harness door
/// ([`send_harness_text`], the one writer allowed to emit a wrapper). The stored
/// preview is the UNWRAPPED text, so the roster's send-recall shows what the
/// person typed, not the machinery. The owner's own sends never reach here (the
/// owner is not a `Human` context), so they are byte-identically unaffected.
pub async fn send_human_text(
    state: &AppState,
    name: &str,
    text: &str,
    author_user_id: i64,
    author_name: &str,
    author_company_id: Option<i64>,
    send_id: Option<&str>,
) -> Result<(), AppError> {
    reject_wrapper_markup(text)?;
    let wrapped = crate::agents::delegate::wrap_human(
        author_user_id,
        author_name,
        author_company_id,
        text,
    )
    .map_err(|e| AppError::BadRequest(e.into()))?;
    send_harness_text(state, name, &wrapped, Some(text), send_id).await
}

/// [`send_text`] for HARNESS-AUTHORED deliveries: no wrapper-markup guard, and
/// the string recorded as `last_send_text` can differ from the string typed
/// into the pty.
///
/// Two callers, both of which build supermux's own transcript wrappers with
/// `agents::delegate::wrap_delegation` / the schedule tag after refusing
/// forgeable markup in the untrusted parts (`from`, `prompt`, `title`):
/// `agents::delegate` and `scheduler::runner`. `tests/archive_schedule_contract.rs`
/// pins that list — a third caller is a review question, not a refactor.
///
/// The wrapper is machinery for the receiving agent's transcript: it must never
/// surface as the send preview the roster renders (`last-send-recall.tsx`) or as
/// the text `receiptClaims` matches against, hence `preview_text`.
/// `preview: None` keeps the old behaviour (preview == what was sent).
/// The runtime a `send_harness_text` WRITE must target. Pure decision, factored
/// out so the "re-resolve after a migrating wake" rule is unit-tested against the
/// real runtime cache: when `woke` is true the pre-wake handle may point at a
/// backend `start` just migrated away from, so re-resolve; otherwise reuse it.
async fn write_runtime(
    state: &AppState,
    name: &str,
    pre_wake: Arc<dyn SessionRuntime>,
    woke: bool,
) -> Result<Arc<dyn SessionRuntime>, AppError> {
    if woke {
        Ok(state.runtime_for(name).await?)
    } else {
        Ok(pre_wake)
    }
}

pub async fn send_harness_text(
    state: &AppState,
    name: &str,
    text: &str,
    preview_text: Option<&str>,
    send_id: Option<&str>,
) -> Result<(), AppError> {
    // ARCHIVE CONTRACT (B5/T5): `exists_active`, never the archive-blind
    // `exists`. This function AUTO-STARTS a session that is not alive (three
    // lines down), so gating it on `exists` meant any caller — most visibly a
    // schedule tick — silently resurrected an archived session: running again,
    // yet still hidden from `list` (which filters `archived = 0`). The guard
    // belongs here rather than only in the scheduler so a future job kind or
    // delivery path cannot reintroduce the bug. An archived session is not a
    // send target; unarchive it first.
    if !db::sessions::exists_active(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    // LOGIN FREEZE (the one seam every automatic writer passes through).
    //
    // A `/login` in flight is holding a PKCE `code_verifier` and a `state` nonce
    // that exist ONLY inside the running CLI process, and the masked field is
    // waiting on a paste. Three lines down this function AUTO-STARTS a session
    // that is not alive — so a scheduled fire, a delegated prompt, a board
    // dispatch or a steering delivery landing here mid-login either types into
    // the credential field or restarts the process holding the verifier. Either
    // way the code the user is copying out of their browser at that moment is
    // already dead, and the failure surfaces as "Authentication failed: Invalid
    // authorization code" with nothing in the UI able to explain it.
    //
    // The refusal is a 409 with a sentence, not a silent drop: the caller (and
    // the schedule that will retry) is told what is happening.
    if super::login::is_frozen(name) {
        return Err(super::login::frozen_error(name));
    }
    let rt = state.runtime_for(name).await?;
    // Auto-wake BEFORE taking the lock (start() acquires it itself).
    let woke = !rt.alive().await;
    if woke {
        wake_for_send(state, name).await?;
    }

    let lock = state.lock_for(name);
    let _guard = lock.lock().await;
    // IDEMPOTENCY (chat Retry duplicate guard). Under the per-session lock, so a
    // double-tap that races two POSTs cannot slip both past this check: the
    // first types + records the id below, the second sees it here and returns
    // Ok without typing. Only chat sends carry an id; harness callers pass None
    // and are unaffected. The record happens ONLY after a successful delivery
    // (below `set_last_send`), so a first attempt that 409s here or downstream
    // records nothing and a retry with the same id proceeds normally.
    if let Some(id) = send_id {
        if state.send_dedup.seen(name, id) {
            return Ok(());
        }
    }
    // RE-RESOLVE after a wake. `wake_for_send` → `start` can migrate a legacy
    // tmux session to native on its fresh start, which `runtime_invalidate`s the
    // cache — so `rt`, resolved BEFORE the wake, is now a handle to the dead tmux
    // backend. Writing `text` through it would let the wake succeed yet drop the
    // very first message into nothing. When we did not wake, the pre-resolved
    // handle is still valid; reuse it.
    let rt = write_runtime(state, name, rt, woke).await?;

    // SEND-PATH MODAL GUARD (codex #1, wave-7). `wake_for_send` above refuses a
    // FIRST send whose wake lands on a boot modal, but an ALREADY-AWAKE retry
    // (`woke == false`) never entered that branch — so a retry issued while the
    // session is parked at the resume picker / trust dialog (a live program, so
    // still `alive`) would type `text`+Enter straight into the modal, record
    // `last_send`, and report the swallowed message as delivered. Gate the SEND
    // itself on the CURRENT screen. Refuse BEFORE the first keystroke so nothing
    // is typed and `last_send` is never written — `/send` and `/paste` answer
    // 409, `agents::delegate` never reaches `record_delegation` (no delivered
    // edge), and the chat composer settles on the sentence instead of promising
    // an arrival. Skipped when we just woke: `wake_for_send`'s `start().ready`
    // already polled the agent onto the wheel, and re-capturing a freshly-booted
    // pane risks a transient-repaint FALSE refusal of a message we did deliver.
    // PROVIDER SCOPE. The guard exists to stop a message being typed into a bare
    // shell an AGENT exited to (or a boot modal). A `shell`-provider session's
    // screen IS a bare shell and every send legitimately targets it — guarding it
    // would refuse `echo hi` into a plain terminal. So the whole guard is
    // agent-only: a shell session is always typeable. (This also closes a
    // pre-existing wave-7 gap where the guard refused shell-provider sends
    // whenever the current screen was — correctly — a bare prompt.) On an
    // unreadable row we default to guarding (agent-shaped, fail safe); the row
    // exists here (`exists_active` passed above), so that branch is unreachable.
    let is_agent = db::sessions::get(&state.pool, name)
        .await?
        .map(|s| s.provider != "shell")
        .unwrap_or(true);
    if !woke && is_agent {
        // NATIVE AUTHORITATIVE refuse. `tpgid == pid` proves the pty is at a BARE
        // SHELL (the login shell is the foreground process group — no agent is
        // running), which is precisely the screen the text guard can be fooled
        // about by stale scrollback. This is a fact from `/proc`, not a heuristic,
        // so it decides outright when available; tmux returns `None` and falls
        // through to the capture-scoped text guard below. A busy turn / permission
        // menu / live composer all have the agent as the foreground program
        // (`Some(false)`), so none of them are caught here.
        if rt.shell_is_foreground().await == Some(true) {
            return Err(AppError::Conflict(format!(
                "session '{name}' is sitting at a bare shell — the agent is not running, so the \
                 message was NOT delivered. Start (or Reset) the session, then resend.",
            )));
        }
        match rt.capture_plain(status::CAPTURE_LINES).await {
            Ok(raw) => {
                if !pty_ready_for_send(&status::prepare_capture(&raw)) {
                    return Err(AppError::Conflict(format!(
                        "session '{name}' is parked at a prompt that is not the agent's — the \
                         message was NOT delivered. Open the terminal: it is likely sitting on a \
                         resume picker or a folder-trust dialog. Dismiss it (or Reset the session), \
                         then resend.",
                    )));
                }
            }
            // FAIL CLOSED. A send guard that cannot read the current screen must
            // NOT type: an undelivered 409 the caller can retry is recoverable, a
            // message typed blindly into whatever is on the pty (a bare shell, a
            // modal) and then reported as delivered is not. So a capture failure
            // refuses rather than falling through to the keystrokes.
            Err(e) => {
                tracing::warn!(session = %name, error = %e, "send guard: capture failed; refusing (fail closed)");
                return Err(AppError::Conflict(format!(
                    "session '{name}' could not be read to confirm it is ready — the message was \
                     NOT delivered. Open the terminal to check its state, then resend.",
                )));
            }
        }
    }

    rt.send_text(text).await?;
    // Backend-declared gap between the text and its submit (see `submit_gap`).
    submit_gap(rt.as_ref()).await;
    rt.send_key("Enter").await?;
    let (preview, at) =
        db::sessions::set_last_send(&state.pool, name, preview_text.unwrap_or(text)).await?;
    broadcast_send(state, name, &preview, at);
    // Record the idempotency key ONLY now that the text is genuinely typed +
    // Entered + stamped: a re-POST with this id is a delivered message and must
    // not be typed again. Still under the per-session lock taken above.
    if let Some(id) = send_id {
        state.send_dedup.record(name, id);
    }
    Ok(())
}

/// THE AUTO-WAKE SEAM — the one place a writer may resurrect a stopped session,
/// and therefore the one place the recovery guards have to live.
///
/// `#81` put two guards on the AUTOMATIC recovery path
/// (`auto_actions::auto_heal`): refuse to restart a claude session whose resume
/// link is provably dead, and believe `start`'s `ready` flag rather than the
/// mere existence of a pane. Its sibling — the auto-wake three lines above — had
/// neither, and EVERY writer reaches the pty through it: `POST
/// /api/sessions/{name}/send`, `POST /api/agents/delegate`, `scheduler::runner`,
/// the board dispatcher, the steering deliver loop. So the exact failure #81
/// closed was still one `/send` away: the heal correctly refused ("auto-heal:
/// skipped"), then a send woke the session anyway, `claude --resume <gone>`
/// printed "No conversation found with session ID: …" and EXITED, and the
/// prompt was typed at the bash prompt left behind ("…: command not found")
/// while the API answered `{ok:true}` and the row went green.
///
/// Two refusals, both 409s with a sentence, because "your message was eaten by a
/// shell" must never be reported as delivery:
///
/// 1. **A dead resume link** ([`auto_actions::dead_resume_link`]) — naming the
///    conversation that is gone, so the next step (start fresh, or pick another
///    conversation) is obvious. A claude row with NO link is not refused: that
///    is an ordinary first send and it loses nothing.
/// 2. **`start().ready == false`** — the pane came back, the agent did not. We
///    do NOT type into it, we re-stamp the `holder_died` badge through
///    [`auto_actions::stamp_heal_failed`] (which also latches the badge against
///    the detector's alive tick), and we return the error.
///
/// The caller then reports UNDELIVERED all the way out: `/send` and `/paste`
/// answer 409, `agents::delegate` never reaches its `record_delegation` (so no
/// delivered edge is written), the scheduler's run is recorded failed, and the
/// chat composer settles its unconfirmed row on the server's sentence instead of
/// promising an arrival.
async fn wake_for_send(state: &AppState, name: &str) -> Result<(), AppError> {
    let s = require_session(state, name).await?;
    if let Some(conv) = super::auto_actions::dead_resume_link(&s) {
        return Err(AppError::Conflict(format!(
            "session '{name}' can't be woken: its Claude conversation '{conv}' is no longer on \
             disk, so starting it would come back as a bare shell wearing the session's name and \
             swallow this message — start it fresh (Reset), or point it at a conversation that \
             still exists",
        )));
    }
    let res = start(state, name, None).await?;
    if !res.ready {
        super::auto_actions::stamp_heal_failed(state, name, &s);
        return Err(AppError::Conflict(format!(
            "session '{name}' was woken but its agent never came up — the message was NOT \
             delivered; open the terminal to see what the session is sitting on",
        )));
    }
    Ok(())
}

/// Send a single named tmux key, enforcing the REST allowlist.
pub async fn send_keys(state: &AppState, name: &str, key: &str) -> Result<(), AppError> {
    if !KEY_ALLOWLIST.contains(key) {
        return Err(AppError::BadRequest(format!("key '{key}' not in allowlist")));
    }
    // See `send_harness_text`: while a login is in flight the pty belongs to the
    // login flow's own writer (`login::submit_code` and friends), which reaches
    // the runtime directly. A stray `Enter` from anywhere else submits a
    // half-typed credential field.
    if super::login::is_frozen(name) {
        return Err(super::login::frozen_error(name));
    }
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;

    if !db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let rt = state.runtime_for(name).await?;
    if !rt.alive().await {
        return Err(AppError::Conflict(format!("session '{name}' is not running")));
    }
    rt.send_key(key).await?;
    Ok(())
}

/// Paste `text` via a tmux buffer (bracketed). When `submit`, append Enter.
///
/// Carries [`send_text`]'s wrapper guard: `POST /api/sessions/{name}/paste` puts
/// caller-supplied bytes on the same pty and into the same transcript, so
/// exempting it would leave the forgery one endpoint away.
pub async fn paste(
    state: &AppState,
    name: &str,
    text: &str,
    submit: bool,
) -> Result<(), AppError> {
    reject_wrapper_markup(text)?;
    if super::login::is_frozen(name) {
        return Err(super::login::frozen_error(name));
    }
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;

    if !db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let rt = state.runtime_for(name).await?;
    if !rt.alive().await {
        return Err(AppError::Conflict(format!("session '{name}' is not running")));
    }
    rt.paste(text, true).await?;
    if submit {
        submit_gap(rt.as_ref()).await;
        rt.send_key("Enter").await?;
    }
    // REDACTION. `last_send_text` is the roster's send preview and it is
    // persisted; a user who pastes an OAuth `code#state` into the generic paste
    // box (the way the flow had to be driven before this feature existed) would
    // otherwise write a live credential into the database and onto every
    // connected client's SSE stream. The mask is applied to what is STORED and
    // broadcast, never to what was written to the pty.
    let stored = super::login::mask_codes(text);
    let (preview, at) = db::sessions::set_last_send(&state.pool, name, &stored).await?;
    broadcast_send(state, name, &preview, at);
    Ok(())
}

/// Capture the last `lines` of scrollback as PLAIN text, ANSI-stripped
/// (read-only — no lock). Empty if the session isn't running.
pub async fn peek(state: &AppState, name: &str, lines: usize) -> Result<String, AppError> {
    peek_capture(state, name, lines, false).await
}

/// Capture the last `lines` of scrollback with their SGR escapes INTACT — the
/// colour-true channel (`GET /peek?ansi=1`). Identical contract to [`peek`]
/// (read-only, no lock, empty when the session isn't running, same clamp); the
/// only difference is `capture_ansi` instead of `capture_plain`.
///
/// Why it exists: a read-only mini-view of what the terminal is actually showing
/// (a permission dialog, a picker) is only faithful in colour — the plain
/// channel renders a colour-coded dialog as flat grey text. Both runtimes
/// implement `capture_ansi` already (`tmux capture-pane -pe` / the native VT
/// grid), so this is a passthrough, not new capture machinery.
pub async fn peek_ansi(state: &AppState, name: &str, lines: usize) -> Result<String, AppError> {
    peek_capture(state, name, lines, true).await
}

/// The shared body of [`peek`] / [`peek_ansi`] — one existence check, one
/// liveness check, one clamp, so the two modes can never drift apart.
async fn peek_capture(
    state: &AppState,
    name: &str,
    lines: usize,
    ansi: bool,
) -> Result<String, AppError> {
    if !db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let rt = state.runtime_for(name).await?;
    if !rt.alive().await {
        return Ok(String::new());
    }
    let lines = lines.clamp(1, 10_000);
    Ok(if ansi {
        // The line cap alone does not bound this channel: the ANSI capture
        // re-emits SGR per run, so `?ansi=1&lines=10000` builds a multi-MB
        // JSON string in memory. Keep the NEWEST bytes — the peek is a tail.
        cap_bytes_from_tail(rt.capture_ansi(lines).await?, MAX_PEEK_BYTES)
    } else {
        cap_bytes_from_tail(rt.capture_plain(lines).await?, MAX_PEEK_BYTES)
    })
}

/// Byte cap for one `/peek` response. Generous next to any real terminal
/// (10 000 rows x 200 cols of plain text is ~2 MB) but finite, so no single
/// request can pin an arbitrary amount of memory.
const MAX_PEEK_BYTES: usize = 4 * 1024 * 1024;

/// Trim `s` to at most `max` bytes, keeping the TAIL and cutting on a line
/// boundary. Line-aligned on purpose: a cut inside an escape sequence would
/// emit a partial SGR. Any style opened before the cut is simply lost, which
/// renders unstyled — never as garbage.
fn cap_bytes_from_tail(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut cut = s.len() - max;
    while cut < s.len() && !s.is_char_boundary(cut) {
        cut += 1;
    }
    match s[cut..].find('\n') {
        Some(nl) => s[cut + nl + 1..].to_string(),
        None => s[cut..].to_string(),
    }
}

/// Archive (async-job-shaped): returns a `job_id` immediately; the
/// scrollback dump + teardown run in the background, completion via SSE `alerts`.
///
/// The DB flip to `archived = 1` and the SSE `sessions` delta announcing the
/// removal both run SYNCHRONOUSLY here — before returning the job id — so that:
///   (a) any subsequent `GET /api/sessions` already filters this row out
///       (db::sessions::list does `WHERE archived = 0`), and
///   (b) every connected client immediately drops the tile from its cached list
///       via the `sessions` SSE delta carrying `archived: true`.
/// Only the scrollback file-write + tmux teardown stay in the spawned task —
/// they don't affect whether the session shows up in the overview.
pub async fn archive(state: &AppState, name: &str) -> Result<String, AppError> {
    if !db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let job_id = uuid::Uuid::new_v4().to_string();

    // SYNCHRONOUS: flip `archived = 1` before returning the response so the
    // very next `GET /api/sessions` excludes this row (the optimistic UI hide
    // can never be re-overwritten by a stale list refetch).
    db::sessions::set_archived(&state.pool, name, true).await?;

    // SYNCHRONOUS: audit row — every destructive HTTP
    // call records a `session.archive` entry. Uses `?` (not `let _ =`) so a
    // failed audit-insert fails the request rather than silently dropping the
    // forensic trail (same pattern as board/mod.rs:401, files/mod.rs:262,
    // scheduler/runner.rs:92, agents/delegate.rs:63).
    db::audit::log(
        &state.pool,
        "user",
        "session.archive",
        name,
        json!({ "job_id": job_id }),
    )
    .await?;

    // SYNCHRONOUS: broadcast a `sessions` delta with `archived: true` so all
    // connected clients drop the tile from their cached list immediately. The
    // frontend's `applyDelta` reads this flag and removes the row.
    let _ = state.sse_tx.send(SseEvent {
        event: "sessions".to_string(),
        company_id: None,
        payload: json!({
            "delta": [{ "name": name, "archived": true }],
        }),
    });

    // R2: the session is now archived (archived = 1 committed above), so any card
    // linked to it just went stale (`session_live` → false). Re-publish the board
    // so open boards swap the live dot for "session archived — reassign?" without
    // a manual refetch. Synchronous + before the spawned teardown so the board
    // reflects the change as promptly as the overview tile does.
    emit_board_if_linked(state, name).await;

    // On-disk team cleanup: park the team's config under
    // `~/.claude/teams/.archived/` so the next scan doesn't surface it. Without
    // this, two teams in the same cwd (e.g. an old archived team + a fresh one
    // started in the same project) BOTH stay in the scanner output and the
    // watcher's cwd_match fallback can wrongly attribute the stale team to the
    // new session's host. Best-effort: missing dir / I/O hiccup logs at debug
    // and never blocks the archive (the team would just keep its ghost
    // visibility until manually swept). The `team_name` backlink is populated
    // by teams::watcher on each successful host-resolution.
    if let Ok(Some(team)) = db::sessions::team_name(&state.pool, name).await {
        if let Err(e) = crate::teams::scan::archive_team_config(&team) {
            tracing::debug!(team = %team, error = %e, "archive: failed to park team config");
        }
        // The team's config is parked, so drop its supermux-side dismissals too so
        // the `dismissed_teammates` table stays bounded to live teams. Best-effort.
        if let Err(e) = db::teams_dismissed::prune_team(&state.pool, &team).await {
            tracing::debug!(team = %team, error = %e, "archive: failed to prune team dismissals");
        }
    }

    // Cascade to the teams watcher so an archived team-lead's TEAM CARD
    // disappears from the overview RIGHT NOW (without waiting up to 30s for
    // the next teams poll). Cheap: the wake is a single Notify ping; the next
    // tick re-scans the now-cleaned `~/.claude/teams/` and the parked team is
    // simply absent.
    state.teams_wake.notify_one();

    let state = state.clone();
    let name = name.to_string();
    let job = job_id.clone();
    tokio::spawn(async move {
        // Runtime seam. Best-effort: an unresolvable runtime dumps an empty
        // archive rather than failing the (already-202'd) job.
        let content = match state.runtime_for(&name).await {
            Ok(rt) if rt.alive().await => rt.capture_full().await.unwrap_or_default(),
            _ => String::new(),
        };

        // Filesystem-bound dump runs on the blocking pool.
        let archive_dir = state.config.data_dir.join("archives");
        let ts = chrono::Utc::now().timestamp();
        let path = archive_dir.join(format!("{name}-{ts}.log"));
        let write_path = path.clone();
        let write_res = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            std::fs::create_dir_all(&archive_dir)?;
            std::fs::write(&write_path, content)?;
            Ok(())
        })
        .await;

        // Definitive teardown through the seam (best-effort — the archive row
        // is already flipped and the job already answered 202).
        if let Ok(rt) = state.runtime_for(&name).await {
            let _ = rt.kill().await;
        }

        // Nudge both per-session background loops to re-check their guard NOW
        // rather than at their next interval (detector: 2s; steering: 60s):
        //   * the detector loop `select!`s on `detector_wake`;
        //   * the steering loop `select!`s on the status watch `changed()`.
        state.wake_detector(&name);
        {
            let tx = state.status_watch_for(&name);
            let cur = tx.borrow().clone();
            // Re-send the current value: `watch::changed()` fires on any send,
            // waking the steering loop so it re-checks `exists_active` and exits.
            tx.send_replace(cur);
        }

        // `forget_session` must be the LAST thing — a still-running loop's
        // `or_insert_with` (`status_watch_for`, `detector_wake_for`, …) would
        // otherwise re-create the very DashMap entries we just dropped. Wait for
        // every per-session loop to actually stop (the task-guard count → 0),
        // THEN forget. Bounded poll so a wedged loop can't block the job
        // forever; the guarantee holds in the normal case.
        for _ in 0..100 {
            if state.live_session_tasks(&name) == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        state.forget_session(&name);

        let detail = match write_res {
            Ok(Ok(())) => format!("archived to {} (job {job})", path.display()),
            _ => format!("archive write failed (job {job})"),
        };
        emit_alert(&state, &name, "info", &detail);
    });

    Ok(job_id)
}

/// Reverse an archive (the overview's "Undo" affordance). Soft-deleted rows keep
/// every column (archive only flips `archived = 1`, never `DELETE`s — see
/// db/sessions.rs:set_archived), so unarchive is a pure mirror of `archive`'s
/// SYNCHRONOUS half:
///   1. flip `archived = 0` so the next `GET /api/sessions` includes the row;
///   2. audit `session.unarchive` (same forensic-trail rule as archive);
///   3. broadcast a `sessions` SSE delta carrying the FULL re-listed row with
///      `archived: false` so every connected tab springs the tile back in
///      live (the client's `applyDelta` appends an unknown-name delta when
///      `allowAdd` is set — `sessions` deltas allow it).
/// There is NO spawned task: archive's background half tore down tmux + dumped
/// scrollback; unarchive only restores overview visibility of the row. The
/// session reads as `stopped` until the user starts it again.
pub async fn unarchive(state: &AppState, name: &str) -> Result<(), AppError> {
    if !db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }

    // SYNCHRONOUS: flip `archived = 0` before returning so the very next
    // `GET /api/sessions` re-includes this row.
    db::sessions::set_archived(&state.pool, name, false).await?;

    // SYNCHRONOUS: audit the reverse op (mirrors the `session.archive` entry).
    db::audit::log(&state.pool, "user", "session.unarchive", name, json!({})).await?;

    // SYNCHRONOUS: broadcast the full re-listed row (archived: false) so every
    // tab re-adds the tile immediately. `super::get` builds the same SessionView
    // the list endpoint serves — so the resurrected tile has its real status,
    // preview, branch, etc., not a stub seeded from a thin delta.
    if let Ok(view) = super::get(state, name).await {
        let mut row = serde_json::to_value(&view).unwrap_or_else(|_| json!({ "name": name }));
        // Belt-and-suspenders: ensure the flag is present + false on the wire so
        // the client's archived-true removal branch never triggers on this row.
        row["archived"] = json!(false);
        let _ = state.sse_tx.send(SseEvent {
            event: "sessions".to_string(),
            company_id: None,
            payload: json!({ "delta": [row] }),
        });
    }

    // R2: un-archiving makes a linked card's session live again (`session_live`
    // → true). Re-publish the board so the card recovers its live dot.
    emit_board_if_linked(state, name).await;

    // Mirror archive's on-disk cleanup: restore the team config from
    // `.archived/` to `teams/` so the next scan surfaces it again. Skips the
    // restore (debug log) when a fresh team has since claimed the same name —
    // the new team wins, the parked copy stays in `.archived/`.
    if let Ok(Some(team)) = db::sessions::team_name(&state.pool, name).await {
        if let Err(e) = crate::teams::scan::restore_team_config(&team) {
            tracing::debug!(team = %team, error = %e, "unarchive: failed to restore team config");
        }
    }

    // Mirror the archive cascade: wake the teams watcher so an un-archived
    // team-lead's TEAM CARD reappears in the overview immediately. The watcher
    // re-scans `~/.claude/teams/` each tick; this wake fires the tick now.
    state.teams_wake.notify_one();

    Ok(())
}

// ── the manual recovery ladder (B5/T8) ──────────────────────────────────────
//
// The AUTOMATIC layer already existed and is good: holder supervision, the
// `auto_heal` reaction with its 10-minute cooldown, and the "Terminal died"
// badge. What did not exist was any way for a HUMAN to act on it. Clients
// composed their own stop+start (and `focus/desktop.tsx` composed it
// *differently* from `use-session-actions.ts`), there was no manual heal at
// all, and no way back from a wedged runtime short of deleting the session.
//
// Three rungs, ordered by WHAT THEY PRESERVE rather than by how drastic they
// sound — that ordering is the whole design, because "restart" and "reset" mean
// nothing to someone deciding under pressure whether they are about to lose a
// conversation:
//
//   | rung           | preserves                          | destroys                    |
//   |----------------|------------------------------------|-----------------------------|
//   | Recover holder | scrollback                         | nothing else                |
//   | Restart        | conversation, worktree, schedules  | live pty + in-memory buffer |
//   | Reset          | worktree, schedules, config        | conversation + scrollback   |
//
// `BRAND.md` §6h carries the same three sentences the UI shows.

/// Rung 2 — **Restart**: stop and start as ONE server-side operation.
///
/// Exists because the client composed it, twice, differently. A composed
/// stop+start also has a window: between the two calls the session is a stopped
/// row that the detector, the auto-healer and any other client can all act on,
/// and a heal landing in that gap races the user's own restart.
///
/// Preserves the conversation (Claude resumes it), the worktree and the
/// schedules. Destroys the live pty and whatever scrollback lived only in it.
pub async fn restart(state: &AppState, name: &str) -> Result<StartResult, AppError> {
    if !db::sessions::exists_active(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    // A stop on an already-stopped session is not an error here: the user asked
    // for the END STATE ("be running again"), and refusing because it was
    // already down would make the button fail exactly when it is most needed.
    if let Err(e) = stop(state, name).await {
        tracing::debug!(name = %name, error = %e, "restart: stop was a no-op or failed; starting anyway");
    }
    start(state, name, None).await
}

/// Rung 1 — **Recover holder**: the manual trigger for `auto_heal`, deliberately
/// bypassing its 10-minute cooldown.
///
/// The cooldown exists to stop the AUTOMATIC layer from fighting a session that
/// dies repeatedly. A human pressing a button is not that loop: they have seen
/// the badge, they know it just tried, and they are asking anyway. Making them
/// wait out a cooldown they cannot see is the worst version of this feature.
///
/// Returns the `Heal` outcome verbatim so the caller can say WHY nothing
/// happened — "auto-heal is off", "this session type cannot be healed" and "it
/// tried and failed" are three different answers, and before B5 all three were
/// a `tracing` line the user never saw.
pub async fn recover_holder(state: &AppState, name: &str) -> Result<super::auto_actions::Heal, AppError> {
    if !db::sessions::exists_active(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    super::auto_actions::clear_heal_cooldown(name);
    Ok(super::auto_actions::auto_heal(state, name, "manual").await)
}

/// Rung 3 — **Reset**: a fresh runtime for a session whose state is wedged.
///
/// Preserves everything the user thinks of as THEIRS — the working directory,
/// the worktree, the branch, the schedules, the config, the session's identity
/// and name. Destroys the conversation link, the scrollback and the activity
/// state.
///
/// The session must be stopped first, and that refusal is deliberate rather
/// than a convenience gap: resetting under a live pty would leave a running
/// agent writing into a runtime row that no longer describes it, and the
/// resulting split-brain is far harder to explain than a 409 telling the user
/// to stop it first.
pub async fn reset(state: &AppState, name: &str) -> Result<(), AppError> {
    if !db::sessions::exists_active(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let rt = state.runtime_for(name).await?;
    if rt.alive().await {
        return Err(AppError::Conflict(format!(
            "session '{name}' is still running — stop it before resetting"
        )));
    }

    let lock = state.lock_for(name);
    let _guard = lock.lock().await;

    // A NEW hook token, not the old one. A reset is the answer to "something
    // about this session's runtime is wrong", and a leaked or stale token is
    // squarely in that set — reusing it would leave the one thing a reset
    // cannot fix.
    let token = uuid::Uuid::new_v4().to_string();
    db::sessions::ensure_runtime(&state.pool, name, &token).await?;
    db::sessions::set_last_status(&state.pool, name, "stopped").await?;
    // Drop the conversation link: the next start begins fresh rather than
    // resuming into whatever state was wedged.
    db::sessions::clear_cc_conversation_id(&state.pool, name).await?;

    // In-memory: the chat ring, the activity snapshot, and every per-session map.
    if let Some(store) = state.chat_store(name) {
        store.reset();
    }
    state.clear_activity(name);
    state.clear_error(name);
    state.clear_permission_request(name);
    state.reset_turn_state(name);
    state.clear_forced_status(name);

    db::audit::log(&state.pool, "user", "session.reset", name, serde_json::json!({})).await?;
    broadcast_status(state, name, "stopped");
    Ok(())
}


// ── mode-shift: switch the permission mode from the UI ────────────────────────

/// The launch flag that activates Claude Code's bypass-permissions mode at boot
/// (mode-shift). `bypassPermissions` is launch-only — a running session cannot
/// enter it via Shift+Tab — so entering bypass is a clean relaunch with this flag
/// (and leaving it strips the flag and resumes). The `--permission-mode <value>`
/// form is the canonical, documented way to set the launch mode and composes with
/// `--resume <id>` so the conversation carries over.
pub(crate) const BYPASS_FLAG: &str = "--permission-mode bypassPermissions";

/// How many Shift+Tabs to send to advance from `from` to `to` around the runtime
/// cycle (`Normal → AcceptEdits → Plan → Normal`). Returns `None` for a target
/// that is not on the cycle (i.e. `Bypass`, handled by relaunch). `0` means we
/// are already there.
fn cycle_steps(from: Mode, to: Mode) -> Option<u8> {
    let idx = |m: Mode| match m {
        Mode::Normal => Some(0u8),
        Mode::AcceptEdits => Some(1),
        Mode::Plan => Some(2),
        Mode::Bypass => None,
    };
    let (f, t) = (idx(from)?, idx(to)?);
    Some((t + 3 - f) % 3)
}

/// Read the session's CURRENT parsed mode from a fresh capture (mode-shift). Read-
/// only — no lock (mirrors the detector rule for `capture-pane`). Falls
/// back to `Normal` when the pane can't be captured.
async fn read_mode(rt: &dyn SessionRuntime) -> Mode {
    match rt.capture_plain(status::CAPTURE_LINES).await {
        Ok(raw) => status::parse_mode(&status::prepare_capture(&raw)),
        Err(_) => Mode::Normal,
    }
}

/// Switch a session's permission mode from the UI (mode-shift).
///
/// * `Normal`/`AcceptEdits`/`Plan` — the runtime cycle: read the live mode, then
///   send Shift+Tab (`BackTab` → CSI Z, the existing wire) ONE STEP AT A TIME,
///   RE-READING the capture after each press and capping retries. This is robust
///   targeting, not blind spamming: a transient bypass-opt-in / auto prompt that
///   mis-seats the cycle is caught by the re-read, and we never over-send. If it
///   can't converge, we return the REAL mode so the UI reflects truth.
/// * `Bypass` — launch-only → a clean RELAUNCH: stop, add [`BYPASS_FLAG`] to the
///   session `flags`, preserve the Claude conversation id so it resumes (mirrors
///   `resume_handler`), start. Leaving bypass (any other target while in bypass)
///   strips the flag and relaunches the same way.
pub async fn set_mode(state: &AppState, name: &str, target: Mode) -> Result<SetModeResult, AppError> {
    let s = require_session(state, name).await?;
    // Mode-shift is a Claude-only affordance (codex/shell have no permission bar).
    if s.provider != "claude" {
        return Err(AppError::BadRequest(
            "mode switching is only available for Claude sessions".into(),
        ));
    }

    let currently_bypass = s.flags.contains(BYPASS_FLAG);

    match target {
        Mode::Bypass => relaunch_for_bypass(state, name, &s, true).await,
        _ => {
            // Leaving bypass requires a relaunch (the flag must be stripped, and a
            // running bypass session can't be cycled out of it via Shift+Tab).
            if currently_bypass {
                return relaunch_for_bypass(state, name, &s, false).await.map(|mut r| {
                    // After the strip-and-resume the session boots in Normal; if the
                    // user asked for AcceptEdits/Plan they can pick again (one extra
                    // click only for the rarer leave-bypass-into-a-cycle-mode path).
                    r.mode = Mode::Normal.as_str().to_string();
                    r.converged = matches!(target, Mode::Normal);
                    r
                });
            }
            cycle_to(state, name, target).await
        }
    }
}

/// The Shift+Tab targeting cycle (mode-shift). Reads the live mode, then advances
/// one press at a time toward `target`, re-reading after each press. Capped so a
/// stuck cycle can never loop forever. Returns the REAL mode it ended on.
async fn cycle_to(state: &AppState, name: &str, target: Mode) -> Result<SetModeResult, AppError> {
    let rt = state.runtime_for(name).await?;
    if !rt.alive().await {
        return Err(AppError::Conflict(format!(
            "session '{name}' is not running — start it before switching mode"
        )));
    }

    // At most 4 presses: a 3-mode ring needs ≤2 to reach any target, +2 slack for
    // a transient prompt that mis-seats a press (robust, never blind-spam).
    const MAX_PRESSES: u8 = 4;
    let mut current = read_mode(rt.as_ref()).await;
    let mut presses = 0u8;
    while current != target && presses < MAX_PRESSES {
        // Guard: if the live mode ever reads Bypass here, the cycle can't reach a
        // runtime target — bail with the truth rather than spam.
        if current == Mode::Bypass {
            break;
        }
        // Only press when a forward step is actually warranted (the re-read may
        // have already advanced us, e.g. a racing user keystroke).
        match cycle_steps(current, target) {
            Some(0) => break,
            Some(_) => {
                let lock = state.lock_for(name);
                let guard = lock.lock().await;
                rt.send_key("BTab").await?;
                drop(guard);
                presses += 1;
                // Let the status bar repaint before re-reading (it updates within
                // a frame or two; the detector cadence is slower so we read here).
                tokio::time::sleep(Duration::from_millis(250)).await;
                current = read_mode(rt.as_ref()).await;
            }
            None => break, // target not on the cycle (shouldn't happen — Bypass handled above)
        }
    }

    // Persist + broadcast the freshly-observed mode so the menu reflects truth
    // immediately (the detector loop would also pick it up on its next tick, but
    // this makes the radio flip sub-second).
    broadcast_mode(state, name, current);

    Ok(SetModeResult {
        name: name.to_string(),
        mode: current.as_str().to_string(),
        converged: current == target,
        relaunched: false,
    })
}

/// Bypass enter/leave via a clean relaunch (mode-shift). Mirrors `resume_handler`:
/// stop → toggle [`BYPASS_FLAG`] in `flags` → preserve the Claude conversation id
/// so `--resume` carries the chat → start. `enter` adds the flag; `!enter` strips
/// it.
async fn relaunch_for_bypass(
    state: &AppState,
    name: &str,
    s: &Session,
    enter: bool,
) -> Result<SetModeResult, AppError> {
    // 1. Compute the new flags string (add or strip the bypass flag; trim doubled
    //    whitespace so repeated toggles never accumulate blanks).
    let flags = if enter {
        if s.flags.contains(BYPASS_FLAG) {
            s.flags.clone()
        } else {
            format!("{} {BYPASS_FLAG}", s.flags).trim().to_string()
        }
    } else {
        s.flags.replace(BYPASS_FLAG, "")
    };
    let flags = flags.split_whitespace().collect::<Vec<_>>().join(" ");

    // 2. Preserve the Claude conversation id so the relaunch RESUMES (mirrors
    //    resume_handler). Prefer the named session, else the conversation id; if
    //    neither is set the session simply boots fresh under the new mode.
    let resume_id = if !s.cc_session_name.is_empty() {
        Some(s.cc_session_name.clone())
    } else if !s.cc_conversation_id.is_empty() {
        Some(s.cc_conversation_id.clone())
    } else {
        None
    };

    // 3. Stop the running agent (best-effort: a not-running session just starts).
    if let Ok(rt) = state.runtime_for(name).await {
        if rt.alive().await {
            stop(state, name).await?;
        }
    }

    // 4. Apply the flags + (re-)seed the resume id, then start. set_cc_conversation_id
    //    clears cc_session_name, so re-seed it explicitly when that was the resume
    //    handle (keeps `--resume <name>` semantics intact).
    db::sessions::set_flags(&state.pool, name, &flags).await?;
    if let Some(id) = resume_id.as_deref() {
        db::sessions::set_cc_conversation_id(&state.pool, name, id).await?;
    }
    start(state, name, None).await?;

    let mode = if enter { Mode::Bypass } else { Mode::Normal };
    broadcast_mode(state, name, mode);

    Ok(SetModeResult {
        name: name.to_string(),
        mode: mode.as_str().to_string(),
        converged: true,
        relaunched: true,
    })
}

/// Broadcast a `sessions` SSE delta carrying the new `mode` so every open tab's
/// ⋯ menu live-checks the right radio immediately (mode-shift). Best-effort.
fn broadcast_mode(state: &AppState, name: &str, mode: Mode) {
    let _ = state.sse_tx.send(SseEvent {
        event: "sessions".to_string(),
        company_id: None,
        payload: json!({ "delta": [{ "name": name, "mode": mode.as_str() }] }),
    });
}


// ── REST send_keys allowlist ─────────────────────────────────────────────────

static KEY_ALLOWLIST: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    let mut s: HashSet<&'static str> = [
        "Enter", "Escape", "Tab", "BTab", "Space", "BSpace", "Up", "Down", "Left", "Right",
        "Home", "End", "PageUp", "PageDown", "IC", "DC", "C-c", "C-d", "C-z", "C-l", "C-a",
        "C-e", "C-k", "C-u", "C-r", "C-p", "C-n", "C-b", "C-f", "C-w", "M-b", "M-f", "M-d", "y",
        "n", "q",
    ]
    .into_iter()
    .collect();
    for f in [
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    ] {
        s.insert(f);
    }
    s
});

#[cfg(test)]
mod agent_ready_heuristics_tests {
    //! The capture-scan heuristics that drive `wait_for_agent_ready` are pure
    //! string predicates, so the trust-dialog / resume-picker / UI-visible
    //! detection is unit-tested directly (no real tmux needed).
    use super::*;

    #[test]
    fn detects_claude_trust_dialog() {
        // Verbatim shape of Claude's first-run workspace-trust prompt.
        let cap = "Accessing workspace:\n /opt/projects/supermux\n Quick safety check: \
                   Is this a project you created or one you trust?\n \
                   ❯ 1. Yes, I trust this folder\n   2. No, exit";
        assert!(at_trust_dialog(cap), "must catch the trust dialog");
        // The trust dialog is NOT the agent UI — yet the `❯` menu cursor means a
        // naive `agent_ui_visible` ready-check ALSO fires on this very capture.
        // That collision is exactly why `wait_for_agent_ready` must check the trust
        // gate BEFORE readiness: otherwise the session is declared ready with the
        // modal up, the dispatched task is sent into it, and the detector reads the
        // `❯ 1.` menu as WAITING. Pin both predicates so a future edit can't
        // silently reintroduce the ordering hazard.
        assert!(
            agent_ui_visible(cap),
            "the ❯ menu cursor trips agent_ui_visible — trust MUST be handled first",
        );
    }

    #[test]
    fn trust_dialog_does_not_false_positive_on_normal_ui() {
        let normal = "❯ Try \"fix type check errors\"\n  ⏵⏵ bypass permissions on";
        assert!(!at_trust_dialog(normal));
        assert!(agent_ui_visible(normal));
        // Resume picker is distinct from the trust dialog.
        assert!(!at_trust_dialog("Resume a conversation"));
    }

    #[test]
    fn detects_resume_picker_and_ui() {
        assert!(at_resume_picker("Select a session to resume"));
        assert!(agent_ui_visible("? for shortcuts"));
        assert!(!at_resume_picker("Yes, I trust this folder"));
    }

    /// THE resume-reliability fix: on an INTENDED resume we must never escape the
    /// picker (+ `clear_cc`). Escaping abandons the exact conversation the user
    /// asked to continue and `clear_cc` permanently wipes the resume handle, so a
    /// later Start/Resume can't resume it either — the "Resume doesn't always work"
    /// bug. The escape stays armed only for a FRESH start (anti-hang), one-shot.
    #[test]
    fn intended_resume_never_escapes_the_picker() {
        let picker = "Resume a conversation\n❯ 1. Fix the parser  2h ago";
        // Intended resume: NEVER escape, no matter the capture.
        assert!(!should_escape_resume_picker(picker, true, false));
        // A resumed transcript whose scrollback merely MENTIONS the picker phrase
        // must not trip the destructive fallback either (the false-positive path).
        assert!(!should_escape_resume_picker(
            "…as we discussed, select a session to resume later\n❯ ",
            true,
            false,
        ));
    }

    #[test]
    fn fresh_start_escapes_a_stale_picker_once() {
        let picker = "Select a session to resume\n❯ 1. old chat";
        // Fresh start (not resume-intended): a stale picker IS escaped, once.
        assert!(should_escape_resume_picker(picker, false, false));
        // One-shot: after we've escaped, don't spam the fallback on later ticks.
        assert!(!should_escape_resume_picker(picker, false, true));
        // Normal agent UI is never mistaken for the picker.
        assert!(!should_escape_resume_picker("❯ Try \"fix tests\"", false, false));
    }

    /// REGRESSION (codex #1, CRITICAL). A resume picker left open on an INTENDED
    /// resume must classify `Wait`, NEVER `Ready` — even though its `❯` cursor
    /// makes `agent_ui_visible` true. Reporting it ready is what let a stale
    /// `--resume` park at the picker, be recorded as a successful heal (clearing
    /// `holder_died`), and have the next send typed + Enter'd straight INTO the
    /// modal and logged as delivered.
    #[test]
    fn a_resume_picker_left_open_is_never_ready() {
        let picker = "Resume a conversation\n❯ 1. Fix the parser  2h ago\n  2. Older chat";
        // The exact honest-state hazard: intended resume, picker still up.
        assert!(
            agent_ui_visible(picker),
            "precondition: the picker's ❯ cursor DOES trip the bare glyph check — \
             which is why keying readiness on it was the bug",
        );
        assert_eq!(
            classify_ready_tick(picker, /*resume_intended*/ true, /*escaped*/ false, /*trusted*/ false),
            ReadyTick::Wait,
            "a picker we deliberately do not escape must keep the ready-poll WAITING, \
             so the heal times out to ready=false (a FAILED heal), not a false success",
        );
        // The trust dialog is the sibling boot modal: also `❯`, also not ready.
        let trust = "Quick safety check: do you trust the files in this folder?\n❯ 1. Yes";
        assert_eq!(
            classify_ready_tick(trust, true, false, false),
            ReadyTick::AcceptTrust,
            "trust dialog is dismissed, not treated as ready",
        );
        // A real composer prompt (no modal) is the ONLY thing that reads Ready.
        assert_eq!(
            classify_ready_tick("❯ Try \"fix tests\"\n  ⏵⏵ bypass permissions on", true, false, false),
            ReadyTick::Ready,
            "the agent's own prompt, with no boot modal over it, is ready",
        );
    }

    /// A FRESH (not resume-intended) stale picker is escaped ONCE, then — once the
    /// escape has been issued (`escaped=true`) but the picker capture has not yet
    /// re-rendered — must still `Wait`, not fall through to `Ready` on the same
    /// menu still showing `❯`.
    #[test]
    fn a_fresh_stale_picker_escapes_then_waits_not_ready() {
        let picker = "Select a session to resume\n❯ 1. old chat";
        assert_eq!(
            classify_ready_tick(picker, false, false, false),
            ReadyTick::EscapePicker,
        );
        assert_eq!(
            classify_ready_tick(picker, false, /*escaped*/ true, false),
            ReadyTick::Wait,
            "after the one-shot escape, the still-visible menu must not read Ready",
        );
    }

    /// The SEND-path guard (codex #1, wave-7): decide, from the CURRENT capture
    /// alone, whether `send_harness_text` may type into the pty. The picker and
    /// trust dialog — the exact screens an already-awake retry used to be typed
    /// into — must refuse; a live composer, a permission menu, and a busy turn
    /// must all still be typeable.
    #[test]
    fn pty_ready_for_send_refuses_boot_modals_but_admits_prompt_and_busy() {
        // REFUSE — the two boot modals that draw `❯` without an agent behind them.
        let picker = "Resume a conversation\n❯ 1. Fix the parser  2h ago\n  2. Older chat";
        assert!(
            !pty_ready_for_send(picker),
            "a retry while parked at the resume picker must NOT be typed (it would be \
             swallowed by the modal and falsely reported delivered)",
        );
        let trust = "Quick safety check: do you trust the files in this folder?\n❯ 1. Yes";
        assert!(
            !pty_ready_for_send(trust),
            "the folder-trust dialog is the sibling boot modal — also not typeable",
        );
        // REFUSE — a bare shell the agent exited to (no ❯/❱, no busy footer).
        assert!(
            !pty_ready_for_send("user@host project % \n"),
            "a bare shell the agent exited to would eat the message — refuse",
        );

        // ADMIT — the agent's own composer prompt with no boot modal over it.
        assert!(
            pty_ready_for_send("❯ Try \"fix tests\"\n  ? for shortcuts"),
            "the agent's own idle prompt is the send target",
        );
        // ADMIT — a permission menu IS the agent waiting on the user; answering it
        // (typing a choice) must stay unchanged, so this is deliberately typeable.
        assert!(
            pty_ready_for_send("Do you want to proceed?\n❯ 1. Yes\n  2. No"),
            "a permission menu is the agent at the wheel — still typeable (unchanged)",
        );
        // ADMIT — a busy turn: the send is a legitimate QUEUE, and the composer
        // glyph may have scrolled out of a short capture, so `esc to interrupt`
        // carries the decision.
        assert!(
            pty_ready_for_send("✻ Thinking… (esc to interrupt · 12s · ↑ 2.1k tokens)"),
            "a send while the agent is mid-turn is a queue, not a swallow",
        );
    }

    /// CURRENT-SCREEN scoping (wave-8, codex pass 3). A capture whose VIEWPORT is
    /// a bare shell the agent exited to, but whose SCROLLBACK still carries an
    /// OLDER `❯` composer AND an OLDER `esc to interrupt` footer, must REFUSE — the
    /// stale glyphs are not the screen we are about to type into. Before the fix
    /// `pty_ready_for_send` searched the whole capture and admitted this, so the
    /// retry was typed into the bare shell.
    #[test]
    fn pty_ready_for_send_ignores_stale_scrollback_above_a_bare_shell() {
        let mut screen = String::new();
        // Scrollback: the agent's last render before it exited — both glyphs.
        screen.push_str("✻ Thinking… (esc to interrupt · 8s · ↑ 1.2k tokens)\n");
        screen.push_str("❯ the previous composer line\n");
        screen.push_str("  ? for shortcuts\n");
        // A band of the agent's final output / blanks, pushing the glyphs well
        // above the current screen tail.
        for i in 0..14 {
            screen.push_str(&format!("  done step {i}\n"));
        }
        // Viewport bottom: a bare shell prompt, the agent gone.
        screen.push_str("user@host project % \n");

        assert!(
            !pty_ready_for_send(&screen),
            "an OLD ❯/esc-to-interrupt scrolled up above a bare shell must NOT satisfy the \
             send guard — the current screen is a bare shell that would eat the message",
        );

        // CONTROL: the SAME kind of history, but the current screen tail IS a live
        // composer — still delivers. Proves the scoping refuses on the bottom, not
        // on the mere presence of history.
        let mut live = String::new();
        for i in 0..14 {
            live.push_str(&format!("  done step {i}\n"));
        }
        live.push_str("❯ Try \"fix tests\"\n  ? for shortcuts\n");
        assert!(
            pty_ready_for_send(&live),
            "a live composer at the bottom of the current screen still delivers",
        );
    }

    /// FIX 2 (a). A ready, EMPTY Codex composer — `›` cursor + the placeholder
    /// "Ask Codex to do anything" + the model footer — must be SENDABLE. Codex
    /// draws `›` (U+203A) not Claude's `❯`, so before the fix the send guard was
    /// blind to it and 409'd every send/delegate to an awake, idle Codex.
    #[test]
    fn codex_idle_composer_is_ready_for_send() {
        let composer = "› Ask Codex to do anything\n  gpt-5.6-sol high · /opt/projects/Folderwijzer-codex";
        assert!(
            pty_ready_for_send(composer),
            "an idle Codex composer (`›` + Ask-Codex placeholder + model footer) is a \
             ready send target — the delegate/#2 regression",
        );
        // The model footer ALONE (placeholder scrolled out of a short tail) still
        // reads ready — it is a signal a picker/trust dialog never shows.
        assert!(
            pty_ready_for_send("  gpt-5.6-sol high · /opt/projects/Folderwijzer-codex"),
            "the Codex composer model footer alone is enough to read ready",
        );
    }

    /// FIX 2 (b). A Codex `› N.` NUMBERED selector (CODEX_WAITING_BANK) must stay
    /// GUARDED — the bare `›` is not admitted, so a selector/approval never reads
    /// as a ready composer even though it shares Codex's cursor glyph.
    #[test]
    fn codex_numbered_selector_is_not_ready_for_send() {
        let selector = "Do you want to run this command?\n› 1. Yes, run it\n  2. No, keep chatting";
        assert!(
            !pty_ready_for_send(selector),
            "a Codex `› N.` numbered selector is a waiting prompt — MUST NOT be typed into",
        );
    }

    /// FIX 3 (c). A Codex resume picker must be NOT ready (no injected prompt) AND
    /// recognised by `at_resume_picker` so `should_escape_resume_picker` can
    /// escape a genuinely-stuck one on a fresh, non-resume-intended start.
    #[test]
    fn codex_resume_picker_is_guarded_and_escapable() {
        let picker = "Resume a previous session\n› 1. Fix the parser   2h ago\n  2. Older chat   1d ago";
        assert!(
            at_resume_picker(picker),
            "a Codex resume picker header must be visible to the escape path (FIX 3)",
        );
        assert!(
            !pty_ready_for_send(picker),
            "a Codex resume picker still receives NO typed prompt",
        );
        // Escapable only on a fresh, non-resume-intended start; an INTENDED resume
        // is never auto-escaped.
        assert!(
            should_escape_resume_picker(picker, false, false),
            "a stuck Codex picker on a non-resume start is escapable",
        );
        assert!(
            !should_escape_resume_picker(picker, true, false),
            "an INTENDED Codex resume is never auto-escaped",
        );
    }

    /// FIX 3 (d). A real folder-trust dialog is still NOT ready — the Codex-ready
    /// predicate keys on composer markers a trust gate never shows, so it never
    /// admits an injected prompt into the trust dialog.
    #[test]
    fn codex_trust_dialog_still_receives_no_injection() {
        let trust = "Do you trust the files in this folder?\n› 1. Yes, I trust\n  2. No";
        assert!(
            !pty_ready_for_send(trust),
            "a folder-trust dialog must still be refused a typed prompt",
        );
    }

    /// FIX 2 (e). Claude's idle `❯` composer is UNCHANGED by the Codex additions —
    /// still ready for send.
    #[test]
    fn claude_idle_composer_still_ready_after_codex_fix() {
        assert!(
            pty_ready_for_send("❯ Try \"fix tests\"\n  ? for shortcuts"),
            "the Claude idle composer must remain a ready send target (unchanged)",
        );
    }
}

#[cfg(test)]
mod build_env_tests {
    //! `build_env` injects the per-pane tmux environment. These pin the two
    //! Claude-only escape hatches that fix browser-terminal regressions:
    //! synchronized output (torn frames) and inline rendering / disabled
    //! alternate-screen (so the browser terminal keeps a native scrollback for
    //! wheel + touch + drag-select).
    use super::*;

    fn cfg() -> crate::config::Config {
        crate::config::Config {
            data_dir: std::env::temp_dir(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "t".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        }
    }

    /// The startup scrub, which is what makes the TMUX and hook-curl spawn
    /// paths clean too (the native one enforces the same rule at the spawn).
    ///
    /// Serialised on the process-wide test lock: it mutates the environment.
    #[tokio::test]
    async fn the_startup_scrub_drops_inherited_nesting_markers_and_nothing_else() {
        let _serial = crate::sessions::native::test_serial().await;
        // A daemon started from inside a Claude Code pane.
        for key in AGENT_NESTING_ENV {
            std::env::set_var(key, "1");
        }
        // Something supermux itself sets per pane — must survive.
        std::env::set_var("CLAUDE_CODE_FORCE_SYNC_OUTPUT", "1");

        let mut removed = scrub_inherited_agent_env();
        removed.sort_unstable();
        let mut expected = AGENT_NESTING_ENV.to_vec();
        expected.sort_unstable();
        assert_eq!(removed, expected, "the scrub must report what it removed");

        for key in AGENT_NESTING_ENV {
            assert!(
                std::env::var_os(key).is_none(),
                "{key} survived the scrub — every pane would inherit it",
            );
        }
        assert!(
            std::env::var_os("CLAUDE_CODE_FORCE_SYNC_OUTPUT").is_some(),
            "the scrub must not touch supermux's own CLAUDE_CODE_* injections",
        );
        // Idempotent, and honest about a clean environment.
        assert!(scrub_inherited_agent_env().is_empty());
        std::env::remove_var("CLAUDE_CODE_FORCE_SYNC_OUTPUT");
    }

    /// `build_env`'s own injections must never overlap the scrub list, or the
    /// scrub would silently disarm a per-pane escape hatch.
    #[test]
    fn the_scrub_list_and_the_injected_env_are_disjoint() {
        let env = build_env(&cfg(), "s", "tok", "claude", true, None);
        for key in AGENT_NESTING_ENV {
            assert!(
                !env.contains_key(*key),
                "{key} is both injected and scrubbed — pick one",
            );
        }
    }

    /// SRV-01 — the transcript guarantee has TWO halves and only both together
    /// make "a supermux-spawned Claude always writes a `.jsonl`" true:
    ///
    ///   1. NEGATIVE — the eight [`AGENT_NESTING_ENV`] markers are scrubbed from
    ///      the daemon's own environ, so a supermux started by hand from inside a
    ///      Claude pane stops handing every child a `CLAUDE_CODE_CHILD_SESSION`.
    ///   2. POSITIVE — every Claude pane exports
    ///      `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, which also covers the two
    ///      cases the scrub cannot see: a user who turned persistence off in
    ///      their own profile, and a marker that lands in the environ after the
    ///      one-shot startup scrub.
    ///
    /// Half two is what was missing on origin/main. Without a transcript the
    /// whole chat plane (tailer, recall, renderer) reads an empty conversation
    /// for a session that is visibly working, and Claude says so exactly once, in
    /// one dim line: "⚠ Transcript saving is off … restart with
    /// CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1".
    #[test]
    fn both_halves_of_the_transcript_guarantee_are_wired() {
        // Half 1: the marker Claude actually names is on the scrub list.
        assert!(
            AGENT_NESTING_ENV.contains(&"CLAUDE_CODE_CHILD_SESSION"),
            "the inherited-marker half must stay listed",
        );
        assert_eq!(AGENT_NESTING_ENV.len(), 8, "the scrub list is the eight markers");

        // Half 2: every Claude pane forces persistence on.
        let env = build_env(&cfg(), "s", "tok", "claude", false, None);
        assert_eq!(
            env.get("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE").map(String::as_str),
            Some("1"),
            "a supermux-spawned Claude must always write a transcript",
        );
        // A legacy/unknown non-shell row falls through to CLAUDE in
        // `build_launch_command`, so it needs the Claude env too.
        let legacy = build_env(&cfg(), "s", "tok", "legacy-agent", false, None);
        assert_eq!(
            legacy.get("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE").map(String::as_str),
            Some("1"),
            "the launch fallback boots claude for unknown providers — same env",
        );
        // …and the providers that never launch `claude` do not get it.
        for provider in ["codex", "shell", "kimi"] {
            let other = build_env(&cfg(), "s", "tok", provider, false, None);
            assert!(
                !other.contains_key("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"),
                "{provider} does not launch claude — no Claude-only env",
            );
        }
    }

    #[test]
    fn renders_claude_in_the_normal_buffer() {
        // Regression guard: Claude Code is a full-screen TUI in the ALTERNATE
        // screen, which has no scrollback — so the browser terminal cannot scroll
        // natively (a wheel event there even cycles prompt-history). Injecting
        // CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 makes Claude render inline in the
        // normal buffer so xterm keeps a real scrollback (only Claude reads it;
        // codex/shell ignore it, same as the FORCE_SYNC sibling).
        let env = build_env(&cfg(), "s", "tok", "claude", false, None);
        assert_eq!(
            env.get("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN").map(String::as_str),
            Some("1"),
            "must render Claude inline so the browser terminal has native scrollback",
        );
        // Sibling escape hatch stays put.
        assert_eq!(
            env.get("CLAUDE_CODE_FORCE_SYNC_OUTPUT").map(String::as_str),
            Some("1"),
        );
    }

    #[test]
    fn codex_launch_uses_its_binary_defaults_and_inline_terminal() {
        let mut config = cfg();
        config.provider_defaults.codex_flags = "--model gpt-5-codex".into();
        let session = Session {
            name: "codex-worker".into(),
            display_name: "Codex worker".into(),
            dir: "/tmp".into(),
            desc: String::new(),
            provider: "codex".into(),
            flags: "--ask-for-approval never".into(),
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
            runtime: "tmux".into(),
            notif: "inherit".into(),
            seen_ts: None,
            seen_count: None,
            seen_epoch: None,
            model: String::new(),
            memory: String::new(),
            skills: "[]".into(),
            role_id: None,
        };

        let (command, resume_intended) = build_launch_command(&config, &session, &[]);
        // Per-session flags go through the SEC-01 escaper, which leaves ordinary
        // flag words alone — the rendered line is byte-identical to before.
        let invocation = "codex --no-alt-screen --model gpt-5-codex --ask-for-approval never";
        assert!(command.contains("https://chatgpt.com/codex/install.sh"));
        assert!(command.contains("CODEX_NON_INTERACTIVE=1"));
        assert!(command.contains("codex login status >/dev/null 2>&1"));
        assert!(command.contains("codex login --device-auth"));
        assert_eq!(command.matches(invocation).count(), 2);
        assert!(!command.contains("claude"));
        // Codex never carries a supermux `--resume`, so it is NEVER a resume-intended
        // launch — the picker-escape anti-hang stays armed for it (a fresh start).
        assert!(!resume_intended, "codex launch must not be resume-intended");
        assert!(!command.contains("--resume"));
    }

    /// `resume_intended` mirrors whether the Claude launch actually carries
    /// `--resume` — the single source of truth `wait_for_agent_ready` reads to
    /// decide the picker-escape is safe. A cc_session_name OR a cc_conversation_id
    /// makes it a resume; a bare `--name` launch does not.
    #[test]
    fn claude_resume_intended_tracks_the_resume_flag() {
        let config = cfg();
        let base = Session {
            name: "worker".into(),
            display_name: "Worker".into(),
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
            runtime: "tmux".into(),
            notif: "inherit".into(),
            seen_ts: None,
            seen_count: None,
            seen_epoch: None,
            model: String::new(),
            memory: String::new(),
            skills: "[]".into(),
            role_id: None,
        };

        // Fresh: no cc handles → `--name`, not resume-intended.
        let (cmd, resume) = build_launch_command(&config, &base, &[]);
        assert!(cmd.contains("--name worker"));
        assert!(!cmd.contains("--resume"));
        assert!(!resume);

        // A persisted conversation id → `--resume '<id>'`, resume-intended.
        let by_id = Session { cc_conversation_id: "abc-123".into(), ..base.clone() };
        let (cmd, resume) = build_launch_command(&config, &by_id, &[]);
        assert!(cmd.contains("--resume 'abc-123'"));
        assert!(resume);

        // A named session takes precedence and is likewise resume-intended.
        let by_name = Session {
            cc_session_name: "my-chat".into(),
            cc_conversation_id: "abc-123".into(),
            ..base
        };
        let (cmd, resume) = build_launch_command(&config, &by_name, &[]);
        assert!(cmd.contains("--resume 'my-chat'"));
        assert!(resume);
    }

    #[test]
    fn codex_bootstrap_is_valid_shell() {
        let config = cfg();
        let session = Session {
            name: "codex-shell-check".into(),
            display_name: "Codex shell check".into(),
            dir: "/tmp".into(),
            desc: String::new(),
            provider: "codex".into(),
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
            runtime: "tmux".into(),
            notif: "inherit".into(),
            seen_ts: None,
            seen_count: None,
            seen_epoch: None,
            model: String::new(),
            memory: String::new(),
            skills: "[]".into(),
            role_id: None,
        };

        let (command, _resume) = build_launch_command(&config, &session, &[]);
        let status = std::process::Command::new("bash")
            .args(["-n", "-c", &command])
            .status()
            .expect("bash must be available to validate the launch command");
        assert!(status.success(), "generated Codex bootstrap must parse as shell");
    }

    // ── bot identity (migration 0030): role/notes/model injection ────────────

    /// The MODEL allowlist maps a selection to a real id per provider and rejects
    /// anything else — the guard that keeps free text off the launch line.
    #[test]
    fn model_allowlist_maps_known_and_rejects_unknown() {
        assert_eq!(resolve_model_flag("claude", "opus"), Ok(Some("opus")));
        assert_eq!(resolve_model_flag("claude", "sonnet"), Ok(Some("sonnet")));
        assert_eq!(resolve_model_flag("codex", "gpt-5-codex"), Ok(Some("gpt-5-codex")));
        // Empty = provider default (no injection).
        assert_eq!(resolve_model_flag("claude", ""), Ok(None));
        assert_eq!(resolve_model_flag("claude", "   "), Ok(None));
        // A claude model asked of codex (and vice-versa) is refused, not silently
        // accepted — the allowlist is per-provider.
        assert!(resolve_model_flag("claude", "gpt-5-codex").is_err());
        assert!(resolve_model_flag("codex", "opus").is_err());
        // Junk / shell-meta never maps.
        assert!(resolve_model_flag("claude", "opus; rm -rf /").is_err());
        assert!(resolve_model_flag("shell", "opus").is_err());
    }

    /// THE KEY NEW BEHAVIOUR: a non-empty role (`desc`) and the bot's notes
    /// (`memory`) are injected into Claude's system prompt via
    /// `--append-system-prompt`, and the model column lands as `--model <id>`.
    #[test]
    fn role_notes_and_model_inject_into_the_claude_launch_line() {
        let config = cfg();
        let mut s = claude_session("bot", "");
        s.desc = "You are a meticulous code reviewer.".into();
        s.memory = "The build is debug-only; never run cargo --release.".into();
        s.model = "opus".into();

        let (cmd, _resume) = build_launch_command(&config, &s, &[]);
        // Role + notes ride ONE `--append-system-prompt` word.
        assert!(cmd.contains("--append-system-prompt"), "cmd: {cmd}");
        assert!(cmd.contains("meticulous code reviewer"), "role missing: {cmd}");
        assert!(cmd.contains("Notes you keep:"), "notes delimiter missing: {cmd}");
        assert!(cmd.contains("never run cargo --release"), "notes body missing: {cmd}");
        // Model column → validated `--model opus`.
        assert!(cmd.contains("--model opus"), "model missing: {cmd}");

        // CONNECTOR-STORE COEXISTENCE: role injection consumes only its own
        // `--append-system-prompt` slot and leaves `--mcp-config` free for the
        // later connector-store work to sit beside it.
        assert!(!cmd.contains("--mcp-config"), "must not pre-empt the connector slot");
    }

    /// A session with neither role nor notes injects NO system prompt — the launch
    /// line is unchanged for the whole pre-0030 fleet.
    #[test]
    fn no_role_no_notes_means_no_system_prompt_injection() {
        let config = cfg();
        let s = claude_session("plain", "");
        let (cmd, _resume) = build_launch_command(&config, &s, &[]);
        assert!(!cmd.contains("--append-system-prompt"), "cmd: {cmd}");
        assert!(!cmd.contains("--model"), "no model column → no --model: {cmd}");
    }

    /// A poisoned/legacy model column value is DROPPED at launch (re-resolved
    /// through the allowlist), never shell-injected.
    #[test]
    fn a_junk_model_column_is_not_injected() {
        let config = cfg();
        let mut s = claude_session("legacy", "");
        s.model = "totally-made-up".into();
        let (cmd, _resume) = build_launch_command(&config, &s, &[]);
        assert!(!cmd.contains("--model"), "an unmappable model must be dropped: {cmd}");
    }

    /// The composed launch line still parses as shell with role/notes/model on it
    /// (the escaping holds for a system prompt full of spaces and shell-meta).
    #[test]
    fn role_injected_claude_launch_is_valid_shell() {
        let config = cfg();
        let mut s = claude_session("shellcheck", "");
        s.desc = "Mind the $PATH; use \"quotes\" & `ticks` — carefully.".into();
        s.memory = "Rule: don't `rm -rf`.".into();
        s.model = "sonnet".into();
        let (command, _resume) = build_launch_command(&config, &s, &[]);
        let status = std::process::Command::new("bash")
            .args(["-n", "-c", &command])
            .status()
            .expect("bash must be available to validate the launch command");
        assert!(status.success(), "role-injected launch must parse as shell: {command}");
    }

    /// Connector scoping COMPOSES with role/notes (migration 0031): a session
    /// with both a role AND connector flags emits BOTH the role's
    /// `--append-system-prompt` pair and the connector's `--mcp-config …
    /// --strict-mcp-config` pair — neither clobbers the other, and the whole line
    /// still parses as shell.
    #[test]
    fn connector_flags_compose_with_role_notes() {
        let config = cfg();
        let mut s = claude_session("compose", "");
        s.desc = "You are the mail bot.".into();
        s.memory = "Never delete a thread.".into();
        let mcp_flags = vec![
            "--mcp-config".to_string(),
            r#"{"mcpServers":{"icloud-mail":{"command":"python","args":["s.py"]}}}"#.to_string(),
            "--strict-mcp-config".to_string(),
        ];
        let (command, _resume) = build_launch_command(&config, &s, &mcp_flags);
        // BOTH flag pairs present.
        assert!(command.contains("--append-system-prompt"), "role flag missing: {command}");
        assert!(command.contains("--mcp-config"), "connector flag missing: {command}");
        assert!(command.contains("--strict-mcp-config"), "strict flag missing: {command}");
        assert!(command.contains("icloud-mail"), "inline mcp config missing: {command}");
        // The role's system prompt survived intact.
        assert!(command.contains("You are the mail bot."), "role text missing: {command}");
        // And the composed line is still valid shell (the inline JSON is quoted).
        let status = std::process::Command::new("bash")
            .args(["-n", "-c", &command])
            .status()
            .expect("bash must be available to validate the launch command");
        assert!(status.success(), "composed launch must parse as shell: {command}");
    }

    /// The CORE (always-loaded) notes index is HARD-CAPPED (audit gap 4): a bot
    /// whose `memory` grows past the line budget gets a truncated index plus a
    /// "…(N more in archival)" pointer, never the unbounded blob.
    #[test]
    fn core_notes_are_capped_with_archival_pointer() {
        // 100 one-line notes — well over CORE_MAX_LINES (40).
        let notes: String = (0..100).map(|i| format!("- note line {i}\n")).collect();
        let capped = cap_core_notes(&notes);
        let lines: Vec<&str> = capped.lines().collect();
        // 40 kept lines + the pointer line.
        assert_eq!(lines.len(), CORE_MAX_LINES + 1, "capped to the line budget + pointer");
        assert!(lines[0].contains("note line 0"), "keeps the head");
        assert!(!capped.contains("note line 99"), "drops the tail");
        assert_eq!(lines.last().copied(), Some("…(60 more in archival)"), "pointer names the drop count");

        // A short index passes through untouched.
        let short = "- one\n- two\n- three";
        assert_eq!(cap_core_notes(short), short, "under budget = verbatim");
    }

    /// The char budget is HARD even for a single wall-of-text line with no
    /// newlines: the line budget alone would emit it whole (the always-loaded
    /// token tax stays unbounded), so the first line is char-truncated too.
    #[test]
    fn core_notes_cap_a_single_overlong_line() {
        let one_huge_line = "x".repeat(20_000); // >> CORE_MAX_CHARS, zero newlines
        let capped = cap_core_notes(&one_huge_line);
        assert!(
            capped.chars().count() <= CORE_MAX_CHARS + 40,
            "a single long line is clipped to the char budget (+pointer), got {}",
            capped.chars().count()
        );
        assert!(capped.contains("more in archival"), "clipped index shows the pointer");
    }

    /// The cap also injects the pointer through the full `role_system_prompt`
    /// composition (role + capped notes), not just the helper in isolation.
    #[test]
    fn role_system_prompt_caps_the_notes_section() {
        let mut s = claude_session("bot", "");
        s.desc = "Standing instructions: be terse.".into();
        s.memory = (0..80).map(|i| format!("- fact {i}\n")).collect();
        let sys = role_system_prompt(&s).expect("role+notes present");
        assert!(sys.starts_with("Standing instructions: be terse."), "role first");
        assert!(sys.contains("Notes you keep:"), "notes delimiter kept");
        assert!(sys.contains("more in archival)"), "cap pointer injected");
        assert!(!sys.contains("fact 79"), "tail dropped");
    }

    /// With NO connector flags (empty slice), the launch line is byte-identical to
    /// the pre-connector fleet — the composition adds nothing.
    #[test]
    fn no_connector_flags_is_byte_identical() {
        let config = cfg();
        let s = claude_session("plain", "--yolo");
        let (with_empty, _) = build_launch_command(&config, &s, &[]);
        assert!(!with_empty.contains("--mcp-config"));
        assert!(!with_empty.contains("--strict-mcp-config"));
    }

    // ── SEC-01: caller-supplied `flags` on a shell command line ──────────────

    /// A claude-provider row carrying `flags`, everything else at its zero value.
    fn claude_session(name: &str, flags: &str) -> Session {
        Session {
            name: name.into(),
            display_name: name.into(),
            dir: "/tmp".into(),
            desc: String::new(),
            provider: "claude".into(),
            flags: flags.into(),
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
            runtime: "tmux".into(),
            notif: "inherit".into(),
            seen_ts: None,
            seen_count: None,
            seen_epoch: None,
            model: String::new(),
            memory: String::new(),
            skills: "[]".into(),
            role_id: None,
        }
    }

    /// COMPAT — every flags value this repo actually stores must reach the agent
    /// as the SAME argv it reached it with before quoting.
    ///
    /// This is the whole risk of the SEC-01 fix: `flags` is a free-text column on
    /// live installs, and quoting is only safe if it is a no-op for real values.
    /// Proven against `bash` itself rather than by eyeballing the string — the
    /// shell is the thing whose opinion counts.
    #[test]
    fn quoting_leaves_every_real_flags_value_argv_identical() {
        let corpus = [
            // `Default::default()` / every `flags: String::new()` fixture.
            "",
            // The trusted bypass flag `create` + `relaunch_for_bypass` write.
            BYPASS_FLAG,
            // Retired-provider and codex rows in this file's own fixtures.
            "--yolo",
            "--ask-for-approval never",
            // Ordinary user-typed values.
            "--model opus",
            "--permission-mode bypassPermissions --model opus",
            "--add-dir /opt/projects/supermux",
            // Sloppy whitespace: the old `.trim()` + shell splitting collapsed
            // it, and so does `split_whitespace`.
            "  --yolo   --model  opus  ",
        ];
        for flags in corpus {
            let words = quoted_flag_words(flags);
            let want: Vec<String> = flags.split_whitespace().map(str::to_string).collect();
            // Stronger than argv-equality for these: the escaper leaves an
            // ordinary flag word ALONE, so the launch line these render into is
            // byte-for-byte the line origin/main rendered.
            assert_eq!(words, want, "{flags:?} must render unchanged");
            if words.is_empty() {
                assert!(want.is_empty(), "{flags:?} produced no words but expected {want:?}");
                continue;
            }
            // Ask bash what argv these words produce.
            let out = std::process::Command::new("bash")
                .args(["-c", &format!("printf '%s\\n' {}", words.join(" "))])
                .output()
                .expect("bash must be available");
            let got: Vec<String> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::to_string)
                .collect();
            assert_eq!(got, want, "quoting changed the argv for {flags:?}");
        }
    }

    /// THE REGRESSION TEST. A flags value carrying `; touch <sentinel>` must
    /// neither execute nor break the launch line: the payload has to arrive at
    /// the agent as ARGUMENTS.
    ///
    /// Executed for real against a stub `claude` on PATH and an empty `$HOME`
    /// (so the profile sources in the launch line find nothing), because the
    /// only convincing proof that a shell-injection is dead is running the line
    /// and finding the sentinel absent.
    #[test]
    fn a_poisoned_flags_value_is_argv_and_never_a_command() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = std::env::temp_dir().join(format!("supermux-sec01-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let bin = tmp.join("bin");
        std::fs::create_dir_all(&bin).expect("temp bin dir");
        let sentinel = tmp.join("pwned");
        let argv_log = tmp.join("argv");

        // The stub agent: record argv, exit. Stands in for `claude` on PATH.
        let stub = bin.join("claude");
        std::fs::write(
            &stub,
            format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\n", argv_log.display()),
        )
        .expect("write stub");
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        // The exploit body from the SEC-01 report, verbatim in shape: end the
        // injected run with a second `claude` so the `--name <session>` the
        // builder appends still lands on a real command. Without that tail the
        // old, VULNERABLE rendering would leave `touch <sentinel> --name pwn`,
        // `touch` would refuse the flag, and this test would pass against the
        // very bug it exists to catch.
        let payload = format!(
            "--version >/dev/null ; touch {} ; claude",
            sentinel.display()
        );
        let (command, _) = build_launch_command(&cfg(), &claude_session("pwn", &payload), &[]);

        // 1. It is still a VALID shell line (an unbalanced quote would 500 the
        //    pane instead of running the payload — also not acceptable).
        assert!(
            std::process::Command::new("bash")
                .args(["-n", "-c", &command])
                .status()
                .expect("bash must be available")
                .success(),
            "the launch line must still parse: {command}",
        );

        // 2. Running it does NOT run the payload.
        let status = std::process::Command::new("bash")
            .arg("-c")
            .arg(&command)
            .env("HOME", &tmp)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .status()
            .expect("run the launch line");
        assert!(status.success(), "the stub agent should exit cleanly");
        assert!(
            !sentinel.exists(),
            "SEC-01 REGRESSED — the flags payload executed in the pane",
        );

        // 3. The payload reached the agent as argv, one word per argument.
        let argv: Vec<String> = std::fs::read_to_string(&argv_log)
            .expect("the stub agent must have run")
            .lines()
            .map(str::to_string)
            .collect();
        assert!(argv.contains(&";".to_string()), "argv: {argv:?}");
        assert!(argv.contains(&">/dev/null".to_string()), "argv: {argv:?}");
        assert!(argv.contains(&"touch".to_string()), "argv: {argv:?}");
        assert!(
            argv.contains(&sentinel.display().to_string()),
            "argv: {argv:?}",
        );
        // The launch builder's own `--name` still lands after the flags.
        assert!(argv.contains(&"--name".to_string()), "argv: {argv:?}");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[cfg(test)]
mod mode_cycle_tests {
    //! mode-shift: the Shift+Tab targeting math is a pure function, so the ring
    //! (`Normal → AcceptEdits → Plan → Normal`) is unit-tested directly.
    use super::*;

    #[test]
    fn cycle_steps_walks_the_ring_forward() {
        use Mode::*;
        // Same mode → 0 presses (no-op).
        assert_eq!(cycle_steps(Normal, Normal), Some(0));
        assert_eq!(cycle_steps(Plan, Plan), Some(0));
        // One forward step.
        assert_eq!(cycle_steps(Normal, AcceptEdits), Some(1));
        assert_eq!(cycle_steps(AcceptEdits, Plan), Some(1));
        assert_eq!(cycle_steps(Plan, Normal), Some(1));
        // Two forward steps (wrap-around — never go backward, the ring is one-way).
        assert_eq!(cycle_steps(Normal, Plan), Some(2));
        assert_eq!(cycle_steps(Plan, AcceptEdits), Some(2));
        assert_eq!(cycle_steps(AcceptEdits, Normal), Some(2));
    }

    #[test]
    fn cycle_steps_rejects_bypass_endpoints() {
        use Mode::*;
        // Bypass is launch-only — never reachable / leavable via the cycle.
        assert_eq!(cycle_steps(Normal, Bypass), None);
        assert_eq!(cycle_steps(Bypass, Normal), None);
        assert_eq!(cycle_steps(Bypass, Plan), None);
    }
}

#[cfg(test)]
mod stop_grace_tests {
    //! The stop grace must stay SHORT (tmux is torn down regardless,
    //! so a long grace only delays a teardown that happens anyway and makes Stop
    //! feel broken) yet poll on a TIGHT cadence (so a clean exit is observed
    //! near-instantly). These invariants are config-only, so they're pinned here
    //! without driving real tmux — a future edit can't silently regress to the
    //! old 15s grace or a coarse poll.
    use super::{STOP_GRACE_CAP, STOP_GRACE_POLL};
    use std::time::Duration;

    /// The OLD grace polled 30×500ms = 15s before teardown — the lag the user
    /// reported. The cap must stay an order of magnitude below that.
    const OLD_GRACE: Duration = Duration::from_secs(15);

    #[test]
    fn grace_cap_is_short_and_well_under_the_old_15s() {
        assert!(
            STOP_GRACE_CAP <= Duration::from_secs(2),
            "stop grace must stay brief (≤2s) so tmux clears promptly",
        );
        assert!(
            STOP_GRACE_CAP * 5 <= OLD_GRACE,
            "the new cap must be far below the old 15s grace that caused the bug",
        );
    }

    #[test]
    fn poll_cadence_is_tight_and_bounds_the_worst_case_overshoot() {
        // A tight poll means a clean exit is seen within one cadence of happening,
        // not on a coarse half-second tick.
        assert!(
            STOP_GRACE_POLL <= Duration::from_millis(100),
            "poll cadence must be tight so a clean exit is observed near-instantly",
        );
        // The cap must be a whole number of polls so the loop neither overshoots
        // nor stops a fraction short of the intended window.
        assert!(
            STOP_GRACE_CAP.as_millis() % STOP_GRACE_POLL.as_millis() == 0,
            "the grace cap should be an exact multiple of the poll cadence",
        );
        // Sanity: the window admits several poll iterations (a single-shot poll
        // would be too racy to ever observe a graceful exit).
        assert!(
            STOP_GRACE_CAP.as_millis() / STOP_GRACE_POLL.as_millis() >= 10,
            "the grace window must allow enough poll iterations to catch a clean exit",
        );
    }
}

#[cfg(test)]
mod link_liveness_tests {
    //! R2: a session lifecycle change re-publishes the board ONLY when the
    //! session has linked issues (otherwise it's noise). [`emit_board_if_linked`]
    //! is the gate used by archive/unarchive/stop; this exercises it directly so
    //! the rule is covered without driving real tmux.

    use super::*;
    use crate::config::Config;
    use crate::db::board::NewIssue;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-link-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    fn saw_board_event(rx: &mut tokio::sync::broadcast::Receiver<SseEvent>) -> bool {
        let mut seen = false;
        while let Ok(ev) = rx.try_recv() {
            if ev.event == "board" {
                seen = true;
            }
        }
        seen
    }

    #[tokio::test]
    async fn emit_board_only_when_session_has_linked_issues() {
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "worker-2", "/tmp", "claude")
            .await
            .unwrap();
        db::sessions::insert_minimal(&state.pool, "lonely", "/tmp", "claude")
            .await
            .unwrap();
        db::board::insert_issue(
            &state.pool,
            &NewIssue {
                id: "B-1".into(),
                title: "linked".into(),
                desc: String::new(),
                status: "doing".into(),
                session: Some("worker-2".into()),
                creator: String::new(),
                due: None,
                due_time: None,
                owner_type: "agent".into(),
                pos: 0.0,
                notified: 0,
                board_id: "main".into(),
                team_task_id: None,
            },
        )
        .await
        .unwrap();

        // A session WITH a linked issue → board re-published.
        let mut rx = state.sse_tx.subscribe();
        emit_board_if_linked(&state, "worker-2").await;
        assert!(saw_board_event(&mut rx), "linked session re-publishes the board");

        // A session with NO linked issue → no board re-publish (no noise).
        let mut rx = state.sse_tx.subscribe();
        emit_board_if_linked(&state, "lonely").await;
        assert!(
            !saw_board_event(&mut rx),
            "unlinked session must not re-publish the board"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod submit_and_launch_tests {
    //! Two start/send invariants that are easy to regress and expensive to
    //! notice: the text→Enter gap (a missing one turns a submit into a newline
    //! inside the agent's composer) and the double-launch guard (a missing one
    //! types `claude --resume …` into a RUNNING agent).
    use super::agent_already_running;

    /// Source of this module's own file, minus its test modules — the scan
    /// below must not match on its own assertions.
    fn lifecycle_source() -> &'static str {
        const SRC: &str = include_str!("lifecycle.rs");
        let end = SRC.find("\n#[cfg(test)]").unwrap_or(SRC.len());
        &SRC[..end]
    }

    /// EVERY "send literal text, then Enter to submit it" site must go through
    /// [`super::submit_gap`]. There are five (start's launch command, start's
    /// initial prompt, `send_text`, `paste(submit)`, and both stop nudges), and
    /// the one that was fixed first — `send_text` — was for months the only one:
    /// the others silently did not submit on the native runtime, which is how
    /// Stop ended up always burning the full grace window.
    ///
    /// A structural scan rather than five behavioural tests: the alternative
    /// needs a live pty per site, and this catches the actual failure mode (a
    /// NEW text→Enter site added without the gap).
    #[test]
    fn every_text_then_enter_site_applies_the_backend_submit_gap() {
        let src = lifecycle_source();
        let enter = format!("send_key({:?})", "Enter");
        let mut sites = 0;
        for (i, _) in src.match_indices(&enter) {
            let mut start = i.saturating_sub(600);
            while !src.is_char_boundary(start) {
                start += 1;
            }
            let window = &src[start..i];
            // The nearest preceding literal-text send, if any. A bare key send
            // (the trust-dialog Enter in `wait_for_agent_ready`) has none.
            let text_at = [window.rfind("send_text("), window.rfind(".paste(")]
                .into_iter()
                .flatten()
                .max();
            let Some(t) = text_at else { continue };
            sites += 1;
            assert!(
                window[t..].contains("submit_gap("),
                "a text→Enter site (byte {i}) does not apply the backend submit gap:\n{}",
                &window[t..],
            );
        }
        assert!(
            sites >= 5,
            "expected at least 5 text→Enter sites, found {sites} — did the scan stop matching?",
        );
    }

    /// The launch command is typed ONLY when nothing is running in the terminal.
    /// `None` (tmux — it cannot tell) must keep the historical behaviour exactly.
    #[test]
    fn the_launch_command_is_never_typed_into_a_running_program() {
        // Brand-new terminal: always launch, whatever the probe says.
        assert!(!agent_already_running(true, None));
        assert!(!agent_already_running(true, Some(false)));
        assert!(!agent_already_running(true, Some(true)));
        // Re-start on a live terminal…
        assert!(
            agent_already_running(false, Some(false)),
            "a program owns the pty — typing the launch line would land in it",
        );
        assert!(
            !agent_already_running(false, Some(true)),
            "shell prompt waiting: this IS the recovery path, the command must be typed",
        );
        assert!(
            !agent_already_running(false, None),
            "tmux cannot tell, and its behaviour must not change",
        );
    }
}

#[cfg(test)]
mod peek_cap_tests {
    //! `/peek` byte cap. The line cap (`lines.clamp(1, 10_000)`) does not bound
    //! the response: the ANSI channel re-emits SGR per run, so a max-lines
    //! request built a multi-MB JSON string in memory. The cap keeps the tail.

    use super::*;

    #[test]
    fn under_the_cap_is_returned_verbatim() {
        let s = "line one\nline two\n".to_string();
        assert_eq!(cap_bytes_from_tail(s.clone(), MAX_PEEK_BYTES), s);
    }

    #[test]
    fn over_the_cap_keeps_the_tail_on_a_line_boundary() {
        let s = "aaaa\nbbbb\ncccc\ndddd\n".to_string();
        let out = cap_bytes_from_tail(s, 12);
        assert!(out.len() <= 12, "must respect the cap, got {}", out.len());
        assert!(
            out.starts_with("cccc\n") || out.starts_with("dddd\n"),
            "must keep the NEWEST lines, got {out:?}"
        );
        assert!(!out.contains("aaaa"), "the oldest lines are the ones dropped");
    }

    /// A multibyte char straddling the cut must never produce invalid UTF-8
    /// (the return type would not allow it — this pins that we advance to a
    /// boundary rather than panicking on a slice).
    #[test]
    fn a_multibyte_char_at_the_cut_is_handled() {
        let s = format!("{}\nzzz\n", "é".repeat(100));
        let out = cap_bytes_from_tail(s, 10);
        assert!(out.len() <= 10);
        assert!(out.ends_with("zzz\n"));
    }

    /// A single line longer than the cap has no boundary to cut on — it must
    /// still come back bounded rather than whole.
    #[test]
    fn one_giant_line_is_still_bounded() {
        let s = "x".repeat(1_000);
        let out = cap_bytes_from_tail(s, 100);
        assert_eq!(out.len(), 100);
    }
}

#[cfg(test)]
mod write_runtime_tests {
    //! REGRESSION (codex #10). `send_harness_text` resolved the runtime BEFORE
    //! the auto-wake. When the wake's `start` migrates a legacy tmux session to
    //! native it `runtime_invalidate`s the cache — so the pre-wake handle points
    //! at the dead tmux backend, and writing the first message through it drops it
    //! into nothing while the wake reports success. `write_runtime` is the fix's
    //! decision point: re-resolve after a wake, reuse otherwise.

    use super::*;
    use crate::config::Config;
    use crate::sessions::runtime::{RUNTIME_NATIVE, RUNTIME_TMUX};

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("supermux-writert-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    /// After a wake that migrated tmux→native, re-resolving yields a DIFFERENT
    /// (live, native) handle than the one resolved before the wake — proving that
    /// reusing the pre-wake handle (the old bug) would have targeted the dead
    /// backend. When we did NOT wake, the pre-resolved handle is reused verbatim.
    #[tokio::test]
    async fn re_resolves_the_runtime_only_after_a_migrating_wake() {
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "mig", "/tmp", "claude")
            .await
            .unwrap();
        db::sessions::set_runtime(&state.pool, "mig", RUNTIME_TMUX)
            .await
            .unwrap();
        db::sessions::ensure_runtime(&state.pool, "mig", "tok")
            .await
            .unwrap();

        // The handle `send_harness_text` resolves BEFORE the auto-wake.
        let pre_wake = state.runtime_for("mig").await.unwrap();

        // The wake's `start` migrates the legacy row and invalidates the cache.
        db::sessions::set_runtime(&state.pool, "mig", RUNTIME_NATIVE)
            .await
            .unwrap();
        state.runtime_invalidate("mig");

        // woke == true → re-resolve. Must be a fresh handle, not the tmux one.
        let after_wake = write_runtime(&state, "mig", pre_wake.clone(), true)
            .await
            .unwrap();
        assert!(
            !Arc::ptr_eq(&pre_wake, &after_wake),
            "a migrating wake must hand the write the NEW backend, not the stale \
             pre-wake tmux handle that start migrated away from",
        );
        assert_ne!(
            pre_wake.target(),
            after_wake.target(),
            "the re-resolved handle is the native backend, distinct from tmux",
        );

        // woke == false → reuse the pre-resolved handle exactly (no needless churn).
        let no_wake = write_runtime(&state, "mig", pre_wake.clone(), false)
            .await
            .unwrap();
        assert!(
            Arc::ptr_eq(&pre_wake, &no_wake),
            "with no wake there was no migration; reuse the handle we already had",
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── send-path modal guard (codex #1, wave-7) ──────────────────────────────
    //
    // A minimal `SessionRuntime` double: always `alive` (so `send_harness_text`
    // takes the `woke == false` retry path, never `wake_for_send`), returns a
    // canned `capture_plain`, and COUNTS every `send_text` / `send_key` so a
    // test can prove nothing was typed. Injected straight into the runtime cache
    // (`state.session_runtimes`) so `runtime_for` hands it back.

    use crate::sessions::runtime::HistoryWindow;
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct StubRuntime {
        capture: String,
        /// When true, `capture_plain` returns an Err — the send-guard fail-closed
        /// path (wave-8).
        capture_err: bool,
        /// What `shell_is_foreground` reports. `None` = "can't tell" (the tmux
        /// default, which forces the text guard); `Some(true)` = a bare shell.
        shell_fg: Option<bool>,
        text_calls: AtomicUsize,
        key_calls: AtomicUsize,
    }

    impl StubRuntime {
        fn parked_at(capture: &str) -> Arc<Self> {
            Arc::new(Self {
                capture: capture.to_string(),
                capture_err: false,
                shell_fg: None,
                text_calls: AtomicUsize::new(0),
                key_calls: AtomicUsize::new(0),
            })
        }
        /// A runtime whose `capture_plain` always fails — exercises the send
        /// guard's fail-closed arm.
        fn capture_fails() -> Arc<Self> {
            Arc::new(Self {
                capture: String::new(),
                capture_err: true,
                shell_fg: None,
                text_calls: AtomicUsize::new(0),
                key_calls: AtomicUsize::new(0),
            })
        }
        /// A native-shaped runtime that reports it is sitting at a BARE SHELL
        /// (`tpgid == pid`) even though the (stale) capture still shows agent
        /// glyphs — exercises the native-authoritative refuse.
        fn bare_shell_with_stale_capture(capture: &str) -> Arc<Self> {
            Arc::new(Self {
                capture: capture.to_string(),
                capture_err: false,
                shell_fg: Some(true),
                text_calls: AtomicUsize::new(0),
                key_calls: AtomicUsize::new(0),
            })
        }
    }

    #[async_trait]
    impl SessionRuntime for StubRuntime {
        async fn spawn(&self, _d: &Path, _e: &HashMap<String, String>, _s: &str) -> anyhow::Result<()> {
            Ok(())
        }
        async fn alive(&self) -> bool {
            true // ← never wake; force the already-awake retry path
        }
        async fn kill(&self) -> anyhow::Result<()> {
            Ok(())
        }
        async fn send_text(&self, _t: &str) -> anyhow::Result<()> {
            self.text_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn send_key(&self, _k: &str) -> anyhow::Result<()> {
            self.key_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn paste(&self, _t: &str, _b: bool) -> anyhow::Result<()> {
            Ok(())
        }
        async fn resize(&self, _c: u16, _r: u16) -> anyhow::Result<()> {
            Ok(())
        }
        async fn capture_plain(&self, _lines: usize) -> anyhow::Result<String> {
            if self.capture_err {
                anyhow::bail!("stub: capture unavailable");
            }
            Ok(self.capture.clone())
        }
        async fn capture_ansi(&self, _lines: usize) -> anyhow::Result<String> {
            Ok(self.capture.clone())
        }
        async fn capture_screen_ansi(&self) -> anyhow::Result<String> {
            Ok(self.capture.clone())
        }
        async fn capture_full(&self) -> anyhow::Result<String> {
            Ok(self.capture.clone())
        }
        async fn seed(&self) -> anyhow::Result<String> {
            Ok(self.capture.clone())
        }
        async fn history_window(&self, end_offset: i64, _count: u32) -> anyhow::Result<HistoryWindow> {
            Ok(HistoryWindow {
                rows: vec![],
                history_size: 0,
                start_offset: end_offset,
                end_offset,
                hit_top: true,
                cols: 80,
                at_limit: false,
            })
        }
        async fn history_meta(&self) -> (u32, u16) {
            (0, 80)
        }
        async fn pane_pid(&self) -> anyhow::Result<Option<u32>> {
            Ok(None)
        }
        async fn dead(&self) -> anyhow::Result<bool> {
            Ok(false)
        }
        async fn shell_is_foreground(&self) -> Option<bool> {
            self.shell_fg
        }
    }

    /// THE CODEX #1 REGRESSION. A session parked at the resume picker, already
    /// awake (so `send_harness_text` skips `wake_for_send`): a retry `/send` must
    /// answer UNDELIVERED, must NOT type into the picker, and must NOT record
    /// `last_send`. Before the send-path guard the retry took `woke == false`,
    /// typed text+Enter into the modal, and wrote `last_send` — a swallowed
    /// message reported as delivered.
    #[tokio::test]
    async fn a_retry_send_parked_at_the_picker_is_undelivered_and_types_nothing() {
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "parked", "/tmp", "claude")
            .await
            .unwrap();

        let picker = "Resume a conversation\n❯ 1. Fix the parser  2h ago\n  2. Older chat";
        let rt = StubRuntime::parked_at(picker);
        state
            .session_runtimes
            .insert("parked".to_string(), rt.clone());

        let res = send_harness_text(&state, "parked", "retry after the first refusal", None, None).await;

        assert!(
            matches!(res, Err(AppError::Conflict(_))),
            "a retry while parked at the picker must report UNDELIVERED (409), \
             got {res:?}",
        );
        assert_eq!(
            rt.text_calls.load(Ordering::SeqCst),
            0,
            "the retry must NOT be typed into the picker",
        );
        assert_eq!(
            rt.key_calls.load(Ordering::SeqCst),
            0,
            "no Enter either — nothing is submitted into the modal",
        );
        let s = db::sessions::get(&state.pool, "parked").await.unwrap().unwrap();
        assert!(
            s.last_send_text.is_empty(),
            "a swallowed message must never be recorded as a send (last_send stays empty), \
             got {:?}",
            s.last_send_text,
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The guard is SCREEN-CONDITIONAL, not a blanket block: the SAME already-awake
    /// path with the agent's own composer prompt on screen delivers normally —
    /// text is typed, Enter submitted, and `last_send` recorded. Proves the fix
    /// does not turn ready-state sends into false-undelivered.
    #[tokio::test]
    async fn a_send_to_a_ready_composer_still_delivers() {
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "ready", "/tmp", "claude")
            .await
            .unwrap();

        let composer = "❯ Try \"fix tests\"\n  ? for shortcuts";
        let rt = StubRuntime::parked_at(composer);
        state
            .session_runtimes
            .insert("ready".to_string(), rt.clone());

        send_harness_text(&state, "ready", "a real message", None, None)
            .await
            .expect("a ready composer must accept the send");

        assert_eq!(rt.text_calls.load(Ordering::SeqCst), 1, "the text is typed");
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 1, "and submitted with Enter");
        let s = db::sessions::get(&state.pool, "ready").await.unwrap().unwrap();
        assert_eq!(
            s.last_send_text, "a real message",
            "a genuine delivery records last_send",
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// IDEMPOTENT SEND — the chat Retry duplicate guard. A re-POST carrying the
    /// SAME `send_id` (a Retry over a false failure, or a double-tap) is typed
    /// exactly ONCE; the second call is a no-op. A DIFFERENT id is a genuinely
    /// new message and is typed again. Proves "Retry can never duplicate a
    /// delivered message" at the delivery seam every writer passes through.
    #[tokio::test]
    async fn the_same_send_id_is_typed_once_a_different_id_types_again() {
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "idem", "/tmp", "claude")
            .await
            .unwrap();

        let composer = "❯ Try \"fix tests\"\n  ? for shortcuts";
        let rt = StubRuntime::parked_at(composer);
        state.session_runtimes.insert("idem".to_string(), rt.clone());

        // First delivery with key k1: typed + Entered + recorded.
        send_harness_text(&state, "idem", "ship it", None, Some("k1"))
            .await
            .expect("first send delivers");
        assert_eq!(rt.text_calls.load(Ordering::SeqCst), 1);
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 1);

        // Retry with the SAME key: Ok, but nothing typed (dedup no-op).
        send_harness_text(&state, "idem", "ship it", None, Some("k1"))
            .await
            .expect("a same-id re-POST is an accepted no-op, not an error");
        assert_eq!(rt.text_calls.load(Ordering::SeqCst), 1, "the duplicate is NOT typed again");
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 1);

        // A different key is a new message: typed again.
        send_harness_text(&state, "idem", "ship it", None, Some("k2"))
            .await
            .expect("a new id delivers");
        assert_eq!(rt.text_calls.load(Ordering::SeqCst), 2, "a genuinely new send is typed");
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 2);

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// WAVE-8 codex pass 3, edge (a): the CURRENT screen is a bare shell the agent
    /// exited to, but the capture still carries an OLDER `❯`/`esc to interrupt` up
    /// in its scrollback. An already-awake `/send` must answer UNDELIVERED, type
    /// nothing, and never record `last_send`. `shell_is_foreground` is `None` here
    /// (the tmux default), so this exercises the capture-SCOPED text guard — the
    /// exact fix — not the native shortcut. Before the fix the whole-capture search
    /// found the stale glyphs and typed into the bare shell.
    #[tokio::test]
    async fn a_retry_send_with_stale_scrollback_over_a_bare_shell_is_undelivered() {
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "stale", "/tmp", "claude")
            .await
            .unwrap();

        let mut screen = String::new();
        screen.push_str("✻ Thinking… (esc to interrupt · 8s · ↑ 1.2k tokens)\n");
        screen.push_str("❯ the previous composer line\n");
        screen.push_str("  ? for shortcuts\n");
        for i in 0..14 {
            screen.push_str(&format!("  done step {i}\n"));
        }
        screen.push_str("user@host project % \n");

        let rt = StubRuntime::parked_at(&screen);
        state.session_runtimes.insert("stale".to_string(), rt.clone());

        let res = send_harness_text(&state, "stale", "retry into a bare shell", None, None).await;
        assert!(
            matches!(res, Err(AppError::Conflict(_))),
            "a retry whose CURRENT screen is a bare shell (stale agent glyphs only in \
             scrollback) must report UNDELIVERED, got {res:?}",
        );
        assert_eq!(rt.text_calls.load(Ordering::SeqCst), 0, "nothing is typed into the bare shell");
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 0, "and no Enter is submitted");
        let s = db::sessions::get(&state.pool, "stale").await.unwrap().unwrap();
        assert!(s.last_send_text.is_empty(), "a swallowed message is never recorded as a send");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// WAVE-8 codex pass 3, edge (b): a send guard that CANNOT read the current
    /// screen must fail CLOSED — refuse rather than type blindly. Before the fix
    /// the capture-error arm logged and fell through to the keystrokes.
    #[tokio::test]
    async fn a_retry_send_fails_closed_when_the_screen_cannot_be_captured() {
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "blind", "/tmp", "claude")
            .await
            .unwrap();

        let rt = StubRuntime::capture_fails();
        state.session_runtimes.insert("blind".to_string(), rt.clone());

        let res = send_harness_text(&state, "blind", "message into the unknown", None, None).await;
        assert!(
            matches!(res, Err(AppError::Conflict(_))),
            "a capture failure must refuse the send (fail closed), got {res:?}",
        );
        assert_eq!(rt.text_calls.load(Ordering::SeqCst), 0, "nothing is typed when the screen is unreadable");
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 0, "and no Enter is submitted");
        let s = db::sessions::get(&state.pool, "blind").await.unwrap().unwrap();
        assert!(s.last_send_text.is_empty(), "no last_send is written on a refused send");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// WAVE-8 codex pass 3 (native belt-and-suspenders): when the runtime reports
    /// `shell_is_foreground() == Some(true)` — the pty IS at a bare shell — the send
    /// is refused outright, even if the (stale) capture still shows a live composer.
    /// This is the non-heuristic native default runtime path.
    #[tokio::test]
    async fn a_retry_send_refuses_when_native_reports_a_bare_shell() {
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "nativebare", "/tmp", "claude")
            .await
            .unwrap();

        // The capture LIES (still shows the old composer); shell_is_foreground is
        // the authority and says bare shell.
        let rt = StubRuntime::bare_shell_with_stale_capture("❯ Try \"fix tests\"\n  ? for shortcuts");
        state.session_runtimes.insert("nativebare".to_string(), rt.clone());

        let res = send_harness_text(&state, "nativebare", "into the bare shell", None, None).await;
        assert!(
            matches!(res, Err(AppError::Conflict(_))),
            "shell_is_foreground()==Some(true) must refuse regardless of the capture, got {res:?}",
        );
        assert_eq!(rt.text_calls.load(Ordering::SeqCst), 0, "nothing typed");
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 0, "no Enter");
        let s = db::sessions::get(&state.pool, "nativebare").await.unwrap().unwrap();
        assert!(s.last_send_text.is_empty(), "no last_send on refusal");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// WAVE-8 control: a BUSY turn is a legitimate queue — the already-awake path
    /// still delivers when the current screen is the `esc to interrupt` footer, and
    /// `shell_is_foreground` is `Some(false)` (a program owns the pty).
    #[tokio::test]
    async fn a_send_to_a_busy_turn_still_queues() {
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "busy", "/tmp", "claude")
            .await
            .unwrap();

        let mut rt = StubRuntime::parked_at("✻ Thinking… (esc to interrupt · 12s · ↑ 2.1k tokens)");
        Arc::get_mut(&mut rt).unwrap().shell_fg = Some(false);
        state.session_runtimes.insert("busy".to_string(), rt.clone());

        send_harness_text(&state, "busy", "queue me", None, None)
            .await
            .expect("a send during a busy turn is a queue, not a refusal");
        assert_eq!(rt.text_calls.load(Ordering::SeqCst), 1, "the queued text is typed");
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 1, "and submitted with Enter");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

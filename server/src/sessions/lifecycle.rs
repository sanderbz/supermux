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
use std::path::{Path, PathBuf};
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
use super::pty_state;
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
    /// Did the OPENING PROMPT actually submit? `Some(true)`: observed (a turn
    /// started, or the agent parked on a selector it could only reach by
    /// answering). `Some(false)`: the whole verify window was observed and the
    /// prompt still looked unsubmitted — the session is left running for
    /// recovery. `None`: no prompt was delivered, or delivery could not be
    /// verified (see [`deliver_prompt`]). A caller may NOT read `None` as a
    /// failure.
    pub prompt_submitted: Option<bool>,
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
///
/// This is also the rule for a session's `config_dir` (migration 0041): the
/// launch line's `CLAUDE_CONFIG_DIR` export, the Resume picker and recall all
/// read this predicate, so all three agree on whose transcripts a session owns.
pub(crate) fn launches_claude(provider: &str) -> bool {
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

/// The `export CLAUDE_CONFIG_DIR=...` prefix for a session that launches claude
/// (migration 0041), or the empty string when the session carries no config dir
/// (the daemon default, byte-identical to the pre-0041 launch line). The value
/// is charset-validated at the HTTP boundary (`sessions::valid_config_dir`) and
/// single-quoted here as well, so nothing can break out of the line.
///
/// Gated on [`launches_claude`], which is the same gate the Claude-only env in
/// [`build_env`] uses. It matters for the RETIRED `kimi`: since that provider's
/// launch arm was removed, a legacy kimi row reaching this builder would fall
/// through to the claude arm, and a row that gets no `CLAUDE_CODE_*` env and
/// whose picker reads the daemon's transcripts must not get the export either.
/// `start` refuses a retired provider long before this, so no live row is
/// affected either way.
fn config_dir_export(s: &Session) -> String {
    let dir = s.config_dir.trim();
    if dir.is_empty() || !launches_claude(&s.provider) {
        String::new()
    } else {
        format!("export CLAUDE_CONFIG_DIR='{dir}'; ")
    }
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
    // Third element: the `CLAUDE_CONFIG_DIR` export (migration 0041), built by
    // the arm that actually launches the agent so the command and the export can
    // never disagree about which account this session boots on.
    let (agent, resume_intended, config_dir_export) = match s.provider.as_str() {
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
            // No config-dir export either: Codex does not read CLAUDE_CONFIG_DIR.
            (agent, false, String::new())
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
            // This arm runs `claude`, so this is where the session's own Claude
            // login applies (migration 0041).
            (parts.join(" "), resume_intended, config_dir_export(s))
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
    // Per-session Claude login (migration 0041). A session can be pointed at a
    // second account's config dir. The export was built by the launch arm
    // above; it lands AFTER the profile sources so a user `~/.zprofile` that
    // sets its own CLAUDE_CONFIG_DIR cannot override it, and BEFORE `{agent}`
    // so the launched provider inherits it.
    let command = format!(
        "source ~/.zprofile 2>/dev/null; source ~/.bash_profile 2>/dev/null; \
         source ~/.profile 2>/dev/null; export EDITOR='{bridge}' VISUAL='{bridge}'; \
         export PATH='{bin_dir}':\"$PATH\"; {config_dir_export}{agent}"
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

/// LIVE Claude/Codex bottom chrome, read over the WHOLE capture rather than the
/// 10-line tail. The composer glyph and the busy footer sit at a FIXED height
/// above the bottom of a normal agent screen — but this deployment draws a
/// teammate/swarm roster (`● main` / `◯ <bot>` / `↓ N more`, under a
/// `View teammates:` line) BELOW them, so on a busy agent with many teammates
/// the composer and footer are pushed clean out of `current_screen_tail`. The
/// tail then holds only the roster, `agent_composer_visible`/`agent_busy` both
/// miss, and a healthy agent is refused `NoAgent` — the send-guard regression
/// that broke chat + scheduled delivery. These markers are drawn ONLY while a
/// Claude/Codex agent owns the pane (its mode footer, its idle hint, its busy
/// footer); a bare shell or a foreign program draws none of them, and the
/// picker/trust/selection screens are refused ABOVE this on the current screen,
/// so reading agent-presence wide can only widen an ADMIT, never a refusal.
fn agent_footer_live(capture: &str) -> bool {
    let c = capture.to_lowercase();
    // Deliberately NOT `? for shortcuts` / `esc to interrupt`: those also appear in
    // the SCROLLBACK of a session that has since exited to a shell, and admitting on
    // them would defeat `pty_ready_for_send_ignores_stale_scrollback_above_a_bare_shell`.
    // The mode footer and the swarm roster header, by contrast, are redrawn at the
    // BOTTOM of the live agent UI every frame — a bare shell or a foreign program
    // never carries them, so their presence means an agent owns the pane right now,
    // even when its composer has been pushed above the tail by the roster beneath it.
    c.contains("bypass permissions") // the ⏵⏵ mode footer (persistent, live)
        || c.contains("auto mode on")
        || c.contains("view teammates:") // the swarm roster header, drawn live at the bottom
}

/// WHY [`send_harness_text`] may NOT type `text`+Enter into the pty showing this
/// CURRENT capture — or `None` when it may. The SEND-path twin of
/// [`classify_ready_tick`]'s ready arm.
///
/// [`wake_for_send`] already refuses a FIRST send whose wake lands on a boot
/// modal (`start().ready == false`), but an ALREADY-AWAKE retry (`woke ==
/// false`) skips the wake entirely — so without this a retry types straight into
/// a resume picker / trust dialog left open on the pty, records `last_send`, and
/// reports a message the modal swallowed as delivered (codex #1, wave-7).
///
/// THE RULE, and it is the whole of it: a send is admitted ONLY on POSITIVE
/// evidence that the agent is at its TEXT COMPOSER. Not "the screen is not one
/// of the two modals we know"; not "some interactive footer is visible". A
/// screen this function cannot positively recognise as a composer REFUSES.
///
/// WHY THAT ASYMMETRY IS THE DESIGN. `send_harness_text` ends in `send_text` +
/// `Enter`, and what that means depends entirely on what is listening:
///   * at a COMPOSER it is a message — the thing every caller intends;
///   * at ANY selection screen it is neither. The paste is dropped and the Enter
///     picks whatever row is highlighted (a0 §3, the same fact
///     `web/src/components/chat/use-composer.ts` states). The sender's words
///     vanish and an answer nobody chose is submitted — while the caller is told
///     it worked. That is worse than a 409 in every direction, and it is not
///     hypothetical for a foreign program: `[y/N]` under a finger that means
///     "yes" is a destructive confirmation.
/// Only the BROWSER has a lens in front of this (`sendGate` refuses on a sighted
/// dialog). `POST /api/agents/delegate`, `scheduler::runner`, the board
/// dispatcher and the steering loop all funnel through here with no lens at all,
/// so this guard is the only thing standing in front of those keystrokes.
///
/// So, in order:
///   1. the `--resume` session picker (Claude or Codex) — refused over the WHOLE
///      capture, because its identifying TITLE sits at the top of the screen;
///   2. a startup GATE — `trust` / `apikey` / `onboarding` / `hooks-review`, read
///      by [`pty_state::startup_wedge`], the same reader the status detector
///      already trusts to say a session is waiting on a human. Same whole-capture
///      reason;
///   3. ANY SELECTION SCREEN on the current screen ([`selection_screen`]) — the
///      agent's own question / plan / paused modal / permission menu, a picker
///      whose title has scrolled out of the capture, or an interactive prompt
///      from some program the user ran by hand in the same pty. One refusal,
///      because a keystroke means the same wrong thing in all of them;
///   4. otherwise: a COMPOSER anchor ([`agent_composer_visible`]), a live Codex
///      composer ([`codex_ready`]), or a busy turn ([`agent_busy`], where a send
///      is the queue CC itself offers) — and nothing else admits.
///
/// CURRENT-SCREEN scoping (wave-8, codex pass 3) is kept for every check that
/// can be: the capture is scrollback + viewport, so a screen that ENDS at a bare
/// shell but still carries an OLDER `❯` / `esc to interrupt` up in its history
/// must not satisfy the guard. Steps 1-2 are the deliberate exception (a title
/// above the fold), and both of them only ever REFUSE — widening a refusal's
/// window can never open a door.
fn send_block(capture: &str) -> Option<SendBlock> {
    if at_resume_picker(capture) {
        return Some(SendBlock::ResumePicker);
    }
    if at_trust_dialog(capture) {
        return Some(SendBlock::Gate("trust"));
    }
    if let Some(wedge) = pty_state::startup_wedge(capture) {
        return Some(SendBlock::Gate(wedge));
    }
    let screen = current_screen_tail(capture);
    // A SELECTION SCREEN REFUSES BEFORE ANYTHING ADMITS, whoever drew it. It is
    // checked first on purpose: a dialog's own caret is a `❯` too, so a rule
    // that admitted first would admit every one of them.
    if selection_screen(&screen) {
        return Some(SendBlock::Selection);
    }
    // Agent presence is read over the WHOLE capture (`agent_busy` / `agent_footer_live`),
    // not just the current tail: a teammate/swarm roster drawn below the composer can push
    // the composer glyph and the footer out of `current_screen_tail`, and the danger screens
    // (picker / trust / selection) have already been refused above, so widening the ADMIT
    // path cannot reach them.
    if agent_composer_visible(&screen)
        || agent_busy(&screen)
        || codex_ready(&screen)
        || agent_footer_live(capture)
    {
        return None;
    }
    Some(SendBlock::NoAgent)
}

/// Why a send was refused — one variant per screen, because the sentence the
/// caller reads has to name the thing that is actually in the way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendBlock {
    /// The `--resume` session picker (Claude or Codex), by its title.
    ResumePicker,
    /// A named startup gate (`pty_state`'s wedge token).
    Gate(&'static str),
    /// A screen that is answered with a KEYPRESS, not with text: the agent's own
    /// question / plan / paused modal / permission menu, a picker recognised by
    /// its legend rather than its title, or a foreign interactive prompt.
    Selection,
    /// Nothing on the CURRENT screen says an agent is at its composer — a bare
    /// shell the agent exited to, or a screen this server cannot read as one.
    NoAgent,
}

impl SendBlock {
    /// The refusal, in one sentence: what is on screen, that nothing was
    /// delivered, and the one thing that ends the situation.
    fn sentence(self, name: &str) -> String {
        match self {
            SendBlock::ResumePicker => format!(
                "session '{name}' is sitting on its resume picker — the message was NOT delivered. \
                 Open the terminal and pick a conversation (or Reset the session), then resend.",
            ),
            SendBlock::Gate(wedge) => format!(
                "session '{name}' is sitting on {} — a startup gate the agent has not passed yet, \
                 so the message was NOT delivered. Open the terminal and answer it (or Reset the \
                 session), then resend.",
                gate_clause(wedge),
            ),
            SendBlock::Selection => format!(
                "session '{name}' is on a prompt that is answered with a keypress, not with text \
                 — typed words are dropped there and the Enter after them would pick whatever row \
                 is highlighted, so the message was NOT delivered. Answer it (the card in chat, or \
                 the terminal), then resend.",
            ),
            SendBlock::NoAgent => format!(
                "session '{name}' shows no agent composer on its current screen — it has probably \
                 exited to a shell, so the message was NOT delivered. Open the terminal to see \
                 what it is showing (or Reset the session), then resend.",
            ),
        }
    }
}

/// A wedge token as the reader meets it on screen. An unknown token names itself
/// rather than being smoothed into "a startup gate" twice over — a sentence that
/// says a word the user can search for beats one that says nothing.
fn gate_clause(wedge: &str) -> String {
    match wedge {
        "trust" => "its folder-trust dialog".to_string(),
        "apikey" => "its API-key gate".to_string(),
        "onboarding" => "Claude Code's first-run setup".to_string(),
        "hooks-review" => "Codex's hooks-review gate".to_string(),
        other => format!("its `{other}` startup gate"),
    }
}

/// Is the current screen answered with a KEYPRESS rather than with text?
///
/// Deliberately NOT "is this a Claude dialog". The pty is a terminal a human
/// also drives by hand, and `npm init`, `gh`, `k9s`, a psql `\d` pager and a
/// dozen other programs draw selection lists and `[y/N]` confirmations into the
/// same pane. This function's answer only ever REFUSES a send, so it is written
/// to be generous: every marker below costs an undeliverable 409 the caller can
/// act on, and the alternative it prevents is a keystroke landing on a row
/// nobody chose.
///
/// Two shapes, both bottom-anchored by construction:
///   * a CARET ON A NUMBERED ROW (`❯ 1. Yes`) — the selection cursor, which is
///     the one thing ordinary prose lists never carry (the same tell
///     `peek-lens.ts`'s `looksModal` uses);
///   * a KEY LEGEND — the line a TUI prints under its options saying which key
///     commits. Claude Code and Codex draw `Enter to select` / `Enter to
///     confirm` / `Esc to cancel` / `Tab to amend`; inquirer-style CLIs draw
///     `(Use arrow keys)`; a shell confirmation draws `[y/N]`.
///
/// THE LEGEND IS ALSO THE BELT ON THE PICKER (step 1's blind spot): a resume
/// picker whose title has scrolled out of the 30-line capture keeps its footer,
/// so it is still refused here — one row lower in the ladder, with a sentence
/// that is true of both.
///
/// Read on the CURRENT SCREEN ONLY: an answered dialog's footer scrolled up into
/// the history is not what is about to be typed into.
fn selection_screen(screen: &str) -> bool {
    if screen.lines().any(is_selection_row) {
        return true;
    }
    let c = screen.to_lowercase();
    [
        "enter to select",
        "enter to confirm",
        "esc to cancel",
        "tab to amend",
        "use arrow keys",
        "[y/n]",
        "(y/n)",
    ]
    .iter()
    .any(|marker| c.contains(marker))
}

/// `❯ 1. Yes, and don't ask again` — a selection caret sitting ON a numbered
/// row. The caret alone is the composer's glyph and the number alone is prose,
/// so it takes both.
fn is_selection_row(line: &str) -> bool {
    let rest = match strip_selection_caret(line) {
        Some(rest) => rest,
        None => return false,
    };
    numbered_row(rest)
}

/// The SELECTION cursor glyphs — a strict superset of [`strip_caret`]'s, adding
/// `›` (U+203A).
///
/// Kept separate on purpose, because the two callers want opposite risk. `›` is
/// Codex's cursor (and Claude Code draws it too — `keys_to_accept_trust` has
/// always matched both), so without it `is_selection_row` was blind to EVERY
/// Codex selector and `selection_screen` could only recognise one through its
/// ENGLISH key-legend list. That was merely over-cautious while this fed
/// `send_block`, where an unrecognised dialog just refuses a send; but
/// [`submit_state`] INVERTS the polarity — an unrecognised selector reads `Stuck`,
/// and `deliver_prompt` answers `Stuck` by pressing Enter, onto whatever row the
/// dialog has highlighted. A Codex approval prompt whose command preview pushes
/// its legend out of the 10-line [`current_screen_tail`] window is exactly that
/// screen: `› 1. Yes / › 2. No` and nothing else.
///
/// It is NOT folded into [`strip_caret`] because that one also feeds
/// [`agent_composer_visible`], where a matched glyph PERMITS a send. Widening
/// both would trade a blind Enter for a blind send onto a `›`-drawn non-numbered
/// dialog line. Widening only the selection side is monotonic: strictly more
/// screens are recognised as dialogs, so the send guard only ever gets more
/// conservative.
fn strip_selection_caret(line: &str) -> Option<&str> {
    let t = line.trim_start();
    strip_caret(line).or_else(|| t.strip_prefix('›'))
}

/// The line's leading caret glyph removed, or `None` when it does not open with
/// one. Leading whitespace is the terminal's left margin, not a signal.
///
/// The COMPOSER glyphs only (`❯`, `❱`). Codex's `›` is deliberately absent here:
/// this feeds [`agent_composer_visible`], where a match PERMITS a send. Selection
/// detection wants the wider set and uses [`strip_selection_caret`].
fn strip_caret(line: &str) -> Option<&str> {
    let t = line.trim_start();
    t.strip_prefix('❯').or_else(|| t.strip_prefix('❱'))
}

/// `1. Yes` / `12. Something` — the option-row shape, after the caret.
fn numbered_row(rest: &str) -> bool {
    let t = rest.trim_start();
    let digits = t.trim_start_matches(|c: char| c.is_ascii_digit());
    digits.len() < t.len() && digits.starts_with('.')
}

/// POSITIVE evidence that the agent is at its TEXT COMPOSER — the one screen
/// where `send_text` + Enter means "a message".
///
/// Two anchors, both Claude Code's own chrome:
///   * `? for shortcuts`, the hint line CC prints under an idle composer and
///     under no other screen it draws;
///   * the composer glyph (`❯` / `❱`) opening a line that is NOT a numbered
///     option row. That exclusion is the whole difference between this and the
///     [`agent_ui_visible`] it replaced on the send path: a dialog's selection
///     cursor is the SAME glyph, which is how a permission menu and an
///     AskUserQuestion both used to read as "the agent is at the wheel".
///
/// [`selection_screen`] has already refused before this is consulted, so a
/// screen carrying both (a caret row above, a composer below) never reaches
/// here — deliberately, and in the safe direction.
fn agent_composer_visible(screen: &str) -> bool {
    screen
        .lines()
        .any(|l| l.contains("? for shortcuts") || strip_caret(l).is_some_and(|r| !numbered_row(r)))
}

/// True once a READY, EMPTY Codex composer is visible. Codex draws `›` (U+203A),
/// not Claude's `❯`, so [`agent_ui_visible`] is blind to it and the send guard
/// wrongly 409'd every send/delegate to an awake, idle Codex (FIX 2). ORed into
/// [`send_block`] AFTER the picker/trust rejections, so a real Codex
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

// ── opening-prompt submission check ──────────────────────────────────────────

/// What one capture says about the OPENING PROMPT we just typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubmitState {
    /// The input was CONSUMED: a turn is running, or the agent is parked on a
    /// selector it could only have reached by answering the prompt.
    Submitted,
    /// The prompt's own text is still on screen with no turn running — either the
    /// composer still holds it (the swallowed Enter) or a finished turn echoed it
    /// into the transcript. The caller resolves that ambiguity by pressing Enter
    /// again, which is a no-op in the second case.
    Stuck,
    /// Neither marker: a cleared or mid-repaint screen. Keep polling.
    Unknown,
}

/// Did the opening prompt submit? Pure over one capture, so it is unit-tested
/// without a terminal exactly like [`send_block`]'s heuristics.
///
/// Two positive arms, both reusing the send guard's own vocabulary:
///   1. [`agent_busy`] — Claude/Codex pin `esc to interrupt` for the whole turn.
///      Read over the WHOLE capture (not the tail) for the same reason
///      [`agent_footer_live`] is: a teammate roster drawn below the footer can
///      push it out of the tail. The stale-scrollback worry that keeps
///      `send_block` narrow does not apply here — this runs seconds after a boot
///      whose agent we just watched take the wheel;
///   2. [`selection_screen`] on the current screen — an approval menu / question
///      PROVES the input was consumed: the agent read the prompt, ran, and is now
///      waiting on a human. Nothing is "working" during that wait, so without this
///      arm the classifier says Stuck and the retry Enter CONFIRMS whatever row is
///      highlighted (a `rm -rf`, an edit, a plan). This arm is what makes retrying
///      safe at all.
///
/// The selector arm must not fire on THE PROMPT'S OWN ECHO. `is_selection_row`
/// matches `❯ <n>. …`, which is exactly how the composer draws a prompt that
/// starts "1. check the queue", and the key-legend markers are unanchored
/// substrings a prompt can carry verbatim. So echoed lines are dropped BEFORE the
/// screen is classified. Per line, because no marker spans a newline — which
/// keeps a genuine selector drawn UNDER an echoed prompt working.
///
/// Otherwise: the prompt tail still squashes into the capture → Stuck.
fn submit_state(capture: &str, prompt: &str) -> SubmitState {
    if agent_busy(capture) {
        return SubmitState::Submitted;
    }
    let screen = current_screen_tail(capture);
    let without_echo = screen
        .lines()
        .filter(|l| !line_is_prompt_echo(l, prompt))
        .collect::<Vec<_>>()
        .join("\n");
    if selection_screen(&without_echo) {
        return SubmitState::Submitted;
    }
    let tail = prompt_tail(prompt);
    if !tail.is_empty() && squash(capture).contains(&tail) {
        SubmitState::Stuck
    } else {
        SubmitState::Unknown
    }
}

/// How many trailing characters of the (squashed) prompt the Stuck match keys on.
/// Long enough that ordinary transcript prose cannot collide with it, short
/// enough that a one-line prompt still has a tail.
const PROMPT_TAIL_CHARS: usize = 60;

/// The last [`PROMPT_TAIL_CHARS`] characters of the squashed prompt — the needle
/// the Stuck arm looks for in the squashed capture.
fn prompt_tail(prompt: &str) -> String {
    let p = squash(prompt);
    let start = p
        .char_indices()
        .rev()
        .nth(PROMPT_TAIL_CHARS - 1)
        .map(|(i, _)| i)
        .unwrap_or(0);
    p[start..].to_string()
}

/// Drop everything the composer's LAYOUT inserts into text: all whitespace (it
/// hard-wraps at pane width, at positions we cannot predict) and every
/// box-drawing glyph. Claude fences each wrapped line with `│` inside a `╭─╮` box,
/// so the borders land in the middle of the text too — squashing whitespace alone
/// would leave `…bootedbythe││scheduler…`, which never matches the prompt.
/// U+2500..U+257F is the whole box-drawing block, so any border style a provider
/// switches to is covered without hard-coding glyphs.
fn squash(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '\u{2500}'..='\u{257F}'))
        .collect()
}

/// Is `line` nothing but a piece of `prompt` drawn back onto the screen?
///
/// Deliberately loose: the composer breaks the prompt at unpredictable points, so
/// any single drawn line is some contiguous run of it. The composer CURSOR glyphs
/// are stripped on both sides as well — the first drawn line opens `❯ `, which the
/// prompt itself never contained and which is what makes it look like a selector.
/// An empty line is never an echo (it is never evidence of anything either).
fn line_is_prompt_echo(line: &str, prompt: &str) -> bool {
    let strip_cursor = |s: &str| -> String {
        squash(s)
            .chars()
            .filter(|c| !matches!(c, '❯' | '❱' | '›' | '>'))
            .collect()
    };
    let l = strip_cursor(line);
    // The match is an UNANCHORED substring, so a SHORT line is matched by
    // coincidence rather than by evidence: `1. Yes` is swallowed as "echo" by any
    // prompt that happens to contain those five characters, and swallowing it
    // hides the very selector row that stops a retry Enter. Below the floor a line
    // is never treated as echo — which errs toward `Submitted` (no extra Enter),
    // the safe direction. A genuine wrapped echo line is far longer than this.
    const MIN_ECHO_CHARS: usize = 12;
    l.chars().count() >= MIN_ECHO_CHARS && strip_cursor(prompt).contains(&l)
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
/// won't render". We detect it and auto-accept by navigating to "Yes, I trust
/// this folder" (see [`keys_to_accept_trust`] — the option order is not fixed),
/// which also records the dir as trusted so it never reappears for that path.
fn at_trust_dialog(capture: &str) -> bool {
    let c = capture.to_lowercase();
    (c.contains("trust the files") || c.contains("trust this folder") || c.contains("do you trust"))
        || (c.contains("safety check") && c.contains("trust"))
}

/// The key sequence that lands on "Yes, I trust this folder" and confirms it —
/// for whatever ORDER the trust dialog draws its options in.
///
/// A bare Enter was correct while Claude Code defaulted the cursor to
/// "1. Yes, I trust this folder". A later Claude Code FLIPPED the dialog: it now
/// lists "No, exit" FIRST and selects it by default (unnumbered), so a bare Enter
/// picks "No, exit" and the session QUITS before it starts — the reported failure
/// where booting a new company assistant "won't get past trust workspace, then
/// quits", and a restart just repeats it. Never trust the default: locate the
/// affirmative option and the cursor, then step onto the affirmative and confirm.
///
/// The dialog is a two-option menu, so a single arrow toward the affirmative
/// always lands on it (blank/paragraph lines between options don't count as menu
/// stops). Returns an EMPTY sequence when the affirmative option or the cursor
/// can't be located, so a parse miss WAITS and retries — never a blind Enter that
/// could confirm "No, exit".
///
/// The affirmative is matched on the OPTION line ("Yes…" after the cursor glyph
/// and any "1." numbering), NOT on any line mentioning trust: the dialog's own
/// header — "Do you trust the files in this folder?" — mentions it too, and
/// locking onto the header put the cursor permanently "below Yes", turning the
/// already-correct old layout into an Up that wraps a two-option menu onto
/// "No, exit". Both cursor glyphs Claude Code has drawn (`❯`, `›`) count.
fn keys_to_accept_trust(capture: &str) -> Vec<&'static str> {
    let lines: Vec<&str> = capture.lines().collect();
    let yes = lines.iter().position(|l| {
        let x = l.to_lowercase();
        let x = x.trim_start_matches(['❯', '›', '>', ' ', '\t']);
        let x = x.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ' ');
        x.starts_with("yes")
    });
    let cursor = lines
        .iter()
        .position(|l| l.contains('❯') || l.contains('›'));
    match (yes, cursor) {
        (Some(y), Some(c)) if c == y => vec!["Enter"], // already on "Yes"
        (Some(y), Some(c)) if c < y => vec!["Down", "Enter"], // "Yes" is below
        (Some(_), Some(_)) => vec!["Up", "Enter"],     // "Yes" is above
        _ => Vec::new(),                               // can't measure → wait, never blind-Enter
    }
}

/// The stable fragment of Claude Code's **background-session refusal**, with all
/// whitespace squeezed out (see [`squash_ws`]).
///
/// The full sentence is:
///
/// ```text
/// Session a30d387a-… is running as a background session (a30d387a). Run
/// `claude attach a30d387a` to open it, or `claude stop a30d387a` first to
/// resume it here. Add --fork-session to branch off a copy instead.
/// ```
///
/// We match the SQUEEZED form of a short, stable middle fragment rather than the
/// sentence: a pane is 80 columns on a phone and this line wraps — anywhere,
/// mid-word — so any needle with a space in it is a coin flip. Squeezing both
/// sides makes the match wrap-proof.
const BG_SESSION_NEEDLE: &str = "isrunningasabackgroundsession";

/// Drop every whitespace character and lowercase the rest. The pane's line
/// wrapping (and the two spaces Claude indents its error with) then cannot break
/// a match or an id.
fn squash_ws(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// **Bug A.** Is the pane showing Claude Code's refusal to `--resume` a
/// conversation that its own daemon is already holding as a BACKGROUND session —
/// and is the conversation it names OURS? Returns the id to `claude stop`.
///
/// Witnessed live on this box: a session's conversation was also registered as a
/// Claude Code daemon background session (`claude bg-pty-host … --session-id
/// <id> --fork-session --reply-on-resume`, parented to init). Every supermux
/// start then typed `claude --resume <id>`, claude printed the refusal and exited
/// INSTANTLY, and the owner saw a terminal flash and vanish — after which the
/// session sat "idle" wrapping a bare bash with no error anywhere. `claude stop
/// <id>` deregisters the daemon copy and the very next start resumes with full
/// context.
///
/// **We never stop an id that is not ours.** The refusal names the conversation
/// twice — in full before the fragment, and short in parentheses — and the id is
/// only returned when one of those matches an id THIS session was launched with
/// (`cc_conversation_id` / `cc_session_name`, passed as `ours`). A refusal about
/// somebody else's conversation (a stale scrollback line, a shared pane) reads as
/// "not ours" and nothing is stopped: killing another agent's background session
/// is far worse than one failed start.
///
/// A row that resumes by NAME while claude answers with the conversation UUID
/// legitimately does not match — that start falls through to the honest error
/// rather than guessing at an id.
fn background_session_refusal(capture: &str, ours: &[&str]) -> Option<String> {
    let flat = squash_ws(capture);
    let at = flat.find(BG_SESSION_NEEDLE)?;

    // The full id sits immediately before the fragment ("Session <id> is running
    // …"): walk back over the id charset. The word "Session" ends in `n`, which
    // is not a hex digit, so the scan stops exactly at the id's first character.
    let full: String = flat[..at]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    // …and the short one in the parentheses right after it, which is the id
    // Claude's own instruction tells the human to pass to `claude stop`.
    let short = flat[at..]
        .strip_prefix(BG_SESSION_NEEDLE)
        .and_then(|rest| rest.strip_prefix('('))
        .and_then(|rest| rest.split_once(')'))
        .map(|(id, _)| id.to_string())
        .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .unwrap_or_default();

    // OWNERSHIP. Either spelling has to name a conversation we launched with.
    let mine = ours.iter().filter(|o| !o.is_empty()).any(|o| {
        let o = o.to_lowercase();
        (!full.is_empty() && o == full) || (short.len() >= MIN_BG_ID && o.starts_with(&short))
    });
    if !mine {
        return None;
    }
    // Prefer the short id: it is the one Claude printed for `claude stop`.
    if short.len() >= MIN_BG_ID {
        Some(short)
    } else if full.len() >= MIN_BG_ID {
        Some(full)
    } else {
        None
    }
}

/// Shortest id we will ever hand to `claude stop`. Claude's own short form is 8
/// hex characters; anything shorter is a parse accident, not an id.
const MIN_BG_ID: usize = 8;

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
    /// Claude refused the `--resume` because its own daemon holds the
    /// conversation as a BACKGROUND session, and the id it named is ours (see
    /// [`background_session_refusal`]). The agent is already gone — claude exits
    /// instantly on this one — so there is nothing left to poll for: stop the
    /// background session and retry the launch ONCE.
    StopBackgroundSession(String),
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
    resume_ids: &[&str],
    bg_stop_tried: bool,
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
    // AFTER the ready check on purpose. The refusal stays in the pane's
    // scrollback once the retry succeeds, and a live agent above it must win —
    // otherwise the second start would `claude stop` the conversation it just
    // resumed. `bg_stop_tried` makes it a ONE-SHOT: a second refusal is a real
    // failure to report, not a loop to run.
    if !bg_stop_tried {
        if let Some(id) = background_session_refusal(capture, resume_ids) {
            return ReadyTick::StopBackgroundSession(id);
        }
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
/// [`should_escape_resume_picker`]), and one trust-dialog auto-accept (navigate to
/// "Yes, I trust this folder" — [`keys_to_accept_trust`]) so a first-launch in a
/// never-seen project dir does not hang forever OR quit on the "No, exit" default.
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
    resume_ids: &[&str],
    bg_stop_tried: bool,
) -> BootOutcome {
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
            match classify_ready_tick(&cap, resume_intended, escaped, trusted, resume_ids, bg_stop_tried)
            {
                ReadyTick::AcceptTrust => {
                    // NEVER a bare Enter: a newer Claude Code lists "No, exit" first
                    // and selects it by default, so Enter alone quits the session.
                    // Navigate to "Yes, I trust this folder" whatever order it is
                    // drawn in; accepting also persists the trust so it never
                    // reappears for this dir.
                    let keys = keys_to_accept_trust(&cap);
                    let confirmed = !keys.is_empty();
                    for k in keys {
                        let _ = rt.send_key(k).await;
                    }
                    // Only latch `trusted` once we actually sent the confirm — a
                    // parse miss must retry next tick, not silently fall through.
                    if confirmed {
                        trusted = true;
                    }
                }
                ReadyTick::EscapePicker => {
                    let _ = rt.send_key("Escape").await;
                    let _ = rt.send_key("Escape").await;
                    let _ = rt.send_key("C-c").await;
                    let _ = db::sessions::clear_cc(&state.pool, name).await;
                    escaped = true;
                }
                ReadyTick::StopBackgroundSession(id) => {
                    // Claude already exited — polling the rest of the window would
                    // just watch a bash prompt. Hand the id back so the caller can
                    // stop the background session and retry the launch.
                    return BootOutcome::BackgroundSession(id);
                }
                ReadyTick::Ready => return BootOutcome::Ready,
                ReadyTick::Wait => {}
            }
        }
    }
    BootOutcome::NotReady
}

/// Why [`wait_for_agent_ready`] stopped waiting. `bool` could not carry the one
/// failure the caller can actually FIX — see [`background_session_refusal`].
#[derive(Debug, PartialEq, Eq)]
enum BootOutcome {
    /// The agent took the wheel.
    Ready,
    /// Claude refused the resume: its own daemon holds this conversation as a
    /// background session. Carries the id to `claude stop`.
    BackgroundSession(String),
    /// The window ran out with no agent — the pre-existing failure mode.
    NotReady,
}

impl BootOutcome {
    fn is_ready(&self) -> bool {
        matches!(self, BootOutcome::Ready)
    }
}

// ── Bug A: the background-session refusal ───────────────────────────────────

/// The error type stamped on a session whose start was refused because Claude's
/// own daemon holds the conversation as a background session, and the automatic
/// remedy did not clear it. A NEW type on purpose: `holder_died` would be a lie
/// (the terminal is perfectly alive — it is sitting at a bash prompt), and the
/// badge's restart affordance cannot fix this one.
pub const BACKGROUND_SESSION: &str = "background_session";

/// How long `claude stop <id>` may run before we give up on it. Generous enough
/// for a cold daemon, short enough that it cannot hold the per-session start
/// lock open for a user staring at a spinner.
const BG_STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// **The Bug A remedy, automated.** `claude stop <id>` + ONE retry of the launch.
///
/// Called only when [`background_session_refusal`] matched an id that is OURS.
/// Returns the outcome of the retry (or of the failed stop), and stamps an honest
/// session error when the session still has no agent — the whole point of the
/// fix is that a start can never again end as a silent idle bash.
///
/// Neither the stop nor the retry is fatal to `start`: a session that cannot be
/// resumed is reported, not thrown. The `Result` exists only for the pane writes,
/// which fail exactly as the first launch's do.
///
/// And the resume link is NEVER cleared here — the deliberate opposite of
/// [`clear_stale_resume_link`], whose link points at a transcript that is GONE.
/// This conversation is alive and well; it is merely held open somewhere else, so
/// dropping the link would throw away exactly the history the human is trying to
/// get back (the manual remedy — `claude stop`, then Start — resumes it with full
/// context).
#[allow(clippy::too_many_arguments)]
async fn recover_background_session(
    rt: &dyn SessionRuntime,
    state: &AppState,
    s: &Session,
    name: &str,
    dir: &Path,
    env: &HashMap<String, String>,
    cmd: &str,
    id: &str,
    resume_intended: bool,
    resume_ids: &[&str],
) -> Result<BootOutcome, AppError> {
    tracing::warn!(
        name = %name,
        conversation = %id,
        "start: claude refused the resume — its daemon holds this conversation as a \
         background session; running `claude stop` and retrying the launch once",
    );
    let stopped = stop_background_session(dir, env, &config_dir_export(s), id).await;
    let mut outcome = BootOutcome::NotReady;
    if stopped {
        // The pane is back at a bash prompt (claude exited instantly), so the
        // launch line is typed exactly as the first time.
        rt.send_text(cmd).await?;
        submit_gap(rt).await;
        rt.send_key("Enter").await?;
        outcome = wait_for_agent_ready(rt, state, name, resume_intended, resume_ids, true).await;
    }
    if outcome.is_ready() {
        tracing::info!(
            name = %name,
            conversation = %id,
            "start: the background session was stopped and the resume came up on the retry",
        );
        return Ok(outcome);
    }
    // NEVER a silent idle bash. Say what happened and what the human can do.
    let message = format!(
        "Claude wouldn't resume conversation {id}: its own daemon still holds it as a \
         background session. supermux ran `claude stop {id}`{} and the session still did \
         not come up. From a terminal in this session's directory: `claude attach {id}` to \
         open it there, or `claude stop {id}` and press Start again.",
        if stopped { "" } else { " (which failed)" },
    );
    tracing::error!(
        name = %name,
        conversation = %id,
        stop_ok = stopped,
        "start: the background-session refusal survived the automatic `claude stop` + retry",
    );
    if state.set_error(name, BACKGROUND_SESSION.to_string(), message.clone()) {
        let _ = state.sse_tx.send(SseEvent {
            event: "sessions".to_string(),
            company_id: None,
            payload: json!({ "delta": [{
                "name": name,
                "error": { "type": BACKGROUND_SESSION, "message": message },
            }] }),
        });
    }
    Ok(outcome)
}

/// Run `claude stop <id>` for a conversation Claude's daemon holds as a
/// background session. `true` iff it exited 0 inside [`BG_STOP_TIMEOUT`].
///
/// A SUBPROCESS, not keystrokes into the pane: the pane is at a bash prompt after
/// claude's instant exit, and a subprocess gives an exit status to log instead of
/// another capture to guess at. It runs through `bash -lc` so `claude` resolves on
/// the same login PATH the launch line uses, in the session's own dir, with the
/// session's env and its `CLAUDE_CONFIG_DIR` export — a session with its own
/// Claude login must talk to ITS daemon, not the default one.
///
/// `id` comes from [`background_session_refusal`], which only ever returns
/// `[0-9a-f-]+`, and it is single-quoted on top of that.
async fn stop_background_session(
    dir: &Path,
    env: &HashMap<String, String>,
    config_dir_export: &str,
    id: &str,
) -> bool {
    let line = format!("{config_dir_export}claude stop '{id}'");
    let mut c = tokio::process::Command::new("bash");
    c.arg("-lc")
        .arg(&line)
        .current_dir(dir)
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    match tokio::time::timeout(BG_STOP_TIMEOUT, c.output()).await {
        Ok(Ok(out)) if out.status.success() => true,
        Ok(Ok(out)) => {
            tracing::warn!(
                conversation = %id,
                status = %out.status,
                stdout = %String::from_utf8_lossy(&out.stdout).trim(),
                stderr = %String::from_utf8_lossy(&out.stderr).trim(),
                "`claude stop` did not succeed",
            );
            false
        }
        Ok(Err(e)) => {
            tracing::warn!(conversation = %id, error = %e, "could not run `claude stop`");
            false
        }
        Err(_) => {
            tracing::warn!(
                conversation = %id,
                "`claude stop` timed out after {}s",
                BG_STOP_TIMEOUT.as_secs(),
            );
            false
        }
    }
}

/// Verify bounds for [`deliver_prompt`]. Worst case is
/// `VERIFY_POLLS * VERIFY_POLL` = 3s of extra wall-clock, and `start()` holds the
/// per-session lock across all of it — so these stay tight and are pinned by a
/// test. Even a healthy boot pays ONE `VERIFY_POLL` (~500ms): the first capture is
/// taken after the sleep, because a submit that landed still needs a frame to be
/// drawn.
const VERIFY_POLLS: usize = 6;
const VERIFY_POLL: Duration = Duration::from_millis(500);
/// How many extra Enters a stuck composer may receive. A spurious Enter on an
/// idle or busy composer is a no-op; on a SELECTOR it is a confirmation, which is
/// why [`submit_state`] stops the loop there.
const MAX_EXTRA_ENTERS: usize = 3;

/// Type the opening prompt, then VERIFY it actually submitted and press Enter
/// again — capped — when it did not.
///
/// THE BUG. `wait_for_agent_ready` returns Ready on the FIRST tick the agent UI is
/// at the wheel, and the agent's own glyphs are drawn before its input handler has
/// mounted. The Enter after the typed prompt is then occasionally swallowed (or
/// read as part of the paste, which is what `submit_gap` addresses), and the
/// prompt sits in the composer forever. Nothing downstream notices: `start()` has
/// already written `active` and `set_last_send` records the prompt as sent, so the
/// scheduler / board / a company's Router boot all believe work started while the
/// agent is idle at a full composer.
///
/// Send failures propagate — a real I/O error is a boot failure, as before.
/// Verification failure is NOT fatal: the session stays up so a human (or the next
/// send) can recover it.
///
/// The return value keeps "could not look" separate from "looked, and it is bad",
/// because those must not be reported the same way:
///
/// * `Ok(Some(true))` — observed submitted.
/// * `Ok(Some(false))` — the whole window was observed and the prompt still looks
///   stuck. The ONLY case the caller warns about.
/// * `Ok(None)` — delivered, not verifiable. Three cases, all deliberate:
///   a SHELL session (verification is built entirely on agent TUI signals; a shell
///   has no busy footer and echoes every command it runs, so every classification
///   would land on Stuck — firing retry Enters into the foreground process's stdin
///   and reporting a false negative on a perfectly good start); a composer that was
///   ALREADY BUSY before we typed (the double-launch guard delivers into a live
///   agent, where the busy footer is on screen from the first poll no matter what
///   our Enter did — the check would rubber-stamp a submit it never observed); and
///   a window in which every capture failed (we never saw the pane, so the
///   untouched `Unknown` must not be read as a cleared composer).
async fn deliver_prompt(
    rt: &dyn SessionRuntime,
    provider: &str,
    prompt: &str,
) -> Result<Option<bool>, AppError> {
    if provider == "shell" {
        rt.send_text(prompt).await?;
        submit_gap(rt).await;
        rt.send_key("Enter").await?;
        return Ok(None);
    }

    let pre_busy = rt
        .capture_plain(status::CAPTURE_LINES)
        .await
        .map(|c| agent_busy(&c))
        .unwrap_or(false);

    rt.send_text(prompt).await?;
    submit_gap(rt).await;
    rt.send_key("Enter").await?;

    if pre_busy {
        tracing::info!(
            provider = %provider,
            "deliver_prompt: agent was already mid-turn; prompt queued without verification",
        );
        return Ok(None);
    }

    let mut extra_enters = 0usize;
    let mut observed = false;
    let mut last = SubmitState::Unknown;
    for _ in 0..VERIFY_POLLS {
        tokio::time::sleep(VERIFY_POLL).await;
        let Ok(cap) = rt.capture_plain(status::CAPTURE_LINES).await else {
            continue; // capture hiccup: tells us nothing, keep polling
        };
        observed = true;
        last = submit_state(&cap, prompt);
        match last {
            SubmitState::Submitted => return Ok(Some(true)),
            SubmitState::Stuck if extra_enters < MAX_EXTRA_ENTERS => {
                extra_enters += 1;
                tracing::info!(
                    provider = %provider,
                    attempt = extra_enters,
                    "deliver_prompt: opening prompt still unsubmitted, pressing Enter again",
                );
                rt.send_key("Enter").await?;
            }
            // Cap reached, or nothing readable: keep watching out the window.
            SubmitState::Stuck | SubmitState::Unknown => {}
        }
    }
    if !observed {
        return Ok(None);
    }
    // The window closed on an Unknown: the prompt text is gone from the screen and
    // no turn is running — the composer cleared, so it submitted.
    Ok(Some(last == SubmitState::Unknown))
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
///
/// Thin wrapper over [`start_locked`], which runs [`mark_boot_failed`] on every
/// failure exit before the error propagates. The per-session lock is taken
/// HERE, not inside, so the failure stamp lands in the same critical section as
/// the boot it is correcting.
pub async fn start(
    state: &AppState,
    name: &str,
    prompt: Option<&str>,
) -> Result<StartResult, AppError> {
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;
    start_locked(state, name, prompt).await
}

/// Best-effort: record a failed boot as `stopped` so the row stops reading LIVE.
///
/// Without this a failed `start` leaves the runtime status at one of two values,
/// and `db::sessions::live_with_prefix` reads BOTH as live:
///   * `''` (the `ensure_runtime` default) when the failure beat the `starting`
///     write below. Empty falls to the freshness arm, and `created_at` is
///     seconds old, so the dead row blocks its own prefix for the whole quiet
///     window (2h by default).
///   * `starting` for any failure after that write. That one is live
///     unconditionally, so it blocks forever.
///
/// Either way the spawn guard would refuse to respawn the identity whose boot
/// just died, which is exactly backwards. The status detector cannot repair it
/// either: it declines to reclassify a session whose runtime is not alive.
///
/// `stopped`, not `error`: the `session_runtime` status CHECK (migration 0009)
/// rejects `error`.
///
/// Skipped when the runtime is in fact alive. A failure that leaves the agent
/// running (a send that did not land, say) belongs to the detector, and writing
/// `stopped` over a live session would be a lie its next tick has to undo.
/// Everything here is best-effort: the caller propagates the ORIGINAL error, so
/// a failed stamp is logged and never raised.
///
/// A stamped failure also runs the normal stop-time cleanup
/// ([`maybe_archive_on_stop`]), because a dead row is only half the problem: the
/// status detector and the steering deliver loop both hang off `exists_active`,
/// which filters `archived = 0`, so an unarchived dead row keeps two tokio loops
/// alive for the life of the process. The gate is `archive_on_stop = 1`, i.e.
/// exactly the scheduler/dispatcher's disposable spawns; human-, board- and
/// team-created sessions stay visible for inspection. Safe under the per-session
/// lock `start()` holds around this call for the same reason `stop()`'s call is:
/// `archive()` takes no session lock and its teardown is async-job-shaped, so it
/// never waits on this task.
async fn mark_boot_failed(state: &AppState, name: &str) {
    // No runtime row means no session to stamp (a start that failed on
    // `require_session`), and the write would be a silent no-op anyway.
    match db::sessions::runtime(&state.pool, name).await {
        Ok(Some(_)) => {}
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(name = %name, error = %e, "mark_boot_failed: runtime lookup failed");
            return;
        }
    }
    if let Ok(rt) = state.runtime_for(name).await {
        if rt.alive().await {
            return;
        }
    }
    match db::sessions::set_last_status(&state.pool, name, "stopped").await {
        Ok(()) => {
            broadcast_status(state, name, "stopped");
            // A failed boot IS a stop, so it gets the same cleanup: disposable
            // spawns archive themselves, which also ends their detector and
            // steering loops.
            maybe_archive_on_stop(state, name).await;
        }
        Err(e) => {
            tracing::warn!(name = %name, error = %e, "mark_boot_failed: could not stamp 'stopped'; the spawn guard may block this prefix until the quiet window elapses")
        }
    }
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

/// STALE-RESUME GUARD — drop a `--resume` link whose transcript is gone, so that
/// pressing Start actually starts something.
///
/// [`build_launch_command`] turns a stored `cc_conversation_id` into
/// `claude --resume '<id>'`. When that conversation's transcript no longer
/// exists, claude answers "No conversation found with session ID: …" and EXITS
/// immediately — the pane comes back as a bare shell wearing the session's name,
/// which the detector then settles as `idle`, and EVERY later Start resumes the
/// same dead id, so the session can never be brought back from the UI. (Found
/// live on `iwd-nl`: the pane showed the launch line, the refusal, then `$`.)
///
/// A human pressing Start is asking for this session to RUN, and a link that
/// points at nothing is not history worth keeping: clear it — in the column AND
/// in the in-memory row the launch builder reads — and let the launch fall
/// through to a clean `--name` start. That also keeps `resume_intended` FALSE,
/// which is what lets [`wait_for_agent_ready`] escape a resume picker it never
/// asked for instead of parking in it.
///
/// Deliberately narrow. [`super::auto_actions::dead_resume_link`] stays the ONE
/// owner of "is this link dead?" (claude rows only; a `cc_session_name` link is
/// resolved by claude's own name index rather than a file we can stat, and a row
/// with no link at all is an ordinary fresh start — neither is touched). And a
/// REMOTE session is skipped entirely: its transcripts live on the remote host,
/// while `resumable::project_dir_for` can only stat THIS host's `~/.claude`, so
/// "missing here" would be a lie about a link that is perfectly alive there.
///
/// Returns the id that was dropped (for the tests; the log line is emitted here).
async fn clear_stale_resume_link(
    state: &AppState,
    name: &str,
    s: &mut Session,
) -> Result<Option<String>, AppError> {
    if s.host_id.is_some() {
        return Ok(None);
    }
    let Some(conv) = super::auto_actions::dead_resume_link(s).map(str::to_string) else {
        return Ok(None);
    };
    db::sessions::clear_cc_conversation_id(&state.pool, name).await?;
    s.cc_conversation_id.clear();
    tracing::info!(
        session = name,
        conversation = %conv,
        "start: the resume link's transcript is gone — cleared it and starting clean",
    );
    Ok(Some(conv))
}

/// The body of [`start`], assuming the per-session lock is ALREADY held. Split
/// out so [`start_if_stopped`] can wrap it with an atomic precondition without
/// re-entering the (non-reentrant) lock.
///
/// Every failure exit runs [`mark_boot_failed`] before the error propagates, so
/// a boot that died never leaves its row reading LIVE to the spawn guard. It
/// sits here rather than in [`start`] so the auto-heal path
/// ([`start_if_stopped`]), which calls this directly, is covered too.
async fn start_locked(
    state: &AppState,
    name: &str,
    prompt: Option<&str>,
) -> Result<StartResult, AppError> {
    match start_locked_inner(state, name, prompt).await {
        Ok(result) => Ok(result),
        Err(e) => {
            mark_boot_failed(state, name).await;
            Err(e)
        }
    }
}

async fn start_locked_inner(
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

    // START MUST ACTUALLY START. A resume link whose transcript is gone would
    // exit claude straight back to a shell (see [`clear_stale_resume_link`]), so
    // drop it BEFORE anything is spawned or launched. Every start path funnels
    // through `start_locked`, so this one call covers the Start button, the
    // restart, the recover and the scheduler alike.
    clear_stale_resume_link(state, name, &mut s).await?;

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
        // A session booting on its OWN Claude account (migration 0041) reads
        // `<config_dir>/settings.json`, not the daemon's — so installing the
        // hooks into the daemon's file would leave that session with no hook
        // reporting at all, falling back to the regex bank + pty heartbeat (the
        // known "stuck active" failure mode). `install_hooks` already takes an
        // explicit settings path for exactly this kind of override; point it at
        // the session's account so a second-account session is a first-class
        // one. Local only: `config_dir` is refused for remote rows on create,
        // and the remote branch resolves a relative path against the far $HOME.
        let settings_override = (!s.config_dir.is_empty() && s.host_id.is_none())
            .then(|| std::path::Path::new(&s.config_dir).join("settings.json"));
        if let Err(e) = crate::claude_config::install_hooks(
            name,
            &hook_token,
            transport.as_ref(),
            settings_override.as_deref(),
        )
        .await
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

        // THE GROUND UNDER US. The sibling `holder_bin` guard above names a
        // missing BINARY; this one names a missing CWD. A stored `dir` that no
        // longer exists (a worktree removed, a project moved) fails ENOENT
        // inside `cmd.spawn()` down in the runtime, and `AppError::Internal`
        // deliberately answers a bare 500 "internal server error" — so the one
        // fact the user can actually act on never reaches the wire. Say it here.
        //
        // LOCAL ROWS ONLY: a remote session's `dir` lives on the far side of the
        // SSH ControlMaster, where this `is_dir()` would measure the wrong box.
        // Gated on `host_id`, not runtime, so a local tmux row is covered too —
        // and it needs to be: the same opaque 500 was reachable on a local tmux
        // row as well, where the ENOENT surfaces as a "spawn pty holder" or a
        // bare tmux error rather than as anything the user can act on.
        //
        // INSIDE `freshly_spawned` deliberately: a start on an already-alive
        // session (resume, or a plain no-op) never spawns and stays
        // byte-identical, so a dir deleted under a RUNNING agent does not
        // newly fail the resume that still works.
        if s.host_id.is_none() && !dir.is_dir() {
            return Err(AppError::BadRequest(format!(
                "session directory '{}' does not exist; create it or update the session's directory",
                s.dir
            )));
        }

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
            // The conversation ids THIS launch could be refused for — the only
            // ids we will ever `claude stop` (see `background_session_refusal`).
            let resume_ids: Vec<&str> = [s.cc_conversation_id.as_str(), s.cc_session_name.as_str()]
                .into_iter()
                .filter(|id| !id.is_empty())
                .collect();
            let mut outcome =
                wait_for_agent_ready(rt.as_ref(), state, name, resume_intended, &resume_ids, false)
                    .await;
            if let BootOutcome::BackgroundSession(id) = &outcome {
                outcome = recover_background_session(
                    rt.as_ref(),
                    state,
                    &s,
                    name,
                    &dir,
                    &env,
                    &cmd,
                    &id.clone(),
                    resume_intended,
                    &resume_ids,
                )
                .await?;
            }
            outcome.is_ready()
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
            prompt_submitted: None, // nothing was typed on this path
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

    let mut prompt_submitted = None;
    if let Some(p) = prompt {
        if !p.trim().is_empty() {
            prompt_submitted = deliver_prompt(rt.as_ref(), &s.provider, p).await?;
            if prompt_submitted == Some(false) {
                // Honest, and only where it was actually looked at: the boot ran,
                // the session is up, but the first turn never started. Every caller
                // of `start(prompt)` — scheduler, board, a company's Router boot —
                // otherwise reads the `active` row we just wrote as "working".
                tracing::warn!(
                    name = %name,
                    "start: opening prompt still looked unsubmitted after capped Enter retries; \
                     session left running for recovery",
                );
            }
            let (preview, at) = db::sessions::set_last_send(&state.pool, name, p).await?;
            broadcast_send(state, name, &preview, at);
        }
    }

    Ok(StartResult {
        name: name.to_string(),
        started: true,
        ready,
        prompt_submitted,
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

    // Capture the lead agent PID while the pane is still up: the agent-team
    // tmux server is named `claude-swarm-<lead pid>` and after teardown the
    // pid is unrecoverable. Teardown itself waits for the lead to die.
    let swarm_lead = if crate::sessions::swarm::teardown_enabled(state) {
        crate::sessions::swarm::lead_pid_of(rt.as_ref()).await
    } else {
        None
    };

    if !rt.alive().await {
        db::sessions::set_last_status(&state.pool, name, "stopped").await?;
        broadcast_status(state, name, "stopped");
        emit_board_if_linked(state, name).await;
        // Disposable (archive_on_stop) sessions archive themselves on stop.
        maybe_archive_on_stop(state, name).await;
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
    // The team's swarm server is reaped off the pid captured before the kill,
    // ahead of the archive below: `archive` runs its own teardown, but by then
    // the pane is gone and there is no foreground pid left to read.
    if let Some(pid) = swarm_lead {
        crate::sessions::swarm::spawn_teardown_for_lead(pid);
    }
    // Disposable (archive_on_stop) sessions archive themselves on stop.
    maybe_archive_on_stop(state, name).await;
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
                // THE REFUSAL NAMES WHAT IS ACTUALLY IN THE WAY (owner report).
                // It used to say "parked at a prompt that is not the agent's …
                // likely sitting on a resume picker or a folder-trust dialog"
                // for every screen that failed the guard — including a Claude
                // question, which is neither, and which is now admitted. See
                // `send_block`.
                if let Some(block) = send_block(&status::prepare_capture(&raw)) {
                    return Err(AppError::Conflict(block.sentence(name)));
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

/// Archive `name` IFF it is a live, `archive_on_stop`-flagged session -- the
/// shared hook behind "disposable sessions clean themselves up when they
/// stop". Best-effort and idempotent: the `archive_pending` gate (row live AND
/// flagged AND not already archived) means a duplicate call -- e.g. an explicit
/// Stop racing the Claude `SessionEnd` hook -- is a no-op in practice: the gate
/// suppresses it. The check and the flip are separate statements, so a rare
/// exactly-simultaneous race could still write one extra `session.archive` audit
/// row, but the SSE delta and teardown are both idempotent. `archive()` takes no
/// session lock, so this is
/// safe to call from `stop()` while it still holds one. Errors are logged, never
/// propagated (archiving is a courtesy, not part of the stop contract).
pub async fn maybe_archive_on_stop(state: &AppState, name: &str) {
    match db::sessions::archive_pending(&state.pool, name).await {
        Ok(true) => {
            if let Err(e) = archive(state, name).await {
                tracing::warn!(name = %name, error = %e, "auto-archive on stop failed");
            } else {
                tracing::info!(name = %name, "auto-archived disposable session on stop");
            }
        }
        Ok(false) => {}
        Err(e) => tracing::debug!(name = %name, error = %e, "archive_pending check failed"),
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
            // capture before the kill; teardown waits for the lead to die
            if crate::sessions::swarm::teardown_enabled(&state) {
                if let Some(pid) = crate::sessions::swarm::lead_pid_of(rt.as_ref()).await {
                    crate::sessions::swarm::spawn_teardown_for_lead(pid);
                }
            }
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
//   | Restart        | conversation, worktree, workflows  | live pty + in-memory buffer |
//   | Reset          | worktree, workflows, config        | conversation + scrollback   |
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
/// workflows. Destroys the live pty and whatever scrollback lived only in it.
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
/// the worktree, the branch, the workflows, the config, the session's identity
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

    /// The send guard as a yes/no — the shape the wave-7/8 tests were written
    /// against, kept so each of them reads as one assertion. `None` from
    /// [`send_block`] IS "ready": every refusal is one of its variants.
    fn pty_ready_for_send(capture: &str) -> bool {
        send_block(capture).is_none()
    }

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
    fn accept_trust_navigates_to_yes_when_no_exit_is_the_default() {
        // THE reported bug: a newer Claude Code lists "No, exit" FIRST and selects
        // it by default, so the old bare Enter quit the session at boot. Verbatim
        // shape from the report (IMG_2950): "No, exit" cursored, "Yes" beneath.
        let cap = "/opt/projects/companies/persoonlijk/persoonlijk-assistant\n\n\
                   Quick safety check: Is this a project you created or one you trust?\n\n\
                   Claude Code'll be able to read, edit, and execute files here.\n\n\
                   Security guide\n\n\
                   ❯ No, exit\n  Yes, I trust this folder\n\n\
                   Enter to confirm · Esc to cancel";
        assert!(at_trust_dialog(cap));
        assert_eq!(
            keys_to_accept_trust(cap),
            vec!["Down", "Enter"],
            "must step down onto Yes, never confirm the No default",
        );
    }

    #[test]
    fn accept_trust_is_a_bare_enter_when_yes_is_already_the_default() {
        // The older layout: "Yes" is option 1 and already cursored → just confirm.
        let cap = "Is this a project you created or one you trust?\n \
                   ❯ 1. Yes, I trust this folder\n   2. No, exit";
        assert_eq!(keys_to_accept_trust(cap), vec!["Enter"]);
    }

    #[test]
    fn accept_trust_ignores_the_dialog_header_that_also_says_trust() {
        // REGRESSION: the real header IS "Do you trust the files in this folder?",
        // so matching any line that mentions trust locked onto the header (line 0)
        // and every layout read as "Yes is above the cursor" → an Up that wraps a
        // two-option menu onto "No, exit". Both real layouts must still be right.
        let old = "Do you trust the files in this folder?\n\
                   ❯ 1. Yes, I trust this folder\n   2. No, exit";
        assert_eq!(keys_to_accept_trust(old), vec!["Enter"]);
        let flipped = "Do you trust the files in this folder?\n\
                       ❯ No, exit\n  Yes, I trust this folder";
        assert_eq!(keys_to_accept_trust(flipped), vec!["Down", "Enter"]);
    }

    #[test]
    fn accept_trust_reads_the_alternate_cursor_glyph() {
        // Claude Code has drawn the menu cursor as `›` as well as `❯`; a glyph we
        // don't know is a parse miss that hangs the boot to timeout.
        let cap = "Do you trust the files in this folder?\n› No, exit\n  Yes, I trust this folder";
        assert_eq!(keys_to_accept_trust(cap), vec!["Down", "Enter"]);
    }

    #[test]
    fn accept_trust_steps_up_when_yes_is_above_the_cursor() {
        let cap = "  Yes, I trust this folder\n❯ No, exit";
        assert_eq!(keys_to_accept_trust(cap), vec!["Up", "Enter"]);
    }

    #[test]
    fn accept_trust_waits_rather_than_blind_enter_when_yes_is_absent() {
        // Parse miss (no affirmative line, or no cursor) → empty: wait & retry, so
        // a stray Enter can never confirm "No, exit". `wait_for_agent_ready` leaves
        // `trusted` false on an empty result and re-scans next tick.
        assert!(keys_to_accept_trust("some unrelated capture with a ❯ prompt").is_empty());
        assert!(keys_to_accept_trust("Yes, I trust this folder\n  No, exit").is_empty()); // no cursor glyph
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
            classify_ready_tick(picker, /*resume_intended*/ true, /*escaped*/ false, /*trusted*/ false, &[], false),
            ReadyTick::Wait,
            "a picker we deliberately do not escape must keep the ready-poll WAITING, \
             so the heal times out to ready=false (a FAILED heal), not a false success",
        );
        // The trust dialog is the sibling boot modal: also `❯`, also not ready.
        let trust = "Quick safety check: do you trust the files in this folder?\n❯ 1. Yes";
        assert_eq!(
            classify_ready_tick(trust, true, false, false, &[], false),
            ReadyTick::AcceptTrust,
            "trust dialog is dismissed, not treated as ready",
        );
        // A real composer prompt (no modal) is the ONLY thing that reads Ready.
        assert_eq!(
            classify_ready_tick(
                "❯ Try \"fix tests\"\n  ⏵⏵ bypass permissions on",
                true,
                false,
                false,
                &[],
                false,
            ),
            ReadyTick::Ready,
            "the agent's own prompt, with no boot modal over it, is ready",
        );
    }


    // ── Bug A: Claude's background-session refusal ───────────────────────────

    /// The refusal EXACTLY as claude printed it on this box (session `Reisposter`,
    /// whose conversation was also registered as a Claude Code daemon background
    /// session). claude exited instantly on this line, so the owner saw the
    /// terminal flash and vanish and the session sat idle over a bare bash.
    const LIVE_REFUSAL: &str = "\
$ claude --resume 'a30d387a-2ff1-4c9e-8f0a-7b1d2e3c4a5b'
Session a30d387a-2ff1-4c9e-8f0a-7b1d2e3c4a5b is running as a background session \
(a30d387a). Run `claude attach a30d387a` to open it, or `claude stop a30d387a` first \
to resume it here. Add --fork-session to branch off a copy instead.
$ ";
    /// Our conversation id in the captures below.
    const OURS: &str = "a30d387a-2ff1-4c9e-8f0a-7b1d2e3c4a5b";

    /// Hard-wrap `text` at `cols`, the way a narrow pane does — mid-word, no
    /// hyphen, no regard for the sentence.
    fn wrap_at(text: &str, cols: usize) -> String {
        let mut out = String::new();
        for line in text.lines() {
            let chars: Vec<char> = line.chars().collect();
            for (i, chunk) in chars.chunks(cols).enumerate() {
                if i > 0 {
                    out.push('\n');
                }
                out.extend(chunk);
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn background_session_refusal_reads_the_live_line() {
        assert_eq!(
            background_session_refusal(LIVE_REFUSAL, &[OURS]).as_deref(),
            Some("a30d387a"),
            "the id handed to `claude stop` is the short one claude itself printed",
        );
    }

    /// The pane is 80 columns on a phone and this sentence WRAPS — mid-word. A
    /// needle with a space in it would be a coin flip, which is why both sides are
    /// whitespace-squeezed before matching.
    #[test]
    fn background_session_refusal_survives_an_80_col_wrap() {
        let wrapped = wrap_at(LIVE_REFUSAL, 80);
        assert!(
            wrapped.lines().count() > LIVE_REFUSAL.lines().count(),
            "precondition: the fixture actually wrapped",
        );
        assert_eq!(
            background_session_refusal(&wrapped, &[OURS]).as_deref(),
            Some("a30d387a"),
        );
        // …and at a width that splits the needle itself.
        assert_eq!(
            background_session_refusal(&wrap_at(LIVE_REFUSAL, 34), &[OURS]).as_deref(),
            Some("a30d387a"),
        );
    }

    /// NEVER `claude stop` an id that is not ours. A refusal naming somebody
    /// else's conversation (a shared pane, a stale scrollback line) must return
    /// nothing: killing another agent's background session is far worse than one
    /// failed start.
    #[test]
    fn background_session_refusal_ignores_a_foreign_id() {
        let foreign = "Session ffffffff-0000-1111-2222-333344445555 is running as a background \
                       session (ffffffff). Run `claude stop ffffffff` first to resume it here.";
        assert_eq!(background_session_refusal(foreign, &[OURS]), None);
        // …and a session with no resume link at all can never match either.
        assert_eq!(background_session_refusal(LIVE_REFUSAL, &[]), None);
    }

    /// A row that resumes BY NAME matches when claude echoes that name, and an
    /// ordinary screen never matches at all.
    #[test]
    fn background_session_refusal_needs_the_refusal() {
        assert_eq!(
            background_session_refusal("❯ Try \"fix tests\"\n  ? for shortcuts", &[OURS]),
            None,
        );
        assert_eq!(background_session_refusal("", &[OURS]), None);
    }

    /// The tick: the refusal is actionable ONCE. After the automatic `claude stop`
    /// + retry it must never fire again (that would stop the conversation we just
    /// resumed), and a live agent drawn over the same scrollback always wins.
    #[test]
    fn the_refusal_is_a_one_shot_and_never_beats_a_live_agent() {
        assert_eq!(
            classify_ready_tick(LIVE_REFUSAL, true, false, false, &[OURS], false),
            ReadyTick::StopBackgroundSession("a30d387a".to_string()),
        );
        assert_eq!(
            classify_ready_tick(LIVE_REFUSAL, true, false, false, &[OURS], true),
            ReadyTick::Wait,
            "one shot: a second refusal is a failure to report, not a loop to run",
        );
        let recovered = format!("{LIVE_REFUSAL}\n❯ Try \"fix tests\"\n  ⏵⏵ bypass permissions on");
        assert_eq!(
            classify_ready_tick(&recovered, true, false, false, &[OURS], false),
            ReadyTick::Ready,
            "the refusal stays in the scrollback after a successful retry — the agent wins",
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
            classify_ready_tick(picker, false, false, false, &[], false),
            ReadyTick::EscapePicker,
        );
        assert_eq!(
            classify_ready_tick(picker, false, /*escaped*/ true, false, &[], false),
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
        // This is the ONLY shape that admits: positive evidence of a text
        // composer, not the absence of a modal.
        assert!(
            pty_ready_for_send("❯ Try \"fix tests\"\n  ? for shortcuts"),
            "the agent's own idle prompt is the send target",
        );
        // …and the composer glyph is not enough on its own when it is marking a
        // ROW rather than opening the composer — the exact confusion that made a
        // dialog read as "the agent is at the wheel".
        assert!(
            !pty_ready_for_send("Pick one\n❯ 1. Apple\n  2. Banana"),
            "a selection cursor is the same glyph as the composer's — it must not admit",
        );
        // REFUSE — a permission menu. THIS ASSERTION IS REVERSED FROM WAVE-7, on
        // purpose and after the fact it rested on was checked: this menu is
        // "typeable" only in the sense that the keystrokes land somewhere. The
        // paste is dropped and the Enter picks the highlighted row (a0 §3), so a
        // message sent here is silently destroyed AND an answer nobody chose is
        // submitted — while the caller is told it was delivered. The browser has
        // a lens in front of this; `delegate`, the scheduler, the board and the
        // steering loop do not, and this is the only guard they get.
        assert_eq!(
            send_block("Do you want to proceed?\n❯ 1. Yes\n  2. No"),
            Some(SendBlock::Selection),
            "a permission menu is answered with a keypress, not with text — refuse",
        );
        // ADMIT — a busy turn: the send is a legitimate QUEUE, and the composer
        // glyph may have scrolled out of a short capture, so `esc to interrupt`
        // carries the decision.
        assert!(
            pty_ready_for_send("✻ Thinking… (esc to interrupt · 12s · ↑ 2.1k tokens)"),
            "a send while the agent is mid-turn is a queue, not a swallow",
        );
    }

    /// THE OWNER'S WEDGE, and what was actually wrong with it: a live
    /// AskUserQuestion refused every message with a 409 that named two dialogs
    /// which were not on screen.
    ///
    /// The refusal was RIGHT and the sentence was WRONG, and only the sentence
    /// is fixed. Wave-8 reached it by accident — its bottom-10 window happened
    /// to miss the `❯` caret, which on the real 2.1.233 capture
    /// (`tests/fixtures/pty/ask-user-question.txt`) sits at row 29 of 39, above
    /// four option rows with description lines, the rule, the out-of-box row and
    /// the footer. The SAME dialog with two options and no descriptions keeps
    /// its caret in range and was admitted, which is the tell that the reading
    /// was positional rather than semantic. Now the dialog's own key legend —
    /// bottom-anchored by construction — refuses it on purpose, and the
    /// two-option twin refuses with it.
    #[test]
    fn a_send_while_claude_asks_a_question_is_refused_as_a_selection_not_a_boot_modal() {
        let capture = status::prepare_capture(include_str!(
            "../../tests/fixtures/pty/ask-user-question.txt"
        ));
        let block = send_block(&capture).expect("a question is answered with a keypress");
        assert_eq!(
            block,
            SendBlock::Selection,
            "an open question must refuse — the paste would be dropped and the Enter would \
             pick the highlighted row",
        );
        // The SENTENCE is the fix: it no longer sends the reader looking for a
        // resume picker or a folder-trust dialog that is not on screen.
        let sentence = block.sentence("ipc");
        assert!(sentence.contains("NOT delivered"), "{sentence}");
        assert!(!sentence.contains("resume picker"), "{sentence}");
        assert!(!sentence.contains("folder-trust"), "{sentence}");

        // The SHORT twin — the same dialog, two options, no descriptions — used
        // to be admitted purely because its caret fell inside the window. It is
        // the same screen and it refuses the same way now.
        let short = "Which fruit do you want?\n❯ 1. Apple\n  2. Banana\n\nEnter to select · ↑/↓ to navigate · Esc to cancel";
        assert_eq!(send_block(short), Some(SendBlock::Selection));

        // The ANSWERED twin — the same session one keystroke later, back at its
        // composer — must still deliver. This is the half of the owner's report
        // that IS an un-wedge: an idle agent takes messages.
        let answered = status::prepare_capture(include_str!(
            "../../tests/fixtures/pty/ask-user-question-answered.txt"
        ));
        assert_eq!(
            send_block(&answered),
            None,
            "once the dialog is gone the composer is back, and a message is a message",
        );
    }

    /// ADMISSION IS POSITIVE, AND NARROW. Not "no modal was recognised" — that
    /// is the fail-OPEN reading, and the pty is a terminal a human also drives by
    /// hand, so an unrecognised screen is at least as likely to be `npm init` as
    /// it is to be an agent.
    #[test]
    fn only_a_recognised_composer_admits_a_send() {
        // ADMIT: Claude's composer (glyph + its own hint line), Codex's ready
        // composer, and a busy turn (CC queues typed text during one).
        for screen in [
            "❯ Try \"fix tests\"\n  ? for shortcuts",
            "❯ \n  ⏵⏵ auto mode on\n  ? for shortcuts",
            "› Ask Codex to do anything\n  gpt-5.6-sol high · /opt/projects/Folderwijzer-codex",
            "✻ Thinking… (esc to interrupt · 12s · ↑ 2.1k tokens)",
        ] {
            assert_eq!(send_block(screen), None, "must admit: {screen:?}");
        }

        // REFUSE: everything a foreign interactive program draws into the same
        // pane. None of these is a Claude dialog and none of them may receive a
        // paste + Enter — `[y/N]` under an Enter is a destructive confirmation,
        // and `delegate` / the scheduler reach this with no lens in front.
        for screen in [
            // inquirer-style list (npm init, create-*, gh)
            "? Which template? (Use arrow keys)\n❯ 1. minimal\n  2. full",
            "? Overwrite dist/? (Use arrow keys)\n> Yes\n  No",
            // a shell confirmation
            "Delete 42 branches? [y/N] ",
            // a numbered menu with the caret, no legend at all
            "❯ 1. production\n  2. staging",
        ] {
            assert_eq!(
                send_block(screen),
                Some(SendBlock::Selection),
                "must refuse: {screen:?}",
            );
        }

        // REFUSE: an unrecognised screen. The default is closed.
        assert_eq!(send_block("some program printing along\nno prompt we know"), Some(SendBlock::NoAgent));
    }

    /// REGRESSION: a swarm/teammate roster drawn BELOW the composer + footer
    /// pushes them out of the 10-line tail, so a tail-only presence check refused
    /// a healthy busy agent (`NoAgent`) — breaking chat and scheduled delivery.
    /// Agent presence read over the whole capture must ADMIT.
    #[test]
    fn a_teammate_roster_below_the_composer_still_admits() {
        let screen = "  the real capture confirms the root cause here.\n\
                      \n\
                      ● Bash(curl … /api/sessions/supermux/peek)\n\
                      \x20 ⎿ Running…\n\
                      \n\
                      ✽ Waddling… (8m 6s · ↓ 26.0k tokens)\n\
                      \n\
                      ─ View teammates: `tmux -L claude-swarm-3193337 a` ─\n\
                      ❯ \n\
                      ────────────────────────────────────────────────────\n\
                      \x20 ⏵⏵ bypass permissions on · 1 shell · esc to int…\n\
                      \x20           ✔ Update installed · Restart to update\n\
                      \n\
                      \x20 ● main\n\
                      \x20 ◯ build-lightbox         You are a s… 9h 25m 43s\n\
                      \x20 ◯ build-settings         You are a s… 9h 25m 18s\n\
                      \x20 ◯ build-delaysend        You are a s… 9h 24m 54s\n\
                      \x20 ◯ spec-workflows         You are a s…  9h 24m 6s\n\
                      \x20 ↓ 27 more";
        assert_eq!(
            send_block(&status::prepare_capture(screen)),
            None,
            "a live agent whose composer/footer sit above a teammate roster must admit",
        );
    }

    /// A PICKER WHOSE TITLE HAS SCROLLED OUT still refuses.
    ///
    /// `at_resume_picker` reads the whole capture, but the capture is 30 lines:
    /// a picker with a long conversation list pushes `Resume a conversation` off
    /// the top, and then the title-based check sees nothing. The legend the
    /// picker keeps drawing at the bottom is what catches it — one rung lower in
    /// the ladder, with a sentence that is true of both.
    #[test]
    fn a_resume_picker_whose_title_scrolled_out_is_still_refused() {
        let mut screen = String::new();
        for i in 0..26 {
            screen.push_str(&format!("  {}. Fix the parser — {i}h ago\n", i + 3));
        }
        screen.push_str("\nEnter to select · Esc to cancel\n");
        assert!(
            !screen.contains("Resume a conversation"),
            "the fixture must NOT carry the title — that is the whole point",
        );
        assert_eq!(
            send_block(&status::prepare_capture(&screen)),
            Some(SendBlock::Selection),
            "a picker recognised by its legend rather than its title still refuses",
        );
    }

    /// Every refusal says its own name. Before this, ANY screen that failed the
    /// positive check was reported as "parked at a prompt that is not the
    /// agent's … likely sitting on a resume picker or a folder-trust dialog" —
    /// false for a question, false for a bare shell, and un-actionable in both.
    #[test]
    fn a_refused_send_names_the_screen_that_is_actually_in_the_way() {
        let picker = "Resume a conversation\n❯ 1. Fix the parser  2h ago\n  2. Older chat";
        assert_eq!(send_block(picker), Some(SendBlock::ResumePicker));
        assert!(
            send_block(picker).unwrap().sentence("ipc").contains("resume picker"),
            "the sentence names the picker, and nothing else",
        );

        let trust = "Quick safety check: do you trust the files in this folder?\n❯ 1. Yes";
        assert_eq!(send_block(trust), Some(SendBlock::Gate("trust")));
        assert!(send_block(trust).unwrap().sentence("ipc").contains("folder-trust"));

        // Codex's hooks-review gate: refused before this change too, but only as
        // the residue of finding no agent glyph. Now it is refused BY NAME.
        let hooks = status::prepare_capture(include_str!(
            "../../tests/fixtures/pty/codex-hooks-review.txt"
        ));
        assert_eq!(send_block(&hooks), Some(SendBlock::Gate("hooks-review")));
        assert!(send_block(&hooks).unwrap().sentence("ipc").contains("hooks-review"));

        // A selection screen says what it is and what would have happened — a
        // reader who is told "a keypress, not text" knows why retrying the same
        // message will not help.
        let selection = send_block("Pick one\n❯ 1. Apple\n  2. Banana").unwrap();
        assert_eq!(selection, SendBlock::Selection);
        assert!(selection.sentence("ipc").contains("keypress"));
        assert!(!selection.sentence("ipc").contains("resume picker"));

        // The bare shell keeps its own sentence — it is not a modal, and telling
        // the user to dismiss one would send them looking for a screen that is
        // not there.
        let bare = send_block("user@host project % \n").unwrap();
        assert_eq!(bare, SendBlock::NoAgent);
        assert!(bare.sentence("ipc").contains("no agent composer"));
        assert!(!bare.sentence("ipc").contains("resume picker"));
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

    // ── opening-prompt submission classifier ─────────────────────────────────

    #[test]
    fn a_running_turn_reads_as_submitted() {
        let prompt = "You are the operator, boot now";
        assert_eq!(
            submit_state("❯ You are the operator, boot now\n✻ Thinking… (esc to interrupt · 3s)", prompt),
            SubmitState::Submitted,
        );
    }

    /// The busy footer is read over the WHOLE capture: a teammate roster drawn
    /// BELOW it pushes it clean out of the 10-line current screen (the same shape
    /// that broke the send guard), and a missed busy footer here means retry
    /// Enters into a working agent.
    #[test]
    fn a_running_turn_under_a_teammate_roster_still_reads_as_submitted() {
        let cap = "✻ Thinking… (esc to interrupt · 3s)\n\
                   View teammates:\n● main\n◯ bot-a\n◯ bot-b\n◯ bot-c\n\
                   ◯ bot-d\n◯ bot-e\n◯ bot-f\n◯ bot-g\n◯ bot-h\n↓ 4 more";
        assert_eq!(submit_state(cap, "boot now"), SubmitState::Submitted);
    }

    /// THE BUG ITSELF: the Enter was swallowed and the prompt is still sitting in
    /// the composer, hard-wrapped inside Claude's box. The tail match has to survive
    /// both the line breaks and the `│` borders drawn through the text.
    #[test]
    fn a_prompt_still_in_the_wrapped_composer_reads_as_stuck() {
        let prompt = "You are the platform operator, booted by the scheduler. \
                      Read prompts/platform.md next to it, then follow it exactly.";
        let cap = "╭──────────────────────────────────────────╮\n\
                   │ ❯ You are the platform operator, booted  │\n\
                   │   by the scheduler. Read                 │\n\
                   │   prompts/platform.md next to it, then   │\n\
                   │   follow it exactly.                     │\n\
                   ╰──────────────────────────────────────────╯\n\
                   ⏵⏵ bypass permissions on";
        assert_eq!(submit_state(cap, prompt), SubmitState::Stuck);
    }

    #[test]
    fn a_cleared_composer_reads_as_unknown() {
        assert_eq!(
            submit_state("❯ Try \"fix tests\"\n  ? for shortcuts", "boot the operator and report"),
            SubmitState::Unknown,
        );
    }

    /// The arm that makes retrying safe at all. The prompt submitted, the agent ran
    /// and is now parked on a permission menu: nothing is working, so without this
    /// the classifier says Stuck and the retry Enter CONFIRMS the highlighted row.
    #[test]
    fn an_approval_selector_reads_as_submitted_so_no_enter_confirms_it() {
        let cap = "  Bash(rm -rf ./build)\n  Do you want to proceed?\n\
                   ❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\
                   Enter to confirm · Esc to cancel";
        assert_eq!(submit_state(cap, "clean the build dir and rerun the tests"), SubmitState::Submitted);
    }

    /// A prompt that OPENS with a numbered item is drawn `❯ 1. …` — the exact shape
    /// `is_selection_row` matches. Read as a selector it would report a confident
    /// Submitted with zero retries on a genuinely stuck boot.
    #[test]
    fn a_numbered_prompt_echo_is_not_mistaken_for_a_selector() {
        let prompt = "1. check the queue, 2. answer the oldest issue";
        let cap = "❯ 1. check the queue, 2. answer the oldest issue\n  ? for shortcuts";
        assert_eq!(submit_state(cap, prompt), SubmitState::Stuck);
    }

    /// Same trap through the key-legend markers, which are unanchored substrings a
    /// prompt can carry verbatim.
    #[test]
    fn a_prompt_echo_carrying_a_key_legend_is_not_mistaken_for_a_selector() {
        let prompt = "if the deploy hangs, tell the user to press esc to cancel";
        let cap = "❯ if the deploy hangs, tell the user to press esc to cancel\n  ? for shortcuts";
        assert_eq!(submit_state(cap, prompt), SubmitState::Stuck);
    }

    /// The echo filter runs per LINE, so a GENUINE selector drawn underneath an
    /// echoed prompt is still seen — guarding on the prompt as a whole would switch
    /// the safe arm off for exactly the prompts that carry a token.
    #[test]
    fn a_real_selector_under_an_echoed_prompt_still_reads_as_submitted() {
        let prompt = "1. check the queue, 2. answer the oldest issue";
        let cap = "❯ 1. check the queue, 2. answer the oldest issue\n\
                   Do you want to proceed?\n❯ 1. Yes\n  2. No, keep going";
        assert_eq!(submit_state(cap, prompt), SubmitState::Submitted);
    }

    /// Codex coverage, ported from pjbakker/feat/prompt-delivery-verification.
    /// Codex draws its approval selector under a `›` cursor and confirms with
    /// "Press enter to confirm", so the selector arm has to fire on a glyph the
    /// Claude fixtures never exercise — that arm is the only thing stopping a
    /// retry Enter from confirming a highlighted destructive default.
    #[test]
    fn submit_state_reads_a_codex_approval_selector_as_submitted() {
        assert_eq!(
            submit_state(
                "› run the deploy script\n› 1. Yes\n› 2. No\nPress enter to confirm",
                "run the deploy script",
            ),
            SubmitState::Submitted,
        );
    }

    /// THE ONE THAT MATTERS. The fixture above passes on its "Press enter to
    /// confirm" LEGEND, not on its `›` rows — delete that one line and it went
    /// `Stuck`, so the selector arm could be completely blind to Codex and the suite
    /// would stay green. Codex previews the proposed command ABOVE the options; a
    /// preview a few lines tall pushes the legend out of the 10-line
    /// [`current_screen_tail`] window (while `agent_busy` still reads all 30),
    /// leaving nothing but the rows themselves.
    ///
    /// Before [`strip_selection_caret`] learned `›` this scored `Stuck`, and
    /// `deliver_prompt` answers `Stuck` with up to three Enters — CONFIRMING the
    /// highlighted option of an approval dialog nobody read.
    #[test]
    fn a_codex_selector_with_no_key_legend_is_still_submitted() {
        // The dangerous screen in full. The prompt is ECHOED (which is what makes
        // the fallback arm score `Stuck` rather than the harmless `Unknown`), the
        // command preview is tall enough to push the legend out of the 10-line
        // window, and the approval rows are all that is left.
        let preview =
            (1..=8).map(|i| format!("  preview line {i}")).collect::<Vec<_>>().join("\n");
        let cap = format!(
            "Press enter to confirm\n{preview}\n› run the deploy script\nDo you want to run this command?\n› 1. Yes, run it\n  2. No",
        );
        assert!(
            !current_screen_tail(&cap).to_lowercase().contains("enter to confirm"),
            "fixture is only meaningful if the legend really is out of the window",
        );
        // Without the glyph this is `Stuck` — and `deliver_prompt` answers `Stuck`
        // by pressing Enter, onto `1. Yes, run it`.
        assert_eq!(submit_state(&cap, "run the deploy script"), SubmitState::Submitted);

        // The bare rows with nothing else on screen: no echo, so the fallback can
        // only reach `Unknown`, but the selector must still be SEEN.
        let bare = format!("› 1. Yes, run it\n› 2. No, keep chatting");
        assert_eq!(submit_state(&bare, "run the deploy script"), SubmitState::Submitted);
    }

    /// The widened glyph belongs to SELECTION detection ONLY. `agent_composer_visible`
    /// still takes just the two Claude composer glyphs, so a `›`-drawn NON-numbered
    /// dialog line cannot begin to read as "the agent is at its text composer" and
    /// permit a send. Pins the asymmetry the split exists for.
    #[test]
    fn the_codex_glyph_widens_selection_but_not_composer_permission() {
        assert!(is_selection_row("› 1. Yes"));
        assert!(strip_selection_caret("› 1. Yes").is_some());
        assert!(strip_caret("› 1. Yes").is_none());
        assert!(!agent_composer_visible("› Do you want to proceed?"));
        // Both Claude glyphs keep working on both sides.
        assert!(is_selection_row("❯ 1. Yes"));
        assert!(agent_composer_visible("❯ write me a haiku"));
    }

    /// A short GENUINE option row must not be eaten by the echo filter merely because
    /// its handful of characters occur somewhere in the prompt. `line_is_prompt_echo`
    /// is an UNANCHORED substring test, so without the length floor `1. Yes` vanishes
    /// from the screen whenever the prompt happens to contain it — taking the selector
    /// with it and turning a live approval dialog into `Stuck` plus a blind Enter.
    #[test]
    fn a_short_option_row_is_not_swallowed_as_prompt_echo() {
        let prompt = "reply with 1. Yes or 2. No when the deploy finishes";
        assert!(!line_is_prompt_echo("› 1. Yes", prompt));
        assert!(!line_is_prompt_echo("  2. No", prompt));
        // A real wrapped echo line is well past the floor and is still filtered.
        assert!(line_is_prompt_echo("❯ reply with 1. Yes or 2. No when", prompt));
        assert_eq!(
            submit_state("› 1. Yes\n  2. No", prompt),
            SubmitState::Submitted,
            "the dialog must survive the echo filter",
        );
    }

    /// The regression Paul's own version failed: a codex composer echoing a
    /// NUMBERED prompt draws `› 1. …`, which is shaped exactly like his codex
    /// selector fixture. `line_is_prompt_echo` has to strip `›` as well as `❯`,
    /// or a stuck codex boot reports a confident Submitted with zero retries.
    /// His fixture passed only because it had no digit after the cursor.
    #[test]
    fn a_numbered_codex_prompt_echo_is_not_mistaken_for_a_selector() {
        assert_eq!(
            submit_state("› 1. check the queue 2. drain it\n? for shortcuts", "1. check the queue 2. drain it"),
            SubmitState::Stuck,
        );
    }

    /// The accepted ambiguity, pinned rather than left in a doc comment (ported
    /// from Paul's branch). A fast turn that already finished can echo the prompt
    /// into the TRANSCRIPT above an empty composer, which is indistinguishable
    /// from a swallowed Enter. It reads Stuck, so the session collects up to
    /// three harmless extra Enters on an idle composer — the safe direction.
    #[test]
    fn submit_state_transcript_echo_reads_stuck_not_unknown() {
        assert_eq!(
            submit_state(
                "❯ You are the operator, boot now\nDone. Summary posted.\n❯ ",
                "You are the operator, boot now",
            ),
            SubmitState::Stuck,
        );
    }

    /// The short-prompt path through `prompt_tail`'s `.unwrap_or(0)`: a prompt
    /// under PROMPT_TAIL_CHARS is matched whole rather than by its tail. Ported
    /// from Paul's branch, with the busy fixture rewritten — ours classifies off
    /// `agent_busy`, which requires the literal "esc to interrupt", not off the
    /// looser status ACTIVE_BANK his version reused.
    #[test]
    fn submit_state_short_prompt_is_matched_whole() {
        assert_eq!(submit_state("❯ hi there", "hi there"), SubmitState::Stuck);
        assert_eq!(
            submit_state("✻ Pondering… (esc to interrupt · 2s)", "hi there"),
            SubmitState::Submitted,
        );
    }

    /// `start()` holds the per-session lock across delivery, so the verify window is
    /// a lock-held cost on EVERY prompted boot. Pin the bounds.
    #[test]
    fn the_verify_window_stays_within_three_seconds() {
        assert!(
            VERIFY_POLL * VERIFY_POLLS as u32 <= Duration::from_secs(3),
            "the verify loop is paid under start()'s session lock — keep it bounded",
        );
        assert!(MAX_EXTRA_ENTERS <= 3, "retry Enters stay capped");
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
            swarm_reaper: Default::default(),
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
            archive_on_stop: 0,
            config_dir: String::new(),
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
            archive_on_stop: 0,
            config_dir: String::new(),
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

    /// A session with a `config_dir` boots Claude under that account: the export
    /// lands AFTER the profile sources (so a user `~/.zprofile` cannot win) and
    /// BEFORE the agent (so `claude` inherits it). Claude-only, single-quoted,
    /// and absent entirely when the session has no config dir.
    #[test]
    fn claude_launch_exports_the_session_config_dir() {
        let config = cfg();
        let base = Session {
            name: "acct".into(),
            display_name: "Acct".into(),
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
            runtime: "native".into(),
            mark_pin: None,
            notif: "inherit".into(),
            seen_ts: None,
            seen_count: None,
            seen_epoch: None,
            model: String::new(),
            memory: String::new(),
            skills: "[]".into(),
            role_id: None,
            archive_on_stop: 0,
            config_dir: "/home/agent/.claude-second".into(),
        };

        let (command, _resume) = build_launch_command(&config, &base, &[]);
        assert!(
            command.contains("export CLAUDE_CONFIG_DIR='/home/agent/.claude-second';"),
            "missing single-quoted export: {command}"
        );
        let profile_at = command.find("source ~/.profile").expect("profile sourced");
        let export_at = command.find("export CLAUDE_CONFIG_DIR=").expect("export present");
        let agent_at = command.find("claude --name acct").expect("agent launched");
        assert!(
            profile_at < export_at && export_at < agent_at,
            "export must sit between the profile sources and the agent: {command}"
        );
        // The whole line still parses as shell.
        let status = std::process::Command::new("bash")
            .args(["-n", "-c", &command])
            .status()
            .expect("bash must be available to validate the launch command");
        assert!(status.success(), "launch line must parse as shell: {command}");

        // No config dir -> byte-identical to today: nothing exported at all.
        let plain = Session { config_dir: String::new(), ..base.clone() };
        let (command, _resume) = build_launch_command(&config, &plain, &[]);
        assert!(!command.contains("CLAUDE_CONFIG_DIR"), "{command}");
    }

    /// The export decision lives in the launch arms, so it cannot disagree with
    /// the command it prefixes. Codex and Kimi run their own CLI and never get
    /// it, even when the row carries a config dir (a duplicate of a Claude
    /// session, say). An unknown/legacy provider falls through to the claude arm
    /// and DOES get it, because that row really does boot claude.
    /// [`launches_claude`] is the same rule for the Resume picker and recall, so
    /// assert the two stay in step.
    #[test]
    fn the_config_dir_export_follows_the_arm_that_launches_claude() {
        let config = cfg();
        let base = Session {
            name: "acct".into(),
            display_name: "Acct".into(),
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
            runtime: "tmux".into(),
            mark_pin: None,
            notif: "inherit".into(),
            seen_ts: None,
            seen_count: None,
            seen_epoch: None,
            model: String::new(),
            memory: String::new(),
            skills: "[]".into(),
            role_id: None,
            archive_on_stop: 0,
            config_dir: "/home/agent/.claude-second".into(),
        };
        // `shell` is deliberately absent: `start` settles a shell session
        // without ever calling this builder, so there is no launch line to
        // assert. The predicate still answers false for it.
        for provider in ["claude", "legacy-agent", "codex", "kimi"] {
            let session = Session { provider: provider.into(), ..base.clone() };
            let (command, _resume) = build_launch_command(&config, &session, &[]);
            assert_eq!(
                command.contains("export CLAUDE_CONFIG_DIR='/home/agent/.claude-second';"),
                launches_claude(provider),
                "provider '{provider}': the export must follow the launch arm: {command}"
            );
        }
        assert!(!launches_claude("shell"), "shell never launches claude");
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
            archive_on_stop: 0,
            config_dir: String::new(),
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
            archive_on_stop: 0,
            config_dir: String::new(),
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
            swarm_reaper: Default::default(),
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
mod stale_resume_tests {
    //! THE START BUTTON MUST START. `claude --resume <id>` against a transcript
    //! that no longer exists prints "No conversation found with session ID: …"
    //! and exits, so the pane comes back as a bare shell wearing the session's
    //! name and the row settles `idle` — the exact shape `iwd-nl` was stuck in.
    //! [`clear_stale_resume_link`] is the guard; these exercise it against a real
    //! DB row and a real (temp) claude project dir, without driving a pty.

    use super::*;
    use crate::config::Config;
    use std::path::PathBuf;

    async fn test_state() -> (AppState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-stale-resume-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            swarm_reaper: Default::default(),
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

    /// Point `CLAUDE_CONFIG_DIR` at a throwaway root and lay down ONE transcript
    /// for `session_dir` — mirrors the helper the auto-heal tests use, so both
    /// sides of the "is this link dead?" question are proved the same way.
    fn with_transcript(session_dir: &str, conv: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("supermux-cc-lc-{}", uuid::Uuid::new_v4()));
        std::env::set_var("CLAUDE_CONFIG_DIR", &root);
        let proj = crate::sessions::resumable::project_dir_for("", session_dir);
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join(format!("{conv}.jsonl")), b"{}\n").unwrap();
        root
    }

    fn drop_transcript(root: PathBuf) {
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(root);
    }

    /// A dead link is dropped (column + in-memory row) so the launch that
    /// follows is a CLEAN `--name` start; a link whose transcript is still there
    /// is left completely alone and still launches as `--resume '<id>'`.
    #[tokio::test]
    async fn a_dead_link_is_cleared_and_a_live_one_is_kept() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        for name in ["gone", "kept"] {
            db::sessions::insert_minimal(&state.pool, name, "/tmp", "claude")
                .await
                .unwrap();
        }
        db::sessions::set_cc_conversation_id(&state.pool, "gone", "conv-vanished").await.unwrap();
        db::sessions::set_cc_conversation_id(&state.pool, "kept", "conv-here").await.unwrap();
        let cc = with_transcript("/tmp", "conv-here");

        // ── the dead one ────────────────────────────────────────────────────
        let mut gone = db::sessions::get(&state.pool, "gone").await.unwrap().unwrap();
        assert_eq!(
            clear_stale_resume_link(&state, "gone", &mut gone).await.unwrap().as_deref(),
            Some("conv-vanished"),
            "a link whose transcript is gone must be dropped, and NAMED for the log",
        );
        assert!(gone.cc_conversation_id.is_empty(), "the in-memory row the launch builder reads is cleared");
        let persisted = db::sessions::get(&state.pool, "gone").await.unwrap().unwrap();
        assert!(persisted.cc_conversation_id.is_empty(), "…and so is the column, so the NEXT Start is clean too");
        let (cmd, resume_intended) = build_launch_command(&state.config, &gone, &[]);
        assert!(!cmd.contains("--resume"), "the launch must not resume a conversation that is gone: {cmd}");
        assert!(cmd.contains("--name gone"), "it starts a fresh named conversation instead: {cmd}");
        assert!(!resume_intended, "a clean start is NOT resume-intended — the picker escape stays available");

        // ── the live one ────────────────────────────────────────────────────
        let mut kept = db::sessions::get(&state.pool, "kept").await.unwrap().unwrap();
        assert_eq!(
            clear_stale_resume_link(&state, "kept", &mut kept).await.unwrap(),
            None,
            "a link with its transcript still on disk is untouched",
        );
        assert_eq!(kept.cc_conversation_id, "conv-here");
        let (cmd, resume_intended) = build_launch_command(&state.config, &kept, &[]);
        assert!(cmd.contains("--resume 'conv-here'"), "it still resumes the real conversation: {cmd}");
        assert!(resume_intended, "…and that IS resume-intended");

        drop_transcript(cc);
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A REMOTE session keeps its link even when this host cannot see the
    /// transcript: the file lives on the remote box, so "missing here" says
    /// nothing about the link, and clearing it would destroy a live conversation.
    #[tokio::test]
    async fn a_remote_session_keeps_a_link_this_host_cannot_see() {
        let _serial = crate::sessions::native::test_serial().await;
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "remote", "/tmp", "claude")
            .await
            .unwrap();
        db::sessions::set_cc_conversation_id(&state.pool, "remote", "conv-on-the-other-box")
            .await
            .unwrap();
        // An empty root: NOTHING is on disk here for that conversation.
        let cc = with_transcript("/tmp", "some-other-conv");

        let mut s = db::sessions::get(&state.pool, "remote").await.unwrap().unwrap();
        s.host_id = Some(1);
        assert_eq!(
            clear_stale_resume_link(&state, "remote", &mut s).await.unwrap(),
            None,
            "a remote row is skipped — its transcripts are not on this filesystem",
        );
        assert_eq!(s.cc_conversation_id, "conv-on-the-other-box");
        let persisted = db::sessions::get(&state.pool, "remote").await.unwrap().unwrap();
        assert_eq!(persisted.cc_conversation_id, "conv-on-the-other-box", "the column survives too");

        drop_transcript(cc);
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
            swarm_reaper: Default::default(),
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
    use std::sync::Mutex;

    struct StubRuntime {
        capture: String,
        /// When true, `capture_plain` returns an Err — the send-guard fail-closed
        /// path (wave-8).
        capture_err: bool,
        /// A SCRIPTED pane: one screen per `capture_plain` call, the last entry
        /// repeating once the script runs out (so a "permanently stuck" pane needs
        /// one line). Empty = the static `capture`, which is what every send-guard
        /// test uses. Exists for `deliver_prompt`, whose whole job is reading a
        /// pane that CHANGES between polls.
        script: Mutex<Vec<String>>,
        /// What `shell_is_foreground` reports. `None` = "can't tell" (the tmux
        /// default, which forces the text guard); `Some(true)` = a bare shell.
        shell_fg: Option<bool>,
        text_calls: AtomicUsize,
        key_calls: AtomicUsize,
        capture_calls: AtomicUsize,
    }

    impl StubRuntime {
        fn parked_at(capture: &str) -> Arc<Self> {
            Arc::new(Self {
                capture: capture.to_string(),
                capture_err: false,
                script: Mutex::new(Vec::new()),
                shell_fg: None,
                text_calls: AtomicUsize::new(0),
                key_calls: AtomicUsize::new(0),
                capture_calls: AtomicUsize::new(0),
            })
        }
        /// A runtime whose `capture_plain` always fails — exercises the send
        /// guard's fail-closed arm.
        fn capture_fails() -> Arc<Self> {
            Arc::new(Self {
                capture: String::new(),
                capture_err: true,
                script: Mutex::new(Vec::new()),
                shell_fg: None,
                text_calls: AtomicUsize::new(0),
                key_calls: AtomicUsize::new(0),
                capture_calls: AtomicUsize::new(0),
            })
        }
        /// A native-shaped runtime that reports it is sitting at a BARE SHELL
        /// (`tpgid == pid`) even though the (stale) capture still shows agent
        /// glyphs — exercises the native-authoritative refuse.
        fn bare_shell_with_stale_capture(capture: &str) -> Arc<Self> {
            Arc::new(Self {
                capture: capture.to_string(),
                capture_err: false,
                script: Mutex::new(Vec::new()),
                shell_fg: Some(true),
                text_calls: AtomicUsize::new(0),
                key_calls: AtomicUsize::new(0),
                capture_calls: AtomicUsize::new(0),
            })
        }
        /// A pane that shows each of `screens` in turn, then holds the last one.
        fn showing(screens: &[&str]) -> Arc<Self> {
            let rt = Self::parked_at("");
            *rt.script.lock().unwrap() = screens.iter().map(|s| s.to_string()).collect();
            rt
        }
        /// The next scripted screen, or the static capture when nothing is scripted.
        fn next_screen(&self) -> String {
            let mut q = self.script.lock().unwrap();
            match q.len() {
                0 => self.capture.clone(),
                1 => q[0].clone(),
                _ => q.remove(0),
            }
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
            self.capture_calls.fetch_add(1, Ordering::SeqCst);
            if self.capture_err {
                anyhow::bail!("stub: capture unavailable");
            }
            Ok(self.next_screen())
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


    /// **Bug A, at the wait loop.** A pane showing Claude's background-session
    /// refusal must END the ready wait immediately with the id to stop — not sit
    /// out the full 10s window and report a nameless failure, which is how a start
    /// used to end as a silent idle bash. Nothing is typed into the pane on the
    /// way out (the remedy is a subprocess, not keystrokes), and a foreign id is
    /// not actionable at all.
    #[tokio::test]
    async fn the_ready_wait_ends_on_a_background_session_refusal_with_our_id() {
        let (state, dir) = test_state().await;
        db::sessions::insert_minimal(&state.pool, "bg", "/tmp", "claude")
            .await
            .unwrap();

        let ours = "a30d387a-2ff1-4c9e-8f0a-7b1d2e3c4a5b";
        let refusal = format!(
            "$ claude --resume '{ours}'\nSession {ours} is running as a background session \
             (a30d387a). Run `claude attach a30d387a` to open it, or `claude stop a30d387a` \
             first to resume it here.\n$ ",
        );
        let rt = StubRuntime::parked_at(&refusal);
        let outcome = wait_for_agent_ready(rt.as_ref(), &state, "bg", true, &[ours], false).await;
        assert_eq!(
            outcome,
            BootOutcome::BackgroundSession("a30d387a".to_string()),
            "the refusal must be reported with the id `claude stop` needs",
        );
        assert_eq!(
            rt.text_calls.load(Ordering::SeqCst) + rt.key_calls.load(Ordering::SeqCst),
            0,
            "nothing may be typed into the pane on this path",
        );
        assert!(
            rt.capture_calls.load(Ordering::SeqCst) <= 2,
            "it must bail on the FIRST refusal tick, not sit out the whole window",
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
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

    // ── opening-prompt delivery (`deliver_prompt`) ────────────────────────────
    //
    // The whole point of these is the KEY COUNT: how many Enters a boot presses,
    // and into what. Reachable only through a live terminal before the scripted
    // `StubRuntime`; `start_paused` makes the 500ms verify polls free.

    const PROMPT: &str = "boot the operator and work the queue";

    /// A SHELL is typed and submitted exactly once and never looked at: it has no
    /// busy footer and echoes back every command it runs, so verification would
    /// classify every good start as Stuck and fire retry Enters into the
    /// foreground process's stdin.
    #[tokio::test(start_paused = true)]
    async fn a_shell_prompt_is_delivered_once_and_never_verified() {
        let rt = StubRuntime::parked_at("$ ");
        let out = deliver_prompt(rt.as_ref(), "shell", PROMPT).await.unwrap();
        assert_eq!(out, None, "a shell start is unverifiable, not failed");
        assert_eq!(rt.text_calls.load(Ordering::SeqCst), 1);
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 1, "exactly one Enter, as before");
        assert_eq!(rt.capture_calls.load(Ordering::SeqCst), 0, "the pane is never read");
    }

    /// The healthy boot: the turn is running at the first poll → verified with no
    /// extra Enter.
    #[tokio::test(start_paused = true)]
    async fn a_turn_that_started_verifies_without_a_retry() {
        let rt = StubRuntime::showing(&["❯ \n  ? for shortcuts", "✻ Thinking… (esc to interrupt · 2s)"]);
        let out = deliver_prompt(rt.as_ref(), "claude", PROMPT).await.unwrap();
        assert_eq!(out, Some(true));
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 1, "no retry Enter on a healthy boot");
    }

    /// THE SWALLOWED ENTER: the prompt sits in the composer poll after poll. One
    /// retry Enter is enough, and it must be the ONLY one.
    #[tokio::test(start_paused = true)]
    async fn a_swallowed_enter_is_retried_and_then_verifies() {
        let stuck = format!("❯ {PROMPT}\n  ? for shortcuts");
        let rt = StubRuntime::showing(&[
            "❯ \n  ? for shortcuts",             // pre-send: idle composer
            &stuck,                               // poll 1: the Enter was swallowed
            "✻ Thinking… (esc to interrupt · 1s)", // poll 2: the retry landed
        ]);
        let out = deliver_prompt(rt.as_ref(), "claude", PROMPT).await.unwrap();
        assert_eq!(out, Some(true));
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 2, "the submit plus exactly one retry");
    }

    /// A pane that never budges: retries stop at the cap and the boot reports an
    /// OBSERVED failure (which is what `start()` warns on).
    #[tokio::test(start_paused = true)]
    async fn a_permanently_stuck_composer_stops_at_the_retry_cap() {
        let rt = StubRuntime::parked_at(&format!("❯ {PROMPT}\n  ? for shortcuts"));
        let out = deliver_prompt(rt.as_ref(), "claude", PROMPT).await.unwrap();
        assert_eq!(out, Some(false), "observed the whole window and it never submitted");
        assert_eq!(
            rt.key_calls.load(Ordering::SeqCst),
            1 + MAX_EXTRA_ENTERS,
            "the submit plus at most MAX_EXTRA_ENTERS retries — never one per poll",
        );
    }

    /// THE DANGEROUS ONE. The prompt submitted and the agent is now parked on a
    /// permission menu with its default highlighted; the prompt is still echoed
    /// above it. A retry Enter here CONFIRMS that default, so the selector must
    /// stop the loop dead.
    #[tokio::test(start_paused = true)]
    async fn an_approval_selector_never_receives_a_retry_enter() {
        let selector = format!(
            "❯ {PROMPT}\n  Bash(rm -rf ./build)\n  Do you want to proceed?\n\
             ❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\
             Enter to confirm · Esc to cancel",
        );
        let rt = StubRuntime::showing(&["❯ \n  ? for shortcuts", &selector]);
        let out = deliver_prompt(rt.as_ref(), "claude", PROMPT).await.unwrap();
        assert_eq!(out, Some(true), "a selector proves the prompt was consumed");
        assert_eq!(
            rt.key_calls.load(Ordering::SeqCst),
            1,
            "NO extra Enter may be pressed into a highlighted destructive default",
        );
    }

    /// Never saw the pane at all → unverifiable, NOT a failure (and no retries: an
    /// unread screen could be anything, including a selector).
    #[tokio::test(start_paused = true)]
    async fn a_window_of_failed_captures_is_unverifiable_not_failed() {
        let rt = StubRuntime::capture_fails();
        let out = deliver_prompt(rt.as_ref(), "claude", PROMPT).await.unwrap();
        assert_eq!(out, None, "we never looked, so we may not claim it failed");
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 1, "one submit, no blind retries");
    }

    /// The double-launch guard delivers into an agent that is already mid-turn:
    /// its busy footer is on screen from the first poll whatever our Enter did, so
    /// the check would rubber-stamp a submit it never observed. Deliver, and say so.
    #[tokio::test(start_paused = true)]
    async fn an_already_busy_agent_is_delivered_but_not_verified() {
        let rt = StubRuntime::parked_at("✻ Thinking… (esc to interrupt · 40s)");
        let out = deliver_prompt(rt.as_ref(), "claude", PROMPT).await.unwrap();
        assert_eq!(out, None, "busy before we typed: honest unknown, not a claimed true");
        assert_eq!(rt.text_calls.load(Ordering::SeqCst), 1, "the prompt is still queued to the agent");
        assert_eq!(rt.key_calls.load(Ordering::SeqCst), 1);
        assert_eq!(rt.capture_calls.load(Ordering::SeqCst), 1, "the pre-send sample only");
    }
}

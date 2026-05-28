//! Session lifecycle: the tmux-backed half of the sessions API (TECH_PLAN
//! §3.2.5, §3.5; feature-extract §1.4, §1.5).
//!
//! Each mutating op acquires the per-session `tokio::sync::Mutex` from
//! [`AppState::lock_for`] so concurrent sends/starts/stops never race tmux
//! commands. Read-only ops (`peek`) skip the lock per the §3.2.5 detector rule.
//!
//! **Hook-token rotation (§6.5).** Every `start` mints a fresh `SUPERMUX_HOOK_TOKEN`
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

use super::status::{self, Mode};
use super::tmux::Tmux;
use super::transport::HostId;
use super::SessionView;

/// Outcome of a `start`/`wake` (returned to the client).
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

/// Resolve the URL a REMOTE session's hook `curl` should dial back to
/// (REMOTE_PLAN RT5). Resolution order:
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

/// Per-session tmux env (§6.5). Excludes the dashboard bearer by construction.
///
/// `agent_teams` gates the experimental Claude Code Agent Teams feature (AT-B
/// §3.1): when ON **and** the provider is `claude`, inject
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
    // REMOTE_PLAN RT5: a session running on a different machine cannot reach
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
    // AT-B §3.1: gated, Claude-only opt-in for Agent Teams.
    if agent_teams && provider == "claude" {
        env.insert(
            "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS".to_string(),
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
    env
}

/// Build the agent launch command sent into the freshly-spawned shell. Profiles
/// are sourced first so `claude`/`codex` are on PATH in a non-login pane.
/// Resume strategy per feature-extract §1.5: `cc_session_name` → `cc_conversation_id`
/// → fresh `--name`.
fn build_launch_command(config: &crate::config::Config, s: &Session) -> String {
    let agent = match s.provider.as_str() {
        // Codex is no longer an OFFERED provider (Claude-only). The validator
        // still ACCEPTS `provider="codex"` (accept-but-never-offer) so existing
        // scheduled jobs don't 400; such sessions launch via the claude default
        // below, same as any non-shell provider.
        // default to claude
        _ => {
            let mut parts = vec!["claude".to_string()];
            let defaults = config.provider_defaults.claude_flags.trim();
            if !defaults.is_empty() {
                parts.push(defaults.to_string());
            }
            if !s.flags.trim().is_empty() {
                parts.push(s.flags.trim().to_string());
            }
            if !s.cc_session_name.is_empty() {
                parts.push("--resume".to_string());
                parts.push(s.cc_session_name.clone());
            } else if !s.cc_conversation_id.is_empty() {
                parts.push("--resume".to_string());
                parts.push(s.cc_conversation_id.clone());
            } else {
                parts.push("--name".to_string());
                parts.push(s.name.clone());
            }
            parts.join(" ")
        }
    };
    // "Edit in native editor" (feat-edit-in-native-editor): point `$EDITOR`/
    // `$VISUAL` at the supermux bridge wrapper so Claude's built-in Ctrl+G
    // (`chat:externalEditor`) opens the browser editor sheet instead of a
    // terminal editor. Exported AFTER the profile sources (a user `~/.zprofile`
    // could set its own EDITOR, which would otherwise win) and BEFORE `{agent}`
    // so the launched provider inherits it. Set once OUTSIDE the provider match —
    // only Claude reads it, but exporting it for codex/shell is harmless (they
    // ignore it). Single-quoted so a data-dir path with spaces never word-splits.
    let bridge = config.data_dir.join("bin/supermux-edit");
    let bridge = bridge.display();
    format!(
        "source ~/.zprofile 2>/dev/null; source ~/.bash_profile 2>/dev/null; \
         source ~/.profile 2>/dev/null; export EDITOR='{bridge}' VISUAL='{bridge}'; {agent}"
    )
}

/// True once the Claude/Codex TUI prompt is visible.
fn agent_ui_visible(capture: &str) -> bool {
    capture.contains('❯') || capture.contains('❱') || capture.contains("? for shortcuts")
}

/// Heuristic: are we stuck in Claude's `--resume` session picker?
fn at_resume_picker(capture: &str) -> bool {
    let c = capture.to_lowercase();
    c.contains("resume a conversation") || c.contains("select a session") || c.contains("conversation to resume")
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

/// Confirm the pane shell is live (and let it print a prompt).
async fn settle_shell(tmux: &Tmux<'_>) -> bool {
    for _ in 0..10 {
        if tmux.exists().await.unwrap_or(false) {
            tokio::time::sleep(Duration::from_millis(150)).await;
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Poll `capture-pane` for up to 10s for the agent UI; one resume-picker escape
/// fallback (Escape Escape C-c + clear cc ids) per feature-extract §1.5, and one
/// trust-dialog auto-accept (Enter on the default "Yes, I trust this folder") so
/// a first-launch in a never-seen project dir does not hang forever.
async fn wait_for_agent_ready(tmux: &Tmux<'_>, state: &AppState, name: &str) -> bool {
    let mut escaped = false;
    let mut trusted = false;
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if let Ok(cap) = tmux.capture_pane(40).await {
            // Dismiss the first-run BOOT GATES *before* the ready-check. Both the
            // trust dialog and the resume picker draw a numbered menu whose cursor
            // is `❯` — the exact glyph `agent_ui_visible` keys on — so a ready-check
            // first would declare the session "ready" with a modal still up. Two
            // costs we actually hit in prod (SD-1):
            //   1. the steering deliver then sends the dispatched task INTO the modal
            //      (a bare Enter just picks "Yes, I trust" / a stale conversation),
            //      so the agent "never got the message"; and
            //   2. the status detector captures the `❯ 1.` menu, matches the WAITING
            //      bank, and flips the card to "needs your input" the instant it is
            //      claimed — before the agent has done anything.
            // Order is trust → resume → ready, and we `continue` after handling a
            // gate so we never fall through to the ready-check on the SAME capture
            // that still shows the menu (the escape/accept has not rendered yet).
            if !trusted && at_trust_dialog(&cap) {
                // Default option is "1. Yes, I trust this folder"; a bare Enter
                // accepts it (and persists the trust so it never reappears).
                let _ = tmux.send_key("Enter").await;
                trusted = true;
                continue;
            }
            if !escaped && at_resume_picker(&cap) {
                let _ = tmux.send_key("Escape").await;
                let _ = tmux.send_key("Escape").await;
                let _ = tmux.send_key("C-c").await;
                let _ = db::sessions::clear_cc(&state.pool, name).await;
                escaped = true;
                continue;
            }
            if agent_ui_visible(&cap) {
                return true;
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
        payload: json!({ "name": name, "status": status, "version": version }),
    });
    let _ = state.sse_tx.send(SseEvent {
        event: "sessions".to_string(),
        payload: json!({ "delta": [{ "name": name, "status": status }] }),
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

async fn require_session(state: &AppState, name: &str) -> Result<Session, AppError> {
    db::sessions::get(&state.pool, name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))
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

    let s = require_session(state, name).await?;
    let tmux = Tmux::new(name);

    // Rotate the hook token on every start (§6.5: avoid long-lived env secrets).
    let hook_token = super::gen_hook_token();
    db::sessions::ensure_runtime(&state.pool, name, &hook_token).await?;
    state.hook_tokens.insert(name.to_string(), hook_token.clone());

    // AT-B §3.1: the global experimental Agent Teams gate (default OFF). Read
    // once here; it both injects the env var and writes `teammateMode:"tmux"`.
    // FAIL CLOSED — a read failure reads OFF inside `agent_teams_enabled`.
    //
    // AT-D ("Start a team"): a session that was explicitly spun up as a team LEAD
    // carries a per-session override flag — it gets the Agent Teams env even when
    // the global pref is OFF (an explicit opt-in beats the conservative default).
    // We OR the two so this NEVER fights AT-B's gating: global ON enables it for
    // every Claude session as before; the override only WIDENS it for one flagged
    // lead. The Claude-only guard still lives in `build_env`/the settings install.
    let agent_teams =
        db::prefs::agent_teams_enabled(&state.pool).await || state.force_agent_teams(name);

    // M5b: install the Claude SettingsHook events so the agent reports real status
    // signals (§3.5). Idempotent + non-destructive; failure is non-fatal — the
    // detector still classifies off the regex bank + pty heartbeat. Only Claude
    // reads `~/.claude/settings.json`, so skip it for codex/shell sessions.
    //
    // REMOTE_PLAN RT5: when the session is remote (s.host_id is Some), resolve
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
        // AT-B §3.1: when teams is enabled, also force `teammateMode:"tmux"` so a
        // lead spawns teammates as split-panes on supermux's socket (not the
        // invisible in-process backend). Gated + Claude-only; non-fatal on error.
        if agent_teams {
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

    let env = build_env(
        &state.config,
        name,
        &hook_token,
        &s.provider,
        agent_teams,
        s.host_id,
    );
    let dir = PathBuf::from(&s.dir);
    let shell = user_shell();

    let freshly_spawned = !tmux.exists().await?;
    if freshly_spawned {
        // A genuinely new tmux pane is about to exist for this name. Drop any
        // cached live pty stream first: it is bound to a PRIOR (now-dead) pane,
        // and because the new session reuses the same name the stream's liveness
        // poll would never invalidate it on its own. `stop` already does this on
        // the restart path; this also covers a start that follows an external
        // pane death (auto-wake, a crash the reader hasn't noticed yet) so the
        // first WS attach after start always rebuilds against the NEW pane.
        // A SERVER restart starts with an empty registry and never hits this
        // `freshly_spawned` branch (it re-attaches to the surviving session), so
        // session-survival is untouched.
        state.pty_invalidate(name);
        tmux.new_session(&dir, &env, &shell).await?;
    }

    // BOOTING window (§3.2.8 — overview UX): mark the session `starting` before
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
        payload: json!({
            "name": name,
            "status": "starting",
            "version": starting_version,
        }),
    });
    let _ = state.sse_tx.send(SseEvent {
        event: "sessions".to_string(),
        payload: json!({ "delta": [{ "name": name, "status": "starting" }] }),
    });

    let ready = match s.provider.as_str() {
        "shell" => settle_shell(&tmux).await,
        _ => {
            // Give the new shell a beat, then launch the agent.
            tokio::time::sleep(Duration::from_millis(300)).await;
            let cmd = build_launch_command(&state.config, &s);
            tmux.send_text(&cmd).await?;
            tmux.send_key("Enter").await?;
            wait_for_agent_ready(&tmux, state, name).await
        }
    };

    db::sessions::bump_start(&state.pool, name).await?;
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
            tmux.send_text(p).await?;
            tmux.send_key("Enter").await?;
            db::sessions::set_last_send(&state.pool, name, p).await?;
        }
    }

    Ok(StartResult {
        name: name.to_string(),
        started: true,
        ready,
        target: tmux.target(),
    })
}

/// Graceful stop (provider exit) → BRIEF grace → hard kill → tmux teardown.
/// Returns once the session is `stopped`; the caller answers 202.
///
/// SUPERMUX-38: Stop felt broken because the old grace polled up to 15s before
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
    let tmux = Tmux::new(name);

    if !tmux.exists().await? {
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
            let _ = tmux.send_text("exit").await;
            let _ = tmux.send_key("Enter").await;
        }
        _ => {
            let _ = tmux.send_key("C-c").await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let _ = tmux.send_text("/exit").await;
            let _ = tmux.send_key("Enter").await;
        }
    }

    // 2. Wait a BRIEF, capped window for the pane program to exit (session gone
    //    or pane dead), polling on a tight cadence so a clean exit is observed
    //    near-instantly rather than on a coarse 500ms tick. Caps at
    //    `STOP_GRACE_CAP` — teardown happens regardless, so there is no value in
    //    waiting longer (SUPERMUX-38).
    let mut graceful = false;
    let deadline = tokio::time::Instant::now() + STOP_GRACE_CAP;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(STOP_GRACE_POLL).await;
        if !tmux.exists().await.unwrap_or(true) || tmux.pane_dead().await.unwrap_or(false) {
            graceful = true;
            break;
        }
    }

    // 3. Hard kill if the grace window elapsed (the agent didn't exit on its own).
    if !graceful {
        if let Ok(Some(pid)) = tmux.pane_pid().await {
            hard_kill(pid).await;
        }
    }

    // 4. Definitive teardown. A failure here is surfaced but status still cleans.
    if let Err(e) = tmux.kill_session().await {
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
    // SUPERMUX-38: publish `stopped` ourselves (status watch + SSE). The detector
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

/// Send literal text followed by Enter. Auto-wakes a stopped session (§1.9).
pub async fn send_text(state: &AppState, name: &str, text: &str) -> Result<(), AppError> {
    if !db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let tmux = Tmux::new(name);
    // Auto-wake BEFORE taking the lock (start() acquires it itself).
    if !tmux.exists().await? {
        start(state, name, None).await?;
    }

    let lock = state.lock_for(name);
    let _guard = lock.lock().await;
    tmux.send_text(text).await?;
    tmux.send_key("Enter").await?;
    db::sessions::set_last_send(&state.pool, name, text).await?;
    Ok(())
}

/// Send a single named tmux key, enforcing the REST allowlist (§1.4).
pub async fn send_keys(state: &AppState, name: &str, key: &str) -> Result<(), AppError> {
    if !KEY_ALLOWLIST.contains(key) {
        return Err(AppError::BadRequest(format!("key '{key}' not in allowlist")));
    }
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;

    if !db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let tmux = Tmux::new(name);
    if !tmux.exists().await? {
        return Err(AppError::Conflict(format!("session '{name}' is not running")));
    }
    tmux.send_key(key).await?;
    Ok(())
}

/// Paste `text` via a tmux buffer (bracketed). When `submit`, append Enter.
pub async fn paste(
    state: &AppState,
    name: &str,
    text: &str,
    submit: bool,
) -> Result<(), AppError> {
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;

    if !db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let tmux = Tmux::new(name);
    if !tmux.exists().await? {
        return Err(AppError::Conflict(format!("session '{name}' is not running")));
    }
    tmux.paste_via_buffer(text, true).await?;
    if submit {
        tmux.send_key("Enter").await?;
    }
    db::sessions::set_last_send(&state.pool, name, text).await?;
    Ok(())
}

/// Capture the last `lines` of scrollback (read-only — no lock). Empty if the
/// session isn't running.
pub async fn peek(state: &AppState, name: &str, lines: usize) -> Result<String, AppError> {
    if !db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let tmux = Tmux::new(name);
    if !tmux.exists().await? {
        return Ok(String::new());
    }
    let lines = lines.clamp(1, 10_000);
    Ok(tmux.capture_pane(lines).await?)
}

/// Archive (async-job-shaped, §3.2.5): returns a `job_id` immediately; the
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

    // SYNCHRONOUS: audit row per ARCHITECTURE §3.3 — every destructive HTTP
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
        let tmux = Tmux::new(&name);
        let content = if tmux.exists().await.unwrap_or(false) {
            tmux.capture_full().await.unwrap_or_default()
        } else {
            String::new()
        };

        // Filesystem-bound dump runs on the blocking pool (§3.2.5).
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

        let _ = tmux.kill_session().await;

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

        // R1-2: `forget_session` must be the LAST thing — a still-running loop's
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

/// Wake a (possibly hibernated/stopped) session: clear the hibernate flag and
/// start it if its tmux session is gone.
pub async fn wake(state: &AppState, name: &str) -> Result<StartResult, AppError> {
    if !db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    db::sessions::set_hibernated(&state.pool, name, false).await?;
    let tmux = Tmux::new(name);
    if tmux.exists().await? {
        return Ok(StartResult {
            name: name.to_string(),
            started: false,
            ready: true,
            target: tmux.target(),
        });
    }
    start(state, name, None).await
}

// ── mode-shift: switch the permission mode from the UI ────────────────────────

/// The launch flag that activates Claude Code's bypass-permissions mode at boot
/// (mode-shift). `bypassPermissions` is launch-only — a running session cannot
/// enter it via Shift+Tab — so entering bypass is a clean relaunch with this flag
/// (and leaving it strips the flag and resumes). The `--permission-mode <value>`
/// form is the canonical, documented way to set the launch mode and composes with
/// `--resume <id>` so the conversation carries over.
const BYPASS_FLAG: &str = "--permission-mode bypassPermissions";

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
/// only — no lock (mirrors the §3.2.5 detector rule for `capture-pane`). Falls
/// back to `Normal` when the pane can't be captured.
async fn read_mode(tmux: &Tmux<'_>) -> Mode {
    match tmux.capture_pane(status::CAPTURE_LINES).await {
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
    let tmux = Tmux::new(name);
    if !tmux.exists().await? {
        return Err(AppError::Conflict(format!(
            "session '{name}' is not running — start it before switching mode"
        )));
    }

    // At most 4 presses: a 3-mode ring needs ≤2 to reach any target, +2 slack for
    // a transient prompt that mis-seats a press (robust, never blind-spam).
    const MAX_PRESSES: u8 = 4;
    let mut current = read_mode(&tmux).await;
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
                tmux.send_key("BTab").await?;
                drop(guard);
                presses += 1;
                // Let the status bar repaint before re-reading (it updates within
                // a frame or two; the detector cadence is slower so we read here).
                tokio::time::sleep(Duration::from_millis(250)).await;
                current = read_mode(&tmux).await;
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
    let tmux = Tmux::new(name);
    if tmux.exists().await.unwrap_or(false) {
        stop(state, name).await?;
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
        payload: json!({ "delta": [{ "name": name, "mode": mode.as_str() }] }),
    });
}

/// Clone a session's config under `new_name` (fresh runtime + hook token). The
/// git-worktree variant of clone is deferred (see agent notes); this mirrors
/// `duplicate` so the new session is independently startable.
pub async fn clone(
    state: &AppState,
    src: &str,
    new_name: &str,
) -> Result<SessionView, AppError> {
    super::duplicate(state, src, new_name).await
}

// ── REST send_keys allowlist (feature-extract §1.4) ──────────────────────────

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
        // `❯ 1.` menu as WAITING (SD-1). Pin both predicates so a future edit can't
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
    //! SUPERMUX-38: the stop grace must stay SHORT (tmux is torn down regardless,
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
            "the new cap must be far below the old 15s grace that caused SUPERMUX-38",
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

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
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::json;

use crate::db;
use crate::db::sessions::Session;
use crate::error::AppError;
use crate::state::{AppState, SseEvent};

use super::tmux::Tmux;
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

// ── helpers ───────────────────────────────────────────────────────────────────

/// The shell to spawn each tmux pane with. `$SHELL`, falling back to bash.
fn user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/bash".to_string())
}

/// Per-session tmux env (§6.5). Excludes the dashboard bearer by construction.
fn build_env(config: &crate::config::Config, name: &str, hook_token: &str) -> HashMap<String, String> {
    let scheme = if config.tls.cert_path.is_some() || config.tls.self_signed {
        "https"
    } else {
        "http"
    };
    let mut env = HashMap::new();
    env.insert("SUPERMUX_SESSION".to_string(), name.to_string());
    env.insert("TMUX_SESSION_NAME".to_string(), name.to_string());
    env.insert("SUPERMUX_URL".to_string(), format!("{scheme}://{}", config.bind));
    env.insert("SUPERMUX_HOOK_TOKEN".to_string(), hook_token.to_string());
    env
}

/// Build the agent launch command sent into the freshly-spawned shell. Profiles
/// are sourced first so `claude`/`codex` are on PATH in a non-login pane.
/// Resume strategy per feature-extract §1.5: `cc_session_name` → `cc_conversation_id`
/// → fresh `--name`.
fn build_launch_command(config: &crate::config::Config, s: &Session) -> String {
    let agent = match s.provider.as_str() {
        "codex" => {
            let mut parts = vec!["codex".to_string()];
            let defaults = config.provider_defaults.codex_flags.trim();
            if !defaults.is_empty() {
                parts.push(defaults.to_string());
            }
            if !s.flags.trim().is_empty() {
                parts.push(s.flags.trim().to_string());
            }
            if !s.codex_session_id.is_empty() {
                parts.push("resume".to_string());
                parts.push(s.codex_session_id.clone());
            }
            parts.join(" ")
        }
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
    format!(
        "source ~/.zprofile 2>/dev/null; source ~/.bash_profile 2>/dev/null; \
         source ~/.profile 2>/dev/null; {agent}"
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
/// fallback (Escape Escape C-c + clear cc ids) per feature-extract §1.5.
async fn wait_for_agent_ready(tmux: &Tmux<'_>, state: &AppState, name: &str) -> bool {
    let mut escaped = false;
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if let Ok(cap) = tmux.capture_pane(40).await {
            if agent_ui_visible(&cap) {
                return true;
            }
            if !escaped && at_resume_picker(&cap) {
                let _ = tmux.send_key("Escape").await;
                let _ = tmux.send_key("Escape").await;
                let _ = tmux.send_key("C-c").await;
                let _ = db::sessions::clear_cc(&state.pool, name).await;
                escaped = true;
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

async fn require_session(state: &AppState, name: &str) -> Result<Session, AppError> {
    db::sessions::get(&state.pool, name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))
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

    // M5b: install the Claude SettingsHook events so the agent reports real status
    // signals (§3.5). Idempotent + non-destructive; failure is non-fatal — the
    // detector still classifies off the regex bank + pty heartbeat. Only Claude
    // reads `~/.claude/settings.json`, so skip it for codex/shell sessions.
    if s.provider == "claude" {
        if let Err(e) = crate::claude_config::install_hooks(name, &hook_token) {
            tracing::warn!(name = %name, error = %e, "install_hooks failed; status falls back to regex/heartbeat");
        }
    }

    let env = build_env(&state.config, name, &hook_token);
    let dir = PathBuf::from(&s.dir);
    let shell = user_shell();

    let freshly_spawned = !tmux.exists().await?;
    if freshly_spawned {
        tmux.new_session(&dir, &env, &shell).await?;
    }

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

/// Graceful stop (provider exit) → 15s grace → hard kill → tmux teardown.
/// Returns once the session is `stopped`; the caller answers 202.
pub async fn stop(state: &AppState, name: &str) -> Result<(), AppError> {
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;

    let s = require_session(state, name).await?;
    let tmux = Tmux::new(name);

    if !tmux.exists().await? {
        db::sessions::set_last_status(&state.pool, name, "stopped").await?;
        return Ok(());
    }

    // 1. Graceful: ask the program to exit.
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

    // 2. Wait up to 15s for the pane program to exit (session gone or pane dead).
    let mut graceful = false;
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if !tmux.exists().await.unwrap_or(true) || tmux.pane_dead().await.unwrap_or(false) {
            graceful = true;
            break;
        }
    }

    // 3. Hard kill if the grace window elapsed.
    if !graceful {
        if let Ok(Some(pid)) = tmux.pane_pid().await {
            hard_kill(pid).await;
        }
    }

    // 4. Definitive teardown. A failure here is surfaced but status still cleans.
    if let Err(e) = tmux.kill_session().await {
        emit_alert(state, name, "error", &format!("stop teardown failed: {e}"));
    }
    db::sessions::set_last_status(&state.pool, name, "stopped").await?;
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
pub async fn archive(state: &AppState, name: &str) -> Result<String, AppError> {
    if !db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let job_id = uuid::Uuid::new_v4().to_string();

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

        // R1-1: flip `archived = 1` BEFORE waking the loops so that when they
        // re-evaluate their `exists_active` guard they observe the archived row
        // and terminate (an archived row no longer satisfies `exists_active`).
        let _ = db::sessions::set_archived(&state.pool, &name, true).await;
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

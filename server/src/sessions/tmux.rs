//! Thin `tokio::process` wrappers around the `tmux` CLI (TECH_PLAN §3.2.6, §3.5).
//!
//! **Naming (§3.5).** Every supermux session lives in a tmux session named
//! `supermux-<name>` (the `supermux-` prefix keeps v2's `amux-<name>` sessions from
//! colliding during the side-by-side dogfooding window — v3 also refuses to
//! adopt any session that is not `supermux-` prefixed).
//!
//! **Large pastes (the cmux lesson).** [`Tmux::send_text`] sends literal text via
//! `send-keys -l` for short input but switches to `load-buffer`/`paste-buffer`
//! once the payload exceeds [`PASTE_THRESHOLD`] bytes — `send-keys` arg lists are
//! bounded by `ARG_MAX` and large literal sends corrupt or truncate. The buffer
//! path streams the bytes over the child's stdin (no arg-length limit) and pastes
//! in bracketed mode so the application sees one paste, not N keystrokes.
//!
//! Every method shells out to the `tmux` binary located once via
//! [`which::which`]; a non-zero exit becomes an `anyhow` error carrying stderr.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use once_cell::sync::Lazy;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Payloads larger than this (in bytes) go through `load-buffer`/`paste-buffer`
/// instead of `send-keys -l`. Bytes (not chars) because the real limit being
/// dodged is the kernel `ARG_MAX` on the argv that carries the literal text.
pub const PASTE_THRESHOLD: usize = 400;

/// Located once at first use. `None` if tmux is not installed.
static TMUX_BIN: Lazy<Option<PathBuf>> = Lazy::new(|| which::which("tmux").ok());

fn tmux_bin() -> Result<&'static Path> {
    TMUX_BIN
        .as_deref()
        .ok_or_else(|| anyhow!("tmux not found on PATH (install tmux)"))
}

/// What a [`Tmux`] handle addresses (Agent Teams, AT-E §3.5). A supermux session
/// is one tmux SESSION (`supermux-<name>`); a Claude agent-team **teammate** is a
/// split-window PANE inside the lead's window, addressed by its tmux pane id
/// (`%id`). Generalizing the target lets `capture_pane*` / `pipe_pane_to_fifo` /
/// `send_*` / list-panes / resize all operate on EITHER without touching the
/// session happy-path: a `Session` target still emits `-t supermux-<name>`
/// byte-for-byte, a `Pane` target emits `-t %id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TmuxTarget {
    /// A supermux session, addressed as `supermux-<name>`. Holds the BARE name.
    Session(String),
    /// A specific tmux pane, addressed by its raw pane id (e.g. `%17`). Used for
    /// agent-team teammate panes (split-windows inside the lead's window).
    Pane(String),
}

impl TmuxTarget {
    /// The `-t` argument tmux receives: `supermux-<name>` for a session, the raw
    /// `%id` for a pane. This is the ONE place the `supermux-` prefix is applied,
    /// so session-targeting stays identical to the pre-AT-E behaviour.
    pub fn arg(&self) -> String {
        match self {
            TmuxTarget::Session(name) => format!("supermux-{name}"),
            TmuxTarget::Pane(id) => id.clone(),
        }
    }

    /// True for a teammate pane target — callers use this to pick pane-scoped
    /// behaviour (e.g. `resize-pane` vs `resize-window`).
    pub fn is_pane(&self) -> bool {
        matches!(self, TmuxTarget::Pane(_))
    }
}

/// A handle to one tmux [`TmuxTarget`] (a session OR a pane). Cheap to construct.
///
/// Backwards-compatible: [`Tmux::new`] still takes a bare session name and the
/// `supermux-` prefix is applied internally exactly as before. [`Tmux::for_pane`]
/// builds a pane-targeted handle for agent-team teammate streaming.
pub struct Tmux<'a> {
    /// Bare session name for a `Session` handle; the pane id for a `Pane` handle.
    /// Retained for log lines / paste-buffer naming.
    name: &'a str,
    target: TmuxTarget,
}

impl<'a> Tmux<'a> {
    /// Wrap the bare session `name` (NOT the `supermux-` prefixed form). The
    /// resulting handle targets `supermux-<name>`.
    pub fn new(name: &'a str) -> Self {
        Self {
            name,
            target: TmuxTarget::Session(name.to_string()),
        }
    }

    /// Wrap a tmux pane id (`%id`) — a teammate split-window inside a lead's
    /// window (Agent Teams). All commands target `-t %id`. `name` is used only for
    /// diagnostics / buffer naming; pass the pane id (or a `{lead}/{member}` key).
    pub fn for_pane(name: &'a str, pane_id: impl Into<String>) -> Self {
        Self {
            name,
            target: TmuxTarget::Pane(pane_id.into()),
        }
    }

    /// The tmux `-t` argument for this handle: `supermux-<name>` for a session,
    /// the raw `%id` for a pane.
    pub fn target(&self) -> String {
        self.target.arg()
    }

    /// True when this handle targets a teammate pane (`%id`) rather than a session.
    pub fn is_pane(&self) -> bool {
        self.target.is_pane()
    }

    // ── command helpers ──────────────────────────────────────────────────────

    /// Run `tmux <args>`; return stdout (lossy UTF-8) on success, error on a
    /// non-zero exit (stderr included).
    async fn run(&self, args: &[&str]) -> Result<String> {
        let out = Command::new(tmux_bin()?)
            .args(args)
            .output()
            .await
            .with_context(|| format!("spawning tmux {args:?}"))?;
        if !out.status.success() {
            return Err(anyhow!(
                "tmux {:?} failed ({}): {}",
                args,
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /// Run `tmux <args>` feeding `stdin_data` to the child's stdin (for
    /// `load-buffer -`). No arg-length limit applies to the streamed bytes.
    async fn run_stdin(&self, args: &[&str], stdin_data: &[u8]) -> Result<()> {
        let mut child = Command::new(tmux_bin()?)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("spawning tmux {args:?}"))?;
        child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("tmux child stdin unavailable"))?
            .write_all(stdin_data)
            .await
            .context("writing tmux load-buffer stdin")?;
        // stdin dropped here → EOF for the child.
        let out = child.wait_with_output().await.context("awaiting tmux")?;
        if !out.status.success() {
            return Err(anyhow!(
                "tmux {:?} failed ({}): {}",
                args,
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }

    // ── lifecycle ────────────────────────────────────────────────────────────

    /// Generous scrollback retained per pane (`history-limit`). The tmux default
    /// is a mere ~2000 lines, which caps how far back a freshly-attached client
    /// can scroll regardless of the WS replay size. 50000 lines comfortably
    /// exceeds the replayed byte budget and the xterm.js `scrollback` so the
    /// history actually exists to replay/scroll. tmux trims oldest lines past
    /// this, so per-session memory stays bounded.
    const HISTORY_LIMIT: u32 = 50_000;

    /// Create a detached session running `shell`, with `dir` as the working
    /// directory and `env` injected per-pane. Sets `remain-on-exit on` (so a dead
    /// pane stays capturable for status/archive), a generous `history-limit` (so
    /// scrollback history exists to replay/scroll), and disables auto-rename.
    ///
    /// `env` MUST NOT contain the dashboard bearer token (§6.5) — only the
    /// narrow `SUPERMUX_HOOK_TOKEN`/`SUPERMUX_SESSION`/`SUPERMUX_URL`.
    pub async fn new_session(
        &self,
        dir: &Path,
        env: &HashMap<String, String>,
        shell: &str,
    ) -> Result<()> {
        let target = self.target();
        let dir_str = dir.to_string_lossy().to_string();
        let history_limit = Self::HISTORY_LIMIT.to_string();

        // tmux reads `history-limit` at PANE-creation time, so the session's
        // initial pane only inherits a generous scrollback if the option is set
        // BEFORE `new-session`. Set it on the global server option (a sensible
        // server-wide default; harmless and idempotent). Best-effort: a failure
        // here just falls back to tmux's small default, never blocks the session.
        let _ = self
            .run(&["set-option", "-g", "history-limit", &history_limit])
            .await;

        // Build argv: new-session -d -s supermux-<name> -n <name> -c <dir> [-e K=V…] <shell>
        let mut args: Vec<String> = vec![
            "new-session".into(),
            "-d".into(),
            "-s".into(),
            target.clone(),
            "-n".into(),
            self.name.to_string(),
            "-c".into(),
            dir_str,
        ];
        // Deterministic env ordering keeps logs/tests stable.
        let mut env_pairs: Vec<(&String, &String)> = env.iter().collect();
        env_pairs.sort_by(|a, b| a.0.cmp(b.0));
        for (k, v) in env_pairs {
            args.push("-e".into());
            args.push(format!("{k}={v}"));
        }
        args.push(shell.to_string());

        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run(&arg_refs).await.context("tmux new-session")?;

        // Best-effort hardening; failures here are not fatal to a live session.
        // `history-limit` is also set session-scoped so any panes/windows created
        // later in this session inherit the generous scrollback even if the global
        // default changes underneath us.
        for opt in [
            ["set-option", "-t", &target, "remain-on-exit", "on"],
            ["set-option", "-t", &target, "allow-rename", "off"],
            ["set-option", "-t", &target, "history-limit", &history_limit],
            ["set-window-option", "-t", &target, "automatic-rename", "off"],
        ] {
            let _ = self.run(&opt).await;
        }
        Ok(())
    }

    /// `tmux kill-session -t supermux-<name>`. Ok if the session is already gone.
    pub async fn kill_session(&self) -> Result<()> {
        if !self.exists().await.unwrap_or(false) {
            return Ok(());
        }
        self.run(&["kill-session", "-t", &self.target()]).await?;
        Ok(())
    }

    /// `tmux has-session -t supermux-<name>` → true on exit 0.
    pub async fn exists(&self) -> Result<bool> {
        let ok = Command::new(tmux_bin()?)
            .args(["has-session", "-t", &self.target()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .with_context(|| "spawning tmux has-session")?
            .success();
        Ok(ok)
    }

    /// Is the addressed PANE still alive (Agent Teams §3.5)? `list-panes -t %id`
    /// succeeds (exit 0, ≥1 line) only while the pane exists; once the teammate
    /// pane is killed tmux exits non-zero. This is the pane analogue of
    /// [`exists`](Self::exists) (which is `has-session`, meaningless for a `%id`),
    /// so the pty reader's liveness poll tears a teammate stream down the instant
    /// its pane is gone — never streaming a stale/reused id. Best-effort: any tmux
    /// fault reads as "gone" (false) so the stream errs toward teardown.
    pub async fn pane_alive(&self) -> bool {
        match self
            .run(&["list-panes", "-t", &self.target(), "-F", "#{pane_id}"])
            .await
        {
            Ok(out) => out.lines().any(|l| !l.trim().is_empty()),
            Err(_) => false,
        }
    }

    /// Unified liveness for either target kind: a SESSION uses `has-session`, a
    /// teammate PANE uses [`pane_alive`](Self::pane_alive). The pty reader polls
    /// this so a pane stream and a session stream share one teardown rule.
    pub async fn target_alive(&self) -> bool {
        if self.is_pane() {
            self.pane_alive().await
        } else {
            self.exists().await.unwrap_or(false)
        }
    }

    /// True when the pane's program has exited but the session is held open by
    /// `remain-on-exit` (`#{pane_dead}` == 1).
    pub async fn pane_dead(&self) -> Result<bool> {
        let out = self
            .run(&[
                "list-panes",
                "-t",
                &self.target(),
                "-F",
                "#{pane_dead}",
            ])
            .await?;
        Ok(out.lines().next().map(|l| l.trim()) == Some("1"))
    }

    // ── capture ──────────────────────────────────────────────────────────────

    /// `tmux capture-pane -p -S -<lines>` — the last `lines` rows, plain text.
    /// Read-only: never acquires the per-session lock (§3.2.5 detector rule).
    pub async fn capture_pane(&self, lines: usize) -> Result<String> {
        let start = format!("-{lines}");
        self.run(&[
            "capture-pane",
            "-p",
            "-t",
            &self.target(),
            "-S",
            &start,
        ])
        .await
    }

    /// `tmux capture-pane -pe -S -<lines>` — the last `lines` rows WITH SGR escape
    /// sequences preserved (`-e`). Drives the colour-true tile preview; the plain
    /// `capture_pane` above still feeds the status detector. Read-only, no lock.
    pub async fn capture_pane_ansi(&self, lines: usize) -> Result<String> {
        let start = format!("-{lines}");
        self.run(&[
            "capture-pane",
            "-p",
            "-e",
            "-t",
            &self.target(),
            "-S",
            &start,
        ])
        .await
    }

    /// `tmux capture-pane -p -e` — the CURRENT VISIBLE screen only (no `-S`
    /// scrollback) WITH SGR escapes preserved. Used to seed a fresh reader's
    /// replay buffer so a subscriber that connects before any new byte flows
    /// (e.g. an idle session whose live stream was just re-attached after a
    /// server restart — see session-survival) still sees the current screen
    /// instead of a black pane. Read-only, no lock.
    pub async fn capture_screen_ansi(&self) -> Result<String> {
        self.run(&["capture-pane", "-p", "-e", "-t", &self.target()])
            .await
    }

    /// Capture the entire scrollback (`-S -`), used by `archive`.
    pub async fn capture_full(&self) -> Result<String> {
        self.run(&["capture-pane", "-p", "-t", &self.target(), "-S", "-"])
            .await
    }

    // ── input ────────────────────────────────────────────────────────────────

    /// Inject `text` literally — NO trailing Enter (callers send `Enter`
    /// separately). Short text uses `send-keys -l`; payloads over
    /// [`PASTE_THRESHOLD`] bytes stream through a tmux paste buffer (the cmux
    /// large-paste fix — `send-keys` argv is `ARG_MAX`-bounded and corrupts large
    /// literals).
    ///
    /// The buffer path is **non-bracketed** (raw): `send_text` carries a command
    /// to run, and bracketed paste triggers zsh's `bracketed-paste-magic`, which
    /// backslash-escapes shell metacharacters (`'`, `>`, `|`, …) and breaks the
    /// command. Bracketed mode is reserved for [`paste_via_buffer`]'s explicit
    /// `paste()` caller, where literal preservation is what's wanted.
    pub async fn send_text(&self, text: &str) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        if text.len() > PASTE_THRESHOLD {
            self.paste_via_buffer(text, false).await
        } else {
            // `--` so a leading '-' in the text isn't parsed as a flag.
            self.run(&["send-keys", "-t", &self.target(), "-l", "--", text])
                .await
                .map(|_| ())
        }
    }

    /// Paste `text` via a named tmux buffer (always, regardless of length).
    /// `bracketed` requests bracketed-paste mode so the receiving app treats it
    /// as a single paste (`paste-buffer -p`).
    pub async fn paste_via_buffer(&self, text: &str, bracketed: bool) -> Result<()> {
        let target = self.target();
        let buf = format!("supermux-paste-{}", self.name);
        // load-buffer reads the payload from stdin (`-`): no arg-length limit.
        self.run_stdin(
            &["load-buffer", "-b", &buf, "-t", &target, "-"],
            text.as_bytes(),
        )
        .await
        .context("tmux load-buffer")?;
        // -d deletes the buffer after pasting; -p = bracketed paste.
        let mut args: Vec<&str> = vec!["paste-buffer", "-d", "-b", &buf, "-t", &target];
        if bracketed {
            args.push("-p");
        }
        self.run(&args).await.context("tmux paste-buffer")?;
        Ok(())
    }

    /// Send a named tmux key (e.g. `Enter`, `C-c`, `Escape`). Not literal.
    pub async fn send_key(&self, key: &str) -> Result<()> {
        self.run(&["send-keys", "-t", &self.target(), key])
            .await
            .map(|_| ())
    }

    /// `tmux resize-window -x <cols> -y <rows>`. Bounds enforced by callers.
    /// Window-scoped — the supermux-session happy path. For a teammate PANE use
    /// [`resize_pane`](Self::resize_pane) instead (Agent Teams §3.5).
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let (c, r) = (cols.to_string(), rows.to_string());
        self.run(&[
            "resize-window",
            "-t",
            &self.target(),
            "-x",
            &c,
            "-y",
            &r,
        ])
        .await
        .map(|_| ())
    }

    /// `tmux resize-pane -t <target> -x <cols> -y <rows>` — resize a SINGLE pane
    /// (Agent Teams §3.5), distinct from [`resize`](Self::resize)'s
    /// whole-window `resize-window`. Provided for completeness; teammate streaming
    /// is read-only by default precisely because tmux splits SHARE the window's
    /// geometry — resizing one teammate reflows its siblings — so callers should
    /// prefer streaming at tmux's given size and reserve this for explicit
    /// resize intent. `cols`/`rows` bounds enforced by callers.
    pub async fn resize_pane(&self, cols: u16, rows: u16) -> Result<()> {
        let (c, r) = (cols.to_string(), rows.to_string());
        self.run(&[
            "resize-pane",
            "-t",
            &self.target(),
            "-x",
            &c,
            "-y",
            &r,
        ])
        .await
        .map(|_| ())
    }

    /// On-disk log capture: `pipe-pane -O -t <target> 'cat >> <path>'`. Replaces
    /// any existing pipe (idempotent). M4 supersedes this with the `tee … > fifo`
    /// form once a WS client subscribes; this gives plain logging meanwhile.
    pub async fn pipe_pane(&self, target_path: &Path) -> Result<()> {
        let cmd = format!("cat >> {}", shell_escape::escape(target_path.to_string_lossy()));
        self.run(&["pipe-pane", "-O", "-t", &self.target(), &cmd])
            .await
            .map(|_| ())
    }

    /// M4 live-stream pipe: `pipe-pane -O -t <target> 'tee -a <log> > <fifo>'`.
    /// Pane output is appended to the on-disk `log` (durable) AND mirrored into
    /// the named `fifo` that [`crate::sessions::pty::PtyStream`] reads. `-O`
    /// captures pane→outside only; `pipe-pane` replaces any existing pipe, so a
    /// re-subscribe is idempotent. `tee`'s open of the FIFO blocks until the
    /// reader opens its end — the caller opens the read fd right after.
    pub async fn pipe_pane_to_fifo(&self, log: &Path, fifo: &Path) -> Result<()> {
        let cmd = format!(
            "tee -a {} > {}",
            shell_escape::escape(log.to_string_lossy()),
            shell_escape::escape(fifo.to_string_lossy()),
        );
        self.run(&["pipe-pane", "-O", "-t", &self.target(), &cmd])
            .await
            .map(|_| ())
    }

    /// The pane's shell PID (`#{pane_pid}`). The agent (claude/codex) runs as a
    /// child of this. `None` if no pane is reported.
    pub async fn pane_pid(&self) -> Result<Option<u32>> {
        let out = self
            .run(&["list-panes", "-t", &self.target(), "-F", "#{pane_pid}"])
            .await?;
        Ok(out.lines().next().and_then(|l| l.trim().parse::<u32>().ok()))
    }

    /// Every pane id (`%id`) live in this SESSION's window (Agent Teams §3.2).
    /// Uses `list-panes -a`-free, session-scoped form (`-t supermux-<name>`) so a
    /// lead's teammate split-windows are all enumerated. Used to VALIDATE that a
    /// teammate `%id` from `config.json` still exists before streaming it — tmux
    /// pane ids are a reused server-global counter, so a stale `%id` could resolve
    /// to an unrelated pane. Call on a `Session` handle for the lead.
    pub async fn list_pane_ids(&self) -> Result<Vec<String>> {
        let out = self
            .run(&["list-panes", "-t", &self.target(), "-F", "#{pane_id}"])
            .await?;
        Ok(out
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect())
    }
}

/// Does pane `pane_id` (`%id`) currently exist in the lead session's window
/// (Agent Teams §3.2)? Free function (takes the LEAD's bare session name + the
/// candidate pane id) because the validation crosses targets: we list the LEAD
/// session's panes and check membership. Returns `Ok(false)` when the session is
/// gone or the id is absent — NEVER errors on "not found", only on a tmux fault.
pub async fn pane_in_session(lead_session: &str, pane_id: &str) -> Result<bool> {
    let lead = Tmux::new(lead_session);
    if !lead.exists().await.unwrap_or(false) {
        return Ok(false);
    }
    Ok(lead.list_pane_ids().await?.iter().any(|p| p == pane_id))
}

#[cfg(test)]
mod target_tests {
    //! Target-string formatting (Agent Teams §3.5). Pins that a `Session` target
    //! keeps emitting `-t supermux-<name>` byte-for-byte (NO regression) while a
    //! `Pane` target emits the raw `%id`, so threading the target through every
    //! tmux verb can't silently change the session happy-path argument.

    use super::*;

    #[test]
    fn session_target_keeps_the_supermux_prefix() {
        // The pre-AT-E behaviour, unchanged: a bare name → `supermux-<name>`.
        assert_eq!(TmuxTarget::Session("myproj".into()).arg(), "supermux-myproj");
        assert_eq!(Tmux::new("myproj").target(), "supermux-myproj");
    }

    #[test]
    fn pane_target_is_the_raw_pane_id() {
        // A teammate pane is addressed by its raw `%id` with NO prefix.
        assert_eq!(TmuxTarget::Pane("%17".into()).arg(), "%17");
        assert_eq!(Tmux::for_pane("teamA/worker-1", "%17").target(), "%17");
    }

    #[test]
    fn is_pane_distinguishes_the_two() {
        assert!(!Tmux::new("s").is_pane());
        assert!(Tmux::for_pane("s", "%3").is_pane());
        assert!(!TmuxTarget::Session("s".into()).is_pane());
        assert!(TmuxTarget::Pane("%3".into()).is_pane());
    }
}

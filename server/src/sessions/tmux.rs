//! Thin `tokio::process` wrappers around the `tmux` CLI (TECH_PLAN §3.2.6, §3.5).
//!
//! **Naming (§3.5).** Every amux-v3 session lives in a tmux session named
//! `amux3-<name>` (the `amux3-` prefix keeps v2's `amux-<name>` sessions from
//! colliding during the side-by-side dogfooding window — v3 also refuses to
//! adopt any session that is not `amux3-` prefixed).
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

/// A handle to one session's tmux conventions. Cheap to construct (borrows the
/// bare session name; the `amux3-` prefix is applied internally).
pub struct Tmux<'a> {
    name: &'a str,
}

impl<'a> Tmux<'a> {
    /// Wrap the bare session `name` (NOT the `amux3-` prefixed form).
    pub fn new(name: &'a str) -> Self {
        Self { name }
    }

    /// The tmux session/target name: `amux3-<name>`.
    pub fn target(&self) -> String {
        format!("amux3-{}", self.name)
    }

    /// `/tmp/amux3-pty-<name>.fifo` — the live-stream FIFO path (filled by M4).
    pub fn fifo_path(&self) -> PathBuf {
        PathBuf::from(format!("/tmp/amux3-pty-{}.fifo", self.name))
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

    /// Create a detached session running `shell`, with `dir` as the working
    /// directory and `env` injected per-pane. Sets `remain-on-exit on` (so a dead
    /// pane stays capturable for status/archive) and disables auto-rename.
    ///
    /// `env` MUST NOT contain the dashboard bearer token (§6.5) — only the
    /// narrow `AMUX_HOOK_TOKEN`/`AMUX_SESSION`/`AMUX_URL`.
    pub async fn new_session(
        &self,
        dir: &Path,
        env: &HashMap<String, String>,
        shell: &str,
    ) -> Result<()> {
        let target = self.target();
        let dir_str = dir.to_string_lossy().to_string();

        // Build argv: new-session -d -s amux3-<name> -n <name> -c <dir> [-e K=V…] <shell>
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
        for opt in [
            ["set-option", "-t", &target, "remain-on-exit", "on"],
            ["set-option", "-t", &target, "allow-rename", "off"],
            ["set-window-option", "-t", &target, "automatic-rename", "off"],
        ] {
            let _ = self.run(&opt).await;
        }
        Ok(())
    }

    /// `tmux kill-session -t amux3-<name>`. Ok if the session is already gone.
    pub async fn kill_session(&self) -> Result<()> {
        if !self.exists().await.unwrap_or(false) {
            return Ok(());
        }
        self.run(&["kill-session", "-t", &self.target()]).await?;
        Ok(())
    }

    /// `tmux has-session -t amux3-<name>` → true on exit 0.
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
        let buf = format!("amux3-paste-{}", self.name);
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
}

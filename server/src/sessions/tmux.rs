//! Thin `tokio::process` wrappers around the `tmux` CLI.
//!
//! **Naming.** Every supermux session lives in a tmux session named
//! `supermux-<name>` (v3 refuses to adopt any session that is not `supermux-`
//! prefixed).
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

use super::transport::{Transport, LOCAL};

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

/// What a [`Tmux`] handle addresses. A supermux session
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
    /// The BARE name tmux knows this target by: `supermux-<name>` for a session,
    /// the raw `%id` for a pane. This is the ONE place the `supermux-` prefix is
    /// applied. Use it for `new-session -s` / `rename-session <new>` (which take a
    /// literal NAME) and for any place that compares against `#{session_name}`.
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
///
/// **Transport.** Every shell-out goes through the
/// `transport: &'a Transport` — `Tmux::new(name)` defaults to a static
/// `&LOCAL` (zero-cost, no behaviour change for today's callers);
/// `Tmux::new_on(transport, name)` threads in an SSH transport for remote-host
/// sessions (wired up by `HostPool`). Local + remote share the same
/// argv-building code below; only the spawn step differs.
pub struct Tmux<'a> {
    /// Bare session name for a `Session` handle; the pane id for a `Pane` handle.
    /// Retained for log lines / paste-buffer naming.
    name: &'a str,
    target: TmuxTarget,
    /// Where to run tmux: local or via an SSH ControlMaster.
    transport: &'a Transport,
}

impl<'a> Tmux<'a> {
    /// Wrap the bare session `name` (NOT the `supermux-` prefixed form). The
    /// resulting handle targets `supermux-<name>` and runs tmux LOCALLY (the
    /// existing behaviour — every today-caller takes this default path with
    /// no allocation thanks to the static `&LOCAL`).
    pub fn new(name: &'a str) -> Self {
        Self::new_on(&LOCAL, name)
    }

    /// Like [`Tmux::new`] but with an explicit `transport` (for remote-host
    /// sessions).
    pub fn new_on(transport: &'a Transport, name: &'a str) -> Self {
        Self {
            name,
            target: TmuxTarget::Session(name.to_string()),
            transport,
        }
    }

    /// Wrap a tmux pane id (`%id`) — a teammate split-window inside a lead's
    /// window (Agent Teams). All commands target `-t %id`. `name` is used only for
    /// diagnostics / buffer naming; pass the pane id (or a `{lead}/{member}` key).
    /// Local transport — see [`Tmux::for_pane_on`] for remote.
    pub fn for_pane(name: &'a str, pane_id: impl Into<String>) -> Self {
        Self::for_pane_on(&LOCAL, name, pane_id)
    }

    /// Like [`Tmux::for_pane`] but with an explicit `transport`.
    pub fn for_pane_on(
        transport: &'a Transport,
        name: &'a str,
        pane_id: impl Into<String>,
    ) -> Self {
        Self {
            name,
            target: TmuxTarget::Pane(pane_id.into()),
            transport,
        }
    }

    /// The BARE tmux name for this handle: `supermux-<name>` for a session, the
    /// raw `%id` for a pane. For `-s`/rename literal names and name comparisons.
    pub fn target(&self) -> String {
        self.target.arg()
    }

    /// The EXACT `-t` target for this handle, resolved at runtime to a tmux
    /// session-id (`$N`) for sessions or the bare `%id` for panes. Every
    /// session-targeted `-t` shell-out below uses this so a session never
    /// shadows another whose name it prefixes — `$N` is allocated by the tmux
    /// server, globally unique, and never substring-matched.
    ///
    /// History: an earlier fix used the `=name` exact-match prefix tmux
    /// documents for session targets, but on tmux 3.4 (Ubuntu noble + the
    /// other current LTS targets) `=name` is rejected for pane-target
    /// commands with `can't find pane: =name`, breaking every
    /// `capture-pane` / `send-keys` / `pipe-pane` call in the binary. The
    /// session-id approach side-steps the whole resolver.
    ///
    /// Async because the lookup runs a tmux `list-sessions` exec. On a miss
    /// (session has been killed, server down) the bare `supermux-<name>`
    /// falls through so the caller's command produces the same natural
    /// "session not found" error a torn-down session would have produced
    /// without this fix.
    pub async fn target_match(&self) -> String {
        match &self.target {
            TmuxTarget::Pane(id) => id.clone(),
            TmuxTarget::Session(name) => {
                let bare = format!("supermux-{name}");
                self.resolve_session_id(&bare).await.unwrap_or(bare)
            }
        }
    }

    /// Look up the live `$<id>` for a session by EXACT name match in Rust.
    /// Returns `None` when the session does not exist or `list-sessions`
    /// fails (no tmux server running, transport down) — callers fall back to
    /// the bare name in both cases, which then produces the correct
    /// session-not-found error.
    async fn resolve_session_id(&self, full_name: &str) -> Option<String> {
        let out = self
            .run(&["list-sessions", "-F", "#{session_id} #{session_name}"])
            .await
            .ok()?;
        for line in out.lines() {
            let (id, n) = line.split_once(' ')?;
            if n == full_name {
                return Some(id.to_string());
            }
        }
        None
    }

    /// Diagnostic (cross-session-leak catcher): resolve this handle's `-t`
    /// target exactly as every capture/pipe/send does, then ask tmux which
    /// `session_name` that target ACTUALLY maps to. The WS attach logs this so a
    /// target that ever resolves to a DIFFERENT session than requested leaves
    /// hard proof in the journal — instead of an unverifiable "I think I saw
    /// another session's output" report. Read-only; one extra `display-message`.
    /// `None` when the lookup fails (no tmux server / gone session) — callers
    /// treat that as "nothing to verify".
    pub async fn resolved_session_name(&self) -> Option<String> {
        let target = self.target_match().await;
        let out = self
            .run(&["display-message", "-p", "-t", &target, "#{session_name}"])
            .await
            .ok()?;
        out.lines()
            .next()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    /// True when this handle targets a teammate pane (`%id`) rather than a session.
    pub fn is_pane(&self) -> bool {
        self.target.is_pane()
    }

    // ── command helpers ──────────────────────────────────────────────────────

    /// The program string to hand to [`Transport::spawn_command`]. LOCAL uses
    /// the cached absolute path from `which::which("tmux")` (one PATH lookup at
    /// first use, never re-walked);
    /// SSH uses the bare `"tmux"` and lets the remote shell resolve it via
    /// the remote PATH (the remote `tmux` install lives wherever the remote
    /// user's `which` says — we don't get to cache it from here).
    fn program_for_transport(&self) -> Result<String> {
        if self.transport.is_local() {
            Ok(tmux_bin()?.to_string_lossy().into_owned())
        } else {
            Ok("tmux".to_string())
        }
    }

    /// Run `tmux <args>`; return stdout (lossy UTF-8) on success, error on a
    /// non-zero exit (stderr included).
    async fn run(&self, args: &[&str]) -> Result<String> {
        let program = self.program_for_transport()?;
        let out = self
            .transport
            .spawn_command(&program, args)
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
        let program = self.program_for_transport()?;
        let mut child = self
            .transport
            .spawn_command(&program, args)
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
    /// `env` MUST NOT contain the dashboard bearer token — only the
    /// narrow `SUPERMUX_HOOK_TOKEN`/`SUPERMUX_SESSION`/`SUPERMUX_URL`.
    pub async fn new_session(
        &self,
        dir: &Path,
        env: &HashMap<String, String>,
        shell: &str,
    ) -> Result<()> {
        let target = self.target(); // bare name — `new-session -s` takes a literal NAME
        let target_match = self.target_match().await; // exact `=`-target for `-t` post-create opts
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

        // Synchronized-output passthrough (DECSET 2026; tmux 3.4+). Without this
        // tmux silently drops the `\x1b[?2026h ... \x1b[?2026l` sequences that
        // Claude Code's Ink renderer emits to batch a full-frame redraw, so the
        // pipe-pane sees the renderer's INTERMEDIATE flushes — line erases,
        // partial cursor moves, half-painted prompt bars — and those torn
        // fragments fan out over the WS as their own broadcast chunks. xterm.js
        // then paints frame N's bottom row(s) before frame N+1's top arrives,
        // and the user sees "Determining…" / "Did 1 search…" lines stack
        // visibly in TWO positions (the leftover partial AND the next-frame
        // repaint). The exact failure mode tracked upstream as claude-code#37283,
        // #49086, #51828, #40555, #57145 — confirmed across many terminals
        // because nearly every wrapping multiplexer (tmux, screen, mosh)
        // defaults to NO sync passthrough.
        //
        // Enabling it tells tmux: when the inner app opens a sync block, BUFFER
        // the pane output until the app closes it (or 1s timeout) and emit one
        // coherent flush to the pipe-pane. The downstream broadcast then carries
        // whole-frame redraws, no torn fragments, no duplicate-looking ghosts.
        //
        // SAFETY of the change:
        //   • `set -as terminal-features` is ADDITIVE (`-a`): we only add the
        //     `sync` capability to the `xterm*` TERM class, never remove an
        //     existing one. supermux always sets `TERM=xterm-256color`
        //     (lifecycle.rs), so the pattern matches exactly the panes we own.
        //   • `-g` makes it a server-global default. supermux owns the tmux
        //     server it spawns (a fresh server boot for each first session),
        //     so this affects supermux panes only in practice. A teammate
        //     pane on the same server inherits the benefit — same render fix
        //     applies, no regression.
        //   • For a session that NEVER emits `\x1b[?2026h` (a plain shell, vim,
        //     less), the sync gate is never entered, so flush behaviour is
        //     byte-identical to today. Pure additive: a TUI that opts in gets
        //     coherent frames; everything else is unchanged.
        //   • xterm.js 5.5 does NOT implement DECSET 2026 itself (added in 6.0)
        //     — it silently ignores the `\x1b[?2026h/l` bytes as unknown DEC
        //     private modes. The frame-coherence we want comes ENTIRELY from
        //     tmux batching upstream; the client renderer is incidental.
        //   • Old tmux (<3.4) doesn't recognize the `sync` feature token and
        //     rejects the command. Best-effort with `let _ = ...` so a failure
        //     here is a no-op (sessions still attach; behaviour falls back to
        //     today's torn-frame state — same shape as pre-fix, no regression).
        //   • Idempotent: re-running on a server that already has the feature
        //     is a no-op (the `-a` append silently dedupes — tmux's option
        //     parser de-duplicates the same feature string).
        let _ = self
            .run(&["set-option", "-g", "-as", "terminal-features", "xterm*:sync"])
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
            ["set-option", "-t", &target_match, "remain-on-exit", "on"],
            ["set-option", "-t", &target_match, "allow-rename", "off"],
            ["set-option", "-t", &target_match, "history-limit", &history_limit],
            ["set-window-option", "-t", &target_match, "automatic-rename", "off"],
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
        self.run(&["kill-session", "-t", &self.target_match().await]).await?;
        Ok(())
    }

    /// `tmux rename-session -t supermux-<name> supermux-<new>` — rename the LIVE
    /// tmux session so it keeps resolving under the session's NEW name. The
    /// window/pane (and its `pipe-pane` capture) survive the rename untouched —
    /// only the session label changes — so the caller must invalidate the cached
    /// pty stream afterwards (its liveness poll watches the OLD name) to force a
    /// fresh attach against the new name. Caller verifies the session exists.
    pub async fn rename_session(&self, new_bare: &str) -> Result<()> {
        let new_target = format!("supermux-{new_bare}");
        self.run(&["rename-session", "-t", &self.target_match().await, &new_target])
            .await?;
        Ok(())
    }

    /// `tmux list-sessions -F #{session_name}` + EXACT name match in Rust. We
    /// deliberately do NOT use `tmux has-session -t <name>` because that
    /// path's target resolver is prefix/fnmatch-based, so a bare
    /// `supermux-foo` would wrongly report the session alive when only the
    /// longer `supermux-foo-side` exists (the start-skip / shadowing bug
    /// `linkbuilder` vs `linkbuilder-mailer`). The `=name` exact-match prefix
    /// tmux documents for this is rejected on tmux 3.4 (`can't find pane`),
    /// so we dodge the whole resolver and match in Rust.
    ///
    /// For pane handles (`%id`) we return `false`: panes aren't sessions, and
    /// the previous `has-session -t %id` would have errored too. Callers
    /// that need pane liveness use [`pane_alive`].
    pub async fn exists(&self) -> Result<bool> {
        let name = match &self.target {
            TmuxTarget::Session(n) => n,
            TmuxTarget::Pane(_) => return Ok(false),
        };
        let full = format!("supermux-{name}");
        // `list-sessions` exits non-zero when there is no tmux server. Treat
        // that as "no session" — same shape the old `has-session` returned in
        // that state.
        let out = match self
            .run(&["list-sessions", "-F", "#{session_name}"])
            .await
        {
            Ok(s) => s,
            Err(_) => return Ok(false),
        };
        Ok(out.lines().any(|l| l == full))
    }

    /// Is the addressed PANE still alive? `list-panes -t %id`
    /// succeeds (exit 0, ≥1 line) only while the pane exists; once the teammate
    /// pane is killed tmux exits non-zero. This is the pane analogue of
    /// [`exists`](Self::exists) (which is `has-session`, meaningless for a `%id`),
    /// so the pty reader's liveness poll tears a teammate stream down the instant
    /// its pane is gone — never streaming a stale/reused id. Best-effort: any tmux
    /// fault reads as "gone" (false) so the stream errs toward teardown.
    pub async fn pane_alive(&self) -> bool {
        match self
            .run(&["list-panes", "-t", &self.target_match().await, "-F", "#{pane_id}"])
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
                &self.target_match().await,
                "-F",
                "#{pane_dead}",
            ])
            .await?;
        Ok(out.lines().next().map(|l| l.trim()) == Some("1"))
    }

    // ── capture ──────────────────────────────────────────────────────────────

    /// `tmux capture-pane -p -S -<lines>` — the last `lines` rows, plain text.
    /// Read-only: never acquires the per-session lock (detector rule).
    pub async fn capture_pane(&self, lines: usize) -> Result<String> {
        let start = format!("-{lines}");
        self.run(&[
            "capture-pane",
            "-p",
            "-t",
            &self.target_match().await,
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
            &self.target_match().await,
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
        self.run(&["capture-pane", "-p", "-e", "-t", &self.target_match().await])
            .await
    }

    /// Capture the entire scrollback (`-S -`), used by `archive`.
    pub async fn capture_full(&self) -> Result<String> {
        self.run(&["capture-pane", "-p", "-t", &self.target_match().await, "-S", "-"])
            .await
    }

    /// `tmux capture-pane -p -e -J -S - -E -` — the FULL scrollback (entire
    /// history-limit) PLUS the current visible screen, with SGR escapes preserved
    /// (`-e`) and lines joined where tmux wrapped them at pane width (`-J`) so
    /// xterm.js re-wraps at the client's actual viewport.
    ///
    /// **WARNING** — flattens primary scrollback + alt-screen visible into one
    /// byte stream without `\x1b[?1049h` framing. Safe only for non-interactive
    /// uses (archive dump, debug print). For WS seeding or "load earlier output"
    /// use [`Self::capture_history_with_alt_screen_aware_visible`] which models
    /// the two distinct xterm.js buffers correctly. Read-only, no lock.
    pub async fn capture_full_ansi_joined(&self) -> Result<String> {
        self.run(&[
            "capture-pane",
            "-p",
            "-e",
            "-J",
            "-t",
            &self.target_match().await,
            "-S",
            "-",
            "-E",
            "-",
        ])
        .await
    }

    /// Build the alt-screen-AWARE seed payload for a fresh WS attach (and any
    /// later "re-seed" path). Returns bytes shaped so that writing them once
    /// onto a freshly opened xterm.js viewport reproduces tmux's pane state
    /// without cursor drift or duplicated TUI banners — both buffers
    /// populated, cursor where Claude's TUI expects it, full primary
    /// scrollback available for native scroll-up.
    ///
    /// Used by `ws::send_seed_then_done`; supersedes the flat
    /// `capture_full_ansi_joined` seed which was correct for shell sessions
    /// but corrupted TUI panes (primary scrollback dumped into the alt
    /// buffer, splash banner stacking, typed echo on the wrong row).
    ///
    /// Strategy (split-capture; one extra tmux fork per load, ~5ms total):
    ///
    /// 1. `tmux display-message #{alternate_on},#{cursor_x},#{cursor_y}` —
    ///    learn whether the pane is in alternate-screen (a TUI like Claude
    ///    Code) and where its cursor currently is.
    ///
    /// 2. PRIMARY-SCREEN MODE (a shell at a prompt): there is no alt screen,
    ///    so the full capture (`capture_full_ansi_joined`) already lands in
    ///    the right buffer — return it as-is (`\x1b[2J\x1b[3J\x1b[H` prefix
    ///    keeps origin deterministic, matching the WS-seed contract).
    ///
    /// 3. ALT-SCREEN MODE: capture the two buffers SEPARATELY and frame
    ///    them with the standard alt-screen escapes so xterm's two-buffer
    ///    model lines up with tmux's:
    ///      - history (`capture-pane -p -e -J -S - -E -1`) — everything
    ///        ABOVE the current visible screen, lands in the PRIMARY buffer
    ///        as scrollback (the user can scroll up to read it);
    ///      - `\x1b[?1049h\x1b[2J\x1b[H` — switch xterm to the ALT buffer,
    ///        clear it, home cursor (the alt buffer never owns scrollback);
    ///      - visible (`capture-pane -p -e`) — the current TUI frame as
    ///        Claude has it painted RIGHT NOW;
    ///      - `\x1b[<row>;<col>H` — restore the cursor to where the TUI
    ///        thinks it is, so the user's first keystroke lands in the
    ///        input row of Claude's prompt and not at a stale cell.
    ///
    /// **Race-B tightening (cursor-row-mismatch fix).** Step 3 issues three
    /// sequential tmux forks (history capture + visible capture + cursor
    /// probe), and an interactive TUI can redraw between the FIRST cursor
    /// probe in step 1 and the visible capture. If we used the step-1 cursor,
    /// the CUP at the end of the seed would point at a stale cell relative
    /// to the bytes we just captured. To pin the cursor to the SAME frame
    /// the visible body shows, we re-issue `display-message` IMMEDIATELY
    /// after `capture-pane visible` and use that SECOND reading. One extra
    /// tmux fork (~2 ms) for an order-of-magnitude tighter coupling between
    /// the cursor position and the bytes it's positioning into. The step-1
    /// probe is still required to choose primary vs alt-screen mode (the
    /// branch decision can't be deferred to after the captures).
    ///
    /// On any tmux failure we fall through to the flat full-capture (still
    /// useful, just with the old "stacked banner" oddity) rather than leaving
    /// the client empty. Read-only, no lock.
    pub async fn capture_history_with_alt_screen_aware_visible(&self) -> Result<String> {
        // 1. Probe pane mode (and a provisional cursor, used only as a
        //    fallback if the second probe in step 3c fails). The branch
        //    decision below needs `alternate_on`, so this probe stays.
        let info = self
            .run(&[
                "display-message",
                "-p",
                "-t",
                &self.target_match().await,
                "#{alternate_on},#{cursor_x},#{cursor_y},#{pane_height}",
            ])
            .await
            .unwrap_or_default();
        let (alt_on, provisional_x, provisional_y, pane_height) = parse_pane_info(&info);

        // 2. Primary-screen mode (a shell prompt, OR Claude Code — its Ink TUI
        //    renders inline on the PRIMARY screen, `alternate_on=0`). Modern
        //    Claude is almost always here. The flat full capture lands in the
        //    right buffer, but on its own it leaves the cursor at the END of the
        //    dumped body — i.e. on Claude's footer row, 2-3 rows BELOW the `❯`
        //    input — because `frame_primary_seed` never restores the cursor. So
        //    split + frame like the alt path: history as scrollback, the visible
        //    pane padded to full height (so the viewport-relative CUP lands
        //    right), then a CUP to tmux's real cursor. Verified against the real
        //    xterm.js engine: this lands the cursor on the input row, not the
        //    footer. Falls back to the flat capture if we lack a pane height.
        if !alt_on {
            if pane_height == 0 {
                let full = self.capture_full_ansi_joined().await?;
                return Ok(frame_primary_seed(&full));
            }
            let history = self
                .run(&[
                    "capture-pane", "-p", "-e", "-J", "-t", &self.target_match().await,
                    "-S", "-", "-E", "-1",
                ])
                .await
                .unwrap_or_default();
            let visible = self
                .run(&["capture-pane", "-p", "-e", "-t", &self.target_match().await])
                .await
                .unwrap_or_default();
            // Race-B: re-probe the cursor right after the visible capture so the
            // CUP matches the bytes we just grabbed (same tightening as alt mode).
            let info2 = self
                .run(&["display-message", "-p", "-t", &self.target_match().await, "#{cursor_x},#{cursor_y}"])
                .await
                .unwrap_or_default();
            let (cursor_x, cursor_y) =
                parse_cursor_xy(&info2).unwrap_or((provisional_x, provisional_y));
            return Ok(frame_primary_seed_with_cursor(
                &history, &visible, cursor_x, cursor_y, pane_height,
            ));
        }

        // 3. Alt-screen mode: split + frame.
        // 3a. PRIMARY scrollback (everything above the current visible frame).
        let history = self
            .run(&[
                "capture-pane",
                "-p",
                "-e",
                "-J",
                "-t",
                &self.target_match().await,
                "-S",
                "-",
                "-E",
                "-1",
            ])
            .await
            .unwrap_or_default();
        // 3b. Visible alt-screen body (the current TUI frame).
        let visible = self
            .run(&["capture-pane", "-p", "-e", "-t", &self.target_match().await])
            .await
            .unwrap_or_default();
        // 3c. RE-PROBE the cursor (Race-B tightening). The TUI may have moved
        //     the cursor between step 1 and step 3b; this reading matches the
        //     `visible` body we just captured. Fall back to step 1's reading
        //     on the rare probe failure rather than corrupting the seed.
        let info2 = self
            .run(&[
                "display-message",
                "-p",
                "-t",
                &self.target_match().await,
                "#{cursor_x},#{cursor_y}",
            ])
            .await
            .unwrap_or_default();
        let (cursor_x, cursor_y) =
            parse_cursor_xy(&info2).unwrap_or((provisional_x, provisional_y));
        Ok(frame_alt_screen_seed(&history, &visible, cursor_x, cursor_y))
    }

    // ── input ────────────────────────────────────────────────────────────────

    /// Inject `text` literally — NO trailing Enter (callers send `Enter`
    /// separately). Short text uses `send-keys -l`; payloads over
    /// [`PASTE_THRESHOLD`] bytes — OR any text ending in `;` (which `send-keys`
    /// would silently drop, see below) — stream through a tmux paste buffer (the
    /// cmux large-paste fix — `send-keys` argv is `ARG_MAX`-bounded and corrupts
    /// large literals).
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
        // tmux's `cmd_parse_from_arguments` treats a TRAILING ';' in any argv
        // element as a command separator: it strips the ';' and (unless the
        // preceding byte is a backslash) ends the command there. This runs
        // BEFORE `send-keys` parses `-l`/`--`, so neither flag protects it —
        // `send-keys -l -- ";"` lands as `send-keys -l --` with no key arg and
        // sends NOTHING (so a lone ';' keystroke, or any chunk ending in ';',
        // silently vanishes). Route those through the paste buffer, which
        // streams bytes over stdin and never touches tmux's command lexer.
        if text.len() > PASTE_THRESHOLD || text.ends_with(';') {
            self.paste_via_buffer(text, false).await
        } else {
            // `--` so a leading '-' in the text isn't parsed as a flag.
            self.run(&["send-keys", "-t", &self.target_match().await, "-l", "--", text])
                .await
                .map(|_| ())
        }
    }

    /// Paste `text` via a named tmux buffer (always, regardless of length).
    /// `bracketed` requests bracketed-paste mode so the receiving app treats it
    /// as a single paste (`paste-buffer -p`).
    pub async fn paste_via_buffer(&self, text: &str, bracketed: bool) -> Result<()> {
        let target = self.target_match().await; // `-t` target for load-buffer/paste-buffer
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
        self.run(&["send-keys", "-t", &self.target_match().await, key])
            .await
            .map(|_| ())
    }

    /// `tmux resize-window -x <cols> -y <rows>`. Bounds enforced by callers.
    /// Window-scoped — the supermux-session happy path. For a teammate PANE use
    /// [`resize_pane`](Self::resize_pane) instead.
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let (c, r) = (cols.to_string(), rows.to_string());
        self.run(&[
            "resize-window",
            "-t",
            &self.target_match().await,
            "-x",
            &c,
            "-y",
            &r,
        ])
        .await
        .map(|_| ())
    }

    /// `tmux resize-pane -t <target> -x <cols> -y <rows>` — resize a SINGLE pane,
    /// distinct from [`resize`](Self::resize)'s
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
            &self.target_match().await,
            "-x",
            &c,
            "-y",
            &r,
        ])
        .await
        .map(|_| ())
    }

    /// Resize the LEAD pane of an Agent-Team window to the client's EXACT
    /// geometry, growing the shared window FIRST so the pane can actually get
    /// there.
    ///
    /// A team window is `window-size manual` (no tmux client drives it) and its
    /// panes SHARE one rectangle, so [`resize_pane`](Self::resize_pane) alone can
    /// never make the lead wider than the current window. A lead window that
    /// started narrow therefore STAYS narrow while the browser xterm is wide —
    /// the app repaints only the left columns and the stale wide-layout cells on
    /// the right are never cleared (the "team-lead render is garbled / unreadable"
    /// bug). Fix: grow the WINDOW to `cols + <teammate-column reserve>` first (a
    /// manual window is unbounded, so the extra width is free), THEN pin the lead
    /// to exactly `cols × rows`. Now browser-width == pane-width and the app
    /// repaints edge-to-edge. The lead is the full-height LEFT column, so its
    /// `rows` also drives the window height. A single-pane window (teammates gone)
    /// degrades to a plain `resize-window` — identical to the non-team path, and
    /// avoids `resize-pane` wrongly filling the window with the reserve slack.
    pub async fn resize_lead_pane(&self, cols: u16, rows: u16) -> Result<()> {
        let target = self.target_match().await;
        // One round-trip: window width + this (lead) pane's width + pane count.
        let geom = self
            .run(&[
                "display-message",
                "-p",
                "-t",
                &target,
                "-F",
                "#{window_width} #{pane_width} #{window_panes}",
            ])
            .await
            .unwrap_or_default();
        let mut it = geom.split_whitespace();
        let win_w: u16 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let pane_w: u16 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let panes: u16 = it.next().and_then(|s| s.parse().ok()).unwrap_or(1);

        // No teammates share the window — the window IS the pane, so a plain
        // window resize is correct (`resize-pane` would fill it with the reserve).
        if panes <= 1 {
            return self.resize(cols, rows).await;
        }

        // Keep the teammate column its current width, but never let it collapse
        // to nothing: 40 cols keeps teammates legible and costs nothing on a
        // manual (unbounded) window.
        const TEAMMATE_COL_MIN: u16 = 40;
        let reserve = win_w.saturating_sub(pane_w).max(TEAMMATE_COL_MIN);
        let target_w = cols.saturating_add(reserve);

        // Grow the window first so `resize-pane` isn't clamped, then pin the lead.
        self.run(&[
            "resize-window",
            "-t",
            &target,
            "-x",
            &target_w.to_string(),
            "-y",
            &rows.to_string(),
        ])
        .await?;
        self.run(&[
            "resize-pane",
            "-t",
            &target,
            "-x",
            &cols.to_string(),
            "-y",
            &rows.to_string(),
        ])
        .await
        .map(|_| ())
    }

    /// On-disk log capture: `pipe-pane -O -t <target> 'cat >> <path>'`. Replaces
    /// any existing pipe (idempotent). Superseded by the `tee … > fifo`
    /// form once a WS client subscribes; this gives plain logging meanwhile.
    pub async fn pipe_pane(&self, target_path: &Path) -> Result<()> {
        let cmd = format!("cat >> {}", shell_escape::escape(target_path.to_string_lossy()));
        self.run(&["pipe-pane", "-O", "-t", &self.target_match().await, &cmd])
            .await
            .map(|_| ())
    }

    /// Live-stream pipe: `pipe-pane -O -t <target> 'tee -a <log> > <fifo>'`.
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
        self.run(&["pipe-pane", "-O", "-t", &self.target_match().await, &cmd])
            .await
            .map(|_| ())
    }

    /// List the tmux pane ids (`%1`, `%2`, …) currently present in this session
    /// (`supermux-<name>`). Used by the Agent-Teams detector to
    /// VALIDATE that a teammate's `tmuxPaneId` from `config.json` still exists in
    /// the lead's window before trusting its live status — tmux pane ids are a
    /// server-global REUSED counter, so a freed `%1` can be re-handed to an
    /// unrelated pane. An error (session gone) yields an empty set, so the caller
    /// drops every member's live status — fail-closed, never a stale `%id`.
    pub async fn list_pane_ids(&self) -> Result<Vec<String>> {
        let out = self
            .run(&["list-panes", "-t", &self.target_match().await, "-F", "#{pane_id}"])
            .await?;
        Ok(out
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect())
    }

    /// The pane's shell PID (`#{pane_pid}`). The agent (claude/codex) runs as a
    /// child of this. `None` if no pane is reported.
    pub async fn pane_pid(&self) -> Result<Option<u32>> {
        let out = self
            .run(&["list-panes", "-t", &self.target_match().await, "-F", "#{pane_pid}"])
            .await?;
        Ok(out.lines().next().and_then(|l| l.trim().parse::<u32>().ok()))
    }

}

/// Does pane `pane_id` (`%id`) currently exist in the lead session's window?
/// Free function (takes the LEAD's bare session name + the
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

/// Find the BARE supermux session name whose window currently contains
/// `pane_id` (`%id`), scanning every live `supermux-*` tmux session. This is
/// the tmux-level fallback used by the
/// teammate WS resolver when the team config's `leadSessionId` is a Claude
/// UUID (not the supermux name): the pane really IS live, just not in the
/// session the lead-id naively pointed at. Returns `None` when the pane is
/// not present in any supermux session (a true stale / gone id) — fail-closed
/// so callers refuse the stream, never serving a re-handed pane.
///
/// Implementation note: uses `tmux list-panes -a` with a server-wide filter on
/// `#{session_name}` prefix `supermux-`, so one tmux roundtrip covers every
/// candidate session (no per-session shell-out fan-out).
pub async fn find_pane_session(pane_id: &str) -> Result<Option<String>> {
    let bin = tmux_bin()?;
    let out = Command::new(bin)
        .args([
            "list-panes",
            "-a",
            "-F",
            "#{session_name} #{pane_id}",
        ])
        .output()
        .await
        .context("spawning tmux list-panes -a")?;
    if !out.status.success() {
        // tmux server may not be running yet (no sessions at all). Treat the
        // same as "no match" — never error on "no panes anywhere".
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        let mut it = line.split_whitespace();
        let (Some(session), Some(pid)) = (it.next(), it.next()) else {
            continue;
        };
        if pid != pane_id {
            continue;
        }
        // Strip the `supermux-` prefix so callers get the BARE session name
        // (the supermux DB key). A pane in a non-supermux session is ignored.
        if let Some(bare) = session.strip_prefix("supermux-") {
            return Ok(Some(bare.to_string()));
        }
    }
    Ok(None)
}

/// Parse tmux's `display-message -p '#{alternate_on},#{cursor_x},#{cursor_y}'`
/// output into the three pieces the seed framer needs. Whitespace-tolerant;
/// malformed input falls back to `(false, 0, 0)` so the seed degrades to a
/// flat capture-pane rather than crashing the WS attach. Free fn so the
/// parse contract is unit-testable without spinning up a real tmux server.
pub(crate) fn parse_pane_info(info: &str) -> (bool, u32, u32, u32) {
    let mut parts = info.trim().split(',');
    let alt_on = parts.next().map(|s| s.trim() == "1").unwrap_or(false);
    let cursor_x: u32 = parts
        .next()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let cursor_y: u32 = parts
        .next()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    // pane_height is optional (older callers passed a 3-field format); 0 means
    // "unknown", which routes the primary-seed path to its flat-capture fallback.
    let pane_height: u32 = parts
        .next()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    (alt_on, cursor_x, cursor_y, pane_height)
}

/// Parse tmux's `display-message -p '#{cursor_x},#{cursor_y}'` (the Race-B
/// re-probe in [`Tmux::capture_history_with_alt_screen_aware_visible`]) into
/// `(cursor_x, cursor_y)`. Returns `None` on malformed/empty input so the
/// caller can fall back to the step-1 cursor reading rather than emitting a
/// CUP at `(0, 0)` and putting the user's first keystroke at the top-left.
pub(crate) fn parse_cursor_xy(info: &str) -> Option<(u32, u32)> {
    let mut parts = info.trim().split(',');
    let cx = parts.next()?.trim().parse::<u32>().ok()?;
    let cy = parts.next()?.trim().parse::<u32>().ok()?;
    Some((cx, cy))
}

/// PRIMARY-mode seed: the flat `capture_full_ansi_joined` dump is correct
/// as-is (no alt buffer in play), normalised to CRLF + prefixed with
/// `\x1b[2J\x1b[3J\x1b[H` so it lands at a deterministic origin in the
/// client buffer.
pub(crate) fn frame_primary_seed(full_capture: &str) -> String {
    let body = full_capture.trim_end_matches('\n').replace('\n', "\r\n");
    format!("\x1b[2J\x1b[3J\x1b[H{body}")
}

/// PRIMARY-mode seed WITH a cursor restore (the fix for "cursor lands 2-3 rows
/// below the `❯` input" on a Claude session, whose Ink TUI renders inline on the
/// primary screen). `frame_primary_seed` dumps the capture and leaves the cursor
/// at the end of the body (Claude's footer); this variant pins the cursor to
/// tmux's real position.
///
/// Shape: `history` (scrollback above the visible frame) → the `visible` pane
/// PADDED to exactly `pane_height` rows → `\x1b[<row>;<col>H`. The padding is
/// load-bearing: a CUP in xterm is VIEWPORT-relative, so the visible body must
/// fill the whole viewport for `cursor_y` to map onto the right row. tmux's
/// cursor_y is 0-based; ANSI CUP is 1-based. Verified against `@xterm/headless`:
/// the cursor lands on the input row, not the footer.
pub(crate) fn frame_primary_seed_with_cursor(
    history: &str,
    visible: &str,
    cursor_x: u32,
    cursor_y: u32,
    pane_height: u32,
) -> String {
    let row = cursor_y.saturating_add(1);
    let col = cursor_x.saturating_add(1);
    let history_body = history.trim_end_matches('\n').replace('\n', "\r\n");
    // Pad/clamp the visible body to exactly `pane_height` rows so the viewport
    // bottom aligns to the real pane bottom and the viewport-relative CUP is exact.
    let mut rows: Vec<&str> = visible.trim_end_matches('\n').split('\n').collect();
    let h = pane_height as usize;
    rows.resize(h.max(rows.len()), "");
    rows.truncate(h.max(1));
    let visible_body = rows.join("\r\n");
    // history + a CRLF separator (so the visible frame starts on its own row),
    // omitted when there's no scrollback so we don't push an extra blank line.
    let sep = if history_body.is_empty() { "" } else { "\r\n" };
    format!("\x1b[2J\x1b[3J\x1b[H{history_body}{sep}{visible_body}\x1b[{row};{col}H")
}

/// ALT-SCREEN-mode seed: PRIMARY scrollback (history above the visible
/// frame) painted first, then `\x1b[?1049h\x1b[2J\x1b[H` to switch xterm
/// into its ALT buffer (clear + home), then the alt visible (the live TUI
/// frame), then `\x1b[<row>;<col>H` to restore the cursor where tmux says
/// it is. Writing this onto a fresh `term.reset()` reproduces tmux's pane
/// state with both buffers populated and the cursor in Claude's expected
/// input position. tmux's cursor_y is 0-based; ANSI CUP is 1-based.
pub(crate) fn frame_alt_screen_seed(
    history: &str,
    visible: &str,
    cursor_x: u32,
    cursor_y: u32,
) -> String {
    let row = cursor_y.saturating_add(1);
    let col = cursor_x.saturating_add(1);
    let history_body = history.trim_end_matches('\n').replace('\n', "\r\n");
    let visible_body = visible.trim_end_matches('\n').replace('\n', "\r\n");
    format!(
        "\x1b[2J\x1b[3J\x1b[H{history_body}\x1b[?1049h\x1b[2J\x1b[H{visible_body}\x1b[{row};{col}H"
    )
}

#[cfg(test)]
mod seed_tests {
    //! Pin the contract of the alt-screen-aware WS seed framer (the fix for
    //! the splash-stacking + typed-on-wrong-row bugs). The parse + the format
    //! are free fns so we don't need a live tmux to exercise them — the
    //! integration with tmux is the well-defined `display-message` /
    //! `capture-pane` output that we mock here byte-for-byte.
    use super::*;

    #[test]
    fn parse_pane_info_happy_path() {
        // tmux 3.x output: `alternate_on,cursor_x,cursor_y,pane_height`.
        assert_eq!(parse_pane_info("1,5,21,40"), (true, 5, 21, 40));
        assert_eq!(parse_pane_info("0,0,0,24"), (false, 0, 0, 24));
        assert_eq!(parse_pane_info("0,80,23,38"), (false, 80, 23, 38));
    }

    #[test]
    fn parse_pane_info_trims_whitespace_and_trailing_newline() {
        // tmux's `display-message -p` usually adds a trailing newline.
        assert_eq!(parse_pane_info("1,5,21,40\n"), (true, 5, 21, 40));
        assert_eq!(parse_pane_info("  1 , 5 , 21 , 40  "), (true, 5, 21, 40));
    }

    #[test]
    fn parse_pane_info_degrades_safely_on_malformed_input() {
        // Empty / partial / non-numeric → falls back to 0s. A missing
        // pane_height (0) routes the primary-seed path to its flat fallback.
        assert_eq!(parse_pane_info(""), (false, 0, 0, 0));
        assert_eq!(parse_pane_info("1"), (true, 0, 0, 0));
        assert_eq!(parse_pane_info("garbage"), (false, 0, 0, 0));
        assert_eq!(parse_pane_info("1,x,y,z"), (true, 0, 0, 0));
        assert_eq!(parse_pane_info("2,5,21,40"), (false, 5, 21, 40)); // `2` != `1` → false
        assert_eq!(parse_pane_info("0,5,21"), (false, 5, 21, 0)); // 3-field → height 0
    }

    #[test]
    fn frame_primary_seed_with_cursor_restores_input_row() {
        // The Bug-A fix: a Claude primary-screen pane where the `❯` input is on
        // row 2 (0-based) but the captured body has a footer below it. The flat
        // seed would leave the cursor on the footer; this framer pins it to the
        // input row via a viewport-relative CUP. pane_height=4 so the visible
        // body is padded to fill the viewport.
        let seed = frame_primary_seed_with_cursor(
            "scrollback line", // history
            "❯ type here\n──footer──", // visible (2 lines, padded to 4)
            2,  // cursor_x → col 3
            2,  // cursor_y → row 3 (1-based)
            4,  // pane_height
        );
        // Ends with a CUP to (row 3, col 3).
        assert!(seed.ends_with("\x1b[3;3H"), "seed tail: {seed:?}");
        // Clears + homes, carries the scrollback, then the visible frame.
        assert!(seed.starts_with("\x1b[2J\x1b[3J\x1b[Hscrollback line\r\n"));
        assert!(seed.contains("❯ type here\r\n──footer──"));
    }

    #[test]
    fn frame_primary_seed_with_cursor_no_history_omits_leading_blank() {
        // No scrollback → no leading CRLF before the visible frame.
        let seed = frame_primary_seed_with_cursor("", "❯ x", 0, 0, 2);
        assert!(seed.starts_with("\x1b[2J\x1b[3J\x1b[H❯ x"));
        assert!(seed.ends_with("\x1b[1;1H"));
    }

    #[test]
    fn parse_cursor_xy_happy_and_malformed() {
        // Race-B re-probe parser: `display-message -p '#{cursor_x},#{cursor_y}'`.
        // Whitespace + trailing newline tolerated; malformed → None so the
        // caller can fall back to the step-1 reading instead of CUP-to-(0,0).
        assert_eq!(parse_cursor_xy("5,21"), Some((5, 21)));
        assert_eq!(parse_cursor_xy("  5 , 21 \n"), Some((5, 21)));
        assert_eq!(parse_cursor_xy("0,0"), Some((0, 0)));
        assert_eq!(parse_cursor_xy(""), None);
        assert_eq!(parse_cursor_xy("5"), None);
        assert_eq!(parse_cursor_xy("x,y"), None);
        assert_eq!(parse_cursor_xy("5,y"), None);
    }

    #[test]
    fn frame_primary_seed_normalises_crlf_and_prefixes_clear_home() {
        let out = frame_primary_seed("line a\nline b\n");
        assert_eq!(out, "\x1b[2J\x1b[3J\x1b[Hline a\r\nline b");
    }

    #[test]
    fn frame_primary_seed_empty_capture_still_prefixes() {
        // An empty primary capture still yields a deterministic "clear screen"
        // — the client lands in a known origin even on a brand-new pane.
        assert_eq!(frame_primary_seed(""), "\x1b[2J\x1b[3J\x1b[H");
    }

    #[test]
    fn frame_alt_screen_seed_contains_both_buffers_and_cursor_restore() {
        let out = frame_alt_screen_seed("history line", "tui frame", 5, 21);
        // Primary scrollback comes first (after clear+home).
        assert!(out.starts_with("\x1b[2J\x1b[3J\x1b[Hhistory line"));
        // Then the enter-alt + clear + home that switches xterm to alt buffer.
        assert!(out.contains("\x1b[?1049h\x1b[2J\x1b[H"));
        // Then the visible TUI frame.
        assert!(out.contains("tui frame"));
        // Then the cursor restore (1-based: 0,0 → 1,1; here 5,21 → row 22, col 6).
        assert!(out.ends_with("\x1b[22;6H"));
        // The ordering is what makes both buffers consistent — assert it.
        let hist_pos = out.find("history line").unwrap();
        let alt_pos = out.find("\x1b[?1049h").unwrap();
        let vis_pos = out.find("tui frame").unwrap();
        let cur_pos = out.find("\x1b[22;6H").unwrap();
        assert!(hist_pos < alt_pos);
        assert!(alt_pos < vis_pos);
        assert!(vis_pos < cur_pos);
    }

    #[test]
    fn frame_alt_screen_seed_at_origin_cursor_is_1_1() {
        // The 0-based → 1-based off-by-one trap — pin (0, 0) → `\x1b[1;1H`.
        let out = frame_alt_screen_seed("", "", 0, 0);
        assert!(out.ends_with("\x1b[1;1H"));
    }

    #[test]
    fn frame_alt_screen_seed_handles_lf_in_both_captures() {
        // Both history + visible may contain raw LF from tmux — both must be
        // CRLF-normalised so xterm.js doesn't half-paint the next column down.
        let out = frame_alt_screen_seed("h1\nh2", "v1\nv2", 0, 0);
        assert!(out.contains("h1\r\nh2"));
        assert!(out.contains("v1\r\nv2"));
        assert!(!out.contains("h1\nh2"), "no bare LF in history body");
        assert!(!out.contains("v1\nv2"), "no bare LF in visible body");
    }
}

/// Boots a uniquely-named session on a PRIVATE tmux socket (`-L`), runs the
/// EXACT `set-option -g -as terminal-features 'xterm*:sync'` argv `new_session`
/// uses, and asserts tmux accepts it AND stores it under the right option with
/// the feature token appended. Pins the literal argv (refactor canary: a future
/// change that drops `-a`, mis-spells the option name, or moves to the wrong
/// target-class fails here) on a live tmux server. We read the STORED config via
/// `show-options`, not the resolved `#{terminal-features}` — tmux only computes
/// the resolved feature set per-CLIENT on attach, so a detached (clientless) test
/// session always resolves to empty.
///
/// SAFETY of the test:
///   • Uses `-L supermux-sync-test-<pid>` to spawn its OWN private tmux
///     server on a dedicated socket — completely isolated from any other
///     test, IDE tmux, or live `supermux-*` session on the default socket.
///     Never calls `kill-server` on the default socket (which would
///     clobber any in-flight integration test).
///   • Tears down its own server at end (best-effort).
///   • Skipped when tmux is unavailable so a tmux-less CI host still passes.
#[cfg(test)]
mod sync_feature_tests {
    use std::process::Command;

    fn tmux_available() -> bool {
        Command::new("tmux")
            .arg("-V")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn terminal_features_sync_accepted_and_resolved() {
        if !tmux_available() {
            eprintln!("tmux not available — skipping");
            return;
        }
        // Per-test PRIVATE socket so we never touch the default tmux server
        // (which other concurrent tests + the developer's IDE rely on).
        let socket = format!("supermux-sync-test-{}", std::process::id());
        let session = "feature-probe";

        let new = Command::new("tmux")
            .args(["-L", &socket, "new-session", "-d", "-s", session, "sleep", "60"])
            .output()
            .expect("spawn tmux new-session");
        assert!(
            new.status.success(),
            "tmux new-session failed: {}",
            String::from_utf8_lossy(&new.stderr).trim()
        );

        // The EXACT argv `new_session` runs — refactor-canary on the option name,
        // the `-a` (append) flag, and the feature token.
        let set = Command::new("tmux")
            .args([
                "-L",
                &socket,
                "set-option",
                "-g",
                "-as",
                "terminal-features",
                "xterm*:sync",
            ])
            .output()
            .expect("spawn tmux set-option");
        assert!(
            set.status.success(),
            "tmux >= 3.4 must accept set-option -g -as terminal-features 'xterm*:sync': {}",
            String::from_utf8_lossy(&set.stderr).trim()
        );

        // Confirm the option was STORED under the right name with the feature
        // token appended (`-a`), not overwriting tmux's built-in defaults. We read
        // the configured value via `show-options`, NOT the resolved
        // `#{terminal-features}` — tmux only computes the resolved feature set
        // per-CLIENT on attach, so a detached (clientless) test session always
        // resolves to empty (it would spuriously fail in CI and headless dev).
        // `show-options` is the headless-robust canary for the option name, the
        // `-a` append flag, and the `xterm*:sync` token.
        let q = Command::new("tmux")
            .args(["-L", &socket, "show-options", "-g", "terminal-features"])
            .output()
            .expect("spawn tmux show-options");
        let out = String::from_utf8_lossy(&q.stdout);
        assert!(
            out.contains("xterm*:sync"),
            "expected 'xterm*:sync' appended to terminal-features, got: {out:?}"
        );

        // Best-effort teardown of our private server only; never touches the
        // default socket. A leak here would just leave one private socket
        // behind for the duration of the OS session — harmless.
        let _ = Command::new("tmux").args(["-L", &socket, "kill-server"]).output();
    }
}

#[cfg(test)]
mod target_tests {
    //! Target-string formatting. Pins that a `Session` target
    //! keeps emitting `-t supermux-<name>` byte-for-byte (NO regression) while a
    //! `Pane` target emits the raw `%id`, so threading the target through every
    //! tmux verb can't silently change the session happy-path argument.

    use super::*;

    #[test]
    fn session_target_keeps_the_supermux_prefix() {
        // The previous behaviour, unchanged: a bare name → `supermux-<name>`.
        assert_eq!(TmuxTarget::Session("myproj".into()).arg(), "supermux-myproj");
        assert_eq!(Tmux::new("myproj").target(), "supermux-myproj");
    }

    #[test]
    fn pane_target_is_the_raw_pane_id() {
        // A teammate pane is addressed by its raw `%id` with NO prefix.
        assert_eq!(TmuxTarget::Pane("%17".into()).arg(), "%17");
        assert_eq!(Tmux::for_pane("teamA/worker-1", "%17").target(), "%17");
        // The async `target_match()` short-circuits on pane targets and never
        // makes a tmux call — exercised in the live-tmux block below.
    }

    #[test]
    fn is_pane_distinguishes_the_two() {
        assert!(!Tmux::new("s").is_pane());
        assert!(Tmux::for_pane("s", "%3").is_pane());
        assert!(!TmuxTarget::Session("s".into()).is_pane());
        assert!(TmuxTarget::Pane("%3".into()).is_pane());
    }
}

/// Live-tmux integration tests. Run with:
///     cargo test --release --lib sessions::tmux::live_tmux_tests -- --ignored
/// Each test creates one or two real tmux sessions with a unique random
/// prefix, exercises the method under test, then cleans them up. ALWAYS
/// `#[ignore]` so CI (no tmux daemon, no `supermux-` prefixed sessions to
/// shadow) and the host's prod tmux don't trip each other.
///
/// The bug these tests catch — and that the prior `arg()`/`arg_match()`
/// string-equality tests missed — is that tmux 3.4 rejects the documented
/// `=name` exact-match prefix for pane-target commands with `can't find
/// pane: =name`. A unit test that compares strings can never see this; only
/// a test that actually shells out can.
#[cfg(test)]
mod live_tmux_tests {
    use super::*;
    use std::collections::HashMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn rand_tag() -> String {
        // No randomness crate — use the nanosecond epoch + pid for uniqueness.
        let ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("itest-{ns}-{}", std::process::id())
    }

    async fn create_session(name: &str) {
        // `new-session -d -s supermux-<name>` — detached, no env, no working dir
        // requirements.
        let tmux = Tmux::new(name);
        tmux.new_session(std::path::Path::new("/tmp"), &HashMap::new(), "/bin/bash")
            .await
            .expect("new-session");
    }

    async fn kill_session(name: &str) {
        // Best-effort cleanup; we don't want a failing kill to mask a real
        // assertion failure in the test body.
        let _ = Tmux::new(name).kill_session().await;
    }

    /// `exists()` must report TRUE for a session whose name is a prefix of
    /// another live session — the linkbuilder / linkbuilder-mailer scenario.
    /// Pre-fix (`has-session -t <bare>` with tmux's prefix matcher) this
    /// passed both. Post-fix (list-sessions + exact match) it correctly
    /// distinguishes them.
    #[tokio::test]
    #[ignore]
    async fn exists_distinguishes_prefix_named_sessions() {
        let tag = rand_tag();
        let short = format!("{tag}-foo");
        let long = format!("{tag}-foo-side");
        create_session(&short).await;
        create_session(&long).await;
        assert!(Tmux::new(&short).exists().await.unwrap(), "short exists");
        assert!(Tmux::new(&long).exists().await.unwrap(), "long exists");
        // Kill the SHORT one. The LONG must remain reachable.
        kill_session(&short).await;
        assert!(!Tmux::new(&short).exists().await.unwrap(), "short gone");
        assert!(
            Tmux::new(&long).exists().await.unwrap(),
            "long still alive"
        );
        kill_session(&long).await;
    }

    /// `target_match()` resolves a session name to its live tmux `$<id>` —
    /// and that `$<id>` is acceptable to `-t` on tmux 3.4 (the regression the
    /// `=name` form tripped on). We verify by feeding it to a real
    /// `capture-pane` call.
    #[tokio::test]
    #[ignore]
    async fn target_match_resolves_to_session_id_usable_by_capture_pane() {
        let tag = rand_tag();
        create_session(&tag).await;
        let tmux = Tmux::new(&tag);
        let target = tmux.target_match().await;
        assert!(
            target.starts_with('$'),
            "expected $<id>, got {target}"
        );
        // Independent verification: capture-pane against the resolved id
        // must succeed (this is the path that broke under `=name`).
        tmux.capture_pane(40).await.expect("capture-pane on resolved id");
        kill_session(&tag).await;
    }

    /// Prefix-shadowing regression: with both `<tag>` and `<tag>-side` alive,
    /// a capture on the shorter must NOT return content from the longer.
    /// Pre-fix this would silently return the wrong session's pane content.
    #[tokio::test]
    #[ignore]
    async fn capture_pane_does_not_cross_prefix_shadow() {
        let tag = rand_tag();
        let short = format!("{tag}-foo");
        let long = format!("{tag}-foo-side");
        create_session(&short).await;
        create_session(&long).await;
        // Write a marker into each session's pane via send-keys.
        Tmux::new(&short)
            .send_text("echo SHORT_MARKER\n")
            .await
            .expect("send to short");
        Tmux::new(&long)
            .send_text("echo LONG_MARKER\n")
            .await
            .expect("send to long");
        // Give tmux a beat to render.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let short_cap = Tmux::new(&short).capture_pane(40).await.unwrap();
        let long_cap = Tmux::new(&long).capture_pane(40).await.unwrap();
        assert!(short_cap.contains("SHORT_MARKER"), "short pane has SHORT");
        assert!(long_cap.contains("LONG_MARKER"), "long pane has LONG");
        assert!(
            !short_cap.contains("LONG_MARKER"),
            "short MUST NOT see LONG (prefix shadow)"
        );
        kill_session(&short).await;
        kill_session(&long).await;
    }

    /// Regression: a lone `;` (and any chunk ending in `;`) must reach the pane.
    /// `send-keys -l -- ";"` drops it because tmux's arg parser eats a trailing
    /// `;` as a command separator before `-l` applies; `send_text` dodges that
    /// by routing trailing-`;` text through the paste buffer.
    #[tokio::test]
    #[ignore]
    async fn send_text_delivers_trailing_semicolon() {
        let tag = rand_tag();
        create_session(&tag).await;
        let tmux = Tmux::new(&tag);
        // A lone semicolon, then a command that ends in one — both previously lost.
        tmux.send_text(";").await.expect("send lone ;");
        tmux.send_text("echo SEMI_OK;").await.expect("send trailing ;");
        tmux.send_key("Enter").await.expect("enter");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let cap = tmux.capture_pane(40).await.unwrap();
        assert!(
            cap.contains(";echo SEMI_OK;"),
            "pane must show the lone ';' and the trailing ';' verbatim, got: {cap:?}"
        );
        kill_session(&tag).await;
    }

    /// Regression: a team-LEAD pane must reach the client's width even when the
    /// tmux window started NARROWER than the client. Pre-fix the lead used bare
    /// `resize-pane`, which clamps to the frozen (manual) window width — so the
    /// browser xterm ended up wider than the pane and the render garbled (stale
    /// wide-layout cells never cleared). `resize_lead_pane` grows the window
    /// first, then pins the pane, so browser-width == pane-width.
    #[tokio::test]
    #[ignore]
    async fn resize_lead_pane_grows_past_a_narrow_frozen_window() {
        let tag = rand_tag();
        create_session(&tag).await;
        let full = format!("supermux-{tag}");
        let sess = Tmux::new(&tag);
        // Simulate an Agent-Team lead window: a teammate split, a manual
        // (client-independent) window size, frozen narrow so the lead can't be
        // wide within it — exactly the state a real team window is in.
        sess.run(&["set-window-option", "-t", &full, "window-size", "manual"])
            .await
            .unwrap();
        sess.run(&["split-window", "-h", "-t", &full]).await.unwrap();
        sess.run(&["resize-window", "-t", &full, "-x", "60", "-y", "30"])
            .await
            .unwrap();
        // The lead is pane 0 (the original, left of the split).
        let lead_id = sess
            .run(&["list-panes", "-t", &full, "-F", "#{pane_id}"])
            .await
            .unwrap()
            .lines()
            .next()
            .expect("a lead pane id")
            .to_string();
        let lead = Tmux::for_pane(&tag, lead_id.clone());

        lead.resize_lead_pane(120, 40).await.expect("resize lead");

        // Bare resize-pane would have clamped the lead to ~59 (the 60-col window).
        // With the window grown first, the lead reaches ~120.
        let w: u16 = lead
            .run(&["display-message", "-p", "-t", &lead_id, "-F", "#{pane_width}"])
            .await
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(w >= 118, "lead pane should reach ~120 cols, got {w}");
        kill_session(&tag).await;
    }

    /// `exists()` for a non-existent session returns Ok(false) — including
    /// the case where tmux server isn't running at all (no panic, no Err
    /// bubble up — matching the old `has-session`'s exit-1 semantics).
    #[tokio::test]
    #[ignore]
    async fn exists_returns_false_for_missing_session() {
        let tag = format!("nonexistent-{}", rand_tag());
        assert!(!Tmux::new(&tag).exists().await.unwrap());
    }
}

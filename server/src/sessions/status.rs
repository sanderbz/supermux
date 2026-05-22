//! Multi-signal status detector — CORE (TECH_PLAN §3.2.8, §3.6; M5a).
//!
//! This is the crown-jewel reliability module: when the UI says "waiting", the
//! agent is actually waiting. The classifier is a **pure function** of its inputs
//! ([`StatusDetector::detect`]) so it can be pinned by 30 golden capture-pane
//! fixtures (`tests/fixtures/status/*.txt`) and never silently regresses when the
//! regex bank evolves.
//!
//! **M5a / M5b split (§3.6).** M5a shipped the fusion order *regex bank → PTY
//! heartbeat → idle timeout*, the cold-start init, and the `last_capture`
//! writeback. **M5b** wires the real hook-event branch in (the top of
//! [`StatusDetector::classify`]): a fresh Claude `SettingsHook` event now
//! outranks the regex bank + heartbeat, fed by `/api/_internal/hook` →
//! [`AppState::record_hook`](crate::state::AppState::record_hook) →
//! [`AppState::last_hook_event`](crate::state::AppState::last_hook_event).
//!
//! **Fusion rule** (per-session, evaluated every 2s — or sooner, on a hook wake —
//! by the detector loop in [`super::auto_actions`]):
//! 1. Fresh hook event (<3s) outranks everything (M5b): `Notification`→`Waiting`,
//!    `PreToolUse`→`Active`, `Stop`/`SubagentStop`→`Idle`; `PostToolUse` is
//!    non-decisive and falls through.
//! 2. capture-pane regex bank (ported verbatim from v2 §1.3 — golden-tested).
//! 3. PTY heartbeat: bytes <1.5s → `Active`.
//! 4. Idle timeout: silent ≥30s → `Idle` (only downgrades an already-known
//!    status; a never-seen session stays `Unknown` — cold-start safety).

use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

/// Bytes seen within this window ⇒ the agent is doing something ⇒ `Active`.
const PTY_ACTIVE_WINDOW: Duration = Duration::from_millis(1500);
/// Silent for at least this long (and previously known) ⇒ `Idle`.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// A hook event newer than this outranks the regex bank + heartbeat (M5b).
const HOOK_FRESH: Duration = Duration::from_secs(3);
/// capture-pane skip optimization window (§3.6 [P2] #7).
const SKIP_WINDOW: Duration = Duration::from_secs(2);
/// How many trailing scroll-back lines the detector classifies + stores.
pub const CAPTURE_LINES: usize = 30;
/// Cold-start sentinel: a freshly-booted server pretends the last PTY byte was 5
/// minutes ago so the first tick never spuriously reads `Active` (§3.2.8).
pub const COLD_START_IDLE: Duration = Duration::from_secs(300);

/// The five live-status states surfaced to the UI (§3.2.8).
///
/// Serialises lower-case (`"active"`, …) to match the `last_status` CHECK values
/// and the frontend `Session.status` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Active,
    Waiting,
    Idle,
    Stopped,
    Unknown,
}

impl Status {
    /// The canonical lower-case token used both in the DB and over the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Active => "active",
            Status::Waiting => "waiting",
            Status::Idle => "idle",
            Status::Stopped => "stopped",
            Status::Unknown => "unknown",
        }
    }
}

/// Claude Code `SettingsHook` event kinds (§3.6). Consumed by the fusion rule in
/// [`StatusDetector::classify`]; fed in by M5b's `/api/_internal/hook` endpoint
/// via [`AppState::record_hook`](crate::state::AppState::record_hook).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    /// `PreToolUse` — the agent began a tool call ⇒ `Active`.
    PreToolUse,
    /// `PostToolUse` — a tool finished ⇒ no override (fall through).
    PostToolUse,
    /// `Notification` — Claude is asking the user something ⇒ `Waiting`.
    Notification,
    /// `Stop` — the turn ended ⇒ `Idle`.
    Stop,
    /// `SubagentStop` — a sub-agent turn ended ⇒ `Idle`.
    SubagentStop,
}

impl HookEvent {
    /// Parse the `event` field of an `/api/_internal/hook` POST body (§3.6 event
    /// types). Accepts the snake_case wire form amux's hook command emits
    /// (`pre_tool`, `post_tool`, `notification`, `stop`, `subagent_stop`) plus the
    /// PascalCase Claude SettingsHook names, so either spelling is robust. Unknown
    /// kinds return `None` (the endpoint treats them as a no-op).
    pub fn from_event_str(s: &str) -> Option<HookEvent> {
        match s {
            "pre_tool" | "pre_tool_use" | "PreToolUse" => Some(HookEvent::PreToolUse),
            "post_tool" | "post_tool_use" | "PostToolUse" => Some(HookEvent::PostToolUse),
            "notification" | "Notification" => Some(HookEvent::Notification),
            "stop" | "Stop" => Some(HookEvent::Stop),
            "subagent_stop" | "SubagentStop" => Some(HookEvent::SubagentStop),
            _ => None,
        }
    }
}

/// Per-session classifier. Holds only the last classification so the fusion
/// fallback can "hold current status" when no signal is decisive; the live PTY
/// heartbeat and hook events are passed *in* to keep [`detect`](Self::detect) a
/// pure function of its inputs (single source of truth — v2 lesson #4).
pub struct StatusDetector {
    last_status: Status,
}

impl Default for StatusDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl StatusDetector {
    /// Cold-start a detector. Begins `Unknown`; the heartbeat it will be fed on
    /// the first tick is the cold-start sentinel ([`AppState::last_pty`] returns
    /// `now - 5min` until M4's reader records a real byte), so the first tick
    /// reads `Unknown` rather than a spurious `Active`/`Idle` (§3.2.8).
    ///
    /// [`AppState::last_pty`]: crate::state::AppState::last_pty
    pub fn new() -> Self {
        Self {
            last_status: Status::Unknown,
        }
    }

    /// The most recent classification (the value the fallback "holds").
    pub fn last_status(&self) -> Status {
        self.last_status
    }

    /// Externally force the status (the loop uses this for the lifecycle-driven
    /// `Stopped` transition, which the capture classifier cannot infer).
    pub fn force(&mut self, status: Status) {
        self.last_status = status;
    }

    /// Classify the session from the fused signals and record the result.
    ///
    /// * `capture` — last [`CAPTURE_LINES`] of `tmux capture-pane`, ANSI-stripped.
    /// * `last_pty` — instant the live reader last saw a byte (cold-start
    ///   sentinel until M4 wires the reader).
    /// * `last_hook` — most recent Claude hook event, if any (**M5b**; M5a passes
    ///   `None`).
    ///
    /// Deterministic given `(capture, last_pty, last_hook, self.last_status)` —
    /// the property the golden-fixture snapshot tests rely on.
    pub fn detect(
        &mut self,
        capture: &str,
        last_pty: Instant,
        last_hook: Option<(Instant, HookEvent)>,
    ) -> Status {
        let status = self.classify(capture, last_pty, last_hook);
        self.last_status = status;
        status
    }

    fn classify(
        &self,
        capture: &str,
        last_pty: Instant,
        last_hook: Option<(Instant, HookEvent)>,
    ) -> Status {
        // ── 1. hook-event branch (M5b — the multi-signal apex) ────────────────
        // A fresh Claude `SettingsHook` event (<3s) is the most authoritative
        // signal we have — it comes straight from the agent runtime, not a
        // best-effort scrape of the pane — so it OUTRANKS the regex bank and the
        // PTY heartbeat (§3.6 fusion rule). `PostToolUse` is deliberately
        // non-decisive: "a tool finished" doesn't say whether that left the agent
        // idle, waiting, or mid-turn, so it falls THROUGH to the capture/heartbeat
        // branches below rather than pinning a status (§3.6: "no override; fall
        // through to other signals").
        if let Some((t, evt)) = last_hook {
            if t.elapsed() < HOOK_FRESH {
                match evt {
                    HookEvent::Notification => return Status::Waiting,
                    HookEvent::PreToolUse => return Status::Active,
                    HookEvent::Stop | HookEvent::SubagentStop => return Status::Idle,
                    HookEvent::PostToolUse => { /* fall through to §2–5 */ }
                }
            }
        }

        // ── 2. capture-pane regex bank (v2 §1.3, ported verbatim) ────────────
        if ACTIVE_BANK.is_match(capture) {
            return Status::Active;
        }
        if WAITING_BANK.is_match(capture) {
            return Status::Waiting;
        }
        if IDLE_BANK.is_match(capture) {
            return Status::Idle;
        }

        // ── 3. PTY heartbeat fallback ────────────────────────────────────────
        let silent = last_pty.elapsed();
        if silent < PTY_ACTIVE_WINDOW {
            return Status::Active;
        }
        // ── 4. idle timeout ──────────────────────────────────────────────────
        // Only downgrade a session we have already classified. A never-seen
        // (`Unknown`) session stays `Unknown` until a positive signal (capture
        // marker or a real PTY byte) arrives — without this guard a cold-started
        // server's first tick would read `Idle` off the cold-start sentinel,
        // contradicting §3.2.8 ("observe Unknown until capture confirms…").
        if silent >= IDLE_TIMEOUT && self.last_status != Status::Unknown {
            return Status::Idle;
        }

        // ── 5. no decisive signal → hold the current status ──────────────────
        self.last_status
    }
}

/// Should the 2s tick skip the `tmux capture-pane` shell-out (§3.6 [P2] #7)?
///
/// When PTY bytes flowed in the last 2s **and** we are already `Active`, the
/// heartbeat alone keeps the session `Active` and the recent `last_capture`
/// stays the freshest preview — so the shell-out is pure overhead. Halves the
/// tmux spawn rate under a chatty agent. (Dormant in M5a until M4 feeds the
/// heartbeat; unit-tested as a pure function.)
pub fn should_skip_capture(last_pty: Instant, last_status: Status) -> bool {
    last_status == Status::Active && last_pty.elapsed() < SKIP_WINDOW
}

// ── capture preparation helpers ──────────────────────────────────────────────

/// Strip CSI escape sequences (SGR colour, cursor moves, …). `capture-pane -p`
/// is already plain, but the detector strips defensively so `last_capture` (the
/// canonical preview source, CEO #1) never carries stray escapes.
static ANSI_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());

/// ANSI-strip `raw` and keep only its last [`CAPTURE_LINES`] lines — the exact
/// payload written to `session_runtime.last_capture` and classified by
/// [`StatusDetector::detect`].
///
/// Trailing blank lines are dropped first: `tmux capture-pane` pads the capture
/// to the full pane height, and those blanks would otherwise crowd the live
/// content out of the 6-line tile preview (CEO #1) and push a bare prompt off
/// the end where the IDLE `$`-anchored patterns expect it.
pub fn prepare_capture(raw: &str) -> String {
    let stripped = ANSI_RE.replace_all(raw, "");
    let mut lines: Vec<&str> = stripped.lines().collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let start = lines.len().saturating_sub(CAPTURE_LINES);
    lines[start..].join("\n")
}

/// Like [`prepare_capture`], but KEEPS the SGR escape sequences — the parallel
/// colour-true capture written to `session_runtime.last_capture_ansi` and
/// surfaced as `SessionView.preview_ansi`. `raw` here is `capture-pane -pe`
/// output. Trailing-blank trimming compares the ANSI-stripped form of each line
/// so a line that is only escape codes still counts as blank.
pub fn prepare_capture_ansi(raw: &str) -> String {
    let mut lines: Vec<&str> = raw.lines().collect();
    while lines
        .last()
        .is_some_and(|l| ANSI_RE.replace_all(l, "").trim().is_empty())
    {
        lines.pop();
    }
    let start = lines.len().saturating_sub(CAPTURE_LINES);
    lines[start..].join("\n")
}

// ── the regex bank (v2 §1.3, ported verbatim per the M5a spec) ───────────────
//
// Patterns are the literal strings from the milestone spec. The IDLE bank adds
// the `m` (multi-line) flag so its `$` anchors (`❯\s*$`, `\$ $`) match a bare
// prompt at the end of *any* line of a multi-line capture, replicating Python
// `re`'s lenient `$` (the Rust default anchors only at end-of-haystack). ACTIVE
// and WAITING use no line anchors, so they stay `(?i)`.

/// ACTIVE markers: a running spinner / interrupt hint / file read.
static ACTIVE_BANK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)(esc to interrupt|running\.\.\.|reading \d+ file|esc t…|✻.*…)").unwrap());

/// WAITING markers: a selector / confirmation / approval prompt.
static WAITING_BANK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(enter to select|do you want to proceed|❯\s*\d+\.|interrupted.*what should claude|approve)")
        .unwrap()
});

/// IDLE markers: a completed spinner, status bar, or bare shell/agent prompt.
static IDLE_BANK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?im)(✻.* for \d|⏵⏵|bypass permissions|plan mode|❯\s*$|\$ $|gpt-\S+ · ~)").unwrap()
});

#[cfg(test)]
mod tests {
    use super::*;

    /// A heartbeat in the neutral band (1.5s–30s): neither `Active` nor the idle
    /// timeout fires, so the regex bank alone decides — what golden tests want.
    fn neutral_pty() -> Instant {
        Instant::now() - Duration::from_secs(10)
    }

    /// Classify with a FRESH detector so the fallback is `Unknown` — this forces
    /// the regex bank to be the decider (a held prior status would otherwise mask
    /// a non-matching input and give a false pass).
    fn fresh(cap: &str) -> Status {
        StatusDetector::new().detect(cap, neutral_pty(), None)
    }

    #[test]
    fn active_markers_classify_active() {
        for cap in [
            "✻ Beaming… (esc to interrupt)",
            "✻ Beaming…",
            "Running...",
            "  Reading 3 files",
            "esc t…",
        ] {
            assert_eq!(fresh(cap), Status::Active, "{cap:?}");
        }
    }

    #[test]
    fn non_active_lookalikes_do_not_match() {
        // Guards against the fallback-masking bug: these lack a real marker, so a
        // fresh detector must NOT read Active (ellipsis ≠ "...", wrong star glyph).
        for cap in ["Running…", "✶ Thinking… esc t"] {
            assert_eq!(fresh(cap), Status::Unknown, "{cap:?} must not match a bank");
        }
    }

    #[test]
    fn waiting_markers_classify_waiting() {
        for cap in [
            "Do you want to proceed?\n❯ 1. Yes\n  2. No",
            "Press enter to select",
            "Interrupted · What should Claude do instead?",
            "Approve this action?",
        ] {
            assert_eq!(fresh(cap), Status::Waiting, "{cap:?}");
        }
    }

    #[test]
    fn idle_markers_classify_idle() {
        for cap in [
            "✻ Brewed for 1m 8s",
            "⏵⏵ accept edits on (shift+tab to cycle)",
            "bypass permissions",
            "plan mode",
            "user@host project %\n❯ ",
            "sander@mac amux-v3 $ ",
            "gpt-5-codex · ~/code",
        ] {
            assert_eq!(fresh(cap), Status::Idle, "{cap:?}");
        }
    }

    #[test]
    fn pty_heartbeat_recent_bytes_are_active() {
        let mut d = StatusDetector::new();
        // No regex markers; bytes flowed just now → Active.
        assert_eq!(d.detect("", Instant::now(), None), Status::Active);
    }

    #[test]
    fn pty_heartbeat_long_silence_is_idle_once_known() {
        let mut d = StatusDetector::new();
        // Establish a known status first (so the cold-start guard is satisfied).
        d.force(Status::Active);
        let silent = Instant::now() - Duration::from_secs(45);
        assert_eq!(d.detect("", silent, None), Status::Idle);
    }

    #[test]
    fn cold_start_first_tick_is_unknown() {
        let mut d = StatusDetector::new();
        let cold = Instant::now() - COLD_START_IDLE;
        // Empty capture + cold heartbeat + never-classified → Unknown, NOT Idle.
        assert_eq!(d.detect("", cold, None), Status::Unknown);
    }

    #[test]
    fn active_outranks_idle_marker_ordering() {
        // A spinner line with the ellipsis must read Active even though a
        // completed-spinner idle marker could co-occur in scrollback.
        let mut d = StatusDetector::new();
        let cap = "✻ Brewed for 1m\n✻ Beaming… (esc to interrupt)";
        assert_eq!(d.detect(cap, neutral_pty(), None), Status::Active);
    }

    #[test]
    fn fresh_hook_outranks_regex_and_heartbeat() {
        // M5b multi-signal apex (§3.6 acceptance: "a fresh hook event outranks the
        // regex bank and the pty heartbeat"). Each capture below carries an ACTIVE
        // marker AND a just-now heartbeat, yet the fresh hook decides the status.
        let mut d = StatusDetector::new();
        d.force(Status::Idle);
        let notif = Some((Instant::now(), HookEvent::Notification));
        assert_eq!(d.detect("esc to interrupt", Instant::now(), notif), Status::Waiting);

        let pre = Some((Instant::now(), HookEvent::PreToolUse));
        assert_eq!(StatusDetector::new().detect("", neutral_pty(), pre), Status::Active);

        let mut d2 = StatusDetector::new();
        d2.force(Status::Active);
        let stop = Some((Instant::now(), HookEvent::Stop));
        assert_eq!(d2.detect("esc to interrupt", Instant::now(), stop), Status::Idle);
    }

    #[test]
    fn post_tool_hook_is_non_decisive_and_falls_through() {
        // PostToolUse must NOT pin a status — the capture (a waiting prompt here)
        // decides instead (§3.6: "no override; fall through to other signals").
        let mut d = StatusDetector::new();
        let post = Some((Instant::now(), HookEvent::PostToolUse));
        assert_eq!(
            d.detect("Do you want to proceed?\n❯ 1. Yes", neutral_pty(), post),
            Status::Waiting
        );
    }

    #[test]
    fn stale_hook_is_ignored_and_falls_through() {
        // A hook older than the 3s freshness window no longer outranks; the regex
        // bank takes over (here an ACTIVE marker).
        let mut d = StatusDetector::new();
        let stale = Some((Instant::now() - Duration::from_secs(5), HookEvent::Notification));
        assert_eq!(d.detect("esc to interrupt", neutral_pty(), stale), Status::Active);
    }

    #[test]
    fn hook_event_parsing_covers_all_kinds() {
        use HookEvent::*;
        for (s, want) in [
            ("pre_tool", PreToolUse),
            ("post_tool", PostToolUse),
            ("notification", Notification),
            ("stop", Stop),
            ("subagent_stop", SubagentStop),
            ("PreToolUse", PreToolUse),
            ("SubagentStop", SubagentStop),
        ] {
            assert_eq!(HookEvent::from_event_str(s), Some(want), "{s:?}");
        }
        assert_eq!(HookEvent::from_event_str("garbage"), None);
    }

    #[test]
    fn skip_optimization_only_when_active_and_fresh() {
        assert!(should_skip_capture(Instant::now(), Status::Active));
        // Not active → never skip.
        assert!(!should_skip_capture(Instant::now(), Status::Idle));
        // Active but stale heartbeat → must re-capture.
        let stale = Instant::now() - Duration::from_secs(5);
        assert!(!should_skip_capture(stale, Status::Active));
    }

    #[test]
    fn prepare_capture_strips_ansi_and_caps_lines() {
        let raw = "\x1b[31mred\x1b[0m\n".to_string() + &"x\n".repeat(40);
        let out = prepare_capture(&raw);
        assert!(!out.contains('\x1b'), "ANSI escapes must be stripped");
        assert!(out.lines().count() <= CAPTURE_LINES, "capped to {CAPTURE_LINES} lines");
    }

    #[test]
    fn prepare_capture_drops_trailing_blank_lines() {
        // tmux pads the pane with blanks below the cursor; the prompt must remain
        // the last line so the preview + IDLE prompt patterns see real content.
        let raw = "output\n$ \n   \n\n\n";
        let out = prepare_capture(raw);
        assert_eq!(out, "output\n$ ", "trailing blanks dropped, prompt kept last");
    }
}

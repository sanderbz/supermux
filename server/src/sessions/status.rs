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
/// Upper bound on how stale the live preview tail may get while we are skipping
/// captures for a streaming-`Active` session. The skip keeps the status `Active`
/// cheaply off the PTY heartbeat — but a session whose bytes flow every tick
/// would NEVER re-capture, so its overview tail-preview would freeze for the
/// whole duration of the agent's work (exactly the "Claude is doing things but
/// the card doesn't update" bug). Capping the skip at this staleness forces a
/// re-capture so the hero live-preview keeps refreshing.
///
/// **Adaptive cadence (M-CADENCE).** This is now the *coarse* upper bound used
/// only when a per-tier bound is not supplied. The detector loop binds the
/// effective staleness to the session's CURRENT cadence tier
/// ([`cadence_for`]) — so a 1s-tier (hot, working) session re-captures within
/// ~1s during streaming, while an idle/waiting session keeps the cheap, coarse
/// bound. See [`should_skip_capture_within`].
pub const MAX_PREVIEW_STALENESS: Duration = Duration::from_secs(4);

// ── adaptive overview-preview cadence (M-CADENCE) ────────────────────────────
//
// Per session, the next capture/broadcast cadence is chosen by the live status
// and recency so the at-rest card preview feels ~1s WHERE IT MATTERS without
// wasting tmux shell-outs on quiet sessions. Tiers (the user's exact spec):
//
//   working/loading (active|starting) AND in the TOP-4 most-recently-active such
//     sessions ("hot")                                              → 1s
//   working/loading (active|starting) but NOT hot                   → 2s
//   idle (the existing skip-optimization already avoids needless captures
//     when nothing changed — that benefit is preserved)             → 4s
//   blocked on the user (waiting / awaiting_input; nothing changing) → 5s
//
// `cadence_for` is a pure function so the tiers are trivially unit-testable; the
// "top 4" hot-set ranking lives in [`crate::state::AppState`] (cheap in-memory,
// no per-tick DB scan) and is passed in here as the `is_hot` boolean.

/// 1s tier — a hot (top-4 most-recently-active) working/loading session.
pub const CADENCE_HOT: Duration = Duration::from_secs(1);
/// 2s tier — a working/loading session that is not in the hot top-4.
pub const CADENCE_ACTIVE: Duration = Duration::from_secs(2);
/// 4s tier — an idle session (skip-optimization still elides captures when
/// nothing changed).
pub const CADENCE_IDLE: Duration = Duration::from_secs(4);
/// 5s tier — a session blocked on the user (waiting / awaiting_input).
pub const CADENCE_WAITING: Duration = Duration::from_secs(5);
/// Fallback cadence for any status with no explicit tier (e.g. `Unknown`,
/// `Stopped`) — the original fixed detector tick, a safe middle ground.
pub const CADENCE_DEFAULT: Duration = Duration::from_secs(2);

/// The adaptive cadence for the NEXT tick, by `status` + hotness (M-CADENCE).
///
/// Pure function (no clock, no I/O) so the tier table is unit-tested directly:
/// `(status, is_hot) -> Duration`.
///
/// * `Active` / `Starting` (working or loading): `1s` when `is_hot` (top-4 most
///   recently active among working sessions), else `2s`.
/// * `Idle`: `4s` — nothing is changing fast; the capture-skip keeps it cheap.
/// * `Waiting`: `5s` — blocked on the user, the screen is frozen on a prompt.
/// * anything else (`Unknown`, `Stopped`): the `2s` default.
pub fn cadence_for(status: Status, is_hot: bool) -> Duration {
    match status {
        Status::Active | Status::Starting => {
            if is_hot {
                CADENCE_HOT
            } else {
                CADENCE_ACTIVE
            }
        }
        Status::Idle => CADENCE_IDLE,
        Status::Waiting => CADENCE_WAITING,
        Status::Stopped | Status::Unknown => CADENCE_DEFAULT,
    }
}
/// How many trailing scroll-back lines the detector classifies + stores.
pub const CAPTURE_LINES: usize = 30;
/// Cold-start sentinel: a freshly-booted server pretends the last PTY byte was 5
/// minutes ago so the first tick never spuriously reads `Active` (§3.2.8).
pub const COLD_START_IDLE: Duration = Duration::from_secs(300);

/// The live-status states surfaced to the UI (§3.2.8).
///
/// Serialises lower-case (`"active"`, …) to match the `last_status` CHECK values
/// and the frontend `Session.status` union.
///
/// `Starting` is a short-lived boot/spawn marker emitted by
/// [`super::lifecycle::start`] before the agent UI is ready (the spawn window
/// between session create and the first stable detector classification). The
/// detector loop replaces it with the real status on the next tick — the
/// classifier itself never returns `Starting`, so the multi-signal fusion stays
/// intact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Active,
    Waiting,
    Idle,
    Stopped,
    Starting,
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
            Status::Starting => "starting",
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
    /// types). Accepts the snake_case wire form supermux's hook command emits
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
/// heartbeat alone keeps the session `Active` — so the shell-out is overhead for
/// STATUS purposes. BUT the capture also produces the live preview tail, so we
/// must NOT skip forever: `last_capture_elapsed` bounds the skip so a session
/// that streams every tick still re-captures (and re-broadcasts its tail) at
/// least every [`MAX_PREVIEW_STALENESS`]. Without that bound a busy agent's
/// overview tile froze its preview for the entire duration of the work (the
/// "Claude is doing things but the card doesn't update" bug). The bound still
/// lets a chatty agent skip most ticks, keeping roughly the intended tmux
/// spawn-rate reduction. Unit-tested as a pure function.
pub fn should_skip_capture(
    last_pty: Instant,
    last_status: Status,
    last_capture_elapsed: Duration,
) -> bool {
    should_skip_capture_within(last_pty, last_status, last_capture_elapsed, MAX_PREVIEW_STALENESS)
}

/// Tier-bounded variant of [`should_skip_capture`] (M-CADENCE).
///
/// Identical skip logic, but the max-staleness is the caller-supplied
/// `max_staleness` (the session's CURRENT cadence tier) instead of the fixed
/// [`MAX_PREVIEW_STALENESS`]. Binding the skip to the live tier is what lets a
/// 1s-tier (hot, streaming) session actually re-capture within ~1s — the old
/// fixed 4s bound would otherwise let a chatty agent skip three 1s ticks in a
/// row and defeat the whole point of the hot tier. Idle/waiting sessions are
/// `last_status != Active`, so they never reach the staleness check and stay
/// cheap regardless of the (larger) bound passed in.
pub fn should_skip_capture_within(
    last_pty: Instant,
    last_status: Status,
    last_capture_elapsed: Duration,
    max_staleness: Duration,
) -> bool {
    last_status == Status::Active
        && last_pty.elapsed() < SKIP_WINDOW
        && last_capture_elapsed < max_staleness
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
            "sander@mac supermux $ ",
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
        let fresh_capture = Duration::from_millis(0);
        assert!(should_skip_capture(
            Instant::now(),
            Status::Active,
            fresh_capture
        ));
        // Not active → never skip.
        assert!(!should_skip_capture(
            Instant::now(),
            Status::Idle,
            fresh_capture
        ));
        // Active but stale heartbeat → must re-capture.
        let stale = Instant::now() - Duration::from_secs(5);
        assert!(!should_skip_capture(stale, Status::Active, fresh_capture));
    }

    #[test]
    fn skip_bounded_by_preview_staleness() {
        // Active + fresh heartbeat but the preview has gone stale past the cap →
        // must re-capture so the live tail keeps refreshing (the "busy agent's
        // overview tile froze" bug). Below the cap it may still skip.
        let stale_preview = MAX_PREVIEW_STALENESS + Duration::from_millis(1);
        assert!(!should_skip_capture(
            Instant::now(),
            Status::Active,
            stale_preview
        ));
        let fresh_preview = MAX_PREVIEW_STALENESS - Duration::from_millis(500);
        assert!(should_skip_capture(
            Instant::now(),
            Status::Active,
            fresh_preview
        ));
    }

    #[test]
    fn cadence_tiers_match_the_spec() {
        // working/loading + hot → 1s; not hot → 2s.
        assert_eq!(cadence_for(Status::Active, true), Duration::from_secs(1));
        assert_eq!(cadence_for(Status::Active, false), Duration::from_secs(2));
        assert_eq!(cadence_for(Status::Starting, true), Duration::from_secs(1));
        assert_eq!(cadence_for(Status::Starting, false), Duration::from_secs(2));
        // idle → 4s (hotness is irrelevant — idle is never hot).
        assert_eq!(cadence_for(Status::Idle, true), Duration::from_secs(4));
        assert_eq!(cadence_for(Status::Idle, false), Duration::from_secs(4));
        // blocked-on-user → 5s.
        assert_eq!(cadence_for(Status::Waiting, true), Duration::from_secs(5));
        assert_eq!(cadence_for(Status::Waiting, false), Duration::from_secs(5));
        // fallthrough statuses get the safe 2s default.
        assert_eq!(cadence_for(Status::Stopped, false), Duration::from_secs(2));
        assert_eq!(cadence_for(Status::Unknown, false), Duration::from_secs(2));
    }

    #[test]
    fn staleness_tracks_the_active_tier() {
        // A hot (1s) streaming-Active session must NOT skip once its preview is
        // older than its 1s tier, even though the heartbeat is fresh — otherwise
        // the old fixed 4s bound would let it skip and defeat the 1s tier.
        let hot = cadence_for(Status::Active, true); // 1s
        let stale_for_hot = hot + Duration::from_millis(1);
        assert!(!should_skip_capture_within(
            Instant::now(),
            Status::Active,
            stale_for_hot,
            hot,
        ));
        // Below the 1s tier it may still skip (fresh heartbeat + fresh preview).
        let fresh_for_hot = hot - Duration::from_millis(200);
        assert!(should_skip_capture_within(
            Instant::now(),
            Status::Active,
            fresh_for_hot,
            hot,
        ));
        // The SAME preview age that is "stale" for the 1s tier is still "fresh"
        // for the 2s (not-hot) tier — proof the bound really tracks the tier.
        let warm = cadence_for(Status::Active, false); // 2s
        assert!(should_skip_capture_within(
            Instant::now(),
            Status::Active,
            stale_for_hot,
            warm,
        ));
        // Idle/waiting are never Active → never skip, regardless of the bound.
        assert!(!should_skip_capture_within(
            Instant::now(),
            Status::Idle,
            Duration::from_millis(0),
            cadence_for(Status::Idle, false),
        ));
    }

    #[test]
    fn status_starting_serialises_lowercase() {
        // Starting must round-trip via its lower-case token (matches the DB
        // CHECK + the frontend `SessionStatus` union member).
        assert_eq!(Status::Starting.as_str(), "starting");
        // Pure-classifier guarantee: the detector itself never returns
        // `Starting` — it is a lifecycle-set transient. Idle/active/waiting
        // capture markers should still classify their own status, never get
        // shadowed by a `Starting` branch in the bank.
        let mut d = StatusDetector::new();
        d.force(Status::Starting);
        // Active marker beats a held `Starting` (classifier reads the bank).
        assert_eq!(d.detect("esc to interrupt", neutral_pty(), None), Status::Active);
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

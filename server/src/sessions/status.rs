//! Multi-signal status detector — CORE (TECH_PLAN §3.2.8, §3.6; M5a).
//!
//! This is the crown-jewel reliability module: when the UI says "waiting", the
//! agent is actually waiting. The classifier is a **pure function** of its inputs
//! ([`StatusDetector::detect`]) so it can be pinned by 30 golden capture-pane
//! fixtures (`tests/fixtures/status/*.txt`) and never silently regresses when the
//! regex bank evolves.
//!
//! **M5a / M5b / STATUS split (§3.6).** M5a shipped the fusion order *regex bank
//! → PTY heartbeat → idle timeout*, the cold-start init, and the `last_capture`
//! writeback. **M5b** wired the hook-event branch in. **STATUS** ("busy while
//! thinking" fix) replaces the 3s single-hook fast-path with a TURN STATE MACHINE
//! ([`TurnState`]): the per-session newest instant of EACH turn-relevant hook,
//! fed by `/api/_internal/hook` →
//! [`AppState::record_hook`](crate::state::AppState::record_hook) →
//! [`AppState::turn_state`](crate::state::AppState::turn_state). A turn in
//! progress reads `Active` for its WHOLE duration — even during a silent "think"
//! between tool calls — which is the bug this module exists to fix.
//!
//! **Fusion rule** (per-session, evaluated every 2s — or sooner, on a hook wake —
//! by the detector loop in [`super::auto_actions`]):
//! 1. Hook turn state machine (`TurnState::classify`) — the apex signal. When
//!    the newest turn hook is within the `TURN_SAFETY` bound (≈15 min):
//!    `Notification` newest → `Waiting`; `turn_start > turn_end` → `Active` (a
//!    turn is running, incl. a silent think); `turn_end ≥ turn_start` → `Idle`.
//!    The classic <3s fast-path is a strict subset. A missed `Stop` older than
//!    the safety bound falls through (never pins `Active` forever).
//! 2. capture-pane regex bank (broadened spinner-glyph class; golden-tested).
//! 3. PTY heartbeat: bytes <1.5s → `Active` — **only for sessions WITHOUT live
//!    hooks**. A hooked session is authoritative off (1)+(2); the heartbeat
//!    cannot distinguish the agent's output from the echo of the user TYPING at
//!    the prompt, so for hooked sessions it is suppressed (typing must not flip
//!    the card to busy — the core fragility this fix removes).
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
/// A hook event newer than this is the classic <3s fresh-hook fast-path (M5b).
/// The turn state machine (below) GENERALISES it: it trusts the per-turn hook
/// timestamps for a much longer [`TURN_SAFETY`] window, so a silent "thinking"
/// gap between tool calls (routinely 10–60s, sometimes minutes) keeps the
/// session `Active` instead of expiring after 3s and falling back to a
/// content-scrape that misses the silent think. The 3s window is kept as a
/// documented strict subset: any event newer than `HOOK_FRESH` is, a fortiori,
/// newer than `TURN_SAFETY`, so the state machine decides it identically to the
/// old fast-path (Notification→Waiting, turn-start→Active, turn-end→Idle).
#[allow(dead_code)]
const HOOK_FRESH: Duration = Duration::from_secs(3);
/// Generous upper bound on how long the turn state machine trusts the newest
/// turn-relevant hook before it gives up and falls through to the content bank +
/// heartbeat (the "busy while thinking" fix; spec §B). A real turn can think
/// silently for many seconds to a couple of minutes, so this is intentionally
/// large — but bounded, so a *missed* `Stop` hook (the curl raced a server
/// restart, the network blipped, …) can never pin a session `Active` forever.
/// Once the newest hook is older than this, the detector behaves exactly as it
/// did pre-fix: regex bank → PTY heartbeat → idle timeout.
const TURN_SAFETY: Duration = Duration::from_secs(15 * 60);
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

/// The Claude Code permission MODE surfaced to the UI (mode-shift).
///
/// Distinct from [`Status`] (busy/idle/waiting): this is the *permission mode*
/// the user picked, persistently shown in Claude's bottom status bar. Three of
/// the four are runtime-cyclable with Shift+Tab (`Normal → AcceptEdits → Plan →
/// Normal`); [`Mode::Bypass`] is launch-only and requires a relaunch with a flag.
///
/// Serialises lower-case (`"normal"`, `"accept_edits"`, `"plan"`, `"bypass"`) so
/// the frontend `SessionMode` union matches the wire exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Normal,
    AcceptEdits,
    Plan,
    Bypass,
}

impl Mode {
    /// The canonical lower-case (snake_case) token used over the wire and by the
    /// set-mode endpoint's request body.
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Normal => "normal",
            Mode::AcceptEdits => "accept_edits",
            Mode::Plan => "plan",
            Mode::Bypass => "bypass",
        }
    }

    /// Parse the wire/request token back into a [`Mode`]. Accepts a couple of
    /// spellings (`accept_edits`/`acceptedits`/`accept-edits`) so the API is
    /// lenient about the client's exact casing. Unknown tokens return `None`.
    pub fn from_token(s: &str) -> Option<Mode> {
        match s.trim().to_ascii_lowercase().replace(['-', ' '], "_").as_str() {
            "normal" | "default" => Some(Mode::Normal),
            "accept_edits" | "acceptedits" | "accept" => Some(Mode::AcceptEdits),
            "plan" => Some(Mode::Plan),
            "bypass" | "bypass_permissions" | "bypasspermissions" => Some(Mode::Bypass),
            _ => None,
        }
    }
}

/// Pure detector for the Claude Code permission mode from a capture-pane snapshot
/// (mode-shift). Reuses the SAME status-bar markers the classifier's IDLE-bank
/// comment documents but DELIBERATELY discards (lines ~540-551): `⏵⏵` / `accept
/// edits` ⇒ [`Mode::AcceptEdits`], `plan mode` ⇒ [`Mode::Plan`], `bypass
/// permissions` ⇒ [`Mode::Bypass`], else [`Mode::Normal`].
///
/// PURE (no clock, no I/O) so it is trivially unit-tested and can never regress
/// the status classifier — it only READS the capture the detector already holds.
///
/// Precedence note: `bypass` is checked first (it is the most consequential and
/// unambiguous), then `plan`, then accept-edits (`⏵⏵` / "accept edits"). A real
/// Claude status bar only ever shows one of these at a time, so the order only
/// matters defensively for a capture that scrolled two bars together.
pub fn parse_mode(capture: &str) -> Mode {
    let c = capture.to_lowercase();
    if c.contains("bypass permissions") || c.contains("bypass-permissions") {
        Mode::Bypass
    } else if c.contains("plan mode") {
        Mode::Plan
    } else if capture.contains("⏵⏵") || c.contains("accept edits") {
        Mode::AcceptEdits
    } else {
        Mode::Normal
    }
}

/// Claude Code `SettingsHook` event kinds (§3.6). Consumed by the fusion rule in
/// [`StatusDetector::classify`]; fed in by M5b's `/api/_internal/hook` endpoint
/// via [`AppState::record_hook`](crate::state::AppState::record_hook).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    /// `UserPromptSubmit` — the user submitted a prompt ⇒ a turn STARTS (the model
    /// begins thinking, possibly silently, before any tool call) ⇒ `Active`.
    UserPromptSubmit,
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
    /// (`user_prompt`, `pre_tool`, `post_tool`, `notification`, `stop`,
    /// `subagent_stop`) plus the PascalCase Claude SettingsHook names, so either
    /// spelling is robust. Unknown kinds return `None` (the endpoint treats them
    /// as a no-op).
    pub fn from_event_str(s: &str) -> Option<HookEvent> {
        match s {
            "user_prompt" | "user_prompt_submit" | "UserPromptSubmit" => {
                Some(HookEvent::UserPromptSubmit)
            }
            "pre_tool" | "pre_tool_use" | "PreToolUse" => Some(HookEvent::PreToolUse),
            "post_tool" | "post_tool_use" | "PostToolUse" => Some(HookEvent::PostToolUse),
            "notification" | "Notification" => Some(HookEvent::Notification),
            "stop" | "Stop" => Some(HookEvent::Stop),
            "subagent_stop" | "SubagentStop" => Some(HookEvent::SubagentStop),
            _ => None,
        }
    }
}

/// A per-session snapshot of the LATEST instant each turn-relevant hook fired
/// (spec §B — the turn state machine, the core reliability win). Unlike the old
/// single "last hook" `(Instant, HookEvent)`, this remembers each event TYPE's
/// most recent time independently, so a `PreToolUse` followed by a long silent
/// think still has a `turn_start` newer than any `turn_end` — keeping the
/// session `Active` for the whole turn rather than expiring 3s after the last
/// tool call.
///
/// Built in [`crate::state::AppState`] from the per-session per-event timestamp
/// map and passed *into* [`StatusDetector::detect`] so the classifier stays a
/// pure function of its inputs (golden-testable; v2 lesson #4). All fields are
/// `Option<Instant>` because a session may not have seen every event yet.
#[derive(Debug, Clone, Copy, Default)]
pub struct TurnState {
    /// Newest `UserPromptSubmit` — the user submitted a prompt (a turn begins).
    pub user_prompt: Option<Instant>,
    /// Newest `PreToolUse` — the agent started a tool call (a turn is running).
    pub pre_tool: Option<Instant>,
    /// Newest `PostToolUse` — a tool finished (still mid-turn; the model may now
    /// think silently before the next tool or the `Stop`).
    pub post_tool: Option<Instant>,
    /// Newest `Stop` — the agent's turn ended.
    pub stop: Option<Instant>,
    /// Newest `SubagentStop` — a sub-agent turn ended.
    pub subagent_stop: Option<Instant>,
    /// Newest `Notification` — Claude is asking the user something (blocked).
    pub notification: Option<Instant>,
}

impl TurnState {
    /// Fold one hook event at `at` into the snapshot (bump that type's newest
    /// instant). Used by [`crate::state::AppState::record_hook`].
    pub fn apply(&mut self, at: Instant, event: HookEvent) {
        let slot = match event {
            HookEvent::UserPromptSubmit => &mut self.user_prompt,
            HookEvent::PreToolUse => &mut self.pre_tool,
            HookEvent::PostToolUse => &mut self.post_tool,
            HookEvent::Stop => &mut self.stop,
            HookEvent::SubagentStop => &mut self.subagent_stop,
            HookEvent::Notification => &mut self.notification,
        };
        // Monotonic per type: never let an out-of-order delivery move a slot back.
        if slot.map(|prev| at > prev).unwrap_or(true) {
            *slot = Some(at);
        }
    }

    /// `turn_start` = newest of {UserPromptSubmit, PreToolUse, PostToolUse}.
    fn turn_start(&self) -> Option<Instant> {
        [self.user_prompt, self.pre_tool, self.post_tool]
            .into_iter()
            .flatten()
            .max()
    }

    /// `turn_end` = newest of {Stop, SubagentStop}.
    fn turn_end(&self) -> Option<Instant> {
        [self.stop, self.subagent_stop].into_iter().flatten().max()
    }

    /// The newest of ALL turn-relevant hooks (start/end/notif), if any.
    fn newest(&self) -> Option<Instant> {
        [self.turn_start(), self.turn_end(), self.notification]
            .into_iter()
            .flatten()
            .max()
    }

    /// Classify purely from the turn timestamps, when the newest is within
    /// [`TURN_SAFETY`] (spec §B):
    /// * `Notification` newest AND a turn is IN PROGRESS ⇒ `Waiting` (a genuine
    ///   permission/question prompt — Claude paused mid-turn to ask the user);
    /// * `Notification` newest but the turn already ENDED (a `Stop`/`SubagentStop`
    ///   is newer than the turn start) ⇒ `Idle`. This is the key nuance: Claude
    ///   Code ALSO fires a `Notification` ~60s after a turn finishes ("Claude is
    ///   waiting for your input") while it sits at an idle prompt. That post-turn
    ///   idle notification must NOT read `Waiting`/"needs input" — the agent
    ///   finished and is simply idle, not blocked on a specific question. Only a
    ///   notification *within* an active turn means the agent is truly blocked.
    /// * else `turn_start > turn_end` ⇒ `Active` (a turn is in progress — this is
    ///   what covers a silent think between/after tool calls);
    /// * else (`turn_end ≥ turn_start`, turn ended) ⇒ `Idle`.
    ///
    /// Returns `None` when there are no hooks yet OR the newest hook is older
    /// than [`TURN_SAFETY`] — the caller then falls through to the content bank +
    /// heartbeat, so a *missed* `Stop` can never pin `Active` forever.
    fn classify(&self) -> Option<Status> {
        let newest = self.newest()?;
        if newest.elapsed() >= TURN_SAFETY {
            return None;
        }
        let start = self.turn_start();
        let end = self.turn_end();
        // Notification is decisive only when it is itself the newest signal — a
        // mid-turn notification superseded by a later PreToolUse/Stop must not pin
        // Waiting. AND it means "blocked on the user" only when it arrived WITHIN
        // an active turn: a turn has started (`start` exists) and has NOT since
        // ended (`end` is None or older than `start`). A notification that arrives
        // after the turn's `Stop` is Claude's idle-prompt notification → fall
        // through to the turn-boundary logic below, which yields `Idle`.
        if self.notification == Some(newest) {
            // The ONLY non-Waiting notification is Claude's post-turn idle
            // notification: a `Stop`/`SubagentStop` ended the turn (`end` exists
            // and is at least as recent as the turn start) and THEN a notification
            // arrived while idling at the prompt. Every other notification — one
            // within an active turn, or a lone notification with no completed turn
            // — means the agent is blocked on the user ⇒ Waiting (conservative:
            // when unsure, surface "needs input" rather than hide it).
            let turn_already_ended = matches!((start, end), (Some(s), Some(e)) if e >= s)
                || matches!((start, end), (None, Some(_)));
            if !turn_already_ended {
                return Some(Status::Waiting);
            }
            // else: post-turn idle notification — fall through → Idle below.
        }
        match (start, end) {
            (Some(s), Some(e)) if s > e => Some(Status::Active),
            (Some(_), None) => Some(Status::Active),
            (Some(_), Some(_)) => Some(Status::Idle), // turn_end ≥ turn_start
            (None, Some(_)) => Some(Status::Idle),    // only an end seen
            (None, None) => None,                     // only a (stale) notif — handled above
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
    /// * `turn` — the per-session [`TurnState`] (the newest instant of each
    ///   turn-relevant hook). The PRIMARY signal: a turn in progress reads
    ///   `Active` for the whole turn, even during a silent think (spec §B).
    /// * `has_hooks` — whether this session has LIVE Claude Code hooks (we have
    ///   received at least one hook POST from it, so the runtime is authoritative
    ///   about turn boundaries). When `true`, the raw PTY-heartbeat "bytes flowing
    ///   ⇒ Active" fallback is SUPPRESSED: the user merely TYPING at the prompt
    ///   echoes bytes back through the pane (which the FIFO reader stamps as a
    ///   fresh heartbeat), and that must NOT read as "the agent is working". For a
    ///   hooked session the turn state machine (+ the content regex bank, which
    ///   only matches glyphs Claude itself prints) already covers every genuine
    ///   `Active`, so the heartbeat adds only the typing-echo false positive.
    ///
    /// Deterministic given `(capture, last_pty, turn, has_hooks, self.last_status)`
    /// — the property the golden-fixture snapshot tests rely on.
    pub fn detect(
        &mut self,
        capture: &str,
        last_pty: Instant,
        turn: TurnState,
        has_hooks: bool,
    ) -> Status {
        let status = self.classify(capture, last_pty, turn, has_hooks);
        self.last_status = status;
        status
    }

    fn classify(&self, capture: &str, last_pty: Instant, turn: TurnState, has_hooks: bool) -> Status {
        // ── 0. user-interrupt pre-emption ────────────────────────────────────
        // When the user presses Esc twice in the Claude TUI, the current turn
        // is interrupted and the TUI shows the literal "Interrupted · What
        // should Claude do instead?" prompt. Claude Code does NOT emit a
        // `Stop` hook for this case, so the turn state machine still sees
        // `turn_start > turn_end` and would pin Active for the full
        // [`TURN_SAFETY`] window (15 min) — wrong, the agent is at rest. The
        // marker is unambiguous: it only appears on that exact prompt, so we
        // safely pre-empt the turn machine and return Waiting (the agent is
        // blocked on the user picking the next action — same semantics as
        // every other entry in WAITING_BANK). Pure capture-driven, robust
        // even when hooks are flapping.
        if INTERRUPT_MARKER.is_match(capture) {
            return Status::Waiting;
        }

        // ── 1. hook TURN STATE MACHINE (the multi-signal apex; spec §B) ────────
        // The per-turn hook timestamps come straight from the agent runtime — the
        // most authoritative signal we have — so they OUTRANK the regex bank and
        // the PTY heartbeat. Unlike the old <3s single-hook fast-path (which the
        // 3s window made expire mid-think, the smoking-gun bug), the state machine
        // trusts the newest turn hook for a generous [`TURN_SAFETY`] window:
        //   * Notification newest        → Waiting (blocked on the user)
        //   * turn_start > turn_end       → Active  (a turn is running — covers a
        //                                            silent think between tools!)
        //   * turn_end ≥ turn_start       → Idle    (the turn ended)
        // It returns `None` only when there are NO hooks yet or the newest is
        // older than the safety bound — so a *missed* Stop can never pin Active
        // forever; we then fall through to the content bank + heartbeat below.
        // (`PostToolUse` is still non-decisive in the sense that it contributes to
        // `turn_start` only as part of "a turn is in progress" — a lone PostToolUse
        // older than any Stop yields Idle, not a pinned Active.)
        if let Some(s) = turn.classify() {
            return s;
        }

        // ── 2. capture-pane regex bank (v2 §1.3) ─────────────────────────────
        if ACTIVE_BANK.is_match(capture) {
            return Status::Active;
        }
        if WAITING_BANK.is_match(capture) {
            return Status::Waiting;
        }
        if IDLE_BANK.is_match(capture) {
            return Status::Idle;
        }

        // ── 3. PTY heartbeat fallback (NON-HOOK sessions only) ───────────────
        // Fresh bytes ⇒ Active is a HEURISTIC: it cannot tell the agent's own
        // output from the echo of the user TYPING at the prompt. For a session
        // with live Claude hooks the runtime is authoritative about turn
        // boundaries — a turn in progress already reads Active off the turn state
        // machine (step 1), and the content bank (step 2) matches the spinner
        // glyphs Claude itself prints — so the heartbeat would contribute ONLY
        // the typing-echo false positive ("I typed a character at the idle prompt
        // and the card flipped to busy"). Suppress it for hooked sessions; keep
        // it as the genuine liveness fallback for shell / codex / claude with
        // unwired (or not-yet-fired) hooks.
        let silent = last_pty.elapsed();
        if !has_hooks && silent < PTY_ACTIVE_WINDOW {
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
///
/// Anchored primarily on **`esc to interrupt`** — shown the WHOLE time Claude is
/// interruptible/busy (the modern line is
/// `✻ Thinking… (esc to interrupt · 12s · ↑ 2.1k tokens)`), so it survives every
/// spinner glyph frame. Plus a glyph CLASS + ellipsis (Claude cycles the spinner
/// glyph ✻ ✶ ✳ ✢ ✽ ✺ ❋ ⚹ ∗ · * across frames, so anchoring on `✻` alone misses
/// most captured frames — the spec §C fix), and the `running...` / `reading N
/// files` verbs.
///
/// **Line-start anchor (the boot false-positive fix).** The spinner-glyph branch
/// is anchored to the START of a line (`(?m)^\s*<glyph>…`). Claude's real spinner
/// is ALWAYS the first visible character of its status line (`✻ Thinking…`,
/// `✳ Cogitating…`, …). Two of the glyphs in the class — `·` and `*` — also occur
/// as ordinary text: `·` is Claude's separator in the welcome box and bottom
/// status bar (`Opus 4.7 · Claude Max · …`) and as a bullet, `*` in markdown. The
/// OLD unanchored pattern matched a mid-line `·` followed anywhere later by a `…`
/// truncation ellipsis (`· Claude Max · │ /usage now shows a p…`), so a freshly
/// booted, IDLE session whose welcome box contained both glyphs read ACTIVE
/// forever — masking the bare `❯` idle prompt (the IDLE bank is checked AFTER
/// ACTIVE). Requiring the glyph at line-start keeps every genuine spinner frame
/// (all real frames are line-leading) while rejecting separators buried in a box.
static ACTIVE_BANK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?im)(esc to interrupt|esc t…|running\.\.\.|reading \d+ file|^\s*[✻✶✳✢✽✺❋⚹∗·*][^\n]*…)",
    )
    .unwrap()
});

/// WAITING markers: a selector / confirmation / approval prompt.
static WAITING_BANK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(enter to select|do you want to proceed|❯\s*\d+\.|interrupted.*what should claude|approve)")
        .unwrap()
});

/// USER-INTERRUPT marker: the literal prompt Claude Code shows after the user
/// presses Esc twice mid-turn. Unique enough to pre-empt the turn state
/// machine (Claude Code doesn't emit a `Stop` hook for user-interrupts, so the
/// machine would otherwise pin Active for the full TURN_SAFETY window).
static INTERRUPT_MARKER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)interrupted.*what should claude do").unwrap());

/// IDLE markers: a COMPLETED spinner or a bare shell/agent prompt.
///
/// The persistent status-bar / mode indicators `⏵⏵`, `bypass permissions`, and
/// `plan mode` were REMOVED (spec §D — the primary smoking gun): those are shown
/// the WHOLE time a session is open (a mode the user picked), NOT idle signals,
/// so a busy session whose spinner frame happened not to match read "done". The
/// bottom status bar ALONE must never yield Idle. What remains are genuine
/// end-of-turn / at-rest markers: a completed spinner (`✻ … for 1m 8s`), a bare
/// agent prompt (`❯` with nothing after it), a bare shell prompt (`$ ` at end of
/// line), or an idle codex shell prompt (`gpt-… · ~/path`).
static IDLE_BANK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?im)(✻.* for \d|❯\s*$|\$ $|gpt-\S+ · ~)").unwrap());

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
    /// a non-matching input and give a false pass). `has_hooks = false` so the
    /// bank/heartbeat path is exercised exactly as the golden fixtures expect.
    fn fresh(cap: &str) -> Status {
        StatusDetector::new().detect(cap, neutral_pty(), TurnState::default(), false)
    }

    /// A `TurnState` whose only hook is `event`, fired `ago` in the past.
    fn turn_with(event: HookEvent, ago: Duration) -> TurnState {
        let mut t = TurnState::default();
        t.apply(Instant::now() - ago, event);
        t
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
        // fresh detector must NOT read Active. `Running…` uses an ellipsis (not the
        // literal `...` the verb pattern wants) and has no spinner glyph; the bare
        // word has no glyph + ellipsis pair either. (Note: a spinner GLYPH followed
        // by an ellipsis — e.g. `✶ Thinking…` — is now legitimately Active per the
        // broadened glyph-class bank, so it is NOT a lookalike; see
        // `cycling_spinner_glyph_frames_are_active`.)
        for cap in ["Running…", "no spinner here at all"] {
            assert_eq!(fresh(cap), Status::Unknown, "{cap:?} must not match a bank");
        }
    }

    #[test]
    fn boot_welcome_box_separators_are_not_active() {
        // Regression (boot false-positive): a freshly-booted, IDLE Claude session
        // shows a welcome box whose lines contain the `·` separator AND a `…`
        // truncation ellipsis (`Opus 4.7 · Claude Max · │ /usage now shows a p…`).
        // The OLD unanchored glyph-class pattern matched that mid-line `·…` pair
        // and read ACTIVE forever, masking the bare `❯` idle prompt below it. The
        // line-start anchor rejects mid-line separators, so the bare prompt now
        // classifies Idle.
        let cap = "\
╭───────────────────────────────────────────────╮
│  Opus 4.7 (1M context) · Claude Max ·  `/usage` now shows a p… │
│  user@example.com's Organization     `/diff` detail view ca… │
╰───────────────────────────────────────────────╯

────────────────────────────────────────── idletest ──
❯
────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents";
        // The bare `❯ ` prompt must win as Idle — the welcome box `·…` no longer
        // false-matches ACTIVE.
        assert_eq!(fresh(cap), Status::Idle, "boot welcome box must not read Active");
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

    /// User-interrupt (Esc Esc) pre-empts the turn state machine. Claude Code
    /// does NOT emit a `Stop` hook for user-interrupts, so without the
    /// INTERRUPT_MARKER pre-emption the turn machine would still see
    /// `turn_start > turn_end` and pin Active for the full TURN_SAFETY (15 min)
    /// window — but the agent is clearly at rest waiting for the user to pick
    /// what to do next. This is the user-reported regression.
    #[test]
    fn user_interrupt_preempts_active_turn() {
        let mut d = StatusDetector::new();
        // Simulate an in-flight turn: PreToolUse just fired, no Stop yet.
        let turn = turn_with(HookEvent::PreToolUse, Duration::from_secs(5));
        let cap = "Interrupted · What should Claude do instead?";
        assert_eq!(d.detect(cap, Instant::now(), turn, true), Status::Waiting);
    }

    #[test]
    fn idle_markers_classify_idle() {
        for cap in [
            "✻ Brewed for 1m 8s",
            "user@host project %\n❯ ",
            "user@host supermux $ ",
            "gpt-5-codex · ~/code",
        ] {
            assert_eq!(fresh(cap), Status::Idle, "{cap:?}");
        }
    }

    #[test]
    fn status_bar_mode_indicators_are_not_idle() {
        // spec §D (primary smoking gun): the persistent bottom status-bar mode
        // indicators are shown the WHOLE time a session is open — they are the
        // user's chosen mode, NOT an idle signal. With no other marker a fresh
        // detector must NOT read Idle off them (it stays Unknown here); when a
        // spinner co-occurs the session reads Active (see the thinking tests).
        for cap in [
            "⏵⏵ accept edits on (shift+tab to cycle)",
            "bypass permissions",
            "plan mode",
        ] {
            assert_eq!(fresh(cap), Status::Unknown, "{cap:?} must NOT be Idle");
        }
    }

    #[test]
    fn pty_heartbeat_recent_bytes_are_active() {
        let mut d = StatusDetector::new();
        // No regex markers, no hooks; bytes flowed just now → Active (non-hook
        // session: the heartbeat heuristic is the liveness fallback).
        assert_eq!(d.detect("", Instant::now(), TurnState::default(), false), Status::Active);
    }

    #[test]
    fn pty_heartbeat_suppressed_for_hooked_session() {
        // The CORE fix: a HOOKED session (has_hooks = true) with fresh bytes (the
        // echo of the user typing at the prompt) but NO turn in progress and no
        // content marker must NOT read Active. The held status (Idle, from a prior
        // Stop) holds — typing at the prompt does not flip the card to busy.
        let mut d = StatusDetector::new();
        d.force(Status::Idle);
        assert_eq!(
            d.detect("", Instant::now(), TurnState::default(), true),
            Status::Idle,
            "fresh bytes (typing echo) must not flip a hooked idle session to Active"
        );
    }

    #[test]
    fn pty_heartbeat_long_silence_is_idle_once_known() {
        let mut d = StatusDetector::new();
        // Establish a known status first (so the cold-start guard is satisfied).
        d.force(Status::Active);
        let silent = Instant::now() - Duration::from_secs(45);
        assert_eq!(d.detect("", silent, TurnState::default(), false), Status::Idle);
    }

    #[test]
    fn cold_start_first_tick_is_unknown() {
        let mut d = StatusDetector::new();
        let cold = Instant::now() - COLD_START_IDLE;
        // Empty capture + cold heartbeat + never-classified → Unknown, NOT Idle.
        assert_eq!(d.detect("", cold, TurnState::default(), false), Status::Unknown);
    }

    #[test]
    fn active_outranks_idle_marker_ordering() {
        // A spinner line with the ellipsis must read Active even though a
        // completed-spinner idle marker could co-occur in scrollback.
        let mut d = StatusDetector::new();
        let cap = "✻ Brewed for 1m\n✻ Beaming… (esc to interrupt)";
        assert_eq!(d.detect(cap, neutral_pty(), TurnState::default(), false), Status::Active);
    }

    #[test]
    fn fresh_hook_outranks_regex_and_heartbeat() {
        // Multi-signal apex (§3.6 acceptance: "a fresh hook event outranks the
        // regex bank and the pty heartbeat"). Each capture below carries a marker
        // AND a just-now heartbeat, yet the fresh turn-state hook decides — the
        // <3s fast-path is now a strict subset of the turn state machine.
        let mut d = StatusDetector::new();
        d.force(Status::Idle);
        let notif = turn_with(HookEvent::Notification, Duration::ZERO);
        assert_eq!(d.detect("esc to interrupt", Instant::now(), notif, true), Status::Waiting);

        let pre = turn_with(HookEvent::PreToolUse, Duration::ZERO);
        assert_eq!(StatusDetector::new().detect("", neutral_pty(), pre, true), Status::Active);

        let mut d2 = StatusDetector::new();
        d2.force(Status::Active);
        let stop = turn_with(HookEvent::Stop, Duration::ZERO);
        assert_eq!(d2.detect("esc to interrupt", Instant::now(), stop, true), Status::Idle);
    }

    #[test]
    fn user_prompt_submit_then_silent_think_is_active() {
        // The headline fix (spec §B): a UserPromptSubmit with NO subsequent tool
        // call and NO PTY bytes (the model is thinking silently) must read Active.
        // Empty capture + neutral heartbeat would otherwise hold/idle.
        let mut d = StatusDetector::new();
        let turn = turn_with(HookEvent::UserPromptSubmit, Duration::from_secs(20));
        assert_eq!(d.detect("", neutral_pty(), turn, true), Status::Active);
    }

    #[test]
    fn pre_tool_then_long_silent_think_stays_active() {
        // A PreToolUse followed by a 40s silent think (no PostToolUse/Stop, no
        // bytes) — the old 3s fast-path expired here and the detector wrongly read
        // the status bar as Idle. The turn state machine keeps it Active.
        let mut d = StatusDetector::new();
        let turn = turn_with(HookEvent::PreToolUse, Duration::from_secs(40));
        assert_eq!(
            d.detect("⏵⏵ accept edits on (shift+tab to cycle)", neutral_pty(), turn, true),
            Status::Active
        );
    }

    #[test]
    fn stop_ends_the_turn_to_idle() {
        // turn_end ≥ turn_start ⇒ Idle, even with a stale earlier PreToolUse and a
        // status-bar capture present.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        let mut turn = TurnState::default();
        turn.apply(Instant::now() - Duration::from_secs(30), HookEvent::PreToolUse);
        turn.apply(Instant::now() - Duration::from_secs(2), HookEvent::Stop);
        assert_eq!(d.detect("plan mode", neutral_pty(), turn, true), Status::Idle);
    }

    #[test]
    fn notification_mid_turn_is_waiting() {
        // A Notification arriving as the NEWEST turn hook ⇒ Waiting (blocked on
        // the user), outranking an earlier PreToolUse.
        let mut d = StatusDetector::new();
        let mut turn = TurnState::default();
        turn.apply(Instant::now() - Duration::from_secs(10), HookEvent::PreToolUse);
        turn.apply(Instant::now() - Duration::from_secs(1), HookEvent::Notification);
        assert_eq!(d.detect("", neutral_pty(), turn, true), Status::Waiting);
    }

    #[test]
    fn post_turn_idle_notification_is_idle_not_waiting() {
        // Real Claude behavior: ~60s after a turn ends (Stop), Claude fires a
        // Notification ("waiting for your input") while sitting idle at the prompt.
        // Because the turn ALREADY ENDED (Stop is newer than the turn start), that
        // post-turn notification must read Idle, NOT Waiting — the agent finished
        // and is merely idle, not blocked on a specific question. (Contrast with a
        // permission notification that arrives mid-turn → Waiting.)
        let mut d = StatusDetector::new();
        d.force(Status::Idle);
        let mut turn = TurnState::default();
        turn.apply(Instant::now() - Duration::from_secs(40), HookEvent::UserPromptSubmit);
        turn.apply(Instant::now() - Duration::from_secs(38), HookEvent::Stop);
        turn.apply(Instant::now() - Duration::from_secs(1), HookEvent::Notification);
        assert_eq!(
            d.detect("", neutral_pty(), turn, true),
            Status::Idle,
            "post-turn idle notification must read Idle, not Waiting"
        );
    }

    #[test]
    fn superseded_notification_does_not_pin_waiting() {
        // A Notification followed by a newer PreToolUse ⇒ the turn resumed ⇒
        // Active, NOT a pinned Waiting (notif is decisive only when newest).
        let mut d = StatusDetector::new();
        let mut turn = TurnState::default();
        turn.apply(Instant::now() - Duration::from_secs(10), HookEvent::Notification);
        turn.apply(Instant::now() - Duration::from_secs(1), HookEvent::PreToolUse);
        assert_eq!(d.detect("", neutral_pty(), turn, true), Status::Active);
    }

    #[test]
    fn missed_stop_after_safety_bound_falls_through() {
        // The safety valve (spec §B): a turn_start older than TURN_SAFETY with no
        // Stop (the Stop curl was lost) must NOT pin Active forever — it falls
        // through to the content bank + heartbeat. Here the capture is empty and
        // the heartbeat is long-silent, so a previously-known session reads Idle.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        let turn = turn_with(HookEvent::PreToolUse, TURN_SAFETY + Duration::from_secs(5));
        let silent = Instant::now() - Duration::from_secs(45);
        // has_hooks = true (a real hooked session whose Stop curl was lost): the
        // stale turn falls through, the heartbeat is long-silent so the idle
        // timeout downgrades it — the safety valve still works for hooked sessions.
        assert_eq!(d.detect("", silent, turn, true), Status::Idle);
    }

    #[test]
    fn missed_stop_then_content_marker_decides() {
        // Same stale-turn fall-through, but a live ACTIVE capture marker is present
        // (the content safety net) → Active off the bank, not the stale turn hook.
        let mut d = StatusDetector::new();
        let turn = turn_with(HookEvent::PreToolUse, TURN_SAFETY + Duration::from_secs(5));
        assert_eq!(d.detect("esc to interrupt", neutral_pty(), turn, true), Status::Active);
    }

    #[test]
    fn cycling_spinner_glyph_frames_are_active() {
        // spec §C: Claude cycles the spinner glyph across frames, so every frame
        // (not just ✻) + an ellipsis must read Active — even while the persistent
        // status bar (which used to win as Idle) is on screen.
        for glyph in ['✻', '✶', '✳', '✢', '✽', '✺', '·', '*'] {
            let cap = format!(
                "{glyph} Thinking…\n⏵⏵ accept edits on (shift+tab to cycle)"
            );
            assert_eq!(fresh(&cap), Status::Active, "glyph {glyph:?}");
        }
    }

    #[test]
    fn token_count_interrupt_line_is_active() {
        // The modern interrupt line with the elapsed-time + token-count tail must
        // read Active via the `esc to interrupt` anchor, regardless of glyph frame
        // or the mode shown in the status bar below it.
        for mode in [
            "⏵⏵ accept edits on (shift+tab to cycle)",
            "plan mode",
            "bypass permissions",
        ] {
            let cap = format!(
                "✻ Thinking… (esc to interrupt · 12s · ↑ 2.1k tokens)\n{mode}"
            );
            assert_eq!(fresh(&cap), Status::Active, "mode {mode:?}");
        }
    }

    #[test]
    fn hook_event_parsing_covers_all_kinds() {
        use HookEvent::*;
        for (s, want) in [
            ("user_prompt", UserPromptSubmit),
            ("user_prompt_submit", UserPromptSubmit),
            ("UserPromptSubmit", UserPromptSubmit),
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
    fn turn_state_apply_is_monotonic_per_type() {
        // An out-of-order (older) delivery for a type must NOT move its slot back.
        let mut t = TurnState::default();
        let newer = Instant::now();
        let older = newer - Duration::from_secs(5);
        t.apply(newer, HookEvent::PreToolUse);
        t.apply(older, HookEvent::PreToolUse);
        assert_eq!(t.pre_tool, Some(newer));
    }

    #[test]
    fn empty_turn_state_is_non_decisive() {
        // No hooks at all → the turn machine abstains so the bank/heartbeat decide.
        assert_eq!(TurnState::default().classify(), None);
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
        assert_eq!(d.detect("esc to interrupt", neutral_pty(), TurnState::default(), false), Status::Active);
    }

    #[test]
    fn parse_mode_reads_the_status_bar() {
        // mode-shift: parse_mode reuses the SAME status-bar markers the IDLE bank
        // deliberately discards. Each persistent bar maps to its mode; a capture
        // with none of them is Normal (Claude's default, no special bar).
        assert_eq!(
            parse_mode("⏵⏵ accept edits on (shift+tab to cycle)"),
            Mode::AcceptEdits
        );
        assert_eq!(parse_mode("ACCEPT EDITS on"), Mode::AcceptEdits);
        assert_eq!(parse_mode("plan mode"), Mode::Plan);
        assert_eq!(parse_mode("⏸ plan mode on (shift+tab to cycle)"), Mode::Plan);
        assert_eq!(parse_mode("bypass permissions"), Mode::Bypass);
        assert_eq!(parse_mode("Bypass Permissions on"), Mode::Bypass);
        // No mode bar at all → Normal.
        assert_eq!(parse_mode(""), Mode::Normal);
        assert_eq!(parse_mode("❯ \n$ "), Mode::Normal);
        // A live thinking line with no mode bar is still Normal (mode ≠ status).
        assert_eq!(parse_mode("✻ Thinking… (esc to interrupt)"), Mode::Normal);
    }

    #[test]
    fn parse_mode_bypass_outranks_other_bars() {
        // Defensive precedence when a capture scrolled two bars together — bypass
        // is the most consequential, so it wins. (A real bar shows only one.)
        assert_eq!(
            parse_mode("plan mode\nbypass permissions"),
            Mode::Bypass
        );
    }

    #[test]
    fn mode_roundtrips_via_str() {
        for m in [Mode::Normal, Mode::AcceptEdits, Mode::Plan, Mode::Bypass] {
            assert_eq!(Mode::from_token(m.as_str()), Some(m), "{m:?}");
        }
        // Lenient casing / spellings the set-mode endpoint accepts.
        assert_eq!(Mode::from_token("AcceptEdits"), Some(Mode::AcceptEdits));
        assert_eq!(Mode::from_token("accept-edits"), Some(Mode::AcceptEdits));
        assert_eq!(Mode::from_token("default"), Some(Mode::Normal));
        assert_eq!(Mode::from_token("bypassPermissions"), Some(Mode::Bypass));
        assert_eq!(Mode::from_token("garbage"), None);
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

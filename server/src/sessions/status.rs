//! Multi-signal status detector — CORE.
//!
//! This is the crown-jewel reliability module: when the UI says "waiting", the
//! agent is actually waiting. The classifier is a **pure function** of its inputs
//! ([`StatusDetector::detect`]) so it can be pinned by 30 golden capture-pane
//! fixtures (`tests/fixtures/status/*.txt`) and never silently regresses when the
//! regex bank evolves.
//!
//! **Evolution.** The fusion order started as *regex bank → PTY heartbeat → idle
//! timeout*, with cold-start init and a `last_capture` writeback. A later pass
//! wired the hook-event branch in. The "busy while thinking" fix then replaced
//! the 3s single-hook fast-path with a TURN STATE MACHINE
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
/// A hook event newer than this is the classic <3s fresh-hook fast-path.
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
/// heartbeat (the "busy while thinking" fix). A real turn can think
/// silently for many seconds to a couple of minutes, so this is intentionally
/// large — but bounded, so a *missed* `Stop` hook (the curl raced a server
/// restart, the network blipped, …) can never pin a session `Active` forever.
/// Once the newest hook is older than this, the detector behaves exactly as it
/// did pre-fix: regex bank → PTY heartbeat → idle timeout.
const TURN_SAFETY: Duration = Duration::from_secs(15 * 60);
/// After the turn state machine still reads `Active` (a `turn_start` with no
/// newer `Stop`), how long the PTY must be QUIET before a capture that plainly
/// shows the session back at its idle composer is trusted to mean the turn was
/// CANCELLED/INTERRUPTED without a `Stop` hook.
///
/// This is the server mirror of the chat client's idle-settle. A chat/Grok
/// "Stop" (and a bare Esc in the composer) delivers a single `Escape` into the
/// pty; Claude Code interrupts the turn and returns to the `❯` prompt but emits
/// **no `Stop` hook**, so the turn machine — which outranks the capture bank —
/// would otherwise pin `Active` for the whole [`TURN_SAFETY`] (15 min) window
/// over a session the terminal shows at rest, leaving the roster tile + header
/// dot busy. Reconciling the stale `Active` against the pty ground truth flips
/// it back to `Idle`.
///
/// Bounded small so the dot is honest within a couple of ticks of a cancel, but
/// non-zero so the sub-second gap at turn START (prompt submitted, spinner not
/// yet drawn — pty bytes still flowing) can never flip a genuinely new turn to
/// idle before its spinner appears.
const CANCEL_SETTLE: Duration = Duration::from_secs(3);
/// How long the `esc to interrupt` spinner (ACTIVE_BANK) must be CONTINUOUSLY
/// absent before a held-`Active` session is settled to `Idle` — the settle
/// signal that, unlike [`CANCEL_SETTLE`] (pty silence), a ticking background
/// pane cannot defeat.
///
/// The stuck-`active` bug's residual case: a session whose turn ended is still
/// showing Claude Code's Agent-Teams roster, whose `…s` age field repaints the
/// pane ~1×/second. That perpetual repaint keeps `last_pty` fresh, so it starves
/// BOTH the 30s idle-timeout AND the [`CANCEL_SETTLE`] pty-quiet reconcile — the
/// session is pinned `Active` forever (measured: the real `ipc`, spinner absent
/// 23h). The fix keys the settle off the DURATION the spinner has been absent
/// (tracked in [`StatusDetector::spinner_last_seen`]), which a spinner-free
/// roster ages out regardless of pty ticking.
///
/// Chosen well ABOVE `CANCEL_SETTLE` and the ≤4s capture-skip window so a real
/// turn — which keeps its spinner drawn the ENTIRE time it is interruptible,
/// including a silent think — refreshes `spinner_last_seen` on every capture and
/// never reaches this bound; and a just-started turn (spinner drawn sub-second)
/// is never idled before its spinner is first seen.
const SPINNER_SETTLE: Duration = Duration::from_secs(10);
/// capture-pane skip optimization window.
const SKIP_WINDOW: Duration = Duration::from_secs(2);
/// Upper bound on how stale the live preview tail may get while we are skipping
/// captures for a streaming-`Active` session. The skip keeps the status `Active`
/// cheaply off the PTY heartbeat — but a session whose bytes flow every tick
/// would NEVER re-capture, so its overview tail-preview would freeze for the
/// whole duration of the agent's work (exactly the "Claude is doing things but
/// the card doesn't update" bug). Capping the skip at this staleness forces a
/// re-capture so the hero live-preview keeps refreshing.
///
/// **Adaptive cadence.** This is now the *coarse* upper bound used
/// only when a per-tier bound is not supplied. The detector loop binds the
/// effective staleness to the session's CURRENT cadence tier
/// ([`cadence_for`]) — so a 1s-tier (hot, working) session re-captures within
/// ~1s during streaming, while an idle/waiting session keeps the cheap, coarse
/// bound. See [`should_skip_capture_within`].
pub const MAX_PREVIEW_STALENESS: Duration = Duration::from_secs(4);

// ── adaptive overview-preview cadence ────────────────────────────────────────
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

/// The adaptive cadence for the NEXT tick, by `status` + hotness.
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
/// minutes ago so the first tick never spuriously reads `Active`.
pub const COLD_START_IDLE: Duration = Duration::from_secs(300);

/// The live-status states surfaced to the UI.
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

/// Claude Code `SettingsHook` event kinds. Consumed by the fusion rule in
/// [`StatusDetector::classify`]; fed in by the `/api/_internal/hook` endpoint
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
    /// `Stop` — the MAIN agent's turn ended ⇒ `Idle`.
    Stop,
    /// `SubagentStop` — a Task sub-agent finished. Recorded but NON-DECISIVE for
    /// the turn boundary: it arrives on the parent session's token while the
    /// main agent keeps working, so it must NOT end the main turn (see
    /// [`TurnState::turn_end`]).
    SubagentStop,
}

impl HookEvent {
    /// Parse the `event` field of an `/api/_internal/hook` POST body. Accepts
    /// the snake_case wire form supermux's hook command emits
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
/// (the turn state machine — the core reliability win). Unlike the old
/// single "last hook" `(Instant, HookEvent)`, this remembers each event TYPE's
/// most recent time independently, so a `PreToolUse` followed by a long silent
/// think still has a `turn_start` newer than any `turn_end` — keeping the
/// session `Active` for the whole turn rather than expiring 3s after the last
/// tool call.
///
/// Built in [`crate::state::AppState`] from the per-session per-event timestamp
/// map and passed *into* [`StatusDetector::detect`] so the classifier stays a
/// pure function of its inputs (golden-testable). All fields are
/// `Option<Instant>` because a session may not have seen every event yet.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
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

    /// `turn_end` = newest main-thread `Stop` only.
    ///
    /// `SubagentStop` is deliberately EXCLUDED. A Task subagent shares the
    /// parent session's token (subagents carry the parent `session_id` with no
    /// per-subagent identifier — anthropics/claude-code#7881), so its
    /// `SubagentStop` is POSTed on the MAIN session and folded into
    /// `self.subagent_stop`. If it counted as a turn end, a single subagent
    /// finishing while the main agent is still working would satisfy
    /// `turn_end ≥ turn_start` and flip the card to `Idle` ("finished")
    /// mid-turn — the false-finished / Active↔Idle flap that plagues
    /// multi-agent workflows and Agent-Team leads (a burst of `SubagentStop`s
    /// makes it long-lived, not a blip). Only the main agent's own `Stop` ends
    /// the main turn. The `subagent_stop` slot is still RECORDED (it is read by
    /// `tests/hook_auth_scope.rs` and is available for future subagent-activity
    /// surfacing) but is non-decisive for the turn boundary.
    fn turn_end(&self) -> Option<Instant> {
        self.stop
    }

    /// The newest of ALL turn-relevant hooks (start/end/notif), if any.
    fn newest(&self) -> Option<Instant> {
        [self.turn_start(), self.turn_end(), self.notification]
            .into_iter()
            .flatten()
            .max()
    }

    /// Classify purely from the turn timestamps, when the newest is within
    /// [`TURN_SAFETY`]:
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
/// pure function of its inputs (single source of truth).
pub struct StatusDetector {
    last_status: Status,
    /// The session's provider, fixed for its lifetime. Selects the capture
    /// heuristics: `"codex"` classifies off Codex's TUI (its own working footer
    /// / selector prompts), everything else off the Claude banks. Empty =
    /// generic/Claude (the cold-start + every existing test default).
    provider: String,
    /// Instant the `esc to interrupt` spinner (ACTIVE_BANK) was last seen in a
    /// capture, or `None` if it has not been seen in this detector's lifetime.
    /// Updated on every [`classify`](Self::classify). This makes "how long has
    /// the spinner been continuously absent" a first-class signal that does NOT
    /// depend on pty bytes — so the [`SPINNER_SETTLE`] settle can flip a
    /// held-`Active` session back to `Idle` even while a ticking background pane
    /// (an Agent-Teams roster) keeps `last_pty` perpetually fresh.
    spinner_last_seen: Option<Instant>,
    /// Instant this detector began observing the session (server start /
    /// first-seen). It marks the window in which a genuinely-active MAIN turn
    /// WOULD have drawn its `esc to interrupt` spinner. The step-1 reconcile
    /// keys its spinner-NEVER-seen settle off this wall-clock rather than pty
    /// silence: a swarm LEAD whose subagents POST PreToolUse/PostToolUse hooks
    /// on the parent session keeps `turn_start` fresh (→ `classify()` = Active)
    /// while a per-second roster repaint keeps `last_pty` fresh — so neither the
    /// turn machine nor the pty-quiet gate ever settles it. `watching_since` is
    /// immune to both: once we have watched ≥ [`SPINNER_SETTLE`] without EVER
    /// seeing the spinner, an idle-at-prompt lead (spinner absent the whole time)
    /// settles, while a just-restarted detector waits out the window so a real
    /// main turn's spinner has time to draw and take the seen path instead.
    watching_since: Instant,
}

impl Default for StatusDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl StatusDetector {
    /// Cold-start a detector. Begins `Unknown`; the heartbeat it will be fed on
    /// the first tick is the cold-start sentinel ([`AppState::last_pty`] returns
    /// `now - 5min` until the PTY reader records a real byte), so the first tick
    /// reads `Unknown` rather than a spurious `Active`/`Idle`.
    ///
    /// [`AppState::last_pty`]: crate::state::AppState::last_pty
    pub fn new() -> Self {
        Self {
            last_status: Status::Unknown,
            provider: String::new(),
            spinner_last_seen: None,
            watching_since: Instant::now(),
        }
    }

    /// Cold-start a detector bound to a specific `provider`. The detector loop
    /// uses this so a Codex session is classified off Codex's TUI rather than
    /// the Claude capture banks (whose `approve` token false-matches Codex's
    /// auto-reviewer "approved" scrollback → a constant false "needs input").
    pub fn for_provider(provider: &str) -> Self {
        Self {
            last_status: Status::Unknown,
            provider: provider.to_string(),
            spinner_last_seen: None,
            watching_since: Instant::now(),
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
    ///   sentinel until the PTY reader wires up).
    /// * `turn` — the per-session [`TurnState`] (the newest instant of each
    ///   turn-relevant hook). The PRIMARY signal: a turn in progress reads
    ///   `Active` for the whole turn, even during a silent think.
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
        // The DEFAULT-FALSE entry: no background-subagent signal. Every existing
        // caller (and every golden fixture) keeps this exact behavior — a session
        // with no live workflow settles exactly as before.
        self.detect_with_subagents(capture, last_pty, turn, has_hooks, false)
    }

    /// [`detect`](Self::detect) with the background-workflow signal threaded in.
    ///
    /// * `subagents_live` — is a BACKGROUND workflow provably running right now (a
    ///   `subagents/agent-*.jsonl` append or an open subagent hook within
    ///   `SUBAGENT_LIVE_WINDOW`, per [`crate::state::AppState::subagents_live`])?
    ///   A DEFAULT-FALSE input: it only ever PREVENTS the spinner-absence settle
    ///   from downgrading a `turn_start > turn_end` (or held-) `Active` to `Idle`,
    ///   so a session whose main agent returned to its prompt while its subagents
    ///   keep working stays `Active` instead of reading done/idle. False for every
    ///   session with no live subagent — so a plain idle Claude session still
    ///   settles (the stuck-`active` fix is intact) and calling this with `false`
    ///   is identical to [`detect`](Self::detect) (every golden fixture passes
    ///   `false`). It is deliberately NOT a positive `Active` signal: it can only
    ///   hold an already-`Active` turn, never manufacture one, because its ground
    ///   truth (a live subagent) is precisely the thing the main spinner cannot
    ///   distinguish from a dead one. The status tick uses this form with
    ///   [`crate::state::AppState::subagents_live`].
    pub fn detect_with_subagents(
        &mut self,
        capture: &str,
        last_pty: Instant,
        turn: TurnState,
        has_hooks: bool,
        subagents_live: bool,
    ) -> Status {
        let status = self.classify(capture, last_pty, turn, has_hooks, subagents_live);
        self.last_status = status;
        status
    }

    /// Whether a held-`Active` session should settle to `Idle` on SUSTAINED
    /// absence of the `esc to interrupt` spinner (ACTIVE_BANK) — the one signal
    /// Claude keeps drawn for the WHOLE of an interruptible turn (incl. a silent
    /// think), so a prolonged absence means the turn is over. Decoupled from pty
    /// silence on purpose: a background Agent-Teams roster repaints the pane
    /// every second (keeping `last_pty` fresh) yet carries no spinner, so
    /// spinner-absence — not pty-quiet — is the signal that survives a ticking
    /// pane.
    ///
    /// * `spinner` — this tick's ACTIVE_BANK match. A present spinner is a
    ///   genuine running turn → never settle.
    /// * `capture` must be non-empty: a blank/cleared pane (cold start, a crash
    ///   that wiped the pane) HOLDS the current status rather than forcing a
    ///   premature Idle (the `silent_think_empty_capture_stays_active` invariant).
    /// * once a spinner has EVER been seen, "sustained" is `spinner_last_seen`
    ///   older than [`SPINNER_SETTLE`]. When it has NEVER been seen (`None`),
    ///   `if_unseen` decides: the turn-machine branch passes the pty-quiet
    ///   ([`CANCEL_SETTLE`]) gate OR-ed with the roster-proof watching wall-clock
    ///   (`watching_since.elapsed() >= SPINNER_SETTLE`) — the pty-quiet disjunct
    ///   still settles a single-Esc cancel / crash over a quiet pty, and the
    ///   watching disjunct additionally settles a swarm LEAD whose subagent hooks
    ///   pin `turn_start` Active while its main agent is idle at the prompt (no
    ///   spinner ever drawn — the live `ipc`) over a ticking roster the pty-quiet
    ///   gate can never trip; a just-started turn (pty still echoing, within the
    ///   watch window) has both disjuncts false and is NOT idled. The held-`Active`
    ///   (step-5, stale-hook) fallback passes `true`, since a hold over a
    ///   bank-silent, still-ticking roster has no fresh turn to protect and must
    ///   settle.
    fn spinner_absent_settled(&self, spinner: bool, capture: &str, if_unseen: bool) -> bool {
        !spinner
            && !capture.trim().is_empty()
            && self
                .spinner_last_seen
                .map_or(if_unseen, |t| t.elapsed() >= SPINNER_SETTLE)
    }

    fn classify(&mut self, capture: &str, last_pty: Instant, turn: TurnState, has_hooks: bool, subagents_live: bool) -> Status {
        // ── spinner-last-seen bookkeeping ────────────────────────────────────
        // Compute the ACTIVE_BANK (`esc to interrupt`) match ONCE and stamp the
        // instant it was last seen. This is the pty-independent clock the
        // sustained-absence settle below keys off (see `spinner_absent_settled`
        // + `SPINNER_SETTLE`). Done before any early return so the timestamp is
        // maintained on every tick regardless of which branch decides.
        let spinner = ACTIVE_BANK.is_match(capture);
        if spinner {
            self.spinner_last_seen = Some(Instant::now());
        }

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

        // ── 0b. STARTUP WEDGE pre-emption ────────────────────────────────────
        // A session parked on a startup gate — the workspace-trust dialog, the
        // custom-API-key gate, the first-run wizard, codex's hooks review — is
        // blocked on a human before it has run anything at all. It reached this
        // classifier reading `Starting` and then `Idle` with a green dot, and it
        // would sit there forever: no hook has fired (there is no turn), and the
        // wizard's screens carry none of the tokens in WAITING_BANK.
        //
        // Pre-empted rather than banked, for the same reason the interrupt
        // marker above is: the trust gate can also appear MID-SESSION (2.1.232+,
        // on entering a nested git repo), and there the turn state machine holds
        // `Active` for the whole TURN_SAFETY window over a screen that is doing
        // nothing but waiting. The tokens are the gates' own titles and appear
        // nowhere else (`pty_state::WEDGES`).
        if super::pty_state::startup_wedge(capture).is_some() {
            return Status::Waiting;
        }

        // ── 0c. the OAuth login dialog ───────────────────────────────────────
        // `/login` is pty-only and hook-silent: no `Notification` fires for it,
        // and it is usually reached FROM a turn that died on a 401 — so the turn
        // state machine below sees `turn_start > turn_end` and pins Active for
        // the full TURN_SAFETY window. The result, verified live, is a session
        // parked on `Paste code here if prompted > ` wearing a busy spinner (or,
        // once the window lapses, a green Idle dot) while it is in fact the most
        // blocked a session can be — nothing at all happens until a human pastes
        // a credential into it.
        //
        // This pre-empts the turn machine for the same reason the interrupt
        // marker above does: the screen is unambiguous and the hooks are not
        // going to say anything. Provider-agnostic on purpose — codex prints its
        // own device-auth screens, which `super::login::read_provider_auth`
        // reads, so a session parked on one of those has an honest dot too.
        if super::login::read_login(capture).is_some()
            || super::login::read_provider_auth(capture).is_some()
        {
            return Status::Waiting;
        }

        // ── 0d. the PAUSED consent modals ────────────────────────────────────
        // `Session paused` — Claude Code stopped the turn on a consent question
        // (spend usage credits? switch models after a safeguard flagged the
        // message?) and is waiting for an answer with a billing consequence.
        //
        // It needs a pre-emption of its own, and it is the hardest of the four to
        // see: the turn has NOT ended, so no `Stop` fires and the machine below
        // holds `Active` for the whole TURN_SAFETY window; then the window lapses
        // and the banks take over, and the banks see a screen with no spinner and
        // no prompt token on it — a green `Idle` dot over a session that will sit
        // there until somebody answers (catalog `limit.overage_consent_dialog`,
        // `err.refusal_fallback_dialog`: "the session sits paused while supermux
        // shows Idle"). The screen itself is unambiguous, so it decides.
        if super::pty_state::paused_dialog(capture).is_some() {
            return Status::Waiting;
        }

        // ── 0e. a STALLED stream ─────────────────────────────────────────────
        // `Waiting for API response · will retry in {t} · check your network` —
        // the mirror image of every state above it. Nothing is blocked and
        // nobody is being asked anything: the request went out, no bytes came
        // back, and CC has already scheduled the retry. The turn is STILL LIVE.
        //
        // Pre-empted because the pty goes SILENT while a stall waits, which is
        // the one thing the heartbeat below reads as "finished": the turn machine
        // eventually lapses, `IDLE_BANK` finds nothing to contradict it, and the
        // session goes green under a user who then walks away from a turn that
        // was about to resume (catalog `err.stream_stalled`).
        if super::pty_state::is_stalled(capture) {
            return Status::Active;
        }

        // ── 1. hook TURN STATE MACHINE (the multi-signal apex) ───────────────
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
            // ── 1b. CANCEL / INTERRUPT reconcile (the stuck-`active` fix) ─────
            // A turn-machine `Active` means `turn_start > turn_end`: a turn began
            // and no `Stop` hook has ended it. But a CANCEL — the chat/Grok "Stop"
            // control, or a bare Esc in the composer — delivers a single `Escape`
            // into the pty, and Claude Code interrupts the turn WITHOUT emitting a
            // `Stop` hook. So `turn_end` never advances and this branch would pin
            // `Active` for the whole TURN_SAFETY (15 min) window over a session the
            // terminal shows back at its idle `❯` composer (the reported bug: the
            // roster tile + header dot stay busy long after the pty went idle).
            //
            // Reconcile against the pty ground truth. For a hooked Claude session
            // the authoritative "still working" signal is the `esc to interrupt`
            // spinner footer (ACTIVE_BANK): Claude keeps it in view the ENTIRE
            // time a turn is interruptible, including a silent think between tool
            // calls. Its ABSENCE over a settled-quiet pty already means the turn
            // is over — regardless of WHICH idle screen is showing. So key off the
            // absence of the spinner, not the presence of one specific idle glyph.
            //
            // The old gate additionally required `IDLE_BANK` (a bare `❯`/`$`
            // prompt or a completed `✻ … for Ns` spinner). That is an over-narrow
            // proxy for "screen at rest": the modern boxed composer `│ >  │`, a
            // `⎿ Interrupted by user` cancel screen, frozen crash output, and a
            // scrolled/emptied tail carry NONE of those glyphs, so a no-`Stop`
            // turn stayed pinned Active for the full TURN_SAFETY (15 min) window
            // (the residual reported bug). Dropping that clause settles ALL those
            // cases within ~CANCEL_SETTLE.
            //
            // The settle keys off SUSTAINED spinner-absence, not pty silence, so
            // a ticking background roster cannot defeat it (see
            // `spinner_absent_settled` + SPINNER_SETTLE). Guards keep it safe:
            //   * `!spinner` — a genuine running turn (incl. silent think) still
            //     shows its spinner → settle skipped → stays Active.
            //   * spinner absent long enough — once a spinner has been seen this
            //     turn, it must have been gone ≥ SPINNER_SETTLE; when it has NOT
            //     yet been seen (`spinner_last_seen == None`), settle iff EITHER
            //     the pty has settled quiet (`last_pty.elapsed() >= CANCEL_SETTLE`,
            //     the original single-Esc-cancel / crash gate) OR we have been
            //     WATCHING this session ≥ SPINNER_SETTLE (`watching_since`, a
            //     roster-proof wall-clock the per-second Agent-Teams roster repaint
            //     cannot refresh). The watching-clock disjunct is the ADDED case:
            //     it widens the settle to a swarm LEAD whose subagents' PreToolUse/
            //     PostToolUse hooks (POSTed on the shared parent token) keep
            //     `turn_start` fresh → `classify()` = Active, while a per-second
            //     roster repaint keeps `last_pty` fresh so the pty-quiet gate never
            //     trips (the live stuck `ipc`, main idle at its prompt, no spinner
            //     EVER drawn). A genuinely-active MAIN turn keeps its `esc to
            //     interrupt` spinner in view the ENTIRE time, so it would have set
            //     `spinner_last_seen` within a tick and taken the seen
            //     (`t.elapsed() >= SPINNER_SETTLE`) path above; the still-echoing
            //     turn START (pty NOT yet quiet) within the watch window is still
            //     protected — both disjuncts are false, so it is never idled early.
            //   * non-empty capture — a truly blank capture (cold start, or a
            //     crash that cleared the pane) HOLDS the current status rather
            //     than forcing a premature Idle (matches the codex cold-start
            //     guard + the `silent_think_empty_capture_stays_active_after_settle`
            //     invariant).
            //
            // The Esc-Esc rewind prompt is already handled earlier by
            // INTERRUPT_MARKER (→ Waiting); this covers the single-Esc cancel,
            // crash, and lost-`Stop`, whose screens are ordinary at-rest tails.
            // `!subagents_live`: a background workflow provably running right now
            // (a subagent transcript appended / an open subagent hook within
            // SUBAGENT_LIVE_WINDOW) is the ONE thing the main spinner cannot tell
            // from a dead turn — so when it IS live, do NOT settle this
            // `turn_start > turn_end` Active to Idle. This is what keeps a session
            // whose main agent returned to its prompt (subagent tool hooks keep
            // `turn_start` fresh here) reading WORKING while its subagents churn.
            // Default-false keeps the stuck-`active` `ipc` case (subagents long
            // done → not live) settling exactly as before.
            if s == Status::Active
                && !subagents_live
                && self.spinner_absent_settled(
                    spinner,
                    capture,
                    last_pty.elapsed() >= CANCEL_SETTLE
                        || self.watching_since.elapsed() >= SPINNER_SETTLE,
                )
            {
                return Status::Idle;
            }
            return s;
        }

        // ── 2. capture-pane regex bank ───────────────────────────────────────
        // Codex has NO supermux hooks (step 1 always None for it), so it relies
        // entirely on the capture — but its TUI is NOT Claude's. Classify it off
        // Codex-specific markers and NEVER the Claude banks: Codex's auto-reviewer
        // prints informational scrollback like "✔ Auto-reviewer approved codex to
        // run …", whose "approved" tripped the Claude WAITING_BANK `approve` token
        // → a constant false "needs your input" (the reported bug). Codex's real
        // states (captured live from codex 0.144.3):
        //   working → `◦ Working (Ns • esc to interrupt)`         → Active
        //   waiting → a `› N.` selector / "Press enter to confirm" → Waiting
        //   else    → Idle (positively — see below)
        if self.provider == "codex" {
            if CODEX_ACTIVE_BANK.is_match(capture) {
                return Status::Active;
            }
            if CODEX_WAITING_BANK.is_match(capture) {
                return Status::Waiting;
            }
            // Codex ALWAYS shows `esc to interrupt` while a turn runs, so the
            // ABSENCE of it (with no selector) is a reliable REST signal → Idle.
            // Crucially we do NOT fall through to the PTY heartbeat below: Codex's
            // idle TUI emits periodic (often invisible) repaint bytes, and the
            // heartbeat would misread those as `Active` — flapping the spinner
            // on↔off at rest (the reported bug; Claude never flaps because its
            // hooks already suppress the heartbeat). An empty capture (still
            // booting, nothing drawn) holds the current status rather than forcing
            // a premature Idle, matching the non-codex cold-start guard.
            return if capture.trim().is_empty() {
                self.last_status
            } else {
                Status::Idle
            };
        } else {
            if spinner {
                return Status::Active;
            }
            if WAITING_BANK.is_match(capture) {
                return Status::Waiting;
            }
            if IDLE_BANK.is_match(capture) {
                return Status::Idle;
            }
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
        //
        // CLAUDE-ONLY spinner gate: reaching here at all means the `esc to
        // interrupt` spinner (ACTIVE_BANK) is ABSENT — a working claude already
        // returned Active at step 2's `if spinner { return Active }`. A claude
        // whose spinner is SUSTAINEDLY absent is at rest; its only fresh bytes
        // are a ticking background view (the Agent-Teams roster's per-second
        // timers) or a cursor blink on an idle composer — not the agent working.
        // Without the gate an unwired-hooks claude-swarm lead (has_hooks=false)
        // pins Active forever off that motion (measured: `ipc`, last_pty≈0 for a
        // day). A shell has no spinner (a busy `npm build` shows none and its
        // fresh bytes ARE the work), codex already returned above, and kimi keeps
        // the raw heartbeat — so the gate is claude-only.
        let silent = last_pty.elapsed();
        if !has_hooks && silent < PTY_ACTIVE_WINDOW {
            let claude_roster_tick_at_rest = self.provider == "claude"
                && !subagents_live
                && self.spinner_absent_settled(
                    spinner,
                    capture,
                    self.watching_since.elapsed() >= SPINNER_SETTLE,
                );
            if !claude_roster_tick_at_rest {
                return Status::Active;
            }
            // else fall through → idle-timeout / step-5 sustained-absence settle → Idle.
        }
        // ── 4. idle timeout ──────────────────────────────────────────────────
        // Only downgrade a session we have already classified. A never-seen
        // (`Unknown`) session stays `Unknown` until a positive signal (capture
        // marker or a real PTY byte) arrives — without this guard a cold-started
        // server's first tick would read `Idle` off the cold-start sentinel,
        // contradicting the rule "observe Unknown until capture confirms…".
        if silent >= IDLE_TIMEOUT && self.last_status != Status::Unknown {
            return Status::Idle;
        }

        // ── 5. no decisive signal → hold the current status ──────────────────
        // …EXCEPT the stuck-`active` residual: a session held `Active` from a
        // turn that ended long ago (hooks now stale → the turn machine returned
        // None above), still showing a bank-silent screen whose only motion is a
        // per-second Agent-Teams roster repaint. That repaint keeps `last_pty`
        // fresh, starving both the 30s idle-timeout (step 4) and the pty-quiet
        // CANCEL_SETTLE reconcile — so it would hold `Active` forever (the real
        // `ipc`: spinner absent 23h). Settle it on SUSTAINED spinner-absence,
        // which the ticking roster ages out regardless of pty motion. `if_unseen
        // = true`: a stale-hook hold has no fresh turn to protect, so a session
        // that never showed a spinner in this detector's life (e.g. restored
        // `Active` after a restart) settles too. The non-empty-capture guard
        // inside still holds a blank pane at its current status.
        if self.last_status == Status::Active
            && !subagents_live
            && self.spinner_absent_settled(spinner, capture, true)
        {
            return Status::Idle;
        }
        self.last_status
    }
}

/// Should the 2s tick skip the `tmux capture-pane` shell-out?
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

/// Tier-bounded variant of [`should_skip_capture`].
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
/// canonical preview source) never carries stray escapes.
static ANSI_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());

/// ANSI-strip `raw` and keep only its last [`CAPTURE_LINES`] lines — the exact
/// payload written to `session_runtime.last_capture` and classified by
/// [`StatusDetector::detect`].
///
/// Trailing blank lines are dropped first: `tmux capture-pane` pads the capture
/// to the full pane height, and those blanks would otherwise crowd the live
/// content out of the 6-line tile preview and push a bare prompt off
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

// ── the regex bank ───────────────────────────────────────────────────────────
//
// Patterns are the literal strings ported verbatim from the spec. The IDLE bank adds
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
/// most captured frames), and the `running...` / `reading N
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

/// CODEX ACTIVE marker: Codex's working footer is `◦ Working (Ns • esc to
/// interrupt)`, pinned the whole time a turn runs. Anchored on `esc to interrupt`
/// (Codex's, like Claude's, phrasing) — note the `/model` etc. selectors show
/// `esc to go back`, NOT `esc to interrupt`, so they never false-match Active.
static CODEX_ACTIVE_BANK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)esc to interrupt").unwrap());

/// CODEX WAITING marker: a GENUINE interactive prompt — a numbered selector whose
/// rows start with Codex's `›` cursor (`› 1. …`), or the selector's
/// "Press enter to confirm" / a command-approval "Do you want to …" line.
/// Deliberately does NOT include a bare `approve`: Codex's auto-reviewer emits
/// "approved" as passive scrollback, which is NOT a prompt and must not read as
/// needs-input (the exact false positive this fix removes).
static CODEX_WAITING_BANK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?im)^\s*›\s*\d+\.|press enter to confirm|do you want to (run|proceed|allow)")
        .unwrap()
});

/// The Codex COMPOSER'S model footer, e.g. `gpt-5.6-sol high · /opt/projects/x`.
/// A `gpt-<model>` token followed by Codex's `·` separator on the same line — the
/// footer a READY, empty composer draws under its `›` prompt. Distinct from
/// [`IDLE_BANK`]'s `gpt-\S+ · ~` (which anchors on the home-dir shell prompt); a
/// live composer's footer carries the working directory, not a `~` path.
static CODEX_COMPOSER_FOOTER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?im)^\s*gpt-\S+.*·").unwrap());

/// True when `screen` shows a Codex WAITING prompt — a numbered `› N.` selector,
/// a "Press enter to confirm", or a command-approval "Do you want to …". Exposed
/// for the send-guard so a Codex picker/approval stays NON-ready (and never a
/// bare `›`). Mirrors [`CODEX_WAITING_BANK`].
pub(crate) fn is_codex_waiting(screen: &str) -> bool {
    CODEX_WAITING_BANK.is_match(screen)
}

/// True when `screen` shows a READY, empty Codex COMPOSER — the placeholder
/// "Ask Codex to do anything" and/or the composer's model footer
/// ([`CODEX_COMPOSER_FOOTER`]), neither of which a Codex resume-picker or
/// folder-trust dialog draws. The send-guard ORs this in because Codex's `›`
/// composer is invisible to the Claude `❯` checks in `agent_ui_visible`.
/// Deliberately NOT keyed on a bare `›`: a `› N.` numbered selector is
/// [`is_codex_waiting`] and MUST stay non-ready, so a waiting screen is rejected
/// here even if a footer lingers.
pub(crate) fn is_codex_ready_composer(screen: &str) -> bool {
    !is_codex_waiting(screen)
        && (screen.to_ascii_lowercase().contains("ask codex to do anything")
            || CODEX_COMPOSER_FOOTER.is_match(screen))
}

/// USER-INTERRUPT marker: the literal prompt Claude Code shows after the user
/// presses Esc twice mid-turn. Unique enough to pre-empt the turn state
/// machine (Claude Code doesn't emit a `Stop` hook for user-interrupts, so the
/// machine would otherwise pin Active for the full TURN_SAFETY window).
static INTERRUPT_MARKER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)interrupted.*what should claude do").unwrap());

/// IDLE markers: a COMPLETED spinner or a bare shell/agent prompt.
///
/// The persistent status-bar / mode indicators `⏵⏵`, `bypass permissions`, and
/// `plan mode` were REMOVED (the primary smoking gun): those are shown
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

    /// Classify with a fresh Codex-bound detector (neutral pty so the bank
    /// decides). `neutral_pty` is >PTY_ACTIVE_WINDOW old, so a non-matching
    /// capture falls through to Idle-timeout territory, not the heartbeat.
    fn fresh_codex(cap: &str) -> Status {
        StatusDetector::for_provider("codex").detect(
            cap,
            neutral_pty(),
            TurnState::default(),
            false,
        )
    }

    // Codex TUI strings below are captured LIVE from codex-cli 0.144.3.

    #[test]
    fn codex_auto_review_approved_scrollback_is_not_waiting() {
        // THE BUG: Codex's auto-reviewer prints these as passive scrollback all
        // turn long. Under the Claude banks the "approved" tripped WAITING_BANK's
        // `approve` token → a constant false "needs your input". A Codex-bound
        // detector must NOT read Waiting off them.
        let cap = "\
✔ Auto-reviewer approved codex to run nl -ba sample1.txt this time
⚠ Automatic approval review approved (risk: low, authorization: unknown): Auto-review returned a low-risk allow decision.

› Implement {feature}
  gpt-5.6-sol default · /tmp/cxprobe";
        assert_ne!(fresh_codex(cap), Status::Waiting, "auto-review logs are not a prompt");
        // And the SAME text still trips the Claude bank (proving the fix is the
        // provider branch, not a change to the shared bank).
        assert_eq!(fresh(cap), Status::Waiting);
    }

    #[test]
    fn codex_working_footer_is_active() {
        let cap = "\
• I'll take a fresh inventory, read every file found, and summarize each one.

◦ Working (6s • esc to interrupt)

› Implement {feature}
  gpt-5.6-sol default · /tmp/cxprobe";
        assert_eq!(fresh_codex(cap), Status::Active);
    }

    #[test]
    fn codex_selector_prompt_is_waiting() {
        // A genuine interactive prompt (the /model selector). `esc to go back`
        // must NOT read Active (it's not `esc to interrupt`).
        let cap = "\
  Select Model and Effort
› 1. gpt-5.6-sol (current)  Latest frontier agentic coding model.
  2. gpt-5.6-terra          Balanced agentic coding model for everyday work.
  Press enter to confirm or esc to go back";
        assert_eq!(fresh_codex(cap), Status::Waiting);
    }

    #[test]
    fn codex_idle_with_fresh_pty_bytes_stays_idle_not_active() {
        // THE FLAP BUG: Codex has no hooks, and its idle TUI emits periodic
        // repaint bytes, so `last_pty` stays fresh at rest. The raw heartbeat
        // (`!has_hooks && silent < PTY_ACTIVE_WINDOW → Active`) therefore flipped
        // the spinner on↔off while Codex did nothing. A Codex-bound detector must
        // read Idle off the resting composer regardless of fresh bytes.
        let cap = "› Explain this codebase\n  gpt-5.6-sol default · /x · Main";
        let mut d = StatusDetector::for_provider("codex");
        // fresh bytes (just now) — the exact condition that used to force Active.
        assert_eq!(d.detect(cap, Instant::now(), TurnState::default(), false), Status::Idle);
        // A hookless SHELL with the same fresh bytes (and a capture that matches
        // no bank) still uses the heartbeat → Active. Proves the fix is scoped to
        // Codex, not a global heartbeat removal.
        let mut sh = StatusDetector::new();
        assert_eq!(
            sh.detect("building the project", Instant::now(), TurnState::default(), false),
            Status::Active,
        );
    }

    #[test]
    fn codex_idle_composer_is_not_waiting_or_active() {
        // At rest: the bare composer + status bar, no Working line, no selector.
        // Not Active, not Waiting — resolves via the heartbeat/idle-timeout
        // fallback (here neutral_pty → Idle), never a false needs-input.
        let cap = "› Implement {feature}\n  gpt-5.6-sol default · /tmp/cxprobe";
        let s = fresh_codex(cap);
        assert_ne!(s, Status::Waiting);
        assert_ne!(s, Status::Active);
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
        // Primary smoking gun: the persistent bottom status-bar mode
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
        // Multi-signal apex: a fresh hook event outranks the
        // regex bank and the pty heartbeat. Each capture below carries a marker
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
        // The headline fix: a UserPromptSubmit with NO subsequent tool
        // call and NO PTY bytes (the model is thinking silently) must read Active.
        // Empty capture + neutral heartbeat would otherwise hold/idle.
        let mut d = StatusDetector::new();
        let turn = turn_with(HookEvent::UserPromptSubmit, Duration::from_secs(20));
        assert_eq!(d.detect("", neutral_pty(), turn, true), Status::Active);
    }

    #[test]
    fn pre_tool_then_long_silent_think_stays_active() {
        // A PreToolUse followed by a 40s silent think (no PostToolUse/Stop, no new
        // bytes) — the old 3s fast-path expired here and the detector wrongly read
        // the status bar as Idle. The turn state machine keeps it Active.
        //
        // A GENUINE interruptible turn keeps its `esc to interrupt` spinner footer
        // in view the entire time (that is exactly the ground truth the
        // spinner-absence reconcile trusts), so the realistic silent-think capture
        // carries it above the mode bar. ACTIVE_BANK matches → the CANCEL_SETTLE
        // reconcile is skipped → the turn stays Active even over a quiet pty. (A
        // capture with NO footer over a quiet pty means the turn is over — that is
        // the stuck-`active` case the reconcile now settles.)
        let mut d = StatusDetector::new();
        let turn = turn_with(HookEvent::PreToolUse, Duration::from_secs(40));
        let cap = "✻ Thinking… (esc to interrupt · 42s)\n⏵⏵ accept edits on (shift+tab to cycle)";
        assert_eq!(d.detect(cap, neutral_pty(), turn, true), Status::Active);
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

    /// The idle composer a single-Esc cancel leaves on screen: a `⎿ Interrupted`
    /// line and the bare `❯` prompt, NO spinner / `esc to interrupt`. This is what
    /// the chat/Grok "Stop" produces (it delivers one `Escape`), distinct from the
    /// Esc-Esc rewind prompt handled by INTERRUPT_MARKER.
    const CANCELLED_COMPOSER: &str = "\
● Editing the configuration file.
  ⎿ Interrupted by user
╭──────────────────────────────────────────────╮
│ >                                             │
╰──────────────────────────────────────────────╯
❯ ";

    #[test]
    fn cancelled_turn_settles_to_idle_when_pty_shows_idle_prompt() {
        // THE server half of the stuck-`active` bug. A chat/Grok turn is cancelled
        // via "Stop": a single Esc interrupts it, Claude Code emits NO `Stop` hook,
        // so the turn machine still sees `turn_start > turn_end` and would pin
        // Active for the full TURN_SAFETY window. But the pty is back at its idle
        // composer and has gone quiet → reconcile to Idle so the roster dot + header
        // are honest, mirroring the client's turnStart reconcile.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        // A turn is "in progress" per the hooks: PreToolUse fired, no Stop.
        let turn = turn_with(HookEvent::PreToolUse, Duration::from_secs(8));
        // neutral_pty() is 10s quiet — well past CANCEL_SETTLE.
        assert_eq!(
            d.detect(CANCELLED_COMPOSER, neutral_pty(), turn, true),
            Status::Idle,
            "a cancelled turn (no Stop hook) over an idle composer must settle to Idle"
        );
    }

    /// The modern idle screen a cancel/finish leaves with NO trailing bare `❯`:
    /// just the rounded boxed composer. This is the residual stuck-`active` bug —
    /// under the OLD reconcile (which additionally required IDLE_BANK) none of
    /// `❯$` / `$ ` / a completed spinner is present, so it stayed pinned Active.
    const BOXED_COMPOSER: &str = "\
╭──────────────────────────────────────────────╮
│ >                                             │
╰──────────────────────────────────────────────╯
  ? for shortcuts";

    /// A cancel that leaves `⎿ Interrupted by user` above the boxed composer, again
    /// with NO trailing bare `❯` (the real modern shape of the single-Esc cancel).
    const INTERRUPTED_BOXED: &str = "\
● Editing the configuration file.
  ⎿ Interrupted by user
╭──────────────────────────────────────────────╮
│ >                                             │
╰──────────────────────────────────────────────╯
  ? for shortcuts";

    /// Frozen partial tool output left by a crash/kill mid-turn: no spinner, no
    /// idle glyph at all — just the last drawn scrollback.
    const FROZEN_TOOL_OUTPUT: &str = "\
● Bash(cargo build)
  ⎿ Compiling supermux-server v0.5.0
     Compiling tokio v1.40.0";

    #[test]
    fn cancelled_boxed_composer_without_bare_prompt_settles_to_idle() {
        // The headline residual bug: a no-`Stop` turn whose at-rest screen is the
        // modern boxed composer with NO trailing bare `❯`. The old gate required a
        // POSITIVE idle glyph (IDLE_BANK) and so pinned this Active for 15 min; the
        // spinner-absence reconcile settles it to Idle within CANCEL_SETTLE.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        let turn = turn_with(HookEvent::PreToolUse, Duration::from_secs(8));
        assert_eq!(
            d.detect(BOXED_COMPOSER, neutral_pty(), turn, true),
            Status::Idle,
            "a boxed composer with no bare ❯ and no spinner must settle to Idle"
        );
    }

    #[test]
    fn cancelled_interrupted_boxed_composer_settles_to_idle() {
        // `⎿ Interrupted by user` + boxed composer, quiet pty, no spinner ⇒ Idle.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        let turn = turn_with(HookEvent::PreToolUse, Duration::from_secs(8));
        assert_eq!(
            d.detect(INTERRUPTED_BOXED, neutral_pty(), turn, true),
            Status::Idle,
            "an interrupted composer (no spinner) over a quiet pty must settle to Idle"
        );
    }

    #[test]
    fn crashed_frozen_tool_output_settles_to_idle() {
        // A crash/kill mid-turn leaves frozen partial output — no spinner, no idle
        // glyph. Quiet pty + spinner-absence ⇒ Idle (was pinned Active for 15 min).
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        let turn = turn_with(HookEvent::PreToolUse, Duration::from_secs(8));
        assert_eq!(
            d.detect(FROZEN_TOOL_OUTPUT, neutral_pty(), turn, true),
            Status::Idle,
            "frozen crash output with no spinner over a quiet pty must settle to Idle"
        );
    }

    #[test]
    fn fresh_turn_start_is_not_flipped_to_idle_before_spinner_draws() {
        // The turn-START guard: right after UserPromptSubmit the composer may still
        // be on screen for a sub-second gap before Claude draws its spinner, and the
        // pty is actively echoing (fresh bytes). The CANCEL_SETTLE quiet-pty gate
        // must keep such a brand-new turn Active — only a SETTLED-quiet pty is
        // trusted to mean "cancelled".
        let mut d = StatusDetector::new();
        let turn = turn_with(HookEvent::UserPromptSubmit, Duration::from_millis(200));
        assert_eq!(
            d.detect(CANCELLED_COMPOSER, Instant::now(), turn, true),
            Status::Active,
            "a just-started turn with fresh pty bytes must not settle to Idle"
        );
    }

    #[test]
    fn running_turn_with_spinner_stays_active_despite_bare_prompt() {
        // Genuine active detection is preserved: a real running turn keeps its
        // `esc to interrupt` spinner line in view even though the composer's bare
        // `❯` is ALSO on screen (which alone matches the IDLE bank). ACTIVE_BANK
        // matches, so the cancel-reconcile is skipped and the turn stays Active —
        // even with a long-quiet pty (a silent think).
        let cap = "\
✻ Thinking… (esc to interrupt · 3s · ↑ 1.2k tokens)
╭──────────────────────────────────────────────╮
│ >                                             │
╰──────────────────────────────────────────────╯
❯ ";
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        let turn = turn_with(HookEvent::PreToolUse, Duration::from_secs(40));
        assert_eq!(
            d.detect(cap, neutral_pty(), turn, true),
            Status::Active,
            "a spinner in view (esc to interrupt) must keep a quiet-pty turn Active"
        );
    }

    #[test]
    fn silent_think_empty_capture_stays_active_after_settle() {
        // A silent think with an EMPTY capture (nothing drawn yet) and a long-quiet
        // pty must stay Active: the reconcile now downgrades on the ABSENCE of the
        // spinner, but the `!capture.trim().is_empty()` guard holds a blank capture
        // (cold start / cleared pane) at its current status — so an empty screen
        // never triggers it. This is the headline "busy while thinking" behaviour,
        // preserved by the empty-capture guard that replaced the IDLE_BANK match.
        let mut d = StatusDetector::new();
        let turn = turn_with(HookEvent::UserPromptSubmit, Duration::from_secs(20));
        assert_eq!(d.detect("", neutral_pty(), turn, true), Status::Active);
    }

    /// The exact stuck-`ipc` capture: Claude Code's Agent-Teams roster, whose
    /// `…s` age column repaints once a second. No `esc to interrupt` spinner
    /// (the whole team is at rest), and the composer line carries ghost text so
    /// it is not a bare `❯` either — the capture is bank-silent.
    const TICKING_ROSTER: &str = "\
──── View teammates: `tmux -L claude-swarm-4893 a` ─
❯ voeg die samsung 75 alsnog toe, check het bedrag …
  ⏵⏵ bypass permissions on (shift+tab to cycle) ·
  ● main
  ◯ fc-ziggo-a     Je bent fact-check…    1d 0h 6m
  ◯ fc-nieuw       Je bent discovery-…  23h 58m 6s
  ↓ 2 more";

    #[test]
    fn ticking_roster_without_spinner_settles_to_idle_despite_fresh_pty() {
        // (a) THE residual stuck-`active` bug. The turn ended long ago so the
        // hooks are stale (turn.classify == None) and the session is held Active
        // by the step-5 fallback. The roster repaints every second, so `last_pty`
        // is perpetually fresh — the 30s idle-timeout AND the pty-quiet
        // CANCEL_SETTLE reconcile are both starved. A spinner last seen well past
        // SPINNER_SETTLE ago must settle it to Idle EVEN with a fresh pty.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        d.spinner_last_seen = Some(Instant::now() - Duration::from_secs(30));
        assert_eq!(
            d.detect(TICKING_ROSTER, Instant::now(), TurnState::default(), true),
            Status::Idle,
            "a ticking roster with no spinner (turn long over) must settle to Idle"
        );
    }

    #[test]
    fn restored_active_without_spinner_history_settles_to_idle() {
        // The literal `ipc` after a redeploy: the detector is re-seeded `Active`
        // from the persisted row (force), so it has NEVER seen a spinner
        // (spinner_last_seen == None). With stale hooks (step-5) and the ticking,
        // spinner-free roster, the `if_unseen = true` held-Active fallback must
        // still settle it to Idle — there is no fresh turn to protect.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        assert!(d.spinner_last_seen.is_none());
        assert_eq!(
            d.detect(TICKING_ROSTER, Instant::now(), TurnState::default(), true),
            Status::Idle,
            "a restored-Active session that never showed a spinner must settle to Idle"
        );
    }

    #[test]
    fn ticking_roster_with_visible_spinner_stays_active() {
        // (b) Guard: the SAME held-Active session, but this capture DOES carry
        // the `esc to interrupt` spinner (a genuine in-flight turn — a silent
        // think keeps the footer drawn). The spinner refreshes spinner_last_seen
        // THIS tick, so the sustained-absence settle never fires — Active holds,
        // even over a fresh, ticking pty and stale hooks.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        d.spinner_last_seen = Some(Instant::now() - Duration::from_secs(30));
        let cap = "✻ Thinking… (esc to interrupt · 42s)\n⏵⏵ accept edits on (shift+tab to cycle)";
        assert_eq!(
            d.detect(cap, Instant::now(), TurnState::default(), true),
            Status::Active,
            "a visible esc-to-interrupt spinner must keep the session Active"
        );
    }

    #[test]
    fn fresh_turn_start_with_spinner_stays_active() {
        // (c) A genuinely in-flight fresh turn: a recent turn_start hook (turn
        // machine → Active) AND its spinner drawn. `!spinner` is false so the
        // sustained-absence settle is skipped — the turn stays Active.
        let mut d = StatusDetector::new();
        let turn = turn_with(HookEvent::UserPromptSubmit, Duration::from_secs(1));
        let cap = "✻ Working… (esc to interrupt · 1s · ↑ 0.3k tokens)";
        assert_eq!(
            d.detect(cap, Instant::now(), turn, true),
            Status::Active,
            "a fresh turn with its spinner drawn must stay Active"
        );
    }

    #[test]
    fn subagent_stop_with_spinner_stays_active_under_new_settle() {
        // (d) The false-finished invariant survives the spinner-absence settle: a
        // SubagentStop (a Task subagent finishing on the shared session token)
        // does NOT advance turn_end, so the turn machine still reads Active, and
        // the visible spinner keeps spinner_last_seen fresh. The session must NOT
        // read finished.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        let mut turn = TurnState::default();
        turn.apply(Instant::now() - Duration::from_secs(10), HookEvent::PreToolUse);
        turn.apply(Instant::now() - Duration::from_secs(1), HookEvent::SubagentStop);
        assert_eq!(
            d.detect("✻ Working… (esc to interrupt)", neutral_pty(), turn, true),
            Status::Active,
            "a subagent stop with a live spinner must NOT end the turn"
        );
    }

    // ── swarm-lead step-1 reconcile (watching wall-clock) ────────────────────
    // The live stuck `ipc` is a swarm LEAD: its subagents (fc-ziggo-a etc.)
    // share the parent session token, so THEIR PreToolUse/PostToolUse hooks POST
    // on `ipc` and fold into `turn_start` — keeping `turn.classify()` == Active
    // even though the MAIN agent is idle at its prompt and never drew a spinner.
    // That reaches the STEP-1 reconcile (not the step-5 stale-hook branch), whose
    // spinner-NEVER-seen settle now keys off `watching_since` (a wall-clock the
    // per-second roster repaint cannot refresh), not the pty-quiet CANCEL_SETTLE.

    #[test]
    fn swarm_lead_subagent_bumped_active_settles_via_watching_clock() {
        // (a) THE literal live `ipc`. A fresh subagent PreToolUse bumps
        // `turn_start` (turn.classify == Active → step-1 branch), the capture is
        // the spinner-free ticking roster, `last_pty` is perpetually fresh (roster
        // repaint), and the MAIN agent never drew a spinner (spinner_last_seen ==
        // None). With this detector having watched the session longer than
        // SPINNER_SETTLE, the step-1 reconcile settles it to Idle — the old
        // pty-quiet gate could not, because the roster keeps `last_pty` fresh.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        assert!(d.spinner_last_seen.is_none());
        d.watching_since = Instant::now() - (SPINNER_SETTLE + Duration::from_secs(5));
        let turn = turn_with(HookEvent::PreToolUse, Duration::from_millis(200));
        assert_eq!(
            d.detect(TICKING_ROSTER, Instant::now(), turn, true),
            Status::Idle,
            "a swarm lead pinned Active by subagent hooks, main idle (no spinner \
             ever), watched > SPINNER_SETTLE, must settle to Idle despite a fresh pty"
        );
    }

    #[test]
    fn swarm_lead_just_restarted_within_watch_window_stays_active() {
        // (b) The guard on (a): a just-restarted detector (watching_since younger
        // than SPINNER_SETTLE) has NOT yet given a genuinely-active main turn's
        // spinner time to draw. With spinner_last_seen == None and the watch
        // window not yet elapsed, the step-1 reconcile must NOT settle — the turn
        // machine's Active is held until the spinner draws or the window elapses.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        assert!(d.spinner_last_seen.is_none());
        d.watching_since = Instant::now(); // fresh: within the watch window
        let turn = turn_with(HookEvent::PostToolUse, Duration::from_millis(200));
        assert_eq!(
            d.detect(TICKING_ROSTER, Instant::now(), turn, true),
            Status::Active,
            "a just-restarted lead (watched < SPINNER_SETTLE) must hold Active so a \
             real main spinner has time to draw"
        );
    }

    #[test]
    fn swarm_lead_with_visible_spinner_stays_active_over_ticking_pane() {
        // (c) A silent-think guard over the step-1 branch: the SAME subagent-bumped
        // Active turn, but this capture DOES carry the `esc to interrupt` spinner
        // (the main agent is genuinely mid-think). The spinner refreshes
        // spinner_last_seen THIS tick and `!spinner` is false, so the settle never
        // fires — Active holds, even with a fully-elapsed watch window and a fresh,
        // ticking pty.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        d.watching_since = Instant::now() - (SPINNER_SETTLE + Duration::from_secs(60));
        let cap = "✻ Thinking… (esc to interrupt · 8s)\n  ● main\n  ◯ fc-ziggo-a   1d 0h 6m";
        let turn = turn_with(HookEvent::PreToolUse, Duration::from_millis(200));
        assert_eq!(
            d.detect(cap, Instant::now(), turn, true),
            Status::Active,
            "a visible esc-to-interrupt spinner keeps the lead Active regardless of \
             the watch clock"
        );
    }

    #[test]
    fn fresh_turn_start_with_spinner_over_step1_stays_active() {
        // (d) A genuinely in-flight fresh MAIN turn reaching step-1: a recent
        // turn_start (turn machine → Active) AND its spinner drawn. spinner_last_seen
        // is refreshed and `!spinner` is false, so the settle is skipped — Active.
        let mut d = StatusDetector::new();
        d.watching_since = Instant::now() - (SPINNER_SETTLE + Duration::from_secs(5));
        let turn = turn_with(HookEvent::UserPromptSubmit, Duration::from_secs(1));
        let cap = "✻ Working… (esc to interrupt · 1s · ↑ 0.3k tokens)";
        assert_eq!(
            d.detect(cap, Instant::now(), turn, true),
            Status::Active,
            "a fresh main turn with its spinner drawn must stay Active even past the \
             watch window"
        );
    }

    #[test]
    fn swarm_lead_subagent_stop_still_does_not_finish_turn() {
        // (e) The false-finished invariant holds through the new settle: a subagent
        // SubagentStop on the shared token does NOT advance turn_end, so with a
        // still-open turn_start (a later PreToolUse) turn.classify stays Active. A
        // visible spinner keeps spinner_last_seen fresh, so even inside the watch
        // window the lead must NOT read finished.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        d.watching_since = Instant::now() - (SPINNER_SETTLE + Duration::from_secs(5));
        let mut turn = TurnState::default();
        turn.apply(Instant::now() - Duration::from_secs(2), HookEvent::SubagentStop);
        turn.apply(Instant::now() - Duration::from_millis(200), HookEvent::PreToolUse);
        assert_eq!(
            d.detect("✻ Working… (esc to interrupt)", Instant::now(), turn, true),
            Status::Active,
            "a subagent stop under a still-open turn must NOT finish the lead's turn"
        );
    }

    #[test]
    fn subagent_stop_mid_turn_must_not_finish_the_turn() {
        // THE bug: a Task subagent shares the parent session token, so its
        // SubagentStop POSTs on the MAIN session. With turn_end folding in
        // SubagentStop, a subagent finishing while the main agent is still
        // working makes turn_end ≥ turn_start ⇒ the card flips to Idle
        // ("finished") mid-turn. Only the main-thread Stop ends the main turn.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        let mut turn = TurnState::default();
        turn.apply(Instant::now() - Duration::from_secs(10), HookEvent::PreToolUse);
        turn.apply(Instant::now() - Duration::from_secs(1), HookEvent::SubagentStop);
        assert_eq!(
            d.detect("esc to interrupt", neutral_pty(), turn, true),
            Status::Active,
            "a subagent stop with no main Stop must NOT read finished"
        );
    }

    #[test]
    fn parallel_subagent_stops_do_not_finish_the_turn() {
        // A workflow/team lead running several Task subagents at once emits a
        // burst of SubagentStops with no interleaved main PreToolUse. None of
        // them may end the main turn.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        let mut turn = TurnState::default();
        turn.apply(Instant::now() - Duration::from_secs(10), HookEvent::PreToolUse);
        turn.apply(Instant::now() - Duration::from_secs(3), HookEvent::SubagentStop);
        turn.apply(Instant::now() - Duration::from_secs(2), HookEvent::SubagentStop);
        turn.apply(Instant::now() - Duration::from_secs(1), HookEvent::SubagentStop);
        assert_eq!(d.detect("", neutral_pty(), turn, true), Status::Active);
    }

    #[test]
    fn main_stop_after_subagents_is_idle() {
        // The genuine finish still works: after the subagents, the main agent's
        // own Stop is the newest signal ⇒ Idle.
        let mut d = StatusDetector::new();
        d.force(Status::Active);
        let mut turn = TurnState::default();
        turn.apply(Instant::now() - Duration::from_secs(10), HookEvent::PreToolUse);
        turn.apply(Instant::now() - Duration::from_secs(3), HookEvent::SubagentStop);
        turn.apply(Instant::now() - Duration::from_secs(1), HookEvent::Stop);
        assert_eq!(d.detect("", neutral_pty(), turn, true), Status::Idle);
    }

    #[test]
    fn late_subagent_stop_after_main_stop_stays_idle() {
        // Receipt jitter / a converted terminal hook can deliver a SubagentStop
        // AFTER the main Stop. Because SubagentStop is non-decisive (not a
        // turn_start signal), it must NOT resurrect the turn to Active — the
        // main Stop ended it and it stays Idle. (Guards against the rejected
        // "reroute SubagentStop into post_tool" design.)
        let mut d = StatusDetector::new();
        d.force(Status::Idle);
        let mut turn = TurnState::default();
        turn.apply(Instant::now() - Duration::from_secs(10), HookEvent::PreToolUse);
        turn.apply(Instant::now() - Duration::from_secs(5), HookEvent::Stop);
        turn.apply(Instant::now() - Duration::from_secs(1), HookEvent::SubagentStop);
        assert_eq!(d.detect("", neutral_pty(), turn, true), Status::Idle);
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
        // The safety valve: a turn_start older than TURN_SAFETY with no
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
        // Claude cycles the spinner glyph across frames, so every frame
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
        // INVARIANT: `subagent_start` is NOT a turn HookEvent. It drives only the
        // display-only outstanding-subagent count (via apply_payload's string
        // dispatch) and must never enter the TurnState machine, or it would
        // pollute the pure, golden-tested classifier. Keeping it out of HookEvent
        // is what structurally prevents the parallelism signal from ever flipping
        // the turn boundary (and regressing the false-finished fix).
        assert_eq!(HookEvent::from_event_str("subagent_start"), None);
        assert_eq!(HookEvent::from_event_str("SubagentStart"), None);
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

    // ── step-3 PTY-heartbeat spinner gate (claude-only) ──────────────────────
    // The live stuck `ipc` is an unwired-hooks claude-swarm LEAD running raw
    // claude with NO supermux hooks (has_hooks=false) and an EMPTY turn machine
    // (turn.classify == None). It never reaches the step-1 or step-5 settle — it
    // lands on the step-3 PTY heartbeat, where the per-second Agent-Teams roster
    // repaint keeps `last_pty≈0 < PTY_ACTIVE_WINDOW`, pinning Active every tick
    // forever. The gate settles it: reaching the heartbeat means the `esc to
    // interrupt` spinner is ABSENT (a working claude returned Active at step 2),
    // and a claude whose spinner is SUSTAINEDLY absent over fresh roster bytes is
    // at rest. Claude-only: shells (no spinner) and kimi keep the raw heartbeat.

    #[test]
    fn heartbeat_claude_roster_tick_no_spinner_settles_to_idle() {
        // (a) THE literal `ipc`: provider=claude, has_hooks=false, empty turn, the
        // spinner-free ticking roster, last_pty fresh (roster repaint), watched >
        // SPINNER_SETTLE, held Active. The step-3 heartbeat would pin Active off
        // the fresh bytes; the spinner-absence gate lets it fall through to the
        // step-5 sustained-absence settle → Idle.
        let mut d = StatusDetector::for_provider("claude");
        d.force(Status::Active);
        d.watching_since = Instant::now() - Duration::from_secs(30);
        assert!(d.spinner_last_seen.is_none());
        assert_eq!(
            d.detect(TICKING_ROSTER, Instant::now(), TurnState::default(), false),
            Status::Idle,
            "an unwired-hooks claude lead, spinner absent over a ticking roster, must settle to Idle"
        );
    }

    #[test]
    fn heartbeat_shell_roster_tick_stays_active() {
        // (b) A SHELL with the SAME inputs stays Active: a shell has no spinner,
        // and a busy shell (e.g. `npm build`) shows none while its fresh bytes ARE
        // the work — the gate is claude-only, so the raw heartbeat is preserved.
        let mut d = StatusDetector::for_provider("shell");
        d.force(Status::Active);
        d.watching_since = Instant::now() - Duration::from_secs(30);
        assert_eq!(
            d.detect(TICKING_ROSTER, Instant::now(), TurnState::default(), false),
            Status::Active,
            "a shell producing fresh bytes must stay live via the heartbeat"
        );
    }

    #[test]
    fn heartbeat_kimi_roster_tick_stays_active() {
        // (c) kimi with the SAME inputs stays Active: only claude is gated, kimi
        // keeps the raw PTY heartbeat.
        let mut d = StatusDetector::for_provider("kimi");
        d.force(Status::Active);
        d.watching_since = Instant::now() - Duration::from_secs(30);
        assert_eq!(
            d.detect(TICKING_ROSTER, Instant::now(), TurnState::default(), false),
            Status::Active,
            "only claude is gated — kimi keeps the raw heartbeat and stays Active"
        );
    }

    #[test]
    fn heartbeat_claude_with_visible_spinner_stays_active() {
        // (d) A GENUINELY working claude: the capture carries `esc to interrupt`,
        // so it returns Active at step 2 and never reaches the heartbeat gate.
        let mut d = StatusDetector::for_provider("claude");
        d.force(Status::Active);
        d.watching_since = Instant::now() - Duration::from_secs(30);
        assert_eq!(
            d.detect(
                "✻ Thinking… (esc to interrupt · 12s)",
                Instant::now(),
                TurnState::default(),
                false,
            ),
            Status::Active,
            "a visible esc-to-interrupt spinner is a genuine turn → Active"
        );
    }

    #[test]
    fn heartbeat_claude_young_watch_window_stays_active() {
        // (e) Restart grace: the SAME resting claude but watched only briefly
        // (2s < SPINNER_SETTLE) and never having seen a spinner. The gate requires
        // the spinner-absence to be SUSTAINED, so a just-restarted lead holds
        // Active until the absence settles — a real main turn's spinner gets time
        // to draw rather than being idled prematurely.
        let mut d = StatusDetector::for_provider("claude");
        d.force(Status::Active);
        d.watching_since = Instant::now() - Duration::from_secs(2);
        assert!(d.spinner_last_seen.is_none());
        assert_eq!(
            d.detect(TICKING_ROSTER, Instant::now(), TurnState::default(), false),
            Status::Active,
            "a just-restarted claude (watched < SPINNER_SETTLE) must hold Active until the absence is sustained"
        );
    }

    /// A turn whose main `Stop` fired long ago but whose subagent tool hooks keep
    /// `turn_start` fresh on the parent token: `turn_start (PreToolUse) > turn_end
    /// (Stop)` ⇒ the turn machine reads Active, and with the spinner absent over a
    /// ticking roster (watched > SPINNER_SETTLE) branch 1b would normally settle it.
    fn workflow_turn() -> TurnState {
        let mut t = TurnState::default();
        t.apply(Instant::now() - Duration::from_secs(40), HookEvent::Stop);
        t.apply(Instant::now() - Duration::from_secs(3), HookEvent::PreToolUse);
        t
    }

    #[test]
    fn subagents_live_holds_a_stopped_main_turn_active() {
        // The headline case: the MAIN turn Stopped but a background workflow is
        // still appending to `subagents/agent-*.jsonl` (subagents_live=true). The
        // spinner is absent and we have watched past SPINNER_SETTLE, so WITHOUT the
        // signal branch 1b settles to Idle — that is the reported done/idle bug.
        // WITH subagents_live=true the settle stands down and the session reads
        // WORKING.
        let mut d = StatusDetector::for_provider("claude");
        d.force(Status::Active);
        d.watching_since = Instant::now() - Duration::from_secs(30);
        assert!(d.spinner_last_seen.is_none());
        assert_eq!(
            d.detect_with_subagents(TICKING_ROSTER, Instant::now(), workflow_turn(), true, true),
            Status::Active,
            "a Stopped main turn with a provably-live background workflow must stay Active"
        );
    }

    #[test]
    fn no_subagents_settles_a_stopped_main_turn_idle() {
        // The SAME inputs with subagents_live=false (no live workflow — the default)
        // MUST settle to Idle exactly as before: the stuck-`active` fix is intact,
        // and a plain session whose subagents are done does not linger Active.
        let mut d = StatusDetector::for_provider("claude");
        d.force(Status::Active);
        d.watching_since = Instant::now() - Duration::from_secs(30);
        assert!(d.spinner_last_seen.is_none());
        assert_eq!(
            d.detect_with_subagents(TICKING_ROSTER, Instant::now(), workflow_turn(), true, false),
            Status::Idle,
            "with no live subagent the settle must still fire (stuck-active fix intact)"
        );
        // And the plain 4-arg `detect` is identical to the false case — the
        // property every golden fixture relies on.
        let mut d2 = StatusDetector::for_provider("claude");
        d2.force(Status::Active);
        d2.watching_since = Instant::now() - Duration::from_secs(30);
        assert_eq!(
            d2.detect(TICKING_ROSTER, Instant::now(), workflow_turn(), true),
            Status::Idle,
            "detect() defaults subagents_live=false → byte-identical to the false path"
        );
    }

    #[test]
    fn subagents_live_holds_the_step5_stale_hook_residual() {
        // Branch 5 (held-Active, stale hooks → turn machine returns None): the
        // `ipc`-class settle. subagents_live=true must also hold THIS Active (a live
        // workflow whose parent hooks have aged past TURN_SAFETY) instead of idling.
        let mut d = StatusDetector::for_provider("claude");
        d.force(Status::Active);
        d.watching_since = Instant::now() - Duration::from_secs(30);
        assert_eq!(
            d.detect_with_subagents(TICKING_ROSTER, Instant::now(), TurnState::default(), true, true),
            Status::Active,
            "a live workflow holds the step-5 held-Active residual against the settle"
        );
        // …and false still settles it (the exact stuck-`active` zombie kill).
        let mut d2 = StatusDetector::for_provider("claude");
        d2.force(Status::Active);
        d2.watching_since = Instant::now() - Duration::from_secs(30);
        assert_eq!(
            d2.detect_with_subagents(TICKING_ROSTER, Instant::now(), TurnState::default(), true, false),
            Status::Idle,
            "no live workflow → the held-Active residual still settles to Idle"
        );
    }
}

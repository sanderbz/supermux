//! Notifications — the agent's OWN words, raised at hook anchors.
//!
//! # The inversion
//!
//! A push used to be a side effect of the STATUS DETECTOR committing a
//! transition (`auto_actions::maybe_push_on_transition`). The detector is a
//! heuristic: regex banks over pane captures, a PTY byte-heartbeat, a 30 s idle
//! timeout, drift-heal commits, restart re-classification. Every one of those
//! could — and did — buzz a phone for something that never happened.
//!
//! Pushes are now FIRST-CLASS EVENTS raised at the hook arms in
//! [`crate::hooks::apply_payload`] — the same authoritative anchors the turn
//! state machine already trusts (`status.rs`: turn_end = main `Stop` only;
//! `SubagentStop` is non-decisive). The detector cannot produce a buzz **by
//! construction**: there is no code path from it to [`crate::push`].
//!
//! Scope consequence, stated rather than hidden: push is HOOK-ANCHORED, so
//! Claude sessions, the board hook and the scheduler push; codex / shell
//! sessions do not. Their roster tier in-app still works off status — the
//! roster may say "waiting", the phone stays silent. Nothing fires off a regex.
//!
//! # The bar
//!
//! Every push body is a string that is ALSO published on the sessions delta or
//! readable in the transcript — the lock screen and the conversation can never
//! disagree. There are exactly two push-only sentences, both declared
//! fallbacks: [`FALLBACK_FINISHED`] and [`FALLBACK_CRASHED`].
//!
//! # The shape
//!
//! [`compose`] is a PURE function `(&NotifEvent, &ComposeCtx) -> PushPayload`.
//! No I/O, no network, no state. That is what makes "assert the copy verbatim"
//! a unit test instead of an end-to-end hope — the same discipline
//! `web/src/components/chat/attention.ts` established for the chat surface.
//! [`notify_event`] is the impure shell: it loads the row, resolves the tail,
//! applies suppression + the session policy, and hands the payload to the
//! transport.

use std::time::Duration;

use serde::Serialize;

use crate::db;
use crate::db::push::NotifCategory;
use crate::sessions::activity::PermissionAsk;
use crate::sessions::chat::store::{one_line_capped, ChatTail};
use crate::state::AppState;

/// Push-body budget in CHARS (never bytes). `TAIL_MAX_CHARS` is 200 for tiles;
/// 180 keeps the whole body visible on an iOS lock-screen banner instead of
/// being cut by the shade.
pub const PUSH_BODY_MAX: usize = 180;

/// The ONLY push-only sentence for a finished turn — used when no closing line
/// is recoverable (no chat ring attached, no transcript on disk yet).
pub const FALLBACK_FINISHED: &str = "Turn finished.";

/// The ONLY push-only sentence for a dead session.
pub const FALLBACK_CRASHED: &str = "Session ended unexpectedly.";

/// Transcript-flush grace before a `TurnFinished` push: the final assistant
/// entry has to land on disk before [`tail_for_push`] can read it back.
pub const FINISH_GRACE: Duration = Duration::from_secs(2);

/// The finish grace for a TEAM LEAD (B5/T2.3, carried over from the detector
/// path's `T_TEAM_FINISH`).
///
/// A lead legitimately bounces in and out of a finished turn every few seconds
/// while it dispatches teammates, so a 2 s window would announce "done" several
/// times per team run. 15 s of quiet is the evidence that the team itself is
/// actually done. Only the finish tier waits this long — a needs-you or an
/// error on a lead keeps the short grace, because delaying those is worse than
/// delaying a finish.
pub const TEAM_FINISH_GRACE: Duration = Duration::from_secs(15);

/// How many bytes off the end of a transcript the disk fallback reads.
const TAIL_READ_BYTES: u64 = 64 * 1024;

// ── the event set (exhaustive — anything not here does not push) ────────────

/// A notification-worthy thing that ACTUALLY HAPPENED, as reported by a hook.
///
/// Not a status, not a classification: each variant corresponds 1:1 to a hook
/// arm in [`crate::hooks::apply_payload`] (or the board hook). Adding a variant
/// means adding an anchor, which is the point — the trigger table is the type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotifEvent {
    /// A permission dialog is UP (incl. plan approval — `ExitPlanMode` arrives
    /// as a `PermissionRequest`). Raised only when the ask actually CHANGED, so
    /// an identical re-fire dedupes for free.
    PermissionAsked,
    /// Claude's own `Notification` hook message, verbatim ("Claude is waiting
    /// for your input", …). Skipped when a dialog is already up — that push
    /// said the same thing with more substance.
    AgentNotice(String),
    /// The agent asked a question via `AskUserQuestion`.
    Question(String),
    /// The MAIN turn ended (`Stop`). `SubagentStop` structurally cannot reach
    /// this.
    TurnFinished,
    /// The turn ended in an agent error (`StopFailure`).
    TurnFailed { etype: String, msg: String },
    /// The session died on its own (`SessionEnd` with reason `other`/absent —
    /// `clear` / `logout` / `prompt_input_exit` are the user at the keyboard
    /// and never push).
    SessionCrashed { reason: String },
}

impl NotifEvent {
    /// The user-facing tier. Two attention levels plus an error tone — the
    /// roster, the badge and the SW's renotify rule all read this.
    pub const fn tier(&self) -> Tier {
        match self {
            Self::PermissionAsked | Self::AgentNotice(_) | Self::Question(_) => Tier::Attention,
            Self::TurnFinished => Tier::Unread,
            Self::TurnFailed { .. } | Self::SessionCrashed { .. } => Tier::Error,
        }
    }

    /// The prefs category this event is muted by (Settings → Notifications).
    /// The DB keys are unchanged from before this redesign — the Settings UI
    /// relabels them under tier language, the storage does not move.
    pub const fn category(&self) -> NotifCategory {
        match self {
            Self::PermissionAsked | Self::AgentNotice(_) | Self::Question(_) => {
                NotifCategory::AgentWaiting
            }
            Self::TurnFinished => NotifCategory::AgentFinished,
            Self::TurnFailed { .. } => NotifCategory::AgentError,
            Self::SessionCrashed { .. } => NotifCategory::AgentStopped,
        }
    }

    /// Short, stable name for the diagnostics ring / the preview endpoint.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::PermissionAsked => "permission",
            Self::AgentNotice(_) => "notice",
            Self::Question(_) => "question",
            Self::TurnFinished => "stop",
            Self::TurnFailed { .. } => "stop_failure",
            Self::SessionCrashed { .. } => "session_end",
        }
    }
}

/// The user-facing tier: two attention levels (needs-attention > unread) plus
/// an error tone, and the schedule lane which is its own explicit opt-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// The agent is BLOCKED on the human. Never server-suppressed, renotifies.
    Attention,
    /// Something finished; there is nothing to unblock. Calm: suppressed while
    /// the session is being viewed, replaces silently.
    Unread,
    /// Something broke. Error tone, renotifies.
    Error,
    /// Scheduler lane — an explicit per-schedule opt-in, so it outranks a
    /// passive per-session mute.
    Schedule,
}

impl Tier {
    /// The client roster tier this push tier corresponds to (B5/T3.5, R2).
    ///
    /// The two vocabularies are DIFFERENT SETS that share exactly one word, and
    /// that overlap is the whole hazard: server `Tier` is
    /// `attention | unread | error | schedule` (what a push IS), while B2's
    /// client `TIERS` is `needs | unread | working | quiet` (what a session
    /// LOOKS like in the roster). They answer different questions, so this is a
    /// mapping, never a rename:
    ///
    /// | server tier | client tier | what buzzes |
    /// |---|---|---|
    /// | `attention` | `needs`  | banner + badge, may renotify |
    /// | `error`     | `needs`  | banner + badge, may renotify |
    /// | `unread`    | `unread` | banner only, replaces silently, no badge |
    /// | `schedule`  | *(none)* | banner only — no roster row to tier |
    ///
    /// The client's `working` and `quiet` have no server tier at all, and must
    /// not grow one: they describe a session nobody needs to hear about, which
    /// is precisely the set that should never push.
    ///
    /// `BRAND.md` §6g carries the full table, and
    /// `web/tests/unit/attention-tiers.test.ts` asserts the same mapping from
    /// the client side — so a rename on either side fails a test rather than
    /// silently drifting.
    pub const fn client_tier(self) -> Option<&'static str> {
        match self {
            Self::Attention | Self::Error => Some("needs"),
            Self::Unread => Some("unread"),
            Self::Schedule => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Attention => "attention",
            Self::Unread => "unread",
            Self::Error => "error",
            Self::Schedule => "schedule",
        }
    }

    /// May this tier buzz again when it REPLACES a live notification for the
    /// same session? A blocking state may; a calm one updates silently.
    pub const fn renotify(self) -> bool {
        matches!(self, Self::Attention | Self::Error | Self::Schedule)
    }
}

// ── the per-bot opt-in ──────────────────────────────────────────────────────

/// One bot's own notification setting (`sessions.notif`, migration 0025).
///
/// This is the Grok move: notifications are turned on in a BOT's settings, not
/// in a global taxonomy of event types. The global category toggles stay as the
/// per-kind mute; the effective decision is the AND of the two, applied exactly
/// once in [`crate::push::send_push_for`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifPolicy {
    /// Follow the global category toggles. The default, and what every
    /// pre-migration row backfills to.
    Inherit,
    /// Every session-scoped tier may push, even ones muted globally? No — the
    /// global toggle still applies. `All` means this bot adds no mute of its
    /// own; it is `Inherit` with the intent stated explicitly, and it exists so
    /// the UI can distinguish "never chose" from "chose everything".
    All,
    /// Only the blocking tiers: needs-attention and errors. The calm "turn
    /// finished" tier is muted for this bot.
    Attention,
    /// This bot never pushes.
    Off,
}

impl NotifPolicy {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Inherit => "inherit",
            Self::All => "all",
            Self::Attention => "attention",
            Self::Off => "off",
        }
    }

    /// Parse the stored column. Anything unrecognised — including an empty
    /// string from a row created before the migration's DEFAULT applied — reads
    /// as [`Self::Inherit`]: a junk value must never silently mute a bot.
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "all" => Self::All,
            "attention" => Self::Attention,
            "off" => Self::Off,
            _ => Self::Inherit,
        }
    }

    /// Strict parse for the WRITE path (`PATCH /api/sessions/{name}/config`).
    ///
    /// Deliberately not [`Self::parse`]: that one is lenient because it reads a
    /// column that may hold junk from a hand-edit, and silently muting a bot is
    /// the worse failure there. On the write path the opposite is true — a
    /// mis-typed policy would quietly change whether the user's phone rings, so
    /// an unrecognised value is a 400 instead.
    pub fn from_str(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "inherit" => Some(Self::Inherit),
            "all" => Some(Self::All),
            "attention" => Some(Self::Attention),
            "off" => Some(Self::Off),
            _ => None,
        }
    }

    /// Does this bot's setting mute `tier`?
    ///
    /// The schedule lane never reaches here (a schedule's "notify me when
    /// done" is an explicit per-schedule opt-in and is sent with no session, so
    /// an explicit opt-in outranks a passive per-bot mute) — but it is spelled
    /// out anyway so the rule survives a future caller.
    pub const fn mutes(self, tier: Tier) -> bool {
        match self {
            Self::Off => !matches!(tier, Tier::Schedule),
            Self::Attention => matches!(tier, Tier::Unread),
            Self::Inherit | Self::All => false,
        }
    }
}

// ── the payload the service worker receives ─────────────────────────────────

/// The JSON the SW gets. The SW is the only consumer; every field here is
/// something it acts on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PushPayload {
    /// The BOT's name — `sessions.display_name`, falling back to the slug.
    /// Never `agent {name}`, never a sentence: the title names who is talking.
    pub title: String,
    /// The agent's own words (see the module docs' invariant).
    pub body: String,
    /// App-relative deep link the SW opens on tap.
    pub url: String,
    pub tier: Tier,
    /// The session this is about (`None` for the scheduler lane). The SW uses
    /// it for the coalescing slot and the app uses it to close stale banners.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// Sessions currently needing attention — the home-screen / dock badge.
    pub badge: u32,
    /// Notification icon. Honored by Chrome/Edge (Android + desktop); iOS
    /// ignores it and always shows the app icon, so this is forward-compatible
    /// plumbing, not a promise. See the module note on identity marks.
    pub icon: String,
    /// Coalescing slot: exactly ONE live notification per session,
    /// replace-in-place.
    pub tag: String,
    /// Whether replacing the slot may buzz again ([`Tier::renotify`]).
    pub renotify: bool,
}

impl PushPayload {
    /// The scheduler / board shape: a plain title+body+url on a given tier,
    /// with no session slot. Keeps those call sites honest without forcing
    /// them through [`compose`], whose inputs they do not have.
    pub fn simple(
        title: impl Into<String>,
        body: impl Into<String>,
        url: impl Into<String>,
        tier: Tier,
    ) -> Self {
        let url = url.into();
        Self {
            title: title.into(),
            body: body.into(),
            tag: url.clone(),
            url,
            tier,
            session: None,
            badge: 0,
            icon: DEFAULT_ICON.to_string(),
            renotify: tier.renotify(),
        }
    }

    /// Session-scoped variant of [`Self::simple`] — the board hook, which has a
    /// session and a question but no `ComposeCtx`.
    pub fn for_session(mut self, session: &str, badge: u32) -> Self {
        self.tag = tag_for(session);
        self.session = Some(session.to_string());
        self.badge = badge;
        self
    }
}

/// The app icon. A per-session identity mark would go here once the plan's
/// mark columns exist server-side (`GET /api/sessions/{name}/mark.png`); until
/// then generating one would deliver nothing on the device that matters (iOS
/// discards `icon` outright), so we do not fake it.
const DEFAULT_ICON: &str = "/icon-192.png";

/// The tool whose permission dialog is NOT a push of its own: Claude raises
/// `AskUserQuestion` as a `PreToolUse` (carrying the question) AND as a
/// `PermissionRequest` a few ms later.
const QUESTION_TOOL: &str = "AskUserQuestion";

/// May a `PermissionRequest` for `tool` raise a push?
///
/// Every dialog may, except the one that is really a question the pre-tool arm
/// has already announced with the agent's OWN words. Without this the phone
/// buzzes twice for one block and the second banner — "Needs permission —
/// AskUserQuestion (AskUserQuestion)", the generic-tool label — replaces the
/// actual question in the session's coalescing slot, so the lock screen ends up
/// showing strictly less than it knew 20 ms earlier.
///
/// The dialog STATE is unaffected: `set_permission_request` still runs, so the
/// in-app pending card and the roster tier are unchanged.
pub fn permission_raises_push(tool: &str) -> bool {
    tool.trim() != QUESTION_TOOL
}

/// The coalescing slot for a session: one live notification, replace-in-place.
///
/// Replacement is CAUSALLY correct by construction — a `Stop` push can only
/// follow a permission push after the dialog resolved (the `Stop` arm clears
/// the permission first), so "finished" overwriting "needs you" states the
/// newest truth instead of masking a live block.
pub fn tag_for(session: &str) -> String {
    format!("session:{session}")
}

// ── the pure copy module ────────────────────────────────────────────────────

/// Everything [`compose`] is allowed to look at. Assembled by the impure shell;
/// the composition itself sees nothing else — no pool, no clock, no network.
#[derive(Debug, Clone, Default)]
pub struct ComposeCtx {
    /// `sessions.display_name` (migration 0019, backfilled to `name`).
    pub display_name: String,
    /// The slug — identity, and the deep-link segment.
    pub name: String,
    /// The live dialog, when one is up.
    pub permission: Option<PermissionAsk>,
    /// The conversation tail, when recoverable.
    pub tail: Option<ChatTail>,
    /// The last activity label (`⚡ cargo check`), for the crash body.
    pub activity_label: Option<String>,
    /// Sessions currently needing attention.
    pub badge: u32,
}

/// Compose the notification for one event. PURE.
///
/// Every string this returns is asserted verbatim in the tests below — that is
/// the whole reason it is a separate function.
pub fn compose(ev: &NotifEvent, ctx: &ComposeCtx) -> PushPayload {
    let tier = ev.tier();
    // The title is the BOT's name and nothing else.
    let title = if ctx.display_name.trim().is_empty() {
        ctx.name.clone()
    } else {
        ctx.display_name.clone()
    };
    let body = compose_body(ev, ctx);
    // Needs-attention lands ON the thing that needs answering; the calm tiers
    // land on the conversation.
    let url = if matches!(tier, Tier::Attention) {
        format!("/focus/{}#pending", ctx.name)
    } else {
        format!("/focus/{}", ctx.name)
    };
    PushPayload {
        title,
        body,
        url,
        tier,
        session: Some(ctx.name.clone()),
        badge: ctx.badge,
        icon: DEFAULT_ICON.to_string(),
        tag: tag_for(&ctx.name),
        renotify: tier.renotify(),
    }
}

/// The body table. Split out so each row reads as one arm.
fn compose_body(ev: &NotifEvent, ctx: &ComposeCtx) -> String {
    match ev {
        NotifEvent::PermissionAsked => match ctx.permission.as_ref() {
            // Plan approval: the plan TEXT is not in the payload, so we do not
            // invent one — the deep-link lands on the plan card, which has it.
            Some(ask) if ask.tool == "ExitPlanMode" => "Plan ready for approval.".to_string(),
            Some(ask) => {
                // The mode is only worth the pixels when it is not the default.
                let mode = ask
                    .mode
                    .as_deref()
                    .map(str::trim)
                    .filter(|m| !m.is_empty() && *m != "default");
                let parens = match mode {
                    Some(m) => format!("({}, {m})", ask.tool),
                    None => format!("({})", ask.tool),
                };
                cap(&format!("Needs permission — {} {parens}", ask.summary))
            }
            // The ask evaporated between the raise and the compose (the dialog
            // resolved). Say the true thing, generically.
            None => "Needs your permission.".to_string(),
        },
        // Claude's own sentence, verbatim.
        NotifEvent::AgentNotice(msg) => one_line_capped(msg, PUSH_BODY_MAX)
            .unwrap_or_else(|| "The agent needs your input.".to_string()),
        // The agent's own question, verbatim.
        NotifEvent::Question(q) => one_line_capped(q, PUSH_BODY_MAX)
            .unwrap_or_else(|| "The agent asked you a question.".to_string()),
        // The agent's actual closing line — markdown glyphs and all. The tile
        // shows the SAME string; polish-stripping would make the two disagree.
        NotifEvent::TurnFinished => ctx
            .tail
            .as_ref()
            .and_then(|t| one_line_capped(&t.agent, PUSH_BODY_MAX))
            .unwrap_or_else(|| FALLBACK_FINISHED.to_string()),
        NotifEvent::TurnFailed { etype, msg } => {
            let etype = etype.trim();
            let msg = msg.trim();
            let joined = if msg.is_empty() {
                etype.to_string()
            } else if etype.is_empty() {
                msg.to_string()
            } else {
                format!("{etype}: {msg}")
            };
            one_line_capped(&joined, PUSH_BODY_MAX)
                .unwrap_or_else(|| "The turn failed.".to_string())
        }
        // Naming what it was doing when it died turns "something broke" into a
        // place to look. The sentence's full stop gives way to the clause.
        NotifEvent::SessionCrashed { .. } => match ctx.activity_label.as_deref().map(str::trim) {
            Some(label) if !label.is_empty() => cap(&format!(
                "{} — {label}",
                FALLBACK_CRASHED.trim_end_matches('.')
            )),
            _ => FALLBACK_CRASHED.to_string(),
        },
    }
}

/// One-line + cap at [`PUSH_BODY_MAX`], never returning empty (the callers here
/// have already established there is something to say).
fn cap(s: &str) -> String {
    one_line_capped(s, PUSH_BODY_MAX).unwrap_or_default()
}

// ── the impure shell ────────────────────────────────────────────────────────

/// Raise one notification event for `session`.
///
/// Returns immediately: every caller is a hook handler that must answer inside
/// the hook command's `--max-time 1`, so the DB reads, the transcript read and
/// the push fan-out all happen on a detached task.
///
/// The task takes the session's slot in `state.pending_pushes`, CANCELLING
/// whatever was in it. That matters exactly once — while a `TurnFinished` is
/// waiting out its transcript-flush grace — and it is what makes the sequence
/// "Stop, then a new permission dialog 200 ms later" produce the dialog's
/// banner rather than two.
/// Does this provider emit Claude-style hooks?
///
/// **This predicate decides who owns `state.pending_pushes`** (B5/T2.2), which
/// is why it is spelled out here rather than inferred at the call site.
///
/// Only `claude` installs the hook set supermux reads (`PermissionRequest`,
/// `Stop`, `StopFailure`, `SessionEnd`, …); board and scheduler sessions are
/// Claude sessions and so are covered by the same `true`. A `codex` /
/// `shell` pane emits nothing, so for those the 2 s status detector remains the
/// ONLY thing that can notice a turn boundary — and therefore stays live as the
/// explicit fallback (`auto_actions::maybe_push_on_transition`).
///
/// EXACT match, deliberately: a new provider must opt IN by name. The failure
/// mode of guessing wrong in the permissive direction is two writers racing on
/// one map, which is silent; guessing wrong in the restrictive direction just
/// means the fallback keeps working.
pub fn provider_emits_hooks(provider: &str) -> bool {
    provider == "claude"
}

/// Whether a hook-anchored `TurnFinished` should actually send, given the live
/// outstanding subagent count (B5/T2.3).
///
/// This gate was grown by `main` INSIDE the detector path
/// (`auto_actions::push_should_fire`). Demoting the detector without carrying
/// it across would have re-opened the bug it closed: a multi-agent turn reads
/// idle between subagent dispatches, and would cry "finished" mid-turn, once
/// per dispatch.
///
/// Fail-safe by construction: the count is force-0'd on the main `Stop`
/// (`hooks.rs`), so a lost `SubagentStop` can never permanently suppress a real
/// finish — the worst case is one late notification, never a missing one.
fn finish_gated_by_subagents(state: &AppState, session: &str) -> bool {
    state
        .session_activity(session)
        .map(|a| a.subagents > 0)
        .unwrap_or(false)
}

pub fn notify_event(state: &AppState, session: &str, ev: NotifEvent) {
    // Cancel the prior pending send FIRST, then install the new one. There is
    // no per-session concurrency here (hooks for one session arrive serially on
    // one handler), so nothing can squeeze an insert in between.
    if let Some((_, prev)) = state.pending_pushes.remove(session) {
        prev.abort();
    }
    let task_state = state.clone();
    let task_session = session.to_string();
    let handle = tokio::spawn(async move {
        // The finish push waits so the closing line has actually been written
        // before `tail_for_push` reads it back. Nothing else waits: a blocked
        // agent is blocked NOW.
        if matches!(ev, NotifEvent::TurnFinished) {
            // B5/T2.3 — the 15 s team-finish window, moved here from the
            // detector path. A team LEAD legitimately bounces in and out of a
            // finished turn every few seconds while it dispatches teammates, so
            // its "done" is held until it has been quiet long enough that the
            // team is actually done. Needs-you and error events keep the short
            // grace even on a lead: those are unambiguous, and delaying them is
            // the one thing worse than delaying a finish.
            let is_lead = db::sessions::team_name(&task_state.pool, &task_session)
                .await
                .ok()
                .flatten()
                .is_some();
            tokio::time::sleep(if is_lead { TEAM_FINISH_GRACE } else { FINISH_GRACE }).await;

            // B5/T2.3 — the subagent gate, likewise moved here. Re-read AFTER
            // the grace, not before: the whole point is to let the count settle.
            if finish_gated_by_subagents(&task_state, &task_session) {
                tracing::debug!(
                    session = %task_session,
                    "notify: finish held — Task subagents are still in flight",
                );
                task_state.pending_pushes.remove(&task_session);
                return;
            }
        }
        deliver(&task_state, &task_session, ev).await;
        // Free the slot; a newer event that arrived meanwhile has already
        // overwritten it, which is correct.
        task_state.pending_pushes.remove(&task_session);
    });
    state
        .pending_pushes
        .insert(session.to_string(), handle.abort_handle());
}

/// The body of [`notify_event`], `await`able so tests can drive it without
/// racing a detached task.
pub async fn deliver(state: &AppState, session: &str, ev: NotifEvent) {
    // ── server-side suppression (cross-device), UNREAD tier only ────────────
    // A finish is calm: if the session is being viewed anywhere, the user has
    // already seen it land. Attention and error are NEVER server-suppressed —
    // they block the agent, and the worst case is the device layer eating the
    // banner on the one device that is already looking.
    //
    // B5/T4.5 — this is the upgrade the harvest named as its own upgrade point.
    // The v1 signal was "a chat store is attached", a proxy for being watched
    // that held whenever a chat WS was up plus the tailer's 30 s idle grace —
    // so a tab left open on a session in another window suppressed its finishes
    // indefinitely, even with the laptop shut.
    //
    // The real signal is the seen cursor (migration 0029): did the user
    // actually LOOK at this session in the last 30 s, on any device? That is
    // cross-device by construction, and it expires on its own.
    //
    // The chat-store proxy survives as the fallback for the window where the
    // cursor is still null. Suppressing one extra finish is a better failure
    // than a duplicate banner.
    if matches!(ev.tier(), Tier::Unread) && recently_seen(state, session).await {
        tracing::debug!(
            session,
            "notify: unread suppressed — seen just now"
        );
        return;
    }

    let Some(payload) = build_payload(state, session, &ev).await else {
        return;
    };
    crate::push::send_push_for(state, ev.category(), &payload, Some(session)).await;
}

/// Assemble the [`ComposeCtx`] for `session` and compose. `None` when the row
/// is gone (a deleted session must not push).
pub async fn build_payload(
    state: &AppState,
    session: &str,
    ev: &NotifEvent,
) -> Option<PushPayload> {
    let row = db::sessions::get(&state.pool, session)
        .await
        .ok()
        .flatten()?;
    let act = state.session_activity(session).unwrap_or_default();
    // Only a finish needs the (possibly disk-reading) tail.
    let tail = if matches!(ev, NotifEvent::TurnFinished) {
        tail_for_push(state, &row).await
    } else {
        None
    };
    Some(compose(
        ev,
        &ComposeCtx {
            display_name: row.display_name.clone(),
            name: row.name.clone(),
            permission: act.permission.clone(),
            tail,
            activity_label: act.activity.clone(),
            badge: badge_including_self(
                attention_badge(state),
                ev.tier(),
                // B5/T1.3 (§0.3b delta #4) — `act.notice` is DELIBERATELY not a
                // term here. See `attention_badge` below for the evidence.
                act.permission.is_some() || act.error.is_some(),
            ),
        },
    ))
}

/// The badge this payload should carry.
///
/// [`attention_badge`] counts the sessions whose STATE says they need the human.
/// A needs-attention event can be raised BEFORE that state exists — the
/// `AskUserQuestion` push is raised from the pre-tool arm, ~20 ms before the
/// matching `PermissionRequest` records the dialog — so counting state alone
/// would ship a badge that leaves out the very bot the banner is about (a `0`
/// badge next to "the agent asked you a question"). Count this session too when
/// the event blocks on the human and the snapshot has not already counted it.
pub const fn badge_including_self(base: u32, tier: Tier, already_counted: bool) -> u32 {
    if matches!(tier, Tier::Attention) && !already_counted {
        base.saturating_add(1)
    } else {
        base
    }
}

/// How recently the user must have looked for a calm finish to be redundant.
///
/// 30 s, matching the tailer's idle grace: long enough that "I was just there"
/// is true, short enough that a session read this morning is not still
/// suppressing tonight's finishes.
const SEEN_SUPPRESSION_WINDOW_MS: i64 = 30_000;

/// Has the user viewed this session within [`SEEN_SUPPRESSION_WINDOW_MS`]?
///
/// Falls back to the pre-0029 proxy ("a chat store is attached") when the row
/// has no cursor yet, so the behaviour degrades toward the old one rather than
/// toward a duplicate banner. A DB error likewise reads as "not seen": failing
/// toward DELIVERING is the right direction — the cost is one redundant
/// banner, where the other direction is a notification the user never gets and
/// cannot know they missed.
async fn recently_seen(state: &AppState, session: &str) -> bool {
    match db::sessions::get(&state.pool, session).await {
        Ok(Some(row)) => match row.seen_ts {
            Some(ts) => {
                let now = chrono::Utc::now().timestamp_millis();
                now.saturating_sub(ts) <= SEEN_SUPPRESSION_WINDOW_MS
            }
            None => state.chat_store(session).is_some(),
        },
        _ => false,
    }
}

/// How many sessions currently NEED the human — the home-screen / dock badge.
///
/// In-memory only (the same snapshot the roster renders from): a live
/// permission dialog, or an un-cleared error.
///
/// **Why no "agent notice" term** (B5/T1.3, §0.3b delta #4). This predicate was
/// written on the integration branch as
/// `permission || notice || error`, against a `SessionActivity` that carried a
/// `notice` field. `main`'s struct has no such field, and it should not gain
/// one *for this purpose*: `status.rs` documents that Claude Code fires a
/// `Notification` hook ~60 s AFTER a turn finishes ("Claude is waiting for your
/// input") — which is why the status classifier already refuses to treat
/// `Notification` as decisive unless it is the newest signal AND a turn is in
/// progress. Feeding that same hook into the badge would relight the home
/// screen a minute after every completed turn, for every session, forever. The
/// two surviving terms are unambiguous: a permission dialog is genuinely up,
/// and an error is genuinely unrecovered.
///
/// `NotifEvent::AgentNotice` still PUSHES — the agent's sentence is worth a
/// banner. It just does not keep a persistent count lit afterwards.
///
/// Known limit, stated: a dialog resolved WITHOUT any subsequent push leaves
/// the badge stale until the app is next opened, which is exactly when the
/// window context recomputes it. The seen-cursor upgrades this later.
pub fn attention_badge(state: &AppState) -> u32 {
    state
        .session_activity
        .iter()
        .filter(|e| {
            let a = e.value();
            a.permission.is_some() || a.error.is_some()
        })
        .count()
        .min(u32::MAX as usize) as u32
}

/// The agent's closing line for a finished turn, from the two sources that can
/// have it — in that order:
///
/// 1. **live**: the in-memory chat ring, when a viewer was recently attached.
///    Free, and byte-identical to what the tile is showing.
/// 2. **disk**: the last [`TAIL_READ_BYTES`] of the session's transcript,
///    scanned backwards for the newest assistant text. This is why the finish
///    push waits out [`FINISH_GRACE`] — the entry has to be written first.
///
/// `None` (→ [`FALLBACK_FINISHED`]) when neither has anything: no pointer, no
/// file, no assistant text.
pub async fn tail_for_push(state: &AppState, row: &db::sessions::Session) -> Option<ChatTail> {
    if let Some(tail) = state.chat_store(&row.name).and_then(|s| s.tail_summary()) {
        if !tail.agent.is_empty() {
            return Some(tail);
        }
    }
    let path = crate::sessions::resumable::project_dir_for(&row.dir)
        .join(format!("{}.jsonl", row.cc_conversation_id));
    if row.cc_conversation_id.is_empty() {
        return None;
    }
    let agent = tokio::task::spawn_blocking(move || last_assistant_line(&path))
        .await
        .ok()
        .flatten()?;
    // B5/T1: `ChatTail` grew three seen-cursor fields in B2 (`entry_count`,
    // `last_entry_ts`, `epoch`). This tail is synthesised from a transcript
    // FILE, not from a live chat store, so it has no seq domain and no epoch to
    // report — zeroes are the honest answer, and the only consumer here is
    // `compose()`, which reads `agent` alone.
    Some(ChatTail {
        user: String::new(),
        agent,
        ts: 0,
        entry_count: 0,
        last_entry_ts: 0,
        epoch: 0,
    })
}

/// Read the tail of a Claude transcript and return its newest assistant text,
/// one-lined + capped. Blocking — call under `spawn_blocking`.
///
/// The read is bounded to [`TAIL_READ_BYTES`] and the first (possibly partial)
/// line of the window is dropped, so a mid-line seek can never yield a
/// half-parsed body. Sidechain (subagent) lines are skipped: the closing line
/// the user is waiting for is the MAIN agent's.
fn last_assistant_line(path: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let from = len.saturating_sub(TAIL_READ_BYTES);
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::with_capacity(TAIL_READ_BYTES as usize);
    f.take(TAIL_READ_BYTES).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);

    let mut lines: Vec<&str> = text.lines().collect();
    // A non-zero start landed mid-line; that fragment is not parseable JSON.
    if from > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    for line in lines.iter().rev() {
        let crate::sessions::chat::parser::ParsedLine::Entry(entries) =
            crate::sessions::chat::parser::parse_line(line, 0)
        else {
            continue;
        };
        for e in entries.iter().rev() {
            if e.kind != crate::sessions::chat::model::Kind::Assistant || e.is_sidechain {
                continue;
            }
            if let Some(t) = e.body.get("text").and_then(|v| v.as_str()) {
                if let Some(line) = one_line_capped(t, PUSH_BODY_MAX) {
                    return Some(line);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    //! The copy table, asserted VERBATIM. Every string a user can see on a lock
    //! screen is pinned here — that is the contract `compose` exists to make
    //! testable.

    use super::*;

    fn ctx() -> ComposeCtx {
        ComposeCtx {
            display_name: "deploy-fix".to_string(),
            name: "deploy-fix".to_string(),
            ..Default::default()
        }
    }

    fn ask(tool: &str, summary: &str, mode: Option<&str>) -> PermissionAsk {
        PermissionAsk {
            tool: tool.to_string(),
            summary: summary.to_string(),
            kind: "bash".to_string(),
            mode: mode.map(str::to_string),
        }
    }

    #[test]
    fn permission_body_is_the_dialog_summary_and_tool() {
        let mut c = ctx();
        c.permission = Some(ask("Bash", "⚡ run the test suite", Some("default")));
        let p = compose(&NotifEvent::PermissionAsked, &c);
        assert_eq!(p.title, "deploy-fix");
        assert_eq!(p.body, "Needs permission — ⚡ run the test suite (Bash)");
        assert_eq!(p.tier, Tier::Attention);
        assert_eq!(p.url, "/focus/deploy-fix#pending");
        assert_eq!(p.tag, "session:deploy-fix");
        assert!(p.renotify, "a blocking state may buzz again");
    }

    #[test]
    fn the_mode_is_named_only_when_it_is_not_the_default() {
        let mut c = ctx();
        c.permission = Some(ask("Bash", "⚡ cargo check", Some("acceptEdits")));
        assert_eq!(
            compose(&NotifEvent::PermissionAsked, &c).body,
            "Needs permission — ⚡ cargo check (Bash, acceptEdits)",
        );
        // Absent and empty modes read the same as `default`: no suffix.
        for mode in [None, Some(""), Some("   "), Some("default")] {
            c.permission = Some(ask("Bash", "⚡ cargo check", mode));
            assert_eq!(
                compose(&NotifEvent::PermissionAsked, &c).body,
                "Needs permission — ⚡ cargo check (Bash)",
                "mode {mode:?} must not be named",
            );
        }
    }

    #[test]
    fn exit_plan_mode_is_a_plan_approval_not_a_permission_sentence() {
        // `ExitPlanMode` arrives as a PermissionRequest, but "Needs permission
        // — 🛠 ExitPlanMode (ExitPlanMode)" is not what happened. The plan text
        // is not in the payload, so the deep-link carries the meaning.
        let mut c = ctx();
        c.permission = Some(ask("ExitPlanMode", "🛠 ExitPlanMode", Some("plan")));
        let p = compose(&NotifEvent::PermissionAsked, &c);
        assert_eq!(p.body, "Plan ready for approval.");
        assert_eq!(
            p.url, "/focus/deploy-fix#pending",
            "tap lands on the plan card"
        );
    }

    #[test]
    /// R2 — the two tier vocabularies are pinned from this side; the client
    /// asserts the same table in `attention-tiers.test.ts`. A rename on either
    /// side has to break one of the two.
    #[test]
    fn the_server_tiers_map_onto_the_client_roster_tiers() {
        assert_eq!(Tier::Attention.as_str(), "attention");
        assert_eq!(Tier::Unread.as_str(), "unread");
        assert_eq!(Tier::Error.as_str(), "error");
        assert_eq!(Tier::Schedule.as_str(), "schedule");

        // An error NEEDS you just as much as a block does — both land on the
        // client's `needs`, which is why this is a mapping and not a rename.
        assert_eq!(Tier::Attention.client_tier(), Some("needs"));
        assert_eq!(Tier::Error.client_tier(), Some("needs"));
        assert_eq!(Tier::Unread.client_tier(), Some("unread"));
        // The scheduler lane has no roster row to tier.
        assert_eq!(Tier::Schedule.client_tier(), None);

        // Every client tier this maps onto must be one B2 actually ships.
        for t in [Tier::Attention, Tier::Unread, Tier::Error, Tier::Schedule] {
            if let Some(c) = t.client_tier() {
                assert!(
                    ["needs", "unread", "working", "quiet"].contains(&c),
                    "{c} is not one of the client's TIERS",
                );
            }
        }
    }

    #[test]
    fn a_notice_is_claudes_own_sentence_verbatim() {
        let p = compose(
            &NotifEvent::AgentNotice("Claude is waiting for your input".to_string()),
            &ctx(),
        );
        assert_eq!(p.body, "Claude is waiting for your input");
        assert_eq!(p.tier, Tier::Attention);
    }

    #[test]
    fn a_question_is_the_agents_own_question_verbatim() {
        let p = compose(
            &NotifEvent::Question("Which migration strategy should I use?".to_string()),
            &ctx(),
        );
        assert_eq!(p.body, "Which migration strategy should I use?");
        assert_eq!(p.tier, Tier::Attention);
    }

    #[test]
    fn a_question_with_no_recoverable_text_falls_back_instead_of_inventing_one() {
        // A payload shape that carries no question still names what happened —
        // the agent IS blocked on an answer — without inventing content. This
        // is reachable: the pre-tool arm raises `Question` for every
        // `AskUserQuestion`, parsed text or not.
        for q in ["", "   ", "\n\n"] {
            assert_eq!(
                compose(&NotifEvent::Question(q.to_string()), &ctx()).body,
                "The agent asked you a question.",
                "{q:?}",
            );
        }
    }

    #[test]
    fn the_question_dialog_does_not_push_a_second_time_as_a_permission() {
        // Live on Claude Code 2.1.233: `AskUserQuestion` arrives as a
        // PreToolUse carrying the question AND as a PermissionRequest ~20 ms
        // later. Both used to push, and the second one — composing to the
        // generic-tool label below — replaced the real question in the
        // session's slot, so the banner showed strictly less than it knew.
        let mut c = ctx();
        c.permission = Some(ask("AskUserQuestion", "AskUserQuestion", Some("default")));
        assert_eq!(
            compose(&NotifEvent::PermissionAsked, &c).body,
            "Needs permission — AskUserQuestion (AskUserQuestion)",
            "the copy this suppression exists to keep off the lock screen",
        );
        assert!(!permission_raises_push("AskUserQuestion"));
        // Every OTHER dialog still pushes — including the plan approval, which
        // has its own copy and no pre-tool announcement.
        for tool in ["Bash", "Edit", "ExitPlanMode", "mcp__x__y", "  Bash  "] {
            assert!(permission_raises_push(tool), "{tool}");
        }
    }

    #[test]
    fn a_finished_turn_carries_the_agents_actual_closing_line() {
        let mut c = ctx();
        c.tail = Some(ChatTail {
            user: "ship it".to_string(),
            agent: "Done — all 34 tests pass, PR #61 is up for review.".to_string(),
            ts: 1,
            // B2 seen-cursor fields — irrelevant to `compose`, which reads the
            // two text fields; zeroed rather than invented.
            entry_count: 0,
            last_entry_ts: 0,
            epoch: 0,
        });
        let p = compose(&NotifEvent::TurnFinished, &c);
        assert_eq!(p.body, "Done — all 34 tests pass, PR #61 is up for review.");
        assert_eq!(p.tier, Tier::Unread);
        assert_eq!(
            p.url, "/focus/deploy-fix",
            "a calm tier does not deep-link to a dialog"
        );
        assert!(!p.renotify, "a replacing finish updates silently");
    }

    #[test]
    fn markdown_in_the_closing_line_survives_so_the_tile_and_the_lock_screen_agree() {
        let mut c = ctx();
        c.tail = Some(ChatTail {
            user: String::new(),
            agent: "**Done** — `cargo test` green.".to_string(),
            ts: 1,
            // B2 seen-cursor fields — irrelevant to `compose`, which reads the
            // two text fields; zeroed rather than invented.
            entry_count: 0,
            last_entry_ts: 0,
            epoch: 0,
        });
        assert_eq!(
            compose(&NotifEvent::TurnFinished, &c).body,
            "**Done** — `cargo test` green.",
        );
    }

    #[test]
    fn a_long_closing_line_is_capped_at_the_banner_budget_on_a_word_boundary() {
        let mut c = ctx();
        let long = "alpha ".repeat(100); // 600 chars of whole words
        c.tail = Some(ChatTail {
            user: String::new(),
            agent: long,
            ts: 1,
            entry_count: 0,
            last_entry_ts: 0,
            epoch: 0,
        });
        let body = compose(&NotifEvent::TurnFinished, &c).body;
        assert!(
            body.chars().count() <= PUSH_BODY_MAX,
            "{} chars",
            body.chars().count()
        );
        assert!(body.ends_with("alpha"), "cut on a word boundary: {body:?}");

        // Multi-byte safety: 500 scalars of `é` with no whitespace at all.
        c.tail = Some(ChatTail {
            user: String::new(),
            agent: "é".repeat(500),
            ts: 1,
            entry_count: 0,
            last_entry_ts: 0,
            epoch: 0,
        });
        let body = compose(&NotifEvent::TurnFinished, &c).body;
        assert_eq!(body.chars().count(), PUSH_BODY_MAX);
    }

    #[test]
    fn a_finish_with_no_recoverable_tail_falls_back_to_the_declared_sentence() {
        assert_eq!(
            compose(&NotifEvent::TurnFinished, &ctx()).body,
            "Turn finished."
        );
        // An empty agent line is "no tail", not an empty push.
        let mut c = ctx();
        c.tail = Some(ChatTail {
            user: "hi".to_string(),
            agent: String::new(),
            ts: 1,
            entry_count: 0,
            last_entry_ts: 0,
            epoch: 0,
        });
        assert_eq!(
            compose(&NotifEvent::TurnFinished, &c).body,
            "Turn finished."
        );
    }

    #[test]
    fn a_failed_turn_carries_the_error_pair() {
        let p = compose(
            &NotifEvent::TurnFailed {
                etype: "rate_limit".to_string(),
                msg: "You've reached your usage limit".to_string(),
            },
            &ctx(),
        );
        assert_eq!(p.body, "rate_limit: You've reached your usage limit");
        assert_eq!(p.tier, Tier::Error);
        assert!(p.renotify);
    }

    #[test]
    fn a_failed_turn_without_a_message_does_not_trail_a_colon() {
        let p = compose(
            &NotifEvent::TurnFailed {
                etype: "rate_limit".to_string(),
                msg: String::new(),
            },
            &ctx(),
        );
        assert_eq!(p.body, "rate_limit");
    }

    #[test]
    fn a_crash_names_the_last_thing_it_was_doing_when_there_is_one() {
        let mut c = ctx();
        c.activity_label = Some("⚡ cargo check".to_string());
        let p = compose(
            &NotifEvent::SessionCrashed {
                reason: "other".to_string(),
            },
            &c,
        );
        assert_eq!(p.body, "Session ended unexpectedly — ⚡ cargo check");
        assert_eq!(p.tier, Tier::Error);

        c.activity_label = None;
        assert_eq!(
            compose(
                &NotifEvent::SessionCrashed {
                    reason: String::new()
                },
                &c
            )
            .body,
            "Session ended unexpectedly.",
        );
    }

    #[test]
    fn the_title_is_the_bots_name_never_the_slug_and_never_a_sentence() {
        let mut c = ctx();
        c.display_name = "Deploy Fixer".to_string();
        c.name = "deploy-fix-7".to_string();
        let p = compose(&NotifEvent::TurnFinished, &c);
        assert_eq!(p.title, "Deploy Fixer");
        assert!(
            !p.title.starts_with("agent "),
            "no `agent {{name}}` prefix survives"
        );
        // The URL still uses the immutable slug.
        assert_eq!(p.url, "/focus/deploy-fix-7");
        assert_eq!(p.tag, "session:deploy-fix-7");

        // Pre-0019 edge: an empty display_name falls back to the slug.
        c.display_name = "   ".to_string();
        assert_eq!(compose(&NotifEvent::TurnFinished, &c).title, "deploy-fix-7");
    }

    #[test]
    fn every_session_event_coalesces_into_one_slot_per_session() {
        let c = ctx();
        for ev in [
            NotifEvent::PermissionAsked,
            NotifEvent::AgentNotice("x".into()),
            NotifEvent::Question("x".into()),
            NotifEvent::TurnFinished,
            NotifEvent::TurnFailed {
                etype: "e".into(),
                msg: "m".into(),
            },
            NotifEvent::SessionCrashed {
                reason: "other".into(),
            },
        ] {
            let p = compose(&ev, &c);
            assert_eq!(
                p.tag, "session:deploy-fix",
                "{ev:?} shares the session slot"
            );
            assert_eq!(p.session.as_deref(), Some("deploy-fix"));
            assert_eq!(p.icon, "/icon-192.png");
        }
    }

    #[test]
    fn the_badge_rides_every_payload() {
        let mut c = ctx();
        c.badge = 3;
        assert_eq!(compose(&NotifEvent::TurnFinished, &c).badge, 3);
    }

    #[test]
    fn a_blocking_event_counts_its_own_session_when_the_state_lags_the_push() {
        // The `AskUserQuestion` push is raised at PreToolUse, ~20 ms before the
        // `PermissionRequest` records the dialog — so the activity snapshot
        // does not yet count this bot. Shipping `attention_badge` verbatim
        // there put a `0` badge on "the agent asked you a question".
        assert_eq!(badge_including_self(0, Tier::Attention, false), 1);
        assert_eq!(badge_including_self(2, Tier::Attention, false), 3);
        // Already in the snapshot (a permission dialog recorded first): no
        // double count.
        assert_eq!(badge_including_self(2, Tier::Attention, true), 2);
        // The calm and error tiers are not "needs you" — they never inflate it.
        for tier in [Tier::Unread, Tier::Error, Tier::Schedule] {
            assert_eq!(badge_including_self(2, tier, false), 2, "{tier:?}");
        }
    }

    #[test]
    fn the_payload_serialises_to_the_shape_the_service_worker_reads() {
        let mut c = ctx();
        c.permission = Some(ask("Bash", "⚡ cargo check", None));
        c.badge = 2;
        let v = serde_json::to_value(compose(&NotifEvent::PermissionAsked, &c)).unwrap();
        assert_eq!(v["title"], "deploy-fix");
        assert_eq!(v["body"], "Needs permission — ⚡ cargo check (Bash)");
        assert_eq!(v["url"], "/focus/deploy-fix#pending");
        assert_eq!(v["tier"], "attention");
        assert_eq!(v["session"], "deploy-fix");
        assert_eq!(v["badge"], 2);
        assert_eq!(v["tag"], "session:deploy-fix");
        assert_eq!(v["renotify"], true);
        assert_eq!(v["icon"], "/icon-192.png");
    }

    #[test]
    fn tiers_and_categories_are_pinned_per_event() {
        use NotifEvent::*;
        for (ev, tier, cat) in [
            (
                PermissionAsked,
                Tier::Attention,
                NotifCategory::AgentWaiting,
            ),
            (
                AgentNotice("x".into()),
                Tier::Attention,
                NotifCategory::AgentWaiting,
            ),
            (
                Question("x".into()),
                Tier::Attention,
                NotifCategory::AgentWaiting,
            ),
            (TurnFinished, Tier::Unread, NotifCategory::AgentFinished),
            (
                TurnFailed {
                    etype: "e".into(),
                    msg: "m".into(),
                },
                Tier::Error,
                NotifCategory::AgentError,
            ),
            (
                SessionCrashed {
                    reason: "other".into(),
                },
                Tier::Error,
                NotifCategory::AgentStopped,
            ),
        ] {
            assert_eq!(ev.tier(), tier, "{ev:?}");
            assert_eq!(ev.category(), cat, "{ev:?}");
        }
    }

    #[test]
    fn the_per_bot_policy_mutes_exactly_the_tiers_it_claims_to() {
        use NotifPolicy::*;
        // (policy, attention, unread, error, schedule) — muted?
        for (policy, muted) in [
            (Inherit, [false, false, false, false]),
            (All, [false, false, false, false]),
            (Attention, [false, true, false, false]),
            // `off` mutes every SESSION-scoped tier. The schedule lane is an
            // explicit per-schedule opt-in and outranks a passive bot mute.
            (Off, [true, true, true, false]),
        ] {
            for (i, tier) in [Tier::Attention, Tier::Unread, Tier::Error, Tier::Schedule]
                .into_iter()
                .enumerate()
            {
                assert_eq!(policy.mutes(tier), muted[i], "{policy:?} × {tier:?}",);
            }
        }
    }

    #[test]
    fn an_unknown_or_empty_policy_value_can_never_mute_a_bot() {
        for junk in ["", "   ", "ON", "everything", "🙂", "inherit"] {
            assert_eq!(NotifPolicy::parse(junk), NotifPolicy::Inherit, "{junk:?}");
        }
        // …and the real values round-trip, case-insensitively.
        for p in [NotifPolicy::All, NotifPolicy::Attention, NotifPolicy::Off] {
            assert_eq!(NotifPolicy::parse(p.as_str()), p);
            assert_eq!(NotifPolicy::parse(&p.as_str().to_uppercase()), p);
        }
    }

    #[test]
    fn the_schedule_lane_keeps_its_own_url_tag_and_has_no_session_slot() {
        let p = PushPayload::simple(
            "schedule 'nightly-audit' finished",
            "'nightly-audit' finished.",
            "/scheduler",
            Tier::Schedule,
        );
        assert_eq!(p.tag, "/scheduler", "unchanged scheduler coalescing");
        assert_eq!(
            p.session, None,
            "no session policy applies to the schedule lane"
        );
        assert!(p.renotify);
    }

    #[test]
    fn last_assistant_line_reads_the_newest_main_agent_text_off_disk() {
        // The disk fallback is what makes a finish push work when nobody has a
        // chat WS attached — the common case for a phone notification.
        let dir =
            std::env::temp_dir().join(format!("supermux-notif-tail-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("conv.jsonl");
        let lines = [
            r#"{"type":"user","uuid":"u1","timestamp":"2026-08-16T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"ship it"}]}}"#,
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-08-16T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"working on it"}]}}"#,
            r#"{"type":"assistant","uuid":"a2","isSidechain":true,"timestamp":"2026-08-16T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"subagent chatter"}]}}"#,
            r#"{"type":"assistant","uuid":"a3","timestamp":"2026-08-16T10:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"DONE-MARKER-7 all checks pass"}]}}"#,
        ];
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();

        assert_eq!(
            last_assistant_line(&path).as_deref(),
            Some("DONE-MARKER-7 all checks pass"),
            "the newest MAIN assistant line wins; subagent chatter is skipped",
        );
        assert_eq!(last_assistant_line(&dir.join("missing.jsonl")), None);

        let _ = std::fs::remove_dir_all(dir);
    }
}

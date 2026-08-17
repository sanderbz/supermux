//! **What the screen says about whether this session can work at all.**
//!
//! [`super::status`] answers *what is the agent doing* — active, waiting, idle.
//! This module answers a question that outlives a turn and that nothing in this
//! codebase was asking: *can this session do the NEXT turn?*
//!
//! The two are not the same fact, and conflating them is what produced the worst
//! failure in the state audit. A usage-limit banner blocks nothing on the screen:
//! Claude Code draws it as a tool-result continuation row (`⎿ You've hit your
//! weekly limit · resets …`), ends the turn with a `Stop` hook, prints its
//! ordinary `✻ Baked for 0s` completion marker and brings the composer back. So
//! the turn state machine reports `Idle`, `IDLE_BANK` agrees, the tile goes green
//! and the composer stays enabled — for a session that cannot run another turn
//! for five hours (verify matrix finding 1, screenshots `05-chat-limits.png` /
//! `06-overview-limits.png`).
//!
//! Widening a status bank cannot fix that, and the audit says so explicitly: the
//! hook turn machine outranks the banks, and a limit-hit turn ends with a `Stop`,
//! so the detector is *structurally* incapable of returning anything but `Idle`.
//! A blocked session is not a status, it is a CONDITION. So it rides beside the
//! status as its own field.
//!
//! **Why the pty, when the transcript carries the same banner.** Because the
//! transcript is blind for exactly the sessions that need this most:
//!
//!   * a session whose transcript is off (an inherited `CLAUDE_CODE_CHILD_SESSION`
//!     marker) writes no JSONL at all;
//!   * every STARTUP WEDGE — the workspace-trust gate, the custom-API-key gate,
//!     the first-run wizard, codex's hooks review — happens *before the first
//!     transcript line exists*. The session boots, parks on a dialog, and reads
//!     `Starting` → `Idle` with a green dot, forever.
//!
//! The pty is the only witness both cases share.
//!
//! **The parity contract.** Every rule below is mirrored in
//! `web/src/components/chat/peek-lens.ts` (`readNotice`), and both are asserted
//! against the same captures by `tests/pty_state_parity.rs` and
//! `web/tests/unit/pty-state-parity.test.ts`. The corpus is
//! `tests/fixtures/pty/claude-states.jsonl`. Teaching one plane a shape and
//! forgetting the other is the drift that corpus exists to catch: the roster
//! reads the server's verdict, the chat surface reads the lens', and a user who
//! is told "blocked" on one surface and "idle" on the other has been told
//! nothing.
//!
//! Pure: no clock, no I/O, no state. It reads a capture and returns a fact.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

/// How far above the last printed row a notice may sit and still be LIVE.
///
/// The banner's own tail on the production capture is 7 rows (the remediation
/// subline, the completion marker, the two composer rules, the mode line); 20 is
/// slack. It matters because a bucket that has since reset leaves its banner in
/// the scrollback, and history must not read as a condition. The web plane uses
/// the identical window over `GET /peek`, whose capture is far deeper than the
/// [`super::status::CAPTURE_LINES`] this side ever holds.
const TAIL_SLACK: usize = 20;

/// The session cannot do the next turn, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Blocked {
    /// `limit` — the account's usage bucket is exhausted.
    /// `startup` — the session never reached a first turn (see `wedge`).
    /// `paused` — Claude Code stopped the turn on a consent modal and is
    ///   waiting for an answer that costs money or swaps the model (see
    ///   `dialog`). The worst of the three, because nothing else in this
    ///   codebase can see it: the turn has not ended, so no `Stop` hook fires
    ///   and the turn machine holds `Active` until [`super::status::TURN_SAFETY`]
    ///   lapses, after which the session wears a green `Idle` dot forever over a
    ///   screen that is asking a billing question.
    pub kind: &'static str,
    /// Claude Code's own line, verbatim. It already carries the reset time, and
    /// this app has no better sentence than the one the terminal printed.
    pub text: String,
    /// The remediation subline under a hard block (`/upgrade or /usage-credits
    /// …`), when it is on screen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Which startup gate, for `kind == "startup"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wedge: Option<&'static str>,
    /// Which consent modal, for `kind == "paused"`: `overage_consent` (spend
    /// usage credits) or `refusal_fallback` (a safeguard flagged the message).
    /// `None` = a `Session paused` screen whose body says neither, which is
    /// still reported — one title covers two dialogs today and a third can ship
    /// in any release, and "paused for a reason we do not recognise" is the
    /// honest reading of that, not silence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dialog: Option<&'static str>,
}

/// What one capture says about the session's ability to work.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PtyState {
    pub blocked: Option<Blocked>,
    /// The dim footer line Claude Code prints at ≥70 % utilisation, verbatim.
    /// A chip, never a block — the session still works.
    pub warning: Option<String>,
    /// **The turn is still live** — `Waiting for API response · will retry in
    /// {t} · check your network`, verbatim.
    ///
    /// The opposite of everything else in this struct: nothing is blocked, the
    /// request simply went out and no bytes came back, and Claude Code has
    /// already scheduled the retry. It is here because the failure it prevents
    /// is symmetrical to the limit banner's — that one drew a working session as
    /// green, this one draws a WORKING session as finished. The pty falls silent
    /// while a stall waits, so the activity heuristics see nothing, the turn
    /// machine's safety window eventually lapses, and the session goes Idle
    /// under a user who then walks away from a turn that was about to resume
    /// (catalog `err.stream_stalled`; issues #76555/#77389/#80299/#82155).
    pub stalled: Option<String>,
}

/// HARD BLOCK. `hit` (a bucket ran out) and `reached` (the model-specific /
/// usage-credit form) are the two verbs the bundle emits. `used` and
/// `Approaching` are the WARNING verbs and are deliberately not here.
static LIMIT_BLOCK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\byou['’]ve (?:hit|reached) your\b.*$").unwrap());

/// WARNING. Three shapes: the captured `You've used N% of your …` footer, and
/// the two `Approaching …` / `You're close to …` branches recorded from the
/// bundle's own strings.
static LIMIT_WARN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(?:you['’]ve used \d+% of your\b|approaching (?:session|weekly|opus|usage)\b|you['’]re close to your\b).*$",
    )
    .unwrap()
});

/// The gutter Claude Code draws these lines in, plus the indent: the
/// tool-result continuation (`⎿`), the assistant bullet (`●` — a refusal banner
/// is printed as an assistant line), and the box rules.
static CONTINUATION_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\s⎿·└│●]+").unwrap());

/// A line that is only box-drawing — the terminal's own framing.
static RULE_ONLY: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\s─━╌┄┈╍-]+$").unwrap());

/// A numbered dialog row, which is never a banner's remediation subline.
static OPTION_ROW: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*(?:❯\s*)?\d+\.\s+\S").unwrap());

/// The paused modals' shared title (catalog `limit.overage_consent_dialog`,
/// `err.refusal_fallback_dialog`). Matched as a whole trimmed line, and only
/// with a numbered row under it: the words "Session paused" appear in this
/// repo's own prose, and the rows are what prove a dialog is drawn.
const PAUSED_TITLE: &str = "Session paused";

/// Which paused modal, from the body under the title. Mirrors
/// `peek-lens.ts::readPausedVariant`, including the order: the refusal dialog's
/// body offers a MODEL switch too, so "usage credits" is not a discriminator
/// against it — "safeguards flagged" is, and only it.
const PAUSED_DIALOGS: &[(&str, &str)] = &[
    ("refusal_fallback", "safeguards flagged this message"),
    ("overage_consent", "usage credit"),
];

/// `Waiting for API response · will retry in 3s · check your network` — the
/// `stalled` retry kind. Taken to end of line so the countdown and the
/// remediation ride along verbatim.
static STALLED: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bWaiting for API response\b.*$").unwrap());

/// The startup gates, and the token that identifies each.
///
/// Every one of them blocks BEFORE the first turn, which is why they are here
/// and not in a status bank: there is no transcript, no hook has fired, and the
/// only two things that ever run are the capture loop and this function.
///
/// `trust`/`apikey` also draw numbered rows, so the chat surface can offer them
/// as a card (`web/src/components/chat/registry/claude.ts`). `onboarding` and
/// `hooks-review` are reported and never acted on — nobody has captured their
/// rows.
const WEDGES: &[(&str, &[&str])] = &[
    // Workspace trust. First run in an untrusted directory, and since 2.1.232
    // also on entering a NESTED git repo mid-session.
    ("trust", &["Accessing workspace:"]),
    // A custom API key in the environment. Focus DEFAULTS to `No (recommended)`
    // — a wrapper that just presses Enter here declines the key.
    ("apikey", &["Detected a custom API key in your environment"]),
    // The first-run wizard: a fresh host parks on the theme picker.
    ("onboarding", &["Let's get started.", "Choose the text style"]),
    // Codex's startup gate — and supermux installs the hooks that trip it.
    ("hooks-review", &["Hooks need review"]),
];

/// Read one capture. Total and cheap: no capture can panic, and an empty one
/// reads as "nothing is wrong" rather than as a failure.
///
/// Precedence is by consequence: a hard block outranks a wedge (a wedged session
/// that also hit its limit is blocked twice, and the limit is the one with a
/// clock on it), and both outrank a warning.
pub fn read(capture: &str) -> PtyState {
    let lines: Vec<&str> = capture.lines().collect();
    let Some(tail) = lines.iter().rposition(|l| !l.trim().is_empty()) else {
        return PtyState::default();
    };
    let from = tail.saturating_sub(TAIL_SLACK - 1);

    // A PAUSED MODAL OUTRANKS EVEN A HARD BLOCK, and it is the one precedence
    // inversion in this function — the same one `peek-lens.ts::readNotice`
    // makes, for the same reason. A limit-hit session and a paused one are the
    // same event seen twice: CC pauses the turn *because* the bucket ran out.
    // Only one of the two readings has a human in it, though — the block says
    // "come back in five hours", the modal says "answer this and keep going, on
    // credits" — so reporting the clock over the question would send somebody
    // away from a session that was one keypress from continuing.
    if let Some(paused) = read_paused(&lines, from, tail) {
        return PtyState {
            blocked: Some(paused),
            warning: None,
            stalled: None,
        };
    }

    for i in (from..=tail).rev() {
        let Some(m) = LIMIT_BLOCK.find(lines[i]) else {
            continue;
        };
        let next = lines.get(i + 1).copied().unwrap_or("");
        let detail = if i + 1 <= tail
            && !next.trim().is_empty()
            && !OPTION_ROW.is_match(next)
            && !RULE_ONLY.is_match(next)
        {
            Some(clean(next))
        } else {
            None
        };
        return PtyState {
            blocked: Some(Blocked {
                kind: "limit",
                text: clean(m.as_str()),
                detail,
                wedge: None,
                dialog: None,
            }),
            warning: None,
            stalled: None,
        };
    }

    for (wedge, tokens) in WEDGES {
        for token in *tokens {
            if let Some(i) = (from..=tail).find(|&i| lines[i].contains(token)) {
                return PtyState {
                    blocked: Some(Blocked {
                        kind: "startup",
                        text: clean(lines[i]),
                        detail: None,
                        wedge: Some(wedge),
                        dialog: None,
                    }),
                    warning: None,
                    stalled: None,
                };
            }
        }
    }

    for i in (from..=tail).rev() {
        if let Some(m) = LIMIT_WARN.find(lines[i]) {
            return PtyState {
                blocked: None,
                warning: Some(clean(m.as_str())),
                stalled: None,
            };
        }
    }

    // STILL LIVE, and therefore last: a stall is not a condition, it is a turn
    // that has not printed yet. It only ever reaches this point on a screen with
    // nothing wrong with it, which is precisely the screen that used to read as
    // a finished turn.
    for i in (from..=tail).rev() {
        if let Some(m) = STALLED.find(lines[i]) {
            return PtyState {
                blocked: None,
                warning: None,
                stalled: Some(clean(m.as_str())),
            };
        }
    }
    PtyState::default()
}

/// The paused consent modal on the live screen, if there is one.
///
/// Two facts, both required, mirroring `peek-lens.ts`: the TITLE (a whole
/// trimmed line — the words appear in this repo's own prose) and at least one
/// numbered row UNDER it (which is what proves a dialog is drawn rather than
/// quoted). The variant is read from the body between them.
fn read_paused(lines: &[&str], from: usize, tail: usize) -> Option<Blocked> {
    let title = (from..=tail).find(|&i| lines[i].trim() == PAUSED_TITLE)?;
    if !(title + 1..=tail).any(|i| OPTION_ROW.is_match(lines[i])) {
        return None;
    }
    let body = lines[title..=tail].join("\n").to_ascii_lowercase();
    let dialog = PAUSED_DIALOGS
        .iter()
        .find(|(_, token)| body.contains(token))
        .map(|(name, _)| *name);
    Some(Blocked {
        kind: "paused",
        text: PAUSED_TITLE.to_string(),
        detail: None,
        wedge: None,
        dialog,
    })
}

/// Is this capture parked on a PAUSED consent modal? The status detector's
/// second pre-emption, beside [`startup_wedge`] and for the same reason: the
/// turn machine cannot see this state at all (no hook fires — the turn has not
/// ended), so without a capture-driven answer the session reads `Active` until
/// the safety window lapses and `Idle` forever after.
pub fn paused_dialog(capture: &str) -> Option<Option<&'static str>> {
    match read(capture).blocked {
        Some(Blocked {
            kind: "paused",
            dialog,
            ..
        }) => Some(dialog),
        _ => None,
    }
}

/// Is the live screen waiting on a stalled request? See [`PtyState::stalled`] —
/// the turn is still live and must not drift to Idle.
pub fn is_stalled(capture: &str) -> bool {
    read(capture).stalled.is_some()
}

/// Is this capture parked on a startup gate? The one part of this module the
/// STATUS detector consults — a session sitting on a gate is blocked on a human
/// and must read `Waiting`, whatever the hooks think (see
/// [`super::status::StatusDetector::classify`]).
pub fn startup_wedge(capture: &str) -> Option<&'static str> {
    match read(capture).blocked {
        Some(Blocked { wedge: Some(w), .. }) => Some(w),
        _ => None,
    }
}

/// One line, gutter and indent removed, whitespace collapsed. Nothing else —
/// every remaining glyph is the terminal's.
fn clean(line: &str) -> String {
    let stripped = CONTINUATION_PREFIX.replace(line, "");
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_quiet_captures_are_not_blocked() {
        assert_eq!(read(""), PtyState::default());
        assert_eq!(read("❯ \n  ⏵⏵ auto mode on"), PtyState::default());
    }

    #[test]
    fn a_banner_far_up_the_scrollback_is_history_not_a_condition() {
        // The same banner, pushed out of the live tail by 25 rows of later
        // output: the bucket reset, the session works, and nothing may claim
        // otherwise.
        let mut cap = String::from("  ⎿  You've hit your weekly limit · resets Aug 17, 4am\n");
        for i in 0..25 {
            cap.push_str(&format!("● line {i}\n"));
        }
        assert_eq!(read(&cap).blocked, None);
    }

    #[test]
    fn the_remediation_subline_rides_along_but_a_rule_does_not() {
        let with = read("  ⎿  You've hit your session limit · resets 4:40am\n     /upgrade to keep using Claude Code\n");
        assert_eq!(
            with.blocked.as_ref().unwrap().detail.as_deref(),
            Some("/upgrade to keep using Claude Code")
        );
        let without = read("  ⎿  You've hit your session limit · resets 4:40am\n────────────\n❯\n");
        assert_eq!(without.blocked.as_ref().unwrap().detail, None);
    }

    #[test]
    fn used_and_approaching_warn_but_never_block() {
        for line in [
            "  You've used 77% of your Fable 5 limit · resets Aug 17, 4am",
            "  Approaching session limit · resets 4:40am",
            "  You're close to your usage limit",
        ] {
            let s = read(line);
            assert_eq!(s.blocked, None, "{line}");
            assert!(s.warning.is_some(), "{line}");
        }
    }

    #[test]
    fn a_hard_block_outranks_a_warning_on_the_same_screen() {
        let s = read("  You've used 99% of your weekly limit\n  ⎿  You've hit your weekly limit · resets Aug 17, 4am\n");
        assert_eq!(s.blocked.as_ref().unwrap().kind, "limit");
        assert_eq!(s.warning, None);
    }

    #[test]
    fn a_paused_modal_outranks_the_limit_banner_that_caused_it() {
        // The same event seen twice: CC pauses the turn BECAUSE the bucket ran
        // out, so both readings are true and only one of them has a human in it.
        // Reporting the clock here would send somebody away for five hours from
        // a session that was one keypress from continuing.
        let cap = "  ⎿  You've hit your Fable 5 limit · resets 4am\n Session paused\n\n Continue on usage credits, or switch models.\n\n   1. Continue on usage credits\n ❯ 2. Switch to the default model\n";
        let b = read(cap).blocked.expect("paused");
        assert_eq!(b.kind, "paused");
        assert_eq!(b.dialog, Some("overage_consent"));
    }

    #[test]
    fn the_title_alone_is_not_a_dialog() {
        // This repo's own prose says "Session paused" in half a dozen places, and
        // a capture is scrollback + viewport. The numbered row is what proves a
        // dialog is DRAWN rather than quoted.
        assert_eq!(read(" Session paused\n ❯\n").blocked, None);
        assert_eq!(
            read("● I'll explain what Session paused means.\n❯\n").blocked,
            None
        );
    }

    #[test]
    fn an_unrecognised_paused_body_still_reports_the_pause() {
        // One title, two dialogs today, and a third can ship in any release.
        // "Paused for a reason we do not recognise" is the honest reading of a
        // body this map has not seen — silence is not.
        let cap = " Session paused\n\n Something new is being asked here.\n\n   1. Do the thing\n   2. Do the other thing\n";
        let b = read(cap).blocked.expect("paused");
        assert_eq!(b.kind, "paused");
        assert_eq!(b.dialog, None);
    }

    #[test]
    fn a_stall_is_live_rather_than_blocked_and_leaves_the_screen_alone() {
        let s = read("✻ Simmering… (esc to interrupt)\n  ⎿  Waiting for API response · will retry in 3s · check your network\n");
        assert_eq!(s.blocked, None);
        assert_eq!(s.warning, None);
        assert_eq!(
            s.stalled.as_deref(),
            Some("Waiting for API response · will retry in 3s · check your network")
        );
        // …and a stall that has since scrolled away is history, like every other
        // reading in this module.
        let mut old = String::from("  ⎿  Waiting for API response · will retry in 3s\n");
        for i in 0..25 {
            old.push_str(&format!("● line {i}\n"));
        }
        assert_eq!(read(&old).stalled, None);
    }

    #[test]
    fn every_wedge_token_is_recognised() {
        for (wedge, tokens) in WEDGES {
            for token in *tokens {
                assert_eq!(startup_wedge(token), Some(*wedge), "{token}");
            }
        }
    }
}

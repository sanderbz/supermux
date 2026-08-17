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
}

/// What one capture says about the session's ability to work.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PtyState {
    pub blocked: Option<Blocked>,
    /// The dim footer line Claude Code prints at ≥70 % utilisation, verbatim.
    /// A chip, never a block — the session still works.
    pub warning: Option<String>,
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

/// The tool-result gutter Claude Code draws the banner in, plus the indent.
static CONTINUATION_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\s⎿·└│]+").unwrap());

/// A line that is only box-drawing — the terminal's own framing.
static RULE_ONLY: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\s─━╌┄┈╍-]+$").unwrap());

/// A numbered dialog row, which is never a banner's remediation subline.
static OPTION_ROW: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*(?:❯\s*)?\d+\.\s+\S").unwrap());

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
            }),
            warning: None,
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
                    }),
                    warning: None,
                };
            }
        }
    }

    for i in (from..=tail).rev() {
        if let Some(m) = LIMIT_WARN.find(lines[i]) {
            return PtyState {
                blocked: None,
                warning: Some(clean(m.as_str())),
            };
        }
    }
    PtyState::default()
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
    fn every_wedge_token_is_recognised() {
        for (wedge, tokens) in WEDGES {
            for token in *tokens {
                assert_eq!(startup_wedge(token), Some(*wedge), "{token}");
            }
        }
    }
}

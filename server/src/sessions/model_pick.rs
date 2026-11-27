//! Switching the MAIN agent's model from the chat header — the pure half.
//!
//! Claude Code has exactly two ways to change a running session's model, and
//! they differ in what they do to every LATER session (live-verified on Claude
//! Code 2.1.326 against a throwaway `CLAUDE_CONFIG_DIR`, 2026-11-27):
//!
//!   * `/model <alias>` switches at once, with no picker, and answers
//!     `Set model to Sonnet 5.5 and saved as your default for new sessions` —
//!     it writes `"model": "sonnet"` into the config dir's `settings.json`.
//!     There is no argument form that skips the save: `/model haiku --session`
//!     answers `Model 'haiku--session' not found`.
//!   * the bare `/model` picker. Its legend reads `Enter to set as default · s
//!     to use this session only · Esc to cancel`; `s` on a row answers `Set
//!     model to Fable 5.2 for this session only` and leaves `settings.json`
//!     untouched. That is the ONLY session-only path a running session has.
//!
//! So a session-only pick has to drive the picker, and driving a picker blind
//! is how a keystroke lands on the wrong row. What the probe showed about it:
//!
//!   * the cursor opens on the CURRENT model's row, not on row 1;
//!   * Up/Down WRAP (8×Up from row 2 of 5 landed on row 4), so "press Up a lot
//!     to reach the top" is not an anchor;
//!   * typing a letter does not filter, and a DIGIT selects that row at once
//!     AND saves it as the default (`2` → `…saved as your default…`) — so a
//!     digit is never sent from here;
//!   * `Esc` closes it with `Kept model as Opus 5.5` and changes nothing.
//!
//! The row set and its labels differ by ACCOUNT, not only by version. Logged
//! out, the rows are `1. Opus` … with the version in the description. A
//! logged-in account (captured from a real session, `real-picker-capture`
//! below) draws `1.  Opus 5.5 ✔` — version in the label, two spaces after the
//! number, a description that names OTHER models (`Default (recommended)`'s
//! says `Opus 5.5 · …`), and an unnumbered `▸   More models` row at the end.
//! Hence rows are matched by FAMILY against the label column only
//! ([`family_matches`]), never by description and never by position.
//!
//! Hence too: read the picker off the screen ([`parse_picker`]), move ONE key
//! at a time and re-read until the cursor is where that key should have put
//! it, require two identical reads on the target, and only then press `s`.

/// The model families the header picker offers. Aliases, not ids: an alias
/// follows Claude Code's own "latest for your provider" resolution, which is
/// what a person picking "Opus" means, and it is also exactly what the picker
/// rows are labelled with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Alias {
    Opus,
    Fable,
    Sonnet,
    Haiku,
}

impl Alias {
    /// Parse the wire token. A closed set on purpose: the token is typed into
    /// the agent's composer (`/model <alias>`), so nothing outside it may pass.
    pub fn from_token(t: &str) -> Option<Self> {
        match t {
            "opus" => Some(Self::Opus),
            "fable" => Some(Self::Fable),
            "sonnet" => Some(Self::Sonnet),
            "haiku" => Some(Self::Haiku),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Opus => "opus",
            Self::Fable => "fable",
            Self::Sonnet => "sonnet",
            Self::Haiku => "haiku",
        }
    }

    /// The family word Claude Code labels this alias with.
    pub fn label(self) -> &'static str {
        match self {
            Self::Opus => "Opus",
            Self::Fable => "Fable",
            Self::Sonnet => "Sonnet",
            Self::Haiku => "Haiku",
        }
    }
}

/// Where a pick should land: Claude Code's normal "this becomes the default"
/// (`/model <alias>`), or this session only (the picker's `s`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Session,
    Default,
}

impl Scope {
    pub fn from_token(t: &str) -> Option<Self> {
        match t {
            "session" => Some(Self::Session),
            "default" => Some(Self::Default),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Default => "default",
        }
    }
}

/// The picker's title line — what tells this picker apart from every other
/// numbered dialog Claude Code draws.
pub const TITLE: &str = "Select model";
/// The legend half that proves this CLI has a session-only key at all. Without
/// it, `s` means nothing we have watched work, so it is never pressed.
pub const SESSION_ONLY_LEGEND: &str = "s to use this session only";

/// Does a label (or an answer's model name) belong to `family`? The family
/// word, case-insensitively, followed by the end, a space (`Sonnet 5.5`) or a
/// closing backtick. `Default (recommended)` never matches anything, and
/// `Opusculum` does not match `Opus`.
pub fn family_matches(label: &str, family: &str) -> bool {
    let l = label.trim_start_matches('`');
    l.len() >= family.len()
        && l.is_char_boundary(family.len())
        && l[..family.len()].eq_ignore_ascii_case(family)
        && l[family.len()..]
            .chars()
            .next()
            .map_or(true, |c| c == ' ' || c == '`')
}

/// One `/model` picker, as read off a capture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picker {
    /// The LABEL column of each numbered row, top to bottom (`Default
    /// (recommended)`, `Opus 5.5`, …), the `✔` tick removed.
    pub rows: Vec<String>,
    /// Index into `rows` of the row the `❯` cursor is on.
    pub cursor: usize,
    /// The legend offers the session-only key.
    pub session_only: bool,
}

impl Picker {
    /// The index of the one row whose label is in `family`. Two rows in one
    /// family is a screen this reader does not understand: `None`.
    pub fn row_of(&self, family: &str) -> Option<usize> {
        let mut hits = self
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| family_matches(r, family));
        let (i, _) = hits.next()?;
        hits.next().is_none().then_some(i)
    }
}

/// Read the `/model` picker off a plain (ANSI-stripped) capture, or `None` when
/// it is not on screen or its rows cannot be read with certainty.
///
/// Only the LAST `Select model` title counts, so an older picker left in the
/// scrollback can never be mistaken for the live one. The rows are the
/// `N. Label   description` lines under it; exactly one of them must carry the
/// cursor (a cursor on the unnumbered `More models` row reads as none), or the
/// read is refused rather than guessed.
pub fn parse_picker(screen: &str) -> Option<Picker> {
    let lines: Vec<&str> = screen.lines().collect();
    let title = lines.iter().rposition(|l| l.trim() == TITLE)?;
    let mut rows = Vec::new();
    let mut cursor = None;
    for line in &lines[title + 1..] {
        // The legend closes the picker. Everything between the title and it that
        // is not a numbered row is prose: the subtitle, the `▸ More models` row,
        // and — in a narrow pane — each row's description WRAPPED into its own
        // column on the lines under the row.
        if line.contains("Esc to cancel") || line.contains("Enter to ") {
            break;
        }
        let t = line.trim_start();
        let (on_cursor, rest) = match t.strip_prefix('❯') {
            Some(r) => (true, r.trim_start()),
            None => (false, t),
        };
        let Some((num, label)) = row_label(rest) else {
            continue;
        };
        // Rows count 1, 2, 3 … with nothing skipped or repeated; anything else
        // is a screen this reader does not understand, so it says so.
        if num != rows.len() + 1 {
            return None;
        }
        if on_cursor {
            if cursor.is_some() {
                return None;
            }
            cursor = Some(rows.len());
        }
        rows.push(label);
    }
    let cursor = cursor?;
    // The legend wraps too in a narrow pane, so read it with the line breaks
    // folded back into spaces.
    let tail = lines[title..]
        .iter()
        .map(|l| l.trim())
        .collect::<Vec<_>>()
        .join(" ");
    Some(Picker {
        rows,
        cursor,
        session_only: tail.contains(SESSION_ONLY_LEGEND),
    })
}

/// `3.  Fable 5.2 ✔   For your toughest …` → `(3, "Fable 5.2")`. One or more
/// spaces after the number; the label is the first cell, up to the first run
/// of two spaces (the column gap before the description).
fn row_label(rest: &str) -> Option<(usize, String)> {
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return None;
    }
    let num = rest[..digits].parse().ok()?;
    let after = rest[digits..].strip_prefix('.')?;
    if !after.starts_with(' ') {
        return None;
    }
    let label = after.trim_start().split("  ").next()?.replace('✔', "");
    let label = label.trim();
    (!label.is_empty()).then(|| (num, label.to_string()))
}

/// Is the picker (or what is left of it) still on screen? Its title, or its
/// legend when a short pane has clipped the title off the top.
pub fn picker_visible(screen: &str) -> bool {
    screen.lines().any(|l| l.trim() == TITLE)
        || screen.contains(SESSION_ONLY_LEGEND)
        || screen
            .lines()
            .any(|l| l.trim_end().ends_with("Esc to cancel"))
}

/// A slash-command completion menu highlighting something OTHER than
/// `/model` — the one way a pasted `/model` + Enter could run a different
/// command. Live on 2.1.326 with a user `/model-review` and a project
/// `/modeler` installed, an exact `/model` stayed the highlighted row, and a
/// trailing space (`/model `, which is what this module types) closes the menu
/// altogether; this is the belt to those braces. Returns the highlighted row.
pub fn stray_completion(screen: &str) -> Option<String> {
    screen.lines().find_map(|l| {
        // Menu rows are indented; the composer and the echoes of earlier
        // commands (`❯ /clear`) sit at column 0 and are not a menu.
        if !l.starts_with(' ') {
            return None;
        }
        let rest = l.trim_start().strip_prefix('❯')?.trim_start();
        let cmd = rest.split_whitespace().next()?;
        (cmd.starts_with('/') && cmd != "/model").then(|| rest.trim().to_string())
    })
}

/// The beginnings of every answer `/model` was seen to give on 2.1.326 — a
/// switch, an Esc, and the two refusals of an argument it cannot use.
const ANSWER_PREFIXES: &[&str] = &[
    "Set model to ",
    "Kept model as ",
    "Model '",
    "Unable to validate model",
];

/// The `/model` answer lines on a capture, oldest first: `⎿` lines that start
/// like an answer to `/model`. Counted before and after a pick, so only an
/// answer that is NEW can say anything about this pick.
///
/// Only answer-shaped lines count, because `⎿` is not only answers: live on
/// 2.1.326 a `⎿  Tip: Use Plan Mode …` line is drawn under a running command
/// and then removed — read as "the answer", it turned a confirmed default pick
/// into an error, and its coming and going would shift a plain count.
pub fn answers(capture: &str) -> Vec<String> {
    capture
        .lines()
        .filter_map(|l| l.trim_start().strip_prefix('⎿'))
        .map(str::trim)
        .filter(|a| ANSWER_PREFIXES.iter().any(|p| a.starts_with(p)))
        .map(str::to_string)
        .collect()
}

/// What Claude Code's answer to the pick says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// `Set model to <the family we asked for> <the scope we asked for>`.
    Confirmed,
    /// `Kept model as …` — the picker closed with nothing changed.
    Kept(String),
    /// Anything else: another model, the other scope, `Model 'x' not found`,
    /// `Unable to validate model: …`. Carried verbatim to the caller.
    Other(String),
}

/// Classify a NEW answer line against the pick that was made. The model name
/// may be quoted (`` `Fable 5.2` `` in the transcript) or not (the screen), and
/// may carry `(default)` when the Default row was the pick.
pub fn classify_answer(answer: &str, family: &str, scope: Scope) -> Answer {
    if answer.starts_with("Kept model as") {
        return Answer::Kept(answer.to_string());
    }
    let Some(rest) = answer.strip_prefix("Set model to ") else {
        return Answer::Other(answer.to_string());
    };
    let scoped = match scope {
        Scope::Session => rest.contains("for this session only"),
        Scope::Default => rest.contains("saved as your default"),
    };
    if scoped && family_matches(rest, family) {
        Answer::Confirmed
    } else {
        Answer::Other(answer.to_string())
    }
}

/// The key that moves the cursor ONE row from `from` towards `to`, or `None`
/// when it is already there. Never relies on the wrap.
pub fn step(from: usize, to: usize) -> Option<&'static str> {
    match from.cmp(&to) {
        std::cmp::Ordering::Less => Some("Down"),
        std::cmp::Ordering::Greater => Some("Up"),
        std::cmp::Ordering::Equal => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The LOGGED-IN picker, verbatim from the user's real session (~115 cols,
    /// scratchpad `real-picker-capture.txt`): versions in the labels, two
    /// spaces after the number, a description on row 1 naming Opus, and an
    /// unnumbered `More models` row.
    const REAL: &str = "\
  Select model
  Switch between Claude models. Your pick becomes the default for new sessions. For other or older models, use
  --model.

    1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks
  ❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks
    3.  Fable 5.2              For your toughest challenges
    4.  Sonnet 5.5             Most efficient for simpler tasks
    5.  Haiku 5.5              Fastest for quick answers
    ▸   More models

  ◐ Medium effort (default) ←/→ to adjust

  Enter to set as default · s to use this session only · Esc to cancel";

    #[test]
    fn reads_the_logged_in_picker_by_label_column_and_family() {
        let p = parse_picker(REAL).expect("picker on screen");
        assert_eq!(
            p.rows,
            [
                "Default (recommended)",
                "Opus 5.5",
                "Fable 5.2",
                "Sonnet 5.5",
                "Haiku 5.5"
            ]
        );
        assert_eq!(p.cursor, 1);
        assert!(p.session_only);
        assert_eq!(
            p.row_of("Opus"),
            Some(1),
            "never row 1, whose DESCRIPTION says Opus 5.5"
        );
        assert_eq!(p.row_of("Sonnet"), Some(3));
        assert_eq!(p.row_of("Fable"), Some(2));
        assert_eq!(p.row_of("Haiku"), Some(4));
        assert_eq!(p.row_of("More"), None, "the unnumbered row is not a row");
    }

    #[test]
    fn a_cursor_on_more_models_reads_as_no_cursor() {
        let moved = REAL
            .replace("  ❯ 2.  Opus", "    2.  Opus")
            .replace("    ▸   More", "  ❯ ▸   More");
        assert_eq!(parse_picker(&moved), None);
    }

    /// The logged-in picker in a 60-column pane. NOT a live capture (no
    /// logged-in CLI here): `fake-model.py --logged-in` rendered at 60 cols,
    /// wrapping the way the logged-out picker was SEEN to wrap at 60 cols.
    const REAL_NARROW: &str = "\
  Select model
  Switch between Claude models. Your pick becomes the
  default for new sessions. For other or older models, use
  --model.

    1.  Default (recommended)  Opus 5.5 · Best for
                               everyday, complex tasks
  ❯ 2.  Opus 5.5 ✔             For complex work and
                               everyday tasks
    3.  Fable 5.2              For your toughest
                               challenges
    4.  Sonnet 5.5             Most efficient for
                               simpler tasks
    5.  Haiku 5.5              Fastest for quick answers
    ▸   More models

  ◐ Medium effort (default) ←/→ to adjust

  Enter to set as default · s to use this session only ·
  Esc to cancel";

    #[test]
    fn reads_the_logged_in_picker_wrapped_narrow() {
        let p = parse_picker(REAL_NARROW).expect("picker on screen");
        assert_eq!(p.rows.len(), 5);
        assert_eq!((p.cursor, p.row_of("Sonnet")), (1, Some(3)));
        assert!(p.session_only);
    }

    /// The LOGGED-OUT picker exactly as Claude Code 2.1.326 drew it (140 cols).
    const PICKER: &str = "\
❯ /model
────────────────────────────────────────────────────────────────
  Select model
  Switch between Claude models. Your pick becomes the default for new sessions. For other or older models, use --model.

    1. Default (recommended)  Use the default model (currently Opus 5.5) · $4/$20 per Mtok
    2. Opus                   Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok
    3. Fable                  Fable 5.2 · Most capable for your hardest and longest-running tasks · $8/$40 per Mtok
  ❯ 4. Sonnet ✔               Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok
    5. Haiku                  Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok

  ◐ Medium effort (default) ←/→ to adjust

  Enter to set as default · s to use this session only · Esc to cancel";

    #[test]
    fn reads_the_logged_out_picker() {
        let p = parse_picker(PICKER).expect("picker on screen");
        assert_eq!(
            p.rows,
            ["Default (recommended)", "Opus", "Fable", "Sonnet", "Haiku"]
        );
        assert_eq!(
            p.cursor, 3,
            "the cursor opens on the current model, not row 1"
        );
        assert!(p.session_only);
        assert_eq!(p.row_of("fable"), Some(2));
    }

    /// The logged-out picker in a 60-column pane, live on 2.1.326: every
    /// description wraps into its own column, the legend across two lines.
    const NARROW: &str = "\
❯ /model
────────────────────────────────────────────────────────────
  Select model
  Switch between Claude models. Your pick becomes the
  default for new sessions. For other or older models, use
  --model.
    1. Default (recommended)  Use the default model
                              (currently Opus 5.5) ·
                              $4/$20 per Mtok
  ❯ 2. Opus ✔                 Opus 5.5 · Best for
                              everyday, complex tasks ·
                              $4/$20 per Mtok
    3. Fable                  Fable 5.2 · Most capable for
                              your hardest and
                              longest-running tasks ·
                              $8/$40 per Mtok
    4. Sonnet                 Sonnet 5.5 · Efficient for
                              routine tasks · $2/$10 per
                              Mtok
    5. Haiku                  Haiku 5.5 · Fastest for
                              quick answers · $0.10/$0.50
                              per Mtok ($0.50/$2.50 for
                              prompts over 100k)
  ◐ Medium effort (default) ←/→ to adjust
  Enter to set as default · s to use this session only ·
  Esc to cancel";

    #[test]
    fn reads_the_picker_when_a_narrow_pane_wraps_every_description() {
        let p = parse_picker(NARROW).expect("picker on screen");
        assert_eq!(
            p.rows,
            ["Default (recommended)", "Opus", "Fable", "Sonnet", "Haiku"]
        );
        assert_eq!(p.cursor, 1);
        assert!(p.session_only);
        let split = NARROW.replace(
            "s to use this session only ·",
            "s to use this session\n  only ·",
        );
        assert!(parse_picker(&split).unwrap().session_only);
    }

    #[test]
    fn rows_that_do_not_count_up_from_one_are_refused() {
        assert_eq!(
            parse_picker(&PICKER.replace("    3. Fable", "    7. Fable")),
            None
        );
    }

    #[test]
    fn a_picker_without_the_session_only_legend_says_so() {
        let old = PICKER.replace(" · s to use this session only", "");
        assert!(!parse_picker(&old).unwrap().session_only);
    }

    #[test]
    fn no_title_or_no_cursor_is_no_picker() {
        assert_eq!(parse_picker("❯ \n  ? for shortcuts"), None);
        assert_eq!(
            parse_picker(&PICKER.replace("Select model", "Select a thing")),
            None
        );
        assert_eq!(parse_picker(&PICKER.replace("  ❯ 4.", "    4.")), None);
        assert_eq!(
            parse_picker("Do you want to proceed?\n❯ 1. Yes\n  2. No"),
            None
        );
    }

    #[test]
    fn only_the_last_picker_on_the_screen_counts() {
        let stale = PICKER
            .replace("  ❯ 4. Sonnet ✔", "    4. Sonnet ✔")
            .replace("    2. Opus ", "  ❯ 2. Opus ");
        let both = format!("{stale}\n  ⎿  Kept model as Sonnet 5.5\n{PICKER}");
        assert_eq!(parse_picker(&both).unwrap().cursor, 3);
    }

    #[test]
    fn family_matching_is_the_label_head_only() {
        assert!(family_matches("Sonnet 5.5", "sonnet"));
        assert!(family_matches("Sonnet", "Sonnet"));
        assert!(family_matches("`Fable 5.2` for this session only", "Fable"));
        assert!(!family_matches("Default (recommended)", "Opus"));
        assert!(!family_matches("Opusculum", "Opus"));
        assert!(!family_matches("Op", "Opus"));
    }

    #[test]
    fn the_picker_is_visible_by_title_or_by_a_clipped_legend() {
        assert!(picker_visible(PICKER));
        assert!(picker_visible("    5. Haiku …\n  Enter to set as default · s to use this session only · Esc to cancel"));
        assert!(picker_visible(
            "  Enter to set as default · s to use this session\n  only · Esc to cancel"
        ));
        assert!(!picker_visible("❯ \n  ⏵⏵ auto mode on"));
    }

    #[test]
    fn a_completion_menu_highlighting_another_command_is_caught() {
        // Live on 2.1.326 with `/model-review` (user) and `/modeler` (project)
        // installed: the exact `/model` stays highlighted — fine.
        let ok = "  ❯ /model                      Set the AI model for Claude Code\n    /modeler                    project modeler (project)";
        assert_eq!(stray_completion(ok), None);
        assert_eq!(stray_completion("❯ /model  [model]"), None);
        let bad = "    /model                      Set the AI model\n  ❯ /modeler                    project modeler (project)";
        assert_eq!(
            stray_completion(bad).as_deref(),
            Some("/modeler                    project modeler (project)")
        );
        assert_eq!(stray_completion("❯ "), None);
        assert_eq!(
            stray_completion("❯ /clear\n  ⎿  (no content)\n❯ /model "),
            None
        );
    }

    #[test]
    fn answers_are_read_and_classified_against_the_pick() {
        // A transient tip under the running command is not an answer.
        let tip = "❯ /model sonnet\n  ⎿  Tip: Use Plan Mode to prepare for a complex request\n";
        assert!(answers(tip).is_empty());
        assert_eq!(
            answers("  ⎿  Model 'nope' not found\n  ⎿  Unable to validate model: no auth"),
            [
                "Model 'nope' not found",
                "Unable to validate model: no auth"
            ]
        );
        let cap = "❯ /model\n  ⎿  Set model to Fable 5.2 for this session only\n\n❯ ";
        assert_eq!(
            answers(cap),
            ["Set model to Fable 5.2 for this session only"]
        );
        let a = |s: &str, f: &str, sc: Scope| classify_answer(s, f, sc);
        assert_eq!(
            a(
                "Set model to Fable 5.2 for this session only",
                "Fable",
                Scope::Session
            ),
            Answer::Confirmed
        );
        // The logged-in spelling and the transcript's backticks both confirm.
        assert_eq!(
            a(
                "Set model to Sonnet 5.5 for this session only",
                "sonnet",
                Scope::Session
            ),
            Answer::Confirmed
        );
        assert_eq!(
            a(
                "Set model to `Sonnet 5.5` and saved as your default for new sessions",
                "Sonnet",
                Scope::Default
            ),
            Answer::Confirmed
        );
        // Wrong scope, wrong model, an Esc, an error: never a confirmation.
        assert!(matches!(
            a(
                "Set model to Fable 5.2 for this session only",
                "Fable",
                Scope::Default
            ),
            Answer::Other(_)
        ));
        assert!(matches!(
            a(
                "Set model to Opus 5.5 for this session only",
                "Fable",
                Scope::Session
            ),
            Answer::Other(_)
        ));
        assert!(matches!(
            a(
                "Set model to Opus 5.5 (default) for this session only",
                "Fable",
                Scope::Session
            ),
            Answer::Other(_)
        ));
        assert!(matches!(
            a("Kept model as Opus 5.5", "Fable", Scope::Session),
            Answer::Kept(_)
        ));
        assert!(matches!(
            a("Model 'x' not found", "Haiku", Scope::Default),
            Answer::Other(_)
        ));
        assert!(matches!(
            a("Unable to validate model: …", "Haiku", Scope::Default),
            Answer::Other(_)
        ));
    }

    #[test]
    fn step_moves_one_row_and_never_relies_on_the_wrap() {
        assert_eq!(step(3, 2), Some("Up"));
        assert_eq!(step(0, 4), Some("Down"));
        assert_eq!(step(2, 2), None);
    }

    #[test]
    fn the_alias_set_is_closed() {
        for t in ["opus", "fable", "sonnet", "haiku"] {
            assert_eq!(Alias::from_token(t).unwrap().as_str(), t);
        }
        for t in [
            "",
            "Opus",
            "opus[1m]",
            "default",
            "haiku; rm -rf /",
            "claude-opus-5-5",
        ] {
            assert_eq!(Alias::from_token(t), None, "{t:?}");
        }
        assert_eq!(Scope::from_token("session"), Some(Scope::Session));
        assert_eq!(Scope::from_token("default"), Some(Scope::Default));
        assert_eq!(Scope::from_token("Session"), None);
    }
}

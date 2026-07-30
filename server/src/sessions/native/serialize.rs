//! Grid → text. Three shapes, all built from the same run-length walker:
//!
//! * **plain** rows — what `tmux capture-pane -p` returns (trailing blanks
//!   trimmed, no escapes). Feeds the status detector and `archive`.
//! * **ANSI** rows — what `tmux capture-pane -pe` returns: each row is
//!   SELF-CONTAINED (opens with a full SGR reset+set, closes with `\x1b[0m`)
//!   so rows can be shipped and rendered independently, which is exactly what
//!   the history-window client does.
//! * **blobs** — a CRLF-joined range plus an optional cursor CUP, i.e. a byte
//!   stream that reproduces the grid when written into a fresh xterm.js.
//!
//! `alacritty_terminal` ships no serializer; this is the spike's hand-written
//! one, ported. The spike's diff harness (every cell of a 24×80 grid compared
//! after a round trip through a virgin `Term`) is ported as a test too — it
//! covers bold/dim/italic/underline/inverse/strike, the 16 named colours, 256
//! indexed, truecolor, CJK + emoji wide chars, combining marks, and cursor
//! visibility.
//!
//! **Wide chars**: a wide cell occupies two columns; the second carries
//! `WIDE_CHAR_SPACER` and is SKIPPED (the char itself was already emitted).
//! **Combining marks** live in the cell's `zerowidth()` list and are appended
//! after the base char. **`WRAPLINE`** is a grid-internal reflow marker, never
//! part of a cell's visible style, so it is masked out of every comparison and
//! never emitted.

use std::fmt::Write as _;

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor};

/// SGR parameter for one colour, as fg (`3x`/`9x`/`38;…`) or bg (`4x`/`10x`/`48;…`).
fn sgr_color(c: Color, fg: bool) -> String {
    let base = if fg { 3 } else { 4 };
    match c {
        Color::Named(n) => match n {
            // The terminal's *default* fg/bg — `39`/`49`.
            NamedColor::Foreground
            | NamedColor::Background
            | NamedColor::BrightForeground
            | NamedColor::DimForeground => format!("{base}9"),
            other => {
                let idx = other as usize;
                if idx < 8 {
                    format!("{base}{idx}")
                } else if idx < 16 {
                    format!("{}{}", if fg { 9 } else { 10 }, idx - 8)
                } else {
                    // Dim*/Cursor variants have no direct SGR — fall back to
                    // the equivalent 256-colour index.
                    format!("{base}8;5;{}", idx % 256)
                }
            }
        },
        Color::Indexed(i) => format!("{base}8;5;{i}"),
        Color::Spec(rgb) => format!("{base}8;2;{};{};{}", rgb.r, rgb.g, rgb.b),
    }
}

/// SGR parameters for the style flags of a cell.
fn flag_sgr(flags: Flags) -> Vec<&'static str> {
    let mut v = Vec::new();
    if flags.contains(Flags::BOLD) {
        v.push("1");
    }
    if flags.contains(Flags::DIM) {
        v.push("2");
    }
    if flags.contains(Flags::ITALIC) {
        v.push("3");
    }
    if flags.contains(Flags::UNDERLINE) {
        v.push("4");
    }
    if flags.contains(Flags::DOUBLE_UNDERLINE) {
        v.push("21");
    }
    if flags.contains(Flags::UNDERCURL) {
        v.push("4:3");
    }
    if flags.contains(Flags::INVERSE) {
        v.push("7");
    }
    if flags.contains(Flags::HIDDEN) {
        v.push("8");
    }
    if flags.contains(Flags::STRIKEOUT) {
        v.push("9");
    }
    v
}

/// Index one past the last non-default cell of a row — the trailing-blank trim
/// that keeps a capture from being 200 spaces wide per row (and matches
/// `capture-pane`, which also trims).
fn row_end<T>(term: &Term<T>, line: i32) -> usize {
    let cols = term.columns();
    let row = &term.grid()[Line(line)];
    let mut end = cols;
    while end > 0 {
        let cell = &row[Column(end - 1)];
        let default = cell.c == ' '
            && cell.bg == Color::Named(NamedColor::Background)
            && (cell.flags - Flags::WRAPLINE).is_empty();
        if default {
            end -= 1;
        } else {
            break;
        }
    }
    end
}

/// One row as plain text, trailing blanks trimmed.
pub fn row_plain<T>(term: &Term<T>, line: i32) -> String {
    let end = row_end(term, line);
    let row = &term.grid()[Line(line)];
    let mut out = String::with_capacity(end);
    for c in 0..end {
        let cell = &row[Column(c)];
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        out.push(cell.c);
        for zw in cell.zerowidth().unwrap_or(&[]) {
            out.push(*zw);
        }
    }
    out
}

/// One row as SELF-CONTAINED ANSI: every style run opens with `\x1b[0;…m` and
/// the row closes with `\x1b[0m`, so it renders identically no matter what
/// state the receiving terminal was in. This is the `capture-pane -e` shape the
/// history-window client already consumes.
pub fn row_ansi<T>(term: &Term<T>, line: i32) -> String {
    let end = row_end(term, line);
    let row = &term.grid()[Line(line)];
    let mut out = String::new();
    let mut prev: Option<(Color, Color, Flags)> = None;
    for c in 0..end {
        let cell = &row[Column(c)];
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        let key = (cell.fg, cell.bg, cell.flags - Flags::WRAPLINE);
        if prev != Some(key) {
            out.push_str(&sgr_for(key));
            prev = Some(key);
        }
        out.push(cell.c);
        for zw in cell.zerowidth().unwrap_or(&[]) {
            out.push(*zw);
        }
    }
    if prev.is_some() {
        out.push_str("\x1b[0m");
    }
    out
}

/// The full `\x1b[0;…m` introducer for one style key.
fn sgr_for(key: (Color, Color, Flags)) -> String {
    let (fg, bg, flags) = key;
    let mut parts = vec!["0".to_string()];
    parts.extend(flag_sgr(flags).into_iter().map(String::from));
    if fg != Color::Named(NamedColor::Foreground) {
        parts.push(sgr_color(fg, true));
    }
    if bg != Color::Named(NamedColor::Background) {
        parts.push(sgr_color(bg, false));
    }
    format!("\x1b[{}m", parts.join(";"))
}

/// Serialize grid lines `from..=to` (viewport-relative; negative = scrollback)
/// into a CRLF-joined ANSI blob that reproduces the grid when written into a
/// fresh terminal. With `with_cursor`, a trailing CUP puts the cursor where the
/// app left it (and `\x1b[?25l` if it is hidden).
///
/// Unlike [`row_ansi`], style state CARRIES ACROSS rows here (one escape per
/// change, not per row) — it is one stream, not independent rows.
pub fn serialize_range<T>(term: &Term<T>, from: i32, to: i32, with_cursor: bool) -> String {
    let mut out = String::new();
    out.push_str("\x1b[H\x1b[2J\x1b[0m");
    let mut prev: Option<(Color, Color, Flags)> = None;
    for line in from..=to {
        let end = row_end(term, line);
        let row = &term.grid()[Line(line)];
        for c in 0..end {
            let cell = &row[Column(c)];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let key = (cell.fg, cell.bg, cell.flags - Flags::WRAPLINE);
            if prev != Some(key) {
                out.push_str(&sgr_for(key));
                prev = Some(key);
            }
            out.push(cell.c);
            for zw in cell.zerowidth().unwrap_or(&[]) {
                out.push(*zw);
            }
        }
        if line != to {
            out.push_str("\r\n");
        }
    }
    out.push_str("\x1b[0m");

    if with_cursor {
        let cur = term.grid().cursor.point;
        let row_in_dump = cur.line.0 - from + 1;
        let _ = write!(out, "\x1b[{};{}H", row_in_dump, cur.column.0 + 1);
        if !term.mode().contains(TermMode::SHOW_CURSOR) {
            out.push_str("\x1b[?25l");
        }
    }
    out
}

/// Strip the SGR escapes this module emits, recovering the plain text of an
/// [`row_ansi`] row. Exact (not a general ANSI stripper) because we only ever
/// produce `\x1b[…m`; used to serve plain captures from the alt-screen history
/// snapshot without storing a second copy of every row.
pub fn strip_sgr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        // `\x1b[` … final byte in 0x40..=0x7e.
        match chars.next() {
            Some('[') => {
                for f in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&f) {
                        break;
                    }
                }
            }
            Some(other) => out.push(other),
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::term::cell::Cell;
    use alacritty_terminal::term::test::TermSize;
    use alacritty_terminal::term::Config;
    use alacritty_terminal::vte::ansi::Processor;

    fn term_with(input: &str) -> Term<VoidListener> {
        let mut t = Term::new(Config::default(), &TermSize::new(80, 24), VoidListener);
        let mut p: Processor = Processor::new();
        p.advance(&mut t, input.as_bytes());
        t
    }

    /// The spike's cell-by-cell round-trip harness, as a test: serialize a grid,
    /// feed the bytes into a VIRGIN terminal, and require every one of the 1920
    /// cells to match on char, fg, bg, style flags and combining marks.
    #[test]
    fn serializer_round_trip_is_cell_identical_for_the_hard_case() {
        let hard = concat!(
            "\x1b[1;31mbold red\x1b[0m \x1b[4;32munderline green\x1b[0m\r\n",
            "\x1b[38;5;208m256-orange\x1b[0m \x1b[48;5;27m256-bg-blue\x1b[0m\r\n",
            "\x1b[38;2;255;100;50mtruecolor-fg\x1b[0m \x1b[48;2;10;80;160mtruecolor-bg\x1b[0m\r\n",
            "\x1b[7mreverse\x1b[0m \x1b[2mdim\x1b[0m \x1b[3mitalic\x1b[0m \x1b[9mstrike\x1b[0m\r\n",
            "wide: \u{4f60}\u{597d}\u{4e16}\u{754c} emoji: \u{1f680}\u{1f525} combining: e\u{0301}a\u{0300}\r\n",
            "\x1b[1;34mdir\x1b[0m  \x1b[1;32mexec\x1b[0m  \x1b[36msym\x1b[0m  plain\r\n",
            "\x1b[?25l",
            "\x1b[12;10Hcursor-parked-here",
        );
        let src = term_with(hard);
        let dump = serialize_range(&src, 0, 23, true);

        let mut back = Term::new(Config::default(), &TermSize::new(80, 24), VoidListener);
        let mut p: Processor = Processor::new();
        p.advance(&mut back, dump.as_bytes());

        let mut diffs = Vec::new();
        for l in 0..24i32 {
            for c in 0..80usize {
                let a: &Cell = &src.grid()[Line(l)][Column(c)];
                let b: &Cell = &back.grid()[Line(l)][Column(c)];
                let (fa, fb) = (a.flags - Flags::WRAPLINE, b.flags - Flags::WRAPLINE);
                if a.c != b.c
                    || a.fg != b.fg
                    || a.bg != b.bg
                    || fa != fb
                    || a.zerowidth() != b.zerowidth()
                {
                    diffs.push((l, c, a.c, b.c));
                }
            }
        }
        assert!(diffs.is_empty(), "{} cells differ: {:?}", diffs.len(), &diffs[..diffs.len().min(6)]);
        assert_eq!(
            src.grid().cursor.point,
            back.grid().cursor.point,
            "cursor must survive the round trip",
        );
        assert_eq!(
            src.mode().contains(TermMode::SHOW_CURSOR),
            back.mode().contains(TermMode::SHOW_CURSOR),
            "hidden cursor must survive the round trip",
        );
    }

    #[test]
    fn row_ansi_is_self_contained_and_row_plain_trims_trailing_blanks() {
        let t = term_with("\x1b[32mrow-0007\x1b[0m payload\r\n");
        let row = row_ansi(&t, 0);
        assert!(row.starts_with("\x1b[0;32m"), "opens with a full reset+set: {row:?}");
        assert!(row.ends_with("\x1b[0m"), "closes with a reset: {row:?}");
        assert_eq!(strip_sgr(&row), "row-0007 payload");
        assert_eq!(row_plain(&t, 0), "row-0007 payload");
        // A blank row is the empty string, not 80 spaces.
        assert_eq!(row_plain(&t, 5), "");
        assert_eq!(row_ansi(&t, 5), "");
    }

    #[test]
    fn strip_sgr_leaves_text_and_wide_chars_untouched() {
        assert_eq!(strip_sgr("plain"), "plain");
        assert_eq!(strip_sgr("\x1b[0;1;31mred\x1b[0m"), "red");
        assert_eq!(strip_sgr("\u{4f60}\u{597d} \u{1f680}"), "\u{4f60}\u{597d} \u{1f680}");
    }
}

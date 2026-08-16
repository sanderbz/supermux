//! The daemon-side terminal: `alacritty_terminal`'s `Term` + `Processor`, wrapped
//! with the capture/seed/history surface the rest of supermux already speaks
//! (today served by `tmux capture-pane`).
//!
//! **Sizing.** History is capped at [`HISTORY_LINES`] (2000). Measured in the
//! spike: 9.7 MiB per session at 200×50 with a saturated 2000-line history
//! (vs 46.7 MiB at 10 000 lines) and ~8.6 MiB/s of parse throughput. 2000 lines
//! is well past what the client's scroll-up UI fetches in practice, and unlike
//! tmux this history is *rebuildable* — the holder's spool outlives us.
//!
//! **Alt-screen history.** When an app switches to the alternate screen
//! (`\x1b[?1049h` — vim, htop; Claude Code does NOT, it renders inline on the
//! primary screen) `alacritty_terminal` swaps the grids and `history_size()`
//! goes to 0: the main buffer's scrollback is retained but unreachable through
//! the public API. `Term::swap_alt` cannot be used to peek at it either —
//! swapping BACK takes the `!ALT_SCREEN` branch, which calls
//! `inactive_grid.reset_region(..)` and would wipe the live alt screen. (The
//! spike proved main history *survives* an alt round trip; it never tried to
//! READ it mid-alt, so this is the one spike claim that did not carry over.)
//!
//! So: on the primary→alt transition we snapshot the main scrollback as ANSI
//! rows and serve history from that snapshot for as long as alt is active. This
//! is not an approximation — the main buffer is frozen while alt is up, so the
//! snapshot can never go stale — and it matches tmux, where `-S/-E` on an
//! alt-screen pane returns the primary buffer's history. Cost: one
//! ~2000-row serialization (~10 ms) per alt entry, freed on exit.

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermDamage, TermMode};
use alacritty_terminal::vte::ansi::Processor;

use super::serialize::{row_ansi, row_plain, serialize_range, strip_sgr};
use crate::sessions::tmux::{
    frame_alt_screen_seed, frame_primary_seed_with_cursor, HistoryWindow,
};

/// Scrollback lines retained per session (see the module docs for the memory
/// measurement behind the number).
pub const HISTORY_LINES: usize = 2000;

/// Largest history window served in one request — same ceiling as the tmux
/// path's `Tmux::HISTORY_WINDOW_MAX`, so the client's paging is unchanged.
pub const HISTORY_WINDOW_MAX: u32 = 500;

/// Damaged rows since the last read, for the frame-coalescing scheduler a
/// later slice will build on top of this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Damage {
    /// Repaint everything (a scroll, a resize, an alt-screen swap …).
    Full,
    /// Viewport-relative rows with the damaged column span, inclusive.
    Rows(Vec<DamagedRow>),
}

/// One damaged row (viewport-relative line, inclusive column bounds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DamagedRow {
    /// Viewport row, 0 = top.
    pub line: usize,
    /// Leftmost damaged column.
    pub left: usize,
    /// Rightmost damaged column, inclusive.
    pub right: usize,
}

/// Main-buffer scrollback, frozen at the moment the app entered the alt screen.
struct AltHistory {
    /// ANSI rows, oldest → newest. `rows.last()` is scrollback offset `-1`.
    rows: Vec<String>,
    /// Grid width when the snapshot was taken.
    cols: u16,
}

/// The sequences that switch a terminal INTO the alternate screen. The
/// snapshot has to be taken BEFORE these are parsed — once the grids are
/// swapped the main scrollback is gone from the public API — so [`Vt::advance`]
/// splits its input here.
const ALT_ENTER: [&[u8]; 3] = [b"\x1b[?1049h", b"\x1b[?1047h", b"\x1b[?47h"];

/// Longest [`ALT_ENTER`] marker minus one — how many trailing bytes of the
/// previous chunk we must remember to notice a marker split across a chunk
/// boundary.
const ALT_CARRY: usize = 7;

/// The VT. Not `Sync`-friendly by design: callers hold it behind a mutex and
/// keep critical sections short (feeding bytes and serializing are both
/// sub-millisecond at realistic sizes — see the spike's throughput table).
pub struct Vt {
    term: Term<VoidListener>,
    parser: Processor,
    alt_history: Option<AltHistory>,
    /// Tail of the previous chunk, so an alt-enter sequence split across two
    /// reads is still spotted before it is parsed.
    carry: Vec<u8>,
}

impl Vt {
    /// A fresh terminal at `cols`×`rows`.
    pub fn new(cols: u16, rows: u16) -> Self {
        let cfg = Config { scrolling_history: HISTORY_LINES, ..Default::default() };
        let size = TermSize::new(cols.max(1) as usize, rows.max(1) as usize);
        Self {
            term: Term::new(cfg, &size, VoidListener),
            parser: Processor::new(),
            alt_history: None,
            carry: Vec::new(),
        }
    }

    /// Feed pty bytes. Resumable across chunk boundaries (a split escape
    /// sequence is carried in the parser), so callers pass whatever the socket
    /// handed them.
    ///
    /// The one thing this does beyond `Processor::advance`: when the chunk
    /// switches the app INTO the alternate screen, the feed is split at the
    /// switch so the main scrollback can be snapshotted while it is still
    /// reachable (see the module docs). A marker straddling two chunks is
    /// caught via [`Vt::carry`], and snapshotting at the head of the second
    /// chunk is still exact — an escape sequence writes no cells.
    pub fn advance(&mut self, bytes: &[u8]) {
        if self.alt_active() {
            self.parser.advance(&mut self.term, bytes);
        } else {
            match self.alt_enter_at(bytes) {
                Some(idx) => {
                    self.parser.advance(&mut self.term, &bytes[..idx]);
                    self.alt_history = Some(self.snapshot_history());
                    self.parser.advance(&mut self.term, &bytes[idx..]);
                }
                None => self.parser.advance(&mut self.term, bytes),
            }
        }
        // Left the alt screen (possibly within this very chunk) → the live grid
        // owns the history again.
        if !self.alt_active() {
            self.alt_history = None;
        }
        self.slide_carry(bytes);
    }

    /// Keep the last [`ALT_CARRY`] bytes of `carry ++ bytes` — a SLIDING
    /// window, not the tail of `bytes` alone.
    ///
    /// Truncating to `bytes`'s own tail only catches a marker split across TWO
    /// reads. A pty hands out whatever the kernel had: `\x1b[?` / `104` / `9h`
    /// across three reads is ordinary, and used to reset the carry to `9h` and
    /// miss the transition entirely — no main-scrollback snapshot, so
    /// `history_size` collapsed to the alt grid's 0 while the TUI was up and
    /// the client's scrollback vanished. Sliding makes the detector independent
    /// of chunk boundaries, down to one byte per read.
    fn slide_carry(&mut self, bytes: &[u8]) {
        self.carry.extend_from_slice(bytes);
        let excess = self.carry.len().saturating_sub(ALT_CARRY);
        if excess > 0 {
            self.carry.drain(..excess);
        }
    }

    /// Index in `bytes` at which the earliest alt-enter sequence begins, or 0
    /// when one straddles the previous chunk boundary. `None` if there is none.
    fn alt_enter_at(&self, bytes: &[u8]) -> Option<usize> {
        let mut hay = Vec::with_capacity(self.carry.len() + bytes.len());
        hay.extend_from_slice(&self.carry);
        hay.extend_from_slice(bytes);
        let mut best: Option<usize> = None;
        for marker in ALT_ENTER {
            if let Some(pos) = hay
                .windows(marker.len())
                .position(|w| w == marker)
                .filter(|p| p + marker.len() > self.carry.len())
            {
                best = Some(best.map_or(pos, |b: usize| b.min(pos)));
            }
        }
        best.map(|pos| pos.saturating_sub(self.carry.len()))
    }

    /// Snapshot the main buffer's scrollback (offsets `-history_size ..= -1`).
    fn snapshot_history(&self) -> AltHistory {
        let hist = self.term.history_size() as i64;
        let rows = (-hist..=-1)
            .map(|off| row_ansi(&self.term, off as i32))
            .collect();
        AltHistory { rows, cols: self.term.columns() as u16 }
    }

    /// Resize + reflow. The spike verified history reflow in both directions
    /// (80→40 splits wrapped rows and grows `history_size`; 40→80 rejoins them)
    /// — the property xterm.js does NOT have and tmux does, and the reason the
    /// grid lives here rather than in the browser.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.term
            .resize(TermSize::new(cols.max(1) as usize, rows.max(1) as usize));
    }

    /// Grid width.
    pub fn cols(&self) -> u16 {
        self.term.columns() as u16
    }

    /// Grid height (viewport rows).
    pub fn rows(&self) -> u16 {
        self.term.screen_lines() as u16
    }

    /// `#{alternate_on}`.
    pub fn alt_active(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    /// DECCKM — the app asked for SS3-encoded cursor keys (`\x1bOA` instead of
    /// `\x1b[A`). Consumed by [`super::keys::key_bytes`].
    pub fn app_cursor(&self) -> bool {
        self.term.mode().contains(TermMode::APP_CURSOR)
    }

    /// `#{history_size}` — main-buffer scrollback rows above the viewport, alt
    /// screen included (served from the snapshot).
    pub fn history_size(&self) -> u32 {
        match &self.alt_history {
            Some(h) => h.rows.len() as u32,
            None => self.term.history_size() as u32,
        }
    }

    /// The width the HISTORY rows are wrapped at.
    ///
    /// While alt is up that is the frozen snapshot's width, not the live grid's
    /// — a resize during a fullscreen TUI reflows the alt grid but cannot
    /// reflow a main buffer we can no longer reach, so the snapshot keeps the
    /// width it was taken at. Reporting the live width instead would describe
    /// the rows [`Vt::history_window`] actually returns incorrectly. Same
    /// choice tmux makes: `capture-pane -S` on an alt pane returns the primary
    /// buffer's rows as they were wrapped.
    pub fn history_cols(&self) -> u16 {
        match &self.alt_history {
            Some(h) => h.cols,
            None => self.cols(),
        }
    }

    /// `(history_size, cols)` — the WS `attach_meta` pair.
    ///
    /// `cols` is [`Vt::history_cols`], NOT the live grid width, so this pair and
    /// [`Vt::history_window`] always describe the same rows at the same width.
    /// They used to disagree during alt-after-resize (live width here, snapshot
    /// width there), which is the kind of inconsistency the client's
    /// width-matching history cache is entitled to treat as corruption.
    pub fn history_meta(&self) -> (u32, u16) {
        (self.history_size(), self.history_cols())
    }

    /// Cursor position as `(x, y)`, viewport-relative and 0-based (tmux's
    /// `#{cursor_x},#{cursor_y}`).
    pub fn cursor(&self) -> (u32, u32) {
        let p = self.term.grid().cursor.point;
        (p.column.0 as u32, p.line.0.max(0) as u32)
    }

    /// Damaged rows since the last call; resets the accumulator. alacritty
    /// UNIONS damage until reset, so several writes between two calls coalesce
    /// into one row set — which is exactly what a frame scheduler wants.
    pub fn take_damage(&mut self) -> Damage {
        let d = match self.term.damage() {
            TermDamage::Full => Damage::Full,
            TermDamage::Partial(it) => Damage::Rows(
                it.map(|b| DamagedRow { line: b.line, left: b.left, right: b.right })
                    .collect(),
            ),
        };
        self.term.reset_damage();
        d
    }

    // ── history access (grid or alt snapshot) ───────────────────────────────

    /// One scrollback row by negative offset (`-1` = just above the viewport).
    fn history_row(&self, off: i64, ansi: bool) -> String {
        match &self.alt_history {
            Some(h) => {
                let idx = h.rows.len() as i64 + off;
                let row = usize::try_from(idx).ok().and_then(|i| h.rows.get(i));
                match (row, ansi) {
                    (Some(r), true) => r.clone(),
                    (Some(r), false) => strip_sgr(r),
                    (None, _) => String::new(),
                }
            }
            None if ansi => row_ansi(&self.term, off as i32),
            None => row_plain(&self.term, off as i32),
        }
    }

    /// Viewport rows, top → bottom.
    fn viewport_rows(&self, ansi: bool) -> Vec<String> {
        (0..self.term.screen_lines() as i32)
            .map(|l| if ansi { row_ansi(&self.term, l) } else { row_plain(&self.term, l) })
            .collect()
    }

    /// `capture-pane -S -<lines>`: `lines` rows of scrollback (clamped to what
    /// exists) followed by the whole visible screen. Trailing blank rows are
    /// dropped, matching tmux — `frame_primary_seed_with_cursor` pads the
    /// visible body back to the pane height, so the seed math is unaffected.
    fn capture(&self, lines: usize, ansi: bool) -> String {
        let hist = self.history_size() as i64;
        let take = (lines as i64).min(hist);
        let mut rows: Vec<String> = (-take..=-1).map(|o| self.history_row(o, ansi)).collect();
        rows.extend(self.viewport_rows(ansi));
        while rows.last().is_some_and(|r| r.is_empty()) {
            rows.pop();
        }
        rows.join("\n")
    }

    /// `tmux capture-pane -p -S -<lines>` — plain text, feeds the status detector.
    pub fn capture_plain(&self, lines: usize) -> String {
        self.capture(lines, false)
    }

    /// `tmux capture-pane -pe -S -<lines>` — SGR-coloured, feeds the tile preview.
    pub fn capture_ansi(&self, lines: usize) -> String {
        self.capture(lines, true)
    }

    /// `tmux capture-pane -p -e` — the CURRENT VISIBLE screen only, coloured.
    /// The WS pre-seed for a subscriber that attaches before any new byte flows.
    pub fn capture_screen_ansi(&self) -> String {
        let mut rows = self.viewport_rows(true);
        while rows.last().is_some_and(|r| r.is_empty()) {
            rows.pop();
        }
        rows.join("\n")
    }

    /// `tmux capture-pane -p -S -` — the ENTIRE history plus the visible
    /// screen, plain. Used by `archive`.
    pub fn capture_full(&self) -> String {
        self.capture(self.history_size() as usize, false)
    }

    /// The alt-screen-AWARE seed for a fresh WS attach, byte-shaped by the SAME
    /// framers the tmux path uses (`frame_primary_seed_with_cursor` /
    /// `frame_alt_screen_seed`), so the client sees one seed contract
    /// regardless of runtime.
    ///
    /// No tmux-style race here: the grid, the cursor and the alt flag are read
    /// from ONE consistent in-memory snapshot under the caller's lock, so the
    /// cursor can never belong to a different frame than the body (the tmux
    /// path needs a second `display-message` probe to approximate this).
    pub fn seed(&self) -> String {
        let hist = self.history_size() as i64;
        let history: Vec<String> = (-hist..=-1).map(|o| self.history_row(o, true)).collect();
        let history = history.join("\n");
        let mut visible = self.viewport_rows(true);
        while visible.last().is_some_and(|r| r.is_empty()) {
            visible.pop();
        }
        let visible = visible.join("\n");
        let (x, y) = self.cursor();
        if self.alt_active() {
            frame_alt_screen_seed(&history, &visible, x, y)
        } else {
            frame_primary_seed_with_cursor(&history, &visible, x, y, self.rows() as u32)
        }
    }

    /// The `capture-pane -e -S start -E end` equivalent: PHYSICAL rows (no
    /// join) at the current width, stamped with `history_size` so the client
    /// can anchor by absolute line id.
    ///
    /// The spike verified the anchor is stable under concurrent output (a row's
    /// absolute id `history_size + offset` still resolves to the same text
    /// after 300 more lines land) and that it DRIFTS once history saturates —
    /// hence `at_limit`, which tells the client to stop trusting cross-fetch
    /// caches. Same field, same meaning as the tmux path.
    pub fn history_window(&self, end_offset: i64, count: u32) -> HistoryWindow {
        let hist = self.history_size() as i64;
        // The width these rows are wrapped at — frozen while alt is up. Kept in
        // lockstep with `history_meta` through the shared accessor, so the two
        // can never drift apart after a resize.
        let cols = self.history_cols();
        let at_limit = self.history_size() as usize >= HISTORY_LINES;
        let count = count.min(HISTORY_WINDOW_MAX) as i64;
        let end = end_offset.min(-1).max(-hist);
        let start = (end - count + 1).max(-hist);
        if hist == 0 || start > end {
            return HistoryWindow {
                rows: vec![],
                history_size: hist as u32,
                start_offset: 0,
                end_offset: 0,
                hit_top: true,
                cols,
                at_limit,
            };
        }
        HistoryWindow {
            rows: (start..=end).map(|o| self.history_row(o, true)).collect(),
            history_size: hist as u32,
            start_offset: start,
            end_offset: end,
            hit_top: start <= -hist,
            cols,
            at_limit,
        }
    }

    /// Whole-grid ANSI blob (history + viewport, CRLF-joined, cursor restored).
    /// Debug/diagnostic counterpart to [`Self::seed`].
    pub fn dump(&self) -> String {
        let hist = self.history_size() as i32;
        serialize_range(&self.term, -hist, self.rows() as i32 - 1, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vt_with(cols: u16, rows: u16, input: &str) -> Vt {
        let mut v = Vt::new(cols, rows);
        v.advance(input.as_bytes());
        v
    }

    #[test]
    fn feeding_in_chunks_matches_feeding_at_once() {
        // A split escape sequence must not corrupt the grid — the pty read loop
        // hands us arbitrary chunk boundaries.
        let input = "\x1b[1;31mred\x1b[0m plain\r\nsecond\r\n";
        let whole = vt_with(80, 24, input);
        let mut split = Vt::new(80, 24);
        for chunk in input.as_bytes().chunks(3) {
            split.advance(chunk);
        }
        assert_eq!(whole.capture_ansi(0), split.capture_ansi(0));
        assert!(split.capture_plain(0).contains("red plain"));
    }

    #[test]
    fn capture_plain_returns_scrollback_then_viewport_like_tmux() {
        let mut v = Vt::new(80, 10);
        for i in 0..100 {
            v.advance(format!("line-{i:03}\r\n").as_bytes());
        }
        // 100 lines into a 10-row grid → 91 in history (the last one is the
        // empty row the cursor sits on).
        assert!(v.history_size() >= 90, "history_size={}", v.history_size());
        let cap = v.capture_plain(5);
        let rows: Vec<&str> = cap.split('\n').collect();
        // 5 scrollback rows + the visible rows, trailing blanks trimmed.
        assert_eq!(rows.len(), 5 + 9, "rows: {rows:?}");
        assert_eq!(rows[0], "line-086");
        assert_eq!(rows[rows.len() - 1], "line-099");
        // Asking for more history than exists clamps instead of erroring.
        assert!(v.capture_plain(10_000).contains("line-000"));
    }

    #[test]
    fn history_window_anchors_by_absolute_id_and_reports_limits() {
        let mut v = Vt::new(80, 24);
        for i in 0..1000 {
            v.advance(format!("\x1b[32mrow-{i:04}\x1b[0m payload\r\n").as_bytes());
        }
        let w = v.history_window(-1, 5);
        assert_eq!(w.rows.len(), 5);
        assert_eq!(w.end_offset, -1);
        assert_eq!(w.start_offset, -5);
        assert!(!w.hit_top);
        assert_eq!(w.cols, 80);
        assert_eq!(strip_sgr(&w.rows[4]), "row-0976 payload");

        // Absolute-id anchoring: the same row must be re-readable at the offset
        // recomputed from the LATEST history_size after more output lands.
        let anchor_abs = w.history_size as i64 + w.start_offset;
        let anchor_text = w.rows[0].clone();
        for i in 1000..1300 {
            v.advance(format!("\x1b[32mrow-{i:04}\x1b[0m payload\r\n").as_bytes());
        }
        let off_now = anchor_abs - v.history_size() as i64;
        assert_eq!(v.history_window(off_now, 1).rows[0], anchor_text);

        // Clamping + hit_top at the very top of the buffer.
        let top = v.history_window(-(v.history_size() as i64), 10);
        assert!(top.hit_top);
        assert_eq!(top.rows.len(), 1);
        // 1300 lines against a 2000-line cap: not at the limit yet.
        assert!(!top.at_limit);
    }

    #[test]
    fn history_window_reports_at_limit_once_the_cap_saturates() {
        let mut v = Vt::new(80, 24);
        for i in 0..(HISTORY_LINES + 200) {
            v.advance(format!("row-{i}\r\n").as_bytes());
        }
        let w = v.history_window(-1, 5);
        assert_eq!(w.history_size as usize, HISTORY_LINES);
        assert!(w.at_limit, "saturated history must flag at_limit");
    }

    #[test]
    fn resize_reflows_history_in_both_directions() {
        let mut v = Vt::new(80, 24);
        for i in 0..50 {
            v.advance(format!("row-{i:02} {}\r\n", "x".repeat(90)).as_bytes());
        }
        let wide_hist = v.history_size();
        let wide_row = v.history_window(-3, 1).rows[0].clone();

        v.resize(40, 24);
        assert_eq!(v.cols(), 40);
        let narrow_hist = v.history_size();
        assert!(
            narrow_hist > wide_hist,
            "narrowing must split wrapped rows: {wide_hist} -> {narrow_hist}",
        );
        // Rows are physical at the CURRENT width — never wider than the grid.
        let narrow_row = v.history_window(-3, 1).rows[0].clone();
        assert!(strip_sgr(&narrow_row).chars().count() <= 40);
        assert_eq!(v.history_window(-3, 1).cols, 40);

        // Widening rejoins them.
        v.resize(80, 24);
        assert_eq!(v.history_size(), wide_hist, "reflow must be reversible");
        assert_eq!(v.history_window(-3, 1).rows[0], wide_row);
    }

    #[test]
    fn alt_screen_keeps_serving_main_history_and_frames_the_seed() {
        let mut v = Vt::new(80, 24);
        for i in 0..100 {
            v.advance(format!("main-{i:03}\r\n").as_bytes());
        }
        let hist_before = v.history_size();
        let window_before = v.history_window(-3, 3);

        v.advance(b"\x1b[?1049h\x1b[2J\x1bH");
        v.advance(b"I AM A FULLSCREEN TUI\r\n");
        assert!(v.alt_active());
        // The alt grid has no scrollback of its own, yet the pane still reports
        // the MAIN buffer's history (tmux semantics), served from the snapshot.
        assert_eq!(v.history_size(), hist_before);
        assert_eq!(v.history_window(-3, 3).rows, window_before.rows);
        // The alt seed frames both buffers.
        let seed = v.seed();
        assert!(seed.starts_with("\x1b[2J\x1b[3J\x1b[H"));
        assert!(seed.contains("\x1b[?1049h\x1b[2J\x1b[H"), "alt switch must be framed");
        assert!(seed.contains("I AM A FULLSCREEN TUI"));
        assert!(seed.contains("main-050"), "main scrollback must precede the alt switch");

        // Leaving alt restores the live grid AND the live history path.
        v.advance(b"\x1b[?1049l");
        assert!(!v.alt_active());
        assert_eq!(v.history_size(), hist_before);
        assert_eq!(v.history_window(-3, 3).rows, window_before.rows);
        let seed = v.seed();
        assert!(!seed.contains("\x1b[?1049h"), "primary seed must not switch buffers");
        // The primary restore is BOTTOM-relative (QA #4): CUU from the last body
        // row (the body is padded to `rows()`), then an absolute column. Never a
        // viewport-relative CUP — the client's grid height is not ours to assume.
        let up = (v.rows() as u32).saturating_sub(1).saturating_sub(v.cursor().1);
        let expected = if up > 0 {
            format!("\x1b[{up}A\x1b[{}G", v.cursor().0 + 1)
        } else {
            format!("\x1b[{}G", v.cursor().0 + 1)
        };
        assert!(seed.ends_with(&expected), "seed tail: {:?}", &seed[seed.len() - 20..]);
    }

    #[test]
    fn an_alt_marker_delivered_one_byte_at_a_time_is_still_caught() {
        // `\x1b[?1049h` is 8 bytes; a pty read can split it anywhere, including
        // into 8 separate chunks. The carry has to SLIDE across all of them,
        // not restart at every chunk.
        for chunk_size in [1usize, 2, 3, 5, 7, 8] {
            let mut v = Vt::new(80, 24);
            for i in 0..100 {
                v.advance(format!("main-{i:03}\r\n").as_bytes());
            }
            let hist_before = v.history_size();
            let window_before = v.history_window(-3, 3).rows;
            assert!(hist_before >= 70, "history_size={hist_before}");

            for chunk in b"\x1b[?1049h".chunks(chunk_size) {
                v.advance(chunk);
            }
            v.advance(b"\x1b[2J\x1b[HFULLSCREEN");
            assert!(v.alt_active(), "chunk_size={chunk_size}: alt never engaged");
            assert_eq!(
                v.history_size(),
                hist_before,
                "chunk_size={chunk_size}: the main-scrollback snapshot was missed",
            );
            assert_eq!(v.history_window(-3, 3).rows, window_before, "chunk_size={chunk_size}");
            assert!(v.seed().contains("main-050"), "chunk_size={chunk_size}");

            // …and leaving alt (also split) hands history back to the grid.
            for chunk in b"\x1b[?1049l".chunks(chunk_size) {
                v.advance(chunk);
            }
            assert!(!v.alt_active(), "chunk_size={chunk_size}");
            assert_eq!(v.history_size(), hist_before, "chunk_size={chunk_size}");
        }
    }

    #[test]
    fn a_stray_prefix_does_not_make_the_sliding_carry_misfire() {
        // The carry must not manufacture a marker out of unrelated bytes, and a
        // marker fully inside the carry must not be re-detected on the next
        // chunk (which would re-snapshot an alt grid as "history").
        let mut v = Vt::new(80, 24);
        v.advance(b"\x1b[?104");
        v.advance(b"7l"); // …not an alt-enter at all
        assert!(!v.alt_active());
        v.advance(b"9h"); // "1049h" is NOT reachable from "…7l9h"
        assert!(!v.alt_active(), "the carry must not stitch a marker out of thin air");

        for i in 0..50 {
            v.advance(format!("row-{i}\r\n").as_bytes());
        }
        let hist = v.history_size();
        v.advance(b"\x1b[?1049h");
        assert!(v.alt_active());
        assert_eq!(v.history_size(), hist);
        // A follow-up chunk must not re-run the snapshot against the alt grid.
        v.advance(b"x");
        assert_eq!(v.history_size(), hist, "the marker was re-detected from the carry");
    }

    #[test]
    fn history_meta_and_history_window_agree_on_width_during_alt() {
        // Enter alt at 80 cols, then resize. The alt grid reflows; the frozen
        // main-buffer snapshot cannot. `attach_meta` must describe the rows
        // `history_window` actually serves, or the client's width guard throws
        // every fetched row away.
        let mut v = Vt::new(80, 24);
        for i in 0..100 {
            v.advance(format!("main-{i:03} {}\r\n", "y".repeat(20)).as_bytes());
        }
        v.advance(b"\x1b[?1049h\x1b[2J\x1b[HTUI");
        assert!(v.alt_active());

        v.resize(40, 20);
        assert_eq!(v.cols(), 40, "the LIVE grid follows the resize");
        let (meta_hist, meta_cols) = v.history_meta();
        let w = v.history_window(-1, 5);
        assert_eq!(meta_cols, 80, "history is still wrapped at the snapshot width");
        assert_eq!(meta_cols, w.cols, "attach_meta and history must not disagree");
        assert_eq!(meta_hist, w.history_size);

        // Back on the primary screen the pair tracks the live grid again.
        v.advance(b"\x1b[?1049l");
        assert_eq!(v.history_meta().1, 40);
        assert_eq!(v.history_window(-1, 5).cols, 40);
    }

    #[test]
    fn damage_unions_scattered_writes_until_taken() {
        let mut v = Vt::new(80, 24);
        v.advance(b"seed\r\n");
        let _ = v.take_damage();

        v.advance(b"\x1b[1;1Ha");
        v.advance(b"\x1b[3;1Hb");
        v.advance(b"\x1b[3;40Hc");
        v.advance(b"\x1b[7;1Hd");
        match v.take_damage() {
            Damage::Rows(rows) => {
                let lines: Vec<usize> = rows.iter().map(|r| r.line).collect();
                assert!(lines.contains(&0) && lines.contains(&2) && lines.contains(&6));
                // Row 2 got two writes → ONE coalesced span covering both.
                let r = rows.iter().find(|r| r.line == 2).unwrap();
                assert!(r.left == 0 && r.right >= 39, "coalesced span: {r:?}");
            }
            Damage::Full => panic!("scattered writes should stay partial"),
        }
        // Taking damage resets the accumulator: the written rows are gone.
        // (alacritty always re-reports the cursor's own cell, so this is "no
        // content damage", not literally an empty set.)
        match v.take_damage() {
            Damage::Rows(rows) => {
                let lines: Vec<usize> = rows.iter().map(|r| r.line).collect();
                assert!(!lines.contains(&0) && !lines.contains(&2), "stale damage: {rows:?}");
            }
            Damage::Full => panic!("reset_damage should not escalate to Full"),
        }
    }

    #[test]
    fn capture_screen_ansi_is_viewport_only() {
        let mut v = Vt::new(80, 5);
        for i in 0..20 {
            v.advance(format!("l{i:02}\r\n").as_bytes());
        }
        let screen = v.capture_screen_ansi();
        assert!(!screen.contains("l00"), "scrollback must not leak into the viewport capture");
        assert!(screen.contains("l19"));
        assert!(screen.split('\n').count() <= 5);
        // capture_full sees everything.
        assert!(v.capture_full().contains("l00"));
    }
}

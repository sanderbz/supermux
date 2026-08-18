// P13 provisional-tail extraction (fase A1 heuristic — master plan §4.2 P13).
//
// The pty capture includes the composer box, spinner, and status hints; the
// provisional block must show only the in-progress PROSE above them. This is
// deliberately a cheap heuristic (dogfood quality checkpoint (c) judges it);
// the reconciliation rule lives in the panel: provisional content is
// DISCARDED AND REPLACED by confirmed transcript entries, never merged.
//
// RELATIVE import so `bun test` runs without alias config; `lib/ansi`'s React
// dependency is type-only (erased at runtime).
import { plain } from '../../lib/ansi'
import { readLens } from './peek-lens'

/** Status-bar / hint noise the tail must never show.
 *
 *  The trailing alternative is a bare HORIZONTAL RULE — `────────`, `╌╌╌╌╌╌` —
 *  the divider Claude Code draws above a plan or a status block. It is
 *  furniture, never prose, and it was the entire content of the "Live terminal ·
 *  unconfirmed" card on eleven of this repo's own live captures.
 *
 *  The last alternative is the status line's MODEL/EFFORT chip — `● high ·
 *  /effort`, `● opus · /model` — which sits below the composer and is the only
 *  row left standing on eight more of them. Claude's own `●` lines are prose
 *  (`● Done.`, `● Bash(…)`); none of them is one word followed by ` · /command`. */
const NOISE =
  /esc to interrupt|shift\+tab|\? for shortcuts|^[⏵⏸✻✽·╰│]|^\s*❯|^[─╌—]{3,}$|^●\s\S+\s·\s\/\w+$/i

/**
 * A shell prompt head — `user@host:/path` — anchored to the start of a line.
 *
 * Its presence means the capture window is showing the pty's SCROLLBACK: the
 * login line and the `claude …` command that launched the session, which sit
 * above the agent's own first paint. The trailing `$` is deliberately NOT
 * required: at 47 columns the prompt wraps, and the observed capture split one
 * logical line into five ("supermux@host:/tmp" / "…/scratch" / "~/.bash_profile
 * 2>/dev/null;" / "/mpx/bin/supermux-edit' VISUA" / "pad") — a pattern that
 * needed the whole prompt matched none of them.
 *
 * The colon must be followed by a path character so an email address in prose
 * ("write to a@b.com: …") is not mistaken for a login line.
 */
const SHELL_PROMPT_HEAD = /^[\w.-]+@[\w.-]+:[~/]/

/**
 * A fragment of the SESSION'S OWN LAUNCH COMMAND, wherever it wrapped.
 *
 * `SHELL_PROMPT_HEAD` only catches the window that still contains the login
 * line. When the launch command is long enough to wrap past the top of a 30-line
 * capture — supermux's is: profile sourcing, an EDITOR wrapper, then
 * `claude --name …` — the head is gone and every surviving row is a mid-word
 * slice of shell. That is what the owner's very first message showed, captioned
 * "Live terminal · unconfirmed" (daily-driver QA #8):
 *
 *   ash_profile 2>/dev/null; sour ermux/.supermux/bin/supermux--edit'; claude --name spike-q
 *
 * Every token below is furniture no agent writes into prose: a redirect, a
 * profile source, an env assignment in front of a command, supermux's own bin
 * path, or the CLI being invoked with a flag. One hit condemns the WHOLE block —
 * a capture that contains shell is a capture that never reached the agent's
 * output, and half of a launch command is not more honest than all of it.
 *
 * `source` is SHELL-SHAPED here, not a word: it has to open the line (or follow
 * a `;`/`&&`/`|`) and take a path-ish argument. A bare `\bsource\s` also matched
 * "reading the source files" and "the source of truth" — a coding agent's most
 * ordinary vocabulary — and blanked the whole tail on prose that was never shell
 * at all, which is the same defect as the leak, pointed the other way.
 */
const LAUNCH_FRAGMENT =
  /2>\s*\/dev\/null|(?:^|[;&|]\s*)(?:source|\.)\s+[~/$'"]|\.bash_profile|\bexport\s+[A-Z_]+=|\.supermux\/bin\/|\b(?:VISUAL|EDITOR)=|\bclaude\s+--/

/**
 * A TUI DIALOG's own furniture — numbered options and the footer under them.
 *
 * A permission dialog is not drawn in a `╭` box, so the composer cut never
 * reached it and the tail rendered the dialog's rows as if they were prose,
 * mid-word and one wrap behind the real screen (daily-driver QA #8):
 *
 *   2. Yes, and don't ask agai … 3. No / Esc to cancel · Tab to amend explain
 *
 * The dialog belongs to the choice card, which is drawn from the same capture by
 * a reader that can actually parse it (`peek-lens.ts`). Two copies of one
 * question — one of them shredded — is worse than one.
 *
 * FOOTER TOKENS ONLY, never the numbered rows themselves: `1.` `2.` `3.` at the
 * head of a line is also how Claude writes a list in ordinary prose, and a rule
 * that blanked the tail on those would blank it for half the turns on this
 * surface. The footer is the part no assistant writes.
 */
const DIALOG_FRAGMENT = /Esc to cancel|Tab to amend|ctrl\+e to explain/

/** Below this a capture is a fixture, not a terminal, and the width test under
 *  `extractProvisionalTail` has nothing to measure. */
const MIN_PANE_COLS = 40

/**
 * THE LIVE COMPOSER, in the layout Claude Code actually ships.
 *
 * Until 2.1.23x the composer was a `╭ … ╯` box, so the box-top scan below was
 * the whole bottom cut and every `❯` in reach was a PROMPT ECHO. In the shipped
 * non-alt-screen layout of cc 2.1.233 the composer is a bare `❯ ` row
 * between two full-width rules, with no box anywhere below the welcome banner:
 *
 *     ● Terminal multiplexers have become indispensable …      ← the prose
 *     ────────────────────────────────────────────────────────
 *     ❯                                                         ← the composer
 *     ────────────────────────────────────────────────────────
 *       ⏵⏵ bypass permissions on (shift+tab to cycle)
 *
 * With no `╭` under the banner the box scan cut at the BANNER's own top (index
 * 0, everything dropped) or, once the banner had scrolled off, at the end of the
 * capture — and then the `❯` rule below took the composer for a prompt echo and
 * moved the start past every prose row. Either way the card rendered zero prose
 * lines while the pty demonstrably held thirty-five of them at the same instant
 * (verifier `chat-core`, `91-prov-live-*.png`; fixture
 * `tests/fixtures/tui/cc233/60-streaming-prose.txt`).
 *
 * So the composer is recognised on its own terms and acts as a bottom CUT, like
 * `╭`. Two shapes, because the row is not always empty:
 *   · a caret with nothing but whitespace after it (NBSP included — the TUI
 *     pads the empty composer with ` `), and
 *   · a caret DIRECTLY under a full-width rule, which is the composer with a
 *     draft in it. A prompt echo never has a rule immediately above it.
 */
const BARE_CARET = /^❯[\s\u00a0]*$/
const RULE_ROW = /^[─╌—]{3,}$/

/** A `❯` row that carries text — the prompt echo Claude prints at the head of a
 *  turn, and the only `❯` that may START a block. */
function isPromptEcho(t: string): boolean {
  return t.startsWith('❯') && !BARE_CARET.test(t.trimEnd())
}

/** Filter a raw ANSI pty capture down to the lines worth showing as the
 *  provisional (unconfirmed) tail: everything from the LAST box-top `╭`
 *  onward is dropped (composer or dialog), everything up to and including the
 *  last CLOSED box before it is dropped too (the welcome banner and, above it,
 *  whatever the shell left in the scrollback), then status noise and blanks;
 *  the last `max` surviving lines are returned ANSI-preserved.
 *
 * The second cut is what keeps a just-started session honest. Its capture is
 * `login prompt → the long `claude …` launch command → the ╭ welcome banner ╯ →
 * composer`, and the box-top rule alone kept ALL of the first three — so the
 * first thing the chat surface ever said about the session was a wrapped,
 * word-broken copy of its own launch command, captioned "Live terminal"
 * (mobile proof, 05-sent-pending-light.png). Nothing above a finished box is
 * ever in-progress prose: prose is what the agent is typing NOW, which is
 * strictly below everything already boxed and closed.
 */
export function extractProvisionalTail(capture: string, max = 12): string[] {
  if (!capture) return []
  // THE DIALOG SCREEN BELONGS TO THE CARD, AND A PANEL BELONGS TO NOBODY.
  //
  // `DIALOG_FRAGMENT` below is a token list, and a token list only knows the
  // dialogs somebody thought of: it was written off the PERMISSION footer, so
  // the PLAN dialog — which ends `shift+tab to approve` / `ctrl+g to edit in …`
  // and is not drawn in a `╭` box either — walked straight past it. Eight of
  // this repo's own live captures (`cc233/40-42`, `cc233/live/case4-*`,
  // `a4c/case4-*`, `plan-approval.txt`) rendered `2. Yes, manually approve
  // edits` / `3. Tell Claude what to change` as prose under "Live terminal ·
  // unconfirmed", beside a choice card drawn from the same capture — which is
  // daily-driver QA #8's second leak, unfixed.
  //
  // So ask the reader that can actually parse the screen. `peek-lens` sights
  // every dialog family (and the unknown modal shape, and the full-screen
  // panels of QA #1) off the same bytes, under its own fixtures and tests; when
  // it sights one, this block has nothing left to be. Prose is what the agent is
  // typing NOW, and a screen that is asking a question is not that.
  const lens = readLens(capture)
  if (lens.dialog || lens.modal) return []
  const lines = capture.split('\n')
  const stripped = lines.map(plain)
  // The bottom cut: the composer, in whichever layout this build draws it —
  // a `╭` box top (≤ 2.1.232) or a bare/ruled `❯` row (2.1.233+). Scanned from
  // the bottom for the FIRST of either, so a capture that still holds the
  // welcome banner (whose `╭` is at index 0) cuts at its composer and not at
  // its banner.
  let cut = lines.length
  for (let i = stripped.length - 1; i >= 0; i--) {
    const t = stripped[i].trimStart()
    if (t.startsWith('╭')) {
      cut = i
      break
    }
    if (BARE_CARET.test(t.trimEnd()) || (t.startsWith('❯') && i > 0 && RULE_ROW.test(stripped[i - 1].trim()))) {
      cut = i
      break
    }
  }
  // Start after the last CLOSED box above the cut (banner, finished dialog).
  let start = 0
  for (let i = cut - 1; i >= 0; i--) {
    if (stripped[i].includes('╰')) {
      start = i + 1
      break
    }
  }
  // …and then after the last PROMPT ECHO above the cut. Claude re-prints the
  // user's prompt behind a `❯` at the head of every turn, so this is where the
  // CURRENT turn starts on screen — everything above it belongs to turns the
  // transcript has already confirmed and is drawing properly above this block.
  // Without it, the first seconds of a new turn showed the previous one's tail
  // (a denied Bash call, an old `⎿ Interrupted`) captioned "Live terminal"
  // (mobile proof, f03-working-light.png).
  //
  // ONLY AN ECHO STARTS A TURN. A caret with nothing after it is the live
  // composer, never a prompt anybody typed — treating it as a start marker is
  // what moved `start` past thirty-five rows of streaming prose in the 2.1.233
  // layout. It is a CUT (above), and the cut has already excluded it here.
  for (let i = cut - 1; i >= start; i--) {
    if (isPromptEcho(stripped[i].trimStart())) {
      start = i + 1
      break
    }
  }
  // A shell prompt anywhere in what is left means the window never reached the
  // agent's own output: the banner that would have ended the scrollback is
  // above the capture, so every line here is the login line and the wrapped
  // launch command. There is no in-progress prose to show, and showing the
  // wreck of a `claude …` invocation captioned "Live terminal" is worse than
  // showing nothing — the transcript below is complete either way.
  //
  // IF THE FILTER CANNOT PARSE IT, IT RENDERS NOTHING (daily-driver QA #8). The
  // same verdict now covers the other two ways this block lied: a launch command
  // whose prompt head wrapped off the top of the window, and a TUI dialog whose
  // rows are somebody else's to draw. All three are "this capture is not prose",
  // and prose is the only thing this block claims to be.
  for (let i = start; i < cut; i++) {
    const t = stripped[i].trimStart()
    if (!t) continue
    if (SHELL_PROMPT_HEAD.test(t)) return []
    if (LAUNCH_FRAGMENT.test(t)) return []
    if (DIALOG_FRAGMENT.test(stripped[i])) return []
  }
  // Kept WITH their capture index: the wrap test below needs the row that was
  // physically above this one on the screen, and that is not `out[n - 1]` —
  // blanks and status noise were dropped in between, and a blank row is the end
  // of a line, not the middle of one.
  const kept: { row: number; text: string }[] = []
  for (let i = start; i < cut; i++) {
    const t = stripped[i].trim()
    if (!t) continue
    if (NOISE.test(t)) continue
    kept.push({ row: i, text: lines[i] })
  }
  // NO MID-WORD FRAGMENTS (daily-driver QA #8) — including the one the `max`
  // cut makes itself.
  //
  // The tell is STRUCTURAL, not a guess about the words: a pty hard-wraps at the
  // pane width, so a row that RUNS TO THE EDGE is a row whose text carried on
  // into the row below it. The row below therefore starts wherever that word
  // happened to break. Rows that stop short ended because their own line ended,
  // so whatever follows them starts where something started.
  //
  // Two places that bites, and the first fix only covered one:
  //   · the top of an UNANCHORED window (`start === 0` — neither a closed box
  //     nor a prompt echo was in the capture), where the first row is the tail
  //     of something above the window: `ermux/.supermux/bin/supermux--edit'`;
  //   · the `slice(-max)` cut, which picks a row 12 up from the end with no
  //     regard for what it is. Measured on an 80-column pane of ordinary
  //     streaming prose, that cut opened the card with
  //     `l comma and an American decimal point bo` — the same defect, one row
  //     further down.
  // So the block starts at the first kept row that BEGINS a line, and if there
  // is no such row it renders nothing, which is this module's standing verdict
  // on a capture it cannot parse.
  //
  // Width ignores trailing spaces: the TUI pads its own rows out to the pane,
  // and a padded row ends where its text ends. Only a row whose CHARACTERS reach
  // the edge wrapped.
  const width = (s: string): number => s.replace(/\s+$/, '').length
  let cols = 0
  for (const s of stripped) cols = Math.max(cols, width(s))
  const measured = cols >= MIN_PANE_COLS
  const startsLine = (row: number): boolean => {
    if (!measured) return true
    // The first row of the block: anchored means the thing above it is a box
    // bottom or a prompt echo, i.e. a line that ended. Unanchored, it has to
    // vouch for itself.
    if (row <= start) return start > 0 || width(stripped[row]) < cols
    return width(stripped[row - 1]) < cols
  }
  let from = Math.max(0, kept.length - max)
  while (from < kept.length && !startsLine(kept[from].row)) from++
  return kept.slice(from).map((k) => k.text)
}

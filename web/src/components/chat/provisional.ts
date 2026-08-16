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
import { parseAnsiLine } from '../../lib/ansi'

/** Status-bar / hint noise the tail must never show. */
const NOISE =
  /esc to interrupt|shift\+tab|\? for shortcuts|^[⏵⏸✻✽·╰│]|^\s*❯/i

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
 */
const LAUNCH_FRAGMENT =
  /2>\s*\/dev\/null|\bsource\s|\.bash_profile|\bexport\s+[A-Z_]+=|\.supermux\/bin\/|\b(?:VISUAL|EDITOR)=|\bclaude\s+--/

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

function plain(line: string): string {
  return parseAnsiLine(line)
    .map((s) => s.text)
    .join('')
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
  const lines = capture.split('\n')
  const stripped = lines.map(plain)
  let cut = lines.length
  for (let i = stripped.length - 1; i >= 0; i--) {
    if (stripped[i].trimStart().startsWith('╭')) {
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
  for (let i = cut - 1; i >= start; i--) {
    if (stripped[i].trimStart().startsWith('❯')) {
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
  const out: string[] = []
  for (let i = start; i < cut; i++) {
    const t = stripped[i].trim()
    if (!t) continue
    if (NOISE.test(t)) continue
    out.push(lines[i])
  }
  // NO MID-WORD FRAGMENTS (daily-driver QA #8). With no anchor above it
  // (`start === 0` — neither a closed box nor a prompt echo was in the window)
  // the first surviving row begins wherever the 30-line capture happened to
  // start, and on a hard-wrapped line that is the middle of a word:
  // `ermux/.supermux/bin/supermux--edit'`. Anchored blocks keep every row —
  // their first line starts where the turn does.
  //
  // The tell is STRUCTURAL, not a guess about the words: a pty hard-wraps at the
  // pane width, so a row that FILLS the pane is a row the text ran off the end
  // of — and when that row is the first one in the window, what it ran off the
  // end of is above the window. Everything shorter than the widest line ended
  // because its own line ended, so it starts where something started.
  const cols = Math.max(...stripped.map((l) => l.length), 0)
  const body =
    start === 0 && out.length > 0 && cols >= MIN_PANE_COLS && plain(out[0]).length >= cols
      ? out.slice(1)
      : out
  return body.slice(-max)
}

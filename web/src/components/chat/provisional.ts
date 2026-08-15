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
  for (let i = start; i < cut; i++) {
    if (SHELL_PROMPT_HEAD.test(stripped[i].trimStart())) return []
  }
  const out: string[] = []
  for (let i = start; i < cut; i++) {
    const t = stripped[i].trim()
    if (!t) continue
    if (NOISE.test(t)) continue
    out.push(lines[i])
  }
  return out.slice(-max)
}

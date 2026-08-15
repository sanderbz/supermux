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

/** A shell prompt and the command that launched the agent. Present in the
 *  capture of a freshly-started session — the pty's scrollback still holds the
 *  login line above Claude's banner — and it is the one thing on this surface
 *  that is emphatically NOT the agent talking. Matches `user@host:dir$ …` and
 *  the `%`/`#` prompt shapes. */
const SHELL_PROMPT = /^[\w.-]+@[\w.-]+:[^\s]*\s*[$#%]/

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
  const out: string[] = []
  for (let i = start; i < cut; i++) {
    const t = stripped[i].trim()
    if (!t) continue
    if (NOISE.test(t)) continue
    if (SHELL_PROMPT.test(t)) continue
    out.push(lines[i])
  }
  return out.slice(-max)
}

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

function plain(line: string): string {
  return parseAnsiLine(line)
    .map((s) => s.text)
    .join('')
}

/** Filter a raw ANSI pty capture down to the lines worth showing as the
 *  provisional (unconfirmed) tail: everything from the LAST box-top `╭`
 *  onward is dropped (composer or dialog), then status noise and blanks;
 *  the last `max` surviving lines are returned ANSI-preserved. */
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
  const out: string[] = []
  for (let i = 0; i < cut; i++) {
    const t = stripped[i].trim()
    if (!t) continue
    if (NOISE.test(t)) continue
    out.push(lines[i])
  }
  return out.slice(-max)
}

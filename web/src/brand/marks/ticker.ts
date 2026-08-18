/**
 * One rAF loop for every face on screen.
 * ─────────────────────────────────────────────────────────────────────────────
 * A roster can hold twenty marks; twenty independent rAF loops would be twenty
 * scheduling slots and twenty closures. Instead every live mark registers here
 * and the single loop writes the two eye paths directly, bypassing React —
 * the eyes change ~60×/s and nothing else in the tree cares.
 *
 * Two cheap guards keep this near-free:
 *   · the loop only runs while at least one mark is registered (an all-`done`
 *     roster, or a fully offscreen one, costs literally nothing);
 *   · each mark quantises its own blink/saccade to a key and skips the DOM
 *     write when the key is unchanged, so a wide-open eye is never rewritten.
 */
import { eyeClock, eyesFor, type Character, type MarkState } from './character'
import { eyePath, poseQuat, type Quat } from './geometry'

export interface LiveMark {
  ch: Character
  state: MarkState
  /** The two eye paths to drive. */
  left: SVGPathElement
  right: SVGPathElement
}

interface Entry extends LiveMark {
  q: Quat
  lastKey: number
}

const entries = new Set<Entry>()
let frame = 0

function tick(now: number) {
  const t = now / 1000
  for (const a of entries) {
    const { blink, saccadeX } = eyeClock(a.ch, a.state, t)
    // Quantise: 40 blink steps × the (already quantised) saccade offset.
    const key = Math.round(blink * 40) * 10 + saccadeX
    if (key === a.lastKey) continue
    a.lastKey = key
    const base = eyesFor(a.ch, a.state)
    const e = { ...base, pxL: a.ch.gaze + saccadeX, pxR: a.ch.gaze + saccadeX }
    a.left.setAttribute('d', eyePath(a.ch, a.q, e, -1, blink))
    a.right.setAttribute('d', eyePath(a.ch, a.q, e, 1, blink))
  }
  frame = entries.size > 0 ? requestAnimationFrame(tick) : 0
}

/** Register a mark; the returned disposer unregisters it (and stops the loop). */
export function registerMark(mark: LiveMark): () => void {
  const entry: Entry = { ...mark, q: poseQuat(mark.ch), lastKey: NaN }
  entries.add(entry)
  if (!frame && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(tick)
  return () => {
    entries.delete(entry)
    if (entries.size === 0 && frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
  }
}

/** Test seam: how many marks are currently being driven. */
export const liveMarkCount = () => entries.size

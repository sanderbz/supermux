/**
 * The shared rAF loop that drives every blinking face.
 *
 * What matters here is cost, not motion: the loop must not exist when nothing is
 * live (an all-`done` roster, or a fully scrolled-away one), and it must not
 * touch the DOM for a frame in which no eye actually changed — a wide-open eye
 * holds for seconds at a time.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { characterFromSeed } from '../../src/brand/marks/character'
import { liveMarkCount, registerMark } from '../../src/brand/marks/ticker'

type Frame = (now: number) => void

let queued: Frame[] = []
let cancelled = 0
let realRaf: unknown
let realCancel: unknown

/** A fake path element: records every `d` it is given. */
function fakeEye() {
  const written: string[] = []
  return {
    written,
    setAttribute: (name: string, value: string) => {
      if (name === 'd') written.push(value)
    },
  } as unknown as SVGPathElement & { written: string[] }
}

beforeEach(() => {
  queued = []
  cancelled = 0
  const g = globalThis as Record<string, unknown>
  realRaf = g.requestAnimationFrame
  realCancel = g.cancelAnimationFrame
  g.requestAnimationFrame = (cb: Frame) => {
    queued.push(cb)
    return queued.length
  }
  g.cancelAnimationFrame = () => {
    cancelled++
  }
})

afterEach(() => {
  const g = globalThis as Record<string, unknown>
  g.requestAnimationFrame = realRaf
  g.cancelAnimationFrame = realCancel
})

/** Run the single queued frame at `t` seconds, then let it reschedule. */
function frameAt(t: number) {
  const next = queued.shift()
  next?.(t * 1000)
}

describe('ticker', () => {
  const ch = characterFromSeed('Patch')

  test('drives both eyes and reschedules itself while a mark is live', () => {
    const left = fakeEye()
    const right = fakeEye()
    const stop = registerMark({ ch, state: 'idle', left, right })
    expect(liveMarkCount()).toBe(1)
    expect(queued.length).toBe(1)

    frameAt(0)
    expect(left.written.length).toBe(1)
    expect(right.written.length).toBe(1)
    expect(queued.length).toBe(1) // rescheduled

    stop()
    expect(liveMarkCount()).toBe(0)
    expect(cancelled).toBe(1)
  })

  test('skips the DOM entirely while the eye is unchanged', () => {
    const left = fakeEye()
    const right = fakeEye()
    const stop = registerMark({ ch, state: 'idle', left, right })
    // Two frames a rendering frame apart, both far from this seed's blink.
    frameAt(0)
    const after = left.written.length
    frameAt(0.016)
    expect(left.written.length).toBe(after)
    stop()
  })

  test('a blink writes a shorter eye, then restores it', () => {
    const left = fakeEye()
    const right = fakeEye()
    const stop = registerMark({ ch, state: 'idle', left, right })
    const heights = new Set<string>()
    // One full period at 50fps: the lid must close and reopen inside it.
    for (let i = 0; i < 300; i++) {
      frameAt(i * 0.02)
      const d = left.written.at(-1)
      if (d) heights.add(d)
    }
    stop()
    // Far more than two distinct shapes ⇒ a real eased blink, not a toggle.
    expect(heights.size).toBeGreaterThan(10)
  })

  test('ROSTER SCALE — 40 marks share ONE loop, and the loop dies with the last', () => {
    // Fase B2 puts a face on every row of the overview, the focus strip and
    // every picker. Forty is a plausible roster on this box, and the claim the
    // whole design rests on is that forty faces cost ONE scheduling slot, not
    // forty. Asserted rather than believed, because "shared" is a statement
    // about code and a phone battery is a fact about the world.
    const stops = Array.from({ length: 40 }, (_, i) =>
      registerMark({
        ch: characterFromSeed(`roster-${i}`),
        state: i % 3 === 0 ? 'working' : i % 3 === 1 ? 'waiting' : 'idle',
        left: fakeEye(),
        right: fakeEye(),
      }),
    )
    expect(liveMarkCount()).toBe(40)
    expect(queued.length).toBe(1) // ONE rAF, not forty

    frameAt(0)
    expect(queued.length).toBe(1) // still one after a frame

    // Scrolling half the roster off screen unregisters half the marks
    // (use-on-screen.ts) — the loop keeps running for the visible half and its
    // cost drops with the count.
    for (const stop of stops.slice(0, 20)) stop()
    expect(liveMarkCount()).toBe(20)
    expect(cancelled).toBe(0)

    for (const stop of stops.slice(20)) stop()
    expect(liveMarkCount()).toBe(0)
    expect(cancelled).toBe(1)
  })

  test('the loop stops when the last mark leaves and restarts for the next', () => {
    const stop1 = registerMark({ ch, state: 'idle', left: fakeEye(), right: fakeEye() })
    const stop2 = registerMark({ ch, state: 'working', left: fakeEye(), right: fakeEye() })
    expect(queued.length).toBe(1) // one loop, not one per mark
    stop1()
    expect(cancelled).toBe(0) // still one live mark
    stop2()
    expect(cancelled).toBe(1)

    queued = []
    const stop3 = registerMark({ ch, state: 'waiting', left: fakeEye(), right: fakeEye() })
    expect(queued.length).toBe(1)
    stop3()
  })
})

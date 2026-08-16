import { describe, expect, test } from 'bun:test'

import {
  dragRows,
  decayVelocity,
  isFling,
  momentumAlive,
  FLING_MIN_VELOCITY,
  MOMENTUM_STOP_VELOCITY,
} from '../../src/lib/touch-scroll'

// The phone terminal's scrollback is driven ENTIRELY by this math: xterm 6.0 has
// no built-in touch-drag scroll and its `.xterm-viewport` is not a native
// overflow scroller (scrollHeight === clientHeight), which is what the
// daily-driver QA measured and read as "no scrollback on the phone" (#19). The
// drag→rows conversion below is therefore the only thing standing between a
// finger and the history, and it had no test.
describe('touch-drag scrollback math', () => {
  test('a drag shorter than one cell scrolls nothing but carries the remainder', () => {
    const cell = 20
    const a = dragRows(12, cell, 0)
    expect(a.rows).toBe(0)
    expect(a.carry).toBe(12)
    // The next nudge completes the cell — the carry is what makes a slow drag
    // move at all instead of quantising to zero forever.
    const b = dragRows(12, cell, a.carry)
    expect(b.rows).toBe(1)
    expect(b.carry).toBe(4)
  })

  test('rows follow the drag distance, sign included', () => {
    // dy > 0 = finger moved UP = scroll toward the newest output.
    expect(dragRows(100, 20, 0).rows).toBe(5)
    // dy < 0 = finger moved DOWN = scroll back into history.
    expect(dragRows(-100, 20, 0).rows).toBe(-5)
    // A whole-cell drag leaves no carry in either direction.
    expect(dragRows(-100, 20, 0).carry).toBe(0)
  })

  test('a reversal spends the carry instead of stranding it', () => {
    const cell = 20
    const down = dragRows(-15, cell, 0)
    expect(down.rows).toBe(0)
    expect(down.carry).toBe(-15)
    const back = dragRows(15, cell, down.carry)
    expect(back.rows).toBe(0)
    expect(back.carry).toBe(0)
  })

  test('a degenerate cell height never divides by zero or NaNs the scroll', () => {
    // `cellPx()` reads xterm's render dimensions, which are 0/undefined before
    // the first paint and on a hidden (display:none) embed.
    for (const cell of [0, -4, Number.NaN]) {
      const r = dragRows(100, cell, 0)
      expect(Number.isFinite(r.rows)).toBe(true)
      expect(Number.isFinite(r.carry)).toBe(true)
      expect(r.rows).toBe(0)
    }
  })

  test('a tap or a slow release does not fling', () => {
    expect(isFling(0)).toBe(false)
    expect(isFling(FLING_MIN_VELOCITY / 2)).toBe(false)
    expect(isFling(-FLING_MIN_VELOCITY / 2)).toBe(false)
    expect(isFling(FLING_MIN_VELOCITY * 2)).toBe(true)
    expect(isFling(-FLING_MIN_VELOCITY * 2)).toBe(true)
  })

  test('momentum decays ~6% per 60fps frame and terminates', () => {
    const one = decayVelocity(1, 16)
    expect(one).toBeCloseTo(0.94, 3)
    // Half a frame decays half as much (frame-rate independent).
    expect(decayVelocity(1, 8)).toBeGreaterThan(one)
    // And it always reaches the stop threshold in bounded time — the loop must
    // not be able to spin forever on a fast fling.
    let v = 10
    let frames = 0
    while (momentumAlive(v) && frames < 1000) {
      v = decayVelocity(v, 16)
      frames++
    }
    expect(momentumAlive(v)).toBe(false)
    expect(frames).toBeLessThan(150)
    expect(Math.abs(v)).toBeLessThanOrEqual(MOMENTUM_STOP_VELOCITY)
  })
})

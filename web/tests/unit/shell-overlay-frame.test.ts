/**
 * The shell overlay's frame sizing (fase B1 T6.1).
 * ─────────────────────────────────────────────────────────────────────────────
 * The frame is sized in container-query units against the CONTENT COLUMN, so
 * its size is a three-way `min()` and every one of the three constraints is a
 * deliberate design decision rather than a fudge factor. A `min()` written
 * straight into CSS is untestable and, worse, unreviewable — nobody can tell
 * from a screenshot whether a frame is height-bound or ceiling-bound. So the
 * arithmetic lives in a pure module and this suite pins all three branches plus
 * the boundaries between them.
 */
import { describe, expect, test } from 'bun:test'

import {
  FRAME_MAX_PX,
  FRAME_SIZE_CSS,
  FRAME_V_INSET,
  frameBinding,
  frameSize,
} from '../../src/components/shell/shell-overlay-frame'

describe('frameSize — the three clamp branches', () => {
  test('height-bound: a short, wide column', () => {
    // 1440 wide → width budget 855; 400 tall → height budget 328. Height wins.
    const box = { cqw: 1440, cqh: 400 }
    expect(frameBinding(box)).toBe('height')
    expect(frameSize(box)).toBe(400 - FRAME_V_INSET)
  })

  test('width-bound: a tall, narrow column (the split-view case)', () => {
    // 560 wide → 0.625*560 - 45 = 305; 900 tall → 828. Width wins.
    const box = { cqw: 560, cqh: 900 }
    expect(frameBinding(box)).toBe('width')
    expect(frameSize(box)).toBe(560 * 0.625 - 45)
  })

  test('ceiling-bound: a big desktop column', () => {
    // 1600 wide → 955; 1200 tall → 1128. The 512 ceiling wins.
    const box = { cqw: 1600, cqh: 1200 }
    expect(frameBinding(box)).toBe('max')
    expect(frameSize(box)).toBe(FRAME_MAX_PX)
  })

  test('the ceiling really is a ceiling — no column can exceed it', () => {
    for (const cqw of [900, 1200, 2000, 5000]) {
      for (const cqh of [700, 1000, 3000]) {
        expect(frameSize({ cqw, cqh })).toBeLessThanOrEqual(FRAME_MAX_PX)
      }
    }
  })

  test('a column smaller than its own insets yields 0, never a negative size', () => {
    expect(frameSize({ cqw: 40, cqh: 40 })).toBe(0)
    expect(frameSize({ cqw: 0, cqh: 0 })).toBe(0)
  })

  test('the boundary between height- and width-bound is where the budgets cross', () => {
    // Solve cqh - 72 === 0.625*cqw - 45 for cqw = 800 → 455 + 72 = 527.
    const cqw = 800
    const crossing = 0.625 * cqw - 45 + FRAME_V_INSET
    expect(frameSize({ cqw, cqh: crossing })).toBe(0.625 * cqw - 45)
    expect(frameBinding({ cqw, cqh: crossing - 10 })).toBe('height')
    expect(frameBinding({ cqw, cqh: crossing + 10 })).toBe('width')
  })

  test('monotonic in both dimensions — a bigger column never yields a smaller frame', () => {
    let prev = -1
    for (let cqw = 200; cqw <= 2000; cqw += 100) {
      const size = frameSize({ cqw, cqh: 900 })
      expect(size).toBeGreaterThanOrEqual(prev)
      prev = size
    }
  })
})

describe('FRAME_SIZE_CSS — the string the component actually emits', () => {
  test('is a container-query min() with the same three terms', () => {
    expect(FRAME_SIZE_CSS).toBe('min(100cqh - 72px, 62.5cqw - 45px, 512px)')
  })

  test('uses container units, never viewport units', () => {
    // `vh`/`vw` would size the frame against the WINDOW, which is the whole bug
    // this component exists to avoid — the overlay is bounded by the content
    // column, not by the screen.
    expect(FRAME_SIZE_CSS).not.toMatch(/\d(vh|vw|dvh|dvw)\b/)
    expect(FRAME_SIZE_CSS).toContain('cqh')
    expect(FRAME_SIZE_CSS).toContain('cqw')
  })
})

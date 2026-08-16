/**
 * `pinnedBoundary` — where the pinned block ends (fase B2 T7).
 *
 * The hairline it drives has exactly two ways to be wrong and both are invisible
 * in a screenshot: drawing when there is nothing to separate, and not drawing
 * when there is. §12.4 asks for a 0.5px separator and NO "Pinned" text header —
 * so the boundary is the only thing that says a block exists, and it has to be
 * exactly right.
 */
import { describe, expect, test } from 'bun:test'

import { pinnedBoundary } from '../../src/hooks/use-session-config'

const rows = (...pinned: boolean[]) => pinned.map((p) => ({ pinned: p }))

describe('renders exactly when it means something', () => {
  test('2 pinned + 6 unpinned → the boundary is at index 2', () => {
    expect(pinnedBoundary(rows(true, true, false, false, false, false, false, false))).toBe(2)
  })

  test('one pinned, one unpinned → index 1', () => {
    expect(pinnedBoundary(rows(true, false))).toBe(1)
  })
})

describe('renders nothing when there is nothing to separate', () => {
  test('no pins at all', () => {
    expect(pinnedBoundary(rows(false, false, false))).toBeNull()
  })

  test('everything pinned', () => {
    expect(pinnedBoundary(rows(true, true, true))).toBeNull()
  })

  test('an empty list', () => {
    expect(pinnedBoundary([])).toBeNull()
  })

  test('a single row, pinned or not', () => {
    expect(pinnedBoundary(rows(true))).toBeNull()
    expect(pinnedBoundary(rows(false))).toBeNull()
  })

  test('rows with no `pinned` field at all (a pre-B2 cache)', () => {
    expect(pinnedBoundary([{}, {}, {}])).toBeNull()
  })
})

describe('a list that is not pinned-first is not lied about', () => {
  test('a manual/custom order with a pin in the middle draws nothing', () => {
    // `smartSort` puts pinned first; a hand-dragged group does not. Drawing a
    // hairline after the first pinned run would claim a structure the list does
    // not have.
    expect(pinnedBoundary(rows(true, false, true, false))).toBeNull()
  })

  test('a pin at the very end draws nothing', () => {
    expect(pinnedBoundary(rows(false, false, true))).toBeNull()
  })
})

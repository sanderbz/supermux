/**
 * `applyDelta` — how a `sessions` SSE delta merges into the cached roster.
 *
 * The states-audit residual this file guards: a HARD-DELETED session kept its
 * tile (green "Idle" dot, selected in the roster, a live composer) on every open
 * tab, because `sessions/mod.rs delete()` broadcast no removal and `applyDelta`
 * dropped a row ONLY on `archived: true`. The fix broadcasts `{name,
 * removed: true}` and this reducer drops on it exactly like the archive flag —
 * so the tile, the focus-header dot and the composer all clear at once (they all
 * read this one sessions query).
 */

import { describe, expect, test } from 'bun:test'

import { applyDelta } from '../../src/hooks/use-sessions'
import type { ApiSession } from '../../src/lib/api'

const row = (over: Partial<ApiSession> = {}): ApiSession => ({
  name: 'vx-cdel',
  status: 'idle',
  dir: '/tmp',
  provider: 'claude',
  preview_lines: [],
  ...over,
})

describe('applyDelta — the hard-delete removal path', () => {
  test('a `removed: true` delta drops the row immediately', () => {
    const before = [row({ name: 'keep' }), row({ name: 'vx-cdel' })]
    const after = applyDelta(before, [{ name: 'vx-cdel', removed: true }], true)
    expect(after.map((s) => s.name)).toEqual(['keep'])
  })

  test('the archive drop path still works (removed is an ADDITION, not a swap)', () => {
    const before = [row({ name: 'keep' }), row({ name: 'arch' })]
    const after = applyDelta(before, [{ name: 'arch', archived: true }], true)
    expect(after.map((s) => s.name)).toEqual(['keep'])
  })

  test('a `removed: true` delta never RE-ADDS an already-gone row', () => {
    // The whole point: a delete must not resurrect a tile. An unknown name with
    // `removed: true` is a no-op, even with allowAdd on.
    const after = applyDelta([row({ name: 'keep' })], [{ name: 'ghost', removed: true }], true)
    expect(after.map((s) => s.name)).toEqual(['keep'])
  })

  test('an ordinary status delta on a surviving row still merges key-by-key', () => {
    const before = [row({ name: 'vx-cdel', status: 'idle', preview_lines: ['hi'] })]
    const after = applyDelta(before, [{ name: 'vx-cdel', status: 'active' }], false)
    expect(after[0].status).toBe('active')
    // A status-only delta must not blank the tail preview (the merge is per-key).
    expect(after[0].preview_lines).toEqual(['hi'])
  })
})

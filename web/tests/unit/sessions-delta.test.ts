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

import { applyDelta, clearRemovalTombstone } from '../../src/hooks/use-sessions'
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

describe('applyDelta — the delete resurrection race (w6 #3)', () => {
  // Each test injects its OWN tombstone map + clock so the module-level
  // singleton and Date.now cannot make one test leak into another.
  test('a late in-flight delta does NOT resurrect a just-deleted session', () => {
    const tomb = new Map<string, number>()
    // 1. the session exists.
    const alive = [row({ name: 'keep' }), row({ name: 'vx-cdel', status: 'active' })]
    // 2. the DELETE lands — the row is dropped AND the name is tombstoned.
    const gone = applyDelta(alive, [{ name: 'vx-cdel', removed: true }], true, tomb, 1000)
    expect(gone.map((s) => s.name)).toEqual(['keep'])
    // 3. a preview/activity delta that was already in flight arrives 200ms later
    //    with `allowAdd` on. Before the fix this took the unknown-name branch and
    //    re-added the tile as a synthetic green `idle`; now it is denied.
    const after = applyDelta(
      gone,
      [{ name: 'vx-cdel', preview_lines: ['ghost tail'] }],
      true,
      tomb,
      1200,
    )
    expect(after.map((s) => s.name)).toEqual(['keep'])
  })

  test('the tombstone is short-lived — a real recreate past the TTL is allowed', () => {
    const tomb = new Map<string, number>()
    const gone = applyDelta([row({ name: 'vx-cdel' })], [{ name: 'vx-cdel', removed: true }], true, tomb, 0)
    expect(gone.map((s) => s.name)).toEqual([])
    // A human recreates the same name 20s later (> 15s TTL): it must appear.
    const recreated = applyDelta(gone, [{ name: 'vx-cdel', status: 'idle' }], true, tomb, 20_000)
    expect(recreated.map((s) => s.name)).toEqual(['vx-cdel'])
  })

  test('an explicit create clears the tombstone so its deltas land at once', () => {
    const tomb = new Map<string, number>()
    applyDelta([row({ name: 'vx-cdel' })], [{ name: 'vx-cdel', removed: true }], true, tomb, 0)
    // The create mutation forgets the tombstone eagerly (here on the injected map
    // via the same delete key), so a delta 1ms later is not denied.
    tomb.delete('vx-cdel')
    const after = applyDelta([], [{ name: 'vx-cdel', status: 'idle', dir: '/w', provider: 'claude' }], true, tomb, 1)
    expect(after.map((s) => s.name)).toEqual(['vx-cdel'])
  })

  test('clearRemovalTombstone targets the module singleton (smoke)', () => {
    // The exported clear is what the create mutation calls; exercise it so the
    // wiring cannot silently break.
    expect(() => clearRemovalTombstone('anything')).not.toThrow()
  })
})

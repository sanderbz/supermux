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

import {
  applyDelta,
  clearRemovalTombstone,
  statusToDelta,
} from '../../src/hooks/use-sessions'
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

describe('applyDelta — tombstone must not strand a real restore (w7 regression)', () => {
  // The w6 tombstone denied EVERY unknown-name add inside the TTL — including
  // the server's own FULL authoritative row for an archive→unarchive or a
  // same-name recreate. Those must win: they mean "the session is really back".
  // The gate belongs on "this is a SYNTHETIC PARTIAL" (no identity columns),
  // never on "the name is tombstoned". A full row carries `dir` + `provider`;
  // no partial delta does — that pair is the discriminator.

  test('archive then an authoritative full-row SSE restores the tile at once', () => {
    const tomb = new Map<string, number>()
    const alive = [row({ name: 'keep' }), row({ name: 'arch', status: 'active' })]
    // Archive drops the row and (today) tombstones the name.
    const gone = applyDelta(alive, [{ name: 'arch', archived: true }], true, tomb, 1000)
    expect(gone.map((s) => s.name)).toEqual(['keep'])
    // Unarchive: the server broadcasts the FULL re-listed SessionView (dir +
    // provider present, archived:false), 200ms later — deep inside the 15s TTL.
    // It must re-add the tile immediately, not wait the tombstone out.
    const restored = applyDelta(
      gone,
      [row({ name: 'arch', status: 'stopped', archived: false })],
      true,
      tomb,
      1200,
    )
    expect(restored.map((s) => s.name).sort()).toEqual(['arch', 'keep'])
    // …and the tombstone is cleared so nothing lingers to re-block a later delta.
    expect(tomb.has('arch')).toBe(false)
  })

  test('a full-row create for a tombstoned name applies inside the TTL', () => {
    const tomb = new Map<string, number>()
    // A hard delete tombstones the name.
    const gone = applyDelta([row({ name: 'vx-cdel' })], [{ name: 'vx-cdel', removed: true }], true, tomb, 0)
    expect(gone.map((s) => s.name)).toEqual([])
    // A full authoritative recreate row (dir + provider present) for the SAME
    // name, 200ms later — inside the TTL. A recreate is server truth: apply it.
    const after = applyDelta(gone, [row({ name: 'vx-cdel', status: 'idle' })], true, tomb, 200)
    expect(after.map((s) => s.name)).toEqual(['vx-cdel'])
    expect(tomb.has('vx-cdel')).toBe(false)
  })

  test('a SYNTHETIC partial for a tombstoned name is STILL denied within the TTL', () => {
    // The other half of the discriminator: the hard-delete resurrection guard
    // (w6 #3) must survive. A late preview partial (no dir/provider) inside the
    // TTL must NOT resurrect the tile — for a hard delete OR an archive.
    const tomb = new Map<string, number>()
    const goneDel = applyDelta([row({ name: 'hd' })], [{ name: 'hd', removed: true }], true, tomb, 0)
    const afterDel = applyDelta(goneDel, [{ name: 'hd', preview_lines: ['ghost'] }], true, tomb, 500)
    expect(afterDel.map((s) => s.name)).toEqual([])

    const tomb2 = new Map<string, number>()
    const goneArch = applyDelta([row({ name: 'ar' })], [{ name: 'ar', archived: true }], true, tomb2, 0)
    const afterArch = applyDelta(goneArch, [{ name: 'ar', preview_lines: ['ghost'] }], true, tomb2, 500)
    expect(afterArch.map((s) => s.name)).toEqual([])
  })
})

describe('status version — a reordered event cannot regress newer truth (w6 #8)', () => {
  test('statusToDelta threads the per-session `version` through', () => {
    // The root: the version used to be discarded here, so `applyDelta` had
    // nothing to compare and applied arrival order.
    expect(statusToDelta({ name: 'a', status: 'stopped', version: 7 })).toEqual([
      { name: 'a', status: 'stopped', status_version: 7 },
    ])
    // An older server that sends no version still produces a valid delta — the
    // guard simply does not engage for it.
    expect(statusToDelta({ name: 'a', status: 'idle' })).toEqual([
      { name: 'a', status: 'idle' },
    ])
    // A non-finite version is ignored rather than trusted.
    expect(statusToDelta({ name: 'a', status: 'idle', version: Number.NaN })).toEqual([
      { name: 'a', status: 'idle' },
    ])
  })

  test('a stale (older-version) status event is dropped, not applied', () => {
    // Two lifecycle tasks: N=10 → `active`, N+1=11 → `stopped`. They arrive
    // REVERSED after an await. The newer `stopped` (v11) lands first…
    let list = applyDelta(
      [row({ name: 'vx-race', status: 'active' })],
      statusToDelta({ name: 'vx-race', status: 'stopped', version: 11 }),
      false,
    )
    expect(list[0].status).toBe('stopped')
    expect(list[0].status_version).toBe(11)
    // …then the stale `active` (v10) arrives. Before the fix arrival order won
    // and it regressed the row to `active`; now it is dropped.
    list = applyDelta(
      list,
      statusToDelta({ name: 'vx-race', status: 'active', version: 10 }),
      false,
    )
    expect(list[0].status).toBe('stopped')
    expect(list[0].status_version).toBe(11)
  })

  test('in-order events apply normally, version climbing', () => {
    let list = applyDelta(
      [row({ name: 'vx-ok', status: 'idle' })],
      statusToDelta({ name: 'vx-ok', status: 'active', version: 3 }),
      false,
    )
    expect(list[0].status).toBe('active')
    list = applyDelta(
      list,
      statusToDelta({ name: 'vx-ok', status: 'stopped', version: 4 }),
      false,
    )
    expect(list[0].status).toBe('stopped')
    expect(list[0].status_version).toBe(4)
  })

  test('a versionless status delta always applies (no guard, no stored version)', () => {
    // A `sessions` delta path or an old server: nothing to compare, so a status
    // change is never dropped by the guard.
    let list = applyDelta(
      [row({ name: 'vx-nov', status: 'active', status_version: 9 })],
      [{ name: 'vx-nov', status: 'stopped' }],
      false,
    )
    expect(list[0].status).toBe('stopped')
    // The stored version is untouched by a versionless delta.
    expect(list[0].status_version).toBe(9)
    // And a fresh row with no stored version accepts any first status event.
    list = applyDelta(
      [row({ name: 'vx-fresh', status: 'idle' })],
      statusToDelta({ name: 'vx-fresh', status: 'stopped', version: 2 }),
      false,
    )
    expect(list[0].status).toBe('stopped')
  })
})

/**
 * `lib/overview-layout.ts` — the FIRST unit test this module has ever had.
 *
 * It is the overview's whole data model (six sort kernels, the custom-layout
 * reconciler, the per-group sort store and, as of fase B2 T9, the group-by
 * presets and the localStorage → server-blob migration) and until now nothing
 * asserted any of it. The two changes T9 makes are exactly the kind that need a
 * net: a persistence move (values must be carried, not dropped) and a new
 * grouping (which must never be able to destroy a hand-dragged order).
 */
import { describe, expect, test } from 'bun:test'

import {
  ageSort,
  bucketSessionsByPreset,
  DEFAULT_LAYOUT,
  defaultGroupSortMode,
  groupSortKey,
  groupSortMode,
  migrateLegacyGroupSort,
  nameSort,
  parseLayout,
  presetGroupId,
  recencySort,
  reconcileCustomLayout,
  serializeLayout,
  smartSort,
  sortSessionsByMode,
  statusSort,
  UNGROUPED_GROUP_ID,
  withGroupSortMode,
  withoutGroupSortMode,
  type KeyValueStore,
  type LayoutItem,
  type OverviewLayout,
} from '../../src/lib/overview-layout'
import type { ApiSession } from '../../src/lib/api/sessions'

const s = (over: Partial<ApiSession> & { name: string }): ApiSession =>
  ({ status: 'idle', dir: '/tmp', provider: 'claude', preview_lines: [], ...over }) as ApiSession

/** A localStorage stand-in — the migration takes a store so it is testable
 *  without a DOM (the unit runner has none). */
function fakeStore(seed: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...seed }
  return {
    data,
    get length() {
      return Object.keys(data).length
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
    getItem: (k: string) => data[k] ?? null,
    removeItem: (k: string) => {
      delete data[k]
    },
  }
}

describe('the six sort kernels', () => {
  test('smartSort puts pinned first, then running, then activity', () => {
    const rows = [
      s({ name: 'stopped', status: 'stopped', last_activity: 900 }),
      s({ name: 'pinned', pinned: true, status: 'idle', last_activity: 1 }),
      s({ name: 'active', status: 'active', last_activity: 100 }),
    ]
    const out = smartSort(rows).map((r) => r.name)
    expect(out[0]).toBe('pinned')
    expect(out.indexOf('active')).toBeLessThan(out.indexOf('stopped'))
  })

  test('nameSort is alphabetical and stable', () => {
    const rows = [s({ name: 'beta' }), s({ name: 'alpha' }), s({ name: 'gamma' })]
    expect(nameSort(rows).map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('statusSort surfaces the ones that need you', () => {
    const rows = [
      s({ name: 'idle', status: 'idle' }),
      s({ name: 'waiting', status: 'waiting' }),
      s({ name: 'stopped', status: 'stopped' }),
    ]
    const out = statusSort(rows).map((r) => r.name)
    expect(out[0]).toBe('waiting')
    expect(out.at(-1)).toBe('stopped')
  })

  test('recencySort is newest ACTIVITY first; ageSort is newest CREATION first', () => {
    // `ageSort`'s name is historical — the kernel sorts by creation stamp
    // DESCENDING and its shipped hint says "Newest first". Pinned here so the
    // label and the behaviour can never drift apart unnoticed.
    const rows = [
      s({ name: 'old', last_activity: 10, created_at: '2026-01-01T00:00:00Z' }),
      s({ name: 'new', last_activity: 900, created_at: '2026-08-01T00:00:00Z' }),
    ]
    expect(recencySort(rows)[0].name).toBe('new')
    expect(ageSort(rows)[0].name).toBe('new')
    expect(ageSort(rows).at(-1)!.name).toBe('old')
  })

  test('every kernel is PURE — the input array is never reordered in place', () => {
    const rows = [s({ name: 'b' }), s({ name: 'a' })]
    const snapshot = rows.map((r) => r.name)
    for (const kernel of [smartSort, nameSort, statusSort, recencySort, ageSort]) {
      kernel(rows)
      expect(rows.map((r) => r.name)).toEqual(snapshot)
    }
  })

  test('sortSessionsByMode dispatches to all six, and `custom` is identity', () => {
    const rows = [s({ name: 'b' }), s({ name: 'a' })]
    // NOTE the argument order: (mode, sessions).
    expect(sortSessionsByMode('name', rows).map((r) => r.name)).toEqual(['a', 'b'])
    expect(sortSessionsByMode('custom', rows).map((r) => r.name)).toEqual(['b', 'a'])
    for (const mode of ['smart', 'status', 'recent', 'age'] as const) {
      expect(sortSessionsByMode(mode, rows).length).toBe(2)
    }
  })
})

describe('parse / serialize — defensive against anything', () => {
  test('an absent or unparseable pref is the default layout', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '3']) {
      expect(parseLayout(raw as string | null)).toEqual(DEFAULT_LAYOUT)
    }
  })

  test('the new fields default rather than throwing on an OLD blob', () => {
    // Every deployed install has a blob written before T9 existed.
    const old = JSON.stringify({ mode: 'alpha', custom: [] })
    const parsed = parseLayout(old)
    expect(parsed.mode).toBe('alpha')
    expect(parsed.groupSort).toEqual({})
    expect(parsed.groupBy).toBe('none')
  })

  test('a junk groupSort ENTRY is dropped without costing the others', () => {
    const raw = JSON.stringify({
      mode: 'custom',
      custom: [],
      groupSort: { good: 'name', bad: 'nonsense', alsoBad: 42 },
    })
    expect(parseLayout(raw).groupSort).toEqual({ good: 'name' })
  })

  test('an unknown groupBy collapses to none', () => {
    expect(parseLayout(JSON.stringify({ groupBy: 'phase-of-moon' })).groupBy).toBe('none')
  })

  test('round-trips', () => {
    const layout: OverviewLayout = {
      mode: 'custom',
      custom: [
        { type: 'group', id: 'g_1', name: 'Release' },
        { type: 'session', name: 'supermux' },
      ],
      groupSort: { g_1: 'recent' },
      groupBy: 'dir',
    }
    expect(parseLayout(serializeLayout(layout))).toEqual(layout)
  })
})

describe('per-group sort on the blob', () => {
  const layout: OverviewLayout = { ...DEFAULT_LAYOUT, groupSort: { g_1: 'recent' } }

  test('a known group reads its mode; an unknown one falls back to the default', () => {
    expect(groupSortMode(layout, 'g_1')).toBe('recent')
    expect(groupSortMode(layout, 'g_2')).toBe(defaultGroupSortMode('g_2'))
    expect(groupSortMode(layout, UNGROUPED_GROUP_ID)).toBe('smart')
    expect(defaultGroupSortMode('g_2')).toBe('custom')
  })

  test('set and clear are pure', () => {
    const next = withGroupSortMode(layout, 'g_2', 'name')
    expect(next.groupSort).toEqual({ g_1: 'recent', g_2: 'name' })
    expect(layout.groupSort).toEqual({ g_1: 'recent' })
    expect(withoutGroupSortMode(next, 'g_2').groupSort).toEqual({ g_1: 'recent' })
  })

  test('clearing a group that has no entry returns the SAME object (no write)', () => {
    expect(withoutGroupSortMode(layout, 'nope')).toBe(layout)
  })
})

describe('the localStorage → blob migration', () => {
  test('folds every legacy value in and clears the keys', () => {
    const store = fakeStore({
      [groupSortKey('g_1')]: 'recent',
      [groupSortKey('g_2')]: 'name',
      'unrelated:key': 'keep me',
    })
    const next = migrateLegacyGroupSort(DEFAULT_LAYOUT, store)!
    expect(next.groupSort).toEqual({ g_1: 'recent', g_2: 'name' })
    expect(store.data[groupSortKey('g_1')]).toBeUndefined()
    expect(store.data[groupSortKey('g_2')]).toBeUndefined()
    expect(store.data['unrelated:key']).toBe('keep me')
  })

  test('nothing to migrate ⇒ null, so the caller never PUTs', () => {
    expect(migrateLegacyGroupSort(DEFAULT_LAYOUT, fakeStore())).toBeNull()
    expect(migrateLegacyGroupSort(DEFAULT_LAYOUT, fakeStore({ other: 'x' }))).toBeNull()
  })

  test('the BLOB wins over a stale localStorage row — but the key still goes', () => {
    const layout: OverviewLayout = { ...DEFAULT_LAYOUT, groupSort: { g_1: 'status' } }
    const store = fakeStore({ [groupSortKey('g_1')]: 'recent' })
    // Nothing moved (the blob already knew), so no write is requested…
    expect(migrateLegacyGroupSort(layout, store)).toBeNull()
    // …and the key is gone anyway, or this would re-run on every mount.
    expect(store.data[groupSortKey('g_1')]).toBeUndefined()
  })

  test('a junk legacy value is dropped, not folded in', () => {
    const store = fakeStore({ [groupSortKey('g_1')]: 'by-vibes' })
    expect(migrateLegacyGroupSort(DEFAULT_LAYOUT, store)).toBeNull()
    expect(store.data[groupSortKey('g_1')]).toBeUndefined()
  })

  test('no store at all (SSR / private mode) is a no-op, never a throw', () => {
    expect(migrateLegacyGroupSort(DEFAULT_LAYOUT, undefined)).toBeNull()
  })
})

describe('group-by presets are DERIVED and cannot destroy a drag order', () => {
  const rows = [
    s({ name: 'a', dir: '/opt/projects/supermux', provider: 'claude', status: 'active' }),
    s({ name: 'b', dir: '/opt/projects/supermux', provider: 'codex', status: 'idle' }),
    s({ name: 'c', dir: '/home/me/notes', provider: 'claude', status: 'idle', host_id: 3 }),
  ]

  test('none = one implicit section — the historical render', () => {
    const out = bucketSessionsByPreset('none', rows)
    expect(out.length).toBe(1)
    expect(out[0].isImplicit).toBe(true)
    expect(out[0].sessions.map((r) => r.name)).toEqual(['a', 'b', 'c'])
  })

  test('dir buckets by folder and labels with the leaf', () => {
    const out = bucketSessionsByPreset('dir', rows)
    expect(out.map((b) => b.groupName).sort()).toEqual(['notes', 'supermux'])
    expect(out.find((b) => b.groupName === 'supermux')!.sessions.length).toBe(2)
  })

  test('provider, host and status each bucket on their own field', () => {
    expect(bucketSessionsByPreset('provider', rows).map((b) => b.groupName).sort()).toEqual([
      'claude',
      'codex',
    ])
    expect(bucketSessionsByPreset('host', rows).map((b) => b.groupName).sort()).toEqual([
      'Host 3',
      'Local',
    ])
    expect(bucketSessionsByPreset('status', rows).map((b) => b.groupName).sort()).toEqual([
      'Active',
      'Idle',
    ])
  })

  test('a missing field gets an honest bucket rather than being dropped', () => {
    const out = bucketSessionsByPreset('dir', [s({ name: 'nowhere', dir: '' })])
    expect(out.length).toBe(1)
    expect(out[0].sessions.map((r) => r.name)).toEqual(['nowhere'])
  })

  test('every session lands in exactly one bucket, for every preset', () => {
    for (const preset of ['dir', 'provider', 'host', 'status'] as const) {
      const out = bucketSessionsByPreset(preset, rows)
      const names = out.flatMap((b) => b.sessions.map((r) => r.name)).sort()
      expect(names).toEqual(['a', 'b', 'c'])
    }
  })

  test('preset ids cannot collide with real group ids', () => {
    expect(presetGroupId('dir', '/tmp')).toMatch(/^preset:/)
    // `newGroupId()` produces `g_…`; a preset id can never look like one.
    expect(presetGroupId('dir', '/tmp').startsWith('g_')).toBe(false)
  })

  test('the preset↔custom round-trip preserves the drag order EXACTLY', () => {
    // The whole risk in one test: go to a preset, come back, and the layout the
    // user dragged is byte-identical. It is, because a preset is a pure read —
    // there is no code path from `bucketSessionsByPreset` to `custom`.
    const custom: LayoutItem[] = [
      { type: 'group', id: 'g_1', name: 'Release' },
      { type: 'session', name: 'b' },
      { type: 'session', name: 'a' },
      { type: 'session', name: 'c' },
    ]
    const layout: OverviewLayout = { mode: 'custom', custom, groupSort: {}, groupBy: 'none' }
    const toPreset: OverviewLayout = { ...layout, groupBy: 'dir' }
    const andBack: OverviewLayout = { ...toPreset, groupBy: 'none' }
    bucketSessionsByPreset(toPreset.groupBy, rows) // the render, which writes nothing
    expect(andBack.custom).toEqual(custom)
    expect(parseLayout(serializeLayout(andBack)).custom).toEqual(custom)
  })
})

describe('reconcileCustomLayout — unchanged by T9', () => {
  test('drops dead sessions, keeps groups, prepends new ones', () => {
    const custom: LayoutItem[] = [
      { type: 'group', id: 'g_1', name: 'Release' },
      { type: 'session', name: 'gone' },
      { type: 'session', name: 'kept' },
    ]
    const out = reconcileCustomLayout(custom, ['kept', 'brand-new'])
    expect(out[0]).toEqual({ type: 'session', name: 'brand-new' })
    expect(out.some((i) => i.type === 'session' && i.name === 'gone')).toBe(false)
    expect(out.some((i) => i.type === 'group' && i.id === 'g_1')).toBe(true)
  })

  test('a duplicate session entry collapses to one', () => {
    const out = reconcileCustomLayout(
      [
        { type: 'session', name: 'dup' },
        { type: 'session', name: 'dup' },
      ],
      ['dup'],
    )
    expect(out.filter((i) => i.type === 'session').length).toBe(1)
  })
})

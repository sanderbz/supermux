/**
 * `lib/fact-ladder.ts` — the table that says no surface silently drops a fact.
 *
 * Four rules, all four asserted here, because the ladder's only value is that it
 * is checkable: monotonicity, mark+attention everywhere, no ticking fact in a
 * picker, and the tile's tier-4 set equal to what the app renders today.
 */
import { describe, expect, test } from 'bun:test'

import {
  facts,
  FACTS,
  hasFact,
  listDetailCeiling,
  listDetailCeilingNote,
  type ListRowFacts,
  SURFACES,
  TICKING_FACTS,
  TIERS,
  TILE_FACTS_TODAY,
  type Fact,
  type Surface,
} from '../../src/lib/fact-ladder'

describe('the ladder is total', () => {
  test('every surface × tier has an answer', () => {
    for (const s of SURFACES) {
      for (const t of TIERS) {
        expect(facts(s, t).size).toBeGreaterThan(0)
      }
    }
  })

  test('every fact it names is in the vocabulary', () => {
    const vocab = new Set<Fact>(FACTS)
    for (const s of SURFACES) {
      for (const t of TIERS) {
        for (const f of facts(s, t)) expect(vocab.has(f)).toBe(true)
      }
    }
  })

  test('contextPct is deliberately absent — it does not exist in the app', () => {
    expect((FACTS as readonly string[]).includes('contextPct')).toBe(false)
  })
})

describe('rule 1 — monotonic: density may add, never subtract', () => {
  test('a fact at tier n is present at every tier above it', () => {
    for (const s of SURFACES) {
      for (const t of [1, 2, 3] as const) {
        const lower = facts(s, t)
        const upper = facts(s, (t + 1) as 2 | 3 | 4)
        for (const f of lower) {
          expect(upper.has(f)).toBe(true)
        }
      }
    }
  })
})

describe('rule 2 — mark and attention survive every collapse', () => {
  test('present on every surface at every tier', () => {
    for (const s of SURFACES) {
      for (const t of TIERS) {
        expect(hasFact(s, t, 'mark')).toBe(true)
        expect(hasFact(s, t, 'attention')).toBe(true)
      }
    }
  })

  test('even the densest surface carries them', () => {
    expect(facts('picker', 1).has('attention')).toBe(true)
  })
})

describe('rule 3 — a picker never mutates under the cursor', () => {
  test('no ticking fact at any tier', () => {
    for (const t of TIERS) {
      for (const ticking of TICKING_FACTS) {
        expect(hasFact('picker', t, ticking)).toBe(false)
      }
    }
  })

  test('the ticking set is the one the other surfaces actually use', () => {
    // A ticking fact nobody renders would make rule 3 vacuous.
    for (const ticking of TICKING_FACTS) {
      const used = SURFACES.some((s: Surface) => facts(s, 4).has(ticking))
      expect(used).toBe(true)
    }
  })
})

describe('rule 4 — the tile keeps everything it renders today', () => {
  test('tile tier 4 equals the status quo, exactly', () => {
    expect([...facts('tile', 4)].sort()).toEqual([...TILE_FACTS_TODAY].sort())
  })

  test('the tile is constant across tiers — the tiers buy pixels, not facts', () => {
    const t1 = [...facts('tile', 1)].sort()
    for (const t of TIERS) expect([...facts('tile', t)].sort()).toEqual(t1)
  })
})

describe('the reconciliation the ladder exists for', () => {
  test('the list keeps every fact SessionRow shows today', () => {
    // dot(→mark) · title(→name) · status · branch · ⌘N · host badge ·
    // needs-input pill(→statusLabel) · time
    for (const f of [
      'mark',
      'name',
      'statusLabel',
      'branch',
      'jumpChip',
      'hostBadge',
      'time',
    ] as const) {
      expect(hasFact('list', 1, f)).toBe(true)
    }
  })

  test('the list gains the preview the roster row was designed around', () => {
    expect(hasFact('list', 1, 'preview')).toBe(false)
    expect(hasFact('list', 2, 'preview')).toBe(true)
  })

  test('the strip keeps every fact CompactTile shows today', () => {
    for (const f of ['mark', 'name', 'tokens', 'branch', 'jumpChip'] as const) {
      expect(hasFact('strip', 1, f)).toBe(true)
    }
    // …and does NOT grow a preview: the strip's preview is the dwell popover,
    // which is an interaction, not a fact.
    expect(hasFact('strip', 4, 'preview')).toBe(false)
  })

  test('the picker keeps what the palette shows today and nothing that ticks', () => {
    expect(hasFact('picker', 1, 'name')).toBe(true)
    expect(hasFact('picker', 1, 'taskSummary')).toBe(true)
    expect(hasFact('picker', 4, 'time')).toBe(false)
  })

  test('the archive affordance stays a tile-only thing', () => {
    expect(hasFact('tile', 1, 'archiveAction')).toBe(true)
    for (const s of ['list', 'strip', 'picker'] as const) {
      expect(hasFact(s, 4, 'archiveAction')).toBe(false)
    }
  })
})

describe('the accessor', () => {
  test('is cached but never handed a mutable set', () => {
    const a = facts('list', 2)
    const b = facts('list', 2)
    expect(a).toBe(b)
    // A caller that mutates the cache would poison every row on the page; the
    // type is ReadonlySet, and the runtime shape is the same object — so this
    // test exists to document that mutating it is the caller's crime.
    expect(a.has('preview')).toBe(true)
  })

  test('defaults to tier 1', () => {
    expect([...facts('strip')].sort()).toEqual([...facts('strip', 1)].sort())
  })
})

describe('the list ladder stops where the CONTENT stops', () => {
  // Stepping List view through all four rungs on the shipping instance: tier 4
  // was byte-identical to tier 3 for every row measured, because the facts it
  // adds (tags) were empty on every session. The rung was honest and the
  // CONTROL was not — a density step that changes nothing reads as broken.
  const row = (over: Partial<ListRowFacts> = {}): ListRowFacts => ({
    tokens: false,
    tags: false,
    ...over,
  })

  test('one tagged session brings the top rung back for the whole roster', () => {
    expect(listDetailCeiling([row(), row({ tags: true })])).toBe(4)
    expect(listDetailCeilingNote(4)).toBeNull()
  })

  test('tokens but no tags ⇒ three rungs, and the reason names tags', () => {
    const ceiling = listDetailCeiling([row({ tokens: true })])
    expect(ceiling).toBe(3)
    expect(listDetailCeilingNote(ceiling)).toContain('tag')
  })

  test('neither ⇒ two rungs, and the reason names tokens', () => {
    const ceiling = listDetailCeiling([row(), row()])
    expect(ceiling).toBe(2)
    expect(listDetailCeilingNote(ceiling)).toContain('token')
  })

  test('the floor is 2, never 1 — the preview rung is transient, not absent', () => {
    // A ceiling of 1 would disable the control on a roster that is one printed
    // line away from having something to show, and would take the row's second
    // line away in the meantime.
    expect(listDetailCeiling([])).toBe(2)
  })
})

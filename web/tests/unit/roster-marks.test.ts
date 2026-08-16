/**
 * `lib/roster-marks.ts` — the dedupe nobody wired.
 *
 * The engine's own probe is unit-tested in `marks-character.test.ts`; what is
 * tested here is the thing B0 left out: that a *roster* gets distinct faces, in
 * an order that does not repaint when the roster changes, with an explicit
 * override outranking the deduper.
 *
 * The stability property is the one worth stating out loud, because it is the
 * one a naive implementation silently breaks: pins are assigned in CREATION
 * order, so a pin depends only on the sessions that existed before it. Sort the
 * roster differently, delete a row, rename a display name — every surviving face
 * is byte-identical.
 */
import { describe, expect, test } from 'bun:test'

import { assignRoster, HUE_SLOTS, SILHOUETTES } from '../../src/brand/marks/character'
import {
  decodeMarkPin,
  encodeMarkPin,
  freeTokens,
  rosterPins,
  type RosterCandidate,
} from '../../src/lib/roster-marks'

const stamp = (i: number): string =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()

const roster = (names: readonly string[]): RosterCandidate[] =>
  names.map((name, i) => ({ name, created_at: stamp(i) }))

const NAMES14 = [
  'supermux',
  'deploy-fix',
  'render-bug',
  'chat-dataplane',
  'strato',
  'readme-launch',
  'title-edit',
  'push-fixes',
  'archive-delete',
  'git-stack',
  'remote-ssh',
  'scrollback',
  'kimi-code',
  'night-watch',
] as const

const keyOf = (p: { silhouette?: string; hue?: number }): string => `${p.silhouette}:${p.hue}`

const keys = (pins: ReadonlyMap<string, { silhouette?: string; hue?: number }>): string[] =>
  [...pins.values()].map((p) => `${p.silhouette}:${p.hue}`)

describe('rosterPins — distinct faces', () => {
  test('14 sessions → 14 distinct silhouette + pigment pairs', () => {
    const pins = rosterPins(roster(NAMES14))
    expect(pins.size).toBe(14)
    expect(new Set(keys(pins)).size).toBe(14)
  })

  test('every pin is a real token the engine can draw', () => {
    const pins = rosterPins(roster(NAMES14))
    for (const pin of pins.values()) {
      expect(SILHOUETTES).toContain(pin.silhouette!)
      expect(HUE_SLOTS).toContain(pin.hue!)
    }
  })

  test('63 sessions still get 63 distinct pairs — the whole token space', () => {
    const names = Array.from({ length: 63 }, (_, i) => `session-${i}`)
    const pins = rosterPins(roster(names))
    expect(new Set(keys(pins)).size).toBe(63)
  })

  test('a solo session is hash-pure — assignment never moves it', () => {
    const solo = rosterPins(roster(['supermux'])).get('supermux')!
    const inCrowd = rosterPins(roster(NAMES14)).get('supermux')!
    // `supermux` is first in creation order, so the crowd cannot displace it.
    expect(inCrowd).toEqual(solo)
  })
})

describe('rosterPins — stability', () => {
  test('deleting the first session leaves every surviving pin unchanged', () => {
    const before = rosterPins(roster(NAMES14))
    const after = rosterPins(roster(NAMES14.slice(1)))
    for (const name of NAMES14.slice(1)) {
      expect(after.get(name)).toEqual(before.get(name)!)
    }
  })

  test('deleting a middle session leaves every surviving pin unchanged', () => {
    const before = rosterPins(roster(NAMES14))
    const kept = NAMES14.filter((n) => n !== 'strato')
    const after = rosterPins(roster(kept))
    for (const name of kept) expect(after.get(name)).toEqual(before.get(name)!)
  })

  test('the reason first-fit is used: the balanced allocator is NOT stable', () => {
    // This is the measurement behind the module doc, kept as a test so the
    // decision cannot be quietly reverted to `assignRoster` "for consistency".
    const before = assignRoster(NAMES14)
    const after = assignRoster(NAMES14.slice(1))
    const moved = NAMES14.slice(1).filter((n) => {
      const a = before.get(n)!
      const b = after.get(n)!
      return a.silhouette !== b.silhouette || a.hue !== b.hue
    })
    expect(moved.length).toBeGreaterThan(0)
    // …and rosterPins, over the identical roster, moves nobody.
    const p1 = rosterPins(roster(NAMES14))
    const p2 = rosterPins(roster(NAMES14.slice(1)))
    expect(NAMES14.slice(1).filter((n) => keyOf(p1.get(n)!) !== keyOf(p2.get(n)!))).toEqual([])
  })

  test('render order does not matter — creation order is the contract', () => {
    const base = rosterPins(roster(NAMES14))
    const shuffled = [...roster(NAMES14)].reverse()
    const other = rosterPins(shuffled)
    for (const name of NAMES14) expect(other.get(name)).toEqual(base.get(name)!)
  })

  test('a new session joins at the tail without disturbing the roster', () => {
    const before = rosterPins(roster(NAMES14))
    const grown = [...roster(NAMES14), { name: 'brand-new', created_at: stamp(99) }]
    const after = rosterPins(grown)
    for (const name of NAMES14) expect(after.get(name)).toEqual(before.get(name)!)
    expect(after.get('brand-new')).toBeDefined()
  })

  test('sessions with no created_at still get a face, ordered by slug', () => {
    const pins = rosterPins([{ name: 'zeta' }, { name: 'alpha' }, { name: 'mid' }])
    expect(pins.size).toBe(3)
    expect(new Set(keys(pins)).size).toBe(3)
    // Deterministic regardless of input order.
    const again = rosterPins([{ name: 'mid' }, { name: 'zeta' }, { name: 'alpha' }])
    for (const n of ['alpha', 'mid', 'zeta']) expect(again.get(n)).toEqual(pins.get(n)!)
  })
})

describe('rosterPins — overrides', () => {
  test('an override is honoured verbatim', () => {
    const pins = rosterPins(roster(NAMES14), {
      'render-bug': { silhouette: 'wedge', hue: 350 },
    })
    expect(pins.get('render-bug')).toMatchObject({ silhouette: 'wedge', hue: 350 })
  })

  test('the rest dedupe AROUND the override — nobody else wears its token', () => {
    // Pick the token some *other* session was derived into, and hand it to
    // `render-bug` as an override: the collision is then guaranteed, not hoped
    // for, and the displaced session must move.
    const base = rosterPins(roster(NAMES14))
    const victimToken = base.get('git-stack')!
    const pins = rosterPins(roster(NAMES14), {
      'render-bug': { silhouette: victimToken.silhouette, hue: victimToken.hue },
    })
    expect(pins.get('render-bug')).toMatchObject({
      silhouette: victimToken.silhouette,
      hue: victimToken.hue,
    })
    expect(new Set(keys(pins)).size).toBe(14)
    expect(`${pins.get('git-stack')!.silhouette}:${pins.get('git-stack')!.hue}`).not.toBe(
      `${victimToken.silhouette}:${victimToken.hue}`,
    )
  })

  test('a partial override (hue only) still dedupes', () => {
    const pins = rosterPins(roster(NAMES14), { strato: { hue: 265 } })
    expect(pins.get('strato')!.hue).toBe(265)
    expect(pins.get('strato')!.silhouette).toBeDefined()
    expect(new Set(keys(pins)).size).toBe(14)
  })

  test('gaze / tilt ride through untouched', () => {
    const pins = rosterPins(roster(NAMES14), {
      'title-edit': { silhouette: 'egg', hue: 190, gaze: 8, tilt: -27 },
    })
    expect(pins.get('title-edit')).toEqual({
      silhouette: 'egg',
      hue: 190,
      gaze: 8,
      tilt: -27,
    })
  })

  test('an override for a session not in the roster is ignored', () => {
    const base = rosterPins(roster(NAMES14))
    const pins = rosterPins(roster(NAMES14), { ghost: { silhouette: 'cube', hue: 28 } })
    expect(pins.has('ghost')).toBe(false)
    for (const n of NAMES14) expect(pins.get(n)).toEqual(base.get(n)!)
  })

  test('overrides work as a plain record OR a Map', () => {
    const asMap = rosterPins(roster(NAMES14), new Map([['strato', { hue: 265 }]]))
    const asRecord = rosterPins(roster(NAMES14), { strato: { hue: 265 } })
    expect(keys(asMap)).toEqual(keys(asRecord))
  })
})

describe('rosterPins — degradation and purity', () => {
  test('>63 sessions degrades to repeats, never throws, and everyone gets a face', () => {
    const names = Array.from({ length: 90 }, (_, i) => `s-${i}`)
    const pins = rosterPins(roster(names))
    expect(pins.size).toBe(90)
    for (const pin of pins.values()) {
      expect(SILHOUETTES).toContain(pin.silhouette!)
      expect(HUE_SLOTS).toContain(pin.hue!)
    }
    // The first 63 are still distinct — degradation starts where the space ends.
    expect(new Set(keys(pins).slice(0, 63)).size).toBe(63)
  })

  test('an empty roster is an empty map, not a throw', () => {
    expect(rosterPins([]).size).toBe(0)
  })

  test('pure — same input, same output, and the input is not mutated', () => {
    const input = roster(NAMES14)
    const snapshot = JSON.stringify(input)
    const a = rosterPins(input)
    const b = rosterPins(input)
    expect(keys(a)).toEqual(keys(b))
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  test('duplicate names collapse to one pin rather than fighting', () => {
    const pins = rosterPins([
      { name: 'dup', created_at: stamp(0) },
      { name: 'dup', created_at: stamp(1) },
    ])
    expect(pins.size).toBe(1)
  })
})

describe('mark_pin encoding — one format, two halves, one file', () => {
  test('round-trips', () => {
    const pin = { silhouette: 'wedge' as const, hue: 350 }
    expect(decodeMarkPin(encodeMarkPin(pin))).toEqual(pin)
  })

  test('a partial pin has no wire form', () => {
    expect(encodeMarkPin({ hue: 350 })).toBeNull()
    expect(encodeMarkPin({})).toBeNull()
  })

  test('garbage decodes to undefined, never to a face the engine cannot draw', () => {
    expect(decodeMarkPin(null)).toBeUndefined()
    expect(decodeMarkPin('')).toBeUndefined()
    expect(decodeMarkPin('nonsense')).toBeUndefined()
    expect(decodeMarkPin('wedge:999')).toBeUndefined()
    expect(decodeMarkPin('pyramid:350')).toBeUndefined()
    expect(decodeMarkPin('wedge')).toBeUndefined()
  })
})

describe('freeTokens — what a reroll may hand out', () => {
  test('a 14-session roster leaves 63 − 13 free for the one rerolling', () => {
    const pins = rosterPins(roster(NAMES14))
    const free = freeTokens(pins, 'render-bug')
    expect(free.length).toBe(63 - 13)
  })

  test('nothing free collides with a face in use', () => {
    const pins = rosterPins(roster(NAMES14))
    const used = new Set(
      [...pins].filter(([n]) => n !== 'render-bug').map(([, p]) => `${p.silhouette}:${p.hue}`),
    )
    for (const t of freeTokens(pins, 'render-bug')) {
      expect(used.has(`${t.silhouette}:${t.hue}`)).toBe(false)
    }
  })

  test('a full roster leaves nothing free — and says so instead of throwing', () => {
    const names = Array.from({ length: 63 }, (_, i) => `session-${i}`)
    const pins = rosterPins(roster(names))
    expect(freeTokens(pins).length).toBe(0)
  })
})

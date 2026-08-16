/**
 * The reroll contract (fase B2 T8).
 *
 * A reroll may never hand out a face somebody else is already wearing — that is
 * the whole point of the roster-wide assignment, and a reroll that could collide
 * would undo it one click at a time. The sheet's picker is
 * `freeTokens(pins)[(reroll - 1) % free.length]`, so what has to hold is: the
 * free list excludes every worn token, the cycle is stable and total, and a
 * session with NO override is byte-identical to today.
 */
import { describe, expect, test } from 'bun:test'

import { characterFromSeed } from '../../src/brand/marks/character'
import {
  encodeMarkPin,
  decodeMarkPin,
  freeTokens,
  rosterPins,
  type RosterCandidate,
} from '../../src/lib/roster-marks'

const stamp = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
const roster = (names: readonly string[]): RosterCandidate[] =>
  names.map((name, i) => ({ name, created_at: stamp(i) }))

const NAMES = [
  'supermux',
  'deploy-fix',
  'render-bug',
  'chat-dataplane',
  'strato',
  'readme-launch',
]

/** What the sheet does, in one line, so the test exercises the real rule. */
const pick = (pins: ReturnType<typeof rosterPins>, reroll: number) => {
  if (reroll === 0) return undefined
  const free = freeTokens(pins)
  if (free.length === 0) return undefined
  return free[(reroll - 1) % free.length]
}

describe('a reroll can never collide', () => {
  const pins = rosterPins(roster(NAMES))
  const worn = new Set([...pins.values()].map((p) => `${p.silhouette}:${p.hue}`))

  test('every reroll in a full cycle lands on a free token', () => {
    for (let i = 1; i <= 63; i++) {
      const picked = pick(pins, i)!
      expect(worn.has(`${picked.silhouette}:${picked.hue}`)).toBe(false)
    }
  })

  test('the cycle is total — it wraps instead of running out', () => {
    const free = freeTokens(pins)
    expect(pick(pins, free.length + 1)).toEqual(free[0])
  })

  test('the picker is deterministic — the same click count is the same face', () => {
    expect(pick(pins, 4)).toEqual(pick(pins, 4))
  })

  test('a FULL roster degrades to the derived face rather than a duplicate', () => {
    const full = rosterPins(roster(Array.from({ length: 63 }, (_, i) => `s-${i}`)))
    expect(freeTokens(full).length).toBe(0)
    expect(pick(full, 1)).toBeUndefined()
  })
})

describe('no reroll ⇒ nothing changes', () => {
  test('reroll 0 stores no pin at all', () => {
    expect(pick(rosterPins(roster(NAMES)), 0)).toBeUndefined()
  })

  test('a session with no override renders its derived face, byte-identically', () => {
    // The face a session gets with `mark_pin = NULL` is exactly the roster
    // assignment — the column changes nothing until someone rerolls.
    const pins = rosterPins(roster(NAMES))
    const derived = characterFromSeed('strato', pins.get('strato'))
    const withNullColumn = characterFromSeed('strato', decodeMarkPin(null) ?? pins.get('strato'))
    expect(withNullColumn).toEqual(derived)
  })
})

describe('what gets written to mark_pin', () => {
  test('a picked token encodes to the column format', () => {
    const picked = pick(rosterPins(roster(NAMES)), 2)!
    const encoded = encodeMarkPin(picked)!
    expect(encoded).toMatch(/^[a-z]+:\d+$/)
    expect(decodeMarkPin(encoded)).toEqual(picked)
  })

  test('a decoded override is what the roster then seats FIRST', () => {
    const picked = pick(rosterPins(roster(NAMES)), 3)!
    const pins = rosterPins(roster([...NAMES, 'newcomer']), {
      newcomer: decodeMarkPin(encodeMarkPin(picked))!,
    })
    expect(pins.get('newcomer')).toMatchObject(picked)
    // …and the roster is still collision-free with the override in it.
    const keys = [...pins.values()].map((p) => `${p.silhouette}:${p.hue}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

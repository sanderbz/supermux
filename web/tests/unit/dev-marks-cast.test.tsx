/**
 * The `/dev/marks` bench cast — a coverage contract, not a fixture dump.
 *
 * The bench exists so that task 4 (and every later phase) has ONE surface where
 * every identity channel is on screen at once. That claim is only true if the
 * cast actually spans the channels, so it is asserted here rather than eyeballed:
 * all 9 silhouettes, all 7 pigments, all 6 states, the 18/28/40 ladder, and the
 * seven approved reference characters at their approved pins.
 *
 * The cast's pins come straight from `assignRoster`, so this doubles as a dedupe
 * regression: if the deduper stops handing nine sessions nine distinct
 * silhouettes, the bench silently loses a shape — and this test fails first.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  assignRoster,
  HUE_SLOTS,
  SILHOUETTES,
  type MarkState,
} from '../../src/brand/marks/character'
import { SessionMark } from '../../src/brand/marks/session-mark'
import {
  BENCH_THEMES,
  CAST,
  CAST_NAMES,
  LIVE_STATES,
  MARK_SIZE_ROLES,
  MARK_SIZES,
  MARK_STATES,
  REFERENCE_STRIP,
  ROSTER,
  ROSTER_NAMES,
} from '../../src/routes/dev-marks.cast'

describe('the ladder the bench renders', () => {
  test('is exactly 18 / 28 / 40, each with a documented role', () => {
    expect([...MARK_SIZES]).toEqual([18, 28, 40])
    for (const size of MARK_SIZES) {
      expect(MARK_SIZE_ROLES[size].length).toBeGreaterThan(0)
    }
  })

  test('both themes are benched', () => {
    expect([...BENCH_THEMES]).toEqual(['light', 'dark'])
  })
})

describe('the states the bench renders', () => {
  test('every state in the union, exactly once', () => {
    const all: MarkState[] = ['idle', 'working', 'waiting', 'done', 'stopped', 'failed']
    expect([...MARK_STATES].sort()).toEqual([...all].sort())
    expect(new Set(MARK_STATES).size).toBe(MARK_STATES.length)
  })

  test('the live strip poses only states that actually animate', () => {
    expect([...LIVE_STATES]).toEqual(['idle', 'working', 'waiting'])
    for (const state of LIVE_STATES) expect(MARK_STATES).toContain(state)
  })
})

describe('the cast spans every identity channel', () => {
  test('nine unique names', () => {
    expect(new Set(CAST_NAMES).size).toBe(CAST_NAMES.length)
    expect(CAST.length).toBe(CAST_NAMES.length)
  })

  test('all nine silhouettes, each exactly once', () => {
    const shapes = CAST.map((c) => c.pin.silhouette)
    expect(new Set(shapes).size).toBe(SILHOUETTES.length)
    expect([...shapes].sort()).toEqual([...SILHOUETTES].sort())
  })

  test('all seven pigments appear', () => {
    const hues = new Set(CAST.map((c) => c.pin.hue))
    for (const hue of HUE_SLOTS) expect(hues.has(hue)).toBe(true)
  })

  test('the pins are the deduper output, not hand-authored', () => {
    const assigned = assignRoster(CAST_NAMES)
    for (const member of CAST) {
      expect(member.pin).toEqual(assigned.get(member.name)!)
    }
  })

  test('no two bench faces are the same face', () => {
    const faces = CAST.map((c) =>
      renderToStaticMarkup(<SessionMark seed={c.name} pin={c.pin} state="idle" />),
    )
    expect(new Set(faces).size).toBe(CAST.length)
  })
})

describe('the reference strip is the approved seven', () => {
  test('the seven names of avatar-strip@2x.png, in strip order', () => {
    expect(REFERENCE_STRIP.map((m) => m.name)).toEqual([
      'Release Train',
      'Patch',
      'Quill',
      'Ledger',
      'Compass',
      'Lookout',
      'Kestrel',
    ])
  })

  test('one distinct silhouette and one distinct pigment each', () => {
    expect(new Set(REFERENCE_STRIP.map((m) => m.pin.silhouette)).size).toBe(REFERENCE_STRIP.length)
    expect([...new Set(REFERENCE_STRIP.map((m) => m.pin.hue))].sort((a, b) => a! - b!)).toEqual([
      ...HUE_SLOTS,
    ])
  })

  test('every pinned silhouette is a real silhouette', () => {
    for (const m of REFERENCE_STRIP) {
      expect(SILHOUETTES).toContain(m.pin.silhouette!)
    }
  })
})

describe('the dedupe panel', () => {
  test('fourteen unique names, all deduped to distinct silhouette×hue pairs', () => {
    expect(new Set(ROSTER_NAMES).size).toBe(ROSTER_NAMES.length)
    const tokens = ROSTER.map((m) => `${m.pin.silhouette}|${m.pin.hue}`)
    expect(new Set(tokens).size).toBe(ROSTER.length)
  })
})

/**
 * The `/dev/marks` bench cast — a coverage contract, not a fixture dump.
 *
 * The bench exists so that task 4 (and every later phase) has ONE surface where
 * every identity channel is on screen at once. That claim is only true if the
 * cast actually spans the channels, so it is asserted here rather than eyeballed:
 * all 9 silhouettes, all 7 pigments, all 6 states, the 18/28/40 ladder, and the
 * seven approved reference characters at their approved pins.
 *
 * The other half of the contract is parity: the bench exists to be held up next
 * to `avatar-strip@2x.png`, so every section has to show the SAME nine
 * characters, and the seven approved ones have to be the approved ones. A page
 * where "Release Train" is a coral cube in one section and a pink wedge in the
 * next is not a reference surface — so that is asserted here too.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  assignRoster,
  characterFromSeed,
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
  REFERENCE_STATE,
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

  test('no two bench faces share a silhouette×hue token', () => {
    const tokens = CAST.map((c) => `${c.pin.silhouette}|${c.pin.hue}`)
    expect(new Set(tokens).size).toBe(CAST.length)
  })

  test('every name on the page is ONE character — the cast agrees with the strip', () => {
    // The bench is the parity anchor for avatar-strip@2x.png. If "Release Train"
    // is a coral cube in the reference strip and a pink wedge in the ladder, the
    // ladder, the state matrix, the facepile and the live strip are all showing
    // characters that do not exist in the approved design.
    const byName = new Map(CAST.map((c) => [c.name, c.pin]))
    for (const member of REFERENCE_STRIP) {
      expect(byName.get(member.name)).toEqual(member.pin)
    }
  })

  test('the cast is the approved seven plus exactly the two shapes they cannot show', () => {
    expect(CAST.slice(0, REFERENCE_STRIP.length)).toEqual([...REFERENCE_STRIP])
    const extras = CAST.slice(REFERENCE_STRIP.length).map((c) => c.pin.silhouette)
    const approved = new Set(REFERENCE_STRIP.map((m) => m.pin.silhouette))
    expect([...extras].sort()).toEqual(SILHOUETTES.filter((s) => !approved.has(s)).sort())
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

  test('its pins are assignRoster output — this panel is the deduper demo', () => {
    // The one section of the bench that shows the real roster path. The cast is
    // deliberately pinned to the approved render instead (see the parity test),
    // so if this stops being the deduper, nothing on the page exercises it.
    const assigned = assignRoster(ROSTER_NAMES)
    for (const member of ROSTER) {
      expect(member.pin).toEqual(assigned.get(member.name)!)
    }
  })

  test('the deduper visibly does work on these fourteen names', () => {
    // Guards the panel's reason to exist. Pure hashing crowds these 14 sessions
    // onto 6 of the 9 silhouettes; the deduper spreads them over all 9 and moves
    // most of the roster to do it. If a future engine change made hashing alone
    // sufficient here, the panel would be showing nothing and should be reseeded.
    const pure = ROSTER_NAMES.map((n) => characterFromSeed(n))
    const pureShapes = new Set(pure.map((c) => c.silhouette))
    const assignedShapes = new Set(ROSTER.map((m) => m.pin.silhouette))
    expect(pureShapes.size).toBeLessThan(assignedShapes.size)
    expect(assignedShapes.size).toBe(SILHOUETTES.length)

    const moved = ROSTER.filter(
      (m, i) => pure[i].silhouette !== m.pin.silhouette || pure[i].hue !== m.pin.hue,
    )
    expect(moved.length).toBeGreaterThan(0)
  })
})

describe('the reference strip is the approved render, pose included', () => {
  test('every one of the seven is pinned to a gaze and an idle tilt', () => {
    // The approved cast is art-directed: silhouette and pigment alone do not
    // reproduce it, because where a character LOOKS and how its eyes lean are
    // pinned too. Drop these and the strip drifts back to seven seeded faces
    // that merely wear the right colours.
    for (const m of REFERENCE_STRIP) {
      expect(typeof m.pin.gaze, m.name).toBe('number')
      expect(typeof m.pin.tilt, m.name).toBe('number')
    }
  })

  test('each is posed in the state it wears on avatar-strip@2x.png', () => {
    expect(REFERENCE_STRIP.map((m) => REFERENCE_STATE[m.name])).toEqual([
      'working',
      'working',
      'waiting',
      'idle',
      'idle',
      'done',
      'done',
    ])
  })

  test('the strip poses more than one state — an all-idle strip is the bug', () => {
    const posed = new Set(REFERENCE_STRIP.map((m) => REFERENCE_STATE[m.name]))
    expect(posed.size).toBeGreaterThan(1)
  })
})

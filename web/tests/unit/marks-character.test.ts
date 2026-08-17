/**
 * The procedural character engine — seed → character.
 *
 * The engine is the identity layer of the approved B0 design system: a session
 * name is hashed into a *character* (silhouette, pigment, eye geometry, blink
 * clock), never into a lookup of hand-drawn assets. Three properties are
 * load-bearing and are the reason this suite exists:
 *
 *   · determinism — the same name must produce the same face on every client,
 *     every reload, and (later) on the server that persists the columns;
 *   · distribution — a real roster must not show the same silhouette in the
 *     same pigment twice, or identity stops working at a glance;
 *   · state → eyes — the face IS the status indicator (concept contract C5),
 *     so the state→eye-geometry mapping is a contract, not a decoration.
 *
 * Numbers are taken from the hero mockup that produced board-light.png /
 * board-dark.png (scratchpad/hero-mockup/src/page.html); the regression vectors
 * at the bottom pin the ones a refactor could silently drift.
 */
import { describe, expect, test } from 'bun:test'

import {
  assignRoster,
  BLINK_CLOSING,
  blinkPeriod,
  characterFromSeed,
  CLOSED_LID,
  eyeClock,
  eyesFor,
  hash32,
  HUE_SLOTS,
  isLive,
  SILHOUETTES,
  type MarkState,
} from '../../src/brand/marks/character'
import { REFERENCE_STRIP } from '../../src/routes/dev-marks.cast'

/** A realistic roster: supermux session names in the approved (human) register. */
const ROSTER_20 = [
  'Release Train',
  'Patch',
  'Quill',
  'Ledger',
  'Compass',
  'Lookout',
  'Kestrel',
  'Beacon',
  'Ferry',
  'Anvil',
  'Sentry',
  'Harbor',
  'Tinder',
  'Meridian',
  'Otter',
  'Pilot',
  'Rook',
  'Sable',
  'Tally',
  'Vellum',
]

/** The kebab-case slugs the app still creates today — same guarantee required. */
const SLUGS_20 = [
  'deploy-fix',
  'web',
  'supermux',
  'render-bug',
  'strato-deploy',
  'ci-green',
  'mobile-ui',
  'notify-hook',
  'term-fix',
  'chat-renderer',
  'marks-b0',
  'device-auth',
  'native-runtime',
  'updater',
  'readme-hero',
  'scrollback',
  'codex-spinner',
  'recall-fix',
  'launch-audit',
  'mux-docs',
]

describe('determinism', () => {
  test('the same seed yields a byte-identical character', () => {
    for (const seed of ROSTER_20) {
      expect(characterFromSeed(seed)).toEqual(characterFromSeed(seed))
    }
  })

  test('every derived field is a finite number, not NaN', () => {
    for (const seed of [...ROSTER_20, ...SLUGS_20]) {
      const ch = characterFromSeed(seed)
      const numbers = [
        ch.body.rx,
        ch.body.ry,
        ch.body.rz,
        ch.body.n,
        ch.gaze,
        ch.clock,
        ch.faceDY,
        ch.eyes.wL,
        ch.eyes.hL,
        ch.eyes.spacing,
        ch.eyes.pyL,
        ch.eyes.angleL,
        ch.eyes.angleR,
        ch.asym.w,
        ch.asym.h,
        ch.asym.py,
        ch.asym.slant,
        ch.pose.x,
        ch.pose.y,
        ch.pose.z,
      ]
      for (const n of numbers) expect(Number.isFinite(n)).toBe(true)
      expect(ch.color).toMatch(/^#[0-9a-f]{6}$/)
      expect(ch.ink).toBe('#ffffff')
    }
  })

  test('a pin overrides what it names, and hue/silhouette are stream-inert', () => {
    const free = characterFromSeed('Quill')
    const pinned = characterFromSeed('Quill', { hue: 350 })
    expect(pinned.hue).toBe(350)
    // `hue` is a pure relabel: it consumes no draw, so nothing downstream moves.
    expect(pinned.silhouette).toBe(free.silhouette)
    expect(pinned.eyes).toEqual(free.eyes)
    expect(pinned.asym).toEqual(free.asym)
    expect(pinned.clock).toBe(free.clock)
  })

  test('pinning gaze or tilt SKIPS its draw — the documented reference behaviour', () => {
    // This is not a wart to iron out, it is the contract that makes the shipped
    // faces the approved faces: the mockup that rendered avatar-strip@2x.png
    // skipped the draw a pin covered, so an engine that draws unconditionally
    // reproduces a DIFFERENT cast (verified: every eye downstream moves). Pinning
    // is a create-time decision, never a runtime toggle, so this is stable.
    const free = characterFromSeed('Quill')
    const gazed = characterFromSeed('Quill', { gaze: 12 })
    expect(gazed.gaze).toBe(12)
    expect(gazed.eyes.spacing).not.toBe(free.eyes.spacing)

    const tilted = characterFromSeed('Quill', { tilt: 22 })
    expect(tilted.eyes.angleL).toBe(22)
    expect(tilted.eyes.spacing).not.toBe(free.eyes.spacing)
  })

  test('the approved cast is reproduced exactly (avatar-strip@2x.png parity)', () => {
    // Golden vectors, computed from the hero mockup's own `characterFromSeed`
    // with the pins its CAST table carries. If any of these move, /dev/marks'
    // reference strip has stopped being the seven faces in the approved render —
    // which is the single most visible regression this design system can have.
    const GOLDEN: readonly (readonly [string, number, number, number, number, number])[] = [
      ['Release Train', 34.772132, 77.313201, 61.940613, 5.456485, 25.77838],
      ['Patch', 31.614769, 67.889746, 69.228192, 0.497686, -22.984404],
      ['Quill', 31.628387, 66.405682, 69.072566, -3.442429, 20.492053],
      ['Ledger', 34.925202, 73.269615, 63.489594, -4.201357, 26.986074],
      ['Compass', 32.765657, 69.518364, 68.114858, -3.724948, -29.346511],
      ['Lookout', 34.693552, 75.523241, 65.317618, 1.503131, 25.319349],
      ['Kestrel', 37.912653, 68.988207, 64.346648, -2.153968, -30.993423],
    ]
    const byName = new Map(REFERENCE_STRIP.map((m) => [m.name, m.pin]))
    for (const [name, wL, hL, spacing, pyL, angleR] of GOLDEN) {
      const pin = byName.get(name)
      expect(pin).toBeDefined()
      const ch = characterFromSeed(name, pin)
      expect(ch.eyes.wL).toBeCloseTo(wL, 5)
      expect(ch.eyes.hL).toBeCloseTo(hL, 5)
      expect(ch.eyes.spacing).toBeCloseTo(spacing, 5)
      expect(ch.eyes.pyL).toBeCloseTo(pyL, 5)
      expect(ch.eyes.angleR).toBeCloseTo(angleR, 5)
      expect(ch.eyes.angleL).toBe(pin!.tilt)
      expect(ch.gaze).toBe(pin!.gaze)
    }
  })

  test('an authored silhouette pin re-seats the body, by design', () => {
    // Authored outlines are drawn, not projected, so they skip the three body
    // jitter draws — the documented consequence is that the rest of the stream
    // shifts. Pinning is a create-time decision, so this is stable, not flaky.
    const solid = characterFromSeed('Quill', { silhouette: 'pebble' })
    const drawn = characterFromSeed('Quill', { silhouette: 'wedge' })
    expect(solid.body).not.toEqual(drawn.body)
    expect(drawn.faceDY).toBe(34)
    expect(drawn.authored).toBe(true)
    expect(solid.authored).toBe(false)
  })

  test('hash32 is FNV-1a-32 (known vectors)', () => {
    // Cross-checked against the spec's own table (b0-mark-spec §7).
    expect(hash32('deploy-fix')).toBe(0x62b1d3ac)
    expect(hash32('web')).toBe(0x0fd9bc91)
    expect(hash32('supermux')).toBe(0xb183cc36)
  })
})

describe('distribution', () => {
  test('20 realistic session names get 20 distinct silhouette+hue pairs', () => {
    const assigned = assignRoster(ROSTER_20)
    const pairs = ROSTER_20.map((s) => {
      const p = assigned.get(s)!
      return `${p.silhouette}/${p.hue}`
    })
    expect(new Set(pairs).size).toBe(20)
  })

  test('20 legacy slugs get 20 distinct silhouette+hue pairs', () => {
    const assigned = assignRoster(SLUGS_20)
    const pairs = SLUGS_20.map((s) => {
      const p = assigned.get(s)!
      return `${p.silhouette}/${p.hue}`
    })
    expect(new Set(pairs).size).toBe(20)
  })

  test('a single session is hash-pure — assignment never moves it', () => {
    for (const seed of ROSTER_20) {
      const solo = assignRoster([seed]).get(seed)!
      const ch = characterFromSeed(seed)
      expect(solo.silhouette).toBe(ch.silhouette)
      expect(solo.hue).toBe(ch.hue)
    }
  })

  test('pairs stay distinct for every roster size up to the token count', () => {
    const cap = SILHOUETTES.length * HUE_SLOTS.length
    for (let n = 1; n <= cap; n++) {
      const seeds = Array.from({ length: n }, (_, i) => `session-${i}-${n}`)
      const assigned = assignRoster(seeds)
      const pairs = seeds.map((s) => {
        const p = assigned.get(s)!
        return `${p.silhouette}/${p.hue}`
      })
      expect(new Set(pairs).size).toBe(n)
    }
  })

  test('hue and silhouette both stay balanced across a 20-roster', () => {
    const assigned = assignRoster(ROSTER_20)
    const hues = new Map<number, number>()
    const shapes = new Map<string, number>()
    for (const p of assigned.values()) {
      hues.set(p.hue, (hues.get(p.hue) ?? 0) + 1)
      shapes.set(p.silhouette, (shapes.get(p.silhouette) ?? 0) + 1)
    }
    // ⌈20/7⌉ = 3 hues, ⌈20/9⌉ = 3 silhouettes is the information-theoretic floor.
    expect(Math.max(...hues.values())).toBeLessThanOrEqual(3)
    expect(Math.max(...shapes.values())).toBeLessThanOrEqual(3)
  })

  test('assignment is order-deterministic and re-runs identically', () => {
    const a = assignRoster(ROSTER_20)
    const b = assignRoster(ROSTER_20)
    for (const seed of ROSTER_20) expect(a.get(seed)).toEqual(b.get(seed))
  })
})

describe('state → eye geometry', () => {
  const seed = 'Release Train'
  const ch = characterFromSeed(seed)

  test('working narrows and slants the eyes (concentration)', () => {
    const idle = eyesFor(ch, 'idle')
    const work = eyesFor(ch, 'working')
    expect(work.wL).toBeCloseTo(idle.wL * 0.54, 6)
    expect(work.hL).toBeCloseTo(idle.hL * 0.78, 6)
    expect(work.angleL).toBeCloseTo(-26 + ch.asym.slant, 6)
    expect(work.angleR).toBeCloseTo(-26 + ch.asym.slant + 3.2, 6)
  })

  test('waiting rounds the eyes and levels the tilt (attention)', () => {
    const idle = eyesFor(ch, 'idle')
    const wait = eyesFor(ch, 'waiting')
    const w = ((ch.eyes.wL + ch.eyes.hL) / 2) * 0.8
    expect(wait.wL).toBeCloseTo(w, 6)
    expect(wait.hL).toBeCloseTo(w * 1.04, 6)
    // Round, not slotted: aspect ratio within 5% of 1.
    expect(wait.hL / wait.wL).toBeCloseTo(1.04, 6)
    expect(Math.abs(wait.angleL)).toBeLessThan(Math.abs(idle.angleL))
    expect(wait.angleL).toBeCloseTo(idle.angleL * 0.35, 6)
  })

  test('done closes the eyes to a content squint', () => {
    const idle = eyesFor(ch, 'idle')
    const done = eyesFor(ch, 'done')
    expect(done.hL).toBeCloseTo(idle.hL * 0.3, 6)
    expect(done.wL).toBeCloseTo(idle.wL * 1.05, 6)
    expect(done.hL).toBeLessThan(done.wL)
  })

  test('stopped shuts the eyes to a lid line — asleep, and visibly so', () => {
    const idle = eyesFor(ch, 'idle')
    const stopped = eyesFor(ch, 'stopped')
    expect(stopped.hL).toBe(CLOSED_LID)
    // A line, not a lozenge: shorter than `done`'s squint and far shorter than idle.
    expect(stopped.hL).toBeLessThan(eyesFor(ch, 'done').hL)
    expect(stopped.hL).toBeLessThan(idle.hL * 0.2)
    expect(stopped.wL).toBeCloseTo(idle.wL * 1.06, 6)
    expect(stopped.angleL).toBeCloseTo(idle.angleL * 0.45, 6)
  })

  test('failed mirrors the tilt — the only state whose eyes are not parallel', () => {
    const failed = eyesFor(ch, 'failed')
    expect(failed.angleL).toBeCloseTo(42 + ch.asym.slant, 6)
    expect(failed.angleR).toBeCloseTo(-(42 + ch.asym.slant), 6)
    // Mirrored: the two tilts have opposite sign and equal magnitude.
    expect(Math.sign(failed.angleL)).toBe(-Math.sign(failed.angleR))
    expect(Math.abs(failed.angleL)).toBeCloseTo(Math.abs(failed.angleR), 6)
    expect(failed.hL).toBeCloseTo(eyesFor(ch, 'idle').hL * 0.86, 6)
    // A slot, not a lozenge — a tilt is invisible on a near-circular eye.
    expect(failed.hL).toBeGreaterThan(failed.wL * 1.5)
  })

  test('every other state keeps the two eyes parallel — failed is the falsifier', () => {
    for (const state of ['idle', 'working', 'waiting', 'done', 'stopped'] as MarkState[]) {
      const e = eyesFor(ch, state)
      // Same sign (or both zero): parallel-ish, never mirrored.
      expect(Math.sign(e.angleL)).toBe(Math.sign(e.angleR))
    }
  })

  test('no two states paint the same eye geometry', () => {
    const all: MarkState[] = ['idle', 'working', 'waiting', 'done', 'stopped', 'failed']
    const shapes = all.map((s) => JSON.stringify(eyesFor(ch, s)))
    expect(new Set(shapes).size).toBe(all.length)
  })

  test('the two eyes are always asymmetric — never a symmetric doll face', () => {
    for (const state of ['idle', 'working', 'waiting', 'done', 'stopped', 'failed'] as MarkState[]) {
      const e = eyesFor(ch, state)
      expect(e.wR).not.toBe(e.wL)
      expect(e.hR).not.toBe(e.hL)
    }
  })

  test('gaze drives both pupils together', () => {
    const e = eyesFor(ch, 'idle')
    expect(e.pxL).toBe(ch.gaze)
    expect(e.pxR).toBe(ch.gaze)
  })

  test('only the live states animate; done, stopped and failed are stills', () => {
    expect(isLive('idle')).toBe(true)
    expect(isLive('working')).toBe(true)
    expect(isLive('waiting')).toBe(true)
    expect(isLive('done')).toBe(false)
    expect(isLive('stopped')).toBe(false)
    expect(isLive('failed')).toBe(false)
  })
})

describe('blink + micro-saccade clock', () => {
  const ch = characterFromSeed('Patch')

  test('eyes are open for the overwhelming majority of the cycle', () => {
    let closedish = 0
    const samples = 2000
    for (let i = 0; i < samples; i++) {
      const { blink } = eyeClock(ch, 'idle', (i / samples) * 20)
      if (blink < 0.9) closedish++
    }
    expect(closedish / samples).toBeLessThan(0.05)
  })

  test('every live state blinks fully closed once per period', () => {
    for (const state of ['idle', 'working', 'waiting'] as MarkState[]) {
      const p = blinkPeriod(state) + (ch.clock % 1.7)
      let min = 1
      for (let i = 0; i < 4000; i++) min = Math.min(min, eyeClock(ch, state, (i / 4000) * p).blink)
      expect(min).toBeLessThan(0.01)
    }
  })

  test('the blink phase is per-seed, so a roster never blinks in unison', () => {
    const seeds = ['Release Train', 'Patch', 'Quill', 'Ledger', 'Compass']
    const phases = seeds.map((s) => characterFromSeed(s).clock)
    expect(new Set(phases.map((p) => p.toFixed(4))).size).toBe(seeds.length)
  })

  test('the micro-saccade only fires while waiting, and stays micro', () => {
    let maxIdle = 0
    let maxWait = 0
    for (let i = 0; i < 2000; i++) {
      const t = (i / 2000) * 30
      maxIdle = Math.max(maxIdle, Math.abs(eyeClock(ch, 'idle', t).saccadeX))
      maxWait = Math.max(maxWait, Math.abs(eyeClock(ch, 'waiting', t).saccadeX))
    }
    expect(maxIdle).toBe(0)
    expect(maxWait).toBeGreaterThan(0)
    // Quantised to {0, ±1.6, ±3.2} face units — ≤ 2.7% of the face radius (120).
    expect(maxWait).toBeLessThanOrEqual(3.2)
  })

  test('the closing window is short enough to read as a blink', () => {
    expect(BLINK_CLOSING).toBeLessThan(0.2)
  })
})

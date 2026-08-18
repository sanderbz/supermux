/**
 * The procedural character engine — seed → character.
 * ─────────────────────────────────────────────────────────────────────────────
 * A supermux session is a colleague, not a row: it has a face, and the face is
 * derived from its name. Nothing here is hand-drawn and nothing is stored — a
 * name hashes to a silhouette, a pigment, an eye geometry and a blink phase, so
 * every client (and, later, the server mirror) renders the same character for
 * the same name forever.
 *
 * This module is PURE: no DOM, no time source, no randomness that isn't seeded.
 * Path emission lives in `./geometry`, the React surface in `./session-mark`.
 *
 * Every constant below is transcribed from the hero mockup that produced the
 * approved renders (board-light.png / board-dark.png / avatar-strip@2x.png):
 * the perceptual hue trims, the six superellipsoid solids, the three authored
 * silhouettes, the eye ranges, the per-state eye deltas and the blink clock.
 *
 * The channel budget:
 *   silhouette  9  (6 projected solids + 3 authored 2-D outlines)
 *   hue         7  (the tuned candy trims — every pigment in the strip)
 *   ————————————————
 *   tokens     63  distinct silhouette×hue identities, deduped by `assignRoster`
 *
 * Everything else — body jitter, pose, eye size/spacing/tilt, asymmetry, gaze,
 * blink phase — is seeded per name and NOT part of the dedupe: it is what makes
 * two sessions that share a pigment still read as two different faces.
 */

/* ── hashing + seeded noise ──────────────────────────────────────────────── */

/**
 * FNV-1a-32 over UTF-16 code units. Deliberately identical to the mockup and to
 * the spec's published vectors (`deploy-fix` → 0x62b1d3ac) so the future Rust
 * mirror can be tested against the same table.
 */
export function hash32(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** xorshift32 seeded by `hash32`, warmed 8 draws so near-identical names diverge. */
function rngFrom(seed: string): () => number {
  let s = hash32(seed) || 1
  const next = () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
  for (let i = 0; i < 8; i++) next()
  return next
}

const range = (r: () => number, a: number, b: number) => a + r() * (b - a)

/* ── pigment ─────────────────────────────────────────────────────────────── */

/** OKLCh → sRGB hex (Ottosson matrices), clamped to gamut. */
export function oklchHex(L: number, C: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const g = (v: number) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055
    return Math.round(Math.min(1, Math.max(0, c)) * 255)
  }
  return '#' + lin.map((v) => g(v).toString(16).padStart(2, '0')).join('')
}

/**
 * The seven pigments, as OKLCh [L, C] per hue angle. These are hand-trimmed for
 * candy — not mathematical uniformity — and every one of them is tuned so a
 * pure-white eye holds its contrast on the body. They are exactly the seven
 * bodies in avatar-strip@2x.png, in strip order:
 * Release Train 28 · Lookout 75 · Compass 158 · Patch 190 · Quill 265 ·
 * Ledger 292 · Kestrel 350.
 */
export const HUE_TRIM: Readonly<Record<number, readonly [number, number]>> = {
  28: [0.685, 0.16],
  75: [0.755, 0.155],
  158: [0.695, 0.135],
  190: [0.655, 0.115],
  265: [0.585, 0.195],
  292: [0.565, 0.205],
  350: [0.66, 0.17],
}

/** The hue wheel, ascending. Index = the `hue` channel of an identity token. */
export const HUE_SLOTS = [28, 75, 158, 190, 265, 292, 350] as const

const trimFor = (hue: number): readonly [number, number] => HUE_TRIM[hue] ?? [0.69, 0.155]

/** The flat body fill for a hue (the shipped read — no gradient, no lift). */
export const bodyColor = (hue: number): string => {
  const [L, C] = trimFor(hue)
  return oklchHex(L, C, hue)
}

/**
 * The text-capable tier of a session's pigment: mention chips, provenance names,
 * hover underlines (concept contract C7). Darkened on light, lifted on dark, so
 * it stays legible as *text* where the body colour would not be.
 */
export const accentInk = (hue: number, dark: boolean): string => {
  const [, C] = trimFor(hue)
  return dark
    ? oklchHex(0.82, Math.min(C, 0.135), hue)
    : oklchHex(0.475, Math.min(C + 0.02, 0.19), hue)
}

/** The eye pigment. White on every body, in both themes — the strip's read. */
export const EYE_INK = '#ffffff'

/* ── silhouettes ─────────────────────────────────────────────────────────── */

/** A superellipsoid: |x/rx|^n + |y/ry|^n + |z/rz|^n = 1. */
export interface Solid {
  rx: number
  ry: number
  rz: number
  n: number
}

/** The six projected solids — the round cast. */
export const SOLIDS = {
  sphere: { rx: 121, ry: 121, rz: 121, n: 2 },
  egg: { rx: 105, ry: 133, rz: 105, n: 2.1 },
  capsule: { rx: 99, ry: 139, rz: 99, n: 2.45 },
  blob: { rx: 132, ry: 108, rz: 118, n: 2.15 },
  cube: { rx: 110, ry: 110, rz: 98, n: 3.6 },
  pebble: { rx: 128, ry: 104, rz: 112, n: 2.7 },
} as const satisfies Record<string, Solid>

/**
 * The three authored 2-D outlines — the odd ones out. Their silhouette is drawn
 * flat, but the eyes still wrap onto an invisible face solid (`face`), shifted
 * down by `dy`, so a blink reads the same on a cloud as on a sphere.
 */
export const AUTHORED = {
  cloud: { face: { rx: 96, ry: 74, rz: 92, n: 2 }, dy: 14 },
  wedge: { face: { rx: 84, ry: 84, rz: 84, n: 2 }, dy: 34 },
  rhombus: { face: { rx: 88, ry: 88, rz: 88, n: 2 }, dy: 4 },
} as const satisfies Record<string, { face: Solid; dy: number }>

export type SolidName = keyof typeof SOLIDS
export type AuthoredName = keyof typeof AUTHORED
export type SilhouetteName = SolidName | AuthoredName

/** The silhouette wheel. Index = the `silhouette` channel of an identity token. */
export const SILHOUETTES = [
  ...(Object.keys(SOLIDS) as SolidName[]),
  ...(Object.keys(AUTHORED) as AuthoredName[]),
] as const satisfies readonly SilhouetteName[]

export const isAuthored = (name: SilhouetteName): name is AuthoredName => name in AUTHORED

/* ── the character ───────────────────────────────────────────────────────── */

/**
 * Session presence, as the face reads it. `done`/`stopped`/`failed` are stills.
 *
 * The approved boards only exercise four states (idle · working · waiting ·
 * done — see the mockup's `eyesFor`). `stopped` and `failed` are the two the
 * product actually needs and the boards never posed: `SessionStatus` (see
 * lib/api/sessions.ts) is `starting | active | idle | waiting | stopped |
 * error`, and a face that IS the status indicator (concept contract C5) must be
 * able to say "this one is asleep" and "this one fell over". Both are built from
 * the existing capsule primitive — no new visual language — and both are
 * legible in a *still* frame, which is the load-bearing part: `stopped` used to
 * be byte-identical to `idle` and differed only by not animating, so a
 * reduced-motion user (or any screenshot) could not tell them apart.
 */
export type MarkState = 'idle' | 'working' | 'waiting' | 'done' | 'stopped' | 'failed'

/** What a roster assignment (or a fixture) may fix; everything else stays seeded. */
export interface MarkPin {
  silhouette?: SilhouetteName
  hue?: number
  /** Horizontal pupil offset in face units (−16..16). */
  gaze?: number
  /** Idle eye tilt in degrees; the right eye follows at 0.82–1.05×. */
  tilt?: number
}

export interface Character {
  seed: string
  silhouette: SilhouetteName
  authored: boolean
  hue: number
  /** Flat body fill. */
  color: string
  /** Eye fill — always white. */
  ink: string
  /** The solid the silhouette is projected from, or (authored) the face solid. */
  body: Solid
  /** Vertical seat of the face on an authored silhouette; 0 for solids. */
  faceDY: number
  /** Where this character looks, in face units. */
  gaze: number
  eyes: {
    /** Left-eye width / height, before per-state deltas. */
    wL: number
    hL: number
    /** Distance between eye centres. */
    spacing: number
    /** Left-eye vertical offset. */
    pyL: number
    /** Eye tilt, degrees; the right eye is deliberately off by a few percent. */
    angleL: number
    angleR: number
  }
  /** The right eye's deviation from the left — no face is symmetric. */
  asym: { w: number; h: number; py: number; slant: number }
  /** Head pose, degrees, plus the perspective amount. */
  pose: { x: number; y: number; z: number; persp: number }
  /** Per-seed phase (seconds) for the blink clock and the breathe loop. */
  clock: number
}

/**
 * Seed → character. Pure and total: any string produces a legible face.
 *
 * `pin` is how a deduped roster (see `assignRoster`) or a fixture fixes the two
 * identity channels without touching the rest of the seeded personality.
 */
export function characterFromSeed(seed: string, pin: MarkPin = {}): Character {
  const rand = rngFrom(seed)
  const silhouette: SilhouetteName =
    pin.silhouette ?? SILHOUETTES[hash32(seed + '#shape') % SILHOUETTES.length]
  const authored = isAuthored(silhouette)
  const hue = pin.hue ?? HUE_SLOTS[hash32(seed + '#hue') % HUE_SLOTS.length]
  const base: Solid = authored ? AUTHORED[silhouette].face : SOLIDS[silhouette]

  // THE DRAW ORDER IS PART OF THE CONTRACT. A pin does not just replace a value,
  // it *consumes no draw* — and an authored silhouette skips the three body
  // jitter draws, because its outline is drawn rather than projected. Both are
  // transcribed from the mockup that rendered board-light/dark.png and
  // avatar-strip@2x.png, and both are load-bearing: shift this sequence by one
  // draw and every eye downstream (size, spacing, seat, asymmetry, pose, blink
  // phase) lands somewhere else, so the shipped faces stop being the approved
  // faces. `/dev/marks`' reference strip is the regression test you can look at.
  //
  // The consequence, stated plainly so nobody "fixes" it again: which pins are
  // present changes the seeded remainder. That is safe because pinning is a
  // create-time decision (a roster assignment or a fixture), never a runtime
  // toggle — a character's pins do not change under it while it is on screen.
  const j = (v: number) => v * range(rand, 0.94, 1.06)
  const asym = () => range(rand, -1, 1)
  const tilt = pin.tilt ?? (asym() > 0 ? 1 : -1) * range(rand, 24, 34)
  const jittered: Solid = authored
    ? { ...base }
    : { rx: j(base.rx), ry: j(base.ry), rz: j(base.rz), n: base.n }
  const gaze = pin.gaze ?? Math.round(asym() * 16)

  return {
    seed,
    silhouette,
    authored,
    hue,
    color: bodyColor(hue),
    ink: EYE_INK,
    // Authored faces keep their exact face solid (the outline is drawn, not
    // projected, so jitter would desync eyes from silhouette).
    body: jittered,
    faceDY: authored ? AUTHORED[silhouette].dy : 0,
    gaze,
    eyes: {
      wL: range(rand, 31, 38),
      hL: range(rand, 64, 80),
      spacing: range(rand, 58, 70),
      pyL: range(rand, -8, 6),
      angleL: tilt,
      angleR: tilt * range(rand, 0.82, 1.05),
    },
    asym: {
      w: 1 + asym() * 0.07,
      h: 1 + asym() * 0.07,
      py: asym() * 2.4,
      slant: asym() * 3,
    },
    pose: {
      x: asym() * (authored ? 2 : 7),
      y: asym() * (authored ? 4 : 15),
      z: asym() * (authored ? 1.5 : 4.5),
      persp: 1,
    },
    clock: rngFrom(seed + '#clock')() * 9,
  }
}

/* ── state → eyes ────────────────────────────────────────────────────────── */

/**
 * Eye height of a shut lid, in face arc-length units. `eyePath` collapses a
 * blinking eye to 5; `stopped` sits deliberately above that floor so the shut
 * lid survives the 18px roster size.
 */
export const CLOSED_LID = 11

/** Resolved per-eye geometry, in face arc-length units. */
export interface EyeGeometry {
  spacing: number
  pxL: number
  pxR: number
  pyL: number
  pyR: number
  angleL: number
  angleR: number
  wL: number
  wR: number
  hL: number
  hR: number
}

/**
 * The state channel (concept contract C5: the face IS the status indicator).
 * The silhouette never moves; only the eyes carry state.
 *
 *   idle           — open, tilted, seeded asymmetry
 *   working        — narrowed to 54% wide × 78% tall and slanted to −26°: the
 *                    universal "concentrating" read at 18px and at 40px
 *   waiting        — rounded (aspect 1.04) and levelled to 35% tilt: wide-eyed,
 *                    the only state that also micro-saccades
 *   done           — squinted to 30% height, 105% width: a content curve
 *   stopped        — held shut: the 11-unit lid line the blink already draws,
 *                    levelled to 45% tilt. Asleep, and visibly so with no motion
 *   failed         — the ONLY state with mirrored tilt (left +30°, right −30°,
 *                    tops converging): a knitted brow. Every other state keeps
 *                    the two eyes parallel, so this cannot be confused at 18px
 *
 * The first four are transcribed from the mockup; the last two are additions —
 * see the `MarkState` note.
 */
export function eyesFor(ch: Character, state: MarkState): EyeGeometry {
  const b = ch.eyes
  const a = ch.asym
  const g = ch.gaze
  const e: EyeGeometry = {
    spacing: b.spacing,
    pxL: g,
    pxR: g,
    pyL: b.pyL,
    pyR: b.pyL + a.py,
    angleL: b.angleL,
    angleR: b.angleR,
    wL: b.wL,
    wR: b.wL * a.w,
    hL: b.hL,
    hR: b.hL * a.h,
  }
  if (state === 'working') {
    const s = -26 + a.slant
    e.angleL = s
    e.angleR = s + 3.2
    e.hL *= 0.78
    e.hR *= 0.78
    e.wL *= 0.54
    e.wR *= 0.54
  } else if (state === 'waiting') {
    const w = ((b.wL + b.hL) / 2) * 0.8
    e.wL = w
    e.wR = w * a.w
    e.hL = w * 1.04
    e.hR = w * 1.04 * a.h
    e.angleL *= 0.35
    e.angleR *= 0.35
  } else if (state === 'done') {
    e.hL *= 0.3
    e.hR *= 0.3
    e.wL *= 1.05
    e.wR *= 1.05
  } else if (state === 'stopped') {
    // The lid line, held. `eyePath` floors a fully-blinked eye at 5 units; 11
    // keeps it visible at the 18px roster size while still reading as shut, and
    // it stays a *line* against `done`'s 30%-height lozenge.
    e.hL = CLOSED_LID
    e.hR = CLOSED_LID * a.h
    e.wL *= 1.06
    e.wR *= 1.06
    e.angleL *= 0.45
    e.angleR *= 0.45
  } else if (state === 'failed') {
    // Mirrored, not parallel: the tops converge toward the centre line, so the
    // pair reads as a knitted brow. No other state mirrors, which is what makes
    // it unmistakable — but a tilt is only visible on a *slot*, so the eyes are
    // narrowed to 62% and kept long (86%) rather than shortened into lozenges.
    const t = 42 + a.slant
    e.angleL = t
    e.angleR = -t
    e.hL *= 0.86
    e.hR *= 0.86
    e.wL *= 0.62
    e.wR *= 0.62
  }
  return e
}

/* ── the blink clock ─────────────────────────────────────────────────────── */

/** Seconds the lid takes to close and reopen. */
export const BLINK_CLOSING = 0.16

/** Base blink period per state; the per-seed `clock` detunes it further. */
export function blinkPeriod(state: MarkState): number {
  return state === 'working' ? 2.6 : state === 'waiting' ? 3.1 : 4.6
}

/**
 * Which states have a heartbeat. `done`, `stopped` and `failed` are stills by
 * design — nothing is running, so nothing should breathe.
 */
export function isLive(state: MarkState): boolean {
  return state === 'idle' || state === 'working' || state === 'waiting'
}

/**
 * The ambient life of a face at time `t` (seconds, any monotonic origin).
 *
 * `blink` ∈ [0,1] scales eye height (1 = open). The period is detuned per seed
 * (`clock % 1.7`) and the phase is offset per seed, so a roster of eight faces
 * never blinks in unison — the single cheapest "someone is there" signal.
 *
 * `saccadeX` is the micro-saccade: a quantised ±1.6-unit pupil drift that only
 * fires while `waiting`, where a wide-eyed face that also *glances* reads as
 * waiting for you rather than frozen.
 */
export function eyeClock(
  ch: Character,
  state: MarkState,
  t: number,
): { blink: number; saccadeX: number } {
  const p = blinkPeriod(state) + (ch.clock % 1.7)
  const ph = (t + ch.clock) % p
  let blink = 1
  if (ph > p - BLINK_CLOSING) {
    const u = (ph - (p - BLINK_CLOSING)) / BLINK_CLOSING
    const b = Math.abs(u - 0.5) * 2
    blink = Math.max(0, b * b * (3 - 2 * b))
  }
  const saccadeX =
    state === 'waiting' ? Math.round(Math.sin((t + ch.clock) * 0.55) * 1.6) * 1.6 : 0
  return { blink, saccadeX }
}

/* ── roster assignment ───────────────────────────────────────────────────── */

/** The two deduped identity channels. */
export interface MarkToken {
  silhouette: SilhouetteName
  hue: number
}

const TOKEN_COUNT = SILHOUETTES.length * HUE_SLOTS.length // 9 × 7 = 63
/** Coprime with 63 ⇒ the probe visits every token exactly once. */
const PROBE_STEP = 17

/**
 * Deduped identity for a whole roster.
 *
 * Hash alone is not enough: 63 tokens and 20 sessions collide with ~99%
 * probability (birthday), and two sessions wearing the same silhouette in the
 * same pigment destroy the one thing the mark exists for. So each session probes
 * the token cycle from its own hash position and takes the cheapest free token:
 *
 *   cost(t) = usedPair[t]·10000 + usedSilhouette[t]·100 + usedHue[t]
 *
 * Lexicographic for any roster below 100 rows: an unused silhouette×hue pair
 * always wins, then the least-used silhouette, then the least-used hue. Because
 * the probe covers all 63 tokens, distinct pairs are *guaranteed* for n ≤ 63.
 *
 * Properties that matter to the caller:
 *   · a solo session is hash-pure — assignment never moves it;
 *   · the result depends only on the seed list and its order (feed it in
 *     creation order and it is stable as rows come and go at the tail);
 *   · it is deterministic, so the server can mirror it and freeze the columns.
 */
export function assignRoster(seeds: readonly string[]): Map<string, MarkToken> {
  const usedPair = new Uint16Array(TOKEN_COUNT)
  const usedSil = new Uint16Array(SILHOUETTES.length)
  const usedHue = new Uint16Array(HUE_SLOTS.length)
  const out = new Map<string, MarkToken>()

  for (const seed of seeds) {
    if (out.has(seed)) continue
    const sil0 = hash32(seed + '#shape') % SILHOUETTES.length
    const hue0 = hash32(seed + '#hue') % HUE_SLOTS.length
    const t0 = sil0 * HUE_SLOTS.length + hue0

    let best = t0
    let bestCost = Infinity
    for (let k = 0; k < TOKEN_COUNT; k++) {
      const t = (t0 + k * PROBE_STEP) % TOKEN_COUNT
      const si = Math.floor(t / HUE_SLOTS.length)
      const hi = t % HUE_SLOTS.length
      const cost = usedPair[t] * 10000 + usedSil[si] * 100 + usedHue[hi]
      if (cost < bestCost) {
        bestCost = cost
        best = t
        if (cost === 0) break
      }
    }

    const si = Math.floor(best / HUE_SLOTS.length)
    const hi = best % HUE_SLOTS.length
    usedPair[best]++
    usedSil[si]++
    usedHue[hi]++
    out.set(seed, { silhouette: SILHOUETTES[si], hue: HUE_SLOTS[hi] })
  }
  return out
}

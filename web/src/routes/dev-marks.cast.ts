/**
 * The bench cast — the fixture behind `/dev/marks`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Kept out of the route component for two reasons: the route is a `.tsx` full of
 * `@/` aliases the unit runner cannot resolve, and the *coverage* of the bench is
 * the part worth testing. A visual bench is only worth screenshotting if it
 * provably shows every channel: all 9 silhouettes, all 7 pigments, all 6 states,
 * every size on the ladder. `tests/unit/dev-marks-cast.test.ts` asserts exactly
 * that — so an engine change that shrinks the cast's coverage fails a test
 * instead of quietly shrinking the bench.
 *
 * Nothing here is imported by the app: the route that consumes it is DEV-only
 * and lazy, so this file never lands in a production chunk.
 */
import { assignRoster, type MarkPin, type MarkState } from '../brand/marks/character'

export interface CastMember {
  name: string
  pin: MarkPin
}

/**
 * The size ladder. These are the three sizes a mark is actually shipped at, and
 * the reason the bench renders all three: the geometry is unitless, but
 * *legibility* is not — `stopped`'s lid line and `working`'s narrowed slots are
 * the two reads that die first at 18px.
 */
export const MARK_SIZES = [18, 28, 40] as const
export type MarkSize = (typeof MARK_SIZES)[number]

/** What each rung is for, printed on the bench so the ladder stays honest. */
export const MARK_SIZE_ROLES: Readonly<Record<MarkSize, string>> = {
  18: 'facepile · dense roster · mention chip',
  28: 'roster row · session chip · header pill',
  40: 'focus header · hero · tile',
}

/**
 * Every state the face can be in, in the order the design system lists them:
 * the four the approved boards posed, then the two additions (`stopped`,
 * `failed`). The bench renders the whole row — a state that only exists in the
 * type union is a state nobody has ever looked at.
 */
export const MARK_STATES: readonly MarkState[] = [
  'idle',
  'working',
  'waiting',
  'done',
  'stopped',
  'failed',
]

/** The live states — the only ones with a heartbeat (see `isLive`). */
export const LIVE_STATES: readonly MarkState[] = ['idle', 'working', 'waiting']

/** Both themes are rendered on one page; `[data-theme]` is the subtree switch. */
export const BENCH_THEMES = ['light', 'dark'] as const
export type BenchTheme = (typeof BENCH_THEMES)[number]

/**
 * The seven faces of the approved render, pinned to the exact silhouette and
 * pigment they wear there (strip order, left to right). This is the parity
 * anchor: `/dev/marks` next to `avatar-strip@2x.png` must be the same seven
 * characters, which is what makes the bench a *reference* surface rather than a
 * gallery. Everything not pinned — eyes, pose, jitter, blink phase — still comes
 * from the seed, so these are the real characters, not drawings of them.
 *
 * Note these are NOT the identities the seven names hash to: the approved render
 * was art-directed, so parity with it requires pins. That is exactly why the
 * whole bench is built on this list (see `CAST`).
 */
export const REFERENCE_STRIP: readonly CastMember[] = [
  { name: 'Release Train', pin: { silhouette: 'pebble', hue: 28, gaze: -6, tilt: 30 } },
  { name: 'Patch', pin: { silhouette: 'egg', hue: 190, gaze: 8, tilt: -27 } },
  { name: 'Quill', pin: { silhouette: 'sphere', hue: 265, gaze: 17, tilt: 22 } },
  { name: 'Ledger', pin: { silhouette: 'capsule', hue: 292, gaze: -15, tilt: 28 } },
  { name: 'Compass', pin: { silhouette: 'rhombus', hue: 158, gaze: 13, tilt: -31 } },
  { name: 'Lookout', pin: { silhouette: 'cloud', hue: 75, gaze: -18, tilt: 26 } },
  { name: 'Kestrel', pin: { silhouette: 'wedge', hue: 350, gaze: 14, tilt: -33 } },
]

/**
 * The state each of the seven is posed in on `avatar-strip@2x.png`.
 *
 * This is not decoration. The approved strip is not seven idle faces: it is the
 * roster, in the states the roster is in, which is *why* the seven read as
 * different personalities rather than one shape in seven colours. Posing the
 * whole strip `idle` collapses that — `done`'s squint and `waiting`'s round eyes
 * disappear and every face wears the same open slot. Parity with the approved
 * render therefore includes the pose, not just the pins.
 */
export const REFERENCE_STATE: Readonly<Record<string, MarkState>> = {
  'Release Train': 'working',
  Patch: 'working',
  Quill: 'waiting',
  Ledger: 'idle',
  Compass: 'idle',
  Lookout: 'done',
  Kestrel: 'done',
}

/**
 * The two silhouettes the approved strip cannot show: it has seven characters
 * and the wheel has nine. They keep their own hash-pure pigment (`deploy-fix` →
 * 350, `night-watch` → 75), which repeats two of the seven — honestly so: nine
 * sessions over seven pigments MUST repeat a pigment, and the dedupe contract is
 * distinct silhouette×hue *pairs*, not distinct hues.
 *
 * `deploy-fix` is the engine's published hash vector (`0x62b1d3ac`).
 */
const EXTRAS: readonly CastMember[] = [
  { name: 'deploy-fix', pin: { silhouette: 'blob', hue: 350 } },
  { name: 'night-watch', pin: { silhouette: 'cube', hue: 75 } },
]

/**
 * The bench cast — ONE set of nine characters, used by every section of the page.
 *
 * The seven approved faces wear their approved pins everywhere, not just in the
 * reference strip: a bench whose job is parity with `avatar-strip@2x.png` cannot
 * show "Release Train" as a coral cube in one section and a pink wedge in the
 * next. So the cast IS the reference strip plus the two silhouettes the strip has
 * no room for — which still spans all 9 silhouettes and all 7 pigments (asserted
 * in `dev-marks-cast.test.tsx`).
 *
 * The deduper is not exercised here on purpose: `assignRoster` has its own unit
 * tests (`marks-character.test.ts`) and its visible demo is the 14-name `ROSTER`
 * panel below, where a live collision actually has something to resolve.
 */
export const CAST: readonly CastMember[] = [...REFERENCE_STRIP, ...EXTRAS]

export const CAST_NAMES: readonly string[] = CAST.map((m) => m.name)

/**
 * A roster big enough to be interesting for the dedupe panel: 14 plausible
 * session names, deduped as a unit. Rendered so a future phase can eyeball what
 * a real sidebar of faces reads like — the thing no single mark can show.
 */
export const ROSTER_NAMES = [
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

export const ROSTER: readonly CastMember[] = (() => {
  const assigned = assignRoster(ROSTER_NAMES)
  return ROSTER_NAMES.map((name) => ({ name, pin: assigned.get(name)! }))
})()

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

export interface CastMember {
  name: string
  pin: MarkPin
}

/**
 * The bench roster, in creation order (`assignRoster` is order-dependent).
 *
 * The first seven are the characters of the approved `avatar-strip@2x.png`;
 * `deploy-fix` (the spec's published hash vector) and `night-watch` extend the
 * roster to nine — the point at which the deduper is forced to hand out all nine
 * silhouettes, so the bench shows the entire shape wheel without a single
 * hand-picked pin.
 */
export const CAST_NAMES = [
  'Release Train',
  'Patch',
  'Quill',
  'Ledger',
  'Compass',
  'Lookout',
  'Kestrel',
  'deploy-fix',
  'night-watch',
] as const

const ASSIGNED = assignRoster(CAST_NAMES)

/**
 * The cast as the *engine* assigns it — pins straight out of `assignRoster`, not
 * authored by hand. The bench therefore exercises the real roster path (the one
 * the app will use), and the coverage test doubles as a dedupe regression.
 */
export const CAST: readonly CastMember[] = CAST_NAMES.map((name) => ({
  name,
  // Non-null: assignRoster returns an entry per unique seed, and CAST_NAMES has
  // no duplicates (asserted in the cast test).
  pin: ASSIGNED.get(name)!,
}))

/**
 * The seven faces of the approved render, pinned to the exact silhouette and
 * pigment they wear there (strip order, left to right). This is the parity
 * anchor: `/dev/marks` next to `avatar-strip@2x.png` must be the same seven
 * characters, which is what makes the bench a *reference* surface rather than a
 * gallery. Everything not pinned — eyes, pose, jitter, blink phase — still comes
 * from the seed, so these are the real characters, not drawings of them.
 */
export const REFERENCE_STRIP: readonly CastMember[] = [
  { name: 'Release Train', pin: { silhouette: 'cube', hue: 28 } },
  { name: 'Patch', pin: { silhouette: 'egg', hue: 190 } },
  { name: 'Quill', pin: { silhouette: 'sphere', hue: 265 } },
  { name: 'Ledger', pin: { silhouette: 'capsule', hue: 292 } },
  { name: 'Compass', pin: { silhouette: 'rhombus', hue: 158 } },
  { name: 'Lookout', pin: { silhouette: 'cloud', hue: 75 } },
  { name: 'Kestrel', pin: { silhouette: 'wedge', hue: 350 } },
]

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

/**
 * The roster bench cast — the fixture behind `/dev/roster` (fase B2, T1).
 * ─────────────────────────────────────────────────────────────────────────────
 * Same split as `dev-marks.cast.ts`, for the same two reasons: the route is a
 * `.tsx` full of `@/` aliases the unit runner cannot resolve, and the *coverage*
 * of a visual bench is the part worth testing. A bench is only a regression net
 * if it provably shows every channel — so the matrix lives here as data and
 * `tests/unit/dev-roster-cast.test.tsx` asserts it cannot quietly shrink.
 *
 * The roster system has four independent channels, and B2 changes all four:
 *
 *   density    how much room a row gets   (list · strip · picker)      T3
 *   state      what the eyes are doing    (6 mark states)              T4
 *   tier       whether it wants you       (needs · unread · working)   T5
 *   theme      light and dark, on ONE page via `[data-theme]`          B0
 *
 * Nothing here is imported by the app: the route that consumes it is DEV-only
 * and lazy, so this file never lands in a production chunk.
 */
import { assignRoster, type MarkPin, type MarkState } from '../brand/marks/character'

/* ── the four channels ───────────────────────────────────────────────────── */

/**
 * The three densities `RosterRow` renders at (T3).
 *
 *   list    h64 / mark 40 / preview / ticking time — the overview list row
 *   strip   h48 / mark 28 / no preview             — the focus strip
 *   picker  h40 / mark 24 / STATIC                 — palette + pickers, where a
 *                                                    mutating row under the
 *                                                    keyboard cursor is a bug
 */
export const ROSTER_DENSITIES = ['list', 'strip', 'picker'] as const
export type RosterDensity = (typeof ROSTER_DENSITIES)[number]

/** Roomier label per rung, printed on the bench so the ladder stays honest. */
export const DENSITY_ROLES: Readonly<Record<RosterDensity, string>> = {
  list: 'overview list · session rows · h64, mark 40, preview',
  strip: 'focus strip · compact tiles · h48, mark 28',
  picker: 'command palette · session picker · h40, mark 24, static',
}

/**
 * Every state the face can be in — the same six `dev-marks` poses, re-rendered
 * here at *row* scale. B0's contract C5 says the eyes ARE the status channel, so
 * the six have to be separable at 24px in a still frame, not only at 40px.
 */
export const ROSTER_STATES: readonly MarkState[] = [
  'idle',
  'working',
  'waiting',
  'done',
  'stopped',
  'failed',
]

/**
 * The attention tiers (T5). `quiet` is the *absence* of a tier and renders no
 * glyph at all — it is on the bench precisely so the difference between "quiet"
 * and "unread" is a thing you can look at rather than a thing you argue about.
 */
export const ATTENTION_TIERS = ['needs', 'unread', 'working', 'quiet'] as const
export type AttentionTier = (typeof ATTENTION_TIERS)[number]

/** Both themes are rendered on one page; `[data-theme]` is the subtree switch. */
export const BENCH_THEMES = ['light', 'dark'] as const
export type BenchTheme = (typeof BENCH_THEMES)[number]

/* ── the roster itself ───────────────────────────────────────────────────── */

export interface RosterMember {
  name: string
  /** The line the session last said — the preview IS the status line (§12.1). */
  preview: string
  timestamp: string
  pin: MarkPin
}

/**
 * Fourteen plausible session names — enough that a duplicate face would be
 * visible, which is the whole point of the dedupe panel. Deliberately the same
 * fourteen `dev-marks.cast.ts` uses for its dedupe panel, so the two benches
 * show the SAME roster wearing the same faces and a pin change shows up in both.
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
  'device-auth',
  'night-watch',
] as const

/** What each of the fourteen last said. Real-shaped lines, not lorem: the row's
 *  truncation and the 13px secondary read are only testable against sentences
 *  that actually run past the edge. */
const PREVIEWS: Readonly<Record<string, string>> = {
  supermux: 'one check left. then crates.io.',
  'deploy-fix': 'rolled back to ef19402 — the unit is green again',
  'render-bug': 'Typing…',
  'chat-dataplane': 'waiting for your answer on the migration number',
  strato: 'deployed. tailnet-only, as agreed.',
  'readme-launch': 'the hero gif is 1.9 MB — under the ceiling',
  'title-edit': 'renamed 6 sessions; nothing else touched',
  'push-fixes': 'push subscription expired for one device, pruned it',
  'archive-delete': 'archived 3, deleted 0 — undo is still open',
  'git-stack': 'rebased onto origin/main; 2 conflicts, both in lockfiles',
  'remote-ssh': 'host unreachable for 40s, then back',
  scrollback: 'width shrank to 88 cols and Claude re-emitted the frame',
  'device-auth': 'device auth still valid until 2026-09',
  'night-watch': 'quiet since 03:12',
}

const TIMES: Readonly<Record<string, string>> = {
  supermux: '1:47 PM',
  'deploy-fix': '1:44 PM',
  'render-bug': '1:41 PM',
  'chat-dataplane': '1:38 PM',
  strato: '1:12 PM',
  'readme-launch': '12:58 PM',
  'title-edit': '12:20 PM',
  'push-fixes': '11:04 AM',
  'archive-delete': '10:39 AM',
  'git-stack': '9:57 AM',
  'remote-ssh': 'Yesterday',
  scrollback: 'Yesterday',
  'device-auth': 'Tuesday',
  'night-watch': 'Tuesday',
}

/**
 * The cast, deduped as ONE roster — `assignRoster` is the engine's own deduper
 * and this is its first *row-scale* demo. Fourteen names over 63 tokens must
 * come out fourteen distinct silhouette×pigment pairs; if it ever doesn't, the
 * bench shows two identical faces and the unit test fails on the same frame.
 */
export const ROSTER_CAST: readonly RosterMember[] = (() => {
  const assigned = assignRoster(ROSTER_NAMES)
  return ROSTER_NAMES.map((name) => ({
    name,
    preview: PREVIEWS[name],
    timestamp: TIMES[name],
    pin: assigned.get(name)!,
  }))
})()

/* ── the other benched surfaces ──────────────────────────────────────────── */

/** Overview density tiers the tile is benched at (`lib/overview-size.ts`). */
export const TILE_TIERS = [1, 2, 3, 4] as const
export type TileTier = (typeof TILE_TIERS)[number]

/** Rollup sizes (T6). 0 must render NOTHING — no empty chrome — and 9 must
 *  collapse to three marks + "+6", so both edges are on the page. */
export const ROLLUP_COUNTS = [0, 1, 3, 9] as const

/** The four states any remote-backed list has, benched so the empty and error
 *  copy is looked at as often as the happy path (T10). */
export const ISSUE_STATES = ['empty', 'loading', 'error', 'populated'] as const
export type IssueState = (typeof ISSUE_STATES)[number]

/**
 * The bench's section ids. The page renders one `<section id>` per entry and the
 * cast test asserts every id appears in the route source — so a section cannot
 * be dropped without the test noticing, and a later task adding a surface adds
 * it here first.
 */
export const BENCH_SECTIONS = [
  'densities',
  'states',
  'attention',
  'selection',
  'pinned-hairline',
  'tiles',
  'rollup',
  'grok-team-rows',
  'issues',
] as const
export type BenchSection = (typeof BENCH_SECTIONS)[number]

/** Which of the fourteen wears which state on the states matrix — one member
 *  per state so a state is never judged through a single silhouette. */
export const STATE_MODELS: Readonly<Record<MarkState, string>> = {
  idle: 'supermux',
  working: 'deploy-fix',
  waiting: 'chat-dataplane',
  done: 'strato',
  stopped: 'night-watch',
  failed: 'remote-ssh',
  // The three Grok-skin moments (connecting/thinking/streaming) — modelled so the
  // roster bench can pose them too.
  connecting: 'render-bug',
  thinking: 'readme-launch',
  streaming: 'title-edit',
}

/** Which member models each attention tier on the attention matrix. */
export const TIER_MODELS: Readonly<Record<AttentionTier, string>> = {
  needs: 'chat-dataplane',
  unread: 'render-bug',
  working: 'deploy-fix',
  quiet: 'night-watch',
}

/** Two pinned + the rest unpinned — the only configuration in which the pinned
 *  hairline renders at all (T7: nothing when there are no pins, and nothing when
 *  everything is pinned). */
export const PINNED_NAMES: readonly string[] = ['supermux', 'deploy-fix']

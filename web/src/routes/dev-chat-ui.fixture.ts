/**
 * The fixture behind `/dev/chat-ui` — the approved board, as data.
 * ─────────────────────────────────────────────────────────────────────────────
 * The content is the hero mockup's Release Train board, verbatim: the same
 * roster, the same eight rows, the same three receipts, the same permission ask.
 * That is the point — the bench is only a reference surface if it can be held up
 * next to `board-light.png` / `board-dark.png` and read as the same screen.
 *
 * Kept out of the route for the same two reasons as `dev-marks.cast.ts`: the
 * route is a `.tsx` full of `@/` aliases the unit runner cannot resolve, and the
 * *coverage* of a bench is the part worth testing —
 * `tests/unit/dev-chat-ui-fixture.test.ts` asserts that every primitive is on
 * the page and that the roster actually exercises every row state.
 *
 * The cast is imported from the marks bench rather than re-declared: one design
 * system, one set of colleagues. If `/dev/marks` and `/dev/chat-ui` disagreed
 * about what Patch looks like, neither page would be a reference.
 */
import type { MarkPin, MarkState } from '../brand/marks/character'
import type { Receipt } from '../components/chat/ui/receipt-group'

import { REFERENCE_STRIP } from './dev-marks.cast'

/** name → identity pin, straight off the approved reference strip. */
export const CAST: ReadonlyMap<string, MarkPin> = new Map(
  REFERENCE_STRIP.map((m) => [m.name, m.pin]),
)

export function pinFor(name: string): MarkPin | undefined {
  return CAST.get(name)
}

/** The focused session — whose accent the board is skinned with. */
export const FOCUS = 'Release Train'

export interface BoardRosterRow {
  name: string
  timestamp: string
  /** The session's own last line — or its presence, when it is composing. */
  preview: string
  state?: MarkState
  attention?: boolean
  /** A team row: three members in one mark's footprint. */
  crew?: readonly string[]
}

/** The mockup's sidebar, row for row. */
export const BOARD_ROSTER: readonly BoardRosterRow[] = [
  { name: 'Release Train', timestamp: '1:47 PM', preview: 'one check left. then crates.io.', state: 'working' },
  { name: 'Patch', timestamp: '11:02 AM', preview: 'Typing…', state: 'working' },
  {
    name: 'Quill',
    timestamp: '10:12 AM',
    preview: 'readme rewritten. shorter now.',
    state: 'waiting',
    attention: true,
  },
  { name: 'Ledger', timestamp: '9:38 AM', preview: 'euro formats parse clean now.', state: 'idle' },
  { name: 'Compass', timestamp: '8:15 AM', preview: 'three dead links, all in docs.', state: 'idle' },
  { name: 'Lookout', timestamp: 'Yesterday', preview: 'ci green across the board.', state: 'done' },
  {
    name: 'Render crew',
    timestamp: 'Yesterday',
    preview: "that flicker's gone on ios.",
    crew: ['Lookout', 'Ledger', 'Patch'],
  },
  { name: 'Kestrel', timestamp: 'Yesterday', preview: 'strato box is quiet since the fix.', state: 'done' },
]

/** The board's receipt group. */
export const BOARD_RECEIPTS: readonly Receipt[] = [
  { tool: 'cargo check', outcome: 'clean · 0 errors' },
  { tool: 'tests', outcome: '212 passed' },
  { tool: 'release', outcome: 'v0.6.0 tagged' },
]

/**
 * A receipt group at Claude's real volume — a twelve-file read run, a repeat
 * that coalesces, and the live line at the bottom. Not on the approved board
 * (which shows a calm three-line turn), but it is the case P3 was designed for,
 * so the bench has to show it.
 */
export const VOLUME_RECEIPTS: readonly Receipt[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ tool: 'Read', outcome: `crates/render/src/frame-${i}.rs` })),
  { tool: 'Grep', outcome: 'no matches' },
  { tool: 'Grep', outcome: 'no matches' },
  { tool: 'Edit', outcome: 'server/src/export/money.rs' },
  { tool: 'cargo test', state: 'running' as const },
]

/**
 * The board's pending ask — a permission dialog, rendered as a choice card.
 * No digit hints: the approved render has none, and the board half of the bench
 * is the parity anchor. The digits (which ARE part of P5 — they are the modal
 * registry's option mapping) are shown on `PLAN_CHOICE` in the parts gallery.
 */
export const BOARD_CHOICE = {
  command: 'cargo publish --dry-run',
  tail: ' before I push to crates.io?',
  why: 'in supermux/server · reaches crates.io, writes nothing',
  options: [
    { label: 'Allow once', primary: true },
    { label: 'Allow while this session runs' },
    { label: 'Not now' },
  ],
} as const

/**
 * Plan approval — the second dialog family the registry acts on, with the real
 * 2.1.231 labels (master plan §4.3) and the digits bound 1:1 to them.
 */
export const PLAN_CHOICE = {
  question: 'Ready to code? Here is the plan for the money-parsing fix.',
  why: '3 files · 2 new tests · no migrations',
  options: [
    { label: 'Yes, and use auto mode', primary: true, kbd: '1' },
    { label: 'Yes, manually approve edits', kbd: '2' },
    { label: 'Tell Claude what to change', kbd: '3' },
  ],
} as const

/** The board's captured frame. */
export const BOARD_FRAME = { caption: 'release-run.png' } as const

/**
 * The phone board — `mobile-light.png` / `mobile-dark.png`, as data.
 *
 * Same session, later: the desktop board is still holding the crates.io ask at
 * 1:47, this thread is after it was allowed, which is why it ends on "done. it's
 * live." and carries no choice card. The clock in the status bar (2:06) is part
 * of that story, not decoration.
 *
 * Kept verbatim from the mockup for the same reason as `BOARD_ROSTER`: a phone
 * bench that paraphrases the approved render is not a parity anchor.
 */
export const PHONE_CLOCK = '2:06'

export interface PhoneTurn {
  /** `agent` renders a gutter mark; `me` is the right-aligned user bubble. */
  from: 'agent' | 'me'
  text: string
  /** The mark's pose on this turn — the last line is `done`. */
  state?: MarkState
}

export const PHONE_THREAD: readonly PhoneTurn[] = [
  { from: 'agent', text: 'morning. picking the release back up.' },
  { from: 'me', text: 'morning' },
  { from: 'agent', text: 'the nightly run finished clean. no flakes.' },
  { from: 'me', text: 'nice' },
  { from: 'agent', text: 'starting the 0.6.0 tag now.' },
  { from: 'me', text: "how's the tag looking?" },
  { from: 'agent', text: "build's rolling. two checks left." },
]

/** The phone's shorter receipt group — two lines, not three. */
export const PHONE_RECEIPTS: readonly Receipt[] = [
  { tool: 'tests', outcome: '212 passed' },
  { tool: 'release', outcome: 'v0.6.0 tagged' },
]

/** The turns after the two colleagues report back. */
export const PHONE_TAIL: readonly PhoneTurn[] = [
  { from: 'me', text: 'any risk in the ledger path?' },
  { from: 'agent', text: 'no. two new tests cover it.' },
  { from: 'me', text: 'ship it once CI is green' },
]

/** After the schedule line — the two closing turns. */
export const PHONE_CLOSE: readonly PhoneTurn[] = [
  { from: 'agent', text: 'one check left. then crates.io.' },
  { from: 'agent', text: "done. it's live.", state: 'done' },
]

/**
 * Every primitive the bench claims to render. Asserted against the barrel's
 * exports in the unit test — a page that quietly stops showing one of these is a
 * page that stops being the review surface.
 */
export const PRIMITIVES = [
  'RosterRow',
  'WorkingRow',
  'ReceiptGroup',
  'Bubble',
  'SystemLine',
  'DelegationPill',
  'ChoiceCard',
  'Composer',
  'CapturedFrameCard',
  'Facepile',
] as const

/** Both themes are on one page; `[data-theme]` is the subtree switch. */
export const BENCH_THEMES = ['light', 'dark'] as const
export type BenchTheme = (typeof BENCH_THEMES)[number]

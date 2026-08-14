/**
 * The fixture behind `/dev/chat-live` — the approved boards, as WIRE data.
 * ─────────────────────────────────────────────────────────────────────────────
 * `/dev/chat-ui` (fase B0) answers "does each primitive look right?" by drawing
 * the board out of primitives by hand. This fixture answers the question that
 * one cannot: does the RENDERER, fed the shapes the server actually sends,
 * produce the approved board?
 *
 * So everything here is `ChatEntry` — newest-first, the exact shape
 * `/recall?chat=true` returns — and it goes through the real pipeline
 * (`toDisplayList` → `receiptsFirst` → `groupItems` → `dayDividers`) before it
 * reaches a pixel. That is why the fixture is worth having: a bench that fed
 * hand-built `ChatItem`s would silently skip the receipts-first tie-break, the
 * run grammar, the arrival dividers and the frame detector — four of the things
 * A3 is.
 *
 * SEEDS AND PINS. The wire's identity is a SLUG (`release-train`), the approved
 * boards were art-directed, and the wire carries no `mark_*` columns yet
 * (`session-accent.ts` §10). So the bench pins the cast by slug — the same pins
 * `/dev/marks` and `/dev/chat-ui` use, from the same list — and hands them to
 * the surface, which passes them to BOTH the faces and the accent derivation.
 * Without that, this page would compare the boards' coral Release Train against
 * whatever `release-train` happens to hash to.
 *
 * Kept out of the route (a `.tsx` full of `@/` aliases) so
 * `tests/unit/dev-chat-live-fixture.test.ts` can assert the coverage claim: that
 * every state the surface can be in is actually on this page.
 */
import type { MarkPin } from '../brand/marks/character'
import type { ChatEntry } from '../components/chat/entries'
import type { OverlayLine } from '../components/chat/use-receipt-overlay'
import type { TileSession } from '../components/session-tile/types'

import { REFERENCE_STRIP } from './dev-marks.cast'

/* ── the cast, by slug ───────────────────────────────────────────────────── */

/** display name → slug, for the seven approved faces the boards use. */
const SLUGS: Readonly<Record<string, string>> = {
  'Release Train': 'release-train',
  Patch: 'patch',
  Quill: 'quill',
  Ledger: 'ledger',
  Compass: 'compass',
  Lookout: 'lookout',
  Kestrel: 'kestrel',
}

/** slug → the approved pin. Both keys resolve, so a bench chrome that seeds a
 *  roster row by DISPLAY name and a transcript that seeds a mark by SLUG draw
 *  the same character. */
export const PINS: ReadonlyMap<string, MarkPin> = new Map([
  ...REFERENCE_STRIP.map((m) => [m.name, m.pin] as const),
  ...REFERENCE_STRIP.map((m) => [SLUGS[m.name] ?? m.name, m.pin] as const),
])

export function pinFor(seed: string): MarkPin | undefined {
  return PINS.get(seed)
}

/** slug → display name, the second index the panel derives from the sessions
 *  query (the arrival divider names a colleague, not a row). */
export const NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries(SLUGS).map(([name, slug]) => [slug, name] as const),
)

/** The known-sessions index the panel derives from the sessions query. */
export const MENTIONS: ReadonlyMap<string, string> = new Map(
  Object.entries(SLUGS).flatMap(([name, slug]) => [
    [name.toLowerCase(), slug] as const,
    [slug, slug] as const,
  ]),
)

/* ── sessions ────────────────────────────────────────────────────────────── */

const DIR = '/opt/projects/supermux/server'

function session(over: Partial<TileSession> & { name: string }): TileSession {
  return {
    status: 'idle',
    dir: DIR,
    provider: 'claude',
    preview_lines: [],
    updated_at: '2026-08-14T13:47:00Z',
    ...over,
  }
}

export const RELEASE_TRAIN = 'release-train'
export const PATCH = 'patch'

/* ── entries ─────────────────────────────────────────────────────────────── */

/**
 * The transcript, oldest first, in SECONDS BEFORE NOW.
 *
 * Relative because two things on this page read the clock: the session-block
 * divider (`dividerLabel`) and the working row's elapsed clause. A fixture with
 * absolute stamps would open every board with `14 Aug 2026` and a turn that has
 * been running for four months.
 */
interface Draft {
  /** Seconds before now. */
  ago: number
  kind: 'prompt' | 'assistant' | 'tool_use' | 'notification' | 'system' | 'teammate' | 'command'
  text: string
  reply?: string
  label?: string
  ok?: boolean
}

function build(drafts: readonly Draft[], nowSec: number): ChatEntry[] {
  return drafts
    .map((d, i) => ({
      uuid: `e${i}`,
      ts: nowSec - d.ago,
      text: d.text,
      reply: d.reply,
      kind: d.kind,
      label: d.label,
      ok: d.ok,
    }))
    // The wire is newest-first; the display model reverses it. Feeding it in
    // wire order is the point — `toDisplayList` is on the path.
    .reverse()
}

/**
 * The Release Train board (`board-light.png` / `board-dark.png`), as the server
 * would have sent it.
 *
 * The three `tool_use` entries and the prose that follows them share ONE second
 * on purpose: that is the flush case, and it is what makes the receipts-first
 * tie-break visible on this page instead of only in a unit test.
 */
const RELEASE_DRAFTS: readonly Draft[] = [
  { ago: 760, kind: 'assistant', text: 'morning. picking the release back up.' },
  { ago: 700, kind: 'prompt', text: "how's the tag looking?" },
  {
    ago: 640,
    kind: 'assistant',
    text: 'tagged v0.6.0 and the build is rolling. two checks left.',
  },
  {
    ago: 600,
    kind: 'tool_use',
    text: '⚡ cargo check',
    reply: 'clean · 0 errors',
  },
  { ago: 600, kind: 'tool_use', text: '⚡ tests', reply: '212 passed' },
  { ago: 600, kind: 'tool_use', text: '⚡ release', reply: 'v0.6.0 tagged' },
  {
    ago: 600,
    kind: 'tool_use',
    text: 'Read /opt/projects/supermux/artifacts/release-run.png',
    reply: 'read 1 image',
  },
  // Same second as the receipts above, and written after them → the closing
  // prose waits for the whole checklist (`receiptsFirst`).
  {
    ago: 600,
    kind: 'assistant',
    text: 'the run is captured above if you want a look at it.',
  },
  {
    ago: 420,
    kind: 'assistant',
    text: "Patch sent over the failing job and Quill tightened the notes. both folded into tonight's run.",
  },
  { ago: 360, kind: 'prompt', text: 'ship it once CI is green' },
  { ago: 300, kind: 'notification', text: 'Nightly release watch' },
  { ago: 240, kind: 'assistant', text: 'one check left. then crates.io.' },
]

/** The Patch board (`board-patch-focused.png`) — the same screen, re-skinned. */
const PATCH_DRAFTS: readonly Draft[] = [
  { ago: 900, kind: 'prompt', text: 'the euro amounts come out wrong in the ledger export' },
  {
    ago: 840,
    kind: 'assistant',
    text: [
      'found it in `server/src/export/money.rs` — we parsed with the dot as the decimal mark, so 1.234,56 came back as one and a bit:',
      '',
      '```rust',
      "- let cents = raw.replace(',', \"\").parse::<f64>()?;",
      '+ let cents = Money::parse_locale(raw, locale)?;',
      '```',
    ].join('\n'),
  },
  { ago: 780, kind: 'tool_use', text: '⚡ cargo check', reply: 'clean · 0 errors' },
  { ago: 780, kind: 'tool_use', text: '⚡ tests', reply: '38 passed · 2 new' },
  { ago: 780, kind: 'tool_use', text: '⚡ export', reply: '1.234,56 € reads right' },
  {
    ago: 600,
    kind: 'assistant',
    text: 'Ledger had the same bug in the invoice path and Quill wrote the note for the changelog. both in this branch now.',
  },
  { ago: 540, kind: 'prompt', text: 'good. open the PR' },
  { ago: 480, kind: 'system', text: 'euro amounts in the export' },
  { ago: 420, kind: 'assistant', text: 'branch is ready. three commits, one from each of us.' },
]

/** The delegation board: a colleague's message ARRIVING (master plan §13.2). */
const ARRIVAL_DRAFTS: readonly Draft[] = [
  ...RELEASE_DRAFTS.slice(0, 9),
  {
    ago: 200,
    kind: 'teammate',
    text: "here's the failing job — it's the money parser again, not the runner.",
    label: 'patch',
  },
  {
    ago: 190,
    kind: 'teammate',
    text: 'i pushed the fix to fix/money; the export test covers it now.',
    label: 'patch',
  },
  { ago: 120, kind: 'assistant', text: 'good. folding it into tonight’s run.' },
]

/* ── the states ──────────────────────────────────────────────────────────── */

export interface LiveState {
  /** URL id — `/dev/chat-live?mock&state=<id>`. */
  id: string
  /** What a reviewer is looking at. */
  title: string
  /** Which approved board this one is held against. */
  board: string
  session: TileSession
  entries: ChatEntry[]
  /** Seconds before now the running turn started; omit for no live turn. */
  turnAgo?: number
  overlay?: readonly OverlayLine[]
  /** The P13 pty capture, as lines. */
  provisional?: readonly string[]
  /** The tail query failed. */
  isError?: boolean
}

const OVERLAY: readonly string[] = [
  '⚡ Read server/src/export/money.rs',
  '⚡ Grep parse_locale',
  '⚡ cargo test --lib money',
]

const PTY: readonly string[] = [
  '   Compiling supermux-server v0.6.0 (/opt/projects/supermux/server)',
  '    Finished test [unoptimized + debuginfo] target(s) in 6.41s',
  '     Running unittests src/lib.rs',
  '',
  'running 3 tests',
  'test export::money::parses_eu_locale ... ok',
  'test export::money::parses_us_locale ... ok',
]

export function liveStates(nowMs: number): LiveState[] {
  const nowSec = Math.floor(nowMs / 1000)
  const release = build(RELEASE_DRAFTS, nowSec)
  const overlay: OverlayLine[] = OVERLAY.map((label, i) => ({
    label,
    at: nowMs - (OVERLAY.length - i) * 4_000,
  }))

  return [
    {
      id: 'idle',
      title: 'Idle — a finished conversation',
      board: 'board-light.png / board-dark.png',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
    },
    {
      id: 'working',
      title: 'Mid-turn — hook receipts + the working row',
      board: 'board-light.png (live layer)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ cargo test --lib money',
        subagents: 3,
      }),
      entries: release,
      turnAgo: 42,
      overlay,
    },
    {
      id: 'provisional',
      title: 'Provisional — the pty tail, visibly unconfirmed',
      board: 'P13 (master plan §4.2)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ cargo test --lib money',
      }),
      entries: release,
      turnAgo: 96,
      overlay,
      provisional: PTY,
    },
    {
      id: 'permission',
      title: 'Permission — the one thing on screen that is asking',
      board: 'board-light.png (choice card)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ cargo publish --dry-run',
        permission_request: {
          tool: 'Bash',
          summary: '⚡ cargo publish --dry-run',
          kind: 'bash',
        },
      }),
      entries: release,
      turnAgo: 18,
    },
    {
      id: 'delegation',
      title: 'Delegation — one arriving, one going out',
      board: 'board-light.png (pill + arrival divider)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ asking Patch to re-run the export test',
      }),
      entries: build(ARRIVAL_DRAFTS, nowSec),
      turnAgo: 31,
    },
    {
      id: 'error',
      title: 'Error — a failed run, said calmly',
      board: 'master plan §4.2 (tone: never alarmist red)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'error',
        error: { type: 'StopFailure', message: 'cargo check failed' },
      }),
      entries: build(
        [
          ...RELEASE_DRAFTS.slice(0, 3),
          {
            ago: 600,
            kind: 'tool_use',
            text: '⚡ cargo check',
            reply: 'error[E0432]: unresolved import `crate::money::Locale`',
            ok: false,
          },
          { ago: 600, kind: 'tool_use', text: '⚡ tests', reply: 'not run', ok: false },
          {
            ago: 590,
            kind: 'assistant',
            text: 'the check broke on an import I moved — fixing it now, no work lost.',
          },
        ],
        nowSec,
      ),
    },
    {
      id: 'offline',
      title: 'Offline — the tail itself could not be read',
      board: 'A1 honesty string',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: [],
      isError: true,
    },
    {
      id: 'patch',
      title: 'Patch focused — the same surface, one property changed',
      board: 'board-patch-focused.png',
      session: session({
        name: PATCH,
        display_name: 'Patch',
        status: 'active',
        activity: '⚡ git push -u origin fix/money',
        permission_request: {
          tool: 'Bash',
          summary: '⚡ git push -u origin fix/money',
          kind: 'bash',
        },
      }),
      entries: build(PATCH_DRAFTS, nowSec),
      turnAgo: 12,
    },
  ]
}

/** Every state id, for the picker and for the coverage test. */
export const STATE_IDS = [
  'idle',
  'working',
  'provisional',
  'permission',
  'delegation',
  'error',
  'offline',
  'patch',
] as const

export type StateId = (typeof STATE_IDS)[number]

/* ── bench chrome ────────────────────────────────────────────────────────── */

export interface BenchRosterRow {
  seed: string
  label: string
  timestamp: string
  preview: string
  state?: 'idle' | 'working' | 'waiting' | 'done'
  attention?: boolean
}

/**
 * The roster the surface sits NEXT TO.
 *
 * Not part of A3 — the sidebar is Track B — but the boards are a WHOLE SCREEN,
 * and half of what they approve is how the conversation pane reads against the
 * paper beside it (the elevation step, the hairline, the accent on the selected
 * row). A bench that cropped the roster away could not review that, so this is
 * bench chrome built from the shipped `RosterRow` primitive, with the boards'
 * own rows.
 */
export const BENCH_ROSTER: readonly BenchRosterRow[] = [
  {
    seed: 'release-train',
    label: 'Release Train',
    timestamp: '1:47 PM',
    preview: 'one check left. then crates.io.',
    state: 'working',
  },
  { seed: 'patch', label: 'Patch', timestamp: '11:02 AM', preview: 'Typing…', state: 'working' },
  {
    seed: 'quill',
    label: 'Quill',
    timestamp: '10:12 AM',
    preview: 'readme rewritten. shorter now.',
    state: 'waiting',
    attention: true,
  },
  {
    seed: 'ledger',
    label: 'Ledger',
    timestamp: '9:38 AM',
    preview: 'euro formats parse clean now.',
    state: 'idle',
  },
  {
    seed: 'compass',
    label: 'Compass',
    timestamp: '8:15 AM',
    preview: 'three dead links, all in docs.',
    state: 'idle',
  },
  {
    seed: 'lookout',
    label: 'Lookout',
    timestamp: 'Yesterday',
    preview: 'ci green across the board.',
    state: 'done',
  },
  {
    seed: 'kestrel',
    label: 'Kestrel',
    timestamp: 'Yesterday',
    preview: 'strato box is quiet since the fix.',
    state: 'done',
  },
]

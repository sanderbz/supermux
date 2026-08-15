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
import type { AttentionCause } from '../components/chat/attention'
import { applyLatch, dialogCardView, type DialogCardView } from '../components/chat/dialog-answer'
import { readLens } from '../components/chat/peek-lens'
import type { ChatEntry } from '../components/chat/entries'
import type { PendingSend } from '../components/chat/pending'
import type { MentionableSession } from '../components/chat/slash'
import type { ComposerNotice } from '../components/chat/use-composer'
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

/**
 * The evidence the Attention card shows — the a0 Bash-permission frame, ANSI
 * intact, so the bench's mini-view and the lens' fixtures are the same bytes
 * (T10's rule). Truecolour on purpose: the mini-view's whole claim is that it
 * reproduces the session's own screen faithfully.
 */
export const BENCH_CAPTURE = [
  '\u001b[38;2;177;185;249m Bash command\u001b[0m',
  '',
  '   touch /tmp/spike-test-file',
  '   \u001b[38;5;244mCreate empty file /tmp/spike-test-file\u001b[0m',
  '',
  ' Do you want to proceed?',
  '\u001b[38;2;177;185;249m ❯ 1. Yes\u001b[0m',
  '   2. Yes, and always allow access to tmp/ from this project',
  '   3. No',
  '',
  ' \u001b[38;5;244mEsc to cancel · Tab to amend · ctrl+e to explain\u001b[0m',
].join('\n')

/**
 * The plan-approval frame (a0, CC 2.1.231 — `tests/fixtures/tui/plan-approval.txt`).
 * Verbatim rows, so the card the bench draws is built by the SAME lens + registry
 * path the app uses; nothing about this state is hand-assembled.
 */
export const BENCH_PLAN_CAPTURE = [
  ' Ready to code?',
  '',
  " Here is Claude's plan:",
  '╌╌╌╌╌╌╌╌ (plan markdown between dashed rules) ╌╌╌╌╌╌╌╌',
  '',
  ' Claude has written up a plan and is ready to execute. Would you like to',
  ' proceed?',
  '',
  '\u001b[38;2;72;150;140m ❯ 1. Yes, and use auto mode\u001b[0m',
  '   2. Yes, manually approve edits',
  '   3. Tell Claude what to change',
  '      shift+tab to approve with this feedback',
  '',
  ' \u001b[38;5;244mctrl+g to edit in Supermux-edit ·',
  ' ~/.claude/plans/plan-a-tiny-change-purrfect-locket.md\u001b[0m',
].join('\n')

/** The session's boot-banner version — the registry's ONLY pin. */
const BENCH_PIN = '2.1.231'
/** A version nothing was ever captured against: every option renders, none of
 *  them presses a key. That is the state a CC bump puts every user in, so it is
 *  on the bench beside the working one. */
const BENCH_UNPINNED = '2.9.0'

/**
 * What a sequence that ABORTED says. Not invented copy — the sentence
 * `dialog-answer.ts` composes when the caret it just moved is not where it put
 * it, which is the concurrent-client race A0 watched happen twice.
 */
const BENCH_ABORT =
  'After Down, the terminal’s selection sits on option 3 instead of 2 — something else is typing into this session, so nothing further was sent.'

/** The four cards, built through the shipped path: capture → lens → registry. */
export const BENCH_DIALOGS: Readonly<
  Record<'permission' | 'plan' | 'unpinned' | 'aborted', DialogCardView>
> = {
  permission: dialogCardView(readLens(BENCH_CAPTURE), BENCH_PIN)!,
  plan: dialogCardView(readLens(BENCH_PLAN_CAPTURE), BENCH_PIN)!,
  unpinned: dialogCardView(readLens(BENCH_CAPTURE), BENCH_UNPINNED)!,
  // Through `applyLatch`, so the bench shows the real revert — a card that was
  // answerable a second ago, is inert now, and PRINTS why.
  aborted: applyLatch(dialogCardView(readLens(BENCH_CAPTURE), BENCH_PIN), {
    key: dialogCardView(readLens(BENCH_CAPTURE), BENCH_PIN)!.key,
    detail: BENCH_ABORT,
    attention: 'dialog-unmapped',
  }).card!,
}

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
  /**
   * The LIVE composer, in a fixed state (fase A4 T9).
   *
   * Present → the bench mounts the real `<ChatComposer>` with a static handle
   * instead of A3's read-only shell. Static on purpose: every other state on
   * this page is one moment with no network behind it, and a composer that
   * fetched its own list would make the two screenshots that matter — the
   * popover and the refusal — depend on a server this page does not have.
   */
  composer?: {
    draft: string
    /** The `@`/`/` popover, open over the trigger the draft ends in. The unit
     *  test asserts this against `readTrigger(draft)`, so the bench cannot
     *  drift from the composer's own arithmetic. */
    picker?: { kind: '@' | '/'; query: string }
    /** The refusal banner, pre-raised. */
    notice?: ComposerNotice
  }
  /** P10 echoes, in their three states (fase A4 T4). */
  pending?: readonly PendingSend[]
  /**
   * The dialog card (fase A4 T7) — which options exist and which of them this
   * app will actually press. Built from a capture through the real lens +
   * registry, so a fingerprint that stops matching takes the bench down with the
   * app rather than quietly diverging from it.
   */
  dialog?: DialogCardView
  /** A sequence in flight — the whole card is inert while one is. */
  dialogBusy?: number | 'escape'
  /** The line the card became once an answer landed. */
  dialogResolved?: string
  /** The Attention card's cause, and whether the bench opens it (T5). */
  attention?: AttentionCause
  attentionExpanded?: boolean
  /** The raw capture the card's mini-view renders — the a0 permission frame,
   *  ANSI intact, so the bench and the lens read the same bytes. */
  attentionCapture?: string
}

/**
 * `GET /api/sessions/{name}/tracked-files`, as the release-train session would
 * answer it — the `@` picker's first source. Real paths from this repo, because
 * the popover's whole job is to look like the project the user is in.
 */
export const TRACKED_FILES: readonly string[] = [
  'server/src/sessions/lifecycle.rs',
  'server/src/sessions/recall.rs',
  'server/src/export/money.rs',
  'web/src/components/chat/conversation.tsx',
  'web/src/components/chat/composer.tsx',
  'docs/superpowers/plans/2026-08-14-fase-a4-interactivity.md',
  'CHANGELOG.md',
]

/** `GET /api/slash-commands` — a built-in, a picker-opening one and a skill, so
 *  the `/` popover's three row shapes are all on the page. */
export const BENCH_COMMANDS: readonly { cmd: string; desc: string }[] = [
  { cmd: '/compact', desc: 'summarise the conversation so far' },
  { cmd: '/model', desc: 'switch the model' },
  { cmd: '/mcp', desc: 'manage MCP servers' },
  // A built-in nobody has captured — the row that must say "terminal only".
  { cmd: '/permissions', desc: 'edit the allow/deny rules' },
  { cmd: '/money-audit', desc: 'skill · re-check the euro parser' },
]

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
    {
      id: 'pending',
      title: 'Pending — one send in flight, one unconfirmed, one the watchdog gave up on',
      board: 'A4 T4 (P10)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      pending: [
        { id: 'p1', text: 'run the full test suite', atMs: nowMs - 800, state: 'sending' },
        { id: 'p2', text: 'and push the branch when it’s green', atMs: nowMs - 2_600, state: 'unconfirmed' },
        {
          id: 'p3',
          text: 'revert the migration',
          atMs: nowMs - 9_000,
          state: 'undelivered',
          note: 'The session isn’t running.',
        },
      ],
    },
    {
      id: 'attention',
      title: 'Attention — the honesty surface, expanded over the pane with its evidence',
      board: 'A4 T5',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      pending: [
        {
          id: 'p3',
          text: 'revert the migration',
          atMs: nowMs - 9_000,
          state: 'undelivered',
          note: 'The session isn’t running.',
        },
      ],
      attention: 'send-unconfirmed',
      attentionExpanded: true,
      attentionCapture: BENCH_CAPTURE,
    },
    {
      id: 'attention-inline',
      title: 'Attention — the inline row, before anybody taps it',
      board: 'A4 T5 (inline-first)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      pending: [
        {
          id: 'p3',
          text: 'revert the migration',
          atMs: nowMs - 9_000,
          state: 'undelivered',
          note: 'The session isn’t running.',
        },
      ],
      attention: 'send-unconfirmed',
      attentionCapture: BENCH_CAPTURE,
    },
    {
      id: 'stopping',
      title: 'Stopping — a turn is running and the box is empty, so the control is Stop',
      board: 'A4 T3',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ cargo test recall',
      }),
      entries: release,
      turnAgo: 14,
      composer: { draft: '' },
    },
    {
      id: 'queueing',
      title: 'Queueing — typing a follow-up mid-turn: the control is Send, not Stop',
      board: 'A4 T3 (A4 review)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ cargo test recall',
      }),
      entries: release,
      turnAgo: 14,
      composer: { draft: 'and when that’s green, push the branch' },
    },
    {
      id: 'composing',
      title: 'Composing — a real draft, with the `@` picker open over tracked files',
      board: 'board-light.png (composer) + A4 T9',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      composer: {
        // The trigger is the LAST token, which is where the caret is — the unit
        // test derives the picker below from exactly this string.
        draft: 'compare notes with @com',
        picker: { kind: '@', query: 'com' },
      },
    },
    {
      id: 'slash',
      title: 'Slash — a command that opens a TUI picker, refused out loud',
      board: 'A4 T9 (the refusal)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      composer: {
        // Both halves of the surface at once, and this IS a reachable moment:
        // the user typed `/model`, pressed Enter, the send was refused — and the
        // draft (and therefore the popover) is still exactly where they left it.
        draft: '/model',
        picker: { kind: '/', query: 'model' },
        notice: { kind: 'slash-picker', detail: '/model' },
      },
    },
    {
      id: 'refused',
      title: 'Refused — a built-in chat cannot verify, listed but not sent',
      board: 'A4 T9 (the safety pass)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      composer: {
        // `/permissions` opens a RULES EDITOR on the pty. Sent as text it would
        // sit there eating the next chat message, so it is refused — and the
        // row said "terminal only" before it was ever picked. This state is on
        // the bench because the badge is the only warning that arrives in time.
        draft: '/permissions',
        picker: { kind: '/', query: 'permissions' },
        notice: { kind: 'slash-unverified', detail: '/permissions' },
      },
    },
    {
      id: 'dialog-live',
      title: 'Answerable — the permission card with the keys chat will actually press',
      board: 'board-light.png (choice card) + A4 T7',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ touch /tmp/spike-test-file',
        permission_request: {
          tool: 'Bash',
          summary: '⚡ touch /tmp/spike-test-file',
          kind: 'bash',
        },
      }),
      entries: release,
      turnAgo: 12,
      // THE headline state, and the one every refusal below is a departure
      // from: three live pills (1 / 3 / esc — a0's verified set) and option 2
      // drawn, readable and inert because what "always allow" persists on a
      // Bash dialog was never found on disk.
      dialog: BENCH_DIALOGS.permission,
    },
    {
      id: 'answering',
      title: 'Answering — the permission card mid-sequence, every control inert',
      board: 'board-light.png (choice card) + A4 T7',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ touch /tmp/spike-test-file',
        permission_request: {
          tool: 'Bash',
          summary: '⚡ touch /tmp/spike-test-file',
          kind: 'bash',
        },
      }),
      entries: release,
      turnAgo: 12,
      // "Not now" was tapped: two Down keys and an Enter, each one verified
      // against a fresh capture — which is why the card says what it is doing
      // rather than spinning.
      dialog: BENCH_DIALOGS.permission,
      dialogBusy: 2,
    },
    {
      id: 'plan-approval',
      title: 'Plan approval — the three real 2.1.231 labels, Esc still unverified',
      board: 'A4 T7 (a0 §3, Family 2)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ waiting on plan approval',
        mode: 'plan',
      }),
      entries: release,
      turnAgo: 40,
      // No `permission_request`: no `PermissionRequest` hook is verified for
      // `ExitPlanMode`, so the lens is this card's only source — exactly as it
      // is in the app.
      dialog: BENCH_DIALOGS.plan,
    },
    {
      id: 'dialog-refused',
      title: 'Refused — a Claude Code version the fingerprints were never checked against',
      board: 'A4 T7 (the hard-disable)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ touch /tmp/spike-test-file',
        permission_request: {
          tool: 'Bash',
          summary: '⚡ touch /tmp/spike-test-file',
          kind: 'bash',
        },
      }),
      entries: release,
      turnAgo: 12,
      dialog: BENCH_DIALOGS.unpinned,
      attention: 'registry-version-mismatch',
      attentionCapture: BENCH_CAPTURE,
    },
    {
      id: 'dialog-aborted',
      title: 'Aborted — the caret moved under a sequence, and the card says so',
      board: 'A4 T7 (the revert path)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ touch /tmp/spike-test-file',
        permission_request: {
          tool: 'Bash',
          summary: '⚡ touch /tmp/spike-test-file',
          kind: 'bash',
        },
      }),
      entries: release,
      turnAgo: 12,
      // The state the safety review exists for: a Down went on the wire, the
      // re-peek found the selection somewhere else, and the sequence stopped.
      // The question is still readable, nothing on it can be pressed again, and
      // the sentence naming what happened is ON THE CARD — not in a tooltip.
      dialog: BENCH_DIALOGS.aborted,
      attention: 'dialog-unmapped',
      attentionCapture: BENCH_CAPTURE,
    },
  ]
}

/**
 * The sessions an `@` may name on this page — the same cast the roster draws,
 * so a mention picked here matches a face in the sidebar.
 */
export const MENTIONABLE: readonly MentionableSession[] = [
  { name: 'patch', display_name: 'Patch' },
  { name: 'quill', display_name: 'Quill' },
  { name: 'ledger', display_name: 'Ledger' },
  { name: 'compass', display_name: 'Compass' },
]

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
  'pending',
  'attention',
  'attention-inline',
  'stopping',
  'queueing',
  'composing',
  'slash',
  'refused',
  'dialog-live',
  'answering',
  'plan-approval',
  'dialog-refused',
  'dialog-aborted',
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

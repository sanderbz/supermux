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
import { toChatEntries } from '../components/chat/wire-entries'
import type { WireEntry } from '../components/chat/wire'
import type { HarnessEvent } from '../lib/api/harness'
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
 * The four harness sentences, as ledger rows (fase B4 T3.6).
 *
 * One of each surfaced action, in the order a real afternoon produces them, so
 * a single screenshot shows every sentence `HarnessLine` can say — including
 * the failed fire, which is the one that has a tone of its own. `ts` is seconds
 * (the ledger's unit), interleaved with the transcript rather than stacked at
 * the end, because "the log lives where it happened" is the whole claim.
 */
function harnessEvents(nowSec: number): readonly HarnessEvent[] {
  return [
    {
      id: 101,
      ts: nowSec - 520,
      actor: 'user',
      action: 'session.delegate',
      target: 'patch',
      detail: { from: RELEASE_TRAIN },
    },
    {
      id: 102,
      ts: nowSec - 430,
      actor: `agent:${RELEASE_TRAIN}`,
      action: 'session.rename',
      target: RELEASE_TRAIN,
      detail: { from: 'Release', to: 'Release Train' },
    },
    {
      id: 103,
      ts: nowSec - 300,
      actor: `agent:${RELEASE_TRAIN}`,
      action: 'schedule.create',
      target: 'SCHED-1a2b3c4d',
      detail: { session: RELEASE_TRAIN, title: 'Nightly release watch', kind: 'tmux' },
    },
    {
      id: 104,
      ts: nowSec - 150,
      actor: 'scheduler',
      action: 'schedule.run',
      target: 'SCHED-1a2b3c4d',
      detail: { session: RELEASE_TRAIN, title: 'Nightly release watch', status: 'error' },
    },
  ]
}

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

/**
 * The AskUserQuestion capture, trimmed from the live one the state audit took
 * (`server/tests/fixtures/pty/ask-user-question.txt`, session `vx-chat` on CC
 * 2.1.233). Inline for the same reason `BENCH_CAPTURE` is: this page renders
 * without a backend and without a file read.
 *
 * Everything that makes it a question is here — the reverse-video header chip,
 * the model's sentence, the descriptions under each label, the free-text row,
 * and the rule with the out-of-box row below it that the option scan must stop
 * at.
 */
export const BENCH_QUESTION_CAPTURE = [
  '╭─── Claude Code v2.1.233 ───────────────────────────────╮',
  '╰────────────────────────────────────────────────────────╯',
  '',
  '❯ Ask me one multiple-choice question: which fruit do I want.',
  '────────────────────────────────────────────────────────────',
  ' ☐ Fruit choice ',
  '',
  'Which fruit do you want?',
  '',
  '❯ 1. Apple',
  '     A crisp and refreshing fruit',
  '  2. Banana',
  '     A soft and sweet tropical fruit',
  '  3. Cherry',
  '     A small and tart stone fruit',
  '  4. Type something.',
  '────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

/** The workspace-trust gate, from the production spool's pre-accept frame
 *  (`server/tests/fixtures/pty/trust-folder.txt`). NOTE what is missing: a boot
 *  banner. This dialog draws above the welcome box, which is why its registry
 *  entry is pin-exempt and why this bench state passes `null` for the pin. */
export const BENCH_TRUST_CAPTURE = [
  '────────────────────────────────────────────────────────────',
  ' Accessing workspace:',
  '',
  ' /home/supermux/spike-a0/trust',
  '',
  ' Quick safety check: Is this a project you created or one you trust?',
  ' If not, take a moment to review what is in this folder first.',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

/**
 * `Session paused` — the OVERAGE CONSENT modal (catalog
 * `limit.overage_consent_dialog`, corpus row `session_paused_overage`).
 *
 * The state the catalog marks ★: needs input, has a billing consequence, and
 * before this wave nothing in the product could see it — the turn does not end,
 * so no hook fires, and the session sat here wearing a green Idle dot.
 */
export const BENCH_PAUSED_OVERAGE_CAPTURE = [
  '● Let me run the test suite.',
  '────────────────────────────────────────────────────────────',
  ' Session paused',
  '',
  ' Continue with Fable 5 on usage credits, or switch models for the rest of',
  ' this session.',
  '',
  '   1. Continue on usage credits',
  ' ❯ 2. Switch to the default model',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

/** `Session paused` — the REFUSAL FALLBACK modal (catalog
 *  `err.refusal_fallback_dialog`, corpus row `session_paused_refusal`). Same
 *  title, different result enum, and its payload is what retracts the replies
 *  already on screen. */
export const BENCH_PAUSED_REFUSAL_CAPTURE = [
  "● I'll take a look at the parser.",
  '────────────────────────────────────────────────────────────',
  ' Session paused',
  '',
  " Fable 5's safeguards flagged this message. Our intentionally broad",
  ' safeguards allow us to deliver more capabilities faster, but can sometimes',
  ' flag legitimate coding, cybersecurity, and biology tasks.',
  '',
  ' ❯ 1. Switch to Opus 5',
  '   2. Edit prompt and retry with Fable 5',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

/** The session's boot-banner version — the registry's ONLY pin. */
const BENCH_PIN = '2.1.231'
/** The pin the question capture actually carries — the card is pinned to the
 *  binary its fingerprint was captured on, and nothing wider. */
const BENCH_QUESTION_PIN = '2.1.233'
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
  Record<
    | 'permission'
    | 'plan'
    | 'question'
    | 'trust'
    | 'unpinned'
    | 'aborted'
    | 'pausedOverage'
    | 'pausedRefusal',
    DialogCardView
  >
> = {
  permission: dialogCardView(readLens(BENCH_CAPTURE), BENCH_PIN)!,
  plan: dialogCardView(readLens(BENCH_PLAN_CAPTURE), BENCH_PIN)!,
  question: dialogCardView(readLens(BENCH_QUESTION_CAPTURE), BENCH_QUESTION_PIN)!,
  // `null` for the pin, and that is the point of the state: the trust gate
  // draws before any banner exists, so this is what the app really holds.
  trust: dialogCardView(readLens(BENCH_TRUST_CAPTURE), null)!,
  unpinned: dialogCardView(readLens(BENCH_CAPTURE), BENCH_UNPINNED)!,
  // Both paused modals are pin-exempt and press NOTHING: no capture of either
  // exists, and one of the rows spends money. The bench shows exactly that —
  // a card you can read, with every control inert and a reason on it.
  pausedOverage: dialogCardView(readLens(BENCH_PAUSED_OVERAGE_CAPTURE), null)!,
  pausedRefusal: dialogCardView(readLens(BENCH_PAUSED_REFUSAL_CAPTURE), null)!,
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
   * A hand-off this client dispatched and the ledger has not confirmed (fase
   * B4 T5) — the only thing that draws the pill now that the activity-string
   * heuristic is gone. A SLUG here rather than the `{to, atMs}` the surface
   * takes: `atMs` is a client clock, and the bench stamps it at render so the
   * pill is never accidentally expired in a screenshot.
   */
  handoffTo?: string
  /**
   * This session's harness ledger (fase B4) — the rows that become the centred
   * management-log sentences, merged into the same ts-ordered stream the
   * messages are in. The bench feeds them as WIRE rows for the same reason it
   * feeds `ChatEntry`: `grouping.ts` decides which ones become lines, and a
   * bench that hand-built the lines would skip that decision.
   */
  events?: readonly HarnessEvent[]
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
    /** Draw the schedule affordance (fase B4 T9). Off by default so every
     *  pre-B4 state screenshots the composer it was approved against. */
    schedulable?: boolean
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
  /** The raiser's own evidence, quoted inside the card's sentence. */
  attentionDetail?: string
  /** The pty's stall line (catalog `err.stream_stalled`) — what the working
   *  row says while a request is out and nothing is coming back. */
  stalled?: string
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

/**
 * The PTY-07 transcript tails, built through the SHIPPED wire fold.
 *
 * `build()` above hands the display model its rows directly, which is right for
 * a board screenshot — but the two states below are ABOUT the fold: the
 * retraction is a later append-only entry naming earlier uuids, and the refusal
 * is a banner the classifier has to recognise. Hand-assembling either would
 * screenshot a claim this app does not actually make.
 */
function wireEntry(
  seq: number,
  uuid: string,
  kind: WireEntry['kind'],
  tsSec: number,
  body: Record<string, unknown>,
  extra: Partial<WireEntry> = {},
): WireEntry {
  return {
    seq,
    uuid,
    kind,
    ts_ms: tsSec * 1000,
    offset: 0,
    oversize: false,
    truncated: false,
    body,
    ...extra,
  }
}

/** Two replies Claude streamed, then the fallback line that withdraws them. */
function retractedTail(nowSec: number): ChatEntry[] {
  return toChatEntries([
    wireEntry(1, 'r-prompt', 'prompt', nowSec - 240, {
      text: 'walk me through how the auth token is validated',
    }),
    wireEntry(2, 'r-1', 'assistant', nowSec - 200, {
      text: 'The check happens in `server/src/auth.rs` — here is the path a request takes, and where the comparison is made:',
    }),
    wireEntry(3, 'r-2', 'assistant', nowSec - 196, {
      text: 'The comparison is constant-time, so the obvious timing attack does not apply here.',
    }),
    wireEntry(4, 'r-fallback', 'system', nowSec - 190, {
      level: 'warning',
      content: "Fable 5's safeguards flagged this message. Switched to Opus 5.",
      from_model: 'claude-fable-5',
      to_model: 'claude-opus-5',
      trigger: 'refusal',
      retracted: ['r-1', 'r-2'],
    }, { label: 'model_refusal_fallback' }),
  ])
}

/** A turn that ended with `stop_reason: refusal` — the amber card, and the
 *  composer still live under it. */
function refusedTail(nowSec: number): ChatEntry[] {
  return toChatEntries([
    wireEntry(1, 'x-prompt', 'prompt', nowSec - 120, {
      text: 'write me a fuzzer for the session-token parser',
    }),
    wireEntry(2, 'x-refusal', 'agent_error', nowSec - 110, {
      text: "API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Fable 5.",
      class: 'refusal',
      blocked: false,
    }, { label: 'refusal', ok: false }),
  ])
}

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
      // The pill is drawn by a DISPATCH now, not by the activity string above
      // (fase B4 T5). The activity is kept precisely because it names Patch:
      // this state is the regression guard's positive twin, and the negative
      // one — the same sentence with no dispatch behind it — lives in
      // `chat-interactive.test.tsx`.
      handoffTo: 'patch',
    },
    {
      id: 'harness',
      title: 'Harness log — the four ledger sentences, every chip live',
      board: 'master plan §13.1 (the transcript as a management log)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: build(RELEASE_DRAFTS, nowSec),
      events: harnessEvents(nowSec),
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
    // The three send-escalation PHASES, one per screenshot (P10 / A4 T4). The
    // `pending` state above stacks all three in one band so a single shot can
    // catch any of them lying; these three isolate each phase so the showcase
    // can hold p1→p2→p3 side by side and prove the escalation is legible — none
    // of them the green-Idle a send used to disappear into. Same `PendingSend`
    // shapes the watchdog produces, fed straight to the surface (the bench does
    // not re-run `use-pending-sends`, so `state` here is display truth).
    {
      id: 'p1',
      title: 'Send · phase 1 — the POST is in flight (grace)',
      board: 'A4 T4 (P10 · sending)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      // `sending`: the bubble at reduced weight is the whole claim — "your Enter
      // was received", nothing more. No receipt line yet.
      pending: [{ id: 'p1', text: 'run the full test suite', atMs: nowMs - 400, state: 'sending' }],
    },
    {
      id: 'p2',
      title: 'Send · phase 2 — delivered, waiting for the transcript (watchdog window)',
      board: 'A4 T4 (P10 · unconfirmed)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      // `unconfirmed` + `receipted`: the server has confirmed it typed the text
      // into the pty, so the row states the delivery receipt (`deliveryLine`)
      // instead of "Sending…". This is the calm middle phase — the normal
      // seconds between a send and Claude writing it down.
      pending: [
        {
          id: 'p2',
          text: 'push the branch once it’s green',
          atMs: nowMs - 2_600,
          state: 'unconfirmed',
          receipted: true,
          activeAtSend: false,
        },
      ],
    },
    {
      id: 'p3',
      title: 'Send · phase 3 — the watchdog gave up (escalated, Retry offered)',
      board: 'A4 T4 (P10 · undelivered)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      // `undelivered`: full-weight bubble, the calm-orange reason, and the two
      // ways out — Retry (writes to the pty) and Open terminal. This is the one
      // phase that speaks in the live region, because it is the only news.
      pending: [
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
      id: 'handoff',
      title: 'Hand-off — the send control says where the words are going',
      board: 'master plan §13.2 (the composer hands work over)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      composer: {
        // The MOMENT THAT MATTERS in T4: the draft opens with `@patch`, so
        // Enter no longer sends here — and the control has already relabelled
        // to "Hand to Patch". The whole safety argument is that this is visible
        // BEFORE the key is pressed, which makes it a screenshot.
        draft: '@patch can you re-run the export test on fix/money?',
      },
    },
    {
      id: 'handoff-sent',
      title: 'Hand-off — the receipt, naming who has it now',
      board: 'master plan §13.2 (the receipt)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      composer: {
        // The box is empty because the hand-off landed: the draft is cleared on
        // SUCCESS only. The durable `Delegated to ●Patch` line arrives in the
        // transcript a tick later from the ledger — this banner is the
        // immediate answer, not a second copy of it.
        draft: '',
        notice: { kind: 'handoff-sent', detail: 'Patch' },
      },
    },
    {
      id: 'handoff-failed',
      title: 'Hand-off — refused, with the sentence still in the box',
      board: 'master plan §13.2 (the failure branch)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      composer: {
        // The draft is STILL THERE, and that is the thing under review: a
        // hand-off that 500s must never eat the user's text. The server's own
        // sentence is the detail — it is written to be read.
        draft: '@patch can you re-run the export test on fix/money?',
        notice: {
          kind: 'handoff-failed',
          detail: 'prompt may not contain supermux wrapper markup',
        },
      },
    },
    {
      id: 'schedule-draft',
      title: 'Schedule — the composer offers to run this later instead of now',
      board: 'master plan §13.3 (the trivial human path)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      composer: {
        // The clock beside `+`. A draft is present because the affordance's
        // whole point is that it carries one over — and the draft STAYS after
        // the sheet opens (T9.2), which is why this state screenshots the
        // composer rather than the sheet.
        draft: 'check whether the nightly release job went green',
        schedulable: true,
      },
    },
    {
      id: 'panel',
      title: 'Panel — a full-screen TUI screen is up, so the send is refused and named',
      board: 'daily-driver QA #1',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'idle',
      }),
      entries: release,
      composer: {
        // The wedge, as the user meets it. `/status` opened Claude Code's Status
        // panel on the pty; the peek lens sights the panel (its `Esc to cancel`
        // footer is the evidence, quoted here), so the composer refuses and
        // names the only surface that can dismiss it. Before this the refusal
        // read "The terminal has an unsent draft `/status`" — about a terminal
        // with no draft, quoting the echo of the command that opened the panel.
        draft: 'and when that lands, tag it',
        notice: { kind: 'dialog-terminal', detail: 'Esc to cancel' },
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
    {
      id: 'question',
      title: 'A question — the model’s own sentence, its header chip and real answers',
      board: 'the states audit, finding 4 (03-chat-askq.png)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ AskUserQuestion',
        // The hook fires for AskUserQuestion too, and quoting its `tool` in the
        // question frame is exactly what produced ``Run `AskUserQuestion` ?``.
        // It is on this state deliberately, so the card has to keep winning.
        permission_request: {
          tool: 'AskUserQuestion',
          summary: 'AskUserQuestion',
          kind: 'tool',
        },
      }),
      entries: release,
      turnAgo: 8,
      dialog: BENCH_DIALOGS.question,
    },
    {
      // THE REFUSAL OVER THE ANSWERS (r2 finding 34). The composer's own
      // dialog-question notice and the card it points at, on one screen — the
      // pair that shipped overlapping, because the track reserves room for the
      // composer by MEASURING it and nothing re-pinned the scroll when that
      // measurement grew. A bench state rather than a comment: the failure is
      // two boxes intersecting, which is exactly what a screenshot catches and
      // no unit test can.
      id: 'question-refused',
      title: 'A question, and the refusal that must not cover its answers',
      board: 'r2 finding 34',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ AskUserQuestion',
        permission_request: {
          tool: 'AskUserQuestion',
          summary: 'AskUserQuestion',
          kind: 'tool',
        },
      }),
      entries: release,
      turnAgo: 8,
      dialog: BENCH_DIALOGS.question,
      composer: {
        draft: '',
        notice: { kind: 'dialog-question' },
      },
    },
    {
      id: 'trust-gate',
      title: 'The startup wedge — answerable, with no boot banner to pin against',
      board: 'the states audit, catalog perm.trust_folder',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'waiting',
        blocked: {
          kind: 'startup',
          wedge: 'trust',
          text: 'Accessing workspace:',
        },
      }),
      // An EMPTY conversation, which is the honest one: this gate blocks before
      // the session has written a single transcript line.
      entries: [],
      turnAgo: undefined,
      dialog: BENCH_DIALOGS.trust,
    },
    {
      id: 'limit-blocked',
      title: 'Limit reached — the session that used to read green and Idle',
      board: 'the states audit, finding 1 (05-chat-limits.png)',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        // `idle` ON PURPOSE. The turn ended normally; it is the NEXT one that
        // cannot start, and this state exists so that the header can never go
        // back to being pixel-identical to a healthy session.
        status: 'idle',
        blocked: {
          kind: 'limit',
          text: "You've hit your weekly limit · resets Aug 17, 4am (Europe/Amsterdam)",
          detail: '/upgrade or /usage-credits to finish what you’re working on.',
        },
        rate_limits: { five_hour: { used_pct: 100 }, seven_day: { used_pct: 100 } },
      }),
      entries: release,
      turnAgo: undefined,
      attention: 'session-blocked',
      attentionExpanded: true,
      attentionDetail:
        "You've hit your weekly limit · resets Aug 17, 4am (Europe/Amsterdam) — /upgrade or /usage-credits to finish what you’re working on.",
    },
    {
      id: 'session-paused',
      title: 'Session paused — the consent modal that used to read as a green Idle',
      board: 'the states audit, catalog limit.overage_consent_dialog',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        // `waiting`, from the pty pre-emption — the turn has NOT ended, so no
        // hook will ever say this. Before the fix the same screen read `active`
        // until the safety window lapsed and then `idle` forever.
        status: 'waiting',
        blocked: {
          kind: 'paused',
          dialog: 'overage_consent',
          text: 'Session paused',
        },
      }),
      entries: release,
      turnAgo: undefined,
      dialog: BENCH_DIALOGS.pausedOverage,
      attention: 'session-paused',
      attentionExpanded: true,
      attentionDetail:
        'Continue with Fable 5 on usage credits, or switch models for the rest of this session.',
    },
    {
      id: 'refusal-fallback',
      title: 'Safeguards flagged the prompt — the paused modal, and the replies it withdraws',
      board: 'the states audit, catalog err.refusal_fallback_dialog',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'waiting',
        blocked: {
          kind: 'paused',
          dialog: 'refusal_fallback',
          text: 'Session paused',
        },
      }),
      // The transcript half of the same event: the two replies Claude already
      // streamed are marked WITHDRAWN (still readable — the user saw them) and
      // a tombstone says why. Nothing was removed from the ring.
      entries: retractedTail(nowSec),
      turnAgo: undefined,
      dialog: BENCH_DIALOGS.pausedRefusal,
    },
    {
      id: 'turn-refused',
      title: 'Refused — a dead turn that used to look like a retryable API error',
      board: 'the states audit, catalog err.safeguards_refusal',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        // Idle, and NOT blocked: this session can take another turn — with a
        // different message, or a different model. The composer stays live,
        // which is the whole distinction from a limit block.
        status: 'idle',
      }),
      entries: refusedTail(nowSec),
      turnAgo: undefined,
      attention: 'turn-refused',
      attentionExpanded: true,
      attentionDetail:
        "API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). Double press esc to edit your last message, or try a different model with /model.",
    },
    {
      id: 'stalled',
      title: 'Waiting for the API — the live turn that used to drift to Idle',
      board: 'the states audit, catalog err.stream_stalled',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        // ACTIVE, from the pty pre-emption: the request is out and the stream
        // never started, so nothing prints and every other signal reads the
        // turn as finished.
        status: 'active',
        // The last tool that RAN, deliberately left here: it is what the
        // working row used to show during a stall, and the fix is that the
        // stall's own sentence takes the label.
        activity: '⚡ Read server/src/export/money.rs',
      }),
      entries: release,
      turnAgo: 94,
      stalled: 'Waiting for API response · will retry in 3s · check your network',
    },
    {
      id: 'stop-armed',
      title: 'Stop refused — the terminal has Escape armed for something else',
      board: 'the states audit, catalog generic.armed_keys',
      session: session({
        name: RELEASE_TRAIN,
        display_name: 'Release Train',
        status: 'active',
        activity: '⚡ cargo test',
      }),
      entries: release,
      turnAgo: 30,
      composer: {
        draft: '',
        notice: {
          kind: 'stop-armed',
          detail: 'Esc again to clear · Ctrl+Y to paste deleted text',
        },
      },
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
  'harness',
  'error',
  'offline',
  'patch',
  'pending',
  'p1',
  'p2',
  'p3',
  'attention',
  'attention-inline',
  'stopping',
  'queueing',
  'composing',
  'slash',
  'refused',
  'handoff',
  'handoff-sent',
  'handoff-failed',
  'schedule-draft',
  'panel',
  'dialog-live',
  'answering',
  'plan-approval',
  'dialog-refused',
  'dialog-aborted',
  'question',
  'question-refused',
  'trust-gate',
  'limit-blocked',
  // PTY-07 — the dialog/pty families.
  'session-paused',
  'refusal-fallback',
  'turn-refused',
  'stalled',
  'stop-armed',
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

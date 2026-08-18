/**
 * One confirmed transcript node → primitives (fase A3 T3).
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the whole of the "what does confirmed content look like" question, and
 * nothing else: no fetching, no turn state, no live layer (that is T4). It takes
 * a `TranscriptNode` — an item already shaped by `grouping.ts` — and renders the
 * B0 primitive that node IS, per the fase-A3 plan's item table:
 *
 *   user       `MessageRow me` + `Bubble variant="user"`, its kind as a leading
 *              weight-500 chip (never an emoji)
 *   assistant  `MessageRow` + gutter mark + `Bubble` + prose
 *   receipts   `MessageRow` + gutter mark + `ReceiptGroup`, plus a
 *              `CapturedFrameCard` for any image the run named
 *   teammate   `ArrivalDivider` + `FaceName` — provenance at the point of
 *              arrival — and then the message in the COLLEAGUE's own face
 *   system     a centred `SystemLine` with the named thing as a `SystemEntity`
 *   divider    a centred `SystemLine` carrying the relative clock
 *   harness    a centred `SystemLine` for a row of the audit ledger — what this
 *              session delegated, renamed or scheduled — with the colleague it
 *              went to as a navigable `MentionChip`
 *
 * TWO INJECTED CAPABILITIES, both deliberate:
 *   · `rawUrl` — turning a path into a fetchable URL lives in `filesApi`, which
 *     reaches `@/env`; importing it here would drag the API client (and its
 *     alias) into every unit test that renders a transcript. The panel injects
 *     `filesApi.rawUrl`; a test or the `/dev/chat-live` bench injects its own.
 *   · `pinFor` — identity pins are a roster concept the wire does not carry yet
 *     (see `session-accent.ts`'s §10 TODO). Injecting it keeps the one cast the
 *     design system already has (`dev-marks.cast.ts`) usable from the bench
 *     without this module knowing that the roster exists.
 *
 * Markdown is not IN here (fase A3 T5): `<Prose>` suspends on the lazy
 * `chat-markdown` chunk and renders the raw text at the SAME type metrics while
 * it is in flight, so the swap changes glyph styling and never block height.
 * That fallback is the bubble's own 15/1.45 with `whitespace-pre-wrap`, and the
 * markdown side keeps single newlines as breaks to match it line for line.
 */
import * as React from 'react'

import { SessionMark, type MarkPin } from '../../brand/marks'
import { cn } from '../../lib/utils'

import type { HarnessEvent } from '../../lib/api/harness'

import type { ChatItem } from './entries'
import { harnessNotice } from './entries'
import { framesIn } from './frames'
import { mentionSegments, toReceiptRows, type TranscriptNode } from './grouping'
import {
  clipStateFor,
  CLIP_RETRY_TITLE,
  CLIP_TITLE,
  NO_REQUEST,
  useTruncation,
} from './truncation'
import {
  ArrivalDivider,
  Bubble,
  BUBBLE_MAX,
  CapturedFrameCard,
  CAPTURED_FRAME,
  ClockIcon,
  FaceName,
  MARK_SIZE,
  MentionChip,
  MessageRow,
  ReceiptGroup,
  RECEIPT_DEFAULT_MAX,
  SystemEntity,
  SystemLine,
  SystemSep,
} from './ui'

/**
 * Who the assistant side of the column is, for AT (fase A6 T7.2 — gap G3).
 *
 * Sighted readers get the speaker from the gutter mark and from which side of
 * the column the bubble hangs on; neither survives linearisation. A cross-agent
 * bubble names the colleague instead (the divider above it already does), and a
 * bubble in a RUN says nothing at all — repeating the name on every one of six
 * consecutive paragraphs is the audio equivalent of drawing the face six times,
 * which is exactly what `grouped` exists to prevent on screen.
 */
const AGENT_VOICE = 'Claude'

export interface TranscriptItemProps {
  node: TranscriptNode
  /** The focused session's immutable slug — the gutter mark's seed. */
  name: string
  /** Desktop or phone metrics (bubble ceilings, frame width). */
  surface?: 'desktop' | 'phone'
  /** uuid → wire label: the slash name, the teammate id, the event's subject. */
  labels?: ReadonlyMap<string, string>
  /** Lowercased name → session slug, for mention chips. */
  mentions?: ReadonlyMap<string, string>
  /**
   * Slug → the name that session is CALLED.
   *
   * The wire's teammate envelope carries a slug (`teammate_id="patch"`), and the
   * arrival divider is a sentence a person reads — "Message from ●patch" names
   * a database row, "Message from ●Patch" names a colleague. The mention chips
   * already get this for free (they show the text the agent wrote); the divider
   * has no prose to take it from, so the panel hands the index down.
   */
  names?: ReadonlyMap<string, string>
  /** Absolute path → fetchable URL. Omit and captured frames render B0's
   *  honest warm placeholder. */
  rawUrl?: (path: string) => string
  /** Seed → identity pin, when a roster has assigned one. */
  pinFor?: (seed: string) => MarkPin | undefined
  /**
   * Go to another session. The chip in a harness line ("Delegated to ●x") is a
   * NAVIGATION affordance (master plan §13.1) and this is its destination; omit
   * it and the chip is inert, which is what the bench and the tests render.
   */
  onOpenSession?: (slug: string) => void
  /**
   * Switch this pane to the terminal renderer.
   *
   * Read by exactly one row: the blocked card for a SIGNED-OUT session.
   * `/login` is an OAuth paste flow that exists only in the pty, so that card
   * hands the user to the surface that can complete it rather than drawing a
   * button chat could not honour. Omit it and the card renders without the
   * affordance, which is what every other blocked class gets.
   */
  onOpenTerminal?: () => void
  /**
   * Open the Schedules sheet for this session (fase B4 T8), scrolled to one
   * schedule when the ledger row knows its id.
   *
   * A REF RATHER THAN A STRING because the two things the chip can know are not
   * interchangeable: `target` is the schedule id on every row written since the
   * spine, but rows written before it carry only a title, and a sheet handed a
   * title cannot scroll to a row it has no id for. Passing both lets the
   * receiver degrade to "open the list" instead of guessing which one it got.
   * Omit and the schedule entity is plain emphasis, never a dead affordance.
   */
  onOpenSchedule?: (ref: ScheduleRef) => void
}

/** What a schedule chip knows about the schedule it names. Both fields optional —
 *  see `TranscriptItemProps.onOpenSchedule`. */
export interface ScheduleRef {
  id?: string
  title?: string
}

const EMPTY_INDEX: ReadonlyMap<string, string> = new Map()

/** The centred word for a harness event, by wire kind. */
const SYSTEM_WORD: Record<string, string> = {
  system: 'System event',
  notification: 'Notification',
  tool: 'Tool run',
  image: 'Image',
  // The states audit's four. Each names the CONSEQUENCE rather than the wire
  // subtype: a line reading "model_refusal_fallback" tells the reader nothing
  // they can act on, and "Conversation compacted" is the answer to "why does
  // the history above this look amputated".
  compaction: 'Conversation compacted',
  'model-switch': 'Model switched',
  'api-retry': 'API error',
  dialog: 'Waiting on a dialog',
  // PTY-07. `stalled` says what is true — the request is out and the turn is
  // still live — rather than "API error", which is what the same wire subtype
  // means in every other case. `retracted` names the cause, because "2 replies
  // withdrawn" with no reason reads as a bug in this app.
  stalled: 'Waiting for the API',
  retracted: 'Withdrawn',
}

/**
 * MEMOISED, and it is load-bearing (A4 review).
 *
 * A4 made the composer live, and its draft is a `useSyncExternalStore`
 * subscription held by `chat-panel.tsx` — so every keystroke re-renders the
 * panel, the conversation, and with it every row of the transcript. Nothing on
 * that path was memoised, and `react-markdown` re-runs its whole unified
 * pipeline on each render: measured on this box at ~1.2ms per ordinary
 * assistant bubble (SSR, i.e. a floor — a client render adds reconciliation and
 * DOM work). An afternoon's session of ~50 messages therefore paid ~60ms of
 * main-thread work per keystroke, and the caret visibly lagged the keyboard.
 *
 * The boundary works because every prop here is already stable across a
 * keystroke: `node` comes out of `buildTranscript`'s `useMemo`, the three
 * indexes are `useMemo`d in the panel, `rawUrl`/`pinFor` are module-level, and
 * `nowMs` is bucketed to 30s (`chat-panel.tsx`) so the transcript reshapes twice
 * a minute rather than once a second. A prop that starts changing per render is
 * what would silently undo this — hence the test in `chat-interactive`.
 */
export const TranscriptItem = React.memo(function TranscriptItem(
  props: TranscriptItemProps,
) {
  const { node } = props
  if (node.kind === 'divider') return <SystemLine>{node.label}</SystemLine>
  if (node.kind === 'harness') {
    return (
      <HarnessLine
        ev={node.ev}
        names={props.names}
        pinFor={props.pinFor}
        onOpenSession={props.onOpenSession}
        onOpenSchedule={props.onOpenSchedule}
      />
    )
  }

  const { item, speaker, grouped, showGutter, sender } = node
  // Before the system arm: a blocked banner is a CARD, not a centred line, and
  // it is the one row on this surface that must be impossible to mistake for
  // Claude talking.
  if (item.type === 'blocked')
    return <BlockedRow item={item} onOpenTerminal={props.onOpenTerminal} />
  if (speaker === 'system') return <SystemRow item={item} labels={props.labels} />
  if (speaker === 'me') return <UserRow {...props} item={item} grouped={grouped} />
  if (sender !== undefined || speaker.startsWith('teammate:')) {
    return <TeammateRow {...props} item={item} grouped={grouped} sender={sender ?? ''} />
  }
  if (speaker.startsWith('schedule:')) {
    return (
      <ScheduleRow
        {...props}
        item={item}
        grouped={grouped}
        title={speaker.slice('schedule:'.length)}
      />
    )
  }
  return (
    <AgentRow
      {...props}
      item={item}
      grouped={grouped}
      gutter={showGutter ? props.name : undefined}
    />
  )
})

/* ── the human ───────────────────────────────────────────────────────────── */

function UserRow({
  item,
  grouped,
  surface,
  labels,
}: TranscriptItemProps & { item: ChatItem; grouped: boolean }) {
  if (item.type !== 'user') return null
  // The kind, as a word. A slash command shows the command it ran; everything
  // else shows its kind. Weight, not colour, and never an emoji: the emoji
  // taxonomy is terminal/tile-only (master plan §4.2 P3).
  //
  // The wire label for a command is the slash name WITH its slash (`/clear` —
  // `recall.rs::classify_by_wrapper` takes `<command-name>` verbatim) and the
  // entry's text opens with that same name plus its args (`/clear`,
  // `/code-review high`). So the chip is the label as it stands, and the body is
  // what the command was given — otherwise the bubble reads `//clear /clear`.
  const command = commandChip(item.badge, labels?.get(item.uuid))
  const chip = command ?? item.badge
  const text =
    command && item.text.startsWith(command) ? item.text.slice(command.length).trimStart() : item.text
  return (
    <MessageRow me grouped={grouped}>
      <Bubble variant="user" surface={surface} author={grouped ? undefined : 'You'}>
        {chip && (
          <span className={cn('font-medium tracking-[-0.1px] opacity-70', text && 'mr-1.5')}>
            {chip}
          </span>
        )}
        {text && <span className="whitespace-pre-wrap break-words">{text}</span>}
        {item.truncated && <ClippedMarker uuid={item.uuid} />}
      </Bubble>
    </MessageRow>
  )
}

/** `/clear` from whatever the wire called the slash name, or nothing. */
function commandChip(badge: string | undefined, label: string | undefined): string | undefined {
  if (badge !== 'command') return undefined
  const name = label?.trim()
  if (!name) return undefined
  return name.startsWith('/') ? name : `/${name}`
}

/* ── this session ────────────────────────────────────────────────────────── */

function AgentRow({
  item,
  grouped,
  gutter,
  ...rest
}: TranscriptItemProps & { item: ChatItem; grouped: boolean; gutter?: string }) {
  const mark = gutter ? <Mark seed={gutter} pinFor={rest.pinFor} /> : undefined
  if (item.type === 'thinking') {
    return (
      <MessageRow grouped={grouped} gutter={mark}>
        <ThinkingDisclosure item={item} surface={rest.surface} />
      </MessageRow>
    )
  }
  if (item.type === 'receipts') {
    return (
      <MessageRow grouped={grouped} gutter={mark}>
        <Receipts item={item} surface={rest.surface} rawUrl={rest.rawUrl} />
      </MessageRow>
    )
  }
  if (item.type !== 'assistant') return null
  return (
    <MessageRow grouped={grouped} gutter={mark}>
      <Bubble surface={rest.surface} author={grouped ? undefined : AGENT_VOICE}>
        {/* WITHDRAWN, NOT DELETED (catalog `err.refusal_fallback_dialog`).
            Claude Code retracted this reply — the prompt it came from was
            flagged, and the model will not act on it any more. The words stay on
            screen because the user READ them and a transcript that quietly
            removes what somebody read is lying about what happened; what changes
            is that they stop reading as live. Dimmed, captioned, and marked in
            the DOM so the e2e can prove it. */}
        {item.retracted && (
          <p
            data-testid="chat-retracted"
            className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3"
          >
            Withdrawn by Claude Code
          </p>
        )}
        <div className={item.retracted ? 'opacity-55' : undefined}>
          <Prose
            text={item.text}
            self={rest.name}
            mentions={rest.mentions}
            pinFor={rest.pinFor}
            surface={rest.surface}
            rawUrl={rest.rawUrl}
            onOpenSession={rest.onOpenSession}
          />
          {item.truncated && <ClippedMarker uuid={item.uuid} />}
        </div>
      </Bubble>
    </MessageRow>
  )
}

/**
 * THE MODEL'S REASONING, COLLAPSED (A6 register S21 — the P7 disclosure).
 *
 * Until now `wire-entries.ts` ended its dispatch by dropping `kind:'thinking'`
 * on the floor — "not part of the A1 calm view" — while the register went on
 * listing the disclosure as a shipped scenario, and an extended-thinking model's
 * entire reasoning phase was thrown away by the surface the user was reading.
 *
 * A native `<details>`, not a `useState` toggle: it is the one control on this
 * surface whose whole job is show/hide, the browser already gives it the right
 * role, keyboard behaviour and AT announcement for free, and it costs no
 * re-render of a memoised transcript row to open. Collapsed by default, because
 * the calm view is the promise — the row is one line high until somebody asks.
 *
 * The clock is honest or absent: a thinking block is written when it is
 * COMPLETE, so the gap from the row above it is what the model spent (see
 * `entries.ts::toDisplayList`). With no row above to measure from, the summary
 * says "Thought" and claims nothing.
 */
function ThinkingDisclosure({
  item,
  surface,
}: {
  item: ChatItem
  surface?: 'desktop' | 'phone'
}) {
  if (item.type !== 'thinking') return null
  const label = item.secs ? `Thought for ${item.secs}s` : 'Thought'
  return (
    <details
      className="group min-w-0"
      style={{ maxWidth: surface === 'phone' ? BUBBLE_MAX.phoneAssistant : BUBBLE_MAX.assistant }}
      data-testid="chat-thinking"
    >
      <summary className="chat-thinking-summary">
        <span aria-hidden className="inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        {label}
      </summary>
      <p className="chat-thinking-body">
        {/* AN EMPTY BLOCK IS STILL A FACT. Claude Code writes the thinking entry
            with an empty `thinking` field on every model this app has seen
            (2.1.233: 20,831 blocks, none with text), so the summary above — a
            reasoning phase happened, and for how long — is the whole of what the
            transcript preserved. Saying that out loud beats a blank disclosure,
            and beats the row not existing at all. */}
        {item.text || 'The model’s reasoning was not saved to this transcript.'}
        {item.truncated && <ClippedMarker uuid={item.uuid} />}
      </p>
    </details>
  )
}

/**
 * The server clipped this message at the wire cap (`ASSISTANT_MAX_CHARS` /
 * `PROMPT_MAX_CHARS`, #59). Say so — a clipped message that just stops reads as
 * an answer that ended mid-sentence, and the reader has no way to tell the
 * difference.
 *
 * No colour of its own: this marker renders inside BOTH bubble variants, and
 * the user bubble flips light-on-dark in dark mode, so it borrows the bubble's
 * own ink and steps back with opacity instead (the A3 rule — the surface
 * hard-codes no colours).
 *
 * A3 note: the marker is the whole of the degradation. The client does not yet
 * re-fetch the full text when the flag is set (that endpoint is fase A4's) —
 * the message renders complete up to the cap, flagged, and the terminal view
 * remains the escape hatch the tooltip points at.
 */
function ClippedMarker({ uuid }: { uuid: string }) {
  const seam = useTruncation()
  const state = clipStateFor(uuid, seam)
  const cls = 'ml-1 select-none align-baseline text-[12px] opacity-60'

  // No provider (the benches, the unit tests) ⇒ no request to make ⇒ the A3
  // marker, unchanged. A dead button is worse than an honest label.
  if (seam.request === NO_REQUEST) {
    return (
      <span className={cls} title={CLIP_TITLE}>
        … clipped
      </span>
    )
  }

  if (state === 'loading') {
    return (
      <span className={cls} aria-live="polite">
        … loading the rest
      </span>
    )
  }

  // The failure KEEPS the condensed text and offers the request again. The
  // socket's own rule (one automatic attempt, never retried) is untouched —
  // what changes is that it stops meaning "unreachable forever".
  return (
    <button
      type="button"
      className={cn(cls, 'underline decoration-dotted underline-offset-2')}
      onClick={() => seam.request(uuid)}
      title={state === 'failed' ? CLIP_RETRY_TITLE : CLIP_TITLE}
    >
      {state === 'failed' ? '… clipped — try again' : '… clipped — show the rest'}
    </button>
  )
}

/* ── a colleague ─────────────────────────────────────────────────────────── */

/**
 * The receiving end of a delegation (master plan §13.2): who this arrived from,
 * said once above the message, in the sender's own colour. The divider only
 * appears at the START of a colleague's run — a five-message handover announces
 * itself once, not five times.
 */
function TeammateRow({
  item,
  grouped,
  sender,
  ...rest
}: TranscriptItemProps & { item: ChatItem; grouped: boolean; sender: string }) {
  if (item.type !== 'user') return null
  const seed = sender || item.uuid
  return (
    <>
      {!grouped && (
        <ArrivalDivider>
          <span>Message from</span>
          {sender ? (
            <FaceName
              seed={sender}
              pin={rest.pinFor?.(sender)}
              name={rest.names?.get(sender)}
            />
          ) : (
            <span>a teammate</span>
          )}
        </ArrivalDivider>
      )}
      <MessageRow
        grouped={grouped}
        gutter={!grouped && sender ? <Mark seed={seed} pinFor={rest.pinFor} /> : undefined}
      >
        <Bubble surface={rest.surface} author={grouped ? undefined : rest.names?.get(sender ?? '') ?? AGENT_VOICE}>
          <Prose
            text={item.text}
            self={sender}
            mentions={rest.mentions}
            pinFor={rest.pinFor}
            surface={rest.surface}
            rawUrl={rest.rawUrl}
            onOpenSession={rest.onOpenSession}
          />
          {item.truncated && <ClippedMarker uuid={item.uuid} />}
        </Bubble>
      </MessageRow>
    </>
  )
}

/* ── a schedule ──────────────────────────────────────────────────────────── */

/**
 * A schedule fired this (master plan §13.3): which schedule, said once above the
 * prompt, in the same arrival grammar a colleague gets.
 *
 * The schedule is the SPEAKER, not a hat on the owner's bubble — a 03:00 prompt
 * with the owner's face on it is the transcript telling a lie about who was
 * awake. There is no mark in the gutter because a schedule has no identity mark
 * to hang: a monochrome `ClockIcon` (the surface's own icon set — the raw `⏱`
 * codepoint tofu'd, not being in the bundled font) plus the title carries it,
 * and the divider is where that belongs anyway.
 *
 * The prompt text arrives already stripped of the machine-generated confirm
 * footer (`recall.rs::strip_confirm_footer`), so the multi-line curl block that
 * used to land in chat is gone before it ever reaches this component.
 */
function ScheduleRow({
  item,
  grouped,
  title,
  ...rest
}: TranscriptItemProps & { item: ChatItem; grouped: boolean; title: string }) {
  if (item.type !== 'user') return null
  return (
    <>
      {!grouped && (
        <ArrivalDivider>
          {title ? (
            <>
              <span>Sent by schedule</span>
              <span className="font-medium text-ink">
                <ClockIcon className="mr-1 inline-block align-[-2px]" />
                {title}
              </span>
            </>
          ) : (
            <span>Sent by a schedule</span>
          )}
        </ArrivalDivider>
      )}
      <MessageRow grouped={grouped}>
        <Bubble surface={rest.surface} author={grouped ? undefined : AGENT_VOICE}>
          <Prose
            text={item.text}
            self={rest.name}
            mentions={rest.mentions}
            pinFor={rest.pinFor}
            surface={rest.surface}
            rawUrl={rest.rawUrl}
            onOpenSession={rest.onOpenSession}
          />
          {item.truncated && <ClippedMarker uuid={item.uuid} />}
        </Bubble>
      </MessageRow>
    </>
  )
}

/* ── the blocked agent ───────────────────────────────────────────────────── */

/**
 * The amber card for a session that cannot work.
 *
 * Full width and centred, deliberately NOT a bubble: the whole defect this
 * fixes is that a five-hour outage arrived as ordinary Claude speech, pixel-
 * identical to "You chose Apple!". Three parts, in the order a reader needs
 * them: WHICH limit (the chip), WHAT Claude said (verbatim — CC's own sentence
 * already names the remedy, `/model` or `/usage-credits`), and WHEN it comes
 * back (the reset clause, when the bucket has one).
 *
 * `--status-error` is the app's calm orange, the same token the tile's error
 * badge uses — never an alarmist red, and never a colour this surface invents
 * for one row.
 */
function BlockedRow({
  item,
  onOpenTerminal,
}: {
  item: ChatItem
  onOpenTerminal?: () => void
}) {
  if (item.type !== 'blocked') return null
  // A signed-out session is the one blocked state chat can NEVER resolve:
  // `/login` opens an OAuth paste flow that only exists in the pty. So the card
  // offers the surface that can do it rather than a button that would lie.
  const signIn = item.label === 'Signed out' && onOpenTerminal
  return (
    <div className="my-2 flex justify-center px-2">
      <div
        role="status"
        data-testid="chat-blocked"
        data-label={item.label}
        className="w-full max-w-[560px] rounded-2xl border border-status-error/25 bg-status-error/10 px-4 py-3"
      >
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-status-error">
          <span aria-hidden>⚠</span>
          {item.label ?? 'Blocked'}
        </p>
        <p className="mt-1 whitespace-pre-wrap text-[14px] leading-[1.45] text-ink">{item.text}</p>
        {item.detail && (
          <p className="mt-1.5 text-[12.5px] tabular-nums text-ink-3">{item.detail}</p>
        )}
        {signIn && (
          <button
            type="button"
            data-testid="chat-blocked-signin"
            onClick={onOpenTerminal}
            className="mt-2 inline-flex h-9 items-center rounded-full bg-status-error/15 px-3 text-[13px] font-medium text-status-error hover:bg-status-error/25"
          >
            Sign in from the terminal
          </button>
        )}
      </div>
    </div>
  )
}

/* ── the harness ─────────────────────────────────────────────────────────── */

function SystemRow({
  item,
  labels,
}: {
  item: ChatItem
  labels?: ReadonlyMap<string, string>
}) {
  if (item.type !== 'user') return null
  // Claude's own bracketed notice ("[Request interrupted by user …]") is already
  // a whole sentence about what happened, so it is printed as one — no
  // `System event ·` lead-in, and without the brackets, which are wire syntax
  // rather than anything a reader needs.
  const notice = harnessNotice(item.text)
  if (notice) return <SystemLine>{notice}</SystemLine>
  // The payload is the named thing; the wire `label` is only the wrapper tag the
  // classifier recognised, so it stands in when the event carries no text of its
  // own rather than leading the line with `local-command-stdout`.
  const subject = item.text.trim() || labels?.get(item.uuid) || ''
  const word = SYSTEM_WORD[item.badge ?? ''] ?? 'System event'
  const detail = item.detail?.trim()
  return (
    <SystemLine>
      {word}
      {subject && (
        <>
          <SystemSep />
          <SystemEntity>{subject.length > 72 ? `${subject.slice(0, 72)}…` : subject}</SystemEntity>
        </>
      )}
      {/* THE SOURCE'S OWN WORDS, UNDER THIS APP'S. The grace-window row is
          written in supermux's voice ("Claude Code asked the agent to wrap up")
          and Claude Code's verbatim instruction — the evidence that the agent's
          sudden change of behaviour is not a bug in this app — was carried on
          the wire and dropped before the renderer. It goes UNDER the summary
          rather than on a hover title: a fact that only exists on hover does not
          exist on a phone, and this one is why the turn is behaving oddly. */}
      {detail && (
        <span
          data-testid="chat-system-detail"
          className="mt-[3px] block text-[12.2px] leading-[1.45] text-ink-3"
        >
          {stripBrackets(detail)}
        </span>
      )}
    </SystemLine>
  )
}

/** `[Usage limit reached — grace window active. …]` → the sentence inside. The
 *  brackets are Claude Code's injection syntax, not something a reader needs. */
function stripBrackets(s: string): string {
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1).trim() : s
}

/* ── the ledger ──────────────────────────────────────────────────────────── */

export interface HarnessLineProps {
  ev: HarnessEvent
  /** Slug → what that session is CALLED (the chip shows a colleague, not a row). */
  names?: ReadonlyMap<string, string>
  pinFor?: (seed: string) => MarkPin | undefined
  onOpenSession?: (slug: string) => void
  onOpenSchedule?: (ref: ScheduleRef) => void
}

/**
 * One row of the harness ledger, as a centred sentence.
 *
 * This is the transcript becoming a MANAGEMENT LOG: what this session set in
 * motion and what the harness did to it, in the place where it happened, and
 * surviving a reload because it is read from `audit_log` rather than from a
 * live frame (`lib/api/harness.ts`).
 *
 * Four sentences, one per surfaced action. There is deliberately no default
 * branch: `grouping.ts` drops any action this file has no copy for, so an
 * unworded event ships dark instead of printing "System event ·" over a blob of
 * JSON. A monochrome `ClockIcon` marks the schedule (the surface's own icon set,
 * `currentColor` — the raw `⏱` codepoint is not in the bundled font and tofu'd),
 * for the same reason the scheduler's own chips carry a clock — a schedule has
 * no identity mark.
 */
export function HarnessLine({ ev, names, pinFor, onOpenSession, onOpenSchedule }: HarnessLineProps) {
  if (ev.action === 'session.delegate') {
    // `target` is the session this went TO; the seed is always the slug, so
    // this chip and that session's face are the same pigment.
    const to = ev.target
    return (
      <SystemLine>
        Delegated to{' '}
        <MentionChip
          seed={to}
          pin={pinFor?.(to)}
          name={names?.get(to)}
          onClick={onOpenSession ? () => onOpenSession(to) : undefined}
        />
      </SystemLine>
    )
  }
  if (ev.action === 'session.rename') {
    // Only a session renaming ITSELF reaches here (`grouping.ts` suppresses the
    // owner's own renames), so the subject of the sentence is the session.
    const to = typeof ev.detail.to === 'string' ? ev.detail.to : ''
    if (!to) return null
    return (
      <SystemLine>
        Renamed itself to <SystemEntity>{to}</SystemEntity>
      </SystemLine>
    )
  }
  const created = ev.action === 'schedule.create'
  // A failed fire is management log, not a toast: the same sentence, in the
  // calm-orange status ink. Never a red bubble, never a banner.
  const failed = !created && typeof ev.detail.status === 'string' && ev.detail.status !== 'ok'
  const title = typeof ev.detail.title === 'string' ? ev.detail.title.trim() : ''
  return (
    <SystemLine className={failed ? 'text-status-error-ink' : undefined}>
      {created ? 'Created schedule' : 'Ran schedule'}
      {title && (
        <>
          <SystemSep />
          {/* The chip's destination is T8's per-session Schedules sheet. It is
              a PROP rather than a route so this file stays route-free — and so
              a surface with nowhere to send it (the bench, a static render)
              degrades to plain emphasis rather than offering a dead
              affordance. `ev.target` is the schedule id on every row the spine
              wrote; older rows have only the title, and the receiver opens the
              list for those. */}
          <SystemEntity
            onClick={
              onOpenSchedule
                ? () => onOpenSchedule({ id: ev.target || undefined, title })
                : undefined
            }
          >
            <ClockIcon className="mr-1 inline-block align-[-2px]" />
            {title}
          </SystemEntity>
        </>
      )}
    </SystemLine>
  )
}

/* ── pieces ──────────────────────────────────────────────────────────────── */

function Mark({
  seed,
  pinFor,
}: {
  seed: string
  pinFor?: (seed: string) => MarkPin | undefined
}) {
  return <SessionMark seed={seed} pin={pinFor?.(seed)} size={MARK_SIZE.gutter} label={null} />
}

/**
 * The markdown renderer, behind the one lazy boundary in this surface.
 *
 * `chat-markdown.tsx` is the only module that imports `react-markdown`, and this
 * is the only edge that reaches it — a plain import would pull the whole
 * unified/remark/rehype/lowlight stack into the hero chunk (~40 KB gz), which is
 * exactly the tripwire the A3 budget watches. Guarded by an import-graph test in
 * `tests/unit/chat-surface.test.tsx`.
 */
const ChatMarkdown = React.lazy(() => import('./markdown/chat-markdown'))

interface ProseProps {
  text: string
  self?: string
  mentions?: ReadonlyMap<string, string>
  pinFor?: (seed: string) => MarkPin | undefined
  surface?: 'desktop' | 'phone'
  rawUrl?: (path: string) => string
  /** A mention in prose is a destination too (fase B4 T3.3). What counts as a
   *  mention is still `mentionSegments`' decision — the index, never a regex
   *  over arbitrary words; this only decides what a click does. */
  onOpenSession?: (slug: string) => void
}

/**
 * Assistant prose: the raw text now, the typeset text a chunk later.
 *
 * The `Suspense` boundary is PER BUBBLE, and its fallback is not a spinner but
 * the message itself — same bubble, same 15/1.45, same line breaks, only
 * unstyled. So a transcript that mounts before the markdown chunk lands is
 * readable and correctly sized, and when the chunk arrives the swap restyles
 * glyphs inside a box that has not moved (plan §T5.3; the risk it mitigates is
 * §4.2, "markdown re-layout jump").
 */
function Prose(props: ProseProps) {
  return (
    <React.Suspense fallback={<ProseText {...props} />}>
      <ChatMarkdown
        text={props.text}
        self={props.self}
        mentions={props.mentions}
        pinFor={props.pinFor}
        surface={props.surface}
        rawUrl={props.rawUrl}
        onOpenSession={props.onOpenSession}
      />
    </React.Suspense>
  )
}

/**
 * The same prose without markdown — the fallback, and the whole of what a
 * static render (`renderToStaticMarkup`, the unit tests) produces. Mention chips
 * run here too: a colleague's name is a fact about the message, not a styling of
 * it, so it must not appear only once a chunk has loaded.
 */
export function ProseText({ text, mentions, self, pinFor, onOpenSession }: ProseProps) {
  const segments = React.useMemo(
    () => mentionSegments(text, mentions ?? EMPTY_INDEX, self),
    [text, mentions, self],
  )
  return (
    <span className="whitespace-pre-wrap break-words">
      {segments.map((segment, i) =>
        'text' in segment ? (
          <React.Fragment key={i}>{segment.text}</React.Fragment>
        ) : (
          <MentionChip
            key={i}
            seed={segment.seed}
            pin={pinFor?.(segment.seed)}
            name={segment.label}
            // Every segment that is not `text` already RESOLVED in the index —
            // that is what made it a chip — so there is no second liveness test
            // to make here. Without a handler it renders as a span.
            onClick={onOpenSession ? () => onOpenSession(segment.seed) : undefined}
          />
        ),
      )}
    </span>
  )
}

/**
 * A confirmed tool run: the checklist, what it produced, and an honest note when
 * the tail itself dropped lines.
 *
 * `RECEIPT_CAP = 30` (A1, frozen) is the DATA cap — anything past it never
 * reached the client and `overflow` counts it. `RECEIPT_DEFAULT_MAX` is the
 * PRESENTATION cap, expanded in place by "Show all N" with no refetch, because
 * everything it hides is already here.
 */
function Receipts({
  item,
  surface,
  rawUrl,
}: {
  item: ChatItem
  surface?: 'desktop' | 'phone'
  rawUrl?: (path: string) => string
}) {
  const [expanded, setExpanded] = React.useState(false)
  if (item.type !== 'receipts') return null
  const rows = toReceiptRows(item.lines)
  const frames = framesIn(item.lines)
  const width = surface === 'phone' ? BUBBLE_MAX.phoneAssistant : CAPTURED_FRAME.width
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <ReceiptGroup
        rows={rows}
        surface={surface}
        max={expanded ? undefined : RECEIPT_DEFAULT_MAX}
        onShowAll={() => setExpanded(true)}
      />
      {item.overflow > 0 && (
        // Not a "show all" — these lines are not in the tail at all. Saying so
        // is the difference between a cap and a silent truncation.
        <p className="mt-[7px] text-[12.6px] tracking-[-0.05px] text-ink-2">
          +{item.overflow} more tool calls in this run
        </p>
      )}
      {/* In a bubble, as the approved board draws it: the frame is something the
          session is SHOWING you, so it sits on the same warm card its prose
          does — a bare frame floating in the column reads as chrome. */}
      {frames.map((frame, i) => (
        <Bubble key={`${frame.caption}-${i}`} surface={surface}>
          <CapturedFrameCard
            caption={frame.caption}
            src={frame.path && rawUrl ? rawUrl(frame.path) : undefined}
            width={width}
          />
        </Bubble>
      ))}
    </div>
  )
}

export default TranscriptItem

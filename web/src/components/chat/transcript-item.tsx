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
 * Markdown is NOT here. T5 replaces `<Prose>`'s body with the lazy
 * `chat-markdown` chunk at the SAME type metrics, so the swap changes glyph
 * styling and never block height — which is the whole reason the fallback below
 * uses the bubble's own 15/1.45 and `whitespace-pre-wrap`.
 */
import * as React from 'react'

import { SessionMark, type MarkPin } from '../../brand/marks'
import { cn } from '../../lib/utils'

import type { ChatItem } from './entries'
import { framesIn } from './frames'
import { mentionSegments, toReceiptRows, type TranscriptNode } from './grouping'
import {
  ArrivalDivider,
  Bubble,
  BUBBLE_MAX,
  CapturedFrameCard,
  CAPTURED_FRAME,
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
  /** Absolute path → fetchable URL. Omit and captured frames render B0's
   *  honest warm placeholder. */
  rawUrl?: (path: string) => string
  /** Seed → identity pin, when a roster has assigned one. */
  pinFor?: (seed: string) => MarkPin | undefined
}

const EMPTY_INDEX: ReadonlyMap<string, string> = new Map()

/** The centred word for a harness event, by wire kind. */
const SYSTEM_WORD: Record<string, string> = {
  system: 'System event',
  notification: 'Notification',
  tool: 'Tool run',
  image: 'Image',
}

export function TranscriptItem(props: TranscriptItemProps) {
  const { node } = props
  if (node.kind === 'divider') return <SystemLine>{node.label}</SystemLine>

  const { item, speaker, grouped, showGutter, sender } = node
  if (speaker === 'system') return <SystemRow item={item} labels={props.labels} />
  if (speaker === 'me') return <UserRow {...props} item={item} grouped={grouped} />
  if (sender !== undefined || speaker.startsWith('teammate:')) {
    return <TeammateRow {...props} item={item} grouped={grouped} sender={sender ?? ''} />
  }
  return (
    <AgentRow
      {...props}
      item={item}
      grouped={grouped}
      gutter={showGutter ? props.name : undefined}
    />
  )
}

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
      <Bubble variant="user" surface={surface}>
        {chip && (
          <span className={cn('font-medium tracking-[-0.1px] opacity-70', text && 'mr-1.5')}>
            {chip}
          </span>
        )}
        {text && <span className="whitespace-pre-wrap break-words">{text}</span>}
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
      <Bubble surface={rest.surface}>
        <Prose
          text={item.text}
          self={rest.name}
          mentions={rest.mentions}
          pinFor={rest.pinFor}
        />
      </Bubble>
    </MessageRow>
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
          {sender ? <FaceName seed={sender} pin={rest.pinFor?.(sender)} /> : <span>a teammate</span>}
        </ArrivalDivider>
      )}
      <MessageRow
        grouped={grouped}
        gutter={!grouped && sender ? <Mark seed={seed} pinFor={rest.pinFor} /> : undefined}
      >
        <Bubble surface={rest.surface}>
          <Prose text={item.text} self={sender} mentions={rest.mentions} pinFor={rest.pinFor} />
        </Bubble>
      </MessageRow>
    </>
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
  // The payload is the named thing; the wire `label` is only the wrapper tag the
  // classifier recognised, so it stands in when the event carries no text of its
  // own rather than leading the line with `local-command-stdout`.
  const subject = item.text.trim() || labels?.get(item.uuid) || ''
  const word = SYSTEM_WORD[item.badge ?? ''] ?? 'System event'
  return (
    <SystemLine>
      {word}
      {subject && (
        <>
          <SystemSep />
          <SystemEntity>{subject.length > 72 ? `${subject.slice(0, 72)}…` : subject}</SystemEntity>
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
 * Assistant prose, with mention chips.
 *
 * The T5 lazy-markdown swap happens INSIDE this component, at these metrics —
 * the bubble's own 15/1.45 — so the chunk landing restyles glyphs without moving
 * a single block edge. `mentionSegments` is shared with T5's component map,
 * which applies the same pass at the text-node level.
 */
function Prose({
  text,
  mentions,
  self,
  pinFor,
}: {
  text: string
  self?: string
  mentions?: ReadonlyMap<string, string>
  pinFor?: (seed: string) => MarkPin | undefined
}) {
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

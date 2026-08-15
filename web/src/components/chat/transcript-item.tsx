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
 * Markdown is not IN here (fase A3 T5): `<Prose>` suspends on the lazy
 * `chat-markdown` chunk and renders the raw text at the SAME type metrics while
 * it is in flight, so the swap changes glyph styling and never block height.
 * That fallback is the bubble's own 15/1.45 with `whitespace-pre-wrap`, and the
 * markdown side keeps single newlines as breaks to match it line for line.
 */
import * as React from 'react'

import { SessionMark, type MarkPin } from '../../brand/marks'
import { cn } from '../../lib/utils'

import type { ChatItem } from './entries'
import { harnessNotice } from './entries'
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
}

const EMPTY_INDEX: ReadonlyMap<string, string> = new Map()

/** The centred word for a harness event, by wire kind. */
const SYSTEM_WORD: Record<string, string> = {
  system: 'System event',
  notification: 'Notification',
  tool: 'Tool run',
  image: 'Image',
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
      <Bubble variant="user" surface={surface}>
        {chip && (
          <span className={cn('font-medium tracking-[-0.1px] opacity-70', text && 'mr-1.5')}>
            {chip}
          </span>
        )}
        {text && <span className="whitespace-pre-wrap break-words">{text}</span>}
        {item.truncated && <ClippedMarker />}
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
          surface={rest.surface}
          rawUrl={rest.rawUrl}
        />
        {item.truncated && <ClippedMarker />}
      </Bubble>
    </MessageRow>
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
function ClippedMarker() {
  return (
    <span
      className="ml-1 select-none align-baseline text-[12px] opacity-60"
      title="This message was clipped for transport — open the Terminal view for the full text."
    >
      … clipped
    </span>
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
        <Bubble surface={rest.surface}>
          <Prose
            text={item.text}
            self={sender}
            mentions={rest.mentions}
            pinFor={rest.pinFor}
            surface={rest.surface}
            rawUrl={rest.rawUrl}
          />
          {item.truncated && <ClippedMarker />}
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
export function ProseText({ text, mentions, self, pinFor }: ProseProps) {
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

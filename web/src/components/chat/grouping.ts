/**
 * The transcript's shaping layer (fase A3 T3) — pure, DOM-free, testable.
 * ─────────────────────────────────────────────────────────────────────────────
 * `entries.ts` (fase A1, frozen) decides WHAT is true: which wire entries become
 * user turns, assistant prose and collapsed receipt blocks. This module decides
 * how that truth is ARRANGED on the page, and nothing else — it renders nothing,
 * fetches nothing and holds no state, so every rule below can be asserted in
 * `bun test` without a DOM (`tests/unit/chat-grouping.test.ts`).
 *
 * Four rules live here, all of them from the master plan:
 *
 *   · RECEIPTS-FIRST (§4.2) — when a flush batch lands, its tool receipts render
 *     before its closing prose. Deliberately implemented as a TIE-BREAK inside
 *     one second, not as a sort: prose written *before* the tools ran must keep
 *     its place, or the turn reads as nonsense.
 *   · RUN GRAMMAR (§4.2 P2) — consecutive turns by one speaker stack at 8px and
 *     only the first row carries the 28px mark.
 *   · SESSION BLOCKS (§5.3) — a centred relative-time divider where the
 *     conversation was put down and picked up again. The label is recomputed on
 *     the existing 1s live-layer ticker; this module owns no interval.
 *   · MENTION CHIPS (§13.1) — a name in prose becomes a chip only when it is a
 *     session that actually exists. There is no regex over arbitrary words: the
 *     pattern is built FROM the known names, so an unknown noun can never be
 *     turned into a colleague.
 *   · THE MANAGEMENT LOG (§13.2/13.3) — the harness's own ledger rows (this
 *     session delegated, renamed itself, made or ran a schedule) are merged
 *     into the SAME ts-ordered stream as the messages, so what the session set
 *     in motion reads where it happened. Which rows qualify is decided here
 *     (`shownHarnessEvents`) and nowhere else; what they SAY is
 *     `transcript-item.tsx`.
 *
 * Also here, for want of a better home, are the two small mappings that turn a
 * frozen A1 shape into a B0 primitive's props (`toReceiptRows`, `entryLabels`).
 * They are presentation decisions about frozen data, which is precisely what
 * this file is for.
 *
 * Import rules: relative paths only (the unit runner reads no `paths` aliases),
 * and `components/chat/*` may import from `components/chat/ui`, never the
 * reverse.
 */
import type { HarnessEvent } from '../../lib/api/harness'

import type { ChatEntry, ChatItem, ReceiptLine } from './entries'
import { harnessNotice, stripEmojiPrefix } from './entries'
import type { Receipt } from './ui/receipt-group'

/* ── speakers ────────────────────────────────────────────────────────────── */

/**
 * The run key. Three fixed voices plus one per colleague and one per schedule:
 *
 *   `agent`         this session — assistant prose and its receipts
 *   `me`            the human — typed prompts and slash commands
 *   `teammate:<id>` another session, routed in through the teammate envelope
 *                   or handed over by `agents/delegate.rs`
 *   `schedule:<t>`  one of this session's schedules, firing its prompt
 *   `system`        harness events; a centred line, not a bubble
 *
 * A colleague is its OWN voice on purpose. On the wire a teammate message is
 * user-role, so a naive two-voice grammar would stack `●Patch`'s message into
 * the human's run and hang the human's silence on it.
 *
 * A schedule is a voice for the same reason, and it is the honest third option:
 * a scheduled prompt is neither a system event (it is a real request, and it
 * gets a real answer) nor the owner's own bubble (nobody was at the keyboard at
 * 03:00). Its identity is the schedule's title, so two fires of one schedule
 * stack into one run and two different schedules never do.
 */
export type Speaker = 'agent' | 'me' | 'system' | `teammate:${string}` | `schedule:${string}`

/** Wire kinds that are harness events rather than anybody speaking. */
const SYSTEM_BADGES: ReadonlySet<string> = new Set(['notification', 'system', 'tool', 'image'])

function speakerOf(item: ChatItem, labels?: ReadonlyMap<string, string>): Speaker {
  if (item.type !== 'user') return 'agent'
  // A delegated prompt is a colleague's request wearing the same face: the
  // teammate envelope and `<supermux-delegation from>` differ in transport, not
  // in who is speaking, so they share one voice and one arrival divider.
  if (item.badge === 'teammate' || item.badge === 'delegation')
    return `teammate:${labels?.get(item.uuid) ?? ''}`
  if (item.badge === 'schedule') return `schedule:${labels?.get(item.uuid) ?? ''}`
  if (item.badge && SYSTEM_BADGES.has(item.badge)) return 'system'
  // An interruption is user-role on the wire and nobody's words on the screen.
  if (harnessNotice(item.text)) return 'system'
  return 'me'
}

/**
 * uuid → the wire `label` the display model drops.
 *
 * `ChatItem` is frozen and carries no label, but the arrival divider has to name
 * the colleague who sent the message (`<teammate-message teammate_id="…">`), and
 * a system line has to name the thing the event is about. Rather than edit a
 * tested A1 shape for a presentation need, the panel hands this index down
 * beside the items.
 */
export function entryLabels(entries: readonly ChatEntry[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of entries) if (e.label) out.set(e.uuid, e.label)
  return out
}

/* ── receipts-first ──────────────────────────────────────────────────────── */

/**
 * Within one confirming batch, the CLOSING prose sorts after the receipts.
 *
 * The batch window is a contiguous run of AGENT items (a user turn closes it),
 * and inside that window the reorder only applies to items sharing a `ts`
 * second — which is exactly the flush case, since one assistant message's text
 * block and its `tool_use` blocks are written at the same instant. Anything
 * further apart is real chronology and is left alone.
 *
 * The direction matters and is asymmetric: prose that OPENS a bucket introduces
 * the calls under it and never moves, prose that FOLLOWS a receipt is the
 * turn's answer and waits for the whole checklist. "The closing text is never
 * the first thing to appear" (master plan §4.2) is a statement about the
 * closing text, not a licence to sort the batch.
 *
 * Stable, non-mutating: the returned array holds the same item objects.
 */
export function receiptsFirst(items: readonly ChatItem[]): ChatItem[] {
  const out: ChatItem[] = []
  let batch: ChatItem[] = []

  const flush = () => {
    if (batch.length === 0) return
    // One pass per second-bucket. `Map` keeps insertion order, so the buckets
    // stay chronological.
    const buckets = new Map<number, ChatItem[]>()
    for (const item of batch) {
      const bucket = buckets.get(item.ts)
      if (bucket) bucket.push(item)
      else buckets.set(item.ts, [item])
    }
    for (const bucket of buckets.values()) {
      // Only the CLOSING prose moves. A message's text block and its `tool_use`
      // blocks carry one timestamp (`recall.rs` stamps every block of a message
      // with the message's `ts`), so a bucket routinely opens with the prose
      // that INTRODUCES the calls — "I'll check the build first." Hoisting the
      // whole receipt class over it would print the answer above the question,
      // which is the exact failure this rule exists to avoid at the other end.
      // So: prose before the first receipt keeps its place; prose after it waits
      // until the batch's receipts are all on the page.
      const head: ChatItem[] = []
      const receipts: ChatItem[] = []
      const closing: ChatItem[] = []
      for (const item of bucket) {
        if (item.type === 'receipts') receipts.push(item)
        else if (receipts.length > 0) closing.push(item)
        else head.push(item)
      }
      out.push(...head, ...receipts, ...closing)
    }
    batch = []
  }

  for (const item of items) {
    if (item.type === 'user') {
      flush()
      out.push(item)
    } else {
      batch.push(item)
    }
  }
  flush()
  return out
}

/* ── run grammar ─────────────────────────────────────────────────────────── */

export interface GroupedItem {
  item: ChatItem
  /** Which voice this row belongs to — the run key. */
  speaker: Speaker
  /** Part of the previous row's run: 8px of air instead of 14px, and no mark. */
  grouped: boolean
  /** This row carries the 28px mark in the gutter. */
  showGutter: boolean
  /** The colleague who sent it, when the speaker is a teammate. */
  sender?: string
}

/**
 * Annotate each display item with the run grammar (§4.2 P2).
 *
 * `showGutter` is not simply `!grouped`: the human's row is right-aligned and
 * gutterless by construction, and a system line is centred and has no row at
 * all. Only the two left-hand voices — this session and a colleague — hang a
 * face, and only on the first row of their run.
 */
export function groupItems(
  items: readonly ChatItem[],
  labels?: ReadonlyMap<string, string>,
): GroupedItem[] {
  const out: GroupedItem[] = []
  let previous: Speaker | null = null
  for (const item of items) {
    const speaker = speakerOf(item, labels)
    // A centred one-liner has no bubble, so it has nothing to stack into and
    // nothing that could stack into it — it also breaks the run around it.
    const grouped = speaker !== 'system' && speaker === previous
    const teammate = speaker.startsWith('teammate:')
    out.push({
      item,
      speaker,
      grouped,
      showGutter: !grouped && (speaker === 'agent' || teammate),
      sender: teammate ? speaker.slice('teammate:'.length) || undefined : undefined,
    })
    previous = speaker
  }
  return out
}

/* ── session-block dividers ──────────────────────────────────────────────── */

/**
 * How long a transcript has to be quiet before picking it up again counts as a
 * new sitting. Half an hour is the rhythm of the app's own day: a turn that
 * finishes and a turn started after lunch are two different conversations, and a
 * divider is how you find where you left off.
 */
export const SESSION_GAP_S = 30 * 60

export type TranscriptNode =
  | ({ kind: 'item'; key: string } & GroupedItem)
  | { kind: 'divider'; key: string; ts: number; label: string }
  | { kind: 'harness'; key: string; ts: number; ev: HarnessEvent }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The divider's relative clock (§5.3), in the app's existing time-ago rhythm.
 *
 * Duration-based below a week (so it is timezone-proof and ticks predictably),
 * calendar-based above it (where "6 days ago" stops being a useful answer). A
 * clock skewed into the future clamps to "Just now" rather than counting up.
 */
export function dividerLabel(tsSeconds: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000 - tsSeconds))
  if (diff < 60) return 'Just now'
  if (diff < 3_600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3_600)}h ago`
  if (diff < 172_800) return 'Yesterday'
  const d = new Date(tsSeconds * 1_000)
  if (diff < 7 * 86_400) return DAYS[d.getDay()]
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/**
 * Insert a divider at every session-block start — including the first row, so
 * the transcript always opens by saying when this began.
 *
 * A divider also BREAKS THE RUN: the row under it starts a fresh block, so it
 * re-hangs its mark and takes the full 14px of air. Grouping a message across a
 * two-hour gap would be a lie told in whitespace.
 */
export function dayDividers(rows: readonly GroupedItem[], nowMs: number): TranscriptNode[] {
  return withDividers(
    rows.map((row) => ({ kind: 'item' as const, ts: row.item.ts, row })),
    nowMs,
  )
}

/** One position in the merged pre-divider stream: a message row, or an event. */
type StreamRow =
  | { kind: 'item'; ts: number; row: GroupedItem }
  | { kind: 'harness'; ts: number; ev: HarnessEvent }

/**
 * The divider pass, over the MERGED stream.
 *
 * A harness line is centred and bubble-less, exactly like a system row, so it
 * breaks the run around it for the same reason a divider does: two assistant
 * turns separated by "Delegated to ●deploy-fix" are not one run, and stacking
 * them at 8px with no second mark would draw them as one.
 */
function withDividers(stream: readonly StreamRow[], nowMs: number): TranscriptNode[] {
  const out: TranscriptNode[] = []
  let previousTs: number | null = null
  // The previous node was a centred line, so whatever comes next opens a run.
  let cutByLine = false
  for (const entry of stream) {
    const ts = entry.ts
    const blockStart = previousTs === null || ts - previousTs > SESSION_GAP_S
    if (blockStart) {
      out.push({
        kind: 'divider',
        key: `div-${entry.kind === 'item' ? entry.row.item.uuid : `hx-${entry.ev.id}`}`,
        ts,
        label: dividerLabel(ts, nowMs),
      })
    }
    if (entry.kind === 'harness') {
      out.push({ kind: 'harness', key: `hx-${entry.ev.id}`, ts, ev: entry.ev })
      previousTs = ts
      cutByLine = true
      continue
    }
    const row = entry.row
    const cut = blockStart || cutByLine
    const broken = cut && row.grouped
    out.push({
      kind: 'item',
      key: row.item.uuid,
      ...row,
      grouped: cut ? false : row.grouped,
      showGutter: broken
        ? row.speaker === 'agent' || row.speaker.startsWith('teammate:')
        : row.showGutter,
    })
    previousTs = ts
    cutByLine = false
  }
  return out
}

/* ── harness events ──────────────────────────────────────────────────────── */

/**
 * The actions the renderer has a sentence for. The server already filters the
 * feed to this set; the client keeps its own copy because a line it cannot word
 * must not reach the page as an empty one — and because a future server action
 * should ship dark until somebody writes its copy, not blank.
 */
const HARNESS_ACTIONS: ReadonlySet<string> = new Set([
  'session.delegate',
  'session.rename',
  'schedule.create',
  'schedule.run',
])

/**
 * Which ledger rows become lines in THIS session's transcript.
 *
 * Two suppressions, both because the transcript already says it better:
 *
 *   · an INBOUND delegate (`target === self`) is rendered by the arrival
 *     divider over the message it delivered (Task 3). A system line as well
 *     would say the same thing twice, three pixels apart.
 *   · a rename the OWNER performed is ceremony — they typed it in this app two
 *     seconds ago. Only a session renaming ITSELF (`actor` is `agent:…`) is
 *     news, which is why the rule is an allow-list on the agent actor rather
 *     than a deny-list on `"user"`: a rename by any future non-agent actor is
 *     still not this session's news.
 *
 * Pure and total — the caller passes the raw feed, this decides what is shown.
 */
export function shownHarnessEvents(
  events: readonly HarnessEvent[],
  self?: string,
): HarnessEvent[] {
  return events.filter((ev) => {
    if (!HARNESS_ACTIONS.has(ev.action)) return false
    if (ev.action === 'session.delegate') return !(self && ev.target === self)
    if (ev.action === 'session.rename') return ev.actor.startsWith('agent:')
    return true
  })
}

/** Display items → the nodes the transcript renders, in order. */
export function buildTranscript(
  items: readonly ChatItem[],
  opts: {
    nowMs: number
    labels?: ReadonlyMap<string, string>
    /** The session's harness feed (`harnessApi.events`), ascending by id. */
    events?: readonly HarnessEvent[]
    /** The focused session's slug — what "inbound" means. */
    self?: string
  },
): TranscriptNode[] {
  const rows = groupItems(receiptsFirst(items), opts.labels)
  const shown = shownHarnessEvents(opts.events ?? [], opts.self)
  // No events → the stream is exactly what it was before this existed. Worth
  // the branch: it keeps the common path off the sort entirely.
  if (shown.length === 0) return dayDividers(rows, opts.nowMs)

  const stream: StreamRow[] = rows.map((row) => ({
    kind: 'item' as const,
    ts: row.item.ts,
    row,
  }))
  for (const ev of shown) stream.push({ kind: 'harness', ts: ev.ts, ev })
  // Sort by ts ALONE, and lean on stability: the items were pushed first and in
  // the order `receiptsFirst` decided, so an event sharing a second with a turn
  // lands after it and the receipts-first ordering inside that second is
  // untouched. A tie-break on kind would undo one of those two properties.
  stream.sort((a, b) => a.ts - b.ts)
  return withDividers(stream, opts.nowMs)
}

/* ── receipt rows ────────────────────────────────────────────────────────── */

/**
 * The two ceilings on a receipt's text.
 *
 * `TOOL_MAX` used to be 64 — the number that kept a receipt to ONE line. It is
 * not that number any more (daily-driver QA #2): the row wraps and expands on
 * tap now, and what keeps the collapsed read short is `condenseReceiptLabel`,
 * not a truncation of the label itself. So this ceiling is what an EXPANDED row
 * may show, and it is generous on purpose — a user who taps a `Bash …` line is
 * asking what the command was.
 */
const TOOL_MAX = 160
const OUTCOME_MAX = 72

/** What the phone shows before the row is tapped. Two lines of a 266px bubble. */
const SHORT_MAX = 30

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * One token of a label, at the length a phone can read.
 *
 * A path becomes its basename (`/home/supermux/spike-qa/notes.md` → `notes.md`),
 * a directory keeps its trailing slash so it still reads as a directory, and a
 * URL keeps its HOST — `post-12.html` names nothing, `example.com/…` names the
 * thing the call reached.
 */
function shortenToken(token: string): string {
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)(\/.*)?$/i.exec(token)
  if (url) return url[2] && url[2] !== '/' ? `${url[1]}/…` : url[1]
  if (!token.includes('/')) return token
  const dir = token.endsWith('/')
  const body = dir ? token.slice(0, -1) : token
  const base = body.slice(body.lastIndexOf('/') + 1)
  if (!base) return token
  return dir ? `${base}/` : base
}

/**
 * A receipt label, condensed for the phone (daily-driver QA #2).
 *
 * On the live instance a 37-character target in a 135px cell rendered as
 * `Read /home/s…` and left the outcome column four glyphs — so the majority of a
 * working turn said nothing at all. The fix is not a narrower ellipsis: it is
 * showing the part that identifies the call. The BASENAME for a path, the HEAD
 * of a command with the paths inside it shortened the same way, and a single
 * clamp at the end for whatever is still too long.
 *
 * The full label is never lost — `toReceiptRows` carries it as `tool`, and the
 * row shows it when the user taps.
 */
export function condenseReceiptLabel(label: string): string {
  const tokens = label.trim().split(/\s+/)
  return clamp(tokens.map(shortenToken).join(' '), SHORT_MAX)
}

/** First line with anything on it, whitespace collapsed. */
function firstLine(text: string | undefined): string {
  if (!text) return ''
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/\s+/g, ' ')
    if (line) return line
  }
  return ''
}

/**
 * `ChatItem.lines` → B0 `Receipt` rows.
 *
 * FAILURE, and why it reads the way it does. `ok === false` is carried in the
 * OUTCOME (`failed · E0432`), not by a red bubble and not by a third glyph:
 * B0's receipt line ships exactly two states (`done`, `running`) because the
 * spinner has to morph into the check without reflow, and inventing a third
 * here would be a Track-B primitive diff inside a Track-A slice. The outcome
 * column is the honest place for it — a failed call is still a completed line
 * in the checklist, and the master plan's tone rule for failure is "calm, never
 * alarmist red" anyway.
 */
export function toReceiptRows(lines: readonly ReceiptLine[]): Receipt[] {
  return lines.map((line) => {
    const result = firstLine(line.result)
    const room = line.ok === false ? OUTCOME_MAX - 9 : OUTCOME_MAX
    const clamped = result.length > room
    const outcome =
      line.ok === false
        ? result
          ? `failed · ${clamp(result, room)}`
          : 'failed'
        : result
          ? clamp(result, room)
          : undefined
    const tool = clamp(stripEmojiPrefix(line.label), TOOL_MAX)
    const row: Receipt = { tool }
    // Only when it says something DIFFERENT: a label with nothing to shorten
    // must not ship two copies of itself through every render (the transcript is
    // memoised on prop identity — see `transcript-item.tsx`).
    const short = condenseReceiptLabel(tool)
    if (short !== tool) row.short = short
    if (outcome !== undefined) row.outcome = outcome
    // What the tap is FOR: the result the outcome column clamped. Same rule —
    // carried only when the clamp actually took something away, and it keeps the
    // `failed · ` prefix, because that prefix is the ONLY thing on a receipt
    // that says the call did not work (the glyph is the same check either way).
    // The expanded row shows this INSTEAD of the outcome, so dropping it would
    // turn a failure into something that reads like a result — on the very tap a
    // user makes because the short line was unreadable.
    if (clamped) row.full = line.ok === false ? `failed · ${result}` : result
    return row
  })
}

/* ── mention chips ───────────────────────────────────────────────────────── */

/** A run of prose, or a session named inside it. */
export type ProseSegment = { text: string } | { seed: string; label: string }

/**
 * Lowercased token → the session's immutable slug (the chip's seed).
 *
 * Both the slug and the display name are matchable — the agent writes whichever
 * it was told — but the SEED is always the slug, so a chip and the mark in the
 * gutter can never end up two different colours for one session.
 */
export function mentionIndex(
  sessions: readonly { name: string; display_name?: string | null }[],
): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of sessions) {
    if (!s.name) continue
    // Longest-first is applied at match time; here, the slug wins a collision
    // with somebody else's display name.
    const display = s.display_name?.trim()
    if (display) out.set(display.toLowerCase(), s.name)
    out.set(s.name.toLowerCase(), s.name)
  }
  return out
}

/**
 * The other direction: slug → the name that session is CALLED.
 *
 * `mentionIndex` answers "is this word a colleague?"; this answers "what do we
 * call the colleague this envelope names?". The arrival divider needs the
 * second — the wire's `teammate_id` is a slug, and a divider reading "Message
 * from ●release-train" names a row in a database rather than a colleague. A
 * session with no display name maps to nothing, and the caller falls back to the
 * slug, which is what that session is called.
 */
export function displayNames(
  sessions: readonly { name: string; display_name?: string | null }[],
): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of sessions) {
    const display = s.display_name?.trim()
    if (s.name && display) out.set(s.name, display)
  }
  return out
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g

/**
 * Split prose into text runs and mention chips.
 *
 * The pattern is built from the KNOWN NAMES, never from a shape — "no regex over
 * arbitrary words" (fase A3 T3). A name only matches on word boundaries that
 * include `-` and `_`, so `patcher` and `patchwork` are words, not colleagues.
 *
 * `self` is the focused session: its face is already in the gutter of every row
 * it speaks in, so a chip for "me" inside my own bubble is noise.
 */
export function mentionSegments(
  text: string,
  index: ReadonlyMap<string, string>,
  self?: string,
): ProseSegment[] {
  const tokens = [...index.keys()]
    .filter((token) => token.length > 1 && index.get(token) !== self)
    .sort((a, b) => b.length - a.length)
  if (tokens.length === 0 || !text) return [{ text }]

  const pattern = new RegExp(
    `(?<![\\w-])(${tokens.map((t) => t.replace(REGEX_SPECIAL, '\\$&')).join('|')})(?![\\w-])`,
    'gi',
  )
  const out: ProseSegment[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const seed = index.get(match[0].toLowerCase())
    if (seed === undefined) continue
    if (match.index > last) out.push({ text: text.slice(last, match.index) })
    out.push({ seed, label: match[0] })
    last = match.index + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out.length > 0 ? out : [{ text }]
}

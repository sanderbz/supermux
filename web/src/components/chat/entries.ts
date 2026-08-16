// Pure display-model logic for the fase-A1 chat tail. Dependency-free on
// purpose (local structural types, no store/API imports) so `bun test` runs
// it hermetically and the A3 renderer can replace the components above it
// without touching this layer.

/** Structural subset of the wire `RecallEntry` (lib/api/sessions.ts) the
 *  display model needs. Kept local: the wire type may grow; we only read. */
export interface ChatEntry {
  uuid: string
  ts: number
  /** The transcript file this entry came from. Half of the server's history
   *  cursor (`backlog.ts`, `encode_cursor` in `recall.rs`) — the uuid alone
   *  cannot address an entry across a project-scope read. */
  sessionId?: string
  text: string
  reply?: string
  kind: string
  label?: string
  ok?: boolean
  /** Server clipped `text` at the wire cap. Rendered as a marker: without it
   *  a clipped message is indistinguishable from one that simply ended. */
  truncated?: boolean
}

export interface ReceiptLine {
  uuid: string
  label: string
  ok?: boolean
  result?: string
}

export type ChatItem =
  | {
      type: 'user'
      uuid: string
      ts: number
      text: string
      badge?: string
      truncated?: boolean
    }
  | { type: 'assistant'; uuid: string; ts: number; text: string; truncated?: boolean }
  | {
      type: 'receipts'
      uuid: string
      ts: number
      lines: ReceiptLine[]
      overflow: number
    }

/** P3 volume guard (master plan §4.2): Claude runs 30–100 calls/turn; a
 *  receipts block shows at most this many lines + an overflow count. */
export const RECEIPT_CAP = 30

/** Newest-first wire entries → oldest-first display items. Consecutive
 *  `tool_use` entries collapse into ONE receipts block (cap + overflow);
 *  command/teammate prompts carry their kind as a badge. */
export function toDisplayList(entries: ChatEntry[]): ChatItem[] {
  const chrono = [...entries].reverse()
  const out: ChatItem[] = []
  for (const e of chrono) {
    if (e.kind === 'tool_use') {
      const line: ReceiptLine = {
        uuid: e.uuid,
        label: e.text,
        ok: e.ok,
        result: e.reply,
      }
      const last = out[out.length - 1]
      if (last && last.type === 'receipts') {
        if (last.lines.length >= RECEIPT_CAP) last.overflow++
        else last.lines.push(line)
      } else {
        out.push({ type: 'receipts', uuid: e.uuid, ts: e.ts, lines: [line], overflow: 0 })
      }
    } else if (e.kind === 'assistant') {
      out.push({
        type: 'assistant',
        uuid: e.uuid,
        ts: e.ts,
        text: e.text,
        truncated: e.truncated,
      })
    } else {
      out.push({
        type: 'user',
        uuid: e.uuid,
        ts: e.ts,
        text: e.text,
        badge: e.kind === 'prompt' ? undefined : e.kind,
        truncated: e.truncated,
      })
    }
  }
  return out
}

/** Newest AGENT-authored entry timestamp (epoch SECONDS; 0 when the tail has
 *  none) out of the newest-first wire list — the supersede gate's "this turn's
 *  confirming batch is in hand" probe. USER-authored turns are excluded on
 *  purpose: Claude writes the user's own prompt to the transcript within ~1s
 *  of the send, so a gate that counted it would fire before the agent has
 *  confirmed anything (and, with the `last_send_at` turn anchor, always). */
export function newestAgentTs(entries: ChatEntry[]): number {
  const e = entries.find((x) => x.kind === 'assistant' || x.kind === 'tool_use')
  return e ? e.ts : 0
}

/** "12s" / "2m 05s" — the P12 elapsed clause. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

/**
 * Claude's own bracketed HARNESS notices, which arrive on the wire as ordinary
 * user-role prompts.
 *
 * `[Request interrupted by user]` / `[Request interrupted by user for tool use]`
 * is what Claude Code writes to the transcript when a turn or a tool call is
 * stopped — nobody typed it, and drawn as a user bubble it reads as if the
 * user had (mobile proof, 16-chat-after-deny-light.png: a dark right-hand
 * bubble saying "[Request interrupted by user for tool use]" under a denied
 * Bash call). It belongs in the surface's SYSTEM voice: a centred line.
 *
 * Deliberately anchored to the whole string and to this one family — the
 * transcript is the user's own words, and a loose pattern that re-voiced a
 * message someone actually typed would be a worse bug than the one it fixes.
 */
export function harnessNotice(text: string): string | null {
  const m = /^\s*\[(Request interrupted by user[^\]]*)\]\s*$/i.exec(text)
  return m ? m[1] : null
}

/** Strip the leading activity-taxonomy glyph (`⚡ npm test` → `npm test`) so
 *  the live overlay and the confirmed `tool_line` receipts are byte-close —
 *  the emoji taxonomy stays terminal/tile-only (master plan §4.2 P3), and the
 *  provisional→confirmed supersede must never visibly re-label a row. */
export function stripEmojiPrefix(label: string): string {
  return label.replace(/^[^\p{L}\p{N}]{1,3}\s+/u, '')
}

/** End of the confirmed entry's second, in ms.
 *
 *  Wire timestamps on transcript entries have SECOND resolution (`RecallEntry.ts`
 *  is `parse_ts` → `.timestamp()`, floored) while the live overlay stamps lines
 *  with millisecond `activity_at`. `ts * 1000` therefore under-shoots by up to
 *  999 ms and leaves an overlay line whose confirmed twin has already landed on
 *  screen. Rounding up to the end of the second is the conservative reading of
 *  "at or before the newest confirmed entry": at worst a not-yet-confirmed line
 *  disappears up to a second early, which is invisible, whereas the other
 *  direction renders the same receipt twice for the rest of the turn. */
export function supersededCutoffMs(lastConfirmedTs: number): number {
  return (lastConfirmedTs + 1) * 1000
}

/** Drop overlay lines the confirmed transcript now represents. Returns the
 *  SAME array when nothing was superseded, so an unchanged live layer does not
 *  force a re-render. */
export function pruneSuperseded<T extends { at: number }>(
  lines: T[],
  lastConfirmedTs: number,
): T[] {
  const cutoff = supersededCutoffMs(lastConfirmedTs)
  const kept = lines.filter((l) => l.at > cutoff)
  return kept.length === lines.length ? lines : kept
}

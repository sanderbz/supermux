// Pure display-model logic for the fase-A1 chat tail. Dependency-free on
// purpose (local structural types, no store/API imports) so `bun test` runs
// it hermetically and the A3 renderer can replace the components above it
// without touching this layer.

/** Structural subset of the wire `RecallEntry` (lib/api/sessions.ts) the
 *  display model needs. Kept local: the wire type may grow; we only read. */
export interface ChatEntry {
  uuid: string
  ts: number
  text: string
  reply?: string
  kind: string
  label?: string
  ok?: boolean
}

export interface ReceiptLine {
  uuid: string
  label: string
  ok?: boolean
  result?: string
}

export type ChatItem =
  | { type: 'user'; uuid: string; ts: number; text: string; badge?: string }
  | { type: 'assistant'; uuid: string; ts: number; text: string }
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
      out.push({ type: 'assistant', uuid: e.uuid, ts: e.ts, text: e.text })
    } else {
      out.push({
        type: 'user',
        uuid: e.uuid,
        ts: e.ts,
        text: e.text,
        badge: e.kind === 'prompt' ? undefined : e.kind,
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

/** Strip the leading activity-taxonomy glyph (`⚡ npm test` → `npm test`) so
 *  the live overlay and the confirmed `tool_line` receipts are byte-close —
 *  the emoji taxonomy stays terminal/tile-only (master plan §4.2 P3), and the
 *  provisional→confirmed supersede must never visibly re-label a row. */
export function stripEmojiPrefix(label: string): string {
  return label.replace(/^[^\p{L}\p{N}]{1,3}\s+/u, '')
}

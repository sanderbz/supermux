// Pure display-model logic for the fase-A1 chat tail. Dependency-free on
// purpose (local structural types, no store/API imports) so `bun test` runs
// it hermetically and the A3 renderer can replace the components above it
// without touching this layer.

/** Structural subset of the wire `RecallEntry` (lib/api/sessions.ts) the
 *  display model needs. Kept local: the wire type may grow; we only read. */
export interface ChatEntry {
  uuid: string
  ts: number
  /** The transcript file this entry came from.
   *
   *  VESTIGIAL. It was half of the A1 poll's history cursor (`encode_cursor` in
   *  `recall.rs`, `<session_id>:<uuid>`); the surface now pages the A2 backlog,
   *  whose cursor is `<conversation_id>:<offset>` and is computed in the WIRE
   *  domain before this shape exists (`backlog.ts`, `use-chat-backlog.ts`).
   *  `toChatEntries` does not populate it and nothing reads it — kept only
   *  because the display model is the frozen A1 shape. */
  sessionId?: string
  text: string
  reply?: string
  kind: string
  label?: string
  ok?: boolean
  /** Server clipped `text` at the wire cap. Rendered as a marker: without it
   *  a clipped message is indistinguishable from one that simply ended. */
  truncated?: boolean
  /**
   * `kind: 'blocked'` only — does this failure stop the session until a human
   * acts?
   *
   * A quota bucket and an auth death do; a 529 retry and a server-side
   * throttle do not, and CC explicitly says so in the second case's own copy.
   * The distinction is the difference between an honest composer gate and one
   * that blanks a working session for a condition that clears in seconds, so it
   * rides on the entry rather than being re-derived from the label downstream.
   */
  blocking?: boolean
  /**
   * A LATER entry withdrew this one (catalog `err.refusal_fallback_dialog`).
   *
   * Set by the wire fold from a system line carrying `retractedMessageUuids`,
   * never stored and never inferred from this entry's own content — see the
   * retraction note in `wire-entries.ts` for why the row is marked rather than
   * removed. The renderer draws a marked row as withdrawn: present, readable,
   * and visibly no longer part of the conversation.
   */
  retracted?: boolean
  /**
   * `kind: 'tool_use'` only — the user DECLINED this call.
   *
   * A denial is not a failure: nothing broke, somebody decided. The server has
   * always labelled it (`parser.rs::is_denial`, whose own comment says the label
   * "is what lets the renderer say you declined this instead of drawing a
   * success tick next to a refusal"), and the renderer went on printing
   * `failed · The user doesn't want to proceed with this tool use…` — reporting
   * a person's decision back to them as a broken tool.
   */
  denied?: boolean
  /**
   * `kind: 'dialog'` only — this session is WAITING ON A HUMAN and cannot get
   * on with it (`server/src/sessions/chat/parser.rs` sets `body.blocked` on
   * `request_user_dialog` and on an MCP `task_*` that parks on
   * `input_required`).
   *
   * The dialog row is drawn as a display-only line, but the blocked bit outlives
   * that: `awaitingInputState` (blocked.ts) reads it to gate the composer and
   * raise attention from the TRANSCRIPT plane alone, for exactly the dialog the
   * peek lens is down for or has never fingerprinted. Distinct from `blocking`,
   * which is a `kind:'blocked'` quota/auth wall with a clock; this is a question
   * a person answers in the terminal.
   */
  awaitsInput?: boolean
}

export interface ReceiptLine {
  uuid: string
  label: string
  ok?: boolean
  result?: string
  /** The user declined this call — see `ChatEntry.denied`. */
  denied?: boolean
}

export type ChatItem =
  | {
      type: 'thinking'
      uuid: string
      ts: number
      text: string
      /** Seconds between the row above and this block landing — the honest
       *  reading of "how long it thought". Absent when there is no row above it
       *  to measure from, or the clock did not move. */
      secs?: number
      truncated?: boolean
      /** A later entry withdrew this row (`ChatEntry.retracted`). */
      retracted?: boolean
    }
  | {
      type: 'user'
      uuid: string
      ts: number
      text: string
      badge?: string
      truncated?: boolean
      /**
       * The SOURCE's own words, under this app's summary of them.
       *
       * System rows are written in supermux's voice — "earlier turns are
       * summarised", "Claude Code asked the agent to wrap up" — and for two of
       * them the payload carries detail the summary cannot hold: the grace
       * window's verbatim wrap-up instruction, which is the only evidence the
       * reader has that Claude's sudden change of behaviour is not a bug in this
       * app. Carried here so the row can show it without a second lookup.
       */
      detail?: string
    }
  | {
      type: 'assistant'
      uuid: string
      ts: number
      text: string
      truncated?: boolean
      /** A later entry withdrew this reply — Claude Code's safeguards flagged
       *  the prompt it came from and the model will not act on it any more
       *  (`ChatEntry.retracted`). Drawn as withdrawn, never deleted. */
      retracted?: boolean
    }
  | {
      /**
       * Claude is BLOCKED — a quota bucket, an auth death, a server-side
       * throttle, a terminal API error.
       *
       * Its own item type rather than an assistant bubble with a chip, because
       * the states audit found the opposite shipping: a limit banner rendered
       * byte-identically to ordinary Claude prose (same bubble, same colour),
       * under a green dot and an "Idle" header, with the composer live. The
       * type is what lets every surface downstream — the card, the composer
       * gate, the attention cause — agree that this session cannot work.
       */
      type: 'blocked'
      uuid: string
      ts: number
      /** The banner, verbatim: CC's own sentence about what happened. */
      text: string
      /** Which bucket, as words (`Session limit`, `Opus limit`, `Server busy`). */
      label?: string
      /** `Resets 4:40am (Europe/Amsterdam)` — absent when the bucket is
       *  answered by a slash command rather than by a clock. */
      detail?: string
      truncated?: boolean
    }
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
  // The stamp of the row physically above, for the thinking clock below. Read
  // from the WIRE order rather than from `out`, so a receipts fold cannot move
  // it. A thinking block is written when it is COMPLETE, so the gap from the
  // row above is what the model spent on it — the same reading Claude's own
  // clients show, and the only one these timestamps support.
  let prevTs = 0
  for (const e of chrono) {
    const since = prevTs > 0 ? e.ts - prevTs : 0
    prevTs = e.ts
    if (e.kind === 'thinking') {
      // A6 register S21 — one collapsed row per thinking block, never merged
      // into the run above it: a "Thought for 8s" that stood for two separate
      // stretches of reasoning would be a number nobody could act on.
      out.push({
        type: 'thinking',
        uuid: e.uuid,
        ts: e.ts,
        text: e.text,
        secs: since > 0 ? since : undefined,
        truncated: e.truncated,
        retracted: e.retracted,
      })
    } else if (e.kind === 'tool_use') {
      const line: ReceiptLine = {
        uuid: e.uuid,
        label: e.text,
        ok: e.ok,
        result: e.reply,
        denied: e.denied,
      }
      const last = out[out.length - 1]
      if (last && last.type === 'receipts') {
        if (last.lines.length >= RECEIPT_CAP) last.overflow++
        else last.lines.push(line)
      } else {
        out.push({ type: 'receipts', uuid: e.uuid, ts: e.ts, lines: [line], overflow: 0 })
      }
    } else if (e.kind === 'blocked') {
      out.push({
        type: 'blocked',
        uuid: e.uuid,
        ts: e.ts,
        text: e.text,
        label: e.label,
        detail: e.reply,
        truncated: e.truncated,
      })
    } else if (e.kind === 'assistant') {
      out.push({
        type: 'assistant',
        uuid: e.uuid,
        ts: e.ts,
        text: e.text,
        truncated: e.truncated,
        retracted: e.retracted,
      })
    } else {
      out.push({
        type: 'user',
        uuid: e.uuid,
        ts: e.ts,
        text: e.text,
        badge: e.kind === 'prompt' ? undefined : e.kind,
        truncated: e.truncated,
        detail: e.reply,
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

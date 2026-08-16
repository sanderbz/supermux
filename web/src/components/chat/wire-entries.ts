/**
 * A2 wire entries → the frozen A1 display shape (fase A2→A3 wiring).
 * ─────────────────────────────────────────────────────────────────────────────
 * `entries.ts` (`ChatEntry`) is the boundary the whole A3/A4 stack is built on:
 * `toDisplayList`, the run grammar, the receipts-first tie-break, the pending
 * echo's reconciler and its watchdog all read it. The A2 socket does NOT speak
 * it — it speaks blocks: one entry per `message.content` block, `tool_result`
 * as its own entry, harness lines kept whole, timestamps in MILLISECONDS.
 *
 * So this module is the seam, and it is where the wiring slice's real work is:
 *
 *   · FOLDING. A `tool_result` is never its own row. It folds into the
 *     `tool_use` it answers, matched on `tool_use_id`, exactly as
 *     `recall.rs::read_chat_turns` did — the receipt's `reply` and `ok`.
 *   · CLASSIFYING. The A1 server split user turns into prompt / command /
 *     teammate / system by their leading harness wrapper. The wire carries the
 *     raw text and no `promptSource`/`isMeta`, so the wrapper rules are ported
 *     here (`classifyPrompt`). Without them a `<system-reminder>` blob renders
 *     as something the human said.
 *   · KEEPING THE VIEW CALM. `read_chat_turns` showed prompt / command /
 *     teammate / assistant prose / tool receipts and nothing else. The socket
 *     sends everything the transcript contains (thinking blocks, attachments,
 *     queue + mode lines, `ai-title`, subagent turns). This module applies the
 *     SAME visibility rule, so switching the data plane changes where the
 *     transcript comes from and not what it says. Widening it is a product
 *     decision for a later fase, not a side effect of the wiring.
 *   · SECONDS. `ChatEntry.ts` is epoch SECONDS everywhere downstream (the
 *     supersede cutoff rounds a floored second UP; the pending reconciler
 *     multiplies by 1000). `ts_ms` is floored to match rather than silently
 *     handing millisecond stamps to code that reads them as seconds.
 *
 * Pure and dependency-free (local types only), like `entries.ts` itself.
 */

import type { ChatEntry } from './entries'
import type { WireEntry } from './wire'

/** `REPLY_MAX_CHARS` (recall.rs): a receipt's outcome is a preview, never the
 *  tool's whole output — the row it feeds is one line high. */
export const REPLY_MAX_CHARS = 600
/** The salient input field on a `tool_use` receipt, clipped (recall.rs). */
const TOOL_DETAIL_MAX = 120
/** `ASSISTANT_MAX_CHARS` / `PROMPT_MAX_CHARS` are the server's A1 caps. The
 *  socket's own cap (`MAX_ENTRY_BYTES`, 16 KB + the `truncated` flag) already
 *  bounds what arrives, so nothing is re-clipped here — a second, smaller,
 *  UNMARKED clip would be a lie the "… clipped" marker cannot cover. */

// ── text hygiene (ws/mod.rs `sanitise_text`) ────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** Strip ANSI escapes and control bytes (keeping `\n` / `\t`), then trim —
 *  the client-side twin of the server's `sanitise_text`. The A1 path sanitised
 *  server-side; the A2 wire hands over the transcript's own bytes, so a tool
 *  result full of colour codes would otherwise reach the renderer raw. */
export function sanitiseText(raw: string): string {
  return raw.replace(ANSI_RE, '').replace(CONTROL_RE, '').trim()
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max)
}

// ── harness wrappers (recall.rs `classify_by_wrapper`) ──────────────────────

/** `<tag>` / `<tag attr=…>` at the very start — lowercase + `-` only, and the
 *  name must end at `>` or whitespace. Conservative on purpose: prose that
 *  merely contains `<` is not a wrapper. */
function leadingTag(s: string): string | null {
  const m = /^<([a-z-]+)(?=[>\s])/.exec(s)
  return m ? m[1] : null
}

/** Inner text of the first `<tag …>…</tag>`, trimmed. */
function tagInner(body: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`)
  const m = re.exec(body)
  return m ? m[1].trim() : null
}

/** `attr="value"` anywhere in the leading tag. */
function attrValue(body: string, attr: string): string | undefined {
  const m = new RegExp(`${attr}\\s*=\\s*"([^"]*)"`).exec(body)
  return m && m[1] ? m[1] : undefined
}

function stripTags(s: string): string {
  let out = ''
  let inTag = false
  for (const c of s) {
    if (c === '<') inTag = true
    else if (c === '>') inTag = false
    else if (!inTag) out += c
  }
  return out
}

/** First non-empty line with the wrapper tags removed — how A1 summarised a
 *  harness aside down to one calm line. */
function shortSummary(s: string): string {
  for (const raw of stripTags(s).split('\n')) {
    const line = raw.trim()
    if (line) return line
  }
  return '(system event)'
}

/** The A1 display kinds a user-role line can become. */
export interface ClassifiedPrompt {
  kind: 'prompt' | 'command' | 'teammate' | 'notification' | 'system' | 'image'
  text: string
  label?: string
}

/**
 * Port of `recall.rs::classify_user`'s wrapper half.
 *
 * The flag half (`promptSource`, `isMeta`) cannot be ported: `WireEntry` does
 * not carry those fields. That costs one distinction only — an `isMeta` aside
 * with NO recognised wrapper reads as a prompt instead of a system line — and
 * the alternative (guessing from prose) is the failure mode `promptSource:
 * "typed"` exists to prevent: a human who pastes XML must not be swallowed
 * into the system bucket.
 */
export function classifyPrompt(raw: string): ClassifiedPrompt {
  const trimmed = raw.trim()
  const tag = leadingTag(trimmed)
  if (!tag) {
    if (trimmed.startsWith('[Image: ')) {
      return { kind: 'image', text: trimmed.split('\n')[0] }
    }
    return { kind: 'prompt', text: sanitiseText(trimmed) }
  }
  switch (tag) {
    case 'task-notification': {
      const status = tagInner(trimmed, 'status')
      const summary =
        tagInner(trimmed, 'summary') ??
        (status ? `Agent run — ${status}` : 'Subagent task completed')
      const label = tagInner(trimmed, 'task-id') ?? undefined
      return { kind: 'notification', text: summary.trim(), label }
    }
    case 'command-name': {
      const slash = tagInner(trimmed, 'command-name') ?? ''
      const args = (tagInner(trimmed, 'command-args') ?? '').trim()
      return {
        kind: 'command',
        text: (args ? `${slash} ${args}` : slash).trim(),
        label: slash || undefined,
      }
    }
    case 'teammate-message':
      return {
        kind: 'teammate',
        text: sanitiseText(tagInner(trimmed, 'teammate-message') ?? ''),
        label: attrValue(trimmed, 'teammate_id'),
      }
    case 'system-reminder':
      return {
        kind: 'system',
        text: shortSummary(tagInner(trimmed, 'system-reminder') ?? ''),
        label: 'reminder',
      }
    default:
      // An unknown wrapper degrades into the system bucket carrying its tag as
      // the badge — a brand-new Claude Code wrapper never leaks as a fake
      // prompt, and it is visible enough that somebody asks what it is.
      return { kind: 'system', text: shortSummary(trimmed), label: tag }
  }
}

// ── bodies ──────────────────────────────────────────────────────────────────

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined
}

function textOf(body: unknown): string {
  const t = field(body, 'text')
  return typeof t === 'string' ? t : ''
}

/**
 * One-line receipt label for a `tool_use`: the tool's name plus its most
 * salient input field (`recall.rs::tool_line`, same field priority, same clip,
 * still icon-free — the emoji taxonomy stays terminal/tile-only, §4.2 P3).
 */
export function toolLine(name: string, input: unknown): string {
  for (const key of ['file_path', 'command', 'pattern', 'url', 'description', 'prompt']) {
    const v = field(input, key)
    if (typeof v === 'string' && v.trim()) {
      return `${name} ${clamp(sanitiseText(v.trim()), TOOL_DETAIL_MAX)}`
    }
  }
  return name
}

/**
 * Printable text of a `tool_result` body: a string verbatim, an array of
 * blocks as its concatenated `text` parts (`recall.rs::tool_result_text`).
 * Anything else (an image result, a structured payload) has no one-line form
 * and yields nothing rather than `[object Object]`.
 */
export function toolResultText(body: unknown): string {
  const content = field(body, 'content')
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  let taken = 0
  for (const p of content) {
    if (field(p, 'type') !== 'text') continue
    const t = field(p, 'text')
    if (typeof t !== 'string') continue
    parts.push(t)
    taken += t.length
    // The whole point of the preview budget: a `Read` of a 5 MB file arrives
    // as one string, and sanitising all of it to keep 600 chars is the cost
    // `preview_budget` exists to avoid on the server. Same rule here.
    if (taken >= REPLY_MAX_CHARS * 16) break
  }
  return parts.join('\n')
}

/** `600`-char preview: bounded slice → sanitise → final clip. */
function preview(s: string): string {
  return clamp(sanitiseText(clamp(s, REPLY_MAX_CHARS * 16 + 64)), REPLY_MAX_CHARS)
}

// ── the adapter ─────────────────────────────────────────────────────────────

/** `ts_ms` → the epoch SECONDS every downstream comparison is written in. */
function toSeconds(tsMs: number): number {
  return Math.floor(tsMs / 1000)
}

/**
 * Wire entries (oldest-first, as the socket holds them) → the renderer's
 * newest-first `ChatEntry` list.
 *
 * Everything the A1 chat view did not show is dropped here — see the module
 * header for the rule and why it is deliberately not widened in a wiring
 * slice. Subagent turns (`agent_id`) are among them: the socket sends them,
 * but the A3 surface has no voice for a subagent, so they would render as
 * indistinguishable main-thread rows. `read_chat_turns` hid sidechains for
 * exactly that reason.
 */
export function toChatEntries(wire: readonly WireEntry[]): ChatEntry[] {
  const out: ChatEntry[] = []
  // tool_use_id → index in `out`, so a later `tool_result` folds into its
  // receipt instead of becoming a row of its own.
  const receipts = new Map<string, number>()

  for (const w of wire) {
    if (w.agent_id != null) continue

    if (w.kind === 'tool_result') {
      const id = w.tool_use_id
      const at = id != null ? receipts.get(id) : undefined
      if (at === undefined) continue
      const target = out[at]
      target.ok = w.ok ?? target.ok
      const text = preview(toolResultText(w.body))
      if (text) target.reply = text
      // The receipt now carries a clipped tool OUTPUT; the flag belongs to the
      // row the user sees, which is the tool_use.
      if (w.truncated) target.truncated = true
      continue
    }

    if (w.kind === 'tool_use') {
      const name = w.label ?? 'tool'
      receipts.set(w.tool_use_id ?? w.uuid, out.length)
      out.push({
        uuid: w.uuid,
        ts: toSeconds(w.ts_ms),
        text: toolLine(name, field(w.body, 'input')),
        kind: 'tool_use',
        label: name,
        truncated: w.truncated || undefined,
      })
      continue
    }

    if (w.kind === 'assistant') {
      const text = sanitiseText(textOf(w.body))
      // An assistant line with no prose is a block that carried only a tool
      // call; A1 skipped the empty text rather than printing a blank bubble.
      if (!text) continue
      out.push({
        uuid: w.uuid,
        ts: toSeconds(w.ts_ms),
        text,
        kind: 'assistant',
        truncated: w.truncated || undefined,
      })
      continue
    }

    if (w.kind === 'prompt') {
      const raw = textOf(w.body)
      if (!raw.trim()) continue
      const c = classifyPrompt(raw)
      // The calm view: only the three user-initiated kinds, the same rule
      // `read_chat_turns` applied. Everything else the harness writes as a
      // user-role line stays out.
      if (c.kind !== 'prompt' && c.kind !== 'command' && c.kind !== 'teammate') {
        continue
      }
      out.push({
        uuid: w.uuid,
        ts: toSeconds(w.ts_ms),
        text: c.text,
        kind: c.kind,
        label: c.label,
        truncated: w.truncated || undefined,
      })
      continue
    }

    // thinking / attachment / system / compact_boundary / queue / mode /
    // subagent / unknown: not part of the A1 calm view.
  }

  out.reverse()
  return out
}

/**
 * The uuids of the entries a truncated body is worth fetching for.
 *
 * Two bounds, both about the SERVER's cost: `find_full_entry` streams the
 * transcript from byte 0 until the uuid matches, so a clipped entry near the
 * end of a 12 MB file is a full-file scan on the blocking pool. So only
 * entries the renderer actually SHOWS are fetched (a clipped `thinking` block
 * is never drawn), and only within the newest `window` of them — a reader who
 * scrolls into an old clipped entry keeps the "… clipped" marker, which is
 * exactly what the marker is for.
 */
export function truncatedUuids(
  wire: readonly WireEntry[],
  window: number,
): string[] {
  const out: string[] = []
  let seen = 0
  for (let i = wire.length - 1; i >= 0 && seen < window; i--) {
    const w = wire[i]
    if (w.agent_id != null) continue
    if (
      w.kind !== 'assistant' &&
      w.kind !== 'prompt' &&
      w.kind !== 'tool_use' &&
      w.kind !== 'tool_result'
    ) {
      continue
    }
    seen++
    if (w.truncated) out.push(w.uuid)
  }
  return out
}

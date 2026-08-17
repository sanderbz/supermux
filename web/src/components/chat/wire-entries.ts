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

import {
  classifyAgentError,
  limitName,
  resetNote,
  type AgentErrorInfo,
} from './agent-error'
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

/** `attr="value"` (or `attr='value'`) anywhere in the leading tag. Both quote
 *  styles, because `recall.rs::attr_value` accepts both and this file's whole
 *  job is to agree with it. */
function attrValue(body: string, attr: string): string | undefined {
  const m = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(body)
  if (!m) return undefined
  const v = m[1] ?? m[2]
  return v ? v : undefined
}

/** supermux's own wrapper tags — the two this app writes itself, as opposed to
 *  the ones Claude Code injects. Kept as consts because `recall.rs` does the
 *  same (`DELEGATION_TAG`, `SCHEDULE_TAG`): the format is a contract. */
const DELEGATION_TAG = 'supermux-delegation'
const SCHEDULE_TAG = 'supermux-schedule'

/** `scheduler/runner.rs::CONFIRM_FOOTER_SENTINEL` — the line that opens the
 *  machine-written "run this curl when you're done" footer. */
const CONFIRM_FOOTER_SENTINEL = '— — —'

/** Drop the agent-confirm footer from a scheduled delivery's body. A sentinel
 *  match, never a guess about what a prompt's tail looks like: bodies without
 *  it come back whole (`recall.rs::strip_confirm_footer`). */
function stripConfirmFooter(text: string): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === CONFIRM_FOOTER_SENTINEL) break
    out.push(line)
  }
  return out.join('\n').replace(/\s+$/, '')
}

/** Inverse of `runner.rs::escape_attr`, for exactly the four entities the
 *  writer produces — a private contract between two functions, not an XML
 *  parser. `&amp;` last, so an escaped `&amp;lt;` returns as `&lt;`. */
function unescapeAttr(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
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

/** The A1 display kinds a user-role line can become. Mirrors `recall.rs`'s
 *  `Kind` in its snake_case wire spelling — the vocabulary the shared parity
 *  corpus is written in. */
export interface ClassifiedPrompt {
  kind:
    | 'prompt'
    | 'command'
    | 'teammate'
    | 'delegation'
    | 'schedule'
    | 'notification'
    | 'system'
    | 'image'
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
/**
 * The chat renderer's calm-view filter — the exact twin of
 * `recall.rs::Kind::is_user_initiated`, and the second half of the reason the
 * fabric spine was invisible here: even once `classifyPrompt` names a
 * delegation, a filter that does not list it drops the row on the floor.
 */
export const SURVIVING_KINDS: ReadonlySet<ClassifiedPrompt['kind']> = new Set([
  'prompt',
  'command',
  'teammate',
  'delegation',
  'schedule',
] as const)

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
    case DELEGATION_TAG: {
      // `<supermux-delegation from="X">…</supermux-delegation>` — a prompt
      // another session handed to this one (`agents/delegate.rs` writes it).
      // Same parse shape as the teammate envelope above; the sender's slug is
      // the label the arrival divider names.
      const from = attrValue(trimmed, 'from')?.trim()
      const inner = sanitiseText(tagInner(trimmed, DELEGATION_TAG) ?? '')
      // No sender means no provenance, and an unattributed body must never
      // leak into the transcript as somebody's bare prompt.
      if (!from) {
        return { kind: 'system', text: shortSummary(inner), label: DELEGATION_TAG }
      }
      return { kind: 'delegation', text: inner, label: from }
    }
    case SCHEDULE_TAG: {
      // `<supermux-schedule id="…" title="…">…</supermux-schedule>` — a prompt
      // one of this session's own schedules fired (`scheduler/runner.rs`).
      // Unlike a delegation — whose whole provenance IS the `from` attribute —
      // the tag itself already says a schedule sent this, so a title-less
      // schedule stays a schedule turn (unnamed) rather than degrading into a
      // system line that would hide the prompt from the transcript.
      const rawTitle = attrValue(trimmed, 'title')
      const title = rawTitle ? unescapeAttr(rawTitle) : undefined
      const inner = stripConfirmFooter((tagInner(trimmed, SCHEDULE_TAG) ?? '').trim())
      return {
        kind: 'schedule',
        text: sanitiseText(inner),
        label: title && title.trim() ? title : undefined,
      }
    }
    case 'system-reminder':
      return {
        kind: 'system',
        text: shortSummary(tagInner(trimmed, 'system-reminder') ?? ''),
        label: 'reminder',
      }
    // `local-command-caveat` / `local-command-stdout` need no arm of their own:
    // `recall.rs` gives them one, but it produces exactly what the default arm
    // below produces (system, tag as label, one-line summary).
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
  // THE TWO TOOLS WHOSE PAYLOAD IS THE POINT, and which fell through this list
  // to a bare tool name (verify matrix: `ask_user_question.tool_use`,
  // `plan.exit_plan_mode.transcript`). `AskUserQuestion`'s input is
  // `{questions:[{question, header, options}]}` and `ExitPlanMode`'s is
  // `{plan, planFilePath}` — neither carries a `file_path`/`command`/`prompt`,
  // so the conversation's only record of a question was the word
  // "AskUserQuestion", and of a whole written plan the word "ExitPlanMode".
  const question = firstQuestion(input)
  if (question) return `${name} ${clamp(sanitiseText(question), TOOL_DETAIL_MAX)}`
  for (const key of ['file_path', 'command', 'pattern', 'url', 'description', 'prompt', 'plan']) {
    const v = field(input, key)
    if (typeof v === 'string' && v.trim()) {
      // A plan is markdown with newlines; the receipt row is one line high, so
      // it is collapsed the way the tile tail collapses a prompt rather than
      // truncated at the first line break.
      const flat = key === 'plan' ? v.trim().split(/\s+/).join(' ') : v.trim()
      return `${name} ${clamp(sanitiseText(flat), TOOL_DETAIL_MAX)}`
    }
  }
  return name
}

/** `AskUserQuestion`'s first question sentence, or `undefined`. */
function firstQuestion(input: unknown): string | undefined {
  const qs = field(input, 'questions')
  if (!Array.isArray(qs)) return undefined
  for (const q of qs) {
    const text = field(q, 'question')
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  return undefined
}

/**
 * `AskUserQuestion`'s answer as the chosen LABEL, from the sibling
 * `toolUseResult.answers` the server now puts on the wire.
 *
 * Without it the receipt showed CC's sentence-for-the-model verbatim —
 * `Your questions have been answered: "Which fruit do you want?"="Apple". You
 * can now continue with these answers in mind.` — where the fact is one word.
 */
export function answerLine(body: unknown): string | undefined {
  const answers = field(body, 'answers')
  if (typeof answers !== 'object' || answers === null) return undefined
  const pairs = Object.entries(answers as Record<string, unknown>).filter(
    ([, v]) => typeof v === 'string' && v.trim(),
  )
  if (pairs.length === 0) return undefined
  return pairs.map(([q, a]) => `${shortQuestion(q)} → ${String(a).trim()}`).join(' · ')
}

/** A question sentence, shortened to the chip-sized stub the receipt shows. */
function shortQuestion(q: string): string {
  const s = sanitiseText(q).replace(/\?$/, '')
  return s.length <= 48 ? s : `${s.slice(0, 47)}…`
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

// ── blocked banners ─────────────────────────────────────────────────────────

/**
 * The server's classification off the wire body — with the client's own
 * classifier as the fallback.
 *
 * Both halves are real. The server stamps `class`/`limit`/`resets_at` onto the
 * entry, and that is authoritative. But the SAME banner reaches this app a
 * second way (the `StopFailure` hook's `last_assistant_message`, on a plane
 * with no chat store behind it), so `agent-error.ts` exists anyway and is
 * pinned to the Rust classifier by the shared corpus — which makes it the
 * correct fallback for an entry from an older server that carries only text.
 */
function infoOf(body: unknown): AgentErrorInfo {
  const cls = field(body, 'class')
  if (typeof cls !== 'string') {
    return classifyAgentError(textOf(body), null, null)
  }
  const limit = field(body, 'limit')
  const label = field(body, 'limit_label')
  const resets = field(body, 'resets_at')
  return {
    cls: cls as AgentErrorInfo['cls'],
    limit: typeof limit === 'string' ? (limit as AgentErrorInfo['limit']) : undefined,
    label: typeof label === 'string' ? label : undefined,
    resetsAt: typeof resets === 'string' ? resets : undefined,
    blocking: field(body, 'blocked') === true,
  }
}

/** The chip over a blocked card: which bucket, or what class of failure. */
function blockedLabel(info: AgentErrorInfo): string {
  switch (info.cls) {
    case 'limit':
      return limitName(info)
    case 'throttle':
      // CC says in prose that this is NOT your usage limit, and the chip must
      // not contradict the sentence under it.
      return 'Server busy'
    case 'auth':
      return 'Signed out'
    case 'api':
      return 'API error'
    default:
      return 'Blocked'
  }
}

/** A banner whose text did not survive (clipped to nothing) still says what
 *  happened — an empty amber card would be worse than the bubble it replaced. */
function bannerFallback(info: AgentErrorInfo): string {
  return info.cls === 'limit'
    ? 'Claude has hit a usage limit and cannot continue this turn.'
    : 'Claude could not complete this turn.'
}

// ── system rows ─────────────────────────────────────────────────────────────

/** Badges the system rows ride under. `grouping.ts::SYSTEM_BADGES` must list
 *  every one of them or the row is drawn as somebody's speech bubble. */
export const SYSTEM_ROW_BADGES = ['compaction', 'model-switch', 'api-retry', 'dialog', 'limit'] as const

function num(body: unknown, key: string): number | undefined {
  const v = field(body, key)
  return typeof v === 'number' ? v : undefined
}

function str(body: unknown, key: string): string | undefined {
  const v = field(body, key)
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * One allowlisted system entry → the centred line it becomes, or `null` for
 * the subtypes that stay dropped.
 *
 * The copy states the CONSEQUENCE, not the subtype: "earlier turns are
 * summarised" is why the history above a compaction seam looks amputated, and
 * naming both models is the whole content of a fallback notice — a warning that
 * says "model_refusal_fallback" tells the reader nothing they can act on.
 */
function systemRow(w: WireEntry): { text: string; badge: string } | null {
  if (w.kind === 'compact_boundary') {
    return {
      text: 'earlier turns are summarised',
      badge: 'compaction',
    }
  }
  switch (w.label) {
    case 'model_refusal_fallback':
    case 'model_fallback':
    case 'model_consent_fallback': {
      const from = str(w.body, 'from_model')
      const to = str(w.body, 'to_model')
      if (from && to) return { text: `${modelName(from)} → ${modelName(to)}`, badge: 'model-switch' }
      return { text: str(w.body, 'content') ?? 'a different model answered this turn', badge: 'model-switch' }
    }
    case 'api_error': {
      const attempt = num(w.body, 'attempt')
      const max = num(w.body, 'max_retries')
      const what = str(w.body, 'formatted') ?? str(w.body, 'content') ?? 'API error'
      const down = field(w.body, 'network_down') === true
      const retry = attempt && max ? ` · retrying (${attempt}/${max})` : ''
      return { text: `${down ? 'network is down — ' : ''}${what}${retry}`, badge: 'api-retry' }
    }
    // THE UNIVERSAL BLOCKED SIGNAL: CC emits `request_user_dialog` for every
    // dialog kind, including ones it has not shipped yet. One arm covers
    // families this codebase has never seen, which no per-dialog registry can.
    case 'request_user_dialog': {
      const kind = str(w.body, 'dialog')
      return { text: `this session is waiting on ${dialogNoun(kind)}`, badge: 'dialog' }
    }
    // THE GRACE WINDOW (`limit.grace_window`). Claude Code injects a wrap-up
    // instruction into the model's CONTEXT as a user-role entry near a usage
    // limit. The server already refuses to call it a prompt; this is the line a
    // reader gets instead — because "Claude suddenly stopped starting subagents"
    // with no explanation anywhere reads as a bug in this app.
    case 'limit_grace': {
      const notice = str(w.body, 'notice') ?? 'Claude Code asked the agent to wrap up — usage limit near'
      return {
        text: str(w.body, 'hint') === 'checkpoint' ? `${notice} · checkpointing` : notice,
        badge: 'limit',
      }
    }
    // A LONG-RUNNING MCP TASK (`mcp.task_input_required`). `input_required` is
    // the one status in the enum that means a person is needed; every other one
    // is progress and stays silent, exactly as it did before.
    case 'task_started':
    case 'task_progress':
    case 'task_updated':
    case 'task_notification': {
      if (str(w.body, 'status') !== 'input_required') return null
      const server = str(w.body, 'server')
      return {
        text: server
          ? `an MCP task on “${server}” is waiting for your input`
          : 'an MCP task is waiting for your input',
        badge: 'dialog',
      }
    }
    case 'informational': {
      const text = str(w.body, 'content')
      return text ? { text, badge: 'system' } : null
    }
    default:
      // stop_hook_summary / turn_duration / local_command / scheduled_task_fire
      // and anything a patch release invents: chrome, and deliberately silent.
      return null
  }
}

/**
 * `request_user_dialog`'s `dialog` field → a noun a reader can act on.
 *
 * The arm is deliberately open-ended — it covers dialog kinds Anthropic has not
 * shipped yet — so an unknown kind keeps Claude Code's own token rather than
 * being dropped. The named ones are the families this codebase has evidence
 * for: `elicitation` is the MCP form, and it is the row a session gets when the
 * `Elicitation` hook is NOT installed (an older settings.json, a session started
 * before the upgrade) — the only thing standing between that user and a silent
 * hang.
 */
function dialogNoun(kind?: string): string {
  switch (kind) {
    case 'elicitation':
      return 'an MCP server’s input form'
    case 'tool_permission':
      return 'a permission dialog'
    case undefined:
      return 'a dialog'
    default:
      return `a ${kind} dialog`
  }
}

/** `claude-opus-5` → `Opus 5`: the model id is wire syntax, and a reader of a
 *  one-line notice needs the name Anthropic uses for it. Unknown shapes come
 *  back verbatim rather than mangled. */
function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)?)/.exec(id)
  if (!m) return id
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return `${family} ${m[2].replace('-', '.')}`
}

// ── the adapter ─────────────────────────────────────────────────────────────

/** `ts_ms` → the epoch SECONDS every downstream comparison is written in. */
function toSeconds(tsMs: number): number {
  return Math.floor(tsMs / 1000)
}

/**
 * A wire entry that came from `<conv>/subagents/agent-<id>.jsonl` rather than
 * from the main transcript.
 *
 * Named (fase A6 T4.1) because the rule it encodes is now a **stated
 * contract** rather than a `continue` in two loops. The chat surface does not
 * render subagent turns, and A6 decided that deliberately rather than fixing
 * it: giving them a voice means a new chat primitive, and the vocabulary is
 * closed at A4's set plus B4's system lines. What A6 would not accept is the
 * state it found — a spinner, a bare count, and silence during a five-way
 * fan-out, with no statement anywhere that this was a choice.
 *
 * The two halves of making it total:
 *   · the surface SAYS the work is happening elsewhere (`SUBAGENTS` in
 *     `brand/copy.ts`, rendered by the live status clause), instead of showing
 *     a count with no explanation of where the content went
 *   · fetch-full is no longer a structural 404 for these
 *     (`ws.rs::find_full_entry_anywhere`) — so the day a surface DOES want
 *     them, the data path already works, and in the meantime a 404 from that
 *     route means "no such entry" and nothing else
 */
export function isSubagent(w: WireEntry): boolean {
  return w.agent_id != null
}

/**
 * Wire entries (oldest-first, as the socket holds them) → the renderer's
 * newest-first `ChatEntry` list.
 *
 * Everything the A1 chat view did not show is dropped here — see the module
 * header for the rule and why it is deliberately not widened in a wiring
 * slice. Subagent turns (`agent_id`) are among them: the socket sends them,
 * but the surface has no voice for a subagent, so they would render as
 * indistinguishable main-thread rows. `read_chat_turns` hid sidechains for
 * exactly that reason. See [`isSubagent`] for the A6 decision that made this
 * deliberate rather than accidental.
 */
export function toChatEntries(wire: readonly WireEntry[]): ChatEntry[] {
  const out: ChatEntry[] = []
  // tool_use_id → index in `out`, so a later `tool_result` folds into its
  // receipt instead of becoming a row of its own.
  const receipts = new Map<string, number>()
  // requestId → index in `out`, so a retry storm is ONE counting row.
  const retries = new Map<string, number>()

  for (const w of wire) {
    if (isSubagent(w)) continue

    if (w.kind === 'tool_result') {
      const id = w.tool_use_id
      const at = id != null ? receipts.get(id) : undefined
      if (at === undefined) continue
      const target = out[at]
      target.ok = w.ok ?? target.ok
      // The structured answer outranks the prose: `answers` is the fact, CC's
      // sentence is a paraphrase of it written for the model.
      const text = answerLine(w.body) ?? preview(toolResultText(w.body))
      if (text) target.reply = text
      // A DENIAL is a decision, not an output (`parser.rs::is_denial` labels
      // it). Without the label the row read as "✓ Bash … → The user doesn't
      // want to proceed" — a tick beside a refusal.
      if (w.label === 'denied') target.label = 'denied'
      // The receipt now carries a clipped tool OUTPUT; the flag belongs to the
      // row the user sees, which is the tool_use.
      if (w.truncated) target.truncated = true
      continue
    }

    // ── THE BLOCKED AGENT (states audit) ────────────────────────────────────
    // A quota/auth/throttle banner. Pre-fix these arrived as `kind:'assistant'`
    // and were drawn as ordinary Claude speech, so a session that was dead for
    // the next five hours looked exactly like one that had just answered a
    // question — green dot, "Idle" header, live composer, no reset time.
    if (w.kind === 'agent_error') {
      const text = sanitiseText(textOf(w.body))
      const info = infoOf(w.body)
      out.push({
        uuid: w.uuid,
        ts: toSeconds(w.ts_ms),
        text: text || bannerFallback(info),
        kind: 'blocked',
        // The bucket, as words — `Session limit` vs `Weekly limit` vs `Opus
        // limit` are four different answers about what to do next.
        label: blockedLabel(info),
        ok: false,
        // The reset clause, which is the whole answer to "when can I work
        // again". Reused rather than a new field: the display model is the
        // frozen A1 shape and `reply` is its slot for "what came back".
        reply: resetNote(info),
        blocking: info.blocking || undefined,
        truncated: w.truncated || undefined,
      })
      continue
    }

    // ── THE SYSTEM ROWS THAT CARRY A FACT ───────────────────────────────────
    // A NARROW allowlist, not an open door. `toChatEntries` dropped every
    // system entry, which made a silent model swap, a retry storm and a
    // compaction seam all render as literally nothing — the turn looked
    // finished. Everything still absent from this switch (stop_hook_summary,
    // turn_duration, local_command, scheduled_task_fire) stays dropped: those
    // are genuinely chrome, and the census counts 4257 of the first alone.
    if (w.kind === 'system' || w.kind === 'compact_boundary') {
      const row = systemRow(w)
      if (!row) continue
      // ONE row per failing request, not one per attempt. CC writes an
      // `api_error` entry for EVERY retry — 30 of them in one captured session
      // — so the honest row is the newest state of the same request, counting
      // up. Collapsed on `requestId`, which is exactly what identifies "the
      // same call again".
      const reqId = str(w.body, 'request_id')
      if (reqId) {
        const at = retries.get(reqId)
        if (at !== undefined) {
          out[at].text = row.text
          continue
        }
        retries.set(reqId, out.length)
      }
      out.push({
        uuid: w.uuid,
        ts: toSeconds(w.ts_ms),
        text: row.text,
        kind: row.badge,
        truncated: w.truncated || undefined,
      })
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

    if (w.kind === 'thinking') {
      // A6 register S21 — the thinking-content disclosure.
      //
      // The A1 calm view dropped these on the floor with a comment ("not part
      // of the A1 calm view"), and the register went on claiming the surface.
      // With an extended-thinking model the primary interface was silently
      // throwing away the reasoning the user had asked for. It renders
      // COLLAPSED, so the calm view is intact — the row is one line high until
      // somebody asks for the rest.
      const text = sanitiseText(textOf(w.body))
      if (!text) continue
      out.push({
        uuid: w.uuid,
        ts: toSeconds(w.ts_ms),
        text,
        kind: 'thinking',
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
      // `isMeta` — THE FLAG HALF, now that the wire carries it (finding 18).
      //
      // `recall.rs::classify_user` checks it at step 8: AFTER the wrapper and
      // image rules (6/7), BEFORE the plain-prompt fallback (9). So the arm sits
      // exactly there — a marked line that a wrapper already named keeps that
      // name, and only an unrecognised marked line is the harness aside. Rust
      // routes it to `Kind::System`; System has never been in `SURVIVING_KINDS`,
      // so dropping it here is the same outcome by the same rule.
      //
      // The one thing `recall.rs` does that this cannot is step 4's
      // `promptSource: "typed"` override, which would rescue a human who typed
      // something marked meta. It has never fired in practice — no `isMeta`
      // record in any transcript on this host carries a `promptSource` at all —
      // and the giant command dump this arm exists for carries neither.
      if (w.meta && c.kind === 'prompt') continue
      // The calm view: only the user-initiated kinds, the same rule
      // `recall.rs::Kind::is_user_initiated` applies. Everything else the
      // harness writes as a user-role line stays out.
      //
      // A delegated and a scheduled prompt belong here for the same reason a
      // typed one does: somebody deliberately asked for it — a colleague in the
      // first case, this session's owner (earlier) in the second. They were
      // omitted while this filter predated the wrappers, which made every
      // handoff invisible in the renderer that ships. `SURVIVING_KINDS` is
      // pinned to the Rust allowlist by the shared corpus in
      // `tests/unit/chat-wrapper-parity.test.ts` — neither language's switch is
      // exhaustive, so nothing else can catch the two drifting apart.
      if (!SURVIVING_KINDS.has(c.kind)) continue
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

    // attachment / system / compact_boundary / queue / mode / subagent /
    // unknown: not part of the A1 calm view.
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
 * entries the renderer actually SHOWS are fetched, and only within the newest
 * `window` of them — a reader who scrolls into an old clipped entry keeps the
 * "… clipped" marker, which is exactly what the marker is for.
 *
 * `thinking` is DRAWN since the S21 disclosure landed but is deliberately still
 * not fetched: the row opens collapsed, so a full-file scan would be spent on a
 * body nobody has asked to see. The clipped marker inside the expanded panel is
 * the honest answer, and it is one the reader chose to look at.
 */
export function truncatedUuids(
  wire: readonly WireEntry[],
  window: number,
): string[] {
  const out: string[] = []
  let seen = 0
  for (let i = wire.length - 1; i >= 0 && seen < window; i--) {
    const w = wire[i]
    // A subagent uuid must never be asked for: the renderer does not show the
    // entry, so a fetch would spend a `find_full_entry` scan on a body nothing
    // will draw. This is the ONLY thing standing between the surface and a
    // request for an entry it does not render — hence the named predicate.
    if (isSubagent(w)) continue
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

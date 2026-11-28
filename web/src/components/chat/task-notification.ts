/**
 * Claude Code `<task-notification>` envelopes → the data of one compact card.
 * ─────────────────────────────────────────────────────────────────────────────
 * When a background agent, a background command or a Monitor stops, Claude Code
 * hands the model a `<task-notification>` block as a user-role line: a task id,
 * an output path, a status, a one-line summary, and sometimes the agent's whole
 * final report (`<result>`) or the monitor's last output (`<event>`), plus
 * sentences meant for the MODEL ("If this event is something the user would act
 * on now, send a PushNotification…", the `<note>` about repeat notifications).
 *
 * The native iOS app parses the same envelope the same way, so both surfaces
 * draw the same card. The rules, agreed with it:
 *   · only a message that is ENTIRELY notification blocks qualifies — optionally
 *     inside a `<system-reminder>` that carries the `[SYSTEM NOTIFICATION - NOT
 *     USER INPUT]` preamble, whose boilerplate lines are then ignored. A prompt
 *     that merely CONTAINS a block stays a prompt.
 *   · every block must parse, or the whole message returns `null` and the caller
 *     keeps today's rendering.
 *   · the model-facing sentences and `<note>` are never part of the result.
 *
 * A tiny tag scanner, not an XML parser: the envelope is a fixed, flat shape.
 * Pure and dependency-free, like `entries.ts`.
 */

export type TaskStatus = 'done' | 'failed' | 'waiting' | 'event'

export interface TaskNotification {
  status: TaskStatus
  /** The quoted name from the summary (`Agent "X" finished` → `X`), or the
   *  whole summary when it has no recognised shape. */
  title: string
  /** What happened, in Claude Code's words minus the name: `Agent finished`,
   *  `Background command failed with exit code 149`, `Monitor stream ended`. */
  line: string
  /** Claude Code's own summary sentence, verbatim. */
  summary: string
  /** `<event>` — shown in monospace. */
  event?: string
  /** `<result>` — shown as Markdown. */
  result?: string
  /** The plumbing, labelled and in display order — task id, tool-use id,
   *  output file, usage, worktree, branch — only what the envelope carried. */
  details: [label: string, value: string][]
  /** This block's own text, `<task-notification>` to `</task-notification>`. */
  raw: string
}

/** The `ChatEntry.kind` / `ChatItem.badge` a parsed block rides under. */
export const TASK_NOTIFICATION_BADGE = 'task-notification'

const OPEN = '<task-notification>'
const CLOSE = '</task-notification>'
const WRAP_OPEN = '<system-reminder>'
const WRAP_CLOSE = '</system-reminder>'
const PREAMBLE = '[SYSTEM NOTIFICATION - NOT USER INPUT]'

/**
 * Every notification block in `text`, or `null` when `text` is not made of
 * notification blocks alone (or any block in it does not parse).
 */
export function parseTaskNotifications(text: string): TaskNotification[] | null {
  let s = text.trim()
  // Inside the harness's own wrapper, text between blocks is its boilerplate.
  // Without the preamble the wrapper earns no such allowance.
  let lenient = false
  if (s.startsWith(WRAP_OPEN) && s.endsWith(WRAP_CLOSE)) {
    s = s.slice(WRAP_OPEN.length, -WRAP_CLOSE.length)
    lenient = s.includes(PREAMBLE)
  }
  const out: TaskNotification[] = []
  let i = 0
  for (;;) {
    const at = s.indexOf(OPEN, i)
    if (!lenient && !onlyNotes(s.slice(i, at < 0 ? s.length : at))) return null
    if (at < 0) break
    const end = s.indexOf(CLOSE, at)
    if (end < 0) return null
    const block = parseBlock(s.slice(at, end + CLOSE.length))
    if (!block) return null
    out.push(block)
    i = end + CLOSE.length
  }
  return out.length > 0 ? out : null
}

/** Is this gap between blocks nothing but whitespace and `<note>…</note>`? */
function onlyNotes(gap: string): boolean {
  return gap.replace(/<note>[\s\S]*?<\/note>/g, '').trim() === ''
}

function parseBlock(raw: string): TaskNotification | null {
  // The two free-text bodies first, cut out whole (first open → last close), so
  // a report that happens to mention `<usage>` cannot be read as the usage. One
  // left open is a clipped or reshaped envelope: not clean, so no card.
  const body: Record<string, string> = {}
  const src = raw
    .slice(OPEN.length, -CLOSE.length)
    .replace(/<(result|event)>([\s\S]*)<\/\1>/g, (_, name: string, text: string) => {
      body[name] = text.trim()
      return ''
    })
  if (/<(result|event)>/.test(src)) return null
  // Every other child is a leaf (`<usage>` / `<worktree>` only group leaves),
  // so one pass over `<name>text</name>` pairs reads them all. A value holding
  // `<` simply goes unread; without a summary that means falling back.
  const f: Record<string, string | undefined> = {}
  for (const [, name, value] of src.matchAll(/<([\w-]+)>([^<]*)<\/\1>/g)) {
    f[name] = value.trim() || undefined
  }
  const summary = f.summary
  if (!summary) return null

  // `Agent "X" finished` / `Background command "X" completed (exit code 0)` /
  // `Monitor "X" stream ended`. Greedy, so a name holding quotes stays whole.
  const m = /^(Agent|Background command|Monitor) "(.+)" ([^"]+)$/s.exec(summary)
  const tail = m ? m[3] : summary
  const exit = /exit code (\d+)/.exec(tail)
  const status: TaskStatus = tail.includes('waiting on its own background work')
    ? 'waiting'
    : f.status === 'failed' || (exit !== null && exit[1] !== '0')
      ? 'failed'
      : m?.[1] === 'Monitor' && !tail.includes('stream ended')
        ? 'event'
        : 'done'
  const usage = [
    f.subagent_tokens ?? f.total_tokens,
    f.tool_uses,
    f.duration_ms,
  ].map(Number)
  return {
    status,
    title: m ? m[2] : summary,
    line: m ? `${m[1]} ${tail}` : (f.status ?? ''),
    summary,
    event: body.event || undefined,
    result: body.result || undefined,
    details: (
      [
        ['Task', f['task-id']],
        ['Tool use', f['tool-use-id']],
        ['Output', f['output-file']],
        ['Usage', usageWords(usage[0], usage[1], usage[2])],
        ['Worktree', f.worktreePath],
        ['Branch', f.worktreeBranch],
      ] as [string, string | undefined][]
    ).filter((d): d is [string, string] => !!d[1]),
    raw,
  }
}

/** `4711` → `5s`, `2137440` → `35m 37s`, `4704439` → `1h 18m`. */
export function durationWords(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** `421k tokens · 140 tool uses · 35m 37s`; a missing (NaN) number is left out. */
export function usageWords(tokens: number, toolUses: number, ms: number): string {
  const parts: string[] = []
  if (tokens >= 0) parts.push(tokens < 1_000 ? `${tokens} tokens` : `${Math.round(tokens / 1_000)}k tokens`)
  if (toolUses >= 0) parts.push(`${toolUses} tool ${toolUses === 1 ? 'use' : 'uses'}`)
  if (ms >= 0) parts.push(durationWords(ms))
  return parts.join(' · ')
}

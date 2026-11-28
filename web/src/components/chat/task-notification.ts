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
  /** `<event>` — shown in monospace. May be empty. */
  event?: string
  /** `<result>` — shown as Markdown. May be empty. */
  result?: string
  /** The plumbing, labelled and in display order — task id, tool-use id,
   *  output file, worktree, branch — only what the envelope carried. */
  details: [label: string, value: string][]
  /** `[tokens, tool uses, duration ms]`, `NaN` where the envelope has none. */
  usage: number[]
  /** This block's own text, `<task-notification>` to `</task-notification>`. */
  raw: string
}

/** The `ChatEntry.kind` / `ChatItem.badge` a parsed block rides under. */
export const TASK_NOTIFICATION_BADGE = 'task-notification'

const OPEN = '<task-notification>'
const CLOSE = '</task-notification>'
const PREAMBLE = '[SYSTEM NOTIFICATION - NOT USER INPUT]'

/**
 * Every notification block in `text`, or `null` when `text` is not made of
 * notification blocks alone (or any block in it does not parse).
 */
export function parseTaskNotifications(text: string): TaskNotification[] | null {
  const wrapped = /^<system-reminder>([\s\S]*)<\/system-reminder>$/.exec(text.trim())
  const out: (TaskNotification | null)[] = []
  const rest = (wrapped ? wrapped[1] : text).replace(
    /<task-notification>[\s\S]*?<\/task-notification>/g,
    (raw) => {
      out.push(parseBlock(raw))
      return ''
    },
  )
  if (out.length === 0 || out.includes(null)) return null
  // Inside the harness's own wrapper, the text around the blocks is its
  // boilerplate. Anywhere else only whitespace and `<note>…</note>` may sit
  // there — which is also what keeps a prompt that QUOTES a block a prompt, and
  // a clipped block (no closing tag, so never matched) out.
  if (!wrapped?.[1].includes(PREAMBLE) && rest.replace(/<note>[\s\S]*?<\/note>/g, '').trim()) {
    return null
  }
  return out as TaskNotification[]
}

function parseBlock(raw: string): TaskNotification | null {
  // The two free-text bodies first, cut out whole (first open → last close), so
  // a report that happens to mention `<usage>` cannot be read as the usage. One
  // left open is a clipped or reshaped envelope: not clean, so no card.
  const body: { result?: string; event?: string } = {}
  const src = raw
    .slice(OPEN.length, -CLOSE.length)
    .replace(/<(result|event)>([\s\S]*)<\/\1>/g, (_, name: string, text: string) => {
      body[name as 'result' | 'event'] = text.trim()
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
  const status: TaskStatus = tail.includes('waiting on its own')
    ? 'waiting'
    : f.status === 'failed' || (exit !== null && exit[1] !== '0')
      ? 'failed'
      : m?.[1] === 'Monitor' && !tail.includes('stream ended')
        ? 'event'
        : 'done'
  return {
    ...body,
    status,
    title: m ? m[2] : summary,
    line: m ? `${m[1]} ${tail}` : '',
    summary,
    details: (
      [
        ['Task', f['task-id']],
        ['Tool use', f['tool-use-id']],
        ['Output', f['output-file']],
        ['Worktree', f.worktreePath],
        ['Branch', f.worktreeBranch],
      ] as [string, string | undefined][]
    ).filter((d): d is [string, string] => !!d[1]),
    usage: [f.subagent_tokens ?? f.total_tokens, f.tool_uses, f.duration_ms].map(Number),
    raw,
  }
}

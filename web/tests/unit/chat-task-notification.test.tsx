/**
 * Claude Code `<task-notification>` messages → a compact card.
 * ─────────────────────────────────────────────────────────────────────────────
 * Fixtures in `tests/fixtures/task-notifications/`: the ten without a prefix are
 * real envelopes from a Claude Code session (usernames, home paths and a
 * personal name redacted). The `synthetic-*` ones are built from them for the
 * shapes that had no real capture: the `<system-reminder>` batch wrapper (the
 * preamble and boilerplate lines as Claude Code writes them; the batching and
 * the `<note>` wording are assumed), a
 * monitor event line, a block clipped mid-way, and a human quoting a block.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import { toDisplayList } from '../../src/components/chat/entries'
import { buildTranscript } from '../../src/components/chat/grouping'
import {
  parseTaskNotifications,
  type TaskNotification,
} from '../../src/components/chat/task-notification'
import TaskNotificationCard from '../../src/components/chat/task-notification-card'
import { ProseText, TranscriptItem } from '../../src/components/chat/transcript-item'
import type { WireEntry } from '../../src/components/chat/wire'
import { toChatEntries } from '../../src/components/chat/wire-entries'

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'task-notifications')
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.txt`), 'utf8')
const one = (name: string) => {
  const notes = parseTaskNotifications(fixture(name))
  expect(notes).not.toBeNull()
  expect(notes).toHaveLength(1)
  return notes![0]
}

/** The card's Details text for a note with this usage. */
const usageWords = (usage: number[]) => {
  const n: TaskNotification = { status: 'done', title: 't', line: '', summary: 's', details: [], usage, raw: '' }
  const html = renderToStaticMarkup(<TaskNotificationCard note={n} />)
  return /Usage: ([^<]*)/.exec(html)?.[1] ?? ''
}

const detail = (n: TaskNotification, label: string) => n.details.find(([k]) => k === label)?.[1]

const HARNESS = [
  'send a PushNotification',
  'A task-notification fires each time',
  'This agent stopped with background work',
  'NOT USER INPUT',
  'NOT a message from the user',
  'Do NOT interpret',
  'Several task notifications arrived',
]

const wire = (over: Partial<WireEntry> & { body: unknown }): WireEntry =>
  ({
    seq: 1,
    uuid: 'n1',
    kind: 'prompt',
    ts_ms: 1_767_225_600_000,
    offset: 0,
    session_id: 'conv-a',
    oversize: false,
    truncated: false,
    ...over,
  }) as unknown as WireEntry

describe('parseTaskNotifications over the real envelopes', () => {
  test('a finished agent: done, its name, the report as the body, usage in details', () => {
    const n = one('agent-result-1')
    expect(n.status).toBe('done')
    expect(n.title).toBe('Build SupermuxKit core')
    expect(n.line).toBe('Agent finished')
    expect(n.result).toStartWith('SupermuxKit is built and `scripts/test-kit.sh` passes')
    expect(n.event).toBeUndefined()
    expect(n.details.map(([k]) => k)).toEqual(['Task', 'Tool use', 'Output'])
    expect(detail(n, 'Task')).toBe('a7e5d97476a6ac5de')
    expect(detail(n, 'Tool use')).toBe('toolu_01N197gW6BGSpeMfjt6T54u6')
    expect(detail(n, 'Output')).toEndWith('/tasks/a7e5d97476a6ac5de.output')
    expect(n.usage).toEqual([420831, 140, 2137440])
    expect(usageWords(n.usage)).toBe('421k tokens · 140 tool uses · 35m 37s')
  })

  test('the worktree and branch ride along when the envelope has them', () => {
    const n = one('agent-result-2')
    expect(n.title).toBe('M1 roster and bot lifecycle')
    expect(detail(n, 'Worktree')).toBe(
      '/Users/operator/projects/supermux-ios/.claude/worktrees/agent-a09871f84c71f2c71',
    )
    expect(detail(n, 'Branch')).toBe('worktree-agent-a09871f84c71f2c71')
  })

  test('an agent waiting on its own background work is "waiting", not done', () => {
    for (const name of ['agent-waiting-1', 'agent-waiting-2']) {
      expect(one(name).status).toBe('waiting')
    }
    expect(one('agent-waiting-1').title).toBe('Scaffold iOS app shell')
    expect(one('agent-waiting-1').line).toBe('Agent is waiting on its own background work')
    expect(detail(one('agent-waiting-2'), 'Branch')).toBe('worktree-agent-ac0a2c2157d599344')
  })

  test('a background command that exited 0 is done and has no body', () => {
    const n = one('bash-1')
    expect(n).toMatchObject({ status: 'done', line: 'Background command completed (exit code 0)' })
    expect(n.title).toBe('Run Kit tests and the full app and UI test suite on the merged main')
    expect(n.result).toBeUndefined()
    expect(n.event).toBeUndefined()
    expect(usageWords(n.usage)).toBe('')
    expect(one('bash-2').status).toBe('done')
  })

  test('a failed command is failed, with its exit code', () => {
    const a = one('failed-1')
    expect(a).toMatchObject({ status: 'failed', line: 'Background command failed with exit code 149' })
    expect(a.title).toStartWith('Tighten the agent rules, then run the full phone UI suite')
    expect(one('failed-2')).toMatchObject({ status: 'failed', line: 'Background command failed with exit code 1' })
  })

  test('a monitor stream that ended is done, its event in the body, the push sentence gone', () => {
    const n = one('monitor-1')
    expect(n).toMatchObject({ status: 'done', line: 'Monitor stream ended', title: 'UI test rerun result' })
    expect(n.event).toStartWith('exit=65\n')
    expect(n.event).toEndWith('terminal-2-typed-keyboard.png')
    expect(n.result).toBeUndefined()
  })

  test('a monitor event line is an "event"', () => {
    const n = one('synthetic-monitor-event')
    expect(n).toMatchObject({ status: 'event', line: 'Monitor event', title: 'UI test rerun result' })
    expect(n.event).toBe('** TEST SUCCEEDED ** (42 tests, 0 failures)')
  })

  test('no harness sentence survives into anything the card reads', () => {
    for (const name of [
      'agent-result-1',
      'agent-result-2',
      'agent-waiting-1',
      'agent-waiting-2',
      'bash-1',
      'bash-2',
      'failed-1',
      'failed-2',
      'monitor-1',
      'monitor-2',
      'synthetic-monitor-event',
      'synthetic-wrapped-multi',
    ]) {
      for (const n of parseTaskNotifications(fixture(name))!) {
        const { raw: _raw, ...shown } = n
        const text = JSON.stringify(shown)
        for (const h of HARNESS) expect(text).not.toContain(h)
      }
    }
  })
})

describe('the message has to be notification blocks and nothing else', () => {
  test('a system-reminder batch with the preamble yields one card per block', () => {
    const notes = parseTaskNotifications(fixture('synthetic-wrapped-multi'))
    expect(notes?.map((n) => [n.status, n.title])).toEqual([
      ['done', 'Run Kit tests and the full app and UI test suite on the merged main'],
      ['failed', 'Tighten the agent rules, then run the full phone UI suite on main (Browser and iPad tests excluded for now)'],
    ])
  })

  test('several bare blocks in a row are several cards; a <note> between them is dropped', () => {
    const text = `${fixture('bash-1')}\n<note>more than one</note>\n${fixture('failed-2')}`
    expect(parseTaskNotifications(text)?.map((n) => n.status)).toEqual(['done', 'failed'])
  })

  test('a system-reminder WITHOUT the preamble earns no boilerplate allowance', () => {
    expect(parseTaskNotifications(`<system-reminder>${fixture('bash-1')}</system-reminder>`)).toHaveLength(1)
    expect(
      parseTaskNotifications(`<system-reminder>\nsome words\n${fixture('bash-1')}</system-reminder>`),
    ).toBeNull()
  })

  test('a human prompt that quotes a block stays a prompt', () => {
    expect(parseTaskNotifications(fixture('synthetic-human-quote'))).toBeNull()
    expect(parseTaskNotifications(`${fixture('bash-1')}\nwhat does this mean?`)).toBeNull()
    expect(parseTaskNotifications('just a prompt')).toBeNull()
  })

  test('a block that does not parse cleanly falls back — the whole message', () => {
    // Clipped mid-envelope (the wire cap): no closing tag.
    expect(parseTaskNotifications(fixture('synthetic-malformed-truncated'))).toBeNull()
    // No summary.
    expect(parseTaskNotifications('<task-notification><status>failed</status></task-notification>')).toBeNull()
    // A summary that never closes.
    expect(parseTaskNotifications('<task-notification><summary>Agent "x" finished</task-notification>')).toBeNull()
    // A result that never closes.
    expect(
      parseTaskNotifications('<task-notification><summary>Agent "x" finished</summary><result>half</task-notification>'),
    ).toBeNull()
    // One good block does not carry a broken one.
    expect(parseTaskNotifications(`${fixture('bash-1')}${fixture('synthetic-malformed-truncated')}`)).toBeNull()
  })

  test('a summary of no known shape keeps the sentence as the title', () => {
    const [n] = parseTaskNotifications(
      '<task-notification><status>completed</status><summary>Build finished</summary></task-notification>',
    )!
    expect(n).toMatchObject({ status: 'done', title: 'Build finished', line: '' })
  })

  test('the human-friendly numbers', () => {
    expect(usageWords([812, NaN, NaN])).toBe('812 tokens')
    expect(usageWords([1_234_567, NaN, NaN])).toBe('1.2M tokens')
    expect(usageWords([25232, 1, 4711])).toBe('25k tokens · 1 tool use · 4s')
    expect(usageWords([NaN, NaN, 4704439])).toBe('78m 24s')
  })
})

describe('the wire fold', () => {
  test('a prompt that is only a wrapped batch becomes one card row per block', () => {
    const rows = toChatEntries([wire({ body: { text: fixture('synthetic-wrapped-multi') } })])
    expect(rows.map((r) => [r.kind, r.uuid])).toEqual([
      ['task-notification', 'n1#t1'],
      ['task-notification', 'n1#t0'],
    ])
    expect(rows[1].text).toStartWith('Background command "Run Kit tests')
    expect(rows[1].reply).toStartWith('<task-notification>')
  })

  test('the server`s agent_notification row becomes the card when its envelope parses', () => {
    const [row] = toChatEntries([
      wire({
        kind: 'system',
        label: 'agent_notification',
        body: { summary: 'Agent "Build SupermuxKit core" finished', content: fixture('agent-result-1').trim() },
      }),
    ])
    expect(row.kind).toBe('task-notification')
    expect(row.text).toBe('Agent "Build SupermuxKit core" finished')
  })

  test('…and keeps the one-line row when it does not', () => {
    const [row] = toChatEntries([
      wire({
        kind: 'system',
        label: 'agent_notification',
        body: { summary: 'Agent "x" finished', content: fixture('synthetic-malformed-truncated') },
      }),
    ])
    expect(row.kind).toBe('background-agent')
  })

  test('a human prompt quoting a block is still a prompt', () => {
    const [row] = toChatEntries([wire({ body: { text: fixture('synthetic-human-quote') } })])
    expect(row.kind).toBe('prompt')
    expect(row.text).toContain('Why did this fail?')
  })
})

describe('the card', () => {
  const text = (html: string) =>
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()

  test('a finished agent: icon, name, status, a collapsed report and the details', () => {
    const n = one('agent-result-2')
    const html = renderToStaticMarkup(
      <TaskNotificationCard note={n} markdown={<ProseText text={n.result!} />} />,
    )
    expect(html).toContain('data-testid="chat-task-notification"')
    const t = text(html)
    expect(t).toContain('✓ M1 roster and bot lifecycle')
    expect(t).toContain('Agent finished')
    expect(t).toContain('I built the roster')
    // Long report → a preview with an expand control.
    expect(html).toContain('max-height')
    expect(t).toContain('Show more')
    // Plumbing behind the disclosure.
    expect(html).toContain('<details')
    expect(t).toContain('Task: a09871f84c71f2c71')
    expect(t).toContain('Tool use: toolu_01VCG72FsbwHfyNY1kgeyYJ5')
    expect(t).toContain('Usage: 414k tokens · 198 tool uses · 57m 15s')
    expect(t).toContain('Branch: worktree-agent-a09871f84c71f2c71')
    for (const h of HARNESS) expect(t).not.toContain(h)
    expect(html).not.toContain('&lt;task-notification')
  })

  test('a failed command says so, with its exit code, and has no body to expand', () => {
    const html = renderToStaticMarkup(<TaskNotificationCard note={one('failed-1')} />)
    expect(text(html)).toContain('✕ Tighten the agent rules')
    expect(text(html)).toContain('Background command failed with exit code 149')
    expect(html).not.toContain('leading-[1.45]')
    expect(html).not.toContain('Show more')
  })

  test('a monitor event is monospace, and the push sentence is not on the card', () => {
    const html = renderToStaticMarkup(<TaskNotificationCard note={one('monitor-1')} />)
    expect(html).toContain('<pre class="whitespace-pre-wrap break-words font-mono')
    expect(text(html)).toContain('** TEST FAILED **')
    expect(html).not.toContain('PushNotification')
  })

  test('the transcript draws the card, in the system voice, never a prompt bubble', () => {
    const rows = toChatEntries([wire({ body: { text: fixture('bash-1') } })])
    const nodes = buildTranscript(toDisplayList(rows), {})
    const node = nodes.find((n) => n.kind === 'item')!
    expect(node.kind === 'item' && node.speaker).toBe('system')
    const html = renderToStaticMarkup(<TranscriptItem node={node} name="vx-chat" />)
    expect(html).toContain('data-testid="chat-task-notification"')
    expect(text(html)).toContain('✓ Run Kit tests and the full app and UI test suite on the merged main')
    expect(html).not.toContain('&lt;task-notification')
    expect(html).not.toContain('data-variant')
  })
})

/**
 * T5.9 — the run history, and the surface where the honesty rule is most
 * visible.
 *
 * Three things are being protected here, and only one of them is layout:
 *
 *  1. **No machine scaffolding reaches a person.** The `<supermux-schedule>`
 *     wrapper and the `— — —` confirm footer are how the engine talks to the
 *     agent. The server strips both before storing a preview; `plainPreview`
 *     strips them again, because an old row — or a wrapper a future server adds
 *     — leaking into the UI is how a user learns to distrust everything else on
 *     the page. Two implementations of one rule is the right cost here.
 *  2. **"asked", never "sent".** supermux has no MCP client. A connector ending
 *     is an instruction delivered to a pane; whether the mail left is between
 *     the bot and its connector, and this surface does not know. The assertion
 *     is deliberately broad — no rendered string may claim a send happened.
 *  3. **One dot vocabulary.** The timeline and the list's step rail describe the
 *     same six outcomes, so they are defined once and read twice.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import {
  RunTimeline,
  STEP_STATUS,
  dayLabel,
  duration,
  plainPreview,
  runEndingLine,
  signalLabel,
} from '../../src/components/workflows/run-timeline'
import { STATUS_GLYPH } from '../../src/components/workflows/step-rail'
import type { WorkflowRunDetail, WorkflowStepRow } from '../../src/lib/api/workflows'

// Anchored to NOON today, not the wall clock: the timeline groups by local
// day, so a fixture at `Date.now() - 300` run in the first five minutes after
// midnight lands on "Yesterday" and the "Today" assertion below flakes (seen
// on CI at 00:01 UTC).
const now = (() => {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
})()

const STEPS: WorkflowStepRow[] = [
  {
    id: 'S1',
    workflow_id: 'WF-1',
    position: 0,
    title: 'Draft the summary',
    command: '',
    prompt: 'Draft it',
    files: '[]',
    connectors: '[]',
    timeout_secs: 1800,
    on_complete: '',
    created: 0,
    updated: 0,
  },
]

const RUNS: WorkflowRunDetail[] = [
  {
    run: {
      id: 9,
      workflow_id: 'WF-1',
      started_at: now - 300,
      finished_at: now - 259,
      trigger: 'tick',
      status: 'ok',
      current_step: 1,
      note: '',
      heartbeat: 0,
    },
    steps: [
      {
        id: 1,
        run_id: 9,
        step_id: 'S1',
        position: 0,
        started_at: now - 300,
        finished_at: now - 259,
        status: 'ok',
        signal: 'agent-confirmed',
        preview: 'Draft the summary of this week',
        note: '',
      },
    ],
  },
]

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>)

describe('no machine scaffolding reaches a person', () => {
  test('the wrapper is stripped, leaving the plain delivered line', () => {
    expect(
      plainPreview('<supermux-schedule id="s1" title="Weekly">Draft the summary</supermux-schedule>'),
    ).toBe('Draft the summary')
  })

  test('the confirm footer sentinel and everything after it is cut', () => {
    expect(plainPreview('Do the thing\n— — —\nWhen complete, call the hook')).toBe('Do the thing')
  })

  test('an unknown supermux tag is stripped too, not rendered raw', () => {
    expect(plainPreview('<supermux-delegation from="x">hi</supermux-delegation>')).toBe('hi')
  })

  test('empty and null degrade to an empty string, never to "undefined"', () => {
    expect(plainPreview(null)).toBe('')
    expect(plainPreview('   ')).toBe('')
  })

  test('the rendered timeline contains no `<supermux-` substring', () => {
    const html = render(<RunTimeline runs={RUNS} steps={STEPS} session="scout" />)
    expect(html).not.toContain('&lt;supermux-')
    expect(html).not.toContain('<supermux-')
    expect(html).not.toContain('— — —')
  })
})

describe('the honesty rule', () => {
  test('a connector ending says the bot was ASKED to send', () => {
    const line = runEndingLine(
      { kind: 'connector_send', connector_id: 'gmail', account_ref: 'a1', to: 'client@example.com' },
      'scout',
    )
    expect(line).toBe('scout was asked to send the summary to client@example.com.')
    expect(line).not.toContain('sent the')
  })

  test('nothing rendered claims a send happened', () => {
    const html = render(
      <RunTimeline
        runs={RUNS}
        steps={STEPS}
        session="scout"
        onComplete={{
          kind: 'connector_send',
          connector_id: 'gmail',
          account_ref: 'a1',
          to: 'client@example.com',
        }}
      />,
    )
    expect(html).toContain('was asked to send')
    for (const lie of ['was sent', 'has been sent', 'we sent', 'email sent']) {
      expect(html.toLowerCase()).not.toContain(lie)
    }
  })

  test('the other four endings are stated plainly, or not at all', () => {
    expect(runEndingLine({ kind: 'none' }, 'scout')).toBeNull()
    expect(runEndingLine({ kind: 'notify' }, 'scout')).toBe('You were notified.')
    expect(runEndingLine({ kind: 'disable' }, 'scout')).toBe(
      'The workflow paused itself afterwards.',
    )
    expect(runEndingLine({ kind: 'message_bot', session: 'inbox' }, 'scout')).toContain('inbox')
  })
})

describe('one dot vocabulary, two surfaces', () => {
  test('the timeline and the list rail describe the same six outcomes', () => {
    for (const key of Object.keys(STATUS_GLYPH)) {
      expect(STEP_STATUS[key]).toBeDefined()
    }
    for (const key of ['running', 'ok', 'skipped', 'error', 'timeout', 'interrupted']) {
      expect(STEP_STATUS[key]).toBeDefined()
    }
  })

  test('a signal is rendered in words, never as its enum value', () => {
    expect(signalLabel('agent-confirmed')).toBe('the bot said it was done')
    expect(signalLabel('status-idle')).toBe('the bot went quiet')
    expect(signalLabel('timeout')).toBe('it ran out of time')
    expect(signalLabel('interrupted')).toBe('the session went away')
  })
})

describe('runs are grouped by day and legible at a glance', () => {
  test('Today / Yesterday / a date', () => {
    const base = new Date('2026-08-24T12:00:00')
    const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)
    expect(dayLabel(at('2026-08-24T09:00:00'), base)).toBe('Today')
    expect(dayLabel(at('2026-08-23T09:00:00'), base)).toBe('Yesterday')
    expect(dayLabel(at('2026-08-20T09:00:00'), base)).toMatch(/Aug/)
  })

  test('durations read as durations', () => {
    expect(duration(0, 41)).toBe('41 s')
    expect(duration(0, 124)).toBe('2 min 4 s')
    expect(duration(0, 120)).toBe('2 min')
    expect(duration(0, null)).toBe('')
  })

  test('the header is rendered and the step is named from the workflow’s steps', () => {
    const html = render(<RunTimeline runs={RUNS} steps={STEPS} session="scout" />)
    expect(html).toContain('Today')
    expect(html).toContain('Draft the summary')
    expect(html).toContain('41 s')
    expect(html).toContain('on schedule')
  })

  test('never-run says so, and says what will show up here', () => {
    const html = render(<RunTimeline runs={[]} steps={STEPS} session="scout" />)
    expect(html).toContain('It hasn’t run yet.')
    expect(html).toContain('Every run shows up here')
  })

  test('"Open the thread here" points at the BOT’s pane', () => {
    // A run has no surface of its own — its steps land in the transcript like
    // anything a human typed, and linking anywhere else would be a lie.
    const html = render(
      <RunTimeline runs={RUNS} steps={STEPS} session="scout" expandAll />,
    )
    expect(html).toContain('/focus/scout')
    expect(html).toContain('Open the thread here')
    // …and the expanded node shows the plain delivered line and how it ended.
    expect(html).toContain('Draft the summary of this week')
    expect(html).toContain('the bot said it was done')
  })
})

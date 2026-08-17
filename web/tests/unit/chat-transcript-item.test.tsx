/**
 * `transcript-item.tsx` — one confirmed node, as pixels.
 * ─────────────────────────────────────────────────────────────────────────────
 * The pure layer (`grouping.ts`, `frames.ts`) is tested next door; what is
 * pinned here is the handful of places where this component reads the WIRE and
 * could quietly print nonsense. Every case below is built from the shape
 * `server/src/sessions/recall.rs` actually emits, run through the frozen A1
 * `toDisplayList`, so a wire change breaks the test rather than the screen:
 *
 *   · a slash command names itself ONCE (`recall.rs` puts the slash in the
 *     label AND at the head of the text — `//clear /clear` is what a naive
 *     read produces),
 *   · a colleague's arrival is announced with their own face,
 *   · a failed call stays a receipt line — no red bubble, no lost row,
 *   · an image a tool named earns a frame, and a path only becomes a `src`
 *     when something was injected to turn it into one.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { toDisplayList, type ChatEntry } from '../../src/components/chat/entries'
import { buildTranscript, entryLabels } from '../../src/components/chat/grouping'
import { TranscriptItem } from '../../src/components/chat/transcript-item'

/** Wire entries (newest-first, as `/recall?chat=true` hands them over) → HTML. */
function render(entries: ChatEntry[], extra: Record<string, unknown> = {}): string {
  const labels = entryLabels(entries)
  const nodes = buildTranscript(toDisplayList(entries), { nowMs: 1_760_000_000_000, labels })
  // The session-block divider is `grouping.ts`'s business and is asserted there;
  // here it is only noise between the rows under review.
  return nodes
    .filter((node) => node.kind === 'item')
    .map((node) =>
      renderToStaticMarkup(
        <TranscriptItem key={node.key} node={node} name="release-train" labels={labels} {...extra} />,
      ),
    )
    .join('')
}

/** Visible text, with element boundaries collapsed to one space. */
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

describe('the human', () => {
  test('a slash command names itself once', () => {
    // `<command-name>/code-review</command-name><command-args>high</…>` →
    // label `/code-review`, text `/code-review high`.
    const out = text(
      render([
        {
          uuid: 'u1',
          ts: 1_760_000_000,
          text: '/code-review high',
          kind: 'command',
          label: '/code-review',
        },
      ]),
    )
    expect(out).toContain('/code-review high')
    expect(out).not.toContain('//code-review')
  })

  test('a bare slash command is just its name', () => {
    const out = text(
      render([
        { uuid: 'u1', ts: 1_760_000_000, text: '/clear', kind: 'command', label: '/clear' },
      ]),
    )
    expect(out).toBe('/clear')
  })

  test('a typed prompt carries no chip at all', () => {
    const out = text(
      render([{ uuid: 'u1', ts: 1_760_000_000, text: 'is the release green?', kind: 'prompt' }]),
    )
    expect(out).toBe('is the release green?')
  })
})

describe('the wire cap', () => {
  // `recall.rs` clamps per kind (`ASSISTANT_MAX_CHARS` / `PROMPT_MAX_CHARS`) and
  // flags the entry it bit. A clipped message that just STOPS reads as an answer
  // that ended mid-sentence, so the flag must reach the pixels — this is the
  // A1-hardening behaviour (#59) that survived A3's rewrite of the panel.
  test('a clipped assistant answer says so', () => {
    const out = text(
      render([
        {
          uuid: 'a1',
          ts: 1_760_000_000,
          text: 'the long answer, cut at the cap',
          kind: 'assistant',
          truncated: true,
        },
      ]),
    )
    expect(out).toContain('the long answer, cut at the cap')
    expect(out).toContain('clipped')
  })

  test('a clipped prompt says so', () => {
    const out = text(
      render([
        { uuid: 'u1', ts: 1_760_000_000, text: 'a very long prompt', kind: 'prompt', truncated: true },
      ]),
    )
    expect(out).toContain('clipped')
  })

  test('an intact message carries no marker', () => {
    const out = text(
      render([{ uuid: 'a1', ts: 1_760_000_000, text: 'short and whole', kind: 'assistant' }]),
    )
    expect(out).toBe('short and whole')
  })
})

describe('a colleague', () => {
  test('arrives with their own name, once', () => {
    const out = text(
      render([
        {
          uuid: 't2',
          ts: 1_760_000_002,
          text: 'taking it.',
          kind: 'teammate',
          label: 'patch',
        },
        {
          uuid: 't1',
          ts: 1_760_000_001,
          text: 'the flaky test is a fixture race.',
          kind: 'teammate',
          label: 'patch',
        },
      ]),
    )
    expect(out).toContain('Message from patch')
    // One handover announces itself once, not once per message.
    expect(out.match(/Message from/g)).toHaveLength(1)
  })
})

describe('a schedule', () => {
  test('announces the schedule that fired it, once, with the ⏱ mark', () => {
    const out = text(
      render([
        {
          uuid: 's2',
          ts: 1_760_000_002,
          text: 'check the deploy',
          kind: 'schedule',
          label: 'Nightly release watch',
        },
        {
          uuid: 's1',
          ts: 1_760_000_001,
          text: 'check the release',
          kind: 'schedule',
          label: 'Nightly release watch',
        },
      ]),
    )
    expect(out).toContain('Sent by schedule ⏱ Nightly release watch')
    expect(out.match(/Sent by schedule/g)).toHaveLength(1)
    expect(out).toContain('check the release')
  })

  test('an unnamed schedule still says a schedule sent it', () => {
    // `recall.rs` drops a blank title rather than inventing one; the divider
    // must still name the speaker, or the prompt reads as the owner's own.
    const out = text(
      render([{ uuid: 's1', ts: 1_760_000_001, text: 'run the sweep', kind: 'schedule' }]),
    )
    expect(out).toContain('Sent by a schedule')
    expect(out).toContain('run the sweep')
  })

  test('the message is left-aligned — it is not the human’s bubble', () => {
    // `MessageRow me` right-aligns; a scheduled prompt must not take that lane.
    const html = render([
      { uuid: 's1', ts: 1_760_000_001, text: 'check the release', kind: 'schedule', label: 'Nightly' },
    ])
    expect(html).not.toContain('justify-end')
  })
})

describe('receipts', () => {
  const run: ChatEntry[] = [
    {
      uuid: 'a1#1',
      ts: 1_760_000_001,
      text: 'cargo check',
      kind: 'tool_use',
      ok: false,
      reply: 'error[E0432]: unresolved import',
    },
    { uuid: 'a1', ts: 1_760_000_001, text: "I'll check the build first.", kind: 'assistant' },
  ]

  test('the intro prose stays above the calls it introduces', () => {
    const out = text(render(run))
    expect(out.indexOf("I'll check the build first.")).toBeLessThan(out.indexOf('cargo check'))
  })

  test('a failed call says so in its outcome, and keeps its line', () => {
    const out = text(render(run))
    expect(out).toContain('cargo check')
    expect(out).toContain('failed · error[E0432]: unresolved import')
  })

  test('an image the run named earns a frame; the path needs an injector to load', () => {
    const entries: ChatEntry[] = [
      {
        uuid: 'a2',
        ts: 1_760_000_003,
        text: 'Read /opt/shots/release-run.png',
        kind: 'tool_use',
        ok: true,
      },
    ]
    const bare = render(entries)
    expect(text(bare)).toContain('release-run.png')
    expect(bare).not.toContain('<img')

    const wired = render(entries, { rawUrl: (p: string) => `/api/file/raw?path=${p}` })
    expect(wired).toContain('src="/api/file/raw?path=/opt/shots/release-run.png"')
  })
})

/**
 * INTEGRATION REGRESSION (the A3 surface swap).
 *
 * `recall.rs` clips a message at the wire cap and says so with `truncated`;
 * `entries.ts` carries the flag onto the item. The A1 panel printed a "…
 * clipped" marker for it, and the A3 surface replaced that whole render tree —
 * so the marker had to move HERE. Without it the cap is silent again and a
 * clipped answer is indistinguishable from one that simply stopped, which is
 * exactly the bug the flag was added for.
 */
describe('a clipped message says so', () => {
  test('on the human`s bubble', () => {
    const out = text(
      render([
        {
          uuid: 'u1',
          ts: 1_760_000_000,
          text: 'here is the whole log',
          kind: 'prompt',
          truncated: true,
        },
      ]),
    )
    expect(out).toContain('here is the whole log')
    expect(out).toContain('… clipped')
  })

  test('on the agent`s bubble', () => {
    const out = text(
      render([
        { uuid: 'a1', ts: 1_760_000_001, text: 'the failure is in', kind: 'assistant', truncated: true },
      ]),
    )
    expect(out).toContain('… clipped')
  })

  test('on a colleague`s bubble', () => {
    const out = text(
      render([
        {
          uuid: 't1',
          ts: 1_760_000_001,
          text: 'handing over the trace',
          kind: 'teammate',
          label: 'patch',
          truncated: true,
        },
      ]),
    )
    expect(out).toContain('… clipped')
  })

  test('and an unclipped message stays silent', () => {
    const out = text(
      render([{ uuid: 'a1', ts: 1_760_000_001, text: 'all green.', kind: 'assistant' }]),
    )
    expect(out).not.toContain('clipped')
  })
})

/**
 * THE MODEL'S REASONING, COLLAPSED (verified finding 16 — A6 register S21).
 *
 * `wire-entries.ts` dropped every `kind:'thinking'` frame and there was no
 * disclosure component anywhere in `web/src`, while the register listed S21 as
 * a shipped scenario. Three properties matter and each one fails differently:
 * the text has to REACH the DOM (or the reasoning is still thrown away), it has
 * to arrive COLLAPSED (or the calm view is gone), and the summary must never
 * invent a duration it cannot support.
 */
describe('thinking', () => {
  const thinking = (over: Partial<ChatEntry> = {}): ChatEntry => ({
    uuid: 'th',
    ts: 1_760_000_008,
    text: '91 is 7 × 13, so it is not prime.',
    kind: 'thinking',
    ...over,
  })

  test('the reasoning is in the DOM, and it is closed', () => {
    const html = render([thinking()])
    expect(html).toContain('data-testid="chat-thinking"')
    expect(html).toContain('91 is 7 × 13')
    // `<details>` renders `open` only when it IS open. The calm view is the
    // promise: one line high until somebody asks for the rest.
    expect(html).not.toMatch(/<details[^>]*\sopen\b/)
  })

  test('“Thought for Ns” is measured from the row above, never guessed', () => {
    // Newest-first, as the wire hands them over: the prompt at t+0, the
    // thinking block complete at t+8.
    const out = text(
      render([
        thinking({ ts: 1_760_000_008 }),
        { uuid: 'u1', ts: 1_760_000_000, text: 'Is 91 prime?', kind: 'prompt' },
      ]),
    )
    expect(out).toContain('Thought for 8s')
  })

  test('…and with nothing above it to measure from, it claims nothing', () => {
    const out = text(render([thinking()]))
    expect(out).toContain('Thought')
    expect(out).not.toMatch(/Thought for/)
  })
})

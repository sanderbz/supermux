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
import {
  TranscriptItem,
  isThinkingSummary,
  THINKING_SUMMARY_MAX_CHARS,
} from '../../src/components/chat/transcript-item'

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
  test('announces the schedule that fired it, once, with a clock icon (never the raw ⏱, which tofus)', () => {
    const raw = render([
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
    ])
    const out = text(raw)
    // The clock is a monochrome `ClockIcon` SVG, not the raw `⏱` (U+23F1),
    // which is absent from the bundled font and tofu'd (▯) in both themes.
    expect(out).toContain('Sent by schedule Nightly release watch')
    expect(out.match(/Sent by schedule/g)).toHaveLength(1)
    expect(out).toContain('check the release')
    expect(raw).toContain('<svg')
    expect(raw).not.toContain('⏱')
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

  // Raw extended reasoning: long, multi-paragraph — the shape older models
  // write when thinking is displayed in full.
  const RAW = [
    'Let me work through this carefully. 91 divided by 7 is 13 exactly, so it factors.',
    'That settles primality; now the follow-up about 97: 97 is not divisible by 2, 3, 5, 7 — and 11² exceeds it, so 97 is prime.',
    'I should answer both and note the method so the user can reuse it.',
  ].join('\n\n')

  test('raw reasoning is in the DOM, and it is closed', () => {
    const html = render([thinking({ text: RAW })])
    expect(html).toContain('data-testid="chat-thinking"')
    expect(html).toContain('91 divided by 7')
    // `<details>` renders `open` only when it IS open. The calm view is the
    // promise: one line high until somebody asks for the rest.
    expect(html).not.toMatch(/<details[^>]*\sopen\b/)
  })

  test('a SUMMARY reads inline — no chevron, visible without a click', () => {
    // Fable 5-family `display: summarized` thinking: one narration sentence
    // between tool calls. The terminal prints it as a plain line; so do we.
    const html = render([
      thinking({ text: 'Adding the address line under each trip, then checking the DB.', ts: 1_760_000_008 }),
      { uuid: 'u1', ts: 1_760_000_000, text: 'Add the address line', kind: 'prompt' },
    ])
    expect(html).toContain('data-testid="chat-thinking"')
    expect(html).toContain('data-summary')
    expect(html).not.toContain('<details')
    const out = text(html)
    expect(out).toContain('Adding the address line under each trip')
    expect(out).toContain('8s')
    expect(out).not.toMatch(/Thought for/)
  })

  test('the summary rule: short + one paragraph is a summary, long or multi-paragraph is not', () => {
    expect(isThinkingSummary('One quick sentence.')).toBe(true)
    expect(isThinkingSummary('')).toBe(false)
    expect(isThinkingSummary('   ')).toBe(false)
    expect(isThinkingSummary(RAW)).toBe(false)
    expect(isThinkingSummary('x'.repeat(THINKING_SUMMARY_MAX_CHARS + 1))).toBe(false)
    expect(isThinkingSummary('x'.repeat(THINKING_SUMMARY_MAX_CHARS))).toBe(true)
  })

  test('“Thought for Ns” is measured from the row above, never guessed', () => {
    // Newest-first, as the wire hands them over: the prompt at t+0, the
    // thinking block complete at t+8.
    const out = text(
      render([
        thinking({ text: RAW, ts: 1_760_000_008 }),
        { uuid: 'u1', ts: 1_760_000_000, text: 'Is 91 prime?', kind: 'prompt' },
      ]),
    )
    expect(out).toContain('Thought for 8s')
  })

  test('…and with nothing above it to measure from, it claims nothing', () => {
    const out = text(render([thinking({ text: RAW })]))
    expect(out).toContain('Thought')
    expect(out).not.toMatch(/Thought for/)
  })

  test('an empty block is a static pill: the duration, no disclosure, no “not saved” body', () => {
    // THE ONLY SHAPE THIS PRODUCT ACTUALLY SEES. Claude Code 2.1.233 writes
    // every thinking block with an empty body (20,831 on the audit host, none
    // with text), so a chevron on it is a disclosure with nothing to disclose:
    // the click opened onto one line of apology. The duration is the fact that
    // survived; the pill carries it as plain text and keeps the "not saved"
    // reason in a title / aria-label, never as a body the reader has to open.
    const html = render([
      thinking({ text: '', ts: 1_760_000_012 }),
      { uuid: 'u1', ts: 1_760_000_000, text: 'Think hard about this.', kind: 'prompt' },
    ])
    const out = text(html)
    expect(out).toContain('Thought for 12s')
    expect(html).not.toContain('<details')
    expect(out).not.toContain('not saved')
    // The fact is preserved where a hover / screen reader finds it.
    expect(html).toMatch(/title="[^"]*not saved[^"]*"/)
    expect(html).toMatch(/aria-label="[^"]*not saved[^"]*"/)
  })

  test('the static pill is not interactive; a long block still discloses', () => {
    const pill = render([
      thinking({ text: '', ts: 1_760_000_012 }),
      { uuid: 'u1', ts: 1_760_000_000, text: 'Think hard about this.', kind: 'prompt' },
    ])
    expect(pill).toContain('data-testid="chat-thinking"')
    expect(pill).toContain('data-static')
    expect(pill).not.toContain('<summary')
    expect(pill).not.toContain('data-open')
    expect(pill).not.toContain('chat-thinking-summary')
    expect(pill).not.toMatch(/cursor-pointer/)
    expect(pill).not.toContain('group-open')
    // Whitespace-only is empty too.
    const blank = render([thinking({ text: '   \n ' })])
    expect(blank).not.toContain('<details')
    expect(text(blank)).toContain('Thought')
    // The disclosure is still the shape for real reasoning text.
    const long = render([thinking({ text: RAW, ts: 1_760_000_012 })])
    expect(long).toContain('<details')
    expect(long).toContain('<summary')
    expect(long).toContain('chat-thinking-summary')
    expect(long).toContain('91 divided by 7')
  })
})

describe('a cross-session coordination event', () => {
  // The wire fold has already mapped the protocol to a calm line and a tone;
  // these pin that the row DRAWS as a compact event line and never leaks JSON.
  test('renders the calm line with the sender’s face, no raw wrapper', () => {
    const out = render([
      { uuid: 'c1', ts: 1_760_000_000, text: 'pagina-catalogus is available', kind: 'coordination', label: 'pagina-catalogus', tone: 'teammate' },
    ])
    const flat = text(out)
    expect(flat).toContain('pagina-catalogus is available')
    expect(flat).not.toContain('<teammate-message')
    expect(flat).not.toContain('{')
    // The centred event row and its tone marker are present…
    expect(out).toContain('data-testid="chat-coordination"')
    expect(out).toContain('data-tone="teammate"')
    // …and it hangs a face (an <svg> mark) because it named a teammate.
    expect(out).toContain('<svg')
  })

  test('a faceless system notice renders no mark and reads dim when quiet', () => {
    const out = render([
      { uuid: 'c2', ts: 1_760_000_000, text: 'the session ended', kind: 'coordination', tone: 'system' },
    ])
    expect(text(out)).toBe('the session ended')
    expect(out).not.toContain('<svg')
  })
})

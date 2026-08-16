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

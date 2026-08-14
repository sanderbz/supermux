/**
 * The LIVE layer, on the surface it lands on (fase A3 T4).
 * ─────────────────────────────────────────────────────────────────────────────
 * A1 shipped this layer's ORDER and its honesty; A3 only re-dresses it. So what
 * is pinned here is exactly the set of things a re-dress could quietly break:
 *
 *   · the stack order — permission, hook receipts, working row, provisional —
 *     which is the whole layer model (a0-findings §1) expressed as pixels,
 *   · the permission card reading the wire OBJECT by field (interpolating it
 *     renders `[object Object]`, and nobody notices until a screenshot),
 *   · the P12 state ladder's first rung (no number under 5s, counted from the
 *     SEND after it),
 *   · the running line being the LAST receipt — the reason the confirmed batch
 *     replacing the overlay costs zero reflow,
 *   · the delegation pill's guard: a name only becomes a colleague when it is a
 *     session that exists.
 *
 * Rendered through `<ChatSurface>` rather than in isolation, because "in the
 * documented order" is a claim about the surface, and because that is the tree
 * the boards were shot from. No react-query, SSE or `/peek` is involved: the
 * panel injects the one networked child as a slot, and here that slot is a
 * marker div.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatSurface } from '../../src/components/chat/chat-surface'
import { serverNowMs } from '../../src/components/chat/latency'
import { LiveLayer, delegationTarget } from '../../src/components/chat/live-layer'
import type { OverlayLine } from '../../src/components/chat/use-receipt-overlay'
import type { TileSession } from '../../src/components/session-tile/types'

const FOCUS = 'release-train'

/** The cast the whole design system uses, as a mention index (slug → slug). */
const KNOWN = new Map<string, string>([
  ['release-train', 'release-train'],
  ['patch', 'patch'],
  ['quill', 'quill'],
])

function session(over: Partial<TileSession> = {}): TileSession {
  return {
    name: FOCUS,
    status: 'idle',
    dir: '/opt/projects/supermux/server',
    provider: 'claude',
    preview_lines: [],
    updated_at: '2026-08-14T10:00:00Z',
    ...over,
  }
}

/** The live layer as the panel mounts it — inside the surface. */
function render(props: Partial<Parameters<typeof LiveLayer>[0]> = {}): string {
  const s = props.session === undefined ? session() : props.session
  return renderToStaticMarkup(
    <ChatSurface name={FOCUS} session={s}>
      <LiveLayer name={FOCUS} session={s} turnStart={null} mentions={KNOWN} {...props} />
    </ChatSurface>,
  )
}

/** Visible text, with element boundaries collapsed to one space. */
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const overlay = (labels: string[]): OverlayLine[] =>
  labels.map((label, i) => ({ label, at: 1_760_000_000_000 + i * 1000 }))

const running = 'data-state="running"'
const marker = <div data-testid="p13" key="p13" />

describe('the stack, top to bottom', () => {
  const html = render({
    session: session({
      status: 'active',
      activity: '⚡ cargo check',
      subagents: 3,
      permission_request: { tool: 'Bash', summary: '⚡ cargo publish --dry-run', kind: 'bash' },
    }),
    turnStart: serverNowMs() - 12_000,
    overlay: overlay(['Read', 'cargo check']),
    provisional: marker,
  })

  test('permission → overlay receipts → working row → provisional', () => {
    const at = (needle: string) => {
      const i = html.indexOf(needle)
      expect(i).toBeGreaterThan(-1)
      return i
    }
    // Confirmed content is above all of this by construction (it is the
    // surface's other child); these four are the live layer's own order.
    expect(at('chat-permission-card')).toBeLessThan(at(running))
    expect(at(running)).toBeLessThan(at('chat-working-row'))
    expect(at('chat-working-row')).toBeLessThan(at('p13'))
  })

  test('every band is actually rendered, not just ordered', () => {
    const out = text(html)
    expect(out).toContain('cargo publish --dry-run') // the ask
    expect(out).toContain('Read') // a hook receipt
    expect(out).toContain('cargo check · 3 subagents') // the working row
  })
})

describe('the four other permutations', () => {
  test('idle — nothing live is claimed', () => {
    const html = render()
    expect(html).not.toContain('chat-working-row')
    expect(html).not.toContain('chat-permission-card')
    expect(html).not.toContain(running)
  })

  test('a running turn with no anchor stays silent', () => {
    // `turnStart` is what the elapsed clause counts from; a row without one
    // would have nothing honest to say, so there is no row.
    expect(render({ session: session({ status: 'active' }) })).not.toContain('chat-working-row')
  })

  test('mid-turn — the working row, without a permission card', () => {
    const html = render({
      session: session({ status: 'active', activity: '✎ money.rs' }),
      turnStart: serverNowMs() - 30_000,
    })
    expect(html).toContain('chat-working-row')
    expect(html).not.toContain('chat-permission-card')
    expect(text(html)).toContain('money.rs')
  })

  test('provisional — the block hangs under the row, in the swap cell', () => {
    const html = render({
      session: session({ status: 'active' }),
      turnStart: serverNowMs() - 6_000,
      provisional: marker,
    })
    expect(html).toContain('p13')
    // The cell shares one grid area so the leaving block and whatever replaces
    // it overlap instead of queueing (§11.6).
    expect(html).toContain('grid-area:1 / 1')
  })

  test('permission — the card, with no turn running', () => {
    const html = render({
      session: session({
        status: 'waiting',
        permission_request: { tool: 'Bash', summary: 'git push -u origin fix/money', kind: 'bash' },
      }),
    })
    expect(html).toContain('chat-permission-card')
    expect(html).not.toContain('chat-working-row')
  })
})

describe('the permission card', () => {
  const html = render({
    session: session({
      status: 'waiting',
      mode: 'plan',
      permission_request: { tool: 'Bash', summary: '⚡ cargo publish --dry-run', kind: 'bash' },
    }),
  })

  test('never stringifies the wire object', () => {
    expect(html).not.toContain('[object Object]')
    // The activity CLASS is a machine field; if it reached the screen the card
    // would be printing the payload rather than reading it (`Bash` is the tool
    // and is capitalised — this is the lowercase wire `kind`).
    expect(html).not.toContain('bash')
  })

  test('the command is the question, the tool and its ground are the why', () => {
    const out = text(html)
    // Emoji stripped: the glyph taxonomy is terminal/tile-only, and the label
    // must be byte-close to the receipt this call will become.
    expect(out).toContain('Run cargo publish --dry-run ?')
    expect(out).not.toContain('⚡')
    expect(out).toContain('Bash · in supermux/server · plan mode')
  })

  test('a summary-less request names the tool itself', () => {
    const out = text(
      render({
        session: session({
          status: 'waiting',
          permission_request: { tool: 'WebFetch', summary: '', kind: 'web' },
        }),
      }),
    )
    expect(out).toContain('Run WebFetch ?')
  })

  test('the three registry answers, with their digits — and no way to answer', () => {
    const out = text(html)
    expect(out).toContain('Allow once')
    expect(out).toContain('Allow while this session runs')
    expect(out).toContain('Not now')
    expect(out).toMatch(/Allow once 1/)
    // A3 cannot send a key, so the card must not imply that clicking it would.
    expect(out).toContain('Answer in the terminal')
    expect(html).not.toContain('data-selected')
  })
})

describe('the working row’s first rung', () => {
  const rowAt = (agoMs: number, over: Partial<TileSession> = {}) =>
    render({
      session: session({ status: 'active', ...over }),
      turnStart: serverNowMs() - agoMs,
    })

  test('under 5s there is no number', () => {
    expect(rowAt(1_000)).not.toMatch(/>\d+s</)
  })

  test('past 5s it counts from the send', () => {
    expect(rowAt(12_000)).toContain('>12s<')
    expect(rowAt(125_000)).toContain('>2m 05s<')
  })

  test('no hook label yet — the row still says what it is', () => {
    expect(text(rowAt(1_000))).toContain('Thinking…')
  })

  test('the subagents clause survives the reskin', () => {
    expect(text(rowAt(1_000, { activity: '⚡ tests', subagents: 3 }))).toContain(
      'tests · 3 subagents',
    )
    // One sub-agent is not parallelism worth a clause (A1 rule, unchanged).
    expect(text(rowAt(1_000, { activity: '⚡ tests', subagents: 1 }))).not.toContain('subagents')
  })
})

describe('the hook receipts', () => {
  test('the last line is running — the slot the check will land in', () => {
    const html = render({
      session: session({ status: 'active' }),
      turnStart: serverNowMs() - 3_000,
      overlay: overlay(['Read', 'Grep', 'cargo check']),
    })
    const states = [...html.matchAll(/data-state="(done|running)"/g)].map((m) => m[1])
    expect(states).toEqual(['done', 'done', 'running'])
  })

  test('a single hook receipt is the running one', () => {
    const html = render({
      session: session({ status: 'active' }),
      turnStart: serverNowMs() - 3_000,
      overlay: overlay(['⚡ cargo check']),
    })
    expect([...html.matchAll(/data-state="(done|running)"/g)].map((m) => m[1])).toEqual(['running'])
    // Same stripping as the confirmed line, so the supersede never re-labels.
    expect(text(html)).toContain('cargo check')
  })
})

describe('delegation, outbound', () => {
  const asking = (activity: string, over: Partial<TileSession> = {}) =>
    render({
      session: session({ status: 'active', activity, ...over }),
      turnStart: serverNowMs() - 3_000,
    })

  test('an activity that names a session becomes the pill', () => {
    const html = asking('⚡ asking Patch for the failing job', { activity_kind: 'task' })
    // The name as the agent wrote it, on the recipient's own pigment.
    expect(text(html)).toContain('asking Patch…')
    expect(html).not.toContain('chat-working-row')
  })

  test('a task that names nobody known falls back to the working row', () => {
    const html = asking('⚡ dispatching a subagent', { activity_kind: 'task' })
    expect(html).toContain('chat-working-row')
  })

  test('delegationTarget — known names only, never the focused session', () => {
    expect(delegationTarget('asking Patch for the job', KNOWN, FOCUS)).toEqual({
      seed: 'patch',
      label: 'Patch',
    })
    // `patchwork` is a word, not a colleague (the T3 boundary rule).
    expect(delegationTarget('reading patchwork.md', KNOWN, FOCUS)).toBeUndefined()
    // The focused session cannot delegate to itself.
    expect(delegationTarget('release-train is busy', KNOWN, FOCUS)).toBeUndefined()
    expect(delegationTarget(undefined, KNOWN, FOCUS)).toBeUndefined()
  })
})

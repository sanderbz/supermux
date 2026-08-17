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
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatSurface } from '../../src/components/chat/chat-surface'
import { serverNowMs } from '../../src/components/chat/latency'
import { LiveLayer, commandChip, pendingHandoff } from '../../src/components/chat/live-layer'
import type { OverlayLine } from '../../src/components/chat/use-receipt-overlay'
import type { TileSession } from '../../src/components/session-tile/types'

const FOCUS = 'release-train'

/** The cast the whole design system uses, as a mention index (slug → slug). */
const KNOWN = new Map<string, string>([
  ['release-train', 'release-train'],
  ['patch', 'patch'],
  ['quill', 'quill'],
])

/** slug → display name, for the pill and the arrival divider. */
const NAMES = new Map<string, string>([
  ['release-train', 'Release Train'],
  ['patch', 'Patch'],
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
      <LiveLayer name={FOCUS} session={s} turnStart={null} names={NAMES} {...props} />
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

  test('permission → overlay receipts → provisional', () => {
    const at = (needle: string) => {
      const i = html.indexOf(needle)
      expect(i).toBeGreaterThan(-1)
      return i
    }
    // Confirmed content is above all of this by construction (it is the
    // surface's other child); these are the live layer's own order.
    expect(at('chat-permission-card')).toBeLessThan(at(running))
    expect(at(running)).toBeLessThan(at('p13'))
  })

  test('every band is actually rendered, not just ordered', () => {
    const out = text(html)
    expect(out).toContain('cargo publish --dry-run') // the ask
    expect(out).toContain('Read') // a hook receipt
    expect(out).toContain('cargo check') // the call that is running
    expect(out).toContain('3 subagents · 12s') // its clock, on the same line
  })

  /**
   * ONE LIVE REPRESENTATION PER TOOL CALL (daily-driver QA #7).
   *
   * The overlay group and the working row are fed by the SAME `activity`, so
   * this frame used to draw one tool call twice — `••• cargo check 12s` in the
   * group and `◌ cargo check · 3 subagents` on a pill directly under it (with
   * the permission card above, the QA counted three). The group's last line is
   * the running call; it takes the clock, and there is no second row.
   */
  test('the running call is ONE row, not a receipt plus a pill', () => {
    expect(html).not.toContain('chat-working-row')
    // Once, not twice: the label appears in the running receipt line and
    // nowhere else in the band.
    expect(text(html).split('cargo check').length - 1).toBe(1)
    expect(html).toContain('chat-receipt-status')
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

  test('the mode is named in words, never in wire', () => {
    const whyFor = (mode?: string) =>
      text(
        render({
          session: session({
            status: 'waiting',
            mode: mode as TileSession['mode'],
            permission_request: { tool: 'Bash', summary: 'git push', kind: 'bash' },
          }),
        }),
      )
    // `accept_edits` is the backend's snake_case `Mode`; printing it verbatim is
    // the same failure as stringifying the request — a wire token on the board.
    expect(whyFor('accept_edits')).toContain('in supermux/server · accept edits mode')
    expect(whyFor('accept_edits')).not.toContain('accept_edits')
    expect(whyFor('bypass')).toContain('bypass mode')
    // A mode this UI does not know is dropped, not guessed into "normal".
    const unknown = whyFor('yolo')
    expect(unknown).not.toContain('yolo')
    expect(unknown).not.toContain('mode')
    expect(unknown).toContain('Bash · in supermux/server')
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

describe('delegation, outbound (fase B4 T5 — the pill stops guessing)', () => {
  const asking = (activity: string, over: Partial<TileSession> = {}) =>
    render({
      session: session({ status: 'active', activity, ...over }),
      turnStart: serverNowMs() - 3_000,
    })

  test('an activity that NAMES a colleague draws no pill on its own', () => {
    // THE REGRESSION THIS TASK EXISTS FOR (#41/#43 class). The old rule grepped
    // the activity string for a known session name, so an agent that merely
    // wrote "I'll ask Patch about this" drew a handoff pill for a delegation
    // that never happened. Prose about a colleague and a message to one are the
    // same bytes; the only fix is to stop reading the prose.
    const html = asking('⚡ asking Patch for the failing job', { activity_kind: 'task' })
    expect(text(html)).not.toContain('asking Patch…')
    expect(html).toContain('chat-working-row')
  })

  test('a real dispatch draws one, even when the activity names nobody', () => {
    const html = render({
      session: session({ status: 'active', activity: '⚡ dispatching a subagent' }),
      turnStart: serverNowMs() - 3_000,
      handoff: { to: 'patch', atMs: Date.now() },
    })
    expect(text(html)).toContain('asking Patch…')
    expect(html).not.toContain('chat-working-row')
  })

  test('the pill outlives the turn — a hand-off is not a turn', () => {
    // A delegation dispatched from an idle session is still in flight, and the
    // old rule could only ever draw while `status === 'active'`.
    const html = render({
      session: session({ status: 'idle' }),
      handoff: { to: 'patch', atMs: Date.now() },
    })
    expect(text(html)).toContain('asking Patch…')
  })

  test('pendingHandoff — nothing in flight, nothing drawn', () => {
    expect(pendingHandoff(null, [], FOCUS)).toBeNull()
    expect(pendingHandoff(undefined, [], FOCUS)).toBeNull()
    expect(pendingHandoff({ to: '', atMs: Date.now() }, [], FOCUS)).toBeNull()
  })

  test('pendingHandoff — the LEDGER retires it, so it is never drawn twice', () => {
    // The pill resolves INTO the durable `Delegated to ●Patch` line rather than
    // sitting beside it: one delegation, one representation, at every instant.
    const atMs = Date.now()
    const landed = {
      id: 9,
      ts: Math.floor(atMs / 1000),
      actor: 'user',
      action: 'session.delegate',
      target: 'patch',
      detail: { from: FOCUS },
    }
    expect(pendingHandoff({ to: 'patch', atMs }, [landed], FOCUS)).toBeNull()
    // …but only the RIGHT row retires it.
    expect(pendingHandoff({ to: 'patch', atMs }, [{ ...landed, target: 'quill' }], FOCUS)).toBe(
      'patch',
    )
    // A row for a delegation somebody ELSE sent to Patch is not this one.
    expect(
      pendingHandoff({ to: 'patch', atMs }, [{ ...landed, detail: { from: 'quill' } }], FOCUS),
    ).toBe('patch')
    // An OLD row — the same pair, delegated an hour ago — must not retire a
    // dispatch made just now, or a repeat hand-off would never draw a pill.
    expect(
      pendingHandoff({ to: 'patch', atMs }, [{ ...landed, ts: landed.ts - 3600 }], FOCUS),
    ).toBe('patch')
  })

  test('pendingHandoff — gives up rather than hanging', () => {
    // The ledger is the only thing that resolves this pill, so a feed that is
    // erroring or disabled would otherwise leave "handing over…" on screen for
    // the rest of the session.
    expect(pendingHandoff({ to: 'patch', atMs: Date.now() - 31_000 }, [], FOCUS)).toBeNull()
  })

  test('the pill is addressable by testid — its WORD is not unique', () => {
    // "asking" is on screen in up to four places at once (the sr-only live
    // region, the chat attention row, the terminal note and this pill), so an
    // e2e that located the pill by text resolved to 4 elements and died on
    // strict mode. The testid is the pill's identity.
    const html = render({
      session: session({ status: 'idle' }),
      handoff: { to: 'patch', atMs: Date.now() },
    })
    expect(html).toContain('data-testid="chat-delegation-pill"')
  })

  test('the hand-off receipt states the delivery and promises no answer here', () => {
    // A delegation is ONE-WAY: the server delivered a prompt into a colleague's
    // pane, and whatever they answer is written in their transcript. The
    // receipt used to read "Handed to X" and then never change again — a
    // completed-exchange reading this surface cannot keep and cannot retract.
    const composer = readFileSync(
      new URL('../../src/components/chat/composer.tsx', import.meta.url),
      'utf8',
    )
    expect(composer).toContain("'handoff-sent': 'Sent to',")
    expect(composer).not.toContain("'handoff-sent': 'Handed to'")
    expect(composer).toContain('their reply lands in their pane.')
  })
})

/* ── T5: assistant prose ─────────────────────────────────────────────────── */

/**
 * Markdown is the one part of this surface that is NOT in the app bundle, and
 * the two things worth pinning follow from that:
 *
 *   1. the lazy boundary holds — nothing in the panel's static import graph
 *      reaches `react-markdown`, or the hero chunk grows by the whole
 *      unified/remark/rehype/lowlight stack and the A3 budget trips,
 *   2. the FALLBACK is a real render — the message is readable, correctly
 *      sized and already chipped before the chunk lands, because a Suspense
 *      fallback that is a spinner would make every transcript flash.
 *
 * Then the map itself: the handful of nodes where "chat markdown" differs from
 * document markdown, plus the two places a naive map is silently wrong (an
 * unlabelled fence wearing the inline chip; a soft break folded into a space,
 * which would re-flow the bubble the moment the chunk arrives).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { ChatMarkdown } from '../../src/components/chat/markdown/chat-markdown'
import { toDisplayList, type ChatEntry } from '../../src/components/chat/entries'
import { buildTranscript, entryLabels } from '../../src/components/chat/grouping'
import { ProseText, TranscriptItem } from '../../src/components/chat/transcript-item'

/** One assistant message, through the frozen A1 model and the T3 shaping. */
function assistantBubble(body: string): string {
  const entries: ChatEntry[] = [
    { uuid: 'a1', ts: 1_760_000_000, text: body, kind: 'assistant' },
  ]
  const labels = entryLabels(entries)
  const nodes = buildTranscript(toDisplayList(entries), { nowMs: 1_760_000_000_000, labels })
  return nodes
    .filter((node) => node.kind === 'item')
    .map((node) =>
      renderToStaticMarkup(
        <TranscriptItem key={node.key} node={node} name={FOCUS} labels={labels} mentions={KNOWN} />,
      ),
    )
    .join('')
}

const md = (text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) =>
  renderToStaticMarkup(<ChatMarkdown text={text} self={FOCUS} mentions={KNOWN} {...props} />)

describe('the lazy boundary', () => {
  /** Static (non-`import()`, non-`import type`) specifiers of one module. */
  const SPECIFIER = /(?:^|\n)\s*(?:import|export)\s+(?!type[\s{])[^;'"]*?from\s*['"]([^'"]+)['"]/g

  const SRC = new URL('../../src/', import.meta.url).pathname

  function resolveFile(fromFile: string, spec: string): string | null {
    const base = path.resolve(path.dirname(fromFile), spec)
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
    return null
  }

  /** Everything reachable from `entry` without a dynamic import. */
  function staticGraph(entry: string): { files: Set<string>; packages: Set<string> } {
    const files = new Set<string>()
    const packages = new Set<string>()
    const queue = [entry]
    while (queue.length > 0) {
      const file = queue.pop()!
      if (files.has(file)) continue
      files.add(file)
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.matchAll(SPECIFIER)) {
        const spec = match[1]
        if (!spec.startsWith('.')) {
          packages.add(spec)
          continue
        }
        const resolved = resolveFile(file, spec)
        if (resolved) queue.push(resolved)
      }
    }
    return { files, packages }
  }

  test('the panel never statically reaches the markdown stack', () => {
    const { files, packages } = staticGraph(`${SRC}components/chat/chat-panel.tsx`)
    // The crawl actually walked the surface — otherwise the assertion below is
    // vacuously true.
    expect(files.has(`${SRC}components/chat/transcript-item.tsx`)).toBe(true)
    const markdown = [...packages].filter((p) =>
      /^(react-markdown|remark|rehype|unified|lowlight|highlight\.js)/.test(p),
    )
    expect(markdown).toEqual([])
    expect(files.has(`${SRC}components/chat/markdown/chat-markdown.tsx`)).toBe(false)
    expect(files.has(`${SRC}components/chat/markdown/chat-components.tsx`)).toBe(false)
  })

  test('…because the one edge to it is an `import()`', () => {
    const item = fs.readFileSync(`${SRC}components/chat/transcript-item.tsx`, 'utf8')
    expect(item).toContain("React.lazy(() => import('./markdown/chat-markdown'))")
    // And the guard is meaningful: that module really is where the stack lives.
    const chunk = fs.readFileSync(`${SRC}components/chat/markdown/chat-markdown.tsx`, 'utf8')
    expect(chunk).toContain("from 'react-markdown'")
  })
})

describe('the Suspense fallback', () => {
  test('is the message itself, at the bubble’s own metrics', () => {
    // The Suspense fallback IS `ProseText` (transcript-item.tsx). Render it
    // directly rather than through `TranscriptItem`'s lazy boundary: whether
    // renderToStaticMarkup shows the fallback or the resolved `ChatMarkdown`
    // depends on whether any earlier test in the shared process already
    // resolved the lazy import — order-dependent, and the reason this used to
    // pass alone but fail in a full-suite run once CI started running it.
    const html = renderToStaticMarkup(
      <ProseText text={'Ran `cargo check` on the workspace.\nClean.'} mentions={KNOWN} />,
    )
    // The raw source, whitespace kept, so the block occupies the same height
    // the typeset version will — no spinner, no skeleton, no empty box.
    expect(html).toContain('whitespace-pre-wrap')
    expect(text(html)).toContain('Ran `cargo check` on the workspace. Clean.')
    expect(html).not.toContain('<p class=')
  })

  test('chips a colleague before the chunk lands', () => {
    // A mention is a fact about the message, not a styling of it.
    const html = assistantBubble('Handing the failing job to patch.')
    expect(html).toContain('sm-ink-accent')
    expect(text(html)).toContain('patch')
  })
})

describe('the chat markdown map', () => {
  test('a single newline stays a line break (the fallback-parity rule)', () => {
    // CommonMark folds a soft break into a space; the fallback does not. If
    // these two disagree the bubble re-flows the moment the chunk arrives.
    expect(md('first line\nsecond line')).toContain('<br/>')
    expect(md('first line\nsecond line')).toContain('second line')
  })

  test('inline code is the B0 chip, a fence is the B0 code block', () => {
    const inline = md('run `cargo check` first')
    expect(inline).toContain('font-mono')
    expect(inline).not.toContain('<pre')

    const fenced = md('```rust\nfn main() {}\n```')
    expect(fenced).toContain('<pre')
    expect(fenced).toContain('bg-code-bg')
  })

  test('an unlabelled fence is a fence, not an inline chip', () => {
    const html = md('```\nno language here\n```')
    const pre = html.slice(html.indexOf('<pre'))
    // The chip's pill (`bg-fill-soft`, radius 8) must not appear inside a block.
    expect(pre).not.toContain('bg-fill-soft')
    expect(pre).toContain('sm-fence')
  })

  test('highlighting is opt-in per fence — an undeclared block stays plain', () => {
    expect(md('```rust\nfn main() {}\n```')).toContain('hljs')
    expect(md('```\nfn main() {}\n```')).not.toContain('hljs')
  })

  test('a colleague inside prose becomes a chip; the speaker does not', () => {
    const html = md('asked patch, ignored release-train')
    expect(html).toContain('sm-ink-accent')
    // `mentionSegments` drops the speaker's own name — its face is already in
    // the gutter of this very row.
    expect(html.match(/class="sm-mark"/g)?.length).toBe(1)
  })

  test('a name inside code is code, never a colleague', () => {
    expect(md('`patch --dry-run`')).not.toContain('sm-mark')
  })

  test('a wide table scrolls inside its own box', () => {
    const html = md('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('<table')
  })

  test('the table rule runs across every row, and stops at the last one', () => {
    // `last:` on a `td` is the last CELL of a row — the right-hand column —
    // which erases that column's rules and doubles the edge under the last row.
    // The rule is scoped to the last ROW on the table instead.
    const html = md('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    expect(html).toContain('[&amp;_tr:last-child_td]:border-b-0')
    const cells = html.match(/<td[^>]*>/g) ?? []
    expect(cells.length).toBe(4)
    for (const cell of cells) expect(cell).not.toContain('last:border-b-0')
  })

  test('a task item wears its checkbox instead of a bullet, not both', () => {
    const html = md('- [x] shipped\n- [ ] written down')
    expect(html).toContain('task-list-item')
    expect(html).toContain('list-none')
    expect(html).toContain('type="checkbox"')
    // A transcript records a state; it never offers to change it.
    expect(html).toContain('disabled')
  })

  test('an image is the captured frame, and only fetches when it can', () => {
    // No injected `rawUrl` → B0's honest placeholder, never a broken <img>.
    expect(md('![shot](/tmp/shot.png)')).not.toContain('<img')
    const wired = md('![shot](/tmp/shot.png)', { rawUrl: (p: string) => `/api/file/raw?path=${p}` })
    expect(wired).toContain('/api/file/raw?path=/tmp/shot.png')
    // The frame is a block: it replaces the paragraph rather than sitting in it
    // (a `<div>` inside a `<p>` is a browser-closed paragraph and a broken row).
    expect(wired).not.toContain('<p class')
  })
})

/**
 * The question's frame supplies the verb, so the command must not supply it
 * twice. Claude's own Bash `description` — which `activity.rs` prefers over the
 * raw command — is imperative English, so the summary that reaches this card is
 * almost always "Run <command>". Observed on the real app: the phone card asked
 * "Run `Run cowsay-nonexistent --version`?" (mobile proof,
 * 11-permission-card-light.png).
 */
describe('the command chip does not repeat the question’s verb', () => {
  test('a leading "Run " is the frame’s, not the command’s', () => {
    expect(commandChip('Run cowsay-nonexistent --version')).toBe('cowsay-nonexistent --version')
    expect(commandChip('run npm test')).toBe('npm test')
  })

  test('any other verb is the description’s own and stays', () => {
    expect(commandChip('Check the git status')).toBe('Check the git status')
    expect(commandChip('running the test suite')).toBe('running the test suite')
  })

  test('a command that is only the word Run keeps it (never render an empty chip)', () => {
    expect(commandChip('Run')).toBe('Run')
    expect(commandChip('  ')).toBe('  ')
  })
})

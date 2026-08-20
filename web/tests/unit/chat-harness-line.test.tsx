/**
 * The harness line — the transcript as a management log (Task 5).
 * ─────────────────────────────────────────────────────────────────────────────
 * `grouping.ts` decides WHICH ledger rows become lines (asserted next door in
 * `chat-grouping.test.ts`); this pins what each of them SAYS, and the one thing
 * a screenshot could never prove: that the entity in the sentence is wired to
 * somewhere.
 *
 * Why the tree is walked instead of clicked: there is no DOM in this runner
 * (every unit test here is `renderToStaticMarkup`), so the proof is the
 * `onClick` prop React itself would call — found on the element, invoked, and
 * the callback observed. Adding a DOM library to click a button would buy less
 * certainty for a dependency.
 *
 * B4 T3 gave the chip a second, cheaper tell: with no handler it renders a
 * `<span>` rather than a `<button>`, so the affordance follows the capability.
 * That half lives in `chat-chip-navigation.test.tsx` along with the schedule
 * chip's destination and the zero-layout-cost invariant.
 */
import { describe, expect, test } from 'bun:test'
import type { ReactElement, ReactNode } from 'react'
import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createElement } from 'react'

import type { HarnessEvent } from '../../src/lib/api/harness'
import { HarnessLine, HarnessRunLine } from '../../src/components/chat/transcript-item'
import { MentionChip, SystemEntity } from '../../src/components/chat/ui'

const ev = (over: Partial<HarnessEvent>): HarnessEvent => ({
  id: 1,
  ts: 1_760_000_000,
  actor: 'user',
  action: 'session.delegate',
  target: 'deploy-fix',
  detail: {},
  ...over,
})

/** Every element in the tree `HarnessLine` returns, depth-first. */
function elements(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = []
  const visit = (n: ReactNode) => {
    if (Array.isArray(n)) {
      for (const child of n) visit(child as ReactNode)
      return
    }
    if (!isValidElement(n)) return
    out.push(n)
    visit((n.props as { children?: ReactNode }).children)
  }
  visit(node)
  return out
}

const findByType = (node: ReactNode, type: unknown): ReactElement | undefined =>
  elements(node).find((el) => el.type === type)

/** Visible text, with element boundaries collapsed to one space. */
const text = (node: ReactNode) =>
  renderToStaticMarkup(node as ReactElement)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('a delegation this session sent', () => {
  const outbound = ev({ action: 'session.delegate', target: 'deploy-fix', detail: { from: 'web-ui' } })

  test('names the colleague it went to', () => {
    const names = new Map([['deploy-fix', 'Deploy Fix']])
    expect(text(HarnessLine({ ev: outbound, names }))).toBe('Delegated to Deploy Fix')
  })

  test('the chip is the target’s own seed, so its colour matches its face', () => {
    const chip = findByType(HarnessLine({ ev: outbound }), MentionChip)
    expect(chip?.props).toMatchObject({ seed: 'deploy-fix' })
  })

  test('and clicking it navigates to that session', () => {
    // The whole point of the line: the chip is a destination, not decoration.
    const opened: string[] = []
    const chip = findByType(
      HarnessLine({ ev: outbound, onOpenSession: (slug) => opened.push(slug) }),
      MentionChip,
    )
    const onClick = (chip?.props as { onClick?: () => void }).onClick
    expect(onClick).toBeTypeOf('function')
    onClick?.()
    expect(opened).toEqual(['deploy-fix'])
  })

  test('with nowhere to go, the chip carries no handler', () => {
    const chip = findByType(HarnessLine({ ev: outbound }), MentionChip)
    expect((chip?.props as { onClick?: () => void }).onClick).toBeUndefined()
  })
})

describe('a folded run of delegations (the anti-wall)', () => {
  const run = (n: number, target = 'ipc'): HarnessEvent[] =>
    Array.from({ length: n }, (_, i) =>
      ev({ id: 200 + i, action: 'session.delegate', target, detail: { from: 'web-ui' } }),
    )

  test('collapses many delegations to ONE line that names the count', () => {
    // The resting state of a wall of 12 identical "Delegated to ●ipc" lines is
    // a single line — the count is on screen, the 12 rows are not.
    const html = renderToStaticMarkup(createElement(HarnessRunLine, { evs: run(12) }))
    // One grouped node, carrying the count the fold stands for.
    expect(html).toContain('data-count="12"')
    // The collapsed line is a single `role="note"` SystemLine, not twelve.
    expect(html.match(/role="note"/g) ?? []).toHaveLength(1)
    // It reads as the busy back-and-forth it is: one colleague, N times.
    const flat = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    expect(flat).toContain('Delegated to')
    expect(flat).toContain('×12')
  })

  test('a single chip is drawn, not one per event', () => {
    // Twelve delegations to one bot draw ONE mention chip in the collapsed line
    // (the busy case), never a stack of twelve.
    const html = renderToStaticMarkup(createElement(HarnessRunLine, { evs: run(12) }))
    expect(html.match(/data-seed/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  test('a mixed-target run reads as a plain count, no wall of chips', () => {
    const evs = [
      ev({ id: 1, action: 'session.delegate', target: 'ipc' }),
      ev({ id: 2, action: 'session.delegate', target: 'deploy-fix' }),
      ev({ id: 3, action: 'session.delegate', target: 'web-ui' }),
    ]
    const html = renderToStaticMarkup(createElement(HarnessRunLine, { evs }))
    const flat = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    expect(flat).toContain('3 delegations')
    expect(html).toContain('data-count="3"')
  })
})

describe('a session that renamed itself', () => {
  test('says what it is called now', () => {
    const node = HarnessLine({
      ev: ev({ actor: 'agent:web-ui', action: 'session.rename', target: 'web-ui', detail: { from: 'a', to: 'b' } }),
    })
    expect(text(node)).toBe('Renamed itself to b')
  })
})

describe('schedules', () => {
  const created = ev({
    action: 'schedule.create',
    target: 'sched-1',
    detail: { session: 'web-ui', title: 'Nightly release watch' },
  })

  test('a created schedule names itself, under a rendered clock icon (never the raw ⏱, which tofus)', () => {
    // The schedule marker is a monochrome `ClockIcon` SVG, not the raw `⏱`
    // (U+23F1): that codepoint is absent from the surface's bundled font and
    // shipped as a tofu box (▯) in both themes. So the sentence is just the
    // words, and the icon is proven by the SVG being present with no `⏱` text.
    const node = HarnessLine({ ev: created })
    expect(text(node)).toBe('Created schedule · Nightly release watch')
    const html = renderToStaticMarkup(node as ReactElement)
    expect(html).toContain('<svg')
    expect(html).not.toContain('⏱')
  })

  test('a fire reads as a fire, not as a creation', () => {
    const node = HarnessLine({
      ev: ev({ action: 'schedule.run', target: 'sched-1', detail: { title: 'Nightly release watch', status: 'ok' } }),
    })
    expect(text(node)).toBe('Ran schedule · Nightly release watch')
    expect(renderToStaticMarkup(node as ReactElement)).not.toContain('⏱')
  })

  test('a failed fire is the same sentence in the error tone — a log line, not an alarm', () => {
    const failed = HarnessLine({
      ev: ev({ action: 'schedule.run', target: 'sched-1', detail: { title: 'Nightly', status: 'error' } }),
    })
    expect(text(failed)).toBe('Ran schedule · Nightly')
    expect(renderToStaticMarkup(failed as ReactElement)).toContain('text-status-error')
    const ok = HarnessLine({
      ev: ev({ action: 'schedule.run', target: 'sched-1', detail: { title: 'Nightly', status: 'ok' } }),
    })
    expect(renderToStaticMarkup(ok as ReactElement)).not.toContain('text-status-error')
  })

  test('the schedule entity degrades to plain emphasis until it has a destination', () => {
    // `SystemEntity` renders `<b>` without an `onClick`; the Schedules sheet
    // that would supply one is a later task, and the line ships useful now.
    const node = HarnessLine({ ev: created })
    const entity = findByType(node, SystemEntity)
    expect((entity?.props as { onClick?: () => void }).onClick).toBeUndefined()
    expect(renderToStaticMarkup(node as ReactElement)).toContain('<b')
  })

  test('a schedule with no title is still an honest line', () => {
    // Pre-existing `schedule.run` rows predate the `title` key (Task 4); they
    // must not render as "Ran schedule · ⏱ undefined".
    const node = HarnessLine({ ev: ev({ action: 'schedule.run', target: 'sched-1', detail: { status: 'ok' } }) })
    expect(text(node)).toBe('Ran schedule')
    expect(renderToStaticMarkup(node as ReactElement)).not.toContain('⏱')
  })
})

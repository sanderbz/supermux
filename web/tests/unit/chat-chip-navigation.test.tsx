/**
 * Fase B4 T3 — every entity chip has a destination, or is honestly not a chip.
 * ─────────────────────────────────────────────────────────────────────────────
 * B0 shipped the chip MECHANIC pixel-exact and left every `onClick` unwired.
 * This file is the contract for wiring it, and it asserts the two halves that
 * a screenshot can never see:
 *
 *   1. THE AFFORDANCE FOLLOWS THE CAPABILITY. A chip that can navigate is a
 *      `<button>`; a chip that cannot is a `<span>`/`<b>`. Before B4 a mention
 *      was a `<button>` unconditionally, which promised a click that did
 *      nothing and put a tab stop on every colleague's name in the transcript.
 *   2. THE SENTENCE DOES NOT MOVE. The hover pill is bought with negative
 *      margins that exactly cancel its padding, so the interactive and
 *      non-interactive variants occupy identical space. A future "let's just
 *      add px-1" would shift the line the moment a session comes online.
 *
 * No DOM in this runner (`renderToStaticMarkup`), so a click is proved the way
 * React itself would deliver it: find the element, read its `onClick`, call it,
 * observe the callback. That is more certain than a synthetic event and costs
 * no dependency.
 */
import { describe, expect, test } from 'bun:test'
import type { ReactElement, ReactNode } from 'react'
import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { HarnessEvent } from '../../src/lib/api/harness'
import {
  HarnessLine,
  ProseText,
  type ScheduleRef,
} from '../../src/components/chat/transcript-item'
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

const allOfType = (node: ReactNode, type: unknown): ReactElement[] =>
  elements(node).filter((el) => el.type === type)

const firstOfType = (node: ReactNode, type: unknown): ReactElement | undefined =>
  allOfType(node, type)[0]

const clickOf = (el: ReactElement | undefined): (() => void) | undefined =>
  (el?.props as { onClick?: () => void } | undefined)?.onClick

const html = (node: ReactNode) => renderToStaticMarkup(node as ReactElement)

const INDEX = new Map([
  ['deploy-fix', 'deploy-fix'],
  ['patchwork', 'patchwork'],
])

/* ── 1. the harness line's session chip ──────────────────────────────────── */

describe('the colleague a delegation went to', () => {
  const outbound = ev({ action: 'session.delegate', target: 'deploy-fix', detail: { from: 'web-ui' } })

  test('is a button when there is somewhere to send the click', () => {
    const opened: string[] = []
    const node = HarnessLine({ ev: outbound, onOpenSession: (s) => opened.push(s) })
    expect(html(node)).toContain('<button')
    clickOf(firstOfType(node, MentionChip))?.()
    expect(opened).toEqual(['deploy-fix'])
  })

  test('and is NOT a button when there is not', () => {
    // The bench, a static render, and any surface without a router all land
    // here. An inert `<button>` is a lie the keyboard has to walk through.
    const node = HarnessLine({ ev: outbound })
    expect(clickOf(firstOfType(node, MentionChip))).toBeUndefined()
    expect(html(node)).not.toContain('<button')
    expect(html(node)).toContain('<span')
  })
})

/* ── 2. a mention in prose ───────────────────────────────────────────────── */

// `ProseText` holds a `useMemo`, so it is a COMPONENT here rather than a
// function to call: the tree is read through its markup. The chip's own
// pigment class is what marks one in the output.
// `class="sm-ink-accent`, not the bare token: the same string appears twice
// more per chip as the `--sm-ink-accent-*` custom properties.
const CHIP_MARKER = 'class="sm-ink-accent'
const chips = (markup: string) => markup.split(CHIP_MARKER).length - 1

describe('a colleague named in prose', () => {
  const line = 'I asked deploy-fix to take the rebase.'

  test('becomes a button when the name resolves in the index', () => {
    const markup = html(
      <ProseText text={line} mentions={INDEX} self="web-ui" onOpenSession={() => {}} />,
    )
    expect(chips(markup)).toBe(1)
    expect(markup).toContain('<button')
    expect(markup).toContain('deploy-fix')
  })

  test('stays inert prose when the surface has no destination for it', () => {
    const markup = html(<ProseText text={line} mentions={INDEX} self="web-ui" />)
    expect(chips(markup)).toBe(1)
    expect(markup).not.toContain('<button')
  })

  test('a word that is not a session is never chipped, handler or no handler', () => {
    // The "no regex over arbitrary words" rule belongs to `mentionSegments`;
    // T3 only decides what a click does. Asserted here so a future navigation
    // change cannot quietly widen what counts as a mention.
    const markup = html(
      <ProseText
        text="the patchwork of tests is fine"
        mentions={new Map([['deploy-fix', 'deploy-fix']])}
        self="web-ui"
        onOpenSession={() => {}}
      />,
    )
    expect(chips(markup)).toBe(0)
    expect(markup).not.toContain('<button')
  })

  test('the speaker’s own name in its own bubble is not a chip', () => {
    const markup = html(
      <ProseText
        text="deploy-fix here, on it"
        mentions={INDEX}
        self="deploy-fix"
        onOpenSession={() => {}}
      />,
    )
    expect(chips(markup)).toBe(0)
  })
})

/* ── 3. the schedule entity ──────────────────────────────────────────────── */

describe('the ⏱ chip in a schedule line', () => {
  const created = ev({
    action: 'schedule.create',
    target: 'SCHED-1a2b3c4d',
    detail: { session: 'web-ui', title: 'Nightly release watch' },
  })

  test('is plain emphasis until a Schedules sheet exists to receive it', () => {
    const node = HarnessLine({ ev: created })
    expect(clickOf(firstOfType(node, SystemEntity))).toBeUndefined()
    expect(html(node)).toContain('<b')
  })

  test('becomes a button once one does, carrying BOTH the id and the title', () => {
    // The id is what lets the sheet scroll to a row; the title is what an old
    // ledger row (written before the id was in `detail`) can still offer.
    const seen: ScheduleRef[] = []
    const node = HarnessLine({ ev: created, onOpenSchedule: (r) => seen.push(r) })
    clickOf(firstOfType(node, SystemEntity))?.()
    expect(seen).toEqual([{ id: 'SCHED-1a2b3c4d', title: 'Nightly release watch' }])
    expect(html(node)).toContain('<button')
  })

  test('a fire opens the same destination as a creation', () => {
    const seen: ScheduleRef[] = []
    const node = HarnessLine({
      ev: ev({
        action: 'schedule.run',
        target: 'SCHED-1a2b3c4d',
        detail: { session: 'web-ui', title: 'Nightly', status: 'ok' },
      }),
      onOpenSchedule: (r) => seen.push(r),
    })
    clickOf(firstOfType(node, SystemEntity))?.()
    expect(seen).toEqual([{ id: 'SCHED-1a2b3c4d', title: 'Nightly' }])
  })

  test('a titleless row offers no chip at all — there is nothing to name', () => {
    const node = HarnessLine({
      ev: ev({ action: 'schedule.run', target: 'SCHED-x', detail: { status: 'ok' } }),
      onOpenSchedule: () => {},
    })
    expect(allOfType(node, SystemEntity)).toHaveLength(0)
  })
})

/* ── 4. zero layout cost, both ways ──────────────────────────────────────── */

/** The class attribute of the outermost element of a render. */
function boxClasses(node: ReactNode): string {
  const m = /class="([^"]*)"/.exec(html(node))
  return m?.[1] ?? ''
}

/** The margin/padding pair the chip mechanic depends on. */
const geometry = (cls: string) =>
  cls
    .split(/\s+/)
    .filter((c) => /^-?[mp][a-z]?-/.test(c))
    .sort()

describe('a chip costs the same layout whether or not it is clickable', () => {
  test('MentionChip: the interactive and inert variants carry one geometry', () => {
    const inert = boxClasses(<MentionChip seed="deploy-fix" />)
    const live = boxClasses(<MentionChip seed="deploy-fix" onClick={() => {}} />)
    expect(geometry(live)).toEqual(geometry(inert))
    // …and the pair is genuinely cancelling: every negative margin has its
    // padding twin, which is what makes the hover pill free.
    expect(geometry(inert)).toContain('my-[-1px]')
    expect(geometry(inert)).toContain('py-px')
    expect(geometry(inert)).toContain('ml-[-3px]')
    expect(geometry(inert)).toContain('pl-[3px]')
    expect(geometry(inert)).toContain('mr-[-5px]')
    expect(geometry(inert)).toContain('pr-[5px]')
  })

  test('SystemEntity: the `<b>` occupies the same box as the `<button>`', () => {
    // The `<b>` has no padding AND no negative margin; the button has both, and
    // they cancel. Net width identical, which is why a schedule chip gaining a
    // destination does not reflow the sentence around it.
    const inert = geometry(boxClasses(<SystemEntity>Nightly</SystemEntity>))
    const live = geometry(boxClasses(<SystemEntity onClick={() => {}}>Nightly</SystemEntity>))
    expect(inert).toEqual([])
    expect(live).toEqual(
      ['my-[-1px]', 'py-px', 'ml-[-3px]', 'pl-[3px]', 'mr-[-5px]', 'pr-[5px]'].sort(),
    )
  })

  test('the hover transition is the 120ms speed, and only on the live variant', () => {
    // A6/T6.2 — `sm-t-hover` IS the 120ms speed; the literal it replaced is now
    // in globals.css, where `tests/unit/motion-tokens.test.ts` pins the number.
    expect(boxClasses(<MentionChip seed="x" onClick={() => {}} />)).toContain('sm-t-hover')
    expect(boxClasses(<MentionChip seed="x" />)).not.toContain('sm-t-hover')
  })
})

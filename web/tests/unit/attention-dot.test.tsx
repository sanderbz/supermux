/**
 * The attention dot, as DRAWN — the render half of "the unread tier was
 * unreachable AND invisible".
 *
 * `lib/attention-tiers.ts` has computed three tiers since B2. Two of them were
 * drawn: `needs` got the 7px dot, `working`/`quiet` got nothing — and `unread`
 * also got nothing, because `attentionFor` set `dot: tier === 'needs'` and every
 * consumer drew that single boolean. An unread row was therefore pixel-identical
 * to a quiet one, which is the same as not having the tier.
 *
 * These assert on the PRIMITIVE (`RosterRow`), which is what the overview's list
 * view, the focus strip and every picker render, so one fix covers all three.
 * The tile's own copy of the dot is covered by the roster e2e, where the tier is
 * produced by the real hook against a real backend rather than by a prop.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { RosterRow } from '../../src/components/chat/ui/roster-row'
import { ATTENTION_DOT } from '../../src/components/chat/ui/metrics'

const html = (attention: Parameters<typeof RosterRow>[0]['attention']): string =>
  renderToStaticMarkup(<RosterRow seed="supermux" name="supermux" attention={attention} />)

describe('the dot distinguishes the two visible tiers', () => {
  test('`needs` draws the loud dot', () => {
    const out = html('needs')
    expect(out).toContain('data-attention-kind="needs"')
    expect(out).toContain(ATTENTION_DOT.color)
  })

  test('`unread` draws its OWN dot — it used to draw nothing at all', () => {
    const out = html('unread')
    expect(out).toContain('data-attention-kind="unread"')
    // Different pigment AND different diameter, so the two tiers are separable
    // at a glance and not merely "a dot is present".
    expect(out).toContain(ATTENTION_DOT.unreadColor)
    expect(out).not.toContain(ATTENTION_DOT.color)
    expect(ATTENTION_DOT.unreadSize).toBeLessThan(ATTENTION_DOT.size)
  })

  test('the two dots are not interchangeable markup', () => {
    expect(html('needs')).not.toBe(html('unread'))
  })

  test('no tier draws no dot', () => {
    expect(html(undefined)).not.toContain('data-vr="attention-dot"')
    expect(html(false)).not.toContain('data-vr="attention-dot"')
  })

  test('the legacy boolean still means `needs` — no call site changed meaning', () => {
    expect(html(true)).toContain('data-attention-kind="needs"')
  })
})

describe('both dots share one seat', () => {
  test('a row escalating unread → needs does not make the dot jump', () => {
    // Same centre, different diameter: the seat is a property of the silhouette,
    // not of the news. Extracted from the inline style so the assertion is about
    // geometry rather than about a class name.
    const centre = (out: string): { x: number; y: number } => {
      // Scoped to the DOT's own style attribute — the row draws several
      // positioned boxes and a document-wide regex would sample the mark's.
      const style = /data-vr="attention-dot"[^>]*style="([^"]*)"/.exec(out)?.[1] ?? ''
      const num = (prop: string) =>
        Number(new RegExp(`${prop}:\\s*([-\\d.]+)px`).exec(style)?.[1])
      const size = num('width')
      return { x: num('left') + size / 2, y: num('top') + size / 2 }
    }
    const a = centre(html('needs'))
    const b = centre(html('unread'))
    expect(Number.isFinite(a.x)).toBe(true)
    expect(b.x).toBeCloseTo(a.x, 5)
    expect(b.y).toBeCloseTo(a.y, 5)
  })
})

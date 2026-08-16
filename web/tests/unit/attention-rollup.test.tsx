/**
 * `<AttentionRollup>` — the header's "needs you: N" cluster (fase B2 T6).
 *
 * Rendered with `renderToStaticMarkup` inside a `MemoryRouter` (it navigates).
 * What is asserted is the three rules that make it a signal rather than chrome:
 * nothing at N=0, oldest-waiting first, and a collapse to three faces + "+N".
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import { AttentionRollup, rollupTarget } from '../../src/components/roster/attention-rollup'
import { rollup, type AttentionSession } from '../../src/lib/attention-tiers'

const NOW = 1_800_000_000_000

const waiting = (name: string, agoMs: number): AttentionSession => ({
  name,
  status: 'waiting',
  activity_at: NOW - agoMs,
})

const html = (sessions: readonly AttentionSession[]): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AttentionRollup sessions={sessions} />
    </MemoryRouter>,
  )

describe('N = 0 renders nothing — no empty chrome', () => {
  test('an empty list produces no markup at all', () => {
    expect(html([])).toBe('')
  })

  test('a roster where nobody is blocked produces no rollup', () => {
    const rows: AttentionSession[] = [
      { name: 'calm', status: 'idle', activity_at: NOW },
      { name: 'busy', status: 'active', activity_at: NOW },
    ]
    expect(html(rollup(rows, new Map(), NOW))).toBe('')
  })
})

describe('N = 1..3 — a face each', () => {
  test('one member, named and counted', () => {
    const out = html([waiting('supermux', 1000)])
    expect(out).toContain('needs you: 1')
    expect(out).toContain('data-session="supermux"')
    expect(out).not.toContain('attention-rollup-overflow')
  })

  test('three members, three faces, no overflow chip', () => {
    const out = html([waiting('a', 3000), waiting('b', 2000), waiting('c', 1000)])
    expect(out).toContain('needs you: 3')
    expect(out.match(/data-vr="attention-rollup-member"/g)?.length).toBe(3)
    expect(out).not.toContain('attention-rollup-overflow')
  })
})

describe('N > 3 collapses to three marks and a +N', () => {
  test('nine members render three faces and "+6"', () => {
    const nine = Array.from({ length: 9 }, (_, i) => waiting(`s-${i}`, (i + 1) * 1000))
    const out = html(rollup(nine, new Map(), NOW))
    expect(out).toContain('needs you: 9')
    expect(out.match(/data-vr="attention-rollup-member"/g)?.length).toBe(3)
    expect(out).toContain('+6')
  })
})

describe('ordering — oldest waiting first', () => {
  test('the longest-blocked session is the first face', () => {
    const rows = [waiting('recent', 1_000), waiting('ancient', 900_000), waiting('mid', 60_000)]
    const out = html(rollup(rows, new Map(), NOW))
    const order = [...out.matchAll(/data-session="([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual(['ancient', 'mid', 'recent'])
  })
})

describe('the tap target is named, because the three are different things', () => {
  test('a pending choice lands on the choice card', () => {
    const t = rollupTarget(waiting('supermux', 0))
    expect(t.kind).toBe('choice')
    expect(t.href).toBe('/focus/supermux#choice')
  })

  test('a live permission dialog lands on the attention card', () => {
    const t = rollupTarget({
      name: 'supermux',
      status: 'idle',
      permission_request: { tool: 'Bash' } as never,
    })
    expect(t.kind).toBe('attention')
    expect(t.href).toBe('/focus/supermux#attention')
  })

  test('everything else lands on the session', () => {
    const t = rollupTarget({
      name: 'supermux',
      status: 'idle',
      error: { type: 'rate_limit', message: '' },
    })
    expect(t.kind).toBe('session')
    expect(t.href).toBe('/focus/supermux')
  })

  test('a session name with URL-hostile characters is encoded', () => {
    expect(rollupTarget({ name: 'feat/a b', status: 'idle' }).href).toBe('/focus/feat%2Fa%20b')
  })

  test('the kind rides the DOM so the e2e can assert where a tap goes', () => {
    const out = html([waiting('supermux', 1000)])
    expect(out).toContain('data-target="choice"')
  })
})

describe('reduced motion — the morph is padding, so a still frame still reads', () => {
  test('the resting pile is legible with no active member', () => {
    // The expand animates PADDING (B0 §11.9), which means the reduced-motion
    // state is the resting state and the label is only ever additive. Nothing
    // here depends on a transform having run.
    const out = html([waiting('supermux', 1000), waiting('quill', 500)])
    expect(out).toContain('needs you: 2')
    expect(out).toContain('<svg')
  })

  test('every member is a real button — the pile is keyboard-reachable', () => {
    const out = html([waiting('a', 1), waiting('b', 2)])
    expect(out.match(/<button/g)?.length).toBe(2)
    expect(out).toContain('aria-label="a needs you"')
  })
})

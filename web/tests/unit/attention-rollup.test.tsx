/**
 * `<AttentionRollup>` — the header's "needs you: N" cluster, and the PICKER it
 * opens (fase B2 T6, mobile-polish revision).
 *
 * Rendered with `renderToStaticMarkup`. Two things are asserted:
 *
 *   1. the GLANCE — the rollup is a signal, not chrome: nothing at N=0, one
 *      single dialog-opening control (not N overlapping buttons), oldest-waiting
 *      first, a collapse to three faces + "+N".
 *   2. the CHOICE — the picker lists EXACTLY the needs-you sessions and every
 *      row opens THAT session (not a random one): one row per session, in order,
 *      each carrying its own resolved `href`.
 *
 * The behaviour these two together pin is the owner's complaint: tapping the
 * rollup no longer jumps to a random focus session — it opens a list, and row
 * *i* opens session *i*.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import {
  AttentionRollup,
  rollupReason,
  rollupTarget,
} from '../../src/components/roster/attention-rollup'
import { AttentionPickerList } from '../../src/components/roster/attention-picker-sheet'
import { rollup, type AttentionSession } from '../../src/lib/attention-tiers'

const NOW = 1_800_000_000_000

const waiting = (name: string, agoMs: number): AttentionSession => ({
  name,
  status: 'waiting',
  activity_at: NOW - agoMs,
})

const rollupHtml = (sessions: readonly AttentionSession[]): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AttentionRollup sessions={sessions} />
    </MemoryRouter>,
  )

const listHtml = (sessions: readonly AttentionSession[]): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AttentionPickerList sessions={sessions} onPick={() => {}} />
    </MemoryRouter>,
  )

describe('N = 0 renders nothing — no empty chrome', () => {
  test('an empty list produces no markup at all', () => {
    expect(rollupHtml([])).toBe('')
  })

  test('a roster where nobody is blocked produces no rollup', () => {
    const rows: AttentionSession[] = [
      { name: 'calm', status: 'idle', activity_at: NOW },
      { name: 'busy', status: 'active', activity_at: NOW },
    ]
    expect(rollupHtml(rollup(rows, new Map(), NOW))).toBe('')
  })
})

describe('the rollup is ONE control that opens the picker', () => {
  test('the whole cluster is a single dialog-opening button, not N faces', () => {
    const out = rollupHtml(rollup([waiting('a', 3000), waiting('b', 2000)], new Map(), NOW))
    // Exactly one <button>: the trigger. The faces inside are decorative spans,
    // so a thumb can no longer land on "whichever face is under it".
    expect(out.match(/<button/g)?.length).toBe(1)
    expect(out).toContain('aria-haspopup="dialog"')
    expect(out).toContain('data-vr="attention-rollup"')
    expect(out).toContain('needs you: 2')
  })

  test('the faces are non-interactive (the parent owns the tap)', () => {
    const out = rollupHtml([waiting('supermux', 1000)])
    expect(out).toContain('data-vr="attention-rollup-face"')
    expect(out).toContain('pointer-events-none')
  })
})

describe('N > 3 collapses to three marks and a +N', () => {
  test('nine members render three faces and "+6"', () => {
    const nine = Array.from({ length: 9 }, (_, i) => waiting(`s-${i}`, (i + 1) * 1000))
    const out = rollupHtml(rollup(nine, new Map(), NOW))
    expect(out).toContain('needs you: 9')
    expect(out.match(/data-vr="attention-rollup-face"/g)?.length).toBe(3)
    expect(out).toContain('+6')
  })
})

describe('ordering — oldest waiting first, in the glance AND the list', () => {
  test('the longest-blocked session is the first face', () => {
    const rows = [waiting('recent', 1_000), waiting('ancient', 900_000), waiting('mid', 60_000)]
    const out = rollupHtml(rollup(rows, new Map(), NOW))
    const order = [...out.matchAll(/data-session="([^"]+)"/g)].map((m) => m[1])
    // The pile shows the first three, oldest first.
    expect(order.slice(0, 3)).toEqual(['ancient', 'mid', 'recent'])
  })

  test('the picker lists every needs-you session in the same order', () => {
    const rows = [waiting('recent', 1_000), waiting('ancient', 900_000), waiting('mid', 60_000)]
    const ordered = rollup(rows, new Map(), NOW)
    const out = listHtml(ordered)
    const order = [
      ...out.matchAll(/data-vr="attention-picker-row" data-session="([^"]+)"/g),
    ].map((m) => m[1])
    expect(order).toEqual(['ancient', 'mid', 'recent'])
  })
})

describe('a picker row opens THAT session — never a random one', () => {
  test('every row carries its own resolved href, one per session', () => {
    const sessions: AttentionSession[] = [
      { name: 'perm', status: 'idle', permission_request: { tool: 'Bash' } as never },
      { name: 'ask', status: 'waiting' },
      { name: 'oops', status: 'idle', error: { type: 'rate_limit', message: '' } },
    ]
    const out = listHtml(sessions)
    // One row per session.
    expect(out.match(/data-vr="attention-picker-row"/g)?.length).toBe(3)
    // Each row's destination is ITS OWN session's target — the anti-random
    // guarantee, read straight off the DOM.
    expect(out).toContain('data-session="perm"')
    expect(out).toContain('data-href="/focus/perm#attention"')
    expect(out).toContain('data-session="ask"')
    expect(out).toContain('data-href="/focus/ask#choice"')
    expect(out).toContain('data-session="oops"')
    expect(out).toContain('data-href="/focus/oops"')
  })

  test('a session name with URL-hostile characters is encoded in the row href', () => {
    const out = listHtml([{ name: 'feat/a b', status: 'waiting' }])
    expect(out).toContain('data-href="/focus/feat%2Fa%20b#choice"')
  })

  test('the row names the reason, so the list says WHAT each needs', () => {
    const out = listHtml([{ name: 'ask', status: 'waiting' }])
    expect(out).toContain('Waiting for your answer')
  })
})

describe('rollupTarget — the three destinations are different things', () => {
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
})

describe('rollupReason — the picker subline states the demand', () => {
  test('permission, form, waiting, limit, setup, error and the fallback', () => {
    expect(
      rollupReason({ name: 'a', status: 'idle', permission_request: { tool: 'Bash' } as never }),
    ).toBe('Permission request')
    expect(rollupReason({ name: 'b', status: 'idle', elicitation: {} as never })).toBe(
      'Waiting on a form',
    )
    expect(rollupReason({ name: 'c', status: 'waiting' })).toBe('Waiting for your answer')
    expect(
      rollupReason({ name: 'd', status: 'idle', blocked: { kind: 'limit', text: '' } }),
    ).toBe('Usage limit reached')
    expect(
      rollupReason({ name: 'e', status: 'idle', blocked: { kind: 'startup', text: '', wedge: 'trust' } }),
    ).toBe('Needs setup to start')
    expect(
      rollupReason({ name: 'f', status: 'idle', error: { type: 'rate_limit', message: '' } }),
    ).toBe('Stopped with an error')
  })
})

describe('the pile is keyboard-reachable and reads under reduced motion', () => {
  test('the trigger is a real button with an accessible label', () => {
    const out = rollupHtml([waiting('a', 1), waiting('b', 2)])
    expect(out).toContain('<button')
    expect(out).toContain('aria-label="2 sessions need you — open the list"')
  })

  test('one session reads in the singular', () => {
    const out = rollupHtml([waiting('solo', 1)])
    expect(out).toContain('aria-label="One session needs you — open the list"')
  })
})

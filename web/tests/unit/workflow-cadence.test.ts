/**
 * T5.2 — the salvage, and the one thing that is genuinely new about it.
 *
 * The English humanizer and the two serializers came across from
 * `components/scheduler/helpers.ts` unchanged, so what is asserted here is the
 * NEW layer: `normalizeCadence`, the forgiving front door.
 *
 * The rule it must never break: **what leaves this function is an expression
 * the SERVER parser already accepts.** A repair that produced a friendlier
 * string the parser rejects would move the failure from "the field says no" to
 * "Save says 400", which is strictly worse. So every expected value below is
 * checked against `isCadenceExpr`, which mirrors `parser.rs`'s own order of
 * attempts — and the un-repairable inputs return null rather than a guess.
 */
import { describe, expect, test } from 'bun:test'

import {
  QUICK_CADENCES,
  describeSchedule,
  exprToRecurrence,
  isCadenceExpr,
  normalizeCadence,
  onceExprFor,
  recurrenceToExpr,
  workflowHintParts,
} from '../../src/components/workflows/cadence'
import {
  botThreadHref,
  workflowAdminHref,
  workflowEditHref,
  workflowHref,
  workflowNewHref,
} from '../../src/components/workflows/workflow-href'

describe('normalizeCadence repairs what people actually type', () => {
  test.each([
    ['9am', 'daily at 9am'],
    ['9:30', 'daily at 9:30'],
    ['every day at 9', 'daily at 9'],
    ['each day at 18:00', 'daily at 18:00'],
    ['weekdays 9am', 'every weekday at 9am'],
    ['weekdays', 'every weekday at 9:00'],
    ['every weekday 8:30', 'every weekday at 8:30'],
    ['mondays at 9am', 'weekly on mon at 9am'],
    ['monday at 9am', 'weekly on mon at 9am'],
    ['every friday 17:00', 'weekly on fri at 17:00'],
    ['hourly', 'every 1h'],
    ['every hour', 'every 1h'],
    ['every 30 minutes', 'every 30m'],
    ['every 2 hours', 'every 2h'],
    ['daily', 'daily at 9:00'],
    ['weekly', 'weekly on mon at 9:00'],
    ['monthly on the 1st at 9am', 'monthly on 1 at 9am'],
    ['in an hour', 'in 1h'],
    ['Run this every weekday at 9am.', 'every weekday at 9am'],
  ])('%p → %p', (input, expected) => {
    expect(normalizeCadence(input)).toBe(expected)
  })

  test('everything it emits is something the server parser accepts', () => {
    const inputs = [
      '9am', 'every day at 9', 'weekdays 9am', 'mondays at 9am', 'hourly',
      'every 30 minutes', 'monthly on the 1st at 9am', 'in an hour', 'daily',
    ]
    for (const i of inputs) {
      const expr = normalizeCadence(i)
      expect(expr).not.toBeNull()
      expect(isCadenceExpr(expr as string)).toBe(true)
    }
  })

  test('an expression already in the grammar passes through untouched', () => {
    for (const e of ['every weekday at 9am', 'daily at 18:00', 'weekly on mon at 9:00', '0 9 * * 1-5']) {
      expect(normalizeCadence(e)).toBe(e)
    }
  })

  test('nonsense returns null — never a guess the server will reject', () => {
    for (const junk of ['', '   ', 'sometimes', 'when the mood strikes', 'every blue moon', 'at潮']) {
      expect(normalizeCadence(junk)).toBeNull()
    }
  })

  test('every quick preset is already valid — a one-tap answer cannot fail to parse', () => {
    for (const p of QUICK_CADENCES) {
      expect(isCadenceExpr(p.expr)).toBe(true)
      // …and reads back in English as something recognisably the label.
      expect(describeSchedule(p.expr)).not.toBe('—')
    }
  })
})

describe('the one-shot form', () => {
  const now = new Date('2026-08-24T09:00:00Z')

  test('a future instant becomes minutes-from-now, rounded up', () => {
    expect(onceExprFor(new Date('2026-08-24T10:00:00Z'), now)).toBe('in 60m')
    expect(onceExprFor(new Date('2026-08-24T09:00:30Z'), now)).toBe('in 1m')
  })

  test('a past instant has no honest expression', () => {
    expect(onceExprFor(new Date('2026-08-24T08:00:00Z'), now)).toBeNull()
  })
})

describe('the salvaged round-trip still round-trips', () => {
  test('draft → expr → draft', () => {
    for (const expr of ['daily at 9:00', 'every weekday at 8:30', 'weekly on fri at 17:00', 'monthly on 3 at 7:00', 'every 15m']) {
      expect(recurrenceToExpr(exprToRecurrence(expr))).toBe(expr)
    }
  })
})

describe('the list hint line', () => {
  const base = { schedule_expr: 'every weekday at 9:00', trigger_kind: 'recurring', enabled: 1, next_run: null, last_run: null, steps: [1, 2] }

  test('a paused workflow says paused, never a stale next fire', () => {
    const parts = workflowHintParts({ ...base, enabled: 0, next_run: '2099-01-01T09:00:00Z' })
    expect(parts.next).toBe('paused')
  })

  test('a manual workflow says when I say / on demand — not "—"', () => {
    const parts = workflowHintParts({ ...base, trigger_kind: 'manual', schedule_expr: null })
    expect(parts.human).toBe('When I say')
    expect(parts.next).toBe('on demand')
  })

  test('never-run reads as never, and the step count is singularised', () => {
    expect(workflowHintParts(base).last).toBe('never')
    expect(workflowHintParts(base).steps).toBe('2 steps')
    expect(workflowHintParts({ ...base, steps: [1] }).steps).toBe('1 step')
  })
})

describe('every route lives in one module', () => {
  test('the list is a top-level destination again', () => {
    expect(workflowAdminHref()).toBe('/workflows')
    expect(workflowAdminHref(true)).toBe('/settings#workflows')
  })

  test('detail / new / edit, with the ids escaped', () => {
    expect(workflowHref('WF-1a2b')).toBe('/workflows/WF-1a2b')
    expect(workflowEditHref('WF-1a2b')).toBe('/workflows/WF-1a2b/edit')
    expect(workflowNewHref()).toBe('/workflows/new')
    expect(workflowNewHref('scout')).toBe('/workflows/new?session=scout')
    expect(workflowHref('a/b')).toBe('/workflows/a%2Fb')
  })

  test('"open the thread" goes to the BOT’s pane — a run has no surface of its own', () => {
    // The pane is on HOME, so the link is the home address, not the terminal.
    expect(botThreadHref('scout')).toBe('/agent/scout')
    expect(botThreadHref('a/b')).toBe('/agent/a%2Fb')
  })
})

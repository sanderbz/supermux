/**
 * `coalesceReceipts` — the one piece of real logic in the receipt group.
 *
 * Master plan §4.2 P3: a Claude turn runs 30–100 tool calls, and the receipt
 * list is built for that volume — "repeats coalesce (`Read ×12`)". The rule has
 * to be honest about what it collapses: twelve reads of twelve different files
 * are twelve DIFFERENT outcomes, so the collapsed line must drop the outcome
 * rather than show one file's and imply the other eleven.
 */
import { describe, expect, test } from 'bun:test'

import { capReceipts, coalesceReceipts } from '../../src/components/chat/ui/receipt-group'

describe('coalesceReceipts', () => {
  test('leaves distinct tools alone', () => {
    const rows = [
      { tool: 'cargo check', outcome: 'clean · 0 errors' },
      { tool: 'tests', outcome: '212 passed' },
      { tool: 'release', outcome: 'v0.6.0 tagged' },
    ]
    expect(coalesceReceipts(rows)).toEqual(rows.map((r) => ({ ...r, count: 1 })))
  })

  test('collapses a consecutive run of the same tool into one counted line', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ tool: 'Read', outcome: `file-${i}.rs` }))
    const out = coalesceReceipts(rows)
    expect(out).toEqual([{ tool: 'Read', count: 12, outcome: undefined }])
  })

  test('keeps the outcome when every repeat really did say the same thing', () => {
    const rows = [
      { tool: 'Grep', outcome: 'no matches' },
      { tool: 'Grep', outcome: 'no matches' },
    ]
    expect(coalesceReceipts(rows)).toEqual([{ tool: 'Grep', count: 2, outcome: 'no matches' }])
  })

  test('only collapses CONSECUTIVE repeats — order is the receipt list', () => {
    const out = coalesceReceipts([
      { tool: 'Read', outcome: 'a' },
      { tool: 'Read', outcome: 'b' },
      { tool: 'Edit', outcome: 'money.rs' },
      { tool: 'Read', outcome: 'c' },
    ])
    expect(out.map((r) => `${r.tool}×${r.count}`)).toEqual(['Read×2', 'Edit×1', 'Read×1'])
  })

  test('a still-running line never merges into the run above it', () => {
    // The running line is the live one: it carries the spinner and its label is
    // rewritten by PreToolUse. Folding it into a count would hide the very row
    // the user is watching.
    const out = coalesceReceipts([
      { tool: 'Read', outcome: 'a' },
      { tool: 'Read', outcome: 'b' },
      { tool: 'Read', state: 'running' as const },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ tool: 'Read', count: 2, outcome: undefined })
    expect(out[1]).toEqual({ tool: 'Read', count: 1, outcome: undefined, state: 'running' })
  })

  test('is a pure function of its input', () => {
    const rows = [{ tool: 'Read', outcome: 'a' }, { tool: 'Read', outcome: 'b' }]
    const snapshot = JSON.stringify(rows)
    coalesceReceipts(rows)
    expect(JSON.stringify(rows)).toBe(snapshot)
  })
})

describe('capReceipts', () => {
  const done = (tool: string) => ({ tool, count: 1 })
  const live = (tool: string) => ({ tool, count: 1, state: 'running' as const })

  test('an uncapped list is shown whole', () => {
    const lines = [done('a'), done('b')]
    expect(capReceipts(lines, undefined)).toEqual({ shown: lines, hidden: 0 })
    expect(capReceipts(lines, 5)).toEqual({ shown: lines, hidden: 0 })
  })

  test('caps the finished backlog and counts what it hid', () => {
    const lines = [done('a'), done('b'), done('c'), done('d')]
    const { shown, hidden } = capReceipts(lines, 2)
    expect(shown.map((l) => l.tool)).toEqual(['a', 'b'])
    expect(hidden).toBe(2)
  })

  test('NEVER hides the running line — it is pulled past the cap', () => {
    // A 60-call turn caps at `max`, and the live call is always the last one, so
    // a naive slice hides the spinner exactly when it matters most.
    const lines = [done('a'), done('b'), done('c'), live('cargo test')]
    const { shown, hidden } = capReceipts(lines, 2)
    expect(shown.map((l) => l.tool)).toEqual(['a', 'b', 'cargo test'])
    expect(shown.at(-1)?.state).toBe('running')
    expect(hidden).toBe(1)
  })

  test('the affordance disappears when pulling the live line left nothing hidden', () => {
    const lines = [done('a'), done('b'), live('cargo test')]
    expect(capReceipts(lines, 2).hidden).toBe(0)
  })

  test('does not mutate the list it was handed', () => {
    const lines = [done('a'), done('b'), live('c')]
    const snapshot = JSON.stringify(lines)
    capReceipts(lines, 1)
    expect(JSON.stringify(lines)).toBe(snapshot)
  })
})

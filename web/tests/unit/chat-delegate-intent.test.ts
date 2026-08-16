/**
 * Fase B4 T4 — when does `@name` MEAN "hand this over"?
 * ─────────────────────────────────────────────────────────────────────────────
 * A match here changes where Enter sends: from this session's own pty to
 * another agent's. That makes the rule a safety property, and the negatives
 * matter more than the positives — a false positive silently starts somebody
 * else's agent, which is the exact failure `slash.ts`' deferral comment was
 * written to avoid.
 *
 * The module is pure and import-free by design (no jsdom, no `@/` aliases in
 * this runner), so this is arithmetic on strings and nothing else.
 */
import { describe, expect, test } from 'bun:test'

import { handoffLabel, readDelegateIntent } from '../../src/components/chat/delegate-intent'
import { acceptRow, type EntityRow } from '../../src/components/chat/slash'
import { handoffResult } from '../../src/components/chat/use-composer'

/** The panel's index: lowercased known name → slug (`grouping.ts::mentionIndex`). */
const MENTIONS = new Map([
  ['deploy-fix', 'deploy-fix'],
  ['deploy fix', 'deploy-fix'],
  ['patch', 'patch'],
  ['release train', 'release-train'],
  ['release-train', 'release-train'],
])
const SELF = 'release-train'

const read = (draft: string) => readDelegateIntent(draft, MENTIONS, SELF)

describe('a hand-off', () => {
  test('is a leading mention of a known colleague plus something to say', () => {
    expect(read('@patch please rebase the stack')).toEqual({
      to: 'patch',
      prompt: 'please rebase the stack',
    })
  })

  test('strips the envelope and keeps the message exactly', () => {
    // Including its own newlines: a hand-off is often a paragraph, and
    // re-wrapping somebody's instructions is not this module's business.
    expect(read('@patch line one\nline two')?.prompt).toBe('line one\nline two')
  })

  test('tolerates the whitespace of typing, before and after the token', () => {
    expect(read('  @patch   go')).toEqual({ to: 'patch', prompt: 'go' })
    expect(read('@patch\ngo')).toEqual({ to: 'patch', prompt: 'go' })
  })

  test('resolves through the index, so the SLUG travels even when a label was typed', () => {
    // The picker inserts `@release-train`, but a person may type a display
    // name. Both land on the slug — the wire has no other identity.
    expect(read('@deploy-fix take this')?.to).toBe('deploy-fix')
  })

  test('is case-insensitive on the name, because the index is', () => {
    expect(read('@Patch take this')?.to).toBe('patch')
  })
})

describe('is NOT a hand-off', () => {
  test('a mention in the middle of a sentence', () => {
    // The single most important negative: this is a message TO THIS SESSION
    // that happens to name a colleague. Dispatching it would send the user's
    // words to someone they were only talking about.
    expect(read('ask @patch about the export')).toBeNull()
    expect(read('I already told @patch')).toBeNull()
  })

  test('an unknown name', () => {
    // Not a session → not a recipient. It stays text and goes to this session,
    // which is also what the chip rule does with it.
    expect(read('@nobody-here do the thing')).toBeNull()
    expect(read('@patchwork do the thing')).toBeNull()
  })

  test('yourself', () => {
    expect(read('@release-train do the thing')).toBeNull()
    expect(read('@release train do the thing')).toBeNull()
  })

  test('a mention with nothing after it', () => {
    // This is mid-typing — the picker is probably still open. Sending on it
    // would deliver an empty prompt to a colleague on the first space.
    expect(read('@patch')).toBeNull()
    expect(read('@patch   ')).toBeNull()
    expect(read('@patch\n\n')).toBeNull()
  })

  test('two leading mentions', () => {
    // A group address. This fase hands work to exactly one colleague, so
    // refusing is honest; taking the first would quietly drop the rest.
    expect(read('@patch @deploy-fix both of you')).toBeNull()
  })

  test('a mention inside a code fence', () => {
    expect(read('```\n@patch do x\n```')).toBeNull()
    expect(read('    @patch do x')).toEqual({ to: 'patch', prompt: 'do x' }) // indented ≠ fenced
  })

  test('a draft whose first LINE is blank', () => {
    // A multi-line message that happens to start its second line with a name.
    expect(read('\n@patch do x')).toBeNull()
  })

  test('an empty draft, or one with no mention at all', () => {
    expect(read('')).toBeNull()
    expect(read('   ')).toBeNull()
    expect(read('just a normal message')).toBeNull()
    expect(read('@')).toBeNull()
    expect(read('@ patch do x')).toBeNull()
  })

  test('an email address or a handle that merely starts with @', () => {
    expect(read('@example.com is down')).toBeNull()
    expect(readDelegateIntent('@patch@example.com hi', MENTIONS, SELF)).toBeNull()
  })

  test('nothing at all when the index is empty', () => {
    // A surface with no roster yet must not dispatch on a name it cannot check.
    expect(readDelegateIntent('@patch do x', new Map(), SELF)).toBeNull()
  })
})

describe('the label on the send control', () => {
  test('names the colleague, not the database row', () => {
    expect(handoffLabel('patch', new Map([['patch', 'Patch']]))).toBe('Patch')
  })

  test('falls back to the slug when there is no display name', () => {
    expect(handoffLabel('patch')).toBe('patch')
    expect(handoffLabel('patch', new Map([['patch', '   ']]))).toBe('patch')
  })
})

/* ── what a finished hand-off leaves behind ──────────────────────────────── */

describe('the two branches of a dispatch', () => {
  test('success clears the sentence that went, and only that sentence', () => {
    // The user kept typing through the round-trip; subtraction is what keeps
    // those keystrokes (the same rule every other send on this surface uses).
    const out = handoffResult('@patch do x and also this', '@patch do x', 'Patch')
    expect(out.draft).toBe('and also this')
    expect(out.notice).toEqual({ kind: 'handoff-sent', detail: 'Patch' })
  })

  test('failure leaves the box EXACTLY as it was, and says why', () => {
    // The whole point: a hand-off that 500s must never eat the user's text.
    const draft = '@patch do x'
    const out = handoffResult(draft, draft, 'Patch', 'prompt may not contain supermux wrapper markup')
    expect(out.draft).toBe(draft)
    expect(out.notice).toEqual({
      kind: 'handoff-failed',
      detail: 'prompt may not contain supermux wrapper markup',
    })
  })

  test('an unworded throw is still a failure, not a silent success', () => {
    const out = handoffResult('@patch do x', '@patch do x', 'Patch', '')
    expect(out.draft).toBe('@patch do x')
    expect(out.notice.kind).toBe('handoff-failed')
    expect(out.notice.detail).toBeUndefined()
  })
})

/* ── the picker's keyboard contract, unchanged by the widening ───────────── */

describe('accept', () => {
  const rows: EntityRow[] = [
    { id: 'f1', kind: 'file', value: '@a.rs', label: 'a.rs' },
    { id: 's1', kind: 'session', value: '@patch', label: 'Patch', meta: 'patch' },
  ]

  test('takes the highlighted row — the WHOLE row, not just its text', () => {
    // T4.3's widening: the caller gets the row's identity (`kind`, `meta`), not
    // a string it would have to parse back out of the draft.
    expect(acceptRow(rows, 1)).toEqual(rows[1])
  })

  test('takes nothing when there is nothing to take, so Enter still SENDS', () => {
    // The contract `use-composer.ts`' key handler depends on: a `false` accept
    // falls through to submit. An empty list that claimed a row would swallow
    // the user's message on every query that matches nothing.
    expect(acceptRow([], 0)).toBeNull()
    expect(acceptRow(rows, -1)).toBeNull()
  })

  test('never takes a neighbour when the list shrank under the highlight', () => {
    // The highlight lives one render out of the list it points into.
    expect(acceptRow(rows, 5)).toBeNull()
  })
})

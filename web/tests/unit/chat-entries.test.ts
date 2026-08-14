import { describe, expect, test } from 'bun:test'

import {
  formatElapsed,
  newestAgentTs,
  pruneSuperseded,
  RECEIPT_CAP,
  stripEmojiPrefix,
  supersededCutoffMs,
  toDisplayList,
  type ChatEntry,
} from '../../src/components/chat/entries'

const e = (over: Partial<ChatEntry>): ChatEntry => ({
  uuid: over.uuid ?? Math.random().toString(36).slice(2),
  ts: over.ts ?? 0,
  text: over.text ?? '',
  kind: over.kind ?? 'prompt',
  ...over,
})

describe('toDisplayList', () => {
  test('carries the server truncation flag through to the display item', () => {
    // A clipped message must be MARKABLE in the UI. Without the flag reaching
    // the display item, a message the server cut at the wire cap renders as
    // one that simply ended mid-sentence and the reader cannot tell.
    const items = toDisplayList([
      e({ kind: 'assistant', text: 'long answer', ts: 2, truncated: true }),
      e({ kind: 'prompt', text: 'long prompt', ts: 1, truncated: true }),
    ])
    expect(items.map((i) => i.type)).toEqual(['user', 'assistant'])
    expect(items.every((i) => i.type !== 'receipts' && i.truncated === true)).toBe(true)
  })

  test('an untruncated entry carries no flag', () => {
    const [item] = toDisplayList([e({ kind: 'assistant', text: 'short', ts: 1 })])
    expect(item.type === 'assistant' && item.truncated).toBeUndefined()
  })

  test('reverses newest-first wire order to oldest-first display order', () => {
    const items = toDisplayList([
      e({ kind: 'assistant', text: 'reply', ts: 2 }),
      e({ kind: 'prompt', text: 'question', ts: 1 }),
    ])
    expect(items.map((i) => i.type)).toEqual(['user', 'assistant'])
  })

  test('consecutive tool_use entries collapse into ONE receipts block', () => {
    const items = toDisplayList([
      e({ kind: 'assistant', text: 'done', ts: 4 }),
      e({ kind: 'tool_use', text: 'Bash cargo test', ok: false, ts: 3 }),
      e({ kind: 'tool_use', text: 'Read a.rs', ok: true, reply: 'ok', ts: 2 }),
      e({ kind: 'prompt', text: 'go', ts: 1 }),
    ])
    expect(items.map((i) => i.type)).toEqual(['user', 'receipts', 'assistant'])
    const r = items[1]
    if (r.type !== 'receipts') throw new Error('expected receipts')
    expect(r.lines.map((l) => l.label)).toEqual(['Read a.rs', 'Bash cargo test'])
    expect(r.lines[0].ok).toBe(true)
    expect(r.lines[1].ok).toBe(false)
    expect(r.overflow).toBe(0)
  })

  test('receipt cap: past RECEIPT_CAP lines count into overflow', () => {
    const tools: ChatEntry[] = []
    for (let i = 0; i < RECEIPT_CAP + 5; i++) {
      tools.push(e({ kind: 'tool_use', text: `Read f${i}`, ts: i + 2 }))
    }
    // Wire order is newest-first.
    const items = toDisplayList([...tools].reverse())
    const r = items[0]
    if (r.type !== 'receipts') throw new Error('expected receipts')
    expect(r.lines.length).toBe(RECEIPT_CAP)
    expect(r.overflow).toBe(5)
  })

  test('command/teammate prompts keep a badge, plain prompts none', () => {
    const items = toDisplayList([
      e({ kind: 'command', text: '/compact', ts: 2 }),
      e({ kind: 'prompt', text: 'hi', ts: 1 }),
    ])
    const [plain, cmd] = items
    if (plain.type !== 'user' || cmd.type !== 'user') throw new Error('users')
    expect(plain.badge).toBeUndefined()
    expect(cmd.badge).toBe('command')
  })
})

describe('formatElapsed', () => {
  test('seconds then m ss', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(12_400)).toBe('12s')
    expect(formatElapsed(125_000)).toBe('2m 05s')
  })
})

describe('stripEmojiPrefix (overlay labels must match confirmed tool_line vocabulary)', () => {
  test('strips the activity-taxonomy glyph, keeps plain labels', () => {
    expect(stripEmojiPrefix('⚡ npm test')).toBe('npm test')
    expect(stripEmojiPrefix('✎ tile.tsx')).toBe('tile.tsx')
    expect(stripEmojiPrefix('🔌 mcp thing')).toBe('mcp thing')
    expect(stripEmojiPrefix('Read src/a.rs')).toBe('Read src/a.rs')
    expect(stripEmojiPrefix('')).toBe('')
  })
})

describe('newestAgentTs (the supersede gate probe)', () => {
  test('ignores the user’s own prompt echo — the send-anchored turn would else tear down instantly', () => {
    // Right after a dock/API send the tail holds ONLY the user turn Claude
    // just wrote (`ts` ≥ last_send_at, i.e. ≥ the turn anchor).
    const sendAtSec = 1_770_000_000
    const entries = [
      e({ kind: 'prompt', text: 'do the thing', ts: sendAtSec }),
      e({ kind: 'assistant', text: 'previous answer', ts: sendAtSec - 300 }),
    ]
    expect(newestAgentTs(entries) * 1000).toBeLessThan(sendAtSec * 1000)
  })

  test('the agent’s confirming batch satisfies it (assistant or tool_use, newest-first)', () => {
    const sendAtSec = 1_770_000_000
    expect(
      newestAgentTs([
        e({ kind: 'assistant', text: 'done', ts: sendAtSec + 31 }),
        e({ kind: 'prompt', text: 'go', ts: sendAtSec }),
      ]) * 1000,
    ).toBeGreaterThanOrEqual(sendAtSec * 1000)
    expect(
      newestAgentTs([
        e({ kind: 'tool_use', text: 'Read a.rs', ts: sendAtSec + 3 }),
        e({ kind: 'prompt', text: 'go', ts: sendAtSec }),
      ]),
    ).toBe(sendAtSec + 3)
  })

  test('0 on an empty / user-only tail', () => {
    expect(newestAgentTs([])).toBe(0)
    expect(newestAgentTs([e({ kind: 'command', text: '/clear', ts: 9 })])).toBe(0)
  })
})

describe('pruneSuperseded (live overlay vs. confirmed transcript)', () => {
  test('a line inside the confirmed entry\u2019s own second is superseded', () => {
    // Wire ts is floored to seconds; the overlay stamps ms. A receipt confirmed
    // at 10.400s arrives as ts=10, so a `ts * 1000` cutoff left its overlay twin
    // on screen — a duplicate row for the rest of the turn.
    const lines = [{ at: 10_400 }, { at: 10_999 }, { at: 11_001 }]
    expect(pruneSuperseded(lines, 10)).toEqual([{ at: 11_001 }])
  })

  test('cutoff is the END of the confirmed second', () => {
    expect(supersededCutoffMs(10)).toBe(11_000)
  })

  test('returns the SAME array when nothing was superseded', () => {
    const lines = [{ at: 99_000 }]
    expect(pruneSuperseded(lines, 10)).toBe(lines)
  })
})

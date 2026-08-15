/**
 * `grouping.ts` — the transcript's shaping layer.
 * ─────────────────────────────────────────────────────────────────────────────
 * `entries.ts` decides WHAT is true (fase A1, frozen). This module decides how
 * that truth is arranged on the page, and it is pure so the arrangement can be
 * asserted without a DOM:
 *
 *   · receipts-first — when a batch lands, the tool receipts render before the
 *     closing prose (master plan §4.2). The closing text is never the first
 *     thing to appear.
 *   · run grammar — consecutive turns by one speaker stack at 8px and only the
 *     first carries the 28px mark (§4.2 P2).
 *   · session-block dividers — a centred relative-time line where the
 *     conversation was put down and picked up again (§5.3).
 *
 * Every case below is a rule that, if it broke, would be invisible in review and
 * obvious in use.
 */
import { describe, expect, test } from 'bun:test'

import type { ChatEntry, ChatItem } from '../../src/components/chat/entries'
import {
  buildTranscript,
  dayDividers,
  displayNames,
  dividerLabel,
  entryLabels,
  groupItems,
  mentionIndex,
  mentionSegments,
  receiptsFirst,
  SESSION_GAP_S,
  toReceiptRows,
} from '../../src/components/chat/grouping'

/* ── builders ────────────────────────────────────────────────────────────── */

const assistant = (uuid: string, ts: number, text = 'ok'): ChatItem => ({
  type: 'assistant',
  uuid,
  ts,
  text,
})
const user = (uuid: string, ts: number, badge?: string): ChatItem => ({
  type: 'user',
  uuid,
  ts,
  text: 'hi',
  badge,
})
const receipts = (uuid: string, ts: number): ChatItem => ({
  type: 'receipts',
  uuid,
  ts,
  lines: [{ uuid: `${uuid}-l`, label: 'cargo check', result: 'clean · 0 errors' }],
  overflow: 0,
})

const ids = (items: readonly ChatItem[]) => items.map((i) => i.uuid)

/* ── receipts-first ──────────────────────────────────────────────────────── */

describe('receiptsFirst', () => {
  test('a flush batch puts its closing prose below the whole checklist', () => {
    // Two tool groups and the answer, all stamped in one second. The answer
    // waits for both groups — "the closing text is never the first thing to
    // appear" is about the text that CLOSES the turn.
    const out = receiptsFirst([
      receipts('r1', 100),
      assistant('closing', 100),
      receipts('r2', 100),
    ])
    expect(ids(out)).toEqual(['r1', 'r2', 'closing'])
  })

  test('the prose that INTRODUCES a call never sinks below it', () => {
    // `recall.rs` stamps a message's text block and its `tool_use` blocks with
    // one `ts`, so the same-second bucket routinely opens with "I'll check the
    // build first." Hoisting the receipts over it prints the answer above the
    // question — the turn reads backwards.
    expect(ids(receiptsFirst([assistant('intro', 100), receipts('tools', 100)]))).toEqual([
      'intro',
      'tools',
    ])
  })

  test('it is a tie-break, not a sort — earlier prose keeps its place', () => {
    // "I'll check the build." at t=100, the tools it then ran at t=112. Hoisting
    // the receipts would rewrite the turn into nonsense.
    expect(ids(receiptsFirst([assistant('intro', 100), receipts('tools', 112)]))).toEqual([
      'intro',
      'tools',
    ])
  })

  test('a user turn closes the batch', () => {
    const out = receiptsFirst([
      assistant('a1', 100),
      user('u1', 100),
      receipts('r1', 100),
      assistant('a2', 100),
    ])
    expect(ids(out)).toEqual(['a1', 'u1', 'r1', 'a2'])
  })

  test('two batches shape independently', () => {
    const out = receiptsFirst([
      receipts('r1', 100),
      assistant('a1', 100),
      receipts('r2', 200),
      assistant('a2', 200),
    ])
    expect(ids(out)).toEqual(['r1', 'a1', 'r2', 'a2'])
  })

  test('a later second is real chronology, never a bucket', () => {
    // The answer at t=101 is already after the receipts at t=100; nothing to do.
    expect(ids(receiptsFirst([receipts('r1', 100), assistant('a1', 101)]))).toEqual(['r1', 'a1'])
  })

  test('it never adds, drops or mutates an item', () => {
    const input = [receipts('r1', 100), assistant('a1', 100), receipts('r2', 100)]
    const out = receiptsFirst(input)
    expect(out).toHaveLength(3)
    expect(out[1]).toBe(input[2])
    expect(out[2]).toBe(input[1])
    expect(ids(input)).toEqual(['r1', 'a1', 'r2'])
  })
})

/* ── run grammar ─────────────────────────────────────────────────────────── */

describe('groupItems', () => {
  test('an agent run stacks, and only its first row carries the mark', () => {
    const out = groupItems([assistant('a1', 100), receipts('r1', 101), assistant('a2', 102)])
    expect(out.map((r) => r.grouped)).toEqual([false, true, true])
    expect(out.map((r) => r.showGutter)).toEqual([true, false, false])
    expect(out.every((r) => r.speaker === 'agent')).toBe(true)
  })

  test('the human never takes a gutter — the me row has no mark', () => {
    const out = groupItems([user('u1', 100), user('u2', 101)])
    expect(out.map((r) => r.showGutter)).toEqual([false, false])
    expect(out.map((r) => r.grouped)).toEqual([false, true])
  })

  test('switching speaker breaks the run and re-hangs the mark', () => {
    const out = groupItems([assistant('a1', 100), user('u1', 101), assistant('a2', 102)])
    expect(out.map((r) => r.grouped)).toEqual([false, false, false])
    expect(out.map((r) => r.showGutter)).toEqual([true, false, true])
  })

  test('a slash command is still the human speaking', () => {
    const out = groupItems([user('u1', 100), user('u2', 101, 'command')])
    expect(out.map((r) => r.speaker)).toEqual(['me', 'me'])
    expect(out[1].grouped).toBe(true)
  })

  test('a colleague is a THIRD voice, with its own face', () => {
    // A teammate message is user-role on the wire, but it is not the human and
    // it is not this session — it must not stack into either run.
    const labels = entryLabels([
      { uuid: 't1', ts: 101, text: 'over to you', kind: 'teammate', label: 'patch' },
    ])
    const out = groupItems([user('u1', 100), user('t1', 101, 'teammate')], labels)
    expect(out.map((r) => r.speaker)).toEqual(['me', 'teammate:patch'])
    expect(out[1].grouped).toBe(false)
    expect(out[1].showGutter).toBe(true)
    expect(out[1].sender).toBe('patch')
  })

  test('two colleagues do not stack into each other', () => {
    const labels = entryLabels([
      { uuid: 't1', ts: 100, text: '', kind: 'teammate', label: 'patch' },
      { uuid: 't2', ts: 101, text: '', kind: 'teammate', label: 'quill' },
    ])
    const out = groupItems([user('t1', 100, 'teammate'), user('t2', 101, 'teammate')], labels)
    expect(out.map((r) => r.grouped)).toEqual([false, false])
  })

  test('harness events are a centred system line, never a bubble run', () => {
    const out = groupItems([user('s1', 100, 'system'), user('s2', 101, 'system')])
    expect(out.map((r) => r.speaker)).toEqual(['system', 'system'])
    // Two centred one-liners in a row are two one-liners; stacking is a bubble
    // grammar and a system line has no bubble.
    expect(out.map((r) => r.grouped)).toEqual([false, false])
    expect(out.map((r) => r.showGutter)).toEqual([false, false])
  })
})

/* ── session-block dividers ──────────────────────────────────────────────── */

describe('dayDividers', () => {
  const NOW = 1_760_000_000_000 // fixed clock; every case is a delta off it
  const at = (secondsAgo: number) => Math.floor(NOW / 1000) - secondsAgo

  test('the transcript opens on a divider — when did this start?', () => {
    const nodes = dayDividers(groupItems([assistant('a1', at(120))]), NOW)
    expect(nodes.map((n) => n.kind)).toEqual(['divider', 'item'])
  })

  test('a quiet gap starts a new block', () => {
    const nodes = dayDividers(
      groupItems([assistant('a1', at(SESSION_GAP_S + 600)), assistant('a2', at(60))]),
      NOW,
    )
    expect(nodes.map((n) => n.kind)).toEqual(['divider', 'item', 'divider', 'item'])
  })

  test('a continuous turn does not', () => {
    const nodes = dayDividers(
      groupItems([assistant('a1', at(300)), assistant('a2', at(120))]),
      NOW,
    )
    expect(nodes.map((n) => n.kind)).toEqual(['divider', 'item', 'item'])
  })

  test('the gap is exclusive at the boundary', () => {
    const nodes = dayDividers(
      groupItems([assistant('a1', at(SESSION_GAP_S)), assistant('a2', at(0))]),
      NOW,
    )
    expect(nodes.filter((n) => n.kind === 'divider')).toHaveLength(1)
  })

  test('a divider breaks the run — the row under it re-hangs its mark', () => {
    const grouped = groupItems([
      assistant('a1', at(SESSION_GAP_S + 600)),
      assistant('a2', at(60)),
    ])
    expect(grouped[1].grouped).toBe(true) // same speaker, uninterrupted…
    const nodes = dayDividers(grouped, NOW)
    const second = nodes[3]
    expect(second.kind).toBe('item')
    if (second.kind !== 'item') throw new Error('unreachable')
    expect(second.grouped).toBe(false) // …but a block start is a fresh start
    expect(second.showGutter).toBe(true)
  })

  test('every node carries a stable key', () => {
    const nodes = dayDividers(groupItems([assistant('a1', at(60)), user('u1', at(30))]), NOW)
    const keys = nodes.map((n) => n.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('an empty transcript gets no divider', () => {
    expect(dayDividers([], NOW)).toEqual([])
  })
})

describe('dividerLabel — the relative clock the 1s ticker recomputes', () => {
  const NOW = Date.UTC(2026, 7, 14, 12, 0, 0) // Fri 14 Aug 2026, 12:00 UTC
  const label = (secondsAgo: number) => dividerLabel(Math.floor(NOW / 1000) - secondsAgo, NOW)

  test('the rungs', () => {
    expect(label(0)).toBe('Just now')
    expect(label(59)).toBe('Just now')
    expect(label(60)).toBe('1m ago')
    expect(label(3599)).toBe('59m ago')
    expect(label(3600)).toBe('1h ago')
    expect(label(86_399)).toBe('23h ago')
    expect(label(86_400)).toBe('Yesterday')
    expect(label(172_799)).toBe('Yesterday')
  })

  // Both of these read the runner's local calendar, so the expectation is built
  // from the same Date rather than hard-coded — the assertion is on the SHAPE
  // (a weekday name, then a date), which is what §5.3 pins.
  test('inside the week it names the day, not a duration', () => {
    const d = new Date(NOW - 3 * 86_400_000)
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    expect(label(3 * 86_400)).toBe(days[d.getDay()])
  })

  test('older than a week it names the date', () => {
    const d = new Date(NOW - 30 * 86_400_000)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    expect(label(30 * 86_400)).toBe(
      `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`,
    )
  })

  test('a clock skewed into the future never renders a negative age', () => {
    expect(label(-30)).toBe('Just now')
  })
})

/* ── receipt rows ────────────────────────────────────────────────────────── */

describe('toReceiptRows', () => {
  test('label → tool, result → outcome', () => {
    expect(
      toReceiptRows([{ uuid: 'l1', label: 'cargo check', result: 'clean · 0 errors' }]),
    ).toEqual([{ tool: 'cargo check', outcome: 'clean · 0 errors' }])
  })

  test('the emoji taxonomy stays terminal-side', () => {
    expect(toReceiptRows([{ uuid: 'l1', label: '⚡ npm test' }])[0].tool).toBe('npm test')
  })

  test('a result with no text leaves the outcome slot empty, not blank', () => {
    // `outcome: undefined` is what makes `ReceiptLine` drop the arrow entirely;
    // an empty string would render a dangling `→`.
    expect(toReceiptRows([{ uuid: 'l1', label: 'Read /a/b.rs', result: '   ' }])[0]).toEqual({
      tool: 'Read /a/b.rs',
    })
  })

  test('a multi-line result becomes its first meaningful line', () => {
    const rows = toReceiptRows([{ uuid: 'l1', label: 'tests', result: '\n\n212 passed\n\nfoo' }])
    expect(rows[0].outcome).toBe('212 passed')
  })

  test('long strings are clamped — a receipt is one line, always', () => {
    const rows = toReceiptRows([
      { uuid: 'l1', label: `Bash ${'x'.repeat(200)}`, result: 'y'.repeat(200) },
    ])
    expect(rows[0].tool.length).toBeLessThanOrEqual(66)
    expect(rows[0].outcome!.length).toBeLessThanOrEqual(74)
    expect(rows[0].tool.endsWith('…')).toBe(true)
  })

  test('a failed call says so in the outcome — no red bubble, no lost line', () => {
    const rows = toReceiptRows([{ uuid: 'l1', label: 'cargo check', ok: false, result: 'E0432' }])
    expect(rows[0]).toEqual({ tool: 'cargo check', outcome: 'failed · E0432' })
  })

  test('a failed call with nothing to say still says failed', () => {
    expect(toReceiptRows([{ uuid: 'l1', label: 'tests', ok: false }])[0].outcome).toBe('failed')
  })

  test('a running line is never invented here — confirmed receipts are done', () => {
    expect(toReceiptRows([{ uuid: 'l1', label: 'tests' }])[0].state).toBeUndefined()
  })
})

/* ── mention chips ───────────────────────────────────────────────────────── */

describe('mentionSegments', () => {
  const index = mentionIndex([
    { name: 'patch', display_name: 'Patch' },
    { name: 'quill' },
    { name: 'release-train', display_name: 'Release Train' },
  ])

  test('a known session becomes a chip, in its own pigment', () => {
    expect(mentionSegments('Patch sent the failing job', index)).toEqual([
      { seed: 'patch', label: 'Patch' },
      { text: ' sent the failing job' },
    ])
  })

  test('the slug matches too, and the chip is seeded by the slug either way', () => {
    expect(mentionSegments('ask release-train', index)).toEqual([
      { text: 'ask ' },
      { seed: 'release-train', label: 'release-train' },
    ])
  })

  test('an unknown word is never a chip — no regex over arbitrary prose', () => {
    expect(mentionSegments('the patcher applied a patchwork', index)).toEqual([
      { text: 'the patcher applied a patchwork' },
    ])
  })

  test('a bare mention inside a sentence keeps its punctuation outside the chip', () => {
    expect(mentionSegments('done, quill.', index)).toEqual([
      { text: 'done, ' },
      { seed: 'quill', label: 'quill' },
      { text: '.' },
    ])
  })

  test('an empty index is the identity — no sessions, no chips', () => {
    expect(mentionSegments('Patch', mentionIndex([]))).toEqual([{ text: 'Patch' }])
  })

  test('the focused session names itself without becoming a chip', () => {
    // Its face is already in the gutter of every row it speaks in; a chip for
    // "me" inside my own bubble is noise.
    expect(mentionSegments('Patch and quill', index, 'patch')).toEqual([
      { text: 'Patch and ' },
      { seed: 'quill', label: 'quill' },
    ])
  })
})

/* ── the whole pipeline ──────────────────────────────────────────────────── */

describe('buildTranscript', () => {
  test('composes shaping, grammar and dividers in that order', () => {
    const now = 1_760_000_000_000
    const t = Math.floor(now / 1000) - 60
    const nodes = buildTranscript(
      [assistant('intro', t), receipts('tools', t), assistant('closing', t)],
      { nowMs: now },
    )
    expect(nodes.map((n) => (n.kind === 'item' ? n.item.uuid : 'divider'))).toEqual([
      'divider',
      'intro',
      'tools',
      'closing',
    ])
  })

  test('an empty tail is empty — no divider hanging over nothing', () => {
    expect(buildTranscript([], { nowMs: Date.now() })).toEqual([])
  })
})

describe('entryLabels', () => {
  test('carries the wire label the display model drops', () => {
    // `ChatItem` is frozen (A1) and has no `label`, but the arrival divider has
    // to name the colleague who sent the message. This is the bridge.
    const entries: ChatEntry[] = [
      { uuid: 'a', ts: 1, text: '', kind: 'teammate', label: 'patch' },
      { uuid: 'b', ts: 2, text: '', kind: 'assistant' },
    ]
    const labels = entryLabels(entries)
    expect(labels.get('a')).toBe('patch')
    expect(labels.has('b')).toBe(false)
  })
})

describe('displayNames', () => {
  test('maps a slug to what that session is called', () => {
    const names = displayNames([
      { name: 'release-train', display_name: 'Release Train' },
      { name: 'patch', display_name: '  ' },
      { name: 'quill' },
    ])
    expect(names.get('release-train')).toBe('Release Train')
    // A blank or absent display name maps to NOTHING, so the caller falls back
    // to the slug — which is what that session is called.
    expect(names.has('patch')).toBe(false)
    expect(names.has('quill')).toBe(false)
  })
})

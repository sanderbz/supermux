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

import type { HarnessEvent } from '../../src/lib/api/harness'
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
  scopedMentionIndex,
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

  test('a delegation speaks as its sender and opens with an arrival divider', () => {
    // `agents/delegate.rs` wraps the delivery in `<supermux-delegation from>`,
    // so a colleague's request arrives here as its own voice. Rendered as the
    // owner's bubble it would read as "you asked for this" — the same
    // impersonation the teammate voice above exists to end.
    const labels = entryLabels([
      { uuid: 'd1', ts: 1_001, text: 'Please rebase the stack.', kind: 'delegation', label: 'git-stacker' },
    ])
    const nodes = buildTranscript([user('u1', 1_000), user('d1', 1_001, 'delegation')], {
      nowMs: 2_000_000,
      labels,
    })
    const row = nodes.find((n) => n.kind === 'item' && n.item.uuid === 'd1')
    expect(row).toBeDefined()
    if (row?.kind !== 'item') throw new Error('unreachable')
    expect(row.speaker).toBe('teammate:git-stacker')
    // `grouped: false` IS the run-start flag `TeammateRow` reads to draw the
    // `ArrivalDivider`; `sender` is what names the face on it.
    expect(row.grouped).toBe(false)
    expect(row.showGutter).toBe(true)
    expect(row.sender).toBe('git-stacker')
  })

  test('a scheduled fire is the SCHEDULE speaking, not the owner', () => {
    // A schedule's prompt is user-role on the wire and lands at 03:00 with
    // nobody at the keyboard. Grouping it into the human's last run says "you
    // typed this" in whitespace — the impersonation this speaker exists to end.
    const labels = entryLabels([
      { uuid: 's1', ts: 101, text: 'check the release', kind: 'schedule', label: 'Nightly' },
    ])
    const out = groupItems([user('u1', 100), user('s1', 101, 'schedule')], labels)
    expect(out.map((r) => r.speaker)).toEqual(['me', 'schedule:Nightly'])
    expect(out[1].grouped).toBe(false)
    // The arrival divider carries the identity (⏱ + title); a schedule has no
    // session mark to hang in the gutter.
    expect(out[1].showGutter).toBe(false)
    expect(out[1].sender).toBeUndefined()
  })

  test('two schedules are two voices; one schedule keeps its own run', () => {
    const labels = entryLabels([
      { uuid: 's1', ts: 100, text: '', kind: 'schedule', label: 'Nightly' },
      { uuid: 's2', ts: 101, text: '', kind: 'schedule', label: 'Nightly' },
      { uuid: 's3', ts: 102, text: '', kind: 'schedule', label: 'Standup' },
    ])
    const out = groupItems(
      [user('s1', 100, 'schedule'), user('s2', 101, 'schedule'), user('s3', 102, 'schedule')],
      labels,
    )
    expect(out.map((r) => r.grouped)).toEqual([false, true, false])
  })

  test('two colleagues do not stack into each other', () => {
    const labels = entryLabels([
      { uuid: 't1', ts: 100, text: '', kind: 'teammate', label: 'patch' },
      { uuid: 't2', ts: 101, text: '', kind: 'teammate', label: 'quill' },
    ])
    const out = groupItems([user('t1', 100, 'teammate'), user('t2', 101, 'teammate')], labels)
    expect(out.map((r) => r.grouped)).toEqual([false, false])
  })

  /** Claude writes its interruption to the transcript as a user-role prompt, so
   *  the two-voice grammar drew it as the human's own dark bubble — "[Request
   *  interrupted by user for tool use]" hanging on the right under a denied
   *  tool call (mobile proof, 16-chat-after-deny-light.png). */
  test('an interruption notice is the system voice, not the human’s', () => {
    const notice: ChatItem = {
      type: 'user',
      uuid: 'i1',
      ts: 100,
      text: '[Request interrupted by user for tool use]',
    }
    const out = groupItems([notice])
    expect(out[0].speaker).toBe('system')
    expect(out[0].showGutter).toBe(false)
  })

  test('a message that merely mentions an interruption is still the human’s', () => {
    const typed: ChatItem = {
      type: 'user',
      uuid: 'u9',
      ts: 100,
      text: 'why did I get [Request interrupted by user] there?',
    }
    expect(groupItems([typed])[0].speaker).toBe('me')
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
      // `short` rides along because the label HAS a shorter honest form — the
      // phone read (QA #2). The outcome slot is what this test is about, and it
      // is still absent.
      tool: 'Read /a/b.rs',
      short: 'Read b.rs',
    })
  })

  test('a multi-line result becomes its first meaningful line', () => {
    const rows = toReceiptRows([{ uuid: 'l1', label: 'tests', result: '\n\n212 passed\n\nfoo' }])
    expect(rows[0].outcome).toBe('212 passed')
  })

  test('long strings are clamped — the collapsed row stays short', () => {
    const rows = toReceiptRows([
      { uuid: 'l1', label: `Bash ${'x'.repeat(200)}`, result: 'y'.repeat(200) },
    ])
    // The label's own ceiling is now what an EXPANDED row may show (QA #2 — the
    // row wraps and expands on tap, so 64 glyphs is no longer what keeps it
    // readable); the COLLAPSED phone read is `short`, and that is the number
    // that has to stay small.
    expect(rows[0].tool.length).toBeLessThanOrEqual(162)
    expect(rows[0].short!.length).toBeLessThanOrEqual(31)
    expect(rows[0].outcome!.length).toBeLessThanOrEqual(74)
    expect(rows[0].tool.endsWith('…')).toBe(true)
    // …and the clamp is not a loss: the full result is carried for the tap.
    expect(rows[0].full).toBe('y'.repeat(200))
  })

  test('a failed call says so in the outcome — no red bubble, no lost line', () => {
    const rows = toReceiptRows([{ uuid: 'l1', label: 'cargo check', ok: false, result: 'E0432' }])
    // `failed` is the honesty flag the grok receipt reads to swap ✓→✗ and tint
    // the outcome; the outcome still carries the word, so the default renderer
    // (which ignores the flag) is unchanged.
    expect(rows[0]).toEqual({ tool: 'cargo check', outcome: 'failed · E0432', failed: true })
  })

  test('a failed call with nothing to say still says failed', () => {
    expect(toReceiptRows([{ uuid: 'l1', label: 'tests', ok: false }])[0].outcome).toBe('failed')
  })

  test('a DECLINE is not a FAILURE — it keeps the check (no `failed` flag)', () => {
    // A denial is the user's own calm choice, reported with its own word
    // ("declined · "), not a malfunction — so it must not read as a failed step.
    const rows = toReceiptRows([{ uuid: 'l1', label: 'Bash', ok: false, denied: true, result: 'no' }])
    expect(rows[0].failed).toBeUndefined()
    expect(rows[0].outcome).toBe('declined · no')
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

  test('a bare 1-2 char single-word name never linkifies (false-positive guard)', () => {
    // A bot slugged `ok` would otherwise mint a chip on every "ok" in prose.
    const shorty = mentionIndex([{ name: 'ok' }])
    expect(mentionSegments('ok, will do', shorty)).toEqual([{ text: 'ok, will do' }])
    // …but a multi-word name (carries a space) stays matchable at any length.
    const twoWord = mentionIndex([{ name: 'qa', display_name: 'QA Bot' }])
    expect(mentionSegments('ask QA Bot now', twoWord)).toEqual([
      { text: 'ask ' },
      { seed: 'qa', label: 'QA Bot' },
      { text: ' now' },
    ])
  })

  test('a Capitalized mention after another Capitalized word still linkifies (Ask Bolt)', () => {
    // Company scoping — not a fragile Capitalized-adjacency guard — is what keeps
    // an out-of-company "iCloud Mail" from minting a chip. So within a company a
    // legitimate mention that trails a Capitalized word MUST still linkify.
    const boltIdx = mentionIndex([{ name: 'acme-b', display_name: 'Bolt' }])
    for (const lead of ['Ask', 'Then', 'Please', 'Hey']) {
      expect(mentionSegments(`${lead} Bolt now`, boltIdx)).toEqual([
        { text: `${lead} ` },
        { seed: 'acme-b', label: 'Bolt' },
        { text: ' now' },
      ])
    }
  })

  test('company scope — not adjacency — blocks the cross-company "iCloud Mail" leak', () => {
    // Typing as `acme-a` (company 1): `mail` is a bot in ANOTHER company, so it is
    // not in the scoped index and never linkifies — Capitalized lead-in or not.
    const fleet = [
      { name: 'acme-a', display_name: 'Aria', company_id: 1 },
      { name: 'acme-b', display_name: 'Bolt', company_id: 1 },
      { name: 'mail', display_name: 'Mail', company_id: 2 },
    ]
    const idx = scopedMentionIndex(fleet, 'acme-a')
    // Out-of-company "Mail" stays plain text (no chip), even bare.
    expect(mentionSegments('connect iCloud Mail today', idx)).toEqual([
      { text: 'connect iCloud Mail today' },
    ])
    expect(mentionSegments('ping Mail today', idx)).toEqual([{ text: 'ping Mail today' }])
    // …while a same-company "Bolt" DOES linkify, Capitalized lead-in and all.
    expect(mentionSegments('Ask Bolt today', idx)).toEqual([
      { text: 'Ask ' },
      { seed: 'acme-b', label: 'Bolt' },
      { text: ' today' },
    ])
  })
})

describe('scopedMentionIndex — a company chat only linkifies its own company', () => {
  // Acme (1) has two bots, Globex (2) one, and there is one main/HQ bot.
  const fleet = [
    { name: 'acme-a', display_name: 'Aria', company_id: 1 },
    { name: 'acme-b', display_name: 'Bolt', company_id: 1 },
    { name: 'globex-a', display_name: 'Gizmo', company_id: 2 },
    { name: 'pa', display_name: 'Assistant', company_id: null },
  ]

  test('a company session EXCLUDES an out-of-company bot (no cross-company link)', () => {
    // Typing as `acme-a` (company 1): its index knows its own colleagues…
    const idx = scopedMentionIndex(fleet, 'acme-a')
    expect(idx.get('acme-a')).toBe('acme-a')
    expect(idx.get('acme-b')).toBe('acme-b')
    expect(idx.get('bolt')).toBe('acme-b')
    // …but NOT the Globex bot, nor the HQ/main bot — no chip, no existence leak.
    expect(idx.has('globex-a')).toBe(false)
    expect(idx.has('gizmo')).toBe(false)
    expect(idx.has('pa')).toBe(false)
    expect(idx.has('assistant')).toBe(false)
  })

  test('a main/HQ session (company_id null) keeps the FULL fleet index', () => {
    // The owner is omniscient — a PA bot may reference any bot in any company.
    const idx = scopedMentionIndex(fleet, 'pa')
    expect(idx.get('acme-a')).toBe('acme-a')
    expect(idx.get('globex-a')).toBe('globex-a')
    expect(idx.get('gizmo')).toBe('globex-a')
    expect(idx.get('pa')).toBe('pa')
  })

  test('an unknown self name is treated as HQ (full index), never a silent empty', () => {
    const idx = scopedMentionIndex(fleet, 'nobody')
    expect(idx.get('acme-a')).toBe('acme-a')
    expect(idx.get('globex-a')).toBe('globex-a')
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

/* ── the harness feed ────────────────────────────────────────────────────── */

/**
 * The transcript as a management log (Task 5). The events come from
 * `GET /api/sessions/{name}/events` — the durable audit ledger, not SSE — and
 * they are merged into the SAME ts-ordered stream the messages are in, so a
 * delegation that happened between two turns reads where it happened.
 *
 * Two of them are deliberately NOT lines:
 *   · an INBOUND delegate already has a rendering — the arrival divider over
 *     the message it delivered. A line as well would say it twice.
 *   · a rename the OWNER typed is ceremony: they did it two seconds ago, in
 *     this app. Only a session renaming ITSELF is news.
 */
describe('harness events in the stream', () => {
  const events: HarnessEvent[] = [
    { id: 1, ts: 1500, actor: 'user', action: 'session.delegate', target: 'deploy-fix', detail: { from: 'web-ui' } },
    { id: 2, ts: 1600, actor: 'user', action: 'session.delegate', target: 'web-ui', detail: { from: 'deploy-fix' } },
    { id: 3, ts: 1700, actor: 'user', action: 'session.rename', target: 'web-ui', detail: { from: 'a', to: 'b' } },
  ]

  test('merges by ts and suppresses inbound delegate + user rename', () => {
    const items = [user('u1', 1000), assistant('a1', 2000)]
    const nodes = buildTranscript(items, { nowMs: 3000, events, self: 'web-ui' })
    const harness = nodes.filter((n) => n.kind === 'harness')
    expect(harness.map((h) => (h.kind === 'harness' ? h.ev.id : -1))).toEqual([1])
    const idx = nodes.findIndex((n) => n.kind === 'harness')
    // ts-ordered: it sits between the two turns, not at either end.
    expect(nodes[idx - 1]).toMatchObject({ kind: 'item', key: 'u1' })
    expect(nodes[idx + 1]).toMatchObject({ kind: 'item', key: 'a1' })
  })

  test('a mid-turn user message stays ABOVE the reply that answers it', () => {
    // THE ORDERING BUG. With the management log merged in, the stream used to be
    // TOTAL-sorted by ts (`stream.sort((a, b) => a.ts - b.ts)`). A message the
    // owner sends MID-TURN carries a later wall-clock stamp (105) than the reply
    // that follows it (101) — the reply belongs to a turn that STARTED at 100
    // and is stamped with that earlier clock. Arrival order (the wire's own
    // write order) is the truth: `u-mid` came in before `reply` was emitted. The
    // by-ts sort reordered them and hoisted the reply ABOVE the very message it
    // answers; the merge keeps the item backbone in arrival order.
    const items = [
      user('u-start', 100), // the turn starts
      user('u-mid', 105), // the owner sends another message while it works
      assistant('reply', 101), // the reply, stamped with the earlier turn's clock
    ]
    const withLog: HarnessEvent[] = [
      { id: 1, ts: 100, actor: 'user', action: 'schedule.create', target: 's1', detail: { session: 'web-ui', title: 'Nightly' } },
    ]
    const nodes = buildTranscript(items, { nowMs: 3_000_000, events: withLog, self: 'web-ui' })
    const order = nodes.flatMap((n) => (n.kind === 'item' ? [n.item.uuid] : []))
    expect(order).toEqual(['u-start', 'u-mid', 'reply'])
    expect(order.indexOf('u-mid')).toBeLessThan(order.indexOf('reply'))
  })

  test('a session renaming ITSELF is news', () => {
    const self: HarnessEvent[] = [
      { id: 9, ts: 1500, actor: 'agent:web-ui', action: 'session.rename', target: 'web-ui', detail: { from: 'a', to: 'b' } },
    ]
    const nodes = buildTranscript([user('u1', 1000)], { nowMs: 3000, events: self, self: 'web-ui' })
    expect(nodes.filter((n) => n.kind === 'harness')).toHaveLength(1)
  })

  test('a centred line breaks the run under it', () => {
    // Two assistant turns one second apart would stack into one run; a system
    // line between them ends it, so the second re-hangs its mark.
    const items = [assistant('a1', 1000), assistant('a2', 1001)]
    const plain = buildTranscript(items, { nowMs: 3000 })
    expect(plain[2]).toMatchObject({ kind: 'item', key: 'a2', grouped: true, showGutter: false })
    const nodes = buildTranscript(items, {
      nowMs: 3000,
      self: 'web-ui',
      events: [
        { id: 4, ts: 1000, actor: 'user', action: 'schedule.create', target: 's1', detail: { session: 'web-ui', title: 'Nightly' } },
      ],
    })
    const a2 = nodes.find((n) => n.kind === 'item' && n.key === 'a2')
    expect(a2).toMatchObject({ grouped: false, showGutter: true })
  })

  test('no events is the old stream, byte for byte', () => {
    const items = [user('u1', 1000), assistant('a1', 1001)]
    expect(buildTranscript(items, { nowMs: 3000, events: [], self: 'web-ui' })).toEqual(
      buildTranscript(items, { nowMs: 3000 }),
    )
  })

  test('a run of consecutive delegations collapses to ONE grouped node', () => {
    // THE WALL (owner's IMG_2353). A session that messaged other bots many
    // times logs one `session.delegate` row per event; rendered as standalone
    // lines they stack as identical narrator rows — one per event, and a
    // session-block divider between any two that straddle the 30-min gap. The
    // fold turns a maximal run of back-to-back delegations into a single
    // `harness-run` node that carries every event (nothing is lost) and takes
    // at most one divider.
    const wall: HarnessEvent[] = Array.from({ length: 6 }, (_, i) => ({
      id: 100 + i,
      // Spread across days so, unfolded, each would earn its own divider.
      ts: 1_000 + i * SESSION_GAP_S * 2,
      actor: 'user',
      action: 'session.delegate',
      target: 'ipc',
      detail: { from: 'web-ui' },
    }))
    const nodes = buildTranscript([user('u1', 500)], {
      nowMs: 9_000_000,
      self: 'web-ui',
      events: wall,
    })
    const runs = nodes.filter((n) => n.kind === 'harness-run')
    expect(runs).toHaveLength(1)
    const run = runs[0]
    if (run.kind !== 'harness-run') throw new Error('unreachable')
    expect(run.evs.map((e) => e.id)).toEqual([100, 101, 102, 103, 104, 105])
    // No bare per-event `harness` lines survive the fold, and the whole run
    // takes exactly one session-block divider rather than one per delegation.
    expect(nodes.filter((n) => n.kind === 'harness')).toHaveLength(0)
    expect(nodes.filter((n) => n.kind === 'divider')).toHaveLength(1)
  })

  test('a lone delegation is left as a plain line, not a run', () => {
    // The common one-off case must stay byte-identical: a single delegation is
    // still a `harness` line, never a one-element run.
    const nodes = buildTranscript([user('u1', 500)], {
      nowMs: 9_000,
      self: 'web-ui',
      events: [
        { id: 7, ts: 1_000, actor: 'user', action: 'session.delegate', target: 'ipc', detail: { from: 'web-ui' } },
      ],
    })
    expect(nodes.filter((n) => n.kind === 'harness-run')).toHaveLength(0)
    expect(nodes.filter((n) => n.kind === 'harness')).toHaveLength(1)
  })

  test('a non-delegation event between two delegations breaks the run', () => {
    // A rename or schedule fire is different news; like a differing tool in the
    // receipt coalescer it ends the run, so the two delegations do NOT fold
    // across it.
    const nodes = buildTranscript([user('u1', 500)], {
      nowMs: 9_000,
      self: 'web-ui',
      events: [
        { id: 1, ts: 1_000, actor: 'user', action: 'session.delegate', target: 'ipc', detail: { from: 'web-ui' } },
        { id: 2, ts: 1_100, actor: 'agent:web-ui', action: 'session.rename', target: 'web-ui', detail: { from: 'a', to: 'b' } },
        { id: 3, ts: 1_200, actor: 'user', action: 'session.delegate', target: 'ipc', detail: { from: 'web-ui' } },
      ],
    })
    // Two lone delegations either side of the rename — three plain lines, no run.
    expect(nodes.filter((n) => n.kind === 'harness-run')).toHaveLength(0)
    expect(nodes.filter((n) => n.kind === 'harness')).toHaveLength(3)
  })

  test('an action nothing can render is not printed', () => {
    // The server filters to the surfaced set; the renderer has copy for four
    // actions and no fallback sentence, so an unknown one is dropped here
    // rather than rendered as an empty line.
    const nodes = buildTranscript([user('u1', 1000)], {
      nowMs: 3000,
      self: 'web-ui',
      events: [{ id: 5, ts: 1500, actor: 'user', action: 'session.delete', target: 'web-ui', detail: {} }],
    })
    expect(nodes.filter((n) => n.kind === 'harness')).toHaveLength(0)
  })
})

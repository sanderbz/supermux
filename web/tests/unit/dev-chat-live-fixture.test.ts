/**
 * The `/dev/chat-live` fixture — is the bench still a review surface?
 * ─────────────────────────────────────────────────────────────────────────────
 * A visual bench is only worth screenshotting if it provably shows every state
 * the surface can be in. This asserts exactly that, the same way
 * `dev-marks-cast.test.ts` does for the marks: the page claims eight states, and
 * each one has to actually CARRY the thing it is named after — a permission
 * state with no `permission_request` is a screenshot of nothing.
 *
 * It also pins the two indexes the bench stands in for (pins by slug, display
 * names by slug), because both were bugs once: the boards' coral Release Train
 * rendered in whatever `release-train` happened to hash to, and the arrival
 * divider read "Message from ●patch".
 */
import { describe, expect, test } from 'bun:test'

import { toDisplayList } from '../../src/components/chat/entries'
import { mentionSegments } from '../../src/components/chat/grouping'
import {
  atRows,
  classifySlash,
  readTrigger,
  slashRows,
} from '../../src/components/chat/slash'
import {
  BENCH_COMMANDS,
  BENCH_ROSTER,
  liveStates,
  MENTIONABLE,
  MENTIONS,
  NAMES,
  PINS,
  pinFor,
  STATE_IDS,
  TRACKED_FILES,
} from '../../src/routes/dev-chat-live.fixture'

const NOW = 1_760_000_000_000
const states = liveStates(NOW)
const byId = new Map(states.map((s) => [s.id, s]))

describe('coverage: every state the surface can be in', () => {
  test('the page ships exactly the states it advertises', () => {
    expect(states.map((s) => s.id)).toEqual([...STATE_IDS])
  })

  test('every state names the board it is held against', () => {
    for (const s of states) {
      expect(s.title.length).toBeGreaterThan(0)
      expect(s.board.length).toBeGreaterThan(0)
    }
  })

  test('idle has a transcript and NO live turn', () => {
    const s = byId.get('idle')!
    expect(s.turnAgo).toBeUndefined()
    expect(s.session.status).toBe('idle')
    expect(toDisplayList(s.entries).length).toBeGreaterThan(5)
  })

  test('working is a running turn with hook receipts, the last one live', () => {
    const s = byId.get('working')!
    expect(s.session.status).toBe('active')
    expect(s.turnAgo).toBeGreaterThan(5) // past the elapsed clause's first rung
    expect(s.overlay?.length ?? 0).toBeGreaterThan(1)
  })

  test('provisional carries a pty capture', () => {
    const s = byId.get('provisional')!
    expect(s.provisional?.length ?? 0).toBeGreaterThan(3)
  })

  test('permission carries the wire OBJECT, not a string', () => {
    const req = byId.get('permission')!.session.permission_request
    expect(req?.tool).toBe('Bash')
    expect(req?.summary).toContain('cargo publish')
  })

  test('delegation has BOTH ends: an arrival in the transcript, a target in the activity', () => {
    const s = byId.get('delegation')!
    expect(s.entries.some((e) => e.kind === 'teammate' && e.label === 'patch')).toBe(true)
    // The pill only draws when the activity names a session that EXISTS.
    const named = mentionSegments(s.session.activity ?? '', MENTIONS, s.session.name).find(
      (seg) => 'seed' in seg,
    )
    expect(named).toBeDefined()
  })

  test('error is a failed run said calmly — the failure is in the outcome', () => {
    const s = byId.get('error')!
    expect(s.session.status).toBe('error')
    expect(s.entries.some((e) => e.kind === 'tool_use' && e.ok === false)).toBe(true)
  })

  test('offline is the tail itself failing', () => {
    const s = byId.get('offline')!
    expect(s.isError).toBe(true)
    expect(s.entries).toEqual([])
  })

  test('patch is a DIFFERENT session — the accent re-skin has something to re-skin', () => {
    const s = byId.get('patch')!
    expect(s.session.name).not.toBe(byId.get('idle')!.session.name)
    // The approved Patch board's one fenced block is a diff.
    expect(s.entries.some((e) => e.text.includes('```'))).toBe(true)
  })

  // ── the interactive states (fase A4 T9) ───────────────────────────────────
  //
  // A bench state that MERELY LOOKS like an open popover is worth nothing: the
  // point of screenshotting this surface is to catch it lying. So each of these
  // asserts the fixture against the composer's own arithmetic — the trigger is
  // the one `readTrigger` reads, the refusal is the one `classifySlash` makes,
  // and the rows are the ones the shipped builders produce.

  test('composing declares the picker its OWN draft would open', () => {
    const c = byId.get('composing')!.composer!
    expect(c.draft.length).toBeGreaterThan(0)
    const trigger = readTrigger(c.draft, c.draft.length)
    expect(trigger?.kind).toBe(c.picker!.kind)
    expect(trigger?.query).toBe(c.picker!.query)
  })

  test('composing’s popover shows BOTH `@` sources — files and a session', () => {
    // An empty list is not a board, and a list with only one of the two sources
    // would let the mention half of `@` rot unseen.
    const c = byId.get('composing')!.composer!
    const rows = atRows(TRACKED_FILES, MENTIONABLE, 'release-train', c.picker!.query)
    expect(rows.length).toBeGreaterThan(2)
    expect(rows.some((r) => r.kind === 'file')).toBe(true)
    expect(rows.some((r) => r.kind === 'session')).toBe(true)
    expect(rows.every((r) => r.value.startsWith('@'))).toBe(true)
  })

  test('slash shows a refusal the classifier actually makes', () => {
    const c = byId.get('slash')!.composer!
    expect(classifySlash(c.draft)).toBe('picker')
    expect(c.notice).toEqual({ kind: 'slash-picker', detail: '/model' })
  })

  test('slash’s popover carries a terminal-only row AND an ordinary one', () => {
    const rows = slashRows(BENCH_COMMANDS, byId.get('slash')!.composer!.picker!.query)
    expect(rows.some((r) => r.warn)).toBe(true)
    expect(slashRows(BENCH_COMMANDS, '').some((r) => !r.warn)).toBe(true)
  })

  test('every other state leaves the composer to A3’s read-only shell', () => {
    const live = states.filter((s) => s.composer)
    expect(live.map((s) => s.id)).toEqual(['composing', 'slash'])
  })
})

describe('the two indexes the bench stands in for', () => {
  test('a pin resolves by slug AND by display name — one character, two keys', () => {
    expect(pinFor('release-train')).toEqual(pinFor('Release Train')!)
    expect(PINS.get('patch')).toEqual(PINS.get('Patch')!)
    // The boards were art-directed: without the pin this is not the same face.
    expect(pinFor('release-train')?.hue).toBe(28)
  })

  test('mentions map both spellings to the slug; names map the slug back', () => {
    expect(MENTIONS.get('patch')).toBe('patch')
    expect(MENTIONS.get('release train')).toBe('release-train')
    expect(NAMES.get('release-train')).toBe('Release Train')
  })

  test('every roster row is one of the cast, so the sidebar and the transcript agree', () => {
    for (const row of BENCH_ROSTER) expect(pinFor(row.seed)).toBeDefined()
  })
})

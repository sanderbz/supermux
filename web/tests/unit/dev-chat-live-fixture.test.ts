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
  BENCH_ROSTER,
  liveStates,
  MENTIONS,
  NAMES,
  PINS,
  pinFor,
  STATE_IDS,
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

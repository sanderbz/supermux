/**
 * T4.4 — merging the local and server seen cursors.
 *
 * B5 did NOT replace localStorage with the server cursor. Both layers stay, and
 * they do different jobs:
 *
 * * localStorage is the write-through layer. It is what makes `markRead`
 *   instant — the dot disappears before any request leaves — and it is what
 *   keeps the roster honest offline.
 * * The server cursor (migration 0029) is what makes a read FOLLOW you: mark a
 *   session read on the desktop and the phone agrees without a reload.
 *
 * So at any moment there can be two answers for one session, and this file pins
 * the rule that resolves them. It is the whole of T4.4's client half, which is
 * why it is tested as a pure function rather than through the hook.
 */
import { describe, expect, test } from 'bun:test'

import {
  mergeCursors,
  serverCursor,
  tierFor,
  unreadCount,
  type AttentionSession,
  type SeenCursor,
} from '../../src/lib/attention-tiers'

const NOW = 1_800_000_000_000

const session = (over: Partial<AttentionSession> = {}): AttentionSession =>
  ({
    name: 'deploy-fix',
    status: 'idle',
    activity_at: NOW - 10_000,
    ...over,
  }) as AttentionSession

describe('mergeCursors — newest wins', () => {
  test('local only, when the write has not landed or we are offline', () => {
    const local: SeenCursor = { ts: NOW }
    expect(mergeCursors(local, undefined)).toBe(local)
  })

  test('server only, on a fresh device or one that cleared its storage', () => {
    // This is the case the whole feature exists for: a phone that has never
    // opened this session still knows it was read on the desktop.
    const server: SeenCursor = { ts: NOW }
    expect(mergeCursors(undefined, server)).toBe(server)
  })

  test('neither is undefined, not an empty cursor', () => {
    // A `{ts: 0}` here would read as "seen at the epoch" and mark every session
    // read, which is the single worst failure this model can have.
    expect(mergeCursors(undefined, undefined)).toBeUndefined()
  })

  test('the later timestamp wins, in both directions', () => {
    const older: SeenCursor = { ts: NOW - 60_000, count: 1, epoch: 1 }
    const newer: SeenCursor = { ts: NOW, count: 9, epoch: 1 }
    expect(mergeCursors(older, newer)).toBe(newer)
    expect(mergeCursors(newer, older)).toBe(newer)
  })

  test('a tie goes to local', () => {
    // A tie means the same read round-tripped. Preferring local keeps the
    // count/epoch this device actually observed rather than a copy of it.
    const local: SeenCursor = { ts: NOW, count: 7, epoch: 2 }
    const server: SeenCursor = { ts: NOW, count: 7, epoch: 2 }
    expect(mergeCursors(local, server)).toBe(local)
  })

  test('a stale tab cannot un-read what another device caught up on', () => {
    // The client half of the server's monotonic guard: even if a sleeping tab
    // hands us its hour-old cursor, the merged answer is the newer one.
    const stale: SeenCursor = { ts: NOW - 3_600_000 }
    const caughtUp: SeenCursor = { ts: NOW }
    expect(mergeCursors(stale, caughtUp)).toBe(caughtUp)
  })
})

describe('serverCursor — reading the row', () => {
  test('a session that has never been read has no cursor', () => {
    expect(serverCursor(session())).toBeUndefined()
    expect(serverCursor(session({ seen_ts: null }))).toBeUndefined()
  })

  test('the triple round-trips off the row', () => {
    const c = serverCursor(session({ seen_ts: NOW, seen_count: 42, seen_epoch: 3 }))
    expect(c).toEqual({ ts: NOW, count: 42, epoch: 3 })
  })

  test('a timestamp-only cursor keeps count and epoch ABSENT, not zero', () => {
    // `count: 0` would mean "zero entries seen" and make everything unread;
    // absent means "no count was recorded", which `unreadCount` handles by
    // rendering a dot.
    const c = serverCursor(session({ seen_ts: NOW, seen_count: null, seen_epoch: null }))
    expect(c).toEqual({ ts: NOW })
    expect(c && 'count' in c).toBe(false)
  })

  test('a non-finite stamp is rejected rather than trusted', () => {
    // A garbage cursor would silence a session forever — the one failure this
    // model must not have.
    expect(serverCursor(session({ seen_ts: NaN }))).toBeUndefined()
  })
})

describe('the merged cursor still obeys B2s epoch rule', () => {
  const withTail = (entry_count: number, epoch: number): AttentionSession =>
    session({
      chat_tail: { user: '', agent: 'x', ts: NOW, entry_count, last_entry_ts: NOW, epoch },
    })

  test('a matching epoch yields a number', () => {
    const merged = mergeCursors({ ts: NOW - 1_000, count: 10, epoch: 4 }, undefined)
    expect(unreadCount(withTail(13, 4), merged)).toBe(3)
  })

  test('a server cursor from a DIFFERENT epoch degrades to a dot, not a wrong number', () => {
    // The store is created and dropped many times a day and its seq restarts at
    // 0 each time, so subtracting across epochs would produce nonsense — a
    // negative count, or a huge one. `null` means "render a dot".
    const merged = mergeCursors(undefined, { ts: NOW - 1_000, count: 10, epoch: 2 })
    expect(unreadCount(withTail(13, 4), merged)).toBeNull()
  })

  test('a server cursor newer than the activity marks the session not-unread', () => {
    const merged = mergeCursors(undefined, { ts: NOW })
    expect(tierFor(session({ activity_at: NOW - 10_000 }), merged, NOW)).toBe('quiet')
  })
})

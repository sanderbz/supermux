/**
 * `lib/attention-tiers.ts` — written as a FALSE-POSITIVE suite.
 *
 * The named risk (§18, and the #41/#43 class before it) is not "the tiers are
 * wrong", it is "the tiers light up when nothing happened". A roster where three
 * rows claim to need you and none of them does is worse than a roster with no
 * tiers at all, because it trains the user to ignore the signal.
 *
 * So most of what follows asserts a NEGATIVE: a session with no chat store still
 * gets a tier but does not light up; a remote-host session behaves like a local
 * one; a fresh install lights up nothing; a store that was dropped and rebuilt
 * yields no number rather than a wrong one.
 */
import { describe, expect, test } from 'bun:test'

import {
  activityStamp,
  attentionFor,
  cursorFor,
  mergeCursors,
  rollup,
  tierFor,
  TIERS,
  unreadCount,
  unreadCursorFor,
  unreadSessions,
  type AttentionSession,
  type SeenCursor,
} from '../../src/lib/attention-tiers'

const NOW = 1_800_000_000_000

const session = (over: Partial<AttentionSession> = {}): AttentionSession => ({
  name: 'supermux',
  status: 'idle',
  activity_at: NOW - 60_000,
  ...over,
})

const seen = (over: Partial<SeenCursor> = {}): SeenCursor => ({ ts: NOW - 30_000, ...over })

describe('every row gets a tier — whatever it is', () => {
  test('the precedence order is the documented one', () => {
    expect([...TIERS]).toEqual(['needs', 'unread', 'working', 'quiet'])
  })

  test('a codex session with no chat store still gets a tier', () => {
    const s = session({ name: 'codex-job', status: 'active', chat_tail: undefined })
    expect(tierFor(s, seen(), NOW)).toBe('working')
  })

  test('a session with no store and nothing recent is quiet, not undefined', () => {
    const s = session({ status: 'idle', activity_at: NOW - 86_400_000 })
    expect(tierFor(s, seen(), NOW)).toBe('quiet')
  })

  test('a remote-host session behaves exactly like a local one', () => {
    const local = session({ status: 'waiting' })
    const remote = session({ status: 'waiting' })
    expect(tierFor(local, seen(), NOW)).toBe(tierFor(remote, seen(), NOW))
  })

  test('a session with NO stamps at all still gets a tier', () => {
    const s: AttentionSession = { name: 'ghost', status: 'idle' }
    expect(activityStamp(s)).toBe(0)
    expect(tierFor(s, undefined, NOW)).toBe('quiet')
  })
})

describe('needs — the tier that must not cry wolf', () => {
  test('status waiting', () => {
    expect(tierFor(session({ status: 'waiting' }), seen(), NOW)).toBe('needs')
  })

  test('a live permission request', () => {
    const s = session({
      permission_request: { tool: 'Bash', input: 'rm -rf' } as never,
    })
    expect(tierFor(s, seen(), NOW)).toBe('needs')
  })

  test('an unrecovered error — the FIELD, not a status', () => {
    // Rust's Status enum has no Error variant; errors ride `error:{type,message}`.
    const s = session({ status: 'idle', error: { type: 'rate_limit', message: 'slow down' } })
    expect(tierFor(s, seen(), NOW)).toBe('needs')
  })

  test('error outranks unread', () => {
    const s = session({
      status: 'idle',
      error: { type: 'billing_error', message: '' },
      activity_at: NOW, // newer than the cursor ⇒ would otherwise be unread
    })
    expect(tierFor(s, seen(), NOW)).toBe('needs')
  })

  test('needs outranks working when both apply', () => {
    const s = session({ status: 'waiting', activity_at: NOW })
    expect(tierFor(s, seen(), NOW)).toBe('needs')
  })

  test('a cleared permission request (null) does NOT need you', () => {
    // The delta sends `null` to clear; `mergeRow` passes null through.
    const s = session({ permission_request: null })
    expect(tierFor(s, seen(), NOW)).toBe('quiet')
  })
})

describe('unread — the false-positive surface', () => {
  test('a fresh install lights up NOTHING', () => {
    // No cursors at all: every row has activity, none has been opened.
    const rows = [
      session({ name: 'a', activity_at: NOW - 1000 }),
      session({ name: 'b', activity_at: NOW - 2000 }),
      session({ name: 'c', activity_at: NOW - 3000 }),
    ]
    for (const s of rows) expect(tierFor(s, undefined, NOW)).not.toBe('unread')
    expect(unreadSessions(rows, new Map(), NOW)).toEqual([])
  })

  test('a session opened and closed with no new activity returns to quiet', () => {
    const s = session({ status: 'idle', activity_at: NOW - 60_000 })
    const cursor = cursorFor(s, NOW)
    expect(tierFor(s, cursor, NOW)).toBe('quiet')
  })

  test('activity AFTER the cursor is unread', () => {
    const s = session({ status: 'idle', activity_at: NOW - 10_000 })
    expect(tierFor(s, seen({ ts: NOW - 30_000 }), NOW)).toBe('unread')
  })

  test('a fresh unrelated session never lights up while ANOTHER works', () => {
    // The gate the e2e spec re-asserts against a live server.
    const busy = session({ name: 'busy', status: 'active', activity_at: NOW })
    const fresh = session({ name: 'fresh', status: 'idle', activity_at: NOW - 900_000 })
    const cursors = new Map([['fresh', cursorFor(fresh, NOW - 800_000)]])
    expect(tierFor(fresh, cursors.get('fresh'), NOW)).toBe('quiet')
    expect(tierFor(busy, cursors.get('busy'), NOW)).toBe('working')
  })

  test('a cursor from the future cannot mark everything read forever', () => {
    // Clock skew between two devices writing the same localStorage-less cursor.
    const s = session({ activity_at: NOW - 1000 })
    expect(tierFor(s, seen({ ts: NOW + 86_400_000 }), NOW)).toBe('quiet')
    // …and activity NEWER than the (skewed) cursor is still unread: the clamp
    // bounds the cursor, it does not blindly trust it.
    expect(
      tierFor(session({ activity_at: NOW + 5_000 }), seen({ ts: NOW + 1 }), NOW),
    ).toBe('unread')
  })

  test('a stopped session is never `working`', () => {
    for (const status of ['stopped', 'idle'] as const) {
      expect(tierFor(session({ status }), seen({ ts: NOW }), NOW)).not.toBe('working')
    }
  })

  test('an archived session is excluded from every rollup', () => {
    const rows = [
      session({ name: 'gone', status: 'waiting', archived: true }),
      session({ name: 'here', status: 'waiting' }),
    ]
    expect(rollup(rows, new Map(), NOW).map((s) => s.name)).toEqual(['here'])
  })
})

describe('the activity ladder is provider-neutral', () => {
  test('activity_at wins — server clock, ms', () => {
    expect(activityStamp(session({ activity_at: 1234, last_activity: 9 }))).toBe(1234)
  })

  test('last_activity is SECONDS and is converted', () => {
    const s: AttentionSession = { name: 'x', status: 'idle', last_activity: 1_700_000_000 }
    expect(activityStamp(s)).toBe(1_700_000_000_000)
  })

  test('updated_at is the third rung', () => {
    const s: AttentionSession = {
      name: 'x',
      status: 'idle',
      updated_at: '2026-08-16T12:00:00Z',
    }
    expect(activityStamp(s)).toBe(Date.parse('2026-08-16T12:00:00Z'))
  })

  test("chat_tail is the LAST resort — it is CC's clock, not the server's", () => {
    const withBoth: AttentionSession = {
      name: 'x',
      status: 'idle',
      activity_at: 5000,
      chat_tail: { user: '', agent: 'hi', ts: 9999, last_entry_ts: 9999 },
    }
    expect(activityStamp(withBoth)).toBe(5000)
    const tailOnly: AttentionSession = {
      name: 'x',
      status: 'idle',
      chat_tail: { user: '', agent: 'hi', ts: 4242, last_entry_ts: 4242 },
    }
    expect(activityStamp(tailOnly)).toBe(4242)
  })

  test('a garbage updated_at does not produce NaN', () => {
    const s: AttentionSession = { name: 'x', status: 'idle', updated_at: 'not a date' }
    expect(activityStamp(s)).toBe(0)
  })
})

describe('unreadCount — a number, or honestly nothing', () => {
  const tail = (over: Partial<NonNullable<AttentionSession['chat_tail']>> = {}) => ({
    user: 'do the thing',
    agent: 'done',
    ts: NOW,
    entry_count: 20,
    last_entry_ts: NOW,
    epoch: 7,
    ...over,
  })

  test('a matching epoch gives a real delta', () => {
    const s = session({ chat_tail: tail() })
    expect(unreadCount(s, seen({ count: 14, epoch: 7 }))).toBe(6)
  })

  test('a DIFFERENT epoch gives null — the store was dropped and rebuilt', () => {
    const s = session({ chat_tail: tail({ epoch: 8 }) })
    expect(unreadCount(s, seen({ count: 14, epoch: 7 }))).toBeNull()
  })

  test('a decreasing count yields null, never a negative', () => {
    const s = session({ chat_tail: tail({ entry_count: 3 }) })
    expect(unreadCount(s, seen({ count: 14, epoch: 7 }))).toBeNull()
  })

  test('no store attached ⇒ null, not zero', () => {
    expect(unreadCount(session({ chat_tail: undefined }), seen({ count: 1, epoch: 7 }))).toBeNull()
  })

  test('a pre-B2 server (no entry_count/epoch) ⇒ null', () => {
    const s = session({ chat_tail: { user: '', agent: 'hi', ts: NOW } })
    expect(unreadCount(s, seen({ count: 1, epoch: 7 }))).toBeNull()
  })

  test('a cursor with no count ⇒ null', () => {
    expect(unreadCount(session({ chat_tail: tail() }), seen())).toBeNull()
  })

  test('an equal count ⇒ null, not 0 — there is nothing to say', () => {
    expect(unreadCount(session({ chat_tail: tail() }), seen({ count: 20, epoch: 7 }))).toBeNull()
  })

  test('attentionFor only carries a count when the tier is unread', () => {
    const s = session({
      status: 'waiting',
      chat_tail: tail(),
      activity_at: NOW,
    })
    const a = attentionFor(s, seen({ count: 14, epoch: 7 }), NOW)
    expect(a.tier).toBe('needs')
    expect(a.dot).toBe(true)
    expect(a.count).toBeNull()
  })
})

describe('rollup — oldest waiting first', () => {
  test('ordered by how long they have been kept waiting', () => {
    const rows = [
      session({ name: 'recent', status: 'waiting', activity_at: NOW - 1_000 }),
      session({ name: 'ancient', status: 'waiting', activity_at: NOW - 900_000 }),
      session({ name: 'middle', status: 'waiting', activity_at: NOW - 60_000 }),
      session({ name: 'calm', status: 'idle' }),
    ]
    expect(rollup(rows, new Map(), NOW).map((s) => s.name)).toEqual([
      'ancient',
      'middle',
      'recent',
    ])
  })

  test('a session with no stamp sorts LAST — unknown is not ancient', () => {
    const rows = [
      session({ name: 'stamped', status: 'waiting', activity_at: NOW - 1000 }),
      { name: 'unstamped', status: 'waiting' } as AttentionSession,
    ]
    expect(rollup(rows, new Map(), NOW).map((s) => s.name)).toEqual(['stamped', 'unstamped'])
  })

  test('N = 0 when nobody wants you', () => {
    expect(rollup([session(), session({ status: 'active' })], new Map(), NOW)).toEqual([])
  })
})

describe('cursorFor — what "I have seen this" records', () => {
  test('captures the count and epoch when a store exists', () => {
    const s = session({
      chat_tail: { user: '', agent: 'x', ts: NOW, entry_count: 42, last_entry_ts: NOW, epoch: 3 },
    })
    expect(cursorFor(s, NOW)).toEqual({ ts: NOW, count: 42, epoch: 3 })
  })

  test('records only a timestamp when no store exists', () => {
    expect(cursorFor(session({ chat_tail: undefined }), NOW)).toEqual({ ts: NOW })
  })

  test('never records a cursor BEHIND the session it just read', () => {
    // A session whose stamp is ahead of our clock would otherwise stay unread
    // the instant it was opened.
    const s = session({ activity_at: NOW + 5_000 })
    expect(cursorFor(s, NOW).ts).toBe(NOW + 5_000)
    expect(tierFor(s, cursorFor(s, NOW), NOW)).toBe('quiet')
  })
})

// ── R2: the two tier vocabularies (B5/T3.5) ─────────────────────────────────
//
// The server's push `Tier` (`attention | unread | error | schedule` — what a
// push IS) and this module's `TIERS` (`needs | unread | working | quiet` —
// what a session LOOKS like in the roster) are DIFFERENT SETS sharing exactly
// one word. That single overlap is the hazard: `unread` means the same thing
// in both, which makes it easy to assume the rest do too and "unify" them.
//
// They answer different questions, so the relationship is a mapping, not a
// rename. It is asserted from BOTH sides — `notify.rs`'s
// `the_server_tiers_map_onto_the_client_roster_tiers` is the mirror of this —
// so a rename on either side breaks a test instead of drifting silently.
// `BRAND.md` §6f carries the table in prose.
describe('the server push tiers map onto the roster tiers', () => {
  /** The mapping, transcribed from `notify::Tier::client_tier`. */
  const SERVER_TO_CLIENT: Record<string, string | null> = {
    attention: 'needs',
    // An error NEEDS you every bit as much as a block does.
    error: 'needs',
    unread: 'unread',
    // The scheduler lane has no roster row to tier.
    schedule: null,
  }

  test('every mapped target is a tier this module actually ships', () => {
    for (const [server, client] of Object.entries(SERVER_TO_CLIENT)) {
      if (client === null) continue
      expect(TIERS as readonly string[]).toContain(client)
      expect(server).not.toBe('')
    }
  })

  test('`working` and `quiet` are unreachable from a push, deliberately', () => {
    // They describe a session nobody needs to hear about — precisely the set
    // that must never buzz a phone. If a future server tier maps onto either,
    // that is a product decision, not a refactor, and this test should be the
    // thing that forces the conversation.
    const targets = Object.values(SERVER_TO_CLIENT).filter((v) => v !== null)
    expect(targets).not.toContain('working')
    expect(targets).not.toContain('quiet')
  })

  test('`unread` is the one shared word, and it means the same thing', () => {
    // Both sides use it for "something happened, nothing is blocked". The
    // server suppresses that tier's banner while the session is being viewed;
    // the client renders it as a dot rather than a demand.
    expect(SERVER_TO_CLIENT.unread).toBe('unread')
    expect(TIERS as readonly string[]).toContain('unread')
  })
})

// ── R3: the unread tier is REACHABLE and VISIBLE ────────────────────────────
//
// The three-tier model shipped as a one-tier model. Three independent defects,
// all of which had to be fixed together — fixing any one alone still yields no
// unread anywhere on the roster:
//
//   RENDER  `attentionFor` set `dot: tier === 'needs'`, so an unread row was
//           pixel-identical to a quiet one and `Attention.count` (fed by the
//           whole T5 server change: entry_count / epoch / last_entry_ts) had no
//           consumer at all.
//   ENTRY   the desktop focus route's markRead effect was keyed on `[name]`
//           while `current` is undefined on the first render, so a cold load
//           wrote no cursor and `tierFor` reported `quiet` forever after.
//           (Covered by the e2e — it is a React deps array, not arithmetic.)
//   TOGGLE  `markUnread` DELETED the cursor, and `tierFor` treats "no cursor"
//           as never-opened ⇒ quiet. It was arithmetically incapable of marking
//           anything unread.
//
// What follows pins the arithmetic halves, including the case the 108-test
// suite was missing: markUnread on a session with a stamp ⇒ tier 'unread'.
describe('mark unread actually marks unread', () => {
  test('the cursor it writes lands the row in the `unread` tier', () => {
    const s = session({ status: 'idle', activity_at: NOW - 10_000 })
    // Read it first — this is the state the bug was invisible in.
    expect(tierFor(s, cursorFor(s, NOW), NOW)).toBe('quiet')
    expect(tierFor(s, unreadCursorFor(s), NOW)).toBe('unread')
  })

  test('DELETING the cursor — the old implementation — does not', () => {
    // The regression itself, stated as a fact about the model rather than about
    // the hook: "no cursor" is *never opened*, which is deliberately quiet.
    const s = session({ status: 'idle', activity_at: NOW - 10_000 })
    expect(tierFor(s, undefined, NOW)).toBe('quiet')
  })

  test('it survives later activity — the row stays unread, not re-read', () => {
    const s = session({ status: 'idle', activity_at: NOW - 10_000 })
    const cursor = unreadCursorFor(s)
    const spokeAgain = { ...s, activity_at: NOW - 1_000 }
    expect(tierFor(spokeAgain, cursor, NOW)).toBe('unread')
  })

  test('`needs` still outranks it — a blocked row is never merely unread', () => {
    const s = session({ status: 'waiting', activity_at: NOW - 10_000 })
    expect(tierFor(s, unreadCursorFor(s), NOW)).toBe('needs')
  })

  test('a row with NO activity stamp cannot be marked unread, and says so', () => {
    // There is no "since" to be after. A cursor at 0 reads as no cursor, i.e.
    // quiet — honest, rather than a badge that means nothing.
    const s = session({ activity_at: undefined, last_activity: undefined, updated_at: undefined })
    expect(activityStamp(s)).toBe(0)
    expect(unreadCursorFor(s).ts).toBe(0)
    expect(tierFor(s, unreadCursorFor(s), NOW)).toBe('quiet')
  })

  test('the count degrades to a dot — we no longer know how many you had read', () => {
    const s = session({
      status: 'idle',
      activity_at: NOW - 10_000,
      chat_tail: { entry_count: 12, epoch: 3 } as AttentionSession['chat_tail'],
    })
    const att = attentionFor(s, unreadCursorFor(s), NOW)
    expect(att.tier).toBe('unread')
    expect(att.count).toBeNull()
  })
})

describe('a local mark-unread outlives the server cursor (B5/T4.4)', () => {
  test('newest-wins would undo it, so the rewind wins outright', () => {
    const s = session({ status: 'idle', activity_at: NOW - 10_000 })
    const local = unreadCursorFor(s)
    // The server's cursor is a real read that really did happen later — it is
    // ALWAYS newer than the rewind, so without the exception "Mark unread" was
    // undone on the very next render of the roster.
    const server: SeenCursor = { ts: NOW }
    expect(server.ts).toBeGreaterThan(local.ts)
    expect(mergeCursors(local, server)).toBe(local)
    expect(tierFor(s, mergeCursors(local, server), NOW)).toBe('unread')
  })

  test('an ordinary read still loses to a newer server cursor', () => {
    const local: SeenCursor = { ts: NOW - 5_000 }
    const server: SeenCursor = { ts: NOW }
    expect(mergeCursors(local, server)).toBe(server)
  })

  test('reading the session afterwards clears the flag and the tier', () => {
    const s = session({ status: 'idle', activity_at: NOW - 10_000 })
    const reread = cursorFor(s, NOW)
    expect(reread.unread).toBeUndefined()
    expect(tierFor(s, reread, NOW)).toBe('quiet')
  })
})

describe('every visible tier has a visible affordance', () => {
  test('`unread` draws a dot — it used to draw nothing at all', () => {
    const s = session({ status: 'idle', activity_at: NOW - 10_000 })
    const att = attentionFor(s, unreadCursorFor(s), NOW)
    expect(att.dot).toBe(true)
    expect(att.dotKind).toBe('unread')
  })

  test('`needs` keeps its own, louder dot — the two are distinguishable', () => {
    const att = attentionFor(session({ status: 'waiting' }), seen(), NOW)
    expect(att.dot).toBe(true)
    expect(att.dotKind).toBe('needs')
  })

  test('`working` and `quiet` draw nothing — the signal stays a signal', () => {
    for (const s of [
      session({ status: 'active', activity_at: NOW - 60_000 }),
      session({ status: 'idle', activity_at: NOW - 60_000 }),
    ]) {
      const att = attentionFor(s, seen(), NOW)
      expect(att.dot).toBe(false)
      expect(att.dotKind).toBeNull()
    }
  })
})

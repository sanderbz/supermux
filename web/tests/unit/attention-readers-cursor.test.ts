/**
 * The single-row / imperative attention readers must merge the SERVER cursor,
 * not just localStorage (w6 #13).
 *
 * The provider path (`useAttention` → `cursors`) already merges both cursors
 * newest-wins, so the roster agrees with a read done on another device. The
 * single-row readers — `useSessionAttention` (focus header, picker) and the
 * non-hook `tierOf` — read `readSeen()[name]` ONLY. So a session read on device
 * B (server cursor advanced) but with a stale local cursor on device A would
 * keep showing `unread` in the focus header while the roster correctly showed it
 * read: two surfaces, two answers, for the same session.
 *
 * `tierOf` is the pure non-hook reader and carries the identical one-line merge
 * as `useSessionAttention`, so it pins the fix without a React render.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { tierOf } from '../../src/hooks/use-attention'
import type { AttentionSession } from '../../src/lib/attention-tiers'

// bun has no DOM localStorage; give the readers a minimal one so we can seed a
// stale LOCAL cursor and prove the server cursor overrides it.
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v))
  }
  removeItem(k: string): void {
    this.m.delete(k)
  }
  clear(): void {
    this.m.clear()
  }
}

const g = globalThis as unknown as { localStorage?: Storage }

const T1 = 1_800_000_000_000 // stale local read
const T2 = T1 + 10_000 // the session then spoke
const T3 = T2 + 10_000 // read on ANOTHER device, after it spoke

const seedLocal = (name: string, ts: number) => {
  g.localStorage!.setItem('supermux:seen', JSON.stringify({ [name]: { ts } }))
}

const session = (over: Partial<AttentionSession> = {}): AttentionSession =>
  ({
    name: 'deploy',
    status: 'idle',
    activity_at: T2,
    ...over,
  }) as AttentionSession

describe('tierOf merges the server cursor (w6 #13)', () => {
  beforeEach(() => {
    g.localStorage = new MemStorage() as unknown as Storage
  })
  afterEach(() => {
    delete g.localStorage
  })

  test('a read on another device (newer server cursor) overrides a stale local cursor', () => {
    // Local says "seen at T1", the session spoke at T2 → local-only reads UNREAD.
    seedLocal('deploy', T1)
    expect(tierOf(session())).toBe('unread')
    // The server cursor (read on device B at T3 > T2) must win the merge and
    // make the row read — this is the exact regression.
    expect(tierOf(session({ seen_ts: T3 }))).toBe('quiet')
  })

  test('with no local cursor at all, a server cursor still marks it read', () => {
    // Fresh device: nothing local, but the account cursor is past the activity.
    expect(tierOf(session({ seen_ts: T3 }))).toBe('quiet')
  })

  test('an OLDER server cursor does not un-read a fresher local read', () => {
    // Local read at T3 (newest); a stale server cursor at T1 must not resurrect
    // unread. Newest-wins ties to local; the row is read.
    seedLocal('deploy', T3)
    expect(tierOf(session({ seen_ts: T1 }))).toBe('quiet')
  })
})

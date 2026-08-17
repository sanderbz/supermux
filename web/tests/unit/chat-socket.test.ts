/**
 * The chat socket's behaviour — dialled, dropped, redialled, torn down.
 * ─────────────────────────────────────────────────────────────────────────────
 * `chat-socket.ts` is framework-free precisely so this file can exist: every
 * failure below is one a user experiences as "the conversation stopped
 * updating", and none of them is visible in a rendered snapshot.
 *
 *   · the handshake — auth FIRST, and nothing else ever sent (A2 is read-only)
 *   · the re-seed — a dropped socket's `high_water` is void, and the fresh
 *     seed REPLACES rather than appends
 *   · the close-code table — 4404 is terminal, everything else backs off
 *   · fetch-full — bounded, never twice, and a failure keeps the clip marker
 *   · the thrash — mount/unmount/mount leaves no socket and no timer behind
 */
import { describe, expect, test } from 'bun:test'

import {
  ChatSocket,
  backoffDelay,
  AUTOFETCH_CONCURRENCY,
  CLOSE_REASON_INELIGIBLE,
  CLOSE_REASON_NO_SESSION,
  type ChatSnapshot,
  type SocketLike,
} from '../../src/components/chat/chat-socket'
import type { WireEntry } from '../../src/components/chat/wire'

/* ── the fake socket + a manual clock ────────────────────────────────────── */

class FakeSocket implements SocketLike {
  static open: FakeSocket[] = []
  readonly sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.open.push(this)
  }

  send(data: string): void {
    if (this.closed) throw new Error('send after close')
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }

  /** The server's side of the handshake + a seed, in one call. */
  greet(entries: WireEntry[], highWater: number): void {
    this.deliver('{"type":"auth_ok"}')
    this.deliver(
      JSON.stringify({ type: 'seed', entries, has_more: false, next_before: null }),
    )
    this.deliver(
      JSON.stringify({
        type: 'seed_done',
        state: 'live',
        resync_epoch: 0,
        high_water: highWater,
      }),
    )
  }

  deliver(text: string): void {
    this.onmessage?.({ data: text })
  }

  drop(code: number, reason?: string): void {
    this.onclose?.({ code, reason })
  }
}

class Clock {
  private seq = 1
  readonly timers = new Map<number, () => void>()

  schedule = (fn: () => void): number => {
    const id = this.seq++
    this.timers.set(id, fn)
    return id
  }

  cancel = (id: number): void => {
    this.timers.delete(id)
  }

  /** Fire every pending timer except the auth grace one (which is only ever
   *  the FIRST timer of a connection and would close a healthy socket). */
  runAll(): void {
    const due = [...this.timers.entries()]
    this.timers.clear()
    for (const [, fn] of due) fn()
  }

  get pending(): number {
    return this.timers.size
  }
}

function entry(over: Partial<WireEntry> & { seq: number; uuid: string }): WireEntry {
  return {
    kind: 'assistant',
    ts_ms: 1_000,
    offset: 0,
    oversize: false,
    truncated: false,
    body: { text: 'x' },
    ...over,
  }
}

interface Harness {
  socket: ChatSocket
  clock: Clock
  snaps: ChatSnapshot[]
  last: () => ChatSnapshot
  ws: () => FakeSocket
  fetches: string[]
}

function harness(
  fetchFull: (name: string, uuid: string) => Promise<unknown> = () =>
    Promise.reject(new Error('no fetch expected')),
): Harness {
  FakeSocket.open = []
  const clock = new Clock()
  const snaps: ChatSnapshot[] = []
  const fetches: string[] = []
  const socket = new ChatSocket({
    name: 'release-train',
    onSnapshot: (s) => snaps.push(s),
    connect: (url) => new FakeSocket(url),
    token: () => 'tok',
    baseUrl: () => 'ws://host',
    fetchFull: (name, uuid) => {
      fetches.push(uuid)
      return fetchFull(name, uuid)
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
    rand: () => 0.5,
  })
  socket.start()
  FakeSocket.open[0].onopen?.(null)
  return {
    socket,
    clock,
    snaps,
    fetches,
    last: () => snaps[snaps.length - 1] ?? socket.snapshot(),
    ws: () => FakeSocket.open[FakeSocket.open.length - 1],
  }
}

/* ── the handshake ───────────────────────────────────────────────────────── */

describe('the handshake', () => {
  test('the token rides the FIRST frame, never the URL', () => {
    const h = harness()
    expect(h.ws().url).toBe('ws://host/ws/sessions/release-train/chat')
    expect(h.ws().url).not.toContain('tok')
    expect(h.ws().sent).toEqual(['{"type":"auth","token":"tok"}'])
    h.socket.dispose()
  })

  test('the client sends NOTHING else — A2 is a read-only data plane', () => {
    const h = harness()
    h.ws().greet([entry({ seq: 1, uuid: 'a' })], 2)
    h.ws().deliver('{"type":"entry","entry":' + JSON.stringify(entry({ seq: 2, uuid: 'b' })) + '}')
    expect(h.ws().sent).toHaveLength(1)
    h.socket.dispose()
  })

  test('a seed makes the surface live; the entries are the page', () => {
    const h = harness()
    h.ws().greet([entry({ seq: 1, uuid: 'a' }), entry({ seq: 2, uuid: 'b' })], 3)
    expect(h.last().state).toBe('live')
    expect(h.last().seeded).toBe(true)
    expect(h.last().entries.map((e) => e.uuid)).toEqual(['a', 'b'])
    h.socket.dispose()
  })
})

/* ── the reconnect ───────────────────────────────────────────────────────── */

describe('a dropped socket', () => {
  test('backs off, redials, and RE-SEEDS rather than appending', () => {
    const h = harness()
    h.ws().greet([entry({ seq: 1, uuid: 'a' })], 2)
    h.ws().drop(1006)
    expect(h.last().state).toBe('reconnecting')
    // The transcript stays on screen while we redial — a network blip is not
    // a reason to blank a conversation.
    expect(h.last().entries.map((e) => e.uuid)).toEqual(['a'])
    expect(h.clock.pending).toBe(1)

    h.clock.runAll()
    expect(FakeSocket.open).toHaveLength(2)
    const fresh = h.ws()
    fresh.onopen?.(null)
    // A live frame carrying the OLD ring's seq must not be spliced on: until
    // the new `seed_done` lands there is no boundary to judge it by.
    fresh.deliver('{"type":"auth_ok"}')
    fresh.deliver('{"type":"entry","entry":' + JSON.stringify(entry({ seq: 9, uuid: 'ghost' })) + '}')
    expect(h.last().entries.map((e) => e.uuid)).toEqual(['a'])

    fresh.greet([entry({ seq: 7, uuid: 'x' })], 8)
    expect(h.last().entries.map((e) => e.uuid)).toEqual(['x'])
    expect(h.last().state).toBe('live')
    h.socket.dispose()
  })

  test('4404 is terminal — there is no chat plane to redial', () => {
    const h = harness()
    h.ws().drop(4404)
    expect(h.last().state).toBe('offline')
    expect(h.clock.pending).toBe(0)
    expect(FakeSocket.open).toHaveLength(1)
    h.socket.dispose()
  })

  test('a 4404 carries WHICH terminal fact it is, and a redial forgets it', () => {
    // The bug: this switch read `ev.code` and threw `ev.reason` away, so a
    // DELETED session and a chat-INELIGIBLE one rendered the same generic
    // "Offline" over "Couldn't load this conversation." — while the app-wide
    // aggregate, which reads an offline link as still-reconnecting through a
    // 30 s grace, painted "Reconnecting…" with a spinner over a dialler that
    // had already stopped. Five claims about one screen.
    const gone = harness()
    gone.ws().drop(4404, CLOSE_REASON_NO_SESSION)
    expect(gone.last().state).toBe('offline')
    expect(gone.last().gone).toBe('no-session')

    // A new dial is a new question. (Read the socket's own snapshot: `open()`
    // does not emit until the new connection says something.)
    gone.socket.redial()
    expect(gone.socket.snapshot().gone).toBeNull()
    gone.socket.dispose()

    const ineligible = harness()
    ineligible.ws().drop(4404, CLOSE_REASON_INELIGIBLE)
    expect(ineligible.last().gone).toBe('chat-unavailable')
    ineligible.socket.dispose()

    // A reason we do not recognise degrades to the generic offline, never to a
    // guess — and a NON-4404 terminal close is not a "gone" session at all.
    const unknown = harness()
    unknown.ws().drop(4404, 'something new the server started saying')
    expect(unknown.last().gone).toBeNull()
    expect(unknown.last().state).toBe('offline')
    unknown.socket.dispose()

    const revoked = harness()
    revoked.ws().drop(4001, CLOSE_REASON_NO_SESSION)
    expect(revoked.last().gone).toBeNull()
    revoked.socket.dispose()
  })

  test('1013 (subscriber cap / a transient tailer stop) retries', () => {
    const h = harness()
    h.ws().drop(1013)
    expect(h.last().state).toBe('reconnecting')
    h.clock.runAll()
    expect(FakeSocket.open).toHaveLength(2)
    h.socket.dispose()
  })

  test('an auth reject is permanent, not a retry loop', () => {
    const h = harness()
    h.ws().drop(1008)
    expect(h.last().state).toBe('offline')
    expect(h.clock.pending).toBe(0)
    h.socket.dispose()
  })

  test('the redial gives up rather than storming forever', () => {
    const h = harness()
    for (let i = 0; i < 20; i++) {
      const ws = h.ws()
      ws.onopen?.(null)
      ws.drop(1006)
      h.clock.runAll()
    }
    expect(h.last().state).toBe('offline')
    expect(h.clock.pending).toBe(0)
    h.socket.dispose()
  })

  test('the backoff climbs and is jittered', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(300)
    expect(backoffDelay(3, () => 0.5)).toBe(2_400)
    expect(backoffDelay(99, () => 0.5)).toBe(30_000)
    expect(backoffDelay(0, () => 0)).toBeLessThan(backoffDelay(0, () => 1))
  })
})

/* ── teardown ────────────────────────────────────────────────────────────── */

describe('teardown', () => {
  test('rapid mount/unmount leaves no socket and no timer behind', () => {
    FakeSocket.open = []
    const clock = new Clock()
    let emitted = 0
    for (let i = 0; i < 25; i++) {
      const s = new ChatSocket({
        name: 'release-train',
        onSnapshot: () => emitted++,
        connect: (url) => new FakeSocket(url),
        token: () => 'tok',
        baseUrl: () => 'ws://host',
        fetchFull: () => Promise.reject(new Error('never')),
        schedule: clock.schedule,
        cancel: clock.cancel,
      })
      s.start()
      const ws = FakeSocket.open[FakeSocket.open.length - 1]
      ws.onopen?.(null)
      // Half of them get as far as a seed before the panel unmounts.
      if (i % 2 === 0) ws.greet([entry({ seq: 1, uuid: 'a' })], 2)
      s.dispose()
      // The socket dies AFTER our teardown — the ordering React's cleanup and
      // a real network drop actually race in.
      ws.drop(1006)
    }
    expect(FakeSocket.open).toHaveLength(25)
    expect(FakeSocket.open.every((w) => w.closed?.code === 1000)).toBe(true)
    // No reconnect was scheduled by any of those late closes, and every auth
    // grace timer was cancelled.
    expect(clock.pending).toBe(0)
    // …and nothing emitted after disposal (a `setState` on an unmounted tree).
    const before = emitted
    for (const w of FakeSocket.open) w.deliver('{"type":"auth_ok"}')
    expect(emitted).toBe(before)
  })

  test('a disposed socket never dials again', () => {
    const h = harness()
    h.socket.dispose()
    h.socket.start()
    expect(FakeSocket.open).toHaveLength(1)
  })
})

/* ── fetch-full ──────────────────────────────────────────────────────────── */

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('the truncated auto-fetch', () => {
  test('a clipped entry is fetched once and swapped in place', async () => {
    const h = harness(() => Promise.resolve({ text: 'the whole thing' }))
    h.ws().greet([entry({ seq: 1, uuid: 'big', truncated: true })], 2)
    expect(h.fetches).toEqual(['big'])
    await tick()
    expect(h.last().entries[0].truncated).toBe(false)
    expect(h.last().entries[0].body).toEqual({ text: 'the whole thing' })

    // A later frame must not re-fetch what is already resolved…
    h.ws().deliver(
      '{"type":"entry","entry":' + JSON.stringify(entry({ seq: 2, uuid: 'b' })) + '}',
    )
    await tick()
    expect(h.fetches).toEqual(['big'])
    h.socket.dispose()
  })

  test('a failed fetch keeps the clip marker and is not retried', async () => {
    const h = harness(() => Promise.reject(new Error('404')))
    h.ws().greet([entry({ seq: 1, uuid: 'gone', truncated: true })], 2)
    await tick()
    expect(h.last().entries[0].truncated).toBe(true)
    // Three more frames, no second attempt: a retry loop against a 404 is not
    // more honest than the "… clipped" marker.
    for (let i = 2; i < 5; i++) {
      h.ws().deliver(
        '{"type":"entry","entry":' + JSON.stringify(entry({ seq: i, uuid: `u${i}` })) + '}',
      )
    }
    await tick()
    expect(h.fetches).toEqual(['gone'])
    h.socket.dispose()
  })

  test('concurrency is capped — a seed of clipped entries is not a stampede', async () => {
    const gates = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()]
    let i = 0
    const h = harness(() => gates[Math.min(i++, gates.length - 1)].promise)
    h.ws().greet(
      [
        entry({ seq: 1, uuid: 'c1', truncated: true }),
        entry({ seq: 2, uuid: 'c2', truncated: true }),
        entry({ seq: 3, uuid: 'c3', truncated: true }),
      ],
      4,
    )
    expect(h.fetches).toHaveLength(AUTOFETCH_CONCURRENCY)
    gates[0].resolve({ text: 'one' })
    await tick()
    // The slot freed by the first fetch is taken by the next one down —
    // newest-first, because the newest is what the reader is looking at.
    expect(h.fetches).toEqual(['c3', 'c2', 'c1'])
    h.socket.dispose()
  })

  test('a fetch that lands after unmount touches nothing', async () => {
    const gate = deferred<unknown>()
    const h = harness(() => gate.promise)
    h.ws().greet([entry({ seq: 1, uuid: 'big', truncated: true })], 2)
    const before = h.snaps.length
    h.socket.dispose()
    gate.resolve({ text: 'late' })
    await tick()
    expect(h.snaps).toHaveLength(before)
  })
})

/**
 * A CONVERSATION THAT DOES NOT EXIST YET (verified finding 7).
 *
 * The server's answer to a pointer whose FILE is missing is
 * `Reconnecting{reason: NO_TRANSCRIPT_REASON}` — permanent, because that branch
 * has no escalation ceiling. Collapsing it onto the one word `reconnecting` is
 * what put a header pill and a global toast on the first screen of every new
 * chat session, beside the body's own "No conversation yet."
 *
 * So the socket carries the REASON through, and `connection.ts::isFreshConversation`
 * (unit-tested there) is what the surface and the app-wide link aggregate both
 * read. Without the field neither could tell the two `reconnecting`s apart.
 */
describe('the reason behind “reconnecting”', () => {
  const seedDone = (state: string, reason?: string) =>
    JSON.stringify({ type: 'seed_done', state, reason, resync_epoch: 0, high_water: 1 })

  test('a missing transcript is carried through as `noTranscript`, not swallowed', () => {
    const h = harness()
    h.ws().deliver('{"type":"auth_ok"}')
    h.ws().deliver('{"type":"seed","entries":[],"has_more":false,"next_before":null}')
    h.ws().deliver(seedDone('reconnecting', 'no transcript for the tracked conversation'))
    expect(h.last().seeded).toBe(true)
    expect(h.last().entries).toHaveLength(0)
    expect(h.last().noTranscript).toBe(true)
    // The one word is unchanged — this is a SECOND channel, not a fifth word.
    expect(h.last().state).toBe('reconnecting')
    h.socket.dispose()
  })

  test('an ordinary reconnect carries no such claim', () => {
    const h = harness()
    h.ws().deliver('{"type":"auth_ok"}')
    h.ws().deliver('{"type":"seed","entries":[],"has_more":false,"next_before":null}')
    h.ws().deliver(seedDone('reconnecting', 'no hook since start'))
    expect(h.last().noTranscript).toBe(false)
    h.socket.dispose()
  })

  test('…and neither does a healthy one', () => {
    const h = harness()
    h.ws().greet([entry({ seq: 1, uuid: 'a' })], 2)
    expect(h.last().noTranscript).toBe(false)
    h.socket.dispose()
  })
})

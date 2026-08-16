/**
 * The chat data plane's honesty layer (fase A6 T2).
 * ─────────────────────────────────────────────────────────────────────────────
 * Three mechanisms, each of which fails silently if it is wrong, and one of
 * which (the ceiling) fails WORSE if it is too aggressive than if it is absent:
 *
 *   · the vocabulary — five socket states collapse onto four words, and
 *     `reconnecting` / `no_hooks` must stop rendering as `live`
 *   · the ceiling — a `live` socket that has been silent too long is `stale`,
 *     and A0's measured latencies are the fixtures, so a NORMAL long prose
 *     turn (p50 31.4 s, max 32.8 s) may never trip it
 *   · the redial — a foreground return dials NOW with a fresh attempt budget,
 *     because the 8 attempts were burned while nobody was looking
 */
import { describe, expect, test } from 'bun:test'

import {
  A0_LATENCIES,
  STALENESS_CEILING_MS,
  chatPresentation,
  isPlaneDown,
  linkStateFor,
} from '../../src/components/chat/connection'
import { ChatSocket, type ChatSnapshot, type SocketLike } from '../../src/components/chat/chat-socket'
import { watchdogState, type PendingSend } from '../../src/components/chat/pending'
import type { WireEntry } from '../../src/components/chat/wire'

/* ── the vocabulary ──────────────────────────────────────────────────────── */

describe('the four words', () => {
  const at = (state: Parameters<typeof chatPresentation>[0]['state']) =>
    chatPresentation({ state, lastSignalAtMs: 1_000, nowMs: 1_100 })

  test('reconnecting and no_hooks are NOT live — the A6 bug in one assertion', () => {
    // Before A6 `use-chat-ws.ts` collapsed both of these into "not an error,
    // not loading", which rendered pixel-identically to a healthy session.
    expect(at('reconnecting')).toBe('reconnecting')
    expect(at('no_hooks')).toBe('stale')
    expect(at('live')).toBe('live')
    expect(at('offline')).toBe('offline')
    expect(at('connecting')).toBe('reconnecting')
  })

  test('only `live` lets a surface claim the transcript is current', () => {
    expect(isPlaneDown('live')).toBe(false)
    // `stale` is a SOCKET that is up and a CONVERSATION that is quiet. The
    // watchdog must not treat it as a dead plane, or a long prose turn would
    // suppress every delivery escalation.
    expect(isPlaneDown('stale')).toBe(false)
    expect(isPlaneDown('reconnecting')).toBe(true)
    expect(isPlaneDown('offline')).toBe(true)
  })

  test('the global banner sees a dead chat socket, and NOT a quiet one', () => {
    expect(linkStateFor('live')).toBe('connected')
    expect(linkStateFor('stale')).toBe('connected')
    expect(linkStateFor('reconnecting')).toBe('reconnecting')
    expect(linkStateFor('offline')).toBe('offline')
  })
})

/* ── the ceiling, against A0's measured latencies ────────────────────────── */

describe('the staleness ceiling', () => {
  const live = (silentForMs: number) =>
    chatPresentation({ state: 'live', lastSignalAtMs: 0, nowMs: silentForMs })

  test('A NORMAL LONG PROSE TURN DOES NOT TRIP IT — the fixture that matters', () => {
    // A0 measured a text-only transcript entry at p50 31.4 s and max 32.8 s.
    // A ceiling that fires inside that window teaches the user that the
    // honesty mechanism lies, which is strictly worse than having no ceiling.
    expect(live(A0_LATENCIES.transcriptP50Ms)).toBe('live')
    expect(live(A0_LATENCIES.transcriptMaxMs)).toBe('live')
    // With real headroom above the worst case A0 ever saw.
    expect(STALENESS_CEILING_MS).toBeGreaterThan(A0_LATENCIES.transcriptMaxMs * 2)
  })

  test('the fast plane is nowhere near it', () => {
    expect(live(A0_LATENCIES.hookMaxMs)).toBe('live')
  })

  test('past the ceiling a `live` socket stops being presented as live', () => {
    expect(live(STALENESS_CEILING_MS)).toBe('live')
    expect(live(STALENESS_CEILING_MS + 1)).toBe('stale')
  })

  test('a socket with no signal yet is connecting, not stale', () => {
    // `null` means nothing has ever arrived on this socket. Measuring an age
    // from a timestamp that does not exist is how a fresh dial would read as
    // an hour-old one.
    expect(
      chatPresentation({ state: 'live', lastSignalAtMs: null, nowMs: 10 ** 9 }),
    ).toBe('live')
  })
})

/* ── the socket: the clock, the redial, the user-triggered retry ─────────── */

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
    this.sent.push(data)
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
  deliver(text: string): void {
    this.onmessage?.({ data: text })
  }
  greet(entries: WireEntry[]): void {
    this.deliver('{"type":"auth_ok"}')
    this.deliver(JSON.stringify({ type: 'seed', entries, has_more: false, next_before: null }))
    this.deliver(
      JSON.stringify({ type: 'seed_done', state: 'live', resync_epoch: 0, high_water: 99 }),
    )
  }
  drop(code: number): void {
    this.onclose?.({ code })
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

function harness(fetchFull?: (name: string, uuid: string) => Promise<unknown>) {
  FakeSocket.open = []
  const snaps: ChatSnapshot[] = []
  const timers = new Map<number, () => void>()
  let seq = 1
  let now = 0
  const fetches: string[] = []
  const socket = new ChatSocket({
    name: 's',
    onSnapshot: (s) => snaps.push(s),
    connect: (url) => new FakeSocket(url),
    token: () => 't',
    baseUrl: () => 'ws://h',
    fetchFull: (n, u) => {
      fetches.push(u)
      return (fetchFull ?? (() => Promise.reject(new Error('boom'))))(n, u)
    },
    schedule: (fn) => {
      const id = seq++
      timers.set(id, fn)
      return id
    },
    cancel: (id) => void timers.delete(id),
    rand: () => 0.5,
    now: () => now,
  })
  socket.start()
  FakeSocket.open[0].onopen?.(null)
  return {
    socket,
    fetches,
    snaps,
    setNow: (v: number) => {
      now = v
    },
    runAll: () => {
      const due = [...timers.values()]
      timers.clear()
      for (const fn of due) fn()
    },
    last: () => snaps[snaps.length - 1] ?? socket.snapshot(),
    ws: () => FakeSocket.open[FakeSocket.open.length - 1],
    sockets: () => FakeSocket.open.length,
  }
}

describe('the staleness clock in the socket', () => {
  test('a frame stamps the clock; the handshake alone does not', () => {
    const h = harness()
    h.setNow(5_000)
    h.ws().deliver('{"type":"auth_ok"}')
    // `auth_ok` proves a socket exists, not that the tailer is reading — so it
    // must not tick the clock, or a socket open against a dead tailer would
    // look eternally fresh.
    expect(h.socket.snapshot().lastSignalAt).toBeNull()
    h.setNow(7_000)
    h.ws().deliver(
      JSON.stringify({ type: 'seed', entries: [entry({ seq: 1, uuid: 'a' })], has_more: false, next_before: null }),
    )
    expect(h.socket.snapshot().lastSignalAt).toBe(7_000)
    h.socket.dispose()
  })
})

describe('the foreground redial', () => {
  test('it dials NOW and hands back the attempt budget the background burned', () => {
    const h = harness()
    h.ws().greet([entry({ seq: 1, uuid: 'a' })])
    // Burn the whole ceiling: 8 attempts, then the terminal `offline`.
    for (let i = 0; i < 9; i++) {
      h.ws().drop(1006)
      h.runAll()
    }
    expect(h.last().state).toBe('offline')
    const before = h.sockets()
    // The human comes back. That is new information, so the budget spent while
    // nobody was looking is not held against it.
    h.socket.redial()
    expect(h.sockets()).toBe(before + 1)
    h.ws().onopen?.(null)
    h.ws().greet([entry({ seq: 1, uuid: 'a' })])
    expect(h.last().state).toBe('live')
    h.socket.dispose()
  })

  test('a disposed socket does not redial — the teardown stays total', () => {
    const h = harness()
    h.socket.dispose()
    const before = h.sockets()
    h.socket.redial()
    expect(h.sockets()).toBe(before)
  })
})

describe('a clipped entry is recoverable in chat', () => {
  test('a failed fetch is remembered, then retried when the USER asks', async () => {
    let attempt = 0
    const h = harness(() => {
      attempt++
      return attempt === 1 ? Promise.reject(new Error('404')) : Promise.resolve({ text: 'full' })
    })
    h.ws().greet([entry({ seq: 1, uuid: 'a', truncated: true })])
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // The automatic policy is unchanged: one try, no retry loop against a 404.
    expect(h.fetches).toEqual(['a'])
    expect([...h.socket.snapshot().fetchFailed]).toEqual(['a'])

    h.socket.retryFull('a')
    expect(h.socket.snapshot().fetching.has('a')).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.fetches).toEqual(['a', 'a'])
    expect(h.socket.snapshot().fetchFailed.has('a')).toBe(false)
    expect(h.socket.snapshot().fetching.has('a')).toBe(false)
    h.socket.dispose()
  })
})

/* ── the watchdog stops manufacturing false negatives ────────────────────── */

describe('the delivery watchdog under a dead socket', () => {
  const send = (over: Partial<PendingSend> = {}): PendingSend => ({
    id: 'p1',
    text: 'hi',
    atMs: 0,
    state: 'unconfirmed',
    seen: 0,
    receiptAtS: 0,
    ...over,
  })

  test('a live plane still escalates — the mechanism is not disabled', () => {
    expect(
      watchdogState(send(), { nowMs: 60_000, sawActiveSince: () => false }),
    ).toBe('undelivered')
  })

  test('a DEAD plane does not, because the silence is its own', () => {
    // The watchdog measures echo arrival in the transcript, and the transcript
    // rides the very socket that is down. `POST /send` is an independent REST
    // path that succeeds perfectly well meanwhile — so "no echo" here is
    // evidence about the socket and about nothing else.
    expect(
      watchdogState(send(), { nowMs: 60_000, sawActiveSince: () => false, planeDown: true }),
    ).toBe('unconfirmed')
  })

  test('an escalation already said out loud stays said', () => {
    // `undelivered` is terminal by design — a failure that heals itself on the
    // next tick teaches the user to ignore the next one.
    expect(
      watchdogState(send({ state: 'undelivered' }), {
        nowMs: 60_000,
        sawActiveSince: () => false,
        planeDown: true,
      }),
    ).toBe('undelivered')
  })
})

/**
 * The chat socket: one live conversation, dialled and kept dialled (fase A2→A3).
 * ─────────────────────────────────────────────────────────────────────────────
 * Framework-free ON PURPOSE. React's job here is to mount and unmount this
 * thing (`use-chat-ws.ts`); everything that can go wrong with a socket — the
 * first-frame auth, the backoff, which close codes are terminal, the re-seed
 * after a drop, the fetch-full queue, and above all the teardown — is behaviour
 * that has to be tested, and a hook is not testable in a `bun test` with no
 * DOM. `tests/unit/chat-socket.test.ts` drives this class through a fake
 * socket, including the rapid mount/unmount thrash that must leave nothing
 * open.
 *
 * The handshake is the terminal socket's, byte for byte (`use-live-term.ts`,
 * `ws.rs::verify_auth_frame`): connect token-less, send `{type:'auth',token}`
 * as the FIRST frame, wait for `{"type":"auth_ok"}`. The token is never in the
 * URL — a browser `WebSocket` cannot set an `Authorization` header, and a
 * query-string token ends up in logs.
 *
 * WHAT THIS OWNS THAT THE SERVER DOES NOT: the re-seed after a network drop.
 * The server re-seeds every attach, so a reconnect is a fresh seed by
 * construction — the client's part is to stop trusting the OLD `high_water`
 * the moment the socket dies, which is why `highWater` is cleared on connect
 * and live frames are ignored until `seed_done` lands again.
 */

import { authToken, wsUrl } from '../../env'
import { sessionRequest } from '../../lib/api/sessions'

import {
  applyFrame,
  applyFullBody,
  authFrame,
  EMPTY_WIRE,
  parseFrame,
  type WireEntry,
  type WireState,
} from './wire'
import { truncatedUuids } from './wire-entries'

/** The slice of `WebSocket` this module uses — so a test can be a socket. */
export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code: number; reason?: string }) => void) | null
}

/** What the surface is told about the data plane. */
export type ChatConnState =
  /** No seed yet — the transcript below is empty or from a previous socket. */
  | 'connecting'
  /** Seeded, and the tailer says it is reading the right file. */
  | 'live'
  /** The socket or the tailer is between states. What is on screen STAYS on
   *  screen — it is just not a claim about now. */
  | 'reconnecting'
  /** The conversation pointer cannot self-heal (no hooks installed). Shown,
   *  but never presented as current. */
  | 'no_hooks'
  /** Terminal: this session has no chat data plane, or the socket gave up. */
  | 'offline'

/**
 * WHY a 4404 closed this socket — the server's own `reason`, kept apart from
 * the one word `state` collapses it to (the same shape `noTranscript` uses).
 *
 * The server closes with `CLOSE_NOT_RUNNING` for two facts that could not be
 * more different (`server/src/sessions/chat/ws.rs`), and this client switched on
 * `ev.code` alone and threw `ev.reason` away. Both collapsed onto `offline`, and
 * a DELETED session then rendered five claims at once: an app-level
 * "Reconnecting…" with a spinner (a promise that can never be kept — the close
 * is terminal and there is no redial), a focus header with a GREEN dot and
 * "Idle", the roster tile still listed, a chat chip reading "Offline", and
 * "Couldn't load this conversation." over an enabled composer.
 *
 * `chat-unavailable` is not an outage at all: a codex/remote/team-lead session
 * simply has no chat plane, and dressing it in offline styling with a retry
 * invites a user to keep tapping at something that will never change.
 */
export type ChatGone = 'no-session' | 'chat-unavailable'

/** The 4404 close reasons, verbatim from `server/src/sessions/chat/ws.rs`.
 *  Pinned on both sides: the server has the twin assertion, so the day either
 *  string moves one of the two suites fails. */
export const CLOSE_REASON_NO_SESSION = 'no such session'
export const CLOSE_REASON_INELIGIBLE = 'chat unavailable for this session'

/** `ev.reason` → the fact, or `null` when the server said nothing we know.
 *  An unrecognised reason degrades to the old generic `offline`, never to a
 *  guess. */
export function goneFor(reason: string | undefined): ChatGone | null {
  const r = (reason ?? '').trim()
  if (r === CLOSE_REASON_NO_SESSION) return 'no-session'
  if (r === CLOSE_REASON_INELIGIBLE) return 'chat-unavailable'
  return null
}

export interface ChatSnapshot {
  entries: readonly WireEntry[]
  state: ChatConnState
  /** A complete seed page is on screen (`seed_done` landed at least once). */
  seeded: boolean
  /** Bumped by every server-ordered re-seed — a different conversation. */
  resyncCount: number
  /** The seed's own answer to "is there anything below this window" — what the
   *  scroll-back affordance is allowed to offer (`use-chat-backlog.ts`). */
  hasMore: boolean
  /** The server's cursor for the page below the seed, `<conversation>:<offset>`.
   *  The backlog recomputes its own cursor from what is on screen, but this is
   *  where the CONVERSATION id comes from: the server stamped it, so the client
   *  never guesses at the id its 409 is keyed on. */
  nextBefore: string | null
  /** Epoch ms of the last AUTHORITATIVE signal — a frame the server sent
   *  because something happened, not because the socket exists. `null` until
   *  the first one lands. The staleness ceiling (`connection.ts`) measures
   *  from here; before A6 no timestamp was tracked anywhere in this layer, so
   *  a socket that had been silent for an hour still read as `live`. */
  lastSignalAt: number | null
  /** Uuids whose fetch-full is in flight right now — the loading state a
   *  clipped entry's "Show full message" affordance renders (A6 T4.2). */
  fetching: ReadonlySet<string>
  /** Uuids whose fetch-full came back an error. The entry keeps its condensed
   *  text (that is the honest outcome), and the surface offers a RETRY rather
   *  than a dead end. */
  fetchFailed: ReadonlySet<string>
  /**
   * THIS SESSION HAS NEVER HAD A TRANSCRIPT — the server's own `reason`, kept
   * apart from the one word `state` collapses it to.
   *
   * `classify_pointer` (`tailer.rs`) returns `Reconnecting` with this reason
   * whenever the pointer FILE does not exist, and unlike the `no_hooks` branch
   * it has no escalation ceiling — so a session that has simply never been
   * spoken to sat in a permanent `Reconnecting…` alarm, next to the body's own
   * "No conversation yet.", from the first screen onward. Two different claims
   * about one calm fact.
   *
   * `reconnecting` promises a reconnection. There is nothing to reconnect TO
   * yet, so the surface reads this WITH `entries.length` and says nothing at
   * all (`chat-panel.tsx`). Had-and-lost — the same reason with entries on
   * screen — keeps the chip: there the transcript really is being presented as
   * current and really is not.
   */
  noTranscript: boolean
  /** WHY a terminal 4404 closed this socket, when the server said something we
   *  recognise. `null` on every other state, and on a 4404 whose reason we do
   *  not know — there the generic `offline` is still the honest reading. */
  gone: ChatGone | null
}

/** The `reason` `classify_pointer` stamps on a pointer whose file does not
 *  exist (`server/src/sessions/chat/tailer.rs::NO_TRANSCRIPT_REASON`). Pinned
 *  on both sides — `server/src/sessions/chat/tailer.rs` has the twin
 *  assertion, so the day the string moves one of the two suites fails. */
export const NO_TRANSCRIPT_REASON = 'no transcript for the tracked conversation'

const NO_UUIDS: ReadonlySet<string> = new Set()

export const EMPTY_SNAPSHOT: ChatSnapshot = {
  entries: [],
  state: 'connecting',
  seeded: false,
  resyncCount: 0,
  hasMore: false,
  nextBefore: null,
  lastSignalAt: null,
  fetching: NO_UUIDS,
  fetchFailed: NO_UUIDS,
  noTranscript: false,
  gone: null,
}

// ── close codes (the terminal socket's table, `use-live-term.ts`) ────────────

const CLOSE_UNMOUNT = 1000 // our own teardown
const CLOSE_AUTH = 1008 // auth / origin reject — permanent
const CLOSE_AGAIN = 1013 // subscriber cap, or a transient tailer stop — retry
const CLOSE_REVOKED = 4001 // token revoked — permanent
const CLOSE_NOT_RUNNING = 4404 // no such session / not chat-eligible — terminal

const BASE_BACKOFF_MS = 300
const MAX_BACKOFF_MS = 30_000
const MAX_ATTEMPTS = 8
/** `auth_ok` has to arrive inside this or the connection is a failed one. */
const AUTH_GRACE_MS = 10_000

/** Exponential backoff with ±20% jitter, from the FIRST retry — the same
 *  anti-storm rule the terminal socket uses when the server restarts. */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  return Math.round(delay * (0.8 + rand() * 0.4))
}

// ── fetch-full ──────────────────────────────────────────────────────────────

/** How many of the NEWEST rendered entries are eligible for auto-fetch, and
 *  how many fetches may be in flight at once. Both are about the server's
 *  cost: `find_full_entry` streams the transcript until the uuid matches. */
export const AUTOFETCH_WINDOW = 12
export const AUTOFETCH_CONCURRENCY = 2

/** `GET /api/sessions/{name}/chat/entry/{uuid}` — `sessionRequest` unwraps the
 *  `{ok,data}` envelope and throws a `SessionError` on 404/409. */
async function defaultFetchFull(name: string, uuid: string): Promise<unknown> {
  const full = await sessionRequest<{ body?: unknown }>(
    `/api/sessions/${encodeURIComponent(name)}/chat/entry/${encodeURIComponent(uuid)}`,
  )
  return full?.body
}

export interface ChatSocketOptions {
  /** Session slug. */
  name: string
  /** Called on every state change, with an immutable snapshot. */
  onSnapshot: (s: ChatSnapshot) => void
  // ── seams (defaults are the real thing; tests replace them) ───────────────
  connect?: (url: string) => SocketLike
  token?: () => string
  baseUrl?: () => string
  fetchFull?: (name: string, uuid: string) => Promise<unknown>
  schedule?: (fn: () => void, ms: number) => number
  cancel?: (id: number) => void
  rand?: () => number
  /** Injectable clock — the staleness ceiling is arithmetic on this, and a
   *  test that cannot move time cannot test a ceiling. */
  now?: () => number
}

/**
 * One session's chat data plane. `start()` dials; `dispose()` is final — a
 * disposed socket never reconnects, never emits and never leaves a WebSocket
 * or a timer behind. Everything the class does after `dispose()` is a no-op,
 * which is what makes React's mount→unmount→mount (StrictMode, a fast tab
 * switch, a re-keyed panel) safe.
 */
export class ChatSocket {
  private readonly opts: Required<ChatSocketOptions>
  private wire: WireState = EMPTY_WIRE
  private conn: ChatConnState = 'connecting'
  /** Set once, by a terminal 4404 carrying a reason we recognise. */
  private gone: ChatGone | null = null
  private ws: SocketLike | null = null
  private authed = false
  private attempt = 0
  private retryTimer: number | null = null
  private authTimer: number | null = null
  private disposed = false
  /** Every uuid fetch-full was ever ASKED for on this socket — success or
   *  failure. A failure is not retried: the entry keeps its "… clipped"
   *  marker, which is honest, where a retry loop against a 404 is not. */
  private readonly attempted = new Set<string>()
  private inflight = 0
  /** In-flight and failed fetch-full uuids — the two states a clipped entry's
   *  affordance renders (A6 T4.2). */
  private readonly fetching = new Set<string>()
  private readonly failed = new Set<string>()
  private lastSignalAt: number | null = null

  constructor(options: ChatSocketOptions) {
    this.opts = {
      connect: (url) => new WebSocket(url) as unknown as SocketLike,
      token: authToken,
      baseUrl: wsUrl,
      fetchFull: defaultFetchFull,
      schedule: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      cancel: (id) => clearTimeout(id),
      rand: Math.random,
      now: () => Date.now(),
      ...options,
    }
  }

  snapshot(): ChatSnapshot {
    return {
      entries: this.wire.entries,
      state: this.conn,
      seeded: this.wire.seeded,
      resyncCount: this.wire.resyncCount,
      hasMore: this.wire.hasMore,
      nextBefore: this.wire.nextBefore,
      lastSignalAt: this.lastSignalAt,
      fetching: this.fetching.size ? new Set(this.fetching) : NO_UUIDS,
      fetchFailed: this.failed.size ? new Set(this.failed) : NO_UUIDS,
      noTranscript: this.wire.status?.reason === NO_TRANSCRIPT_REASON,
      gone: this.gone,
    }
  }

  start(): void {
    if (this.disposed) return
    this.open()
  }

  /**
   * Dial NOW, with a fresh attempt budget (A6 T2.3).
   *
   * The foreground path, not the failure path. A phone that slept past the
   * 8-attempt ceiling lands in `offline` and — because `use-chat-ws.ts` only
   * disposes when the LAST subscriber leaves — a backgrounded-but-mounted
   * panel would sit there permanently. Resetting `attempt` is the whole point:
   * a human coming back to the tab is new information, so the budget that was
   * burned while nobody was looking is not held against it.
   *
   * Debouncing is the caller's job (`use-chat-ws.ts`), because the thing worth
   * debouncing is the GESTURE, not the dial.
   */
  redial(): void {
    if (this.disposed) return
    this.attempt = 0
    const ws = this.ws
    this.ws = null
    if (ws) {
      // Retire the zombie with its handlers dropped first, or its eventual
      // close schedules a reconnect competing with the one we are about to
      // make. Same order as `use-live-term.ts`'s stale-resume.
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close(CLOSE_UNMOUNT, 'stale-resume')
      } catch {
        /* already closing */
      }
    }
    this.open()
  }

  /**
   * Re-run a fetch-full the user asked for again (A6 T4.2).
   *
   * The automatic policy stays exactly as it was: `AUTOFETCH_WINDOW` newest
   * entries, `AUTOFETCH_CONCURRENCY` at a time, and a failure is never retried
   * BY THE SOCKET. What changes is that "never retried" stops meaning "the
   * text is unreachable forever" — the user gets the retry, so the clipped
   * entry reads as deliberately condensed rather than broken.
   */
  retryFull(uuid: string): void {
    if (this.disposed) return
    if (this.fetching.has(uuid)) return
    this.attempted.delete(uuid)
    this.failed.delete(uuid)
    this.pump(uuid)
    this.emit()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    if (ws) {
      // Detach FIRST: a close handler that runs after disposal would schedule
      // a reconnect for a socket nobody is listening to any more.
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close(CLOSE_UNMOUNT, 'unmount')
      } catch {
        /* already closing — nothing to do */
      }
    }
  }

  // ── connection ────────────────────────────────────────────────────────────

  private url(): string {
    const base = this.opts.baseUrl().replace(/\/$/, '')
    return `${base}/ws/sessions/${encodeURIComponent(this.opts.name)}/chat`
  }

  private open(): void {
    if (this.disposed) return
    this.clearTimers()
    this.authed = false
    // A new dial is a new question: whatever the last close said about this
    // session being gone is no longer the current answer.
    this.gone = null
    // The previous connection's boundary is void the moment the socket is: a
    // live frame from the OLD ring must not be spliced onto the NEW seed. The
    // entries stay on screen (a reconnect is not a reason to blank the
    // transcript) and are replaced wholesale when the fresh seed lands.
    this.wire = { ...this.wire, seeded: false, highWater: null }

    let ws: SocketLike
    try {
      ws = this.opts.connect(this.url())
    } catch {
      this.retry()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      try {
        ws.send(authFrame(this.opts.token()))
      } catch {
        /* surfaced by onclose */
      }
      this.authTimer = this.opts.schedule(() => {
        if (this.ws === ws && !this.authed) ws.close()
      }, AUTH_GRACE_MS)
    }

    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return
      const frame = parseFrame(ev.data)
      if (!frame) return
      if (frame.type === 'auth_ok') {
        this.authed = true
        this.clearAuthTimer()
        // The backoff is NOT reset here. A socket that upgrades, acks and then
        // closes (an ineligible session, a tailer that just stopped) is not a
        // useful connection — resetting on `auth_ok` would let that cycle
        // storm the endpoint. It resets on `seed_done`, which is the first
        // frame that proves the data plane actually works.
        return
      }
      const before = this.wire
      this.wire = applyFrame(this.wire, frame)
      if (frame.type === 'seed_done') this.attempt = 0
      // The staleness clock (A6 T2.2). It ticks on frames the server sent
      // because something HAPPENED — a seed completing, an entry, a tail-state
      // transition. `auth_ok` is handled above with its own `return` and so
      // never reaches here, which is the point: a socket can be perfectly open
      // against a tailer that stopped reading, and letting the handshake tick
      // this clock would hide exactly that.
      this.lastSignalAt = this.opts.now()
      if (this.wire !== before) {
        this.conn = stateFor(this.wire)
        this.pump()
        this.emit()
      }
    }

    ws.onerror = () => {
      /* every actionable case arrives as a close */
    }

    ws.onclose = (ev) => {
      if (this.ws !== ws || this.disposed) return
      this.ws = null
      this.authed = false
      this.clearAuthTimer()
      switch (ev.code) {
        case CLOSE_NOT_RUNNING:
        case CLOSE_AUTH:
        case CLOSE_REVOKED:
          // Terminal. 4404 is the server saying this session has no chat data
          // plane at all (gone, codex, remote, a team lead) — redialing can
          // only storm it, so the surface is told and the loop stops.
          //
          // …and WHICH of those it is, because the server says so in `reason`
          // and this switch used to read only `ev.code`. "This session no longer
          // exists" and "chat isn't available for this session" are not the same
          // sentence, and only one of them is an outage.
          if (ev.code === CLOSE_NOT_RUNNING) this.gone = goneFor(ev.reason)
          this.conn = 'offline'
          this.emit()
          return
        case CLOSE_AGAIN:
        default:
          // 1013 (subscriber cap / a transient tailer stop) and every network
          // close: back off and redial. A redial starts a fresh tailer, which
          // is precisely what a transient stop needs.
          this.retry()
      }
    }
  }

  private retry(): void {
    if (this.disposed) return
    if (this.attempt >= MAX_ATTEMPTS) {
      this.conn = 'offline'
      this.emit()
      return
    }
    const attempt = this.attempt++
    this.conn = 'reconnecting'
    this.emit()
    this.retryTimer = this.opts.schedule(
      () => {
        this.retryTimer = null
        this.open()
      },
      backoffDelay(attempt, this.opts.rand),
    )
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== null) {
      this.opts.cancel(this.authTimer)
      this.authTimer = null
    }
  }

  private clearTimers(): void {
    this.clearAuthTimer()
    if (this.retryTimer !== null) {
      this.opts.cancel(this.retryTimer)
      this.retryTimer = null
    }
  }

  private emit(): void {
    if (this.disposed) return
    this.opts.onSnapshot(this.snapshot())
  }

  // ── fetch-full ────────────────────────────────────────────────────────────

  /** Start fetches for clipped entries the renderer is showing, up to the
   *  concurrency cap. Idempotent: called after every applied frame.
   *
   *  `extra` is a uuid the USER asked for (`retryFull`). It is fetched even
   *  when it has fallen out of the `AUTOFETCH_WINDOW`, because the window is a
   *  policy about what to fetch UNASKED — an explicit request is not that. It
   *  still respects the concurrency cap: the server cost of `find_full_entry`
   *  is the same whoever asked. */
  private pump(extra?: string): void {
    if (this.disposed) return
    const wanted = extra
      ? [extra, ...truncatedUuids(this.wire.entries, AUTOFETCH_WINDOW)]
      : truncatedUuids(this.wire.entries, AUTOFETCH_WINDOW)
    for (const uuid of wanted) {
      if (this.inflight >= AUTOFETCH_CONCURRENCY) return
      if (this.attempted.has(uuid)) continue
      this.attempted.add(uuid)
      this.inflight++
      this.fetching.add(uuid)
      void this.opts
        .fetchFull(this.opts.name, uuid)
        .then((body) => {
          if (this.disposed) return
          if (body === undefined) {
            // A 200 with no body is a miss, not a success: the entry stays
            // clipped, so say so rather than leaving a spinner spinning.
            this.failed.add(uuid)
            return
          }
          const next = applyFullBody(this.wire, uuid, body)
          if (next === this.wire) return
          this.wire = next
        })
        .catch(() => {
          // The entry keeps `truncated`, so the surface keeps saying "clipped"
          // — the honest outcome, and the one the marker exists for. A6 adds
          // the other half: the failure is REMEMBERED, so the surface can
          // offer a retry instead of a `title` tooltip pointing at the
          // terminal.
          this.failed.add(uuid)
        })
        .finally(() => {
          this.inflight--
          this.fetching.delete(uuid)
          if (!this.disposed) this.emit()
          this.pump()
        })
    }
  }
}

/** The tail's own state, as the surface's state. `stopped` is only ever seen
 *  in-band right before the server closes (with 1013 or 4404), so it is read
 *  as "not live" and the close code decides whether that is terminal. */
function stateFor(wire: WireState): ChatConnState {
  if (!wire.seeded) return 'connecting'
  switch (wire.status?.state) {
    case 'live':
      return 'live'
    case 'no_hooks':
      return 'no_hooks'
    default:
      return 'reconnecting'
  }
}

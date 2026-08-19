/**
 * The takeover socket: one shared-browser page, watched and driven.
 * ─────────────────────────────────────────────────────────────────────────────
 * Framework-free for the same reason `chat-socket.ts` is: the handshake, the
 * close-code table, the backoff and above all the TEARDOWN are behaviour that
 * has to be tested, and none of it is visible in a rendered snapshot. React's
 * only job (`takeover-panel.tsx`) is to mount it, paint the frames it hands
 * over, and unmount it.
 *
 * The handshake is the terminal socket's, byte for byte (`ws.rs`): connect
 * token-less, send `{type:'auth',token}` as the FIRST frame, wait for
 * `{"type":"auth_ok"}`. The token never goes in the URL — a `WebSocket` cannot
 * set an `Authorization` header and a query-string token ends up in logs.
 *
 * TWO CHANNELS, ON PURPOSE. Frames arrive at up to 60 fps and go straight to
 * `onFrame` → canvas; they never touch React state. Everything a human reads —
 * the mode pill, the target, the connection — is a `snapshot`, which changes a
 * few times a minute. Routing frames through `setState` would re-render the
 * page sixty times a second to paint a canvas that React does not own.
 *
 * THE CLOSE-CODE TABLE (`connectors/browser/takeover.rs`):
 *   · 1008 — auth/origin/bad name. Permanent; retrying cannot fix it.
 *   · 1013 + "already attached" — someone else holds this page. Retryable, but
 *     not by hammering: we back off like any other 1013.
 *   · 4404 + "no browser context" — the agent has not opened a page. TERMINAL:
 *     there is nothing to attach to, and a redial loop would spin forever.
 *   · anything else — a normal drop; back off and redial.
 */

import { authToken, wsUrl } from '@/env'

import type { FrameMetadata, TakeoverFrame } from './frame-map'

/** The slice of `WebSocket` this module uses — so a test can be a socket. */
export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code: number; reason?: string }) => void) | null
}

/** Who holds the wheel — mirrors `lock::DriveMode`'s serde spelling. */
export type DriveMode = 'agent_driving' | 'human_driving'

export type TakeoverState =
  /** Dialling, or dialled but not yet seeded. */
  | 'connecting'
  /** Authed; frames are flowing. */
  | 'live'
  /** The socket dropped; what is on the canvas STAYS there, it is just not a
   *  claim about now. */
  | 'reconnecting'
  /** TERMINAL: this session has no browser context to take over. */
  | 'no-context'
  /** TERMINAL: another takeover socket already holds this session. */
  | 'busy'
  /** TERMINAL: refused, or retries exhausted. */
  | 'offline'

/** The 4404/1013 close reasons, verbatim from `takeover.rs`. Pinned on both
 *  sides — the server has the twin assertion, so the day either string moves,
 *  one of the two suites fails. */
export const REASON_NO_CONTEXT = 'no browser context'
export const REASON_ALREADY_ATTACHED = 'already attached'

const CLOSE_AUTH = 1008
const CLOSE_AGAIN = 1013
const CLOSE_NO_CONTEXT = 4404

/** Everything the UI reads. Changes rarely — frames are NOT in here. */
export interface TakeoverSnapshot {
  state: TakeoverState
  /** `null` until the server has told us; never guessed. */
  mode: DriveMode | null
  /** The page's URL at attach time. */
  url: string
  /** The last input the server dropped, and why — cleared on the next accepted
   *  gesture so a stale banner cannot outlive its cause. */
  refused: string | null
}

export const EMPTY_SNAPSHOT: TakeoverSnapshot = {
  state: 'connecting',
  mode: null,
  url: '',
  refused: null,
}

export interface TakeoverOptions {
  /** Injected for tests; defaults to a real `WebSocket`. */
  factory?: (url: string) => SocketLike
  /** Injected for tests; defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  /** Injected for tests; defaults to `env.ts`. */
  token?: () => string
  baseUrl?: () => string
}

/** Exponential backoff with ±20% jitter, capped — the terminal socket's curve. */
export function backoffDelay(attempt: number): number {
  const base = Math.min(500 * 2 ** Math.max(0, attempt - 1), 10_000)
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

/** CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersFor(e: {
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}): number {
  return (
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
  )
}

/**
 * The text a key press inserts, or `undefined` for a key that inserts nothing.
 *
 * This is what makes the server pick `keyDown` over `rawKeyDown`, and it is the
 * difference between typing into a page and merely poking it: a bare
 * `rawKeyDown` moves focus and fires handlers but never puts a character in an
 * input. A chorded key (Ctrl/Meta held) inserts nothing — `Ctrl+A` is
 * select-all, not the letter "a".
 */
export function keyText(e: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
}): string | undefined {
  if (e.ctrlKey || e.metaKey) return undefined
  if (e.key === 'Enter') return '\r'
  if (e.key === 'Tab') return '\t'
  // A single code point — `key` is 'a', 'é', '€', or an emoji; anything longer
  // ('Shift', 'ArrowUp', 'Backspace') is a named key that inserts nothing.
  return [...e.key].length === 1 ? e.key : undefined
}

export class TakeoverSocket {
  private ws: SocketLike | null = null
  private authed = false
  private stopped = false
  private attempt = 0
  private retry: unknown = null
  private snap: TakeoverSnapshot = { ...EMPTY_SNAPSHOT }

  // Plain fields, not constructor parameter properties: the app's tsconfig
  // sets `erasableSyntaxOnly`, so every construct that emits runtime code from
  // a type-position keyword is out.
  private readonly session: string
  private readonly onSnapshot: (s: TakeoverSnapshot) => void
  private readonly onFrame: (f: TakeoverFrame) => void
  private readonly opts: TakeoverOptions

  constructor(
    session: string,
    onSnapshot: (s: TakeoverSnapshot) => void,
    onFrame: (f: TakeoverFrame) => void,
    opts: TakeoverOptions = {},
  ) {
    this.session = session
    this.onSnapshot = onSnapshot
    this.onFrame = onFrame
    this.opts = opts
  }

  snapshot(): TakeoverSnapshot {
    return this.snap
  }

  /** Dial. Idempotent while a socket is open. */
  start(): void {
    if (this.stopped || this.ws) return
    const base = (this.opts.baseUrl ?? wsUrl)()
    const url = `${base}/ws/browser/${encodeURIComponent(this.session)}/takeover`
    const make = this.opts.factory ?? ((u: string) => new WebSocket(u) as unknown as SocketLike)
    const ws = make(url)
    this.ws = ws
    this.authed = false

    ws.onopen = () => {
      // FIRST frame, always. Anything sent before `auth_ok` is dropped by the
      // server, so input helpers no-op until `authed`.
      const token = (this.opts.token ?? authToken)()
      ws.send(JSON.stringify({ type: 'auth', token }))
    }
    ws.onmessage = (ev) => this.receive(ev.data)
    ws.onerror = () => {
      /* `onclose` always follows; nothing useful to do here. */
    }
    ws.onclose = (ev) => this.closed(ev.code, ev.reason)
  }

  /** Hang up for good. Safe to call twice, and from a React cleanup. */
  stop(): void {
    this.stopped = true
    if (this.retry !== null) {
      ;(this.opts.cancel ?? clearTimeout)(this.retry as never)
      this.retry = null
    }
    const ws = this.ws
    this.ws = null
    this.authed = false
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close(1000, 'done')
      } catch {
        /* already gone */
      }
    }
  }

  // ── outbound ──────────────────────────────────────────────────────────────

  private send(msg: Record<string, unknown>): void {
    if (!this.authed || !this.ws) return
    try {
      this.ws.send(JSON.stringify(msg))
    } catch {
      /* the close handler will redial */
    }
  }

  mouse(
    kind: 'move' | 'down' | 'up',
    point: { x: number; y: number },
    extra: { button?: string; buttons?: number; clickCount?: number; modifiers?: number } = {},
  ): void {
    this.send({
      type: 'mouse',
      kind,
      x: point.x,
      y: point.y,
      button: extra.button ?? (kind === 'move' ? 'none' : 'left'),
      buttons: extra.buttons ?? (kind === 'down' ? 1 : 0),
      click_count: extra.clickCount ?? (kind === 'move' ? 0 : 1),
      modifiers: extra.modifiers ?? 0,
    })
  }

  wheel(point: { x: number; y: number }, delta: { dx: number; dy: number }): void {
    this.send({ type: 'wheel', x: point.x, y: point.y, dx: delta.dx, dy: delta.dy })
  }

  key(
    kind: 'down' | 'up',
    e: { key: string; code?: string; keyCode?: number; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  ): void {
    this.send({
      type: 'key',
      kind,
      key: e.key,
      code: e.code ?? '',
      key_code: e.keyCode ?? 0,
      text: kind === 'down' ? keyText(e) : undefined,
      modifiers: modifiersFor(e),
    })
  }

  text(text: string): void {
    if (!text) return
    this.send({ type: 'text', text })
  }

  touch(kind: 'start' | 'move' | 'end' | 'cancel', point?: { x: number; y: number }): void {
    this.send({ type: 'touch', kind, x: point?.x ?? 0, y: point?.y ?? 0 })
  }

  /** Give the wheel back but keep watching. */
  handBack(): void {
    this.send({ type: 'hand_back' })
  }

  /** Grab it again. */
  takeOver(): void {
    this.send({ type: 'take_over' })
  }

  /** Ask for a fresh still — a static page emits no frames of its own. */
  resync(): void {
    this.send({ type: 'resync' })
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  private receive(raw: unknown): void {
    if (typeof raw !== 'string') return
    let msg: { type?: string; [k: string]: unknown }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    switch (msg.type) {
      case 'auth_ok':
        this.authed = true
        this.attempt = 0
        this.patch({ state: 'live' })
        return
      case 'target':
        this.patch({ url: String(msg.url ?? '') })
        return
      case 'mode':
        this.patch({ mode: msg.mode as DriveMode, refused: null })
        return
      case 'refused':
        this.patch({ refused: String(msg.reason ?? 'refused') })
        return
      case 'frame': {
        const data = typeof msg.data === 'string' ? msg.data : ''
        if (!data) return
        this.onFrame({
          data,
          metadata: (msg.metadata ?? {}) as FrameMetadata,
        })
        return
      }
      default:
        return
    }
  }

  private closed(code: number, reason?: string): void {
    this.ws = null
    this.authed = false
    if (this.stopped) return

    const why = (reason ?? '').trim()
    // Terminal: redialling cannot change any of these facts.
    if (code === CLOSE_NO_CONTEXT || why === REASON_NO_CONTEXT) {
      this.patch({ state: 'no-context' })
      this.stopped = true
      return
    }
    if (code === CLOSE_AUTH) {
      this.patch({ state: 'offline' })
      this.stopped = true
      return
    }
    if (code === CLOSE_AGAIN && why === REASON_ALREADY_ATTACHED) {
      // Retryable in principle (the other viewer will leave) but never by
      // hammering — surface it and let the human retry.
      this.patch({ state: 'busy' })
      this.stopped = true
      return
    }

    this.attempt += 1
    this.patch({ state: 'reconnecting' })
    const delay = backoffDelay(this.attempt)
    this.retry = (this.opts.schedule ?? setTimeout)(() => {
      this.retry = null
      this.start()
    }, delay)
  }

  private patch(next: Partial<TakeoverSnapshot>): void {
    this.snap = { ...this.snap, ...next }
    this.onSnapshot(this.snap)
  }
}

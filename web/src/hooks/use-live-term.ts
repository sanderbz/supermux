// useLiveTerm — M13. The live terminal hook (TECH_PLAN §4.5, §5.2).
//
// Drives an xterm.js Terminal bound to the M4 WebSocket pty stream:
//   • Renders replay + live pty bytes (binary frames → term.write).
//   • Sends user keystrokes back (term.onData → {type:'input'} text frames).
//   • Resizes via FitAddon + a debounced ResizeObserver, telling the server the
//     new {cols,rows} so the pty geometry tracks the viewport.
//   • Reconnects with exponential backoff + decorrelated jitter, honouring the
//     v2 close-code semantics (§4.5).
//
// PRINCIPLE: WebSocket-ONLY. There is no polling here — bytes arrive over the WS
// the M4 backend already fans out. The auth token is NEVER put in the URL
// (Codex #7): we connect token-less and send {type:'auth',token} as the first
// frame, then wait for {type:'auth_ok'} before declaring ourselves `live`. The
// token is read from `window._SUPERMUX_AUTH_TOKEN` at runtime (env.ts) — never
// embedded in source.

import * as React from 'react'
import { Terminal } from '@xterm/xterm'
import { CanvasAddon } from '@xterm/addon-canvas'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

import { authToken, wsUrl } from '@/env'
import { claim as claimPrewarm } from '@/hooks/peek-prewarm-store'

// `stopped` is TERMINAL and distinct from `offline`: the server told us the
// session's pty is gone (not running) — there is nothing to reconnect to, so we
// do NOT retry. `offline` means we exhausted retries / were rejected and a
// manual "Tap to retry" still makes sense.
export type LiveTermState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'stopped'

export interface UseLiveTermResult {
  containerRef: React.RefObject<HTMLDivElement | null>
  state: LiveTermState
  /** True once the FIRST real pty data frame has been written to xterm (auth_ok
   *  alone doesn't count — a `stopped` session can connect + auth + immediately
   *  close with zero bytes). The overview hover-zoom uses this to keep the
   *  static ANSI preview visible UNTIL the live terminal has actual content,
   *  then crossfade — no blank-black-void flicker (peek crossfade polish). */
  hasFirstFrame: boolean
  /** Send literal text to the pty (e.g. a pasted snippet, a slash command). */
  send(text: string): void
  /** Send a named key (Up/Down/Left/Right/PageUp/Enter/…) — see §4.4 gestures. */
  sendKey(name: string): void
  /** Force a fit + resize round-trip (callers rarely need this — the
   *  ResizeObserver handles it — but the dock/joystick may after a layout flip). */
  resize(cols: number, rows: number): void
  /** Copy the whole scrollback buffer to the clipboard. */
  copyAll(): void
  /** Manual retry for the permanent (`offline`) state — "Tap to retry" (§4.12). */
  retry(): void
  /** Programmatically focus xterm's input. The focus route calls this on mount
   *  so keystrokes go to the terminal IMMEDIATELY — no second click required. */
  focus(): void
}

// ── Tunables (TECH_PLAN §4.5) ─────────────────────────────────────────────────
const BASE_BACKOFF_MS = 300
const MAX_BACKOFF_MS = 30_000
const MAX_ATTEMPTS = 6 // 1011 server-error path then permanent
const RESIZE_DEBOUNCE_MS = 100
const VISIBILITY_DEBOUNCE_MS = 2_000
const AUTH_GRACE_MS = 4_000 // server allots 2s for the first frame; we give slack

// Close codes with explicit v2 semantics (§4.5).
const CLOSE_AUTH = 1008 // auth/origin reject — permanent
const CLOSE_SERVER = 1011 // server error — backoff, then permanent
const CLOSE_TOO_SLOW = 1013 // subscriber overflow — silent reconnect on visible
const CLOSE_REVOKED = 4001 // explicit token revocation — permanent
const CLOSE_NOT_RUNNING = 4404 // session's pty is gone — TERMINAL, do NOT retry
const CLOSE_UNMOUNT = 1000 // normal — our own teardown

/** Read the live terminal theme from the CSS custom properties (§4.5). This runs
 *  at mount so the terminal tracks whichever theme `<ThemeProvider>` applied to
 *  <html> before first paint — no hardcoded hex (Termius criterion #15). */
function themeFromCss(): { background: string; foreground: string; cursor: string } {
  const css = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback
  const fg = read('--terminal-fg', '#e5e5e7')
  return {
    // OLED-true terminal surface matching the design tokens (globals.css).
    background: read('--terminal-bg', '#000000'),
    foreground: fg,
    cursor: fg,
  }
}

/** Map a named key to the literal control bytes the pty expects. Keeps the
 *  `{type:'input'}` wire shape (§5.2) — the M4 backend forwards input verbatim
 *  via `tmux send-keys -l`, so we resolve the byte sequence client-side. Used by
 *  the dock send-row + the joystick (M14/M15/M17) through `sendKey`. */
function keyToBytes(name: string): string {
  switch (name) {
    case 'Up':
      return '\x1b[A'
    case 'Down':
      return '\x1b[B'
    case 'Right':
      return '\x1b[C'
    case 'Left':
      return '\x1b[D'
    case 'Enter':
    case 'Return':
      return '\r'
    case 'Tab':
      return '\t'
    case 'Esc':
    case 'Escape':
      return '\x1b'
    case 'Backspace':
      return '\x7f'
    case 'PageUp':
      return '\x1b[5~'
    case 'PageDown':
      return '\x1b[6~'
    case 'Home':
      return '\x1b[H'
    case 'End':
      return '\x1b[F'
    case 'Ctrl-C':
      return '\x03'
    case 'Ctrl-U':
      return '\x15'
    case 'Ctrl-D':
      return '\x04'
    case 'Ctrl-Z':
      return '\x1a'
    case 'Ctrl-L':
      return '\x0c'
    case 'Ctrl-A':
      return '\x01'
    case 'Ctrl-E':
      return '\x05'
    case 'Ctrl-R':
      return '\x12'
    default:
      // Single-char or already-literal text falls through unchanged.
      return name
  }
}

/** Exponential backoff with ±20% decorrelated jitter, from the FIRST retry
 *  (Eng P1 #5 — avoids the reconnect-storm during a Tailscale server restart).
 *  Formula per §4.5: delay = base*2^n; jittered = delay/2 + random(delay). */
function backoffDelay(attempt: number): number {
  const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  return delay / 2 + Math.random() * delay
}

export function useLiveTerm(
  name: string,
  opts?: {
    readOnly?: boolean
    fontSize?: number
    /** Allow imperative `send` / `sendKey` even when `readOnly` is true. The
     *  type-on-hover peek (overview live-zoom) sets this so its document-level
     *  keydown handler can pipe keystrokes through the existing M13 wire while
     *  keeping the xterm DOM stdin disabled (no focus surprises, no global
     *  reconnect-banner subscription). Without this flag `send`/`sendKey` are
     *  silenced for readOnly embeds — the original M11 contract. */
    allowProgrammaticInput?: boolean
    /** Pre-warm fast-path: when true, the mount effect first attempts to adopt
     *  an already-open, already-authed WS + buffered bytes from the peek-
     *  prewarm registry (`peek-prewarm-store`) — so the overview hover-zoom
     *  hydrates INSTANTLY instead of waiting for a fresh M4 handshake +
     *  first-frame round-trip. Falls back to normal connect if no pre-warm
     *  exists (cap was full, tile only just became visible, etc.). Off by
     *  default so the focus terminal + quick-peek modal keep their existing
     *  single-WS lifecycle. */
    prewarmSeed?: boolean
  },
): UseLiveTermResult {
  const readOnly = opts?.readOnly ?? false
  const allowProgrammaticInput = opts?.allowProgrammaticInput ?? false
  // The overview hover-zoom embed renders fewer, larger rows so the shrunk pane
  // stays legible at a glance (it passes an explicit fontSize). The focus
  // terminal and quick-peek omit it and keep the M13 default.
  const fontSize = opts?.fontSize ?? 13
  // When true, the mount effect first attempts to adopt an already-open,
  // already-authed WS + buffered bytes from the peek-prewarm registry — so the
  // overview hover-zoom hydrates INSTANTLY instead of waiting for a fresh M4
  // handshake + first-frame round-trip. Falls back to normal connect if no
  // pre-warm exists (cap was full, tile only just became visible, etc.). Off
  // by default so the focus terminal + quick-peek modal keep their existing
  // single-WS lifecycle.
  const prewarmSeed = opts?.prewarmSeed ?? false

  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  const wsRef = React.useRef<WebSocket | null>(null)

  const [state, setState] = React.useState<LiveTermState>('connecting')
  const stateRef = React.useRef<LiveTermState>('connecting')
  const setLiveState = React.useCallback((s: LiveTermState) => {
    stateRef.current = s
    setState(s)
  }, [])

  // Flips true the first time the WS delivers REAL pty bytes — distinct from
  // `state==='live'` (which only proves auth_ok arrived). A `stopped` session
  // can auth-ok then immediately close with zero bytes, so the overview
  // hover-zoom uses THIS signal to gate its crossfade (no blank-black flicker).
  const [hasFirstFrame, setHasFirstFrame] = React.useState(false)
  const hasFirstFrameRef = React.useRef(false)

  // Mutable connection bookkeeping kept in refs so the single mount effect owns
  // the whole lifecycle (no re-subscribe churn on re-render).
  const attemptRef = React.useRef(0)
  const authedRef = React.useRef(false)
  const reconnectTimerRef = React.useRef<number | null>(null)
  const visibilityPendingRef = React.useRef(false) // 1013 → wait for visible
  const lastVisibleAtRef = React.useRef(0)
  const disposedRef = React.useRef(false)
  // `connectRef` lets the close handler call the latest `connect` without
  // recreating the effect; assigned once below.
  const connectRef = React.useRef<() => void>(() => {})

  // ── Imperative API (stable refs; the dock/joystick call these) ──────────────
  const sendRaw = React.useCallback((data: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN && authedRef.current) {
      ws.send(JSON.stringify({ type: 'input', data }))
    }
  }, [])

  const send = React.useCallback(
    (text: string) => {
      if (readOnly && !allowProgrammaticInput) return
      sendRaw(text)
    },
    [readOnly, allowProgrammaticInput, sendRaw],
  )

  const sendKey = React.useCallback(
    (key: string) => {
      if (readOnly && !allowProgrammaticInput) return
      sendRaw(keyToBytes(key))
    },
    [readOnly, allowProgrammaticInput, sendRaw],
  )

  const resize = React.useCallback((cols: number, rows: number) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN && authedRef.current) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }, [])

  const copyAll = React.useCallback(() => {
    const term = termRef.current
    if (!term) return
    const buf = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }
    const text = lines.join('\n').replace(/\n+$/, '\n')
    void navigator.clipboard?.writeText(text)
  }, [])

  const retry = React.useCallback(() => {
    if (disposedRef.current) return
    attemptRef.current = 0
    visibilityPendingRef.current = false
    setLiveState('connecting')
    connectRef.current()
  }, [setLiveState])

  /** Programmatically focus xterm's input. Called from the focus route on mount
   *  so keystrokes flow to the terminal IMMEDIATELY — no second click. Safe to
   *  call before the terminal is mounted (no-op until then). */
  const focus = React.useCallback(() => {
    termRef.current?.focus()
  }, [])

  // ── Single mount effect: owns the terminal + WS lifecycle ───────────────────
  React.useEffect(() => {
    disposedRef.current = false
    const container = containerRef.current
    if (!container) return

    // 1. Terminal + addons (§4.5). Canvas renderer for desktop perf; FitAddon
    //    snaps the geometry to the container; WebLinks makes URLs clickable.
    const term = new Terminal({
      fontFamily: 'SF Mono, Menlo, monospace',
      fontSize,
      lineHeight: 1.2,
      theme: themeFromCss(),
      allowTransparency: false,
      cursorBlink: true,
      scrollback: 5000,
      disableStdin: readOnly,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    // CanvasAddon needs the renderer's char dimensions to exist, which only
    // happens once the container has a real layout box. Loading it eagerly on a
    // zero-size container (or one that resizes before first paint) throws
    // "Cannot read properties of undefined (reading 'dimensions')". So we defer:
    // wait a frame, perform the FIRST fit (now the box is laid out), THEN attach
    // the canvas renderer. xterm's DOM renderer covers the gap before this runs.
    const raf = window.requestAnimationFrame(() => {
      if (disposedRef.current) return
      try {
        fit.fit()
      } catch {
        /* container still 0-size — the ResizeObserver fit covers it */
      }
      try {
        if (term.cols > 0 && term.rows > 0) {
          term.loadAddon(new CanvasAddon())
        }
      } catch {
        // Canvas may be unavailable in some headless/WKWebView contexts; the DOM
        // renderer (xterm default) is a safe fallback. Non-fatal.
      }
    })

    // 2. Local echo path: pipe xterm keystrokes back to the pty (§5.2). The
    //    server echoes them via the broadcast stream, so we do NOT write locally.
    if (!readOnly) {
      term.onData((s) => sendRaw(s))
    }

    // 3. WebSocket connect with first-frame auth (§4.5). No `?_token=` in URL.
    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    const scheduleReconnect = () => {
      if (disposedRef.current) return
      const attempt = attemptRef.current
      if (attempt >= MAX_ATTEMPTS) {
        setLiveState('offline')
        return
      }
      attemptRef.current = attempt + 1
      setLiveState('reconnecting')
      clearReconnectTimer()
      reconnectTimerRef.current = window.setTimeout(
        () => connect(),
        backoffDelay(attempt),
      )
    }

    /** Install the message/error/close handlers on a WebSocket — used for both
     *  freshly-opened connections and adopted pre-warm seeds. Returns a small
     *  control object so the caller can clear the auth grace timer. */
    const installHandlers = (
      ws: WebSocket,
      opts: { skipAuth?: boolean } = {},
    ) => {
      // Guard: if `auth_ok` never arrives, treat as a failed connection. When
      // adopting a pre-warm seed the WS is already authed — no grace needed.
      let authTimer: number | null = opts.skipAuth
        ? null
        : window.setTimeout(() => {
            if (!authedRef.current) ws.close()
          }, AUTH_GRACE_MS)
      const clearAuthTimer = () => {
        if (authTimer !== null) {
          window.clearTimeout(authTimer)
          authTimer = null
        }
      }

      ws.onmessage = async (ev: MessageEvent) => {
        const data = ev.data
        if (typeof data === 'string') {
          // Control frames (JSON): auth_ok / error / pong.
          try {
            const msg = JSON.parse(data) as { type?: string }
            if (msg.type === 'auth_ok') {
              clearAuthTimer()
              authedRef.current = true
              setLiveState('live')
              // NOTE: we do NOT reset the reconnect backoff here. A WS that
              // 101-upgrades and auth-acks but then immediately closes (e.g. a
              // `stopped` session whose pty is gone) is NOT a genuinely useful
              // connection — resetting here would let a connect→auth_ok→close
              // cycle storm with zero backoff. The backoff is reset only once a
              // real pty data frame arrives (see the binary branch below).
              // Push our geometry so the pty matches the viewport immediately.
              const t = termRef.current
              if (t) resize(t.cols, t.rows)
            }
          } catch {
            /* ignore non-JSON text frames */
          }
          return
        }
        // Binary frame = pty bytes (replay buffer first, then live stream). The
        // FIRST pty byte is the proof the connection is genuinely useful — only
        // now is it safe to reset the reconnect backoff (Eng P1 #5).
        attemptRef.current = 0
        const term = termRef.current
        if (!term) return
        if (data instanceof ArrayBuffer) {
          term.write(new Uint8Array(data))
        } else if (data instanceof Blob) {
          term.write(new Uint8Array(await data.arrayBuffer()))
        }
        // Mark the first real pty frame so the overview hover-zoom can swap the
        // static ANSI preview out (peek crossfade polish). Cheap idempotent
        // ref-then-state flip — re-renders happen ONCE per mount.
        if (!hasFirstFrameRef.current) {
          hasFirstFrameRef.current = true
          setHasFirstFrame(true)
        }
      }

      ws.onerror = () => {
        // Surfaced via onclose; nothing actionable here.
      }

      ws.onclose = (ev: CloseEvent) => {
        clearAuthTimer()
        authedRef.current = false
        if (disposedRef.current || ev.code === CLOSE_UNMOUNT) return

        switch (ev.code) {
          case CLOSE_NOT_RUNNING:
            // TERMINAL: the server says this session's pty is gone (a `stopped`
            // session). There is nothing to reconnect to — STOP entirely and
            // surface the distinct `stopped` state. A genuine network drop uses
            // a different code (1006/1011) and still backs off + retries below.
            setLiveState('stopped')
            return
          case CLOSE_AUTH:
          case CLOSE_REVOKED:
            // Permanent: auth/origin reject or explicit revocation (§4.5).
            setLiveState('offline')
            return
          case CLOSE_TOO_SLOW:
            // 1013 = subscriber overflow. NOT permanent: stay `reconnecting`
            // and silently retry on the NEXT visibilitychange→visible (§4.5).
            visibilityPendingRef.current = true
            setLiveState('reconnecting')
            return
          case CLOSE_SERVER:
          default:
            // 1011 server error + all network closes (1006/…): backoff retry.
            scheduleReconnect()
            return
        }
      }
    }

    const connect = () => {
      if (disposedRef.current) return
      clearReconnectTimer()
      authedRef.current = false

      const base = wsUrl().replace(/\/$/, '')
      const url = `${base}/ws/sessions/${encodeURIComponent(name)}`
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch {
        scheduleReconnect()
        return
      }
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      // Set onopen FIRST so installHandlers' message/close wiring sees a
      // consistent WebSocket. The first frame is the in-band auth (token from
      // window, never the URL).
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ type: 'auth', token: authToken() }))
        } catch {
          /* will surface via onclose */
        }
      }
      installHandlers(ws)
    }

    /** Adopt an already-open, already-authed WebSocket + buffered bytes from
     *  the peek-prewarm registry. Skips the M4 handshake entirely: state goes
     *  straight to `live`, the buffer is written into xterm on the next
     *  microtask (after the first FitAddon `fit()` runs — see the rAF above —
     *  so the cols/rows reflow the buffered ANSI correctly), and the SAME WS
     *  continues streaming. Returns true on success. */
    const adopt = (seed: { ws: WebSocket; bytes: Uint8Array }): boolean => {
      if (disposedRef.current) {
        try {
          seed.ws.close(CLOSE_UNMOUNT, 'unmount-before-adopt')
        } catch {
          /* nothing */
        }
        return false
      }
      const ws = seed.ws
      // Re-set binaryType defensively in case a future contributor flips it on
      // the prewarm side.
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      authedRef.current = true
      // Skip the auth grace timer — we've already received auth_ok upstream.
      installHandlers(ws, { skipAuth: true })
      setLiveState('live')

      // Hydrate the terminal with the buffered bytes. Two timing constraints:
      //  • xterm must have a real layout box (cols/rows > 0) or `write` is
      //    a no-op on the renderer. The rAF above performs the first `fit()`;
      //    we schedule the hydrate AFTER that rAF so the box exists.
      //  • The buffer must land BEFORE any further live bytes arrive, so the
      //    on-screen output preserves chronological order. We're inside the
      //    same synchronous tick as installHandlers — no async gap yet — so
      //    the next message can only fire after this microtask completes; we
      //    queue the hydrate via rAF so it runs strictly after the first fit.
      if (seed.bytes.byteLength > 0) {
        const bytes = seed.bytes
        window.requestAnimationFrame(() => {
          if (disposedRef.current) return
          const t = termRef.current
          if (!t) return
          try {
            t.write(bytes)
          } catch {
            /* xterm rejected the write — non-fatal; live stream still flows */
          }
        })
      }
      // Push our current geometry to the server so the pty matches what xterm
      // just laid out (the pre-warm never sent a resize — it didn't know the
      // viewport size yet).
      window.requestAnimationFrame(() => {
        if (disposedRef.current) return
        const t = termRef.current
        if (!t) return
        try {
          resize(t.cols, t.rows)
        } catch {
          /* not yet authed in our view — onmessage path will catch up */
        }
      })
      return true
    }

    connectRef.current = connect
    // Pre-warm fast-path: try to adopt a buffered WS for `name` if the caller
    // opted in. If no seed is available (cap was full, prewarm not authed
    // yet, the WS closed in the meantime), fall through to the normal connect.
    if (prewarmSeed) {
      const seed = claimPrewarm(name)
      if (seed && adopt(seed)) {
        // Adopted — skip the fresh connect.
      } else {
        connect()
      }
    } else {
      connect()
    }

    // 4. ResizeObserver → debounced fit + resize round-trip (§4.5).
    let resizeTimer: number | null = null
    const ro = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        const f = fitRef.current
        const t = termRef.current
        if (!f || !t) return
        try {
          f.fit()
        } catch {
          return
        }
        resize(t.cols, t.rows)
      }, RESIZE_DEBOUNCE_MS)
    })
    ro.observe(container)

    // 5. 1013 silent-reconnect: on visibilitychange→visible (debounced ≥2s),
    //    re-establish the subscription without a banner state flip (§4.5).
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (!visibilityPendingRef.current || disposedRef.current) return
      const now = Date.now()
      if (now - lastVisibleAtRef.current < VISIBILITY_DEBOUNCE_MS) return
      lastVisibleAtRef.current = now
      visibilityPendingRef.current = false
      attemptRef.current = 0
      connect()
    }
    document.addEventListener('visibilitychange', onVisibility)

    // 6. Teardown — dispose terminal + close WS so the mount/unmount cycle test
    //    (100 iterations, §4.5 / §11) returns WS count to zero, no leaks.
    return () => {
      disposedRef.current = true
      window.cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
      ro.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      clearReconnectTimer()
      const ws = wsRef.current
      if (ws) {
        // Drop handlers before closing so a late onclose can't re-arm a retry.
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        try {
          ws.close(CLOSE_UNMOUNT, 'unmount')
        } catch {
          /* already closing */
        }
        wsRef.current = null
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // Re-subscribe ONLY when the target session changes (or the embed's font
    // geometry changes). The imperative callbacks are ref-stable so they don't
    // belong in deps. `prewarmSeed` is read once at mount (it's a boolean
    // capability, not a per-render input) so it's omitted from the deps to
    // avoid re-subscribing if a parent toggles it on/off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, readOnly, fontSize])

  return {
    containerRef,
    state,
    hasFirstFrame,
    send,
    sendKey,
    resize,
    copyAll,
    retry,
    focus,
  }
}

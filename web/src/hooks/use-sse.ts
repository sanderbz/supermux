// useSse — the single source of real-time truth for the dashboard (TECH_PLAN
// §M12; §3.6 hero data flow). M10 shipped this as a typed stub; M12 fills it in.
//
// ONE EventSource to `/api/events`, fanned out to per-event-type callbacks. SSE
// is the only live channel for metadata + status — there is NO polling fallback
// (anti-vision: "WebSocket-only — no 3s polling"). The `sessions` event carries
// `preview_lines` + `status` deltas; `useSessions` subscribes to merge them into
// the TanStack Query cache, so the tile re-renders with fresh tail-preview text
// without any per-tile WebSocket and without re-fetching the whole list.
//
// Reliability (Eng P1 #5): auto-reconnect with 300ms × 2^n backoff capped at
// 30s, plus ±20% decorrelated jitter from day one (no thundering herd on a
// server restart). A staleness watchdog declares the stream dead after 18s of
// silence and forces a reconnect (some proxies hold a half-open SSE connection
// without delivering the `error` event). On `visibilitychange` / `focus` /
// `online`, if the last data arrived >4s ago, callers are nudged to refetch.
//
// Auth: EventSource cannot set an `Authorization` header, so the SSE channel
// uses the auth layer's `?_token=` fallback (server/src/auth.rs accepts it).
// The subagent prompt asked for `Authorization: Bearer`, but that is physically
// impossible for the browser `EventSource` API — the `?_token=` query is the
// documented, server-supported equivalent and is what the M19 board hook uses
// too. The token is read from `window` at runtime — NEVER embedded in source.

import * as React from 'react'

export type SseStatus = 'connecting' | 'open' | 'closed'

/** Known SSE event types (§3.4). The payload shape is event-specific; callers
 *  parse it. `ping` is a 10s keep-alive — it only resets the staleness clock. */
export type SseEventType =
  | 'sessions'
  | 'board'
  | 'schedules'
  | 'alerts'
  | 'status'
  | 'prefs'
  | 'ping'

export interface SseHandlers {
  /** Called with the parsed payload of each named event (except `ping`). */
  onEvent?: (type: SseEventType, payload: unknown) => void
  /** Called when the stream has been silent for >4s and a window/focus/online
   *  event fires — a hint to refetch the source-of-truth query. */
  onResync?: () => void
}

export interface UseSseResult {
  /** Live connection state of the shared event stream. */
  status: SseStatus
  /** Epoch ms of the last data frame (any event, incl. ping). 0 = never. */
  lastDataAt: number
}

const BASE_BACKOFF_MS = 300
const MAX_BACKOFF_MS = 30_000
const STALE_MS = 18_000 // force-reconnect after this much silence
const RESYNC_MS = 4_000 // refetch on focus if data older than this

/** Decorrelated ±20% jitter (Eng P1 #5) so simultaneous clients don't reconnect
 *  in lockstep after a server bounce. */
function jitter(ms: number): number {
  const spread = ms * 0.2
  return Math.round(ms - spread + Math.random() * spread * 2)
}

function sseUrl(): string {
  const token = window._SUPERMUX_AUTH_TOKEN ?? ''
  const base = (window._SUPERMUX_BASE_URL ?? import.meta.env.BASE_URL).replace(
    /\/$/,
    '',
  )
  return `${base}/api/events${token ? `?_token=${encodeURIComponent(token)}` : ''}`
}

/**
 * Open ONE authenticated EventSource and dispatch its events to `handlers`.
 * Reconnects with jittered exponential backoff; never polls. The `handlers`
 * object is read through a ref so callers can pass inline closures without
 * tearing down the connection on every render.
 */
export function useSse(handlers: SseHandlers = {}): UseSseResult {
  const [status, setStatus] = React.useState<SseStatus>('connecting')
  const lastDataRef = React.useRef(0)
  const [lastDataAt, setLastDataAt] = React.useState(0)

  // Keep the latest handlers in a ref so inline closures don't tear down the
  // connection on every render. Updated in an effect (never during render).
  const handlersRef = React.useRef(handlers)
  React.useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  React.useEffect(() => {
    let es: EventSource | null = null
    let attempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let staleTimer: ReturnType<typeof setInterval> | null = null
    let disposed = false

    const markData = () => {
      const now = Date.now()
      lastDataRef.current = now
      setLastDataAt(now)
    }

    const dispatch = (type: SseEventType, raw: string) => {
      markData()
      if (type === 'ping') return
      let payload: unknown = raw
      try {
        payload = JSON.parse(raw)
      } catch {
        /* keep the raw string for non-JSON frames */
      }
      handlersRef.current.onEvent?.(type, payload)
    }

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return
      const delay = jitter(
        Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS),
      )
      attempt += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    const connect = () => {
      if (disposed) return
      setStatus('connecting')
      try {
        es = new EventSource(sseUrl())
      } catch {
        scheduleReconnect()
        return
      }

      es.onopen = () => {
        attempt = 0
        setStatus('open')
        markData()
      }

      // The default (unnamed) channel: payloads of shape `{type, payload}`.
      es.onmessage = (ev: MessageEvent) => {
        markData()
        try {
          const data = JSON.parse(ev.data) as {
            type?: SseEventType
            payload?: unknown
          }
          if (data?.type) {
            handlersRef.current.onEvent?.(
              data.type,
              data.payload ?? data,
            )
            return
          }
        } catch {
          /* keep-alive / non-JSON — markData already ran */
        }
      }

      // Named channels (axum SSE adapter emits `event: sessions`, etc.).
      const NAMED: SseEventType[] = [
        'sessions',
        'board',
        'schedules',
        'alerts',
        'status',
        'prefs',
        'ping',
      ]
      for (const type of NAMED) {
        es.addEventListener(type, (ev) =>
          dispatch(type, (ev as MessageEvent).data),
        )
      }

      es.onerror = () => {
        // EventSource auto-reconnects, but its built-in retry has no jitter and
        // can't recover a half-open proxy connection. Take over: close + back
        // off ourselves so the policy is uniform.
        setStatus('closed')
        es?.close()
        es = null
        scheduleReconnect()
      }
    }

    // Staleness watchdog: if no frame (incl. ping) in STALE_MS, force-reconnect.
    staleTimer = setInterval(() => {
      if (disposed) return
      if (lastDataRef.current === 0) return
      if (Date.now() - lastDataRef.current > STALE_MS) {
        es?.close()
        es = null
        // Reset attempt so the forced reconnect fires promptly.
        attempt = 0
        scheduleReconnect()
      }
    }, STALE_MS / 3)

    // On regaining focus / visibility / network, nudge a resync if data is old.
    const onWake = () => {
      if (disposed) return
      if (
        lastDataRef.current === 0 ||
        Date.now() - lastDataRef.current > RESYNC_MS
      ) {
        handlersRef.current.onResync?.()
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') onWake()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onWake)
    window.addEventListener('online', onWake)

    connect()

    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (staleTimer) clearInterval(staleTimer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onWake)
      window.removeEventListener('online', onWake)
      es?.close()
      es = null
    }
  }, [])

  return { status, lastDataAt }
}

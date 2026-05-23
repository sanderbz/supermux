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
// SINGLETON: every `useSse(handlers)` call subscribes to the SAME module-level
// EventSource — opening one connection on first subscriber, closing it on last.
// Earlier versions opened one EventSource INSIDE each hook call's effect, so
// `useSessions` + `useBoard` + `useScheduler` + the always-mounted
// `<CommandPalette>` each held their own SSE channel against `/api/events` and
// the server fan-out scaled linearly with mount points. R3-202 collapsed all of
// those onto a single shared client; the public hook API (`useSse(handlers) →
// {status,lastDataAt}`) is unchanged, the change is purely internal.
//
// Reliability (Eng P1 #5): auto-reconnect with 300ms × 2^n backoff capped at
// 30s, plus ±20% decorrelated jitter from day one (no thundering herd on a
// server restart). A staleness watchdog declares the stream dead after 18s of
// silence and forces a reconnect (some proxies hold a half-open SSE connection
// without delivering the `error` event). On `visibilitychange` / `focus` /
// `online`, if the last data arrived >4s ago, subscribers are nudged to refetch.
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

// ── Module-level singleton ────────────────────────────────────────────────────
//
// A single EventSource, a Set of subscriber handler-refs, and a Set of status
// listeners. The first subscriber starts the connection; the last subscriber
// (count drops to 0) tears it down. Reconnect / staleness / wake hooks live
// here so they only run once per page, regardless of mount count.

interface SubscriberSlot {
  handlersRef: { current: SseHandlers }
}

type StatusListener = (status: SseStatus, lastDataAt: number) => void

const subscribers = new Set<SubscriberSlot>()
const statusListeners = new Set<StatusListener>()

let es: EventSource | null = null
let attempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let staleTimer: ReturnType<typeof setInterval> | null = null
let domListenersAttached = false
let currentStatus: SseStatus = 'connecting'
let lastDataAt = 0

function notifyStatus() {
  for (const l of statusListeners) l(currentStatus, lastDataAt)
}

function setStatus(next: SseStatus) {
  if (currentStatus === next) return
  currentStatus = next
  notifyStatus()
}

function markData() {
  lastDataAt = Date.now()
  notifyStatus()
}

function dispatchToAll(type: SseEventType, payload: unknown) {
  for (const s of subscribers) {
    try {
      s.handlersRef.current.onEvent?.(type, payload)
    } catch (err) {
      console.warn('use-sse: subscriber threw in onEvent', err)
    }
  }
}

function dispatchNamed(type: SseEventType, raw: string) {
  markData()
  if (type === 'ping') return
  let payload: unknown = raw
  try {
    payload = JSON.parse(raw)
  } catch {
    /* keep the raw string for non-JSON frames */
  }
  dispatchToAll(type, payload)
}

function scheduleReconnect() {
  if (subscribers.size === 0 || reconnectTimer) return
  const delay = jitter(
    Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS),
  )
  attempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

function connect() {
  if (subscribers.size === 0) return
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
        dispatchToAll(data.type, data.payload ?? data)
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
      dispatchNamed(type, (ev as MessageEvent).data),
    )
  }

  es.onerror = () => {
    // EventSource auto-reconnects, but its built-in retry has no jitter and
    // can't recover a half-open proxy connection. Take over: close + back off
    // ourselves so the policy is uniform.
    setStatus('closed')
    es?.close()
    es = null
    scheduleReconnect()
  }
}

function onWake() {
  if (subscribers.size === 0) return
  if (lastDataAt === 0 || Date.now() - lastDataAt > RESYNC_MS) {
    for (const s of subscribers) {
      try {
        s.handlersRef.current.onResync?.()
      } catch (err) {
        console.warn('use-sse: subscriber threw in onResync', err)
      }
    }
  }
}

function onVisible() {
  if (document.visibilityState === 'visible') onWake()
}

function attachDomListeners() {
  if (domListenersAttached) return
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onWake)
  window.addEventListener('online', onWake)
  domListenersAttached = true
}

function detachDomListeners() {
  if (!domListenersAttached) return
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('focus', onWake)
  window.removeEventListener('online', onWake)
  domListenersAttached = false
}

function startWatchdog() {
  if (staleTimer) return
  // Staleness watchdog: if no frame (incl. ping) in STALE_MS, force-reconnect.
  staleTimer = setInterval(() => {
    if (subscribers.size === 0) return
    if (lastDataAt === 0) return
    if (Date.now() - lastDataAt > STALE_MS) {
      es?.close()
      es = null
      // Reset attempt so the forced reconnect fires promptly.
      attempt = 0
      scheduleReconnect()
    }
  }, STALE_MS / 3)
}

function stopWatchdog() {
  if (!staleTimer) return
  clearInterval(staleTimer)
  staleTimer = null
}

function subscribe(slot: SubscriberSlot): () => void {
  const wasEmpty = subscribers.size === 0
  subscribers.add(slot)
  if (wasEmpty) {
    attachDomListeners()
    startWatchdog()
    attempt = 0
    connect()
  }
  return () => {
    subscribers.delete(slot)
    if (subscribers.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      stopWatchdog()
      detachDomListeners()
      es?.close()
      es = null
      // Reset bookkeeping so a future subscriber starts from a clean slate.
      attempt = 0
      lastDataAt = 0
      setStatus('connecting')
    }
  }
}

function subscribeStatus(listener: StatusListener): () => void {
  statusListeners.add(listener)
  // Fire once so the new listener sees the current snapshot immediately.
  listener(currentStatus, lastDataAt)
  return () => {
    statusListeners.delete(listener)
  }
}

/**
 * Subscribe `handlers` to the ONE shared EventSource (opens on first call,
 * closes when the last consumer unmounts). Reconnect/backoff/staleness/wake are
 * owned by the singleton, so every call here just costs a Set add/remove. The
 * `handlers` object is read through a ref so callers can pass inline closures
 * without re-subscribing on every render.
 */
export function useSse(handlers: SseHandlers = {}): UseSseResult {
  // Keep the latest handlers in a ref so inline closures don't tear down the
  // connection on every render. Updated in an effect (never during render).
  const handlersRef = React.useRef(handlers)
  React.useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  const [snapshot, setSnapshot] = React.useState<UseSseResult>(() => ({
    status: currentStatus,
    lastDataAt,
  }))

  React.useEffect(() => {
    const slot: SubscriberSlot = { handlersRef }
    const unsubscribe = subscribe(slot)
    const unsubscribeStatus = subscribeStatus((status, last) => {
      setSnapshot({ status, lastDataAt: last })
    })
    return () => {
      unsubscribeStatus()
      unsubscribe()
    }
  }, [])

  return snapshot
}

/**
 * Read-only view of the shared SSE connection state. Use this when you only
 * need the status (e.g. registering with the global connection-store at the
 * shell level) and don't want to add another subscriber that holds the channel
 * open. Mount once at `<Layout>` for the ReconnectBanner link (R3-202).
 */
export function useSseStatus(): UseSseResult {
  const [snapshot, setSnapshot] = React.useState<UseSseResult>(() => ({
    status: currentStatus,
    lastDataAt,
  }))
  React.useEffect(() => {
    return subscribeStatus((status, last) => {
      setSnapshot({ status, lastDataAt: last })
    })
  }, [])
  return snapshot
}

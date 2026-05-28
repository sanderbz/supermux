// useConnectionStatus — V034 PWA offline / server-down UX.
//
// The thin public hook that the <ConnectionOverlay> reads. Wires together:
//   • `useApiStatus` store (the state machine — see stores/api-status-store.ts)
//   • `online` / `offline` window events
//   • A `/api/health` probe with exponential backoff while degraded
//
// The fetch wrapper (lib/api/fetch-wrap.ts) feeds the store from every
// real API call; the probe is a SECONDARY signal that runs ONLY while a
// hard-outage state is active, so we recover even when the app isn't
// otherwise calling the API.
//
// PRINCIPLE: still event-driven, no idle polling. The probe loop is armed
// strictly while the state is `server_unreachable` / `connecting` and
// disarmed on `connected` / `offline` / `auth_invalid`.

import * as React from 'react'

import { apiUrl, apiToken } from '@/lib/api/client'
import {
  useApiStatus,
  type ApiConnectionState,
} from '@/stores/api-status-store'

/** Backoff sequence for the recovery probe. After the last entry repeats. */
const BACKOFF_MS = [3_000, 6_000, 12_000]

/** Probe timeout — defends against a half-open connection that never responds. */
const PROBE_TIMEOUT_MS = 5_000

/** Single source of truth for the connection state — what the overlay reads. */
export interface ConnectionStatus extends ApiConnectionState {
  /** Trigger a probe now, bypassing backoff. Used by the manual "Try now"
   *  button in the overlay. Safe to call from any state — a no-op while a
   *  probe is already in flight. */
  retryNow: () => void
}

/** Fire-and-forget probe: GET /api/health with bearer + 5s timeout. The fetch
 *  wrapper (installed once at boot) handles the success/failure reporting, so
 *  here we just kick the request and let the store update. */
async function probe(): Promise<void> {
  const token = apiToken()
  const ctl = new AbortController()
  const timer = window.setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS)
  try {
    await fetch(apiUrl('/api/health'), {
      method: 'GET',
      signal: ctl.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      // Cache-bust: a stale CDN copy must not mask a down origin.
      cache: 'no-store',
    })
    // Result reporting is handled by the fetch wrapper observer.
  } catch {
    /* fetch wrapper reported the failure */
  } finally {
    window.clearTimeout(timer)
  }
}

// ── Singleton wiring — install once per window ────────────────────────────────
//
// The `online`/`offline` listeners + the probe scheduler must be installed
// EXACTLY ONCE per window even if `useConnectionStatus()` is mounted from many
// components. Two registrations would double-fire reports and stack two probe
// timers. We track install state on the window so HMR / fast-refresh respects
// the singleton too.
let listenersInstalled = false
let probeTimer: number | null = null
let probeAttempt = 0

function scheduleNextProbe(): void {
  const state = useApiStatus.getState()
  // Only probe while degraded — `connected` / `auth_invalid` / `offline` do
  // NOT auto-retry. (offline waits for the `online` event; auth_invalid waits
  // for the user; connected has nothing to fix.)
  if (state.kind !== 'server_unreachable' && state.kind !== 'connecting') {
    cancelProbe()
    return
  }
  const delay =
    BACKOFF_MS[Math.min(probeAttempt, BACKOFF_MS.length - 1)]
  probeAttempt += 1
  const at = Date.now() + delay
  useApiStatus.setState({ retryAt: at })
  probeTimer = window.setTimeout(async () => {
    probeTimer = null
    await probe()
    // The fetch wrapper has now updated the store. If still degraded, line
    // up the next probe; if `connected` the subscribe below cancels for us.
    scheduleNextProbe()
  }, delay)
}

function cancelProbe(): void {
  if (probeTimer !== null) {
    window.clearTimeout(probeTimer)
    probeTimer = null
  }
  probeAttempt = 0
  if (useApiStatus.getState().retryAt !== null) {
    useApiStatus.setState({ retryAt: null })
  }
}

function installListeners(): void {
  if (listenersInstalled) return
  if (typeof window === 'undefined') return
  listenersInstalled = true

  // Seed the offline state from the current navigator.onLine value.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    useApiStatus.getState().setOffline(true)
  }

  const onOnline = () => {
    useApiStatus.getState().setOffline(false)
    // Probe immediately — don't wait for backoff. The user explicitly
    // came back online; first impression should be "instant".
    cancelProbe()
    probeAttempt = 0
    void probe().then(() => {
      // If the probe didn't flip us to `connected`, schedule normal backoff.
      if (useApiStatus.getState().kind !== 'connected') scheduleNextProbe()
    })
  }
  const onOffline = () => {
    useApiStatus.getState().setOffline(true)
    cancelProbe()
  }
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)

  // Drive the probe scheduler off store transitions. Whenever the kind moves
  // INTO a degraded state, arm the backoff; moving OUT cancels it.
  let lastKind = useApiStatus.getState().kind
  useApiStatus.subscribe((s) => {
    if (s.kind === lastKind) return
    lastKind = s.kind
    if (s.kind === 'server_unreachable' || s.kind === 'connecting') {
      // Already armed? Don't double-arm.
      if (probeTimer === null) {
        probeAttempt = 0
        scheduleNextProbe()
      }
    } else {
      // `connected` / `offline` / `auth_invalid` — no auto-probe.
      cancelProbe()
    }
  })

  // Kick the initial probe a tick after boot. If the app shell loaded but the
  // FIRST API call is slow, this gives the overlay a quick signal even before
  // any feature module calls fetch — but only if we start in a non-healthy
  // state (typical: `connecting` while the first query is in flight).
  if (
    useApiStatus.getState().kind === 'connecting' ||
    useApiStatus.getState().kind === 'server_unreachable'
  ) {
    scheduleNextProbe()
  }
}

/**
 * Public hook. Returns the live connection state + a `retryNow` to bypass
 * backoff. Safe to mount from any number of components — the underlying
 * listener + probe scheduler are window-singletons.
 */
export function useConnectionStatus(): ConnectionStatus {
  // Subscribe to the whole store so the overlay re-renders when ANY field
  // changes (kind / retryAt / lastSeen / lastError).
  const kind = useApiStatus((s) => s.kind)
  const lastSeen = useApiStatus((s) => s.lastSeen)
  const retryAt = useApiStatus((s) => s.retryAt)
  const lastError = useApiStatus((s) => s.lastError)

  React.useEffect(() => {
    installListeners()
    // We never tear down the singletons — the app shell lives the lifetime of
    // the window. (Returning a cleanup would race with other consumers of the
    // same singletons.)
  }, [])

  const retryNow = React.useCallback(() => {
    // Bypass backoff: cancel pending, set connecting, fire one probe now.
    cancelProbe()
    probeAttempt = 0
    useApiStatus.getState().setConnecting()
    void probe().then(() => {
      // If still degraded after the manual try, resume the backoff schedule.
      if (useApiStatus.getState().kind !== 'connected') scheduleNextProbe()
    })
  }, [])

  return { kind, lastSeen, retryAt, lastError, retryNow }
}

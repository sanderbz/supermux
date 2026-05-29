// useApiStatus — the V034 connection-status state machine (PWA offline / server-
// down branded UX).
//
// THE PROBLEM. The existing `useConnection` store aggregates WS + SSE
// link states for the in-flow <ReconnectBanner>. It does NOT model:
//   • REST API health (5xx / network errors / 401 from arbitrary fetch calls)
//   • `navigator.onLine` (true device offline)
//   • An auth-invalid state needing user action (vs auto-retry)
// So when the gateway returns 502 or the user goes offline the app shows a
// blank screen until the next route re-render. This store closes that gap.
//
// PRINCIPLE: still event-driven. The store is updated by:
//   1. `online` / `offline` window events.
//   2. The global fetch wrapper (install-time monkey-patch) reporting every
//      /api/* response status / network throw / 401.
//   3. A small probe loop (3→6→12s exponential, capped 12s) that ONLY runs
//      while in a degraded state — never polls a healthy server.
// Healthy fetches reset the backoff and flip back to `connected`.
//
// Separate from `useConnection`: that one fans the per-link WS/SSE aggregate
// into the existing small banner. This one drives the FULL-SCREEN overlay for
// hard outages. The overlay wins (covers the banner) when both fire — same
// reality, one branded surface (no double-warning).

import { create } from 'zustand'

export type ApiConnectionKind =
  | 'connected'
  | 'connecting'
  | 'server_unreachable'
  | 'offline'
  | 'auth_invalid'

export interface ApiConnectionState {
  kind: ApiConnectionKind
  /** Epoch ms of the last successful API response (null until the first one). */
  lastSeen: number | null
  /** Epoch ms a retry is scheduled at — drives the "Next try in 6s" countdown.
   *  0 / null when no retry is pending (connected, or auth_invalid). */
  retryAt: number | null
  /** Last short error message (for diagnostics; the overlay shows curated copy). */
  lastError: string | null
}

interface ApiStatusStore extends ApiConnectionState {
  /** Report a successful /api/* response (any 2xx/3xx). */
  reportSuccess: () => void
  /** Report a failed /api/* call. `status` is the HTTP status (0 = network
   *  error / fetch threw). The store decides if this is auth_invalid / offline /
   *  server_unreachable / something to ignore. */
  reportFailure: (status: number, message?: string) => void
  /** Set the offline state from `navigator.onLine === false`. */
  setOffline: (offline: boolean) => void
  /** Set the scheduled retry instant (epoch ms) so the overlay can render a
   *  countdown. Cleared on success / auth_invalid. */
  setRetryAt: (at: number | null) => void
  /** Set the connecting state — used by the probe while in-flight. */
  setConnecting: () => void
}

/** Decide whether a freshly-reported failure should escalate to a hard outage.
 *  5xx and network errors → `server_unreachable`. 401/403 → `auth_invalid`. The
 *  rest (404, 409, 400, …) are real responses from a HEALTHY server — they do
 *  NOT touch the connection state. */
function classifyFailure(status: number): ApiConnectionKind | null {
  if (status === 401 || status === 403) return 'auth_invalid'
  if (status === 0) return 'server_unreachable' // fetch threw / network error
  if (status >= 500 && status <= 599) return 'server_unreachable'
  return null
}

export const useApiStatus = create<ApiStatusStore>()((set, get) => ({
  kind: 'connecting',
  lastSeen: null,
  retryAt: null,
  lastError: null,

  reportSuccess: () => {
    const now = Date.now()
    const prev = get()
    // Only re-render when meaningful (kind or first-success transition).
    if (prev.kind === 'connected') {
      set({ lastSeen: now, retryAt: null, lastError: null })
      return
    }
    set({
      kind: 'connected',
      lastSeen: now,
      retryAt: null,
      lastError: null,
    })
  },

  reportFailure: (status, message) => {
    const next = classifyFailure(status)
    if (!next) return // a 404/409/400 — server is fine, ignore.
    const prev = get()
    // Auth_invalid is sticky — once we know the token is bad, the user MUST
    // re-auth; auto-retry would just keep failing. Don't downgrade to a softer
    // state on a subsequent 5xx.
    if (prev.kind === 'auth_invalid' && next !== 'auth_invalid') return
    set({
      kind: next,
      // Auth_invalid clears the retry pending (no auto-retry — needs user).
      retryAt: next === 'auth_invalid' ? null : prev.retryAt,
      lastError: message ?? null,
    })
  },

  setOffline: (offline) => {
    const prev = get()
    if (offline) {
      // navigator.onLine wins over server_unreachable (they're the same UX
      // either way, but "You're offline" is more accurate when we know the
      // network is gone).
      if (prev.kind === 'offline') return
      set({ kind: 'offline', retryAt: null, lastError: null })
    } else {
      // Coming back online — drop to `connecting` so the probe verifies the
      // server is up before the overlay fades. The probe will flip to
      // `connected` on success.
      if (prev.kind !== 'offline') return
      set({ kind: 'connecting', retryAt: null, lastError: null })
    }
  },

  setRetryAt: (at) => set({ retryAt: at }),

  setConnecting: () => {
    const prev = get()
    if (prev.kind === 'auth_invalid') return // sticky — see reportFailure
    if (prev.kind === 'connected') return // probe is a no-op on success
    if (prev.kind === 'connecting') return
    set({ kind: 'connecting' })
  },
}))

/** True when the kind is one of the hard-outage states the overlay paints. */
export function isOverlayState(kind: ApiConnectionKind): boolean {
  return (
    kind === 'offline' ||
    kind === 'server_unreachable' ||
    kind === 'auth_invalid'
  )
}

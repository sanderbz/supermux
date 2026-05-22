// useConnectionLink — registers one live connection (SSE stream or a terminal
// WebSocket) with the global `useConnection` store (TECH_PLAN §M23a).
//
// This is the additive plumbing M23a owns: the SSE hook (`use-sse.ts`) and the
// live-terminal hook (`use-live-term.ts`) each expose their own per-link state
// enum; this hook normalises that enum onto the store's `LinkState` vocabulary
// and pushes it whenever it changes. The store then aggregates the worst case
// across every registered link for the <ReconnectBanner>.
//
// PRINCIPLE: still single-source, still event-driven — this hook only fires on
// the state value that the underlying WS/SSE callbacks already produced. It does
// not poll, fetch, or open any connection of its own.

import * as React from 'react'

import {
  reaggregateConnection,
  useConnection,
  type LinkState,
} from '@/stores/connection-store'
import type { SseStatus } from '@/hooks/use-sse'
import type { LiveTermState } from '@/hooks/use-live-term'

/** Map the SSE hook's status onto the store vocabulary. SSE's `closed` is a
 *  transient state — its hook is always backing off toward a reconnect — so it
 *  reads as `reconnecting`, never a hard `offline` (the SSE channel never gives
 *  up; only a terminal WS can go permanently offline). */
function fromSse(status: SseStatus): LinkState {
  switch (status) {
    case 'open':
      return 'connected'
    case 'connecting':
      return 'connecting'
    case 'closed':
      return 'reconnecting'
  }
}

/** Map the live-terminal hook's state onto the store vocabulary (`live` is the
 *  terminal's word for connected; the rest line up 1:1). `stopped` is a TERMINAL
 *  non-error state — the session's pty is intentionally gone, not a connection
 *  fault — so it must NOT drive the global reconnect banner: it reads as
 *  `connected` (i.e. "nothing wrong with the link"). */
function fromLiveTerm(state: LiveTermState): LinkState {
  return state === 'live' || state === 'stopped' ? 'connected' : state
}

/** Register the SSE stream as a connection link. Call once from the component
 *  that owns the app-wide SSE subscription (here: `useSessions`). */
export function useSseConnectionLink(status: SseStatus): void {
  const report = useConnection((s) => s.report)
  const release = useConnection((s) => s.release)
  React.useEffect(() => {
    report('sse', fromSse(status))
  }, [status, report])
  React.useEffect(() => () => release('sse'), [release])
}

/** Register one live-terminal WebSocket as a connection link. `id` must be
 *  stable + unique per terminal (the session name works). An EMPTY `id` opts the
 *  terminal out entirely (read-only embeds shouldn't drive the global banner) —
 *  the hook is still called unconditionally so the Rules of Hooks hold. `retry`
 *  is surfaced to the banner so its "Tap to retry" can re-arm this terminal. */
export function useTerminalConnectionLink(
  id: string,
  state: LiveTermState,
  retry?: () => void,
): void {
  const report = useConnection((s) => s.report)
  const release = useConnection((s) => s.release)
  const setRetry = useConnection((s) => s.setRetry)
  const linkId = id ? `term:${id}` : ''

  React.useEffect(() => {
    if (!linkId) return
    report(linkId, fromLiveTerm(state))
  }, [linkId, state, report])

  // Expose this terminal's retry to the banner only while it is the unhealthy
  // one — so the banner CTA always reaches a connection that can act on it.
  React.useEffect(() => {
    if (!linkId || !retry) return
    if (state === 'offline' || state === 'reconnecting') {
      setRetry(() => retry)
      return () => setRetry(null)
    }
  }, [linkId, state, retry, setRetry])

  React.useEffect(() => {
    if (!linkId) return
    return () => release(linkId)
  }, [linkId, release])
}

/** Tick the time-based offline-grace rule so a stuck `reconnecting` link
 *  escalates to `offline` after 30s even with no new reports. Mount once,
 *  app-wide (the banner host does this). Pauses itself when nothing is degraded. */
export function useConnectionReaggregator(): void {
  React.useEffect(() => {
    const id = window.setInterval(reaggregateConnection, 5_000)
    return () => window.clearInterval(id)
  }, [])
}

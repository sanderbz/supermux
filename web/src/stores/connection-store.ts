// useConnection — the single global source of truth for live-link health
// (research/termius-ios-native-spec.md §"Reconnect banner /
// connection status surface", §"v3 finish acceptance criteria" #8).
//
// The app holds N live connections at once: exactly one SSE stream (`/api/events`,
// see use-sse.ts) plus zero-or-more live-terminal WebSockets (use-live-term.ts,
// one per visible focus terminal). Each connection registers itself here and
// pushes its own state; the store AGGREGATES them into ONE worst-case verdict
// that the <ReconnectBanner> renders.
//
// Why a store and not "the last event wins": if the banner
// just mirrors whichever connection updated last, two terminals reconnecting out
// of phase make it flicker amber↔green. Aggregating the WORST current state
// across all registered links means the banner only goes green when EVERYTHING
// is healthy, and the green→fade only fires on a real all-clear. No flicker.
//
// PRINCIPLE: connection state is event-driven from the WS/SSE callbacks — there
// is NO polling here. Each link calls `report()` from its own onopen/onerror/
// onclose handler; the store is a pure reducer over those reports.

import { create } from 'zustand'

/** Per-connection link state. Mirrors `useLiveTerm`'s `LiveTermState` plus the
 *  SSE hook's three states, normalised onto one vocabulary. */
export type LinkState = 'connecting' | 'connected' | 'reconnecting' | 'offline'

/** Aggregated banner verdict — what <ReconnectBanner> renders. `connected` is
 *  the transient all-clear flash (auto-dismisses); `idle` means no surface. */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'offline'

interface LinkRecord {
  state: LinkState
  /** Epoch ms the link first entered a non-connected state. 0 while healthy.
   *  Used for the "Offline if any offline > 30s" rule. */
  degradedSince: number
}

interface ConnectionStore {
  /** Every registered link, keyed by a caller-supplied stable id. */
  links: Record<string, LinkRecord>
  /** The aggregated verdict — recomputed on every report. */
  state: ConnectionState
  /** True once the aggregate has been `connected` at least once AND every link
   *  is currently connected — drives the green "Connected" auto-dismiss flash. */
  justRecovered: boolean
  /** Register / update one link's state. Safe to call every render-cycle from a
   *  hook effect; a no-op if the state is unchanged. */
  report: (id: string, state: LinkState) => void
  /** Drop a link when its component unmounts (e.g. a focus terminal closes). */
  release: (id: string) => void
  /** Caller-driven retry hook — set by the active focus terminal so the banner's
   *  "Tap to retry" can reach into the right WS. Null when nothing is retryable. */
  retry: (() => void) | null
  setRetry: (fn: (() => void) | null) => void
}

/** Offline grace: a link must be un-connected for this long before it can drag
 *  the aggregate to `offline` ("Offline if any offline > 30s"). Until
 *  then a dead link still reads as `reconnecting` so a brief blip never shows
 *  the alarmist red surface. */
const OFFLINE_GRACE_MS = 30_000

/** Pure reducer: fold every link record into one banner verdict. Worst-state
 *  wins so the banner reflects the unhealthiest link, never the last-updated
 *  one. Precedence: offline > reconnecting/connecting > connected. */
function aggregate(links: Record<string, LinkRecord>): {
  state: ConnectionState
  justRecovered: boolean
} {
  const records = Object.values(links)
  if (records.length === 0) return { state: 'idle', justRecovered: false }

  const now = Date.now()
  let anyConnecting = false
  let anyReconnecting = false
  let anyOfflineHard = false // offline AND past the 30s grace
  let allConnected = true

  for (const r of records) {
    if (r.state !== 'connected') allConnected = false
    if (r.state === 'connecting') anyConnecting = true
    if (r.state === 'reconnecting') anyReconnecting = true
    if (r.state === 'offline') {
      if (r.degradedSince > 0 && now - r.degradedSince > OFFLINE_GRACE_MS) {
        anyOfflineHard = true
      } else {
        // Within grace — treat a dead link as still reconnecting (no red yet).
        anyReconnecting = true
      }
    }
  }

  if (anyOfflineHard) return { state: 'offline', justRecovered: false }
  if (anyReconnecting) return { state: 'reconnecting', justRecovered: false }
  if (anyConnecting) return { state: 'connecting', justRecovered: false }
  // Everything connected.
  return { state: 'connected', justRecovered: allConnected }
}

export const useConnection = create<ConnectionStore>()((set, get) => ({
  links: {},
  state: 'idle',
  justRecovered: false,
  retry: null,

  report: (id, linkState) => {
    const prev = get().links[id]
    if (prev && prev.state === linkState) return // no-op — idempotent reports

    const degradedSince =
      linkState === 'connected'
        ? 0
        : // Keep the original degraded timestamp across connecting↔reconnecting
          // so the 30s grace measures total downtime, not the latest sub-state.
          prev && prev.degradedSince > 0
          ? prev.degradedSince
          : Date.now()

    const links = { ...get().links, [id]: { state: linkState, degradedSince } }
    set({ links, ...aggregate(links) })
  },

  release: (id) => {
    if (!get().links[id]) return
    const links = { ...get().links }
    delete links[id]
    set({ links, ...aggregate(links) })
  },

  setRetry: (fn) => set({ retry: fn }),
}))

/** Re-evaluate the aggregate without a new report. The 30s offline-grace rule is
 *  time-based, so a link can cross the threshold while sitting still — the banner
 *  ticks this on an interval so `reconnecting` escalates to `offline` on time.
 *  Pure store mutation; still not polling a server. */
export function reaggregateConnection(): void {
  useConnection.setState((s) => aggregate(s.links))
}

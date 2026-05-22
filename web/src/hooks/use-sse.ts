// useSse — HARD-BLOCKER STUB (TECH_PLAN §M10, dep-graph fix).
//
// The single source of real-time truth for the dashboard. M12 fills in the real
// implementation: open ONE authenticated EventSource to `/api/events`, and on
// each `sessions` / `board` / `schedules` delta call
// `queryClient.invalidateQueries(...)`. This is WebSocket/SSE-only by design —
// there is NO polling fallback (anti-vision: "WebSocket-only — no 3s polling").
//
// Shipping this typed stub in M10 means M12/M19/M20/M21/M22 share one contract
// instead of each re-inventing the hook (which would 5-way merge-conflict).

export type SseStatus = 'connecting' | 'open' | 'closed'

export interface UseSseResult {
  /** Live connection state of the shared event stream. */
  status: SseStatus
}

/**
 * STUB: returns a closed connection and wires nothing. No polling, ever.
 * Real EventSource subscription + query invalidation lands in M12.
 */
export function useSse(): UseSseResult {
  return { status: 'closed' }
}

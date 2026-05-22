// Session ordering for focus-mode navigation (M15).
//
// The mobile focus mode steps prev/next through sessions in the SAME
// "pinned-then-active" order the overview grid uses (research/amux-feature-extract
// §1.2): pinned first, then by status priority (active|waiting before idle), then
// by most-recent activity. Keeping this ONE helper means the edge-swipe nav, the
// session-pill swipe, and the picker sheet all agree on what "the next session"
// is — there is no second source of truth.

import type { SessionStatus, SessionSummary } from '@/lib/api'

// Lower number = higher in the list. Live work (active / waiting) sorts above
// quiet sessions; terminal states sink to the bottom.
const STATUS_RANK: Record<SessionStatus, number> = {
  waiting: 0,
  active: 1,
  starting: 2,
  idle: 3,
  stopped: 4,
  error: 5,
}

/** Sessions that may carry a `pinned` flag (the overview/SSE payload sets it). */
type Orderable = SessionSummary & { pinned?: number | boolean }

/** Stable display order shared by the overview grid and focus-mode navigation. */
export function orderSessions<T extends Orderable>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => {
    const ap = a.pinned ? 1 : 0
    const bp = b.pinned ? 1 : 0
    if (ap !== bp) return bp - ap // pinned first
    const ar = STATUS_RANK[a.status] ?? 9
    const br = STATUS_RANK[b.status] ?? 9
    if (ar !== br) return ar - br // live work first
    // Most-recently-active first.
    return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
  })
}

/** The session that comes after `name` in display order, wrapping around. Returns
 *  `null` when there is zero or one session (nothing to switch to). */
export function neighborSession<T extends Orderable>(
  sessions: readonly T[],
  name: string,
  dir: 1 | -1,
): T | null {
  const ordered = orderSessions(sessions)
  if (ordered.length < 2) return null
  const idx = ordered.findIndex((s) => s.name === name)
  if (idx === -1) return ordered[0] ?? null
  const next = (idx + dir + ordered.length) % ordered.length
  return ordered[next] ?? null
}

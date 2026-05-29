// Session ordering for focus-mode navigation.
//
// The mobile focus mode steps prev/next through sessions in the SAME
// "pinned-then-active" order the overview grid uses: pinned first, then by
// status priority (active|waiting before idle), then by most-recent activity.
// Keeping this ONE helper means the edge-swipe nav, the session-pill swipe,
// and the picker sheet all agree on what "the next session" is — there is no
// second source of truth.

import type { ApiSession, SessionStatus } from '@/lib/api'
import type { Team, TeamMember } from '@/lib/api/teams'

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

/** Sessions that may carry a `pinned` flag (the overview/SSE payload sets it).
 *  Based on `ApiSession` — the canonical store/wire shape (`updated_at` optional,
 *  `pinned` present) the `useSessions` query actually delivers. */
type Orderable = ApiSession & { pinned?: number | boolean }

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

// ── Team-aware ordering ───────────────────────────────────────────────────────
// The mobile session picker is team-aware consistently with the overview: a
// detected team's LEAD + its TEAMMATES group together under the team, with the
// non-team sessions in the usual pinned-then-active order below. Teammates are
// NOT sessions (no `/api/sessions` row) — they are read-only and never become the
// edge-swipe "next session" (which only steps routable sessions). This ONE helper
// is the single source of truth for that grouped layout so the picker (and any
// future grouped surface) agree.

/** One picker entry: either a real session (lead or loose) or a read-only
 *  teammate belonging to `team`. */
export type PickerEntry<T extends Orderable> =
  | { kind: 'session'; session: T; lead: boolean; team: Team | null }
  | { kind: 'teammate'; team: Team; member: TeamMember }

/** A detected team rendered as a group header + its lead row + teammate rows. */
export interface PickerGroup<T extends Orderable> {
  team: Team
  /** The lead's session row (null when unmapped this tick). */
  lead: T | null
  members: readonly TeamMember[]
}

export interface PickerLayout<T extends Orderable> {
  /** Detected team groups (in `teams` order). */
  groups: PickerGroup<T>[]
  /** Sessions NOT claimed by a team lead — the ungrouped tail, ordered. */
  loose: T[]
}

/** Build the team-grouped picker layout: each team (with a mapped lead OR any
 *  teammates) becomes a group; the remaining sessions order as usual below.
 *  No teams → `{ groups: [], loose: orderSessions(sessions) }` (zero regression). */
export function groupedPickerLayout<T extends Orderable>(
  sessions: readonly T[],
  teams: readonly Team[],
): PickerLayout<T> {
  const byName = new Map(sessions.map((s) => [s.name, s]))
  const claimed = new Set<string>()
  const groups: PickerGroup<T>[] = []

  for (const team of teams) {
    const leadName = team.lead_supermux_session
    const lead = leadName ? byName.get(leadName) ?? null : null
    if (lead) claimed.add(lead.name)
    if (!lead && team.members.length === 0) continue
    groups.push({ team, lead, members: team.members })
  }

  const loose = orderSessions(sessions.filter((s) => !claimed.has(s.name)))
  return { groups, loose }
}

// focus-strip-groups.ts — AT-H2.
//
// Make the desktop focus session-strip TEAM-AWARE, consistent with the overview's
// TEAM CARD. The overview groups a detected Agent Team (lead + teammate chips);
// this helper turns the flat `TileSession[]` + the detected `Team[]` into a
// GROUPED strip model:
//   • For each detected team whose lead maps to a live session → one group =
//     a team header + the LEAD row (a real session) then the TEAMMATE rows
//     (NOT sessions — rendered from the team payload).
//   • Every other ("normal") session lists below, ungrouped, exactly as today.
//
// It ALSO returns a flattened ROW list (lead/normal sessions in display order,
// teammates excluded) so ⌘1..9 stays a sensible "jump to the N-th SESSION" — a
// teammate is read-only and not a routable session, so it never claims a number.
//
// SINGLE SOURCE OF TRUTH: it consumes the SAME `sessions` the strip already reads
// (no second fetch) plus the shared `['teams']` cache. When there are NO teams it
// is a pure pass-through (every session is one ungrouped row) → zero regression.

import type { Team, TeamMember } from '@/lib/api/teams'
import type { TileSession } from '@/components/session-tile/types'

/** One row in a team group: the lead (a real session tile) or a teammate. */
export type TeamGroup = {
  team: Team
  /** The lead's session row (from `sessions` by `lead_supermux_session`), or null
   *  when the lead isn't mapped to a live session this tick — the group still
   *  renders its header + teammates so it never looks broken. */
  lead: TileSession | null
  members: TeamMember[]
}

export interface FocusStripModel {
  /** Detected team groups (in `teams` order). */
  groups: TeamGroup[]
  /** Sessions NOT claimed by a team's lead — the ungrouped tail, as today. */
  loose: TileSession[]
  /** Flattened, ⌘1..9-routable SESSION rows in strip order: each group's lead
   *  (when mapped) followed by the loose sessions. Teammates are excluded (they
   *  are read-only, not routable sessions). */
  jumpSessions: TileSession[]
}

/** Build the grouped strip model. A team only forms a group when its
 *  `lead_supermux_session` is present in the live session list (so we never
 *  invent a lead row that the user can't open); an unmapped-lead team still
 *  renders a header + its teammates via `lead: null`, but contributes no jump
 *  target. Sessions consumed as leads are removed from `loose`. */
export function buildFocusStrip(
  sessions: readonly TileSession[],
  teams: readonly Team[],
): FocusStripModel {
  const byName = new Map(sessions.map((s) => [s.name, s]))
  const claimed = new Set<string>()
  const groups: TeamGroup[] = []

  for (const team of teams) {
    const leadName = team.lead_supermux_session
    const lead = leadName ? byName.get(leadName) ?? null : null
    if (lead) claimed.add(lead.name)
    // Skip an utterly empty team (no mapped lead AND no teammates) — there is
    // nothing to render, and showing a bare header would be noise.
    if (!lead && team.members.length === 0) continue
    groups.push({ team, lead, members: team.members })
  }

  const loose = sessions.filter((s) => !claimed.has(s.name))

  const jumpSessions: TileSession[] = []
  for (const g of groups) if (g.lead) jumpSessions.push(g.lead)
  for (const s of loose) jumpSessions.push(s)

  return { groups, loose, jumpSessions }
}

/** A teammate's stable strip key (survives an SSE snapshot replace). */
export function teammateKey(team: Team, member: TeamMember): string {
  return `tm:${team.team_name}/${member.agent_id}`
}

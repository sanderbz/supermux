// focus-strip-groups.ts — AT-H2 + group-aware strip (feat-focus-strip-groups).
//
// Makes the desktop focus session-strip TEAM-AWARE AND GROUP-AWARE, consistent
// with the overview's TEAM CARD and the overview's USER GROUPS.
//
// THE LEGACY HELPER (`buildFocusStrip`) is preserved for completeness; the
// new `buildGroupedFocusStrip` is what the desktop split actually uses.
//
// THE NEW MODEL.
//
//   1. Team detection runs first (same algorithm as before) — a team's lead
//      session is "claimed" so it doesn't double-render as a normal row.
//      Teammates are NOT sessions, so they never appear in any other bucket.
//
//   2. The remaining ("non-team-lead") sessions are then split into USER
//      GROUPS using the SAME overview layout the overview reads via
//      `useOverviewLayout`. The layout walk:
//        • Emit one section per `LayoutItem.group` (in layout order).
//        • Sessions appearing BEFORE the first group header go in an implicit
//          "Ungrouped" bucket at the TOP (mirrors the overview).
//        • Sessions LIVE today but absent from the layout (newly created)
//          surface in the implicit Ungrouped bucket so the user can find them.
//
//   3. Team groups are rendered at the TOP, ABOVE the user groups. We
//      consciously DO NOT try to nest a team group inside whichever user group
//      claims the lead session — a team card is a heavyweight container with
//      its own internal hierarchy (header + lead + teammates) and nesting it
//      inside another container's collapse + sort affordance hurts both at
//      once. Pinning teams at the top mirrors how the overview pins team
//      cards above the grid in every sort mode (`leadSessionNames` excluded
//      from `sessions` in overview.tsx). The user explicitly wanted "the same
//      way/thinking/work method as the overview" — and the overview pins
//      teams above the user groups.
//
//   4. Per-group sort is applied to each user group's session list via
//      `sortSessionsByMode`. The implicit Ungrouped section's sort mode
//      defaults to Smart (same default the overview uses for that bucket).
//      The strip's mode (match-overview vs custom-for-this-strip) is
//      orthogonal to this helper — the caller passes the resolved
//      per-group sort mode for each group.
//
// SINGLE SOURCE OF TRUTH: this helper consumes the SAME `sessions` the strip
// already reads (no second fetch) + the shared `['teams']` cache + the same
// overview layout the overview consumes. With NO teams + NO user groups it
// degrades to a flat ungrouped section — zero regression for first-time users.

import type { Team, TeamMember } from '@/lib/api/teams'
import type { TileSession } from '@/components/session-tile/types'
import {
  defaultGroupSortMode,
  sortSessionsByMode,
  UNGROUPED_GROUP_ID,
  type GroupSortMode,
  type LayoutItem,
} from '@/lib/overview-layout'

// ─────────────────────────────────────────────────────────────────────────────
// Legacy model (kept for back-compat / tests / DEV harness).
// ─────────────────────────────────────────────────────────────────────────────

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

/** Build the FLAT team-aware strip model. This is the original (pre-group)
 *  helper, kept because the legacy `<DesktopSplit>` rendering path still uses
 *  it via the new grouped path's TEAM section (one shared algorithm).
 *
 *  A team only forms a group when its `lead_supermux_session` is present in
 *  the live session list (so we never invent a lead row that the user can't
 *  open); an unmapped-lead team still renders a header + its teammates via
 *  `lead: null`, but contributes no jump target. Sessions consumed as leads
 *  are removed from `loose`. */
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

// ─────────────────────────────────────────────────────────────────────────────
// NEW grouped model — what the desktop strip renders today.
// ─────────────────────────────────────────────────────────────────────────────

/** One user-group section in the strip. Mirrors the overview's `Section` shape
 *  (defined in group-grid.tsx) so the data model + rendering language is
 *  recognisable. */
export interface StripUserGroup {
  /** Stable group id. `UNGROUPED_GROUP_ID` for the implicit Ungrouped bucket. */
  groupId: string
  /** Display name. "Ungrouped" for the implicit bucket. */
  groupName: string
  /** True for the implicit bucket; the renderer can suppress the chrome that
   *  doesn't apply to a system group (no rename — but the strip never renames
   *  anyway). */
  isImplicit: boolean
  /** The resolved per-group sort mode for this group (already factoring in the
   *  strip's match-overview vs custom toggle — caller supplies). */
  sortMode: GroupSortMode
  /** Sessions in this group, already SORTED according to `sortMode`. */
  sessions: TileSession[]
}

/** The full grouped strip model the desktop split renders. */
export interface GroupedFocusStripModel {
  /** Detected team groups — pinned ABOVE the user groups (mirrors how the
   *  overview pins team cards above the grid). */
  teamGroups: TeamGroup[]
  /** User groups (overview-defined, possibly empty) + the implicit "Ungrouped"
   *  bucket (only present when it has at least one session). */
  userGroups: StripUserGroup[]
  /** Flattened ⌘1..9-routable SESSION list in render order. Teammates excluded
   *  (they are read-only, not routable). Order:
   *    1. Each team group's lead (in team order, when the lead is mapped).
   *    2. Each user group's sessions (in user-group order, then per-group sort).
   *  Same contract as the legacy `jumpSessions`. */
  jumpSessions: TileSession[]
}

/** Inputs to `buildGroupedFocusStrip`. */
export interface BuildGroupedFocusStripInput {
  sessions: readonly TileSession[]
  teams: readonly Team[]
  /** The reconciled custom layout — same shape `useOverviewLayout` returns
   *  after `reconcileCustomLayout` is applied. Group order + group membership
   *  flow from THIS list (the strip never invents groups). */
  layoutItems: ReadonlyArray<LayoutItem>
  /** Resolved per-group sort mode for each known group id, INCLUDING the
   *  implicit `UNGROUPED_GROUP_ID`. The caller (the strip's hook) resolves
   *  these via `readStripGroupSortMode` so it knows whether match-overview or
   *  custom mode is in effect — this helper stays pure. */
  resolveSortMode: (groupId: string) => GroupSortMode
}

/** Compute the full grouped strip model.
 *
 *  Pure, memoizable. The caller wraps the strip mode + persisted sort prefs
 *  into `resolveSortMode` so this kernel doesn't touch localStorage. */
export function buildGroupedFocusStrip({
  sessions,
  teams,
  layoutItems,
  resolveSortMode,
}: BuildGroupedFocusStripInput): GroupedFocusStripModel {
  const byName = new Map(sessions.map((s) => [s.name, s]))

  // 1) Team groups + claimed-lead set (so leads don't double-render below).
  const teamGroups: TeamGroup[] = []
  const claimed = new Set<string>()
  for (const team of teams) {
    const leadName = team.lead_supermux_session
    const lead = leadName ? byName.get(leadName) ?? null : null
    if (lead) claimed.add(lead.name)
    if (!lead && team.members.length === 0) continue
    teamGroups.push({ team, lead, members: team.members })
  }

  // 2) Remove team-lead sessions from the pool we feed into user groups; they
  //    already appear inside their team group above.
  const nonLeadSessions = sessions.filter((s) => !claimed.has(s.name))
  const liveNames = new Set(nonLeadSessions.map((s) => s.name))

  // 3) Walk the layout, bucket sessions into user groups in layout order.
  //    Sessions before the first group header land in the implicit Ungrouped
  //    bucket at the TOP (mirrors overview).
  const sectionsInOrder: StripUserGroup[] = []
  let currentBucket: StripUserGroup | null = null
  const placed = new Set<string>()

  for (const item of layoutItems) {
    if (item.type === 'group') {
      currentBucket = {
        groupId: item.id,
        groupName: item.name,
        isImplicit: false,
        sortMode: resolveSortMode(item.id),
        sessions: [],
      }
      sectionsInOrder.push(currentBucket)
    } else {
      if (!liveNames.has(item.name) || placed.has(item.name)) continue
      const session = byName.get(item.name)
      if (!session) continue
      if (!currentBucket) {
        // Floating session above the first group header → implicit Ungrouped
        // bucket. Pinned at the TOP of sectionsInOrder (after we finish the
        // walk, via an unshift below).
        currentBucket = {
          groupId: UNGROUPED_GROUP_ID,
          groupName: 'Ungrouped',
          isImplicit: true,
          sortMode: resolveSortMode(UNGROUPED_GROUP_ID),
          sessions: [],
        }
        sectionsInOrder.unshift(currentBucket)
      }
      currentBucket.sessions.push(session)
      placed.add(session.name)
    }
  }

  // 4) Any LIVE non-lead session that didn't match a layout entry surfaces in
  //    the implicit Ungrouped bucket — newly-created agents should be findable
  //    even before they've been moved into a group on the overview. Match the
  //    overview's behaviour (`reconcileCustomLayout` prepends missing names).
  const missing: TileSession[] = []
  for (const s of nonLeadSessions) {
    if (!placed.has(s.name)) missing.push(s)
  }
  if (missing.length > 0) {
    let ungrouped = sectionsInOrder.find(
      (sec) => sec.groupId === UNGROUPED_GROUP_ID,
    )
    if (!ungrouped) {
      ungrouped = {
        groupId: UNGROUPED_GROUP_ID,
        groupName: 'Ungrouped',
        isImplicit: true,
        sortMode: resolveSortMode(UNGROUPED_GROUP_ID),
        sessions: [],
      }
      sectionsInOrder.unshift(ungrouped)
    }
    // Prepend (not append) so freshly-created agents are at the top of the
    // bucket — same anti-burial rationale the overview applies.
    ungrouped.sessions = [...missing, ...ungrouped.sessions]
  }

  // 5) Apply the per-group sort. The session lists were collected in layout
  //    order — that IS the 'custom' sort for that group; every other mode is
  //    a pure function of the sessions' fields. The `TileSession` shape is a
  //    superset of `ApiSession` for sort purposes (sortSessionsByMode reads
  //    name / status / pinned / running / last_activity / created_at /
  //    updated_at — all present on TileSession).
  const userGroups = sectionsInOrder.map((sec) => {
    if (sec.sortMode === 'custom') return sec
    const sorted = sortSessionsByMode(
      sec.sortMode,
      sec.sessions,
    ) as TileSession[]
    return { ...sec, sessions: sorted }
  })

  // 6) Drop empty user groups EXCEPT keep them when the user explicitly
  //    defined them on the overview (non-implicit). An empty user-defined
  //    group still appears in the strip so the user can SEE that the group
  //    exists (and the count chip reads 0) — mirrors the overview, which
  //    also shows zero-count groups. Implicit Ungrouped IS dropped when
  //    empty because it's a system bucket and showing a "0" placeholder
  //    above a non-empty list would be noise.
  const finalUserGroups = userGroups.filter(
    (sec) => !sec.isImplicit || sec.sessions.length > 0,
  )

  // 7) Build the jump list (⌘1..9). Teams first (their leads), then each user
  //    group's sessions in render order. Teammates excluded (read-only).
  const jumpSessions: TileSession[] = []
  for (const g of teamGroups) if (g.lead) jumpSessions.push(g.lead)
  for (const sec of finalUserGroups) {
    for (const s of sec.sessions) jumpSessions.push(s)
  }

  return { teamGroups, userGroups: finalUserGroups, jumpSessions }
}

/** Convenience: the list of group ids the strip currently knows about (for
 *  ⌘-shortcut announcements, VR hooks, debug). The implicit Ungrouped id is
 *  included when the bucket has any sessions. */
export function stripGroupIds(model: GroupedFocusStripModel): string[] {
  return model.userGroups.map((g) => g.groupId)
}

/** Default per-group sort mode for the strip's "first time in custom mode"
 *  fall-through. Mirrors the overview's `defaultGroupSortMode` so flipping
 *  match-overview → custom for the first time doesn't snap every group to
 *  Smart. Caller normally uses `readStripGroupSortMode` (which already falls
 *  back to the overview's stored mode); this is exported for tests. */
export function stripDefaultGroupSortMode(groupId: string): GroupSortMode {
  return defaultGroupSortMode(groupId)
}

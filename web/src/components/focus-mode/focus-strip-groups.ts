// focus-strip-groups.ts — team-aware + group-aware strip.
//
// Makes the desktop focus session-strip TEAM-AWARE AND GROUP-AWARE, consistent
// with the overview's TEAM CARD and the overview's USER GROUPS.
//
// THE MODEL.
//
//   1. Team detection runs first — a team's lead session is "claimed" so it
//      doesn't double-render as a normal row. Teammates are NOT sessions, so
//      they never appear in any other bucket. The "lead consumed by team"
//      contract is shared with the overview via `splitTeamLeads`.
//
//   2. The remaining ("non-team-lead") sessions are then split into USER
//      GROUPS using the SAME overview layout the overview reads via
//      `useOverviewLayout`. The layout walk is the shared
//      `bucketSessionsByLayout` kernel; the strip's enrichment (per-group
//      sort + implicit-bucket prune + missing-session top-up) layers on top.
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
  bucketSessionsByLayout,
  sortSessionsByMode,
  UNGROUPED_GROUP_ID,
  type GroupSortMode,
  type LayoutItem,
} from '@/lib/overview-layout'

/** One row in a team group: the lead (a real session tile) or a teammate. */
export type TeamGroup = {
  team: Team
  /** The lead's session row (from `sessions` by `lead_supermux_session`), or null
   *  when the lead isn't mapped to a live session this tick — the group still
   *  renders its header + teammates so it never looks broken. */
  lead: TileSession | null
  members: TeamMember[]
}

/** A teammate's stable strip key (survives an SSE snapshot replace). */
export function teammateKey(team: Team, member: TeamMember): string {
  return `tm:${team.team_name}/${member.agent_id}`
}

/**
 * Split sessions into "session is a team lead → consumed by its team group"
 * vs "session belongs to the regular pool". Single source of the team-pinning
 * contract used by every surface that renders sessions next to teams (overview
 * grid, focus strip, and any future surface).
 *
 * Generic over the session shape so the overview can pass `ApiSession` and the
 * focus strip can pass its `TileSession` superset; only `.name` is read.
 */
export function splitTeamLeads<S extends { name: string }>(
  sessions: readonly S[],
  teams: readonly Team[],
): { teamLeadNames: Set<string>; nonLeadSessions: S[] } {
  const teamLeadNames = new Set<string>()
  for (const t of teams) {
    if (t.lead_supermux_session) teamLeadNames.add(t.lead_supermux_session)
  }
  return {
    teamLeadNames,
    nonLeadSessions: sessions.filter((s) => !teamLeadNames.has(s.name)),
  }
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
  /** Per-group "hide stopped sessions" filter, INCLUDING the implicit
   *  `UNGROUPED_GROUP_ID`. Default (caller returns false) = no filter, all
   *  sessions render. When true, stopped sessions are filtered BEFORE the
   *  sort applies so the count chip on the section header reflects what's
   *  actually visible. Pure pass-through if the caller returns false for
   *  every group. */
  resolveHideStopped?: (groupId: string) => boolean
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
  resolveHideStopped,
}: BuildGroupedFocusStripInput): GroupedFocusStripModel {
  const hideStoppedFor =
    resolveHideStopped ?? ((_id: string) => false)
  // 1) Detect team groups + split the session pool. The `splitTeamLeads`
  //    helper is the shared "team lead consumed by team group" contract used
  //    by the overview too. We separately build the `teamGroups` array (with
  //    lead row + members + empty-team prune) — that shape is strip-specific.
  const byName = new Map(sessions.map((s) => [s.name, s]))
  const teamGroups: TeamGroup[] = []
  for (const team of teams) {
    const leadName = team.lead_supermux_session
    const lead = leadName ? byName.get(leadName) ?? null : null
    if (!lead && team.members.length === 0) continue
    teamGroups.push({ team, lead, members: team.members })
  }
  const { nonLeadSessions } = splitTeamLeads(sessions, teams)

  // 2) Walk the layout via the shared `bucketSessionsByLayout` kernel — same
  //    walk the overview's `buildSections` uses. The kernel always returns
  //    the implicit Ungrouped bucket at position 0 (we filter it later when
  //    empty); per-group sort + the implicit bucket's strip-specific
  //    metadata (UNGROUPED_GROUP_ID / "Ungrouped" / sortMode) is enriched
  //    here so the kernel stays surface-agnostic.
  const rawBuckets = bucketSessionsByLayout(layoutItems, nonLeadSessions)
  const sectionsInOrder: StripUserGroup[] = rawBuckets.map((b) =>
    b.isImplicit
      ? {
          groupId: UNGROUPED_GROUP_ID,
          groupName: 'Ungrouped',
          isImplicit: true,
          sortMode: resolveSortMode(UNGROUPED_GROUP_ID),
          sessions: b.sessions,
        }
      : {
          groupId: b.groupId,
          groupName: b.groupName,
          isImplicit: false,
          sortMode: resolveSortMode(b.groupId),
          sessions: b.sessions,
        },
  )

  // 3) Any LIVE non-lead session that didn't match a layout entry surfaces in
  //    the implicit Ungrouped bucket — newly-created agents should be findable
  //    even before they've been moved into a group on the overview. Match the
  //    overview's behaviour (`reconcileCustomLayout` prepends missing names).
  //    In practice reconcile already covers this; the defensive top-up is kept
  //    so this kernel is correct even if a caller skips reconcile.
  const placed = new Set<string>()
  for (const sec of sectionsInOrder) {
    for (const s of sec.sessions) placed.add(s.name)
  }
  const missing: TileSession[] = []
  for (const s of nonLeadSessions) {
    if (!placed.has(s.name)) missing.push(s)
  }
  if (missing.length > 0) {
    // sectionsInOrder[0] is the implicit bucket by construction (the kernel
    // always returns it at position 0). Prepend the missing sessions so
    // freshly-created agents are at the TOP of the bucket — same
    // anti-burial rationale the overview applies.
    const implicit = sectionsInOrder[0]
    implicit.sessions = [...missing, ...implicit.sessions]
  }

  // 4) Apply the per-group filter THEN sort. The session lists were collected
  //    in layout order — that IS the 'custom' sort for that group; every other
  //    mode is a pure function of the sessions' fields. The `TileSession` shape
  //    is a superset of `ApiSession` for sort purposes (sortSessionsByMode
  //    reads name / status / pinned / running / last_activity / created_at /
  //    updated_at — all present on TileSession).
  //
  //    Filter BEFORE sort so the count chip + the rendered list agree and so
  //    the sort kernel never wastes a comparison on a row that's about to be
  //    dropped.
  const userGroups = sectionsInOrder.map((sec) => {
    const filtered = hideStoppedFor(sec.groupId)
      ? sec.sessions.filter((s) => s.status !== 'stopped')
      : sec.sessions
    if (sec.sortMode === 'custom') {
      return filtered === sec.sessions ? sec : { ...sec, sessions: filtered }
    }
    const sorted = sortSessionsByMode(sec.sortMode, filtered) as TileSession[]
    return { ...sec, sessions: sorted }
  })

  // 5) Drop the implicit Ungrouped bucket when empty (the kernel always
  //    returns it; the strip is the surface that prunes it). Non-implicit
  //    (user-defined) groups stay even when empty so the user can SEE the
  //    group exists with a count chip of 0 — mirrors the overview.
  const finalUserGroups = userGroups.filter(
    (sec) => !sec.isImplicit || sec.sessions.length > 0,
  )

  // 6) Build the jump list (⌘1..9). Teams first (their leads), then each user
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
export function stripDefaultGroupSortMode(_groupId: string): GroupSortMode {
  // The strip defaults EVERY group to Smart, including user-defined ones —
  // unlike the overview where user groups default to 'custom' (= the drag
  // order). On a 320 px sidebar with no drag affordance, 'custom' read as
  // "the chip does nothing" because every mode collapsed to the same layout
  // order until a user dragged on the overview. Smart is visibly responsive:
  // pinned/active first, then by recency. Users get instant feedback.
  return 'smart'
}

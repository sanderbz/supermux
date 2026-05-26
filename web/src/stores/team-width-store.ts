// Per-team TEAM CARD width preference (FEAT-RESIZE).
//
// On desktop, the overview lays TEAM CARDs out in a flex-wrap row. By default
// each card takes the full row (current behavior — zero regression for users
// with one team). When the user has several teams, a single full-width card
// per row reads as too dominant, so the TEAM CARD header carries a per-team
// segmented width control letting them pick from a small discrete set —
// Compact / Standard / Wide / Full — and cards then flow side-by-side based
// on those widths.
//
// On mobile (< sm) the toggle is hidden and the card is always full-width:
// the viewport is too narrow for any tier other than Full to read well.
//
// Persisted per team_name via Zustand + `persist`, mirroring the EXACT pattern
// used by `team-density-store.ts` so the two per-team prefs read as one
// pattern. Default is `'full'` so the overview looks identical to today until
// the user opts in.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** The four discrete width tiers. Centralised so the control + the layout
 *  apply the same set without drifting. */
export type TeamWidth = 'compact' | 'standard' | 'wide' | 'full'

/** Ordered for the segmented control (left → right = narrow → wide). */
export const TEAM_WIDTH_ORDER: readonly TeamWidth[] = [
  'compact',
  'standard',
  'wide',
  'full',
] as const

/** Zero-regression default — current overview behaviour: one card per row. */
export const DEFAULT_TEAM_WIDTH: TeamWidth = 'full'

/** Concrete pixel ceilings per tier. Picked so:
 *  - Compact (~360px): two cards fit side-by-side at the typical 768px tablet
 *    width, three at a 1280px desktop, four at a wide ~1680px display.
 *  - Standard (~520px): two cards fit at most desktop widths; the lead tile
 *    inside still reads comfortably at the smaller density tiers.
 *  - Wide (~760px): one Wide + one Compact pair side-by-side on a 1280px
 *    monitor; two Wides on an ultra-wide.
 *  - Full: the card consumes the whole row (current behaviour). */
export const TEAM_WIDTH_PX: Record<Exclude<TeamWidth, 'full'>, number> = {
  compact: 360,
  standard: 520,
  wide: 760,
}

/** Human label for the segmented control + tooltip. Sentence-case per the
 *  app's anti-vision rules. */
export const TEAM_WIDTH_LABEL: Record<TeamWidth, string> = {
  compact: 'Compact',
  standard: 'Standard',
  wide: 'Wide',
  full: 'Full',
}

interface TeamWidthState {
  /** Map of team_name → chosen width. Absent ⇒ DEFAULT_TEAM_WIDTH. */
  byTeam: Record<string, TeamWidth>
  setWidth: (team: string, width: TeamWidth) => void
}

export const useTeamWidthStore = create<TeamWidthState>()(
  persist(
    (set) => ({
      byTeam: {},
      setWidth: (team, width) =>
        set((s) => ({ byTeam: { ...s.byTeam, [team]: width } })),
    }),
    { name: 'supermux:team-width' },
  ),
)

/** Read the persisted width for one team (defaulting to Full) + a setter. A
 *  thin selector hook so a TEAM CARD subscribes only to ITS team's value —
 *  mirrors `useTeamDensity`. */
export function useTeamWidth(
  team: string,
): [TeamWidth, (w: TeamWidth) => void] {
  const width = useTeamWidthStore((s) => s.byTeam[team] ?? DEFAULT_TEAM_WIDTH)
  const setWidth = useTeamWidthStore((s) => s.setWidth)
  return [width, (w) => setWidth(team, w)]
}

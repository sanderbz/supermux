// Per-team Chips↔Cards density preference.
//
// The TEAM CARD header carries a per-team segmented control toggling how
// teammates render below the lead tile: compact 44pt CHIPS (the default, the
// user's "½-size, status-only until peek" idea) or richer CARDS (a mini live
// terminal each, like the desktop session tile). This is DELIBERATELY a per-team
// choice, NOT the global SortControl/SizeControl — those are app-wide and would
// wrongly imply resizing every tile.
//
// Zustand + `persist` → localStorage, so each team's choice survives a browser
// restart, keyed by team_name (matching the ui-store pattern in this app).

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type TeamDensity = 'chips' | 'cards'

/** The product default: Chips ("v1 default = Chips"). */
export const DEFAULT_TEAM_DENSITY: TeamDensity = 'chips'

interface TeamDensityState {
  /** Map of team_name → chosen density. Absent ⇒ DEFAULT_TEAM_DENSITY. */
  byTeam: Record<string, TeamDensity>
  setDensity: (team: string, density: TeamDensity) => void
}

export const useTeamDensityStore = create<TeamDensityState>()(
  persist(
    (set) => ({
      byTeam: {},
      setDensity: (team, density) =>
        set((s) => ({ byTeam: { ...s.byTeam, [team]: density } })),
    }),
    { name: 'supermux:team-density' },
  ),
)

/** Read the persisted density for one team (defaulting to Chips) + a setter. A
 *  thin selector hook so a TEAM CARD subscribes only to ITS team's value. */
export function useTeamDensity(
  team: string,
): [TeamDensity, (d: TeamDensity) => void] {
  const density = useTeamDensityStore(
    (s) => s.byTeam[team] ?? DEFAULT_TEAM_DENSITY,
  )
  const setDensity = useTeamDensityStore((s) => s.setDensity)
  return [density, (d) => setDensity(team, d)]
}

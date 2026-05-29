// TeamRollupBadges — the shared attention-first roll-up badges.
//
// ONE loud token when present (the blue `needs you · N` pill in the tile
// waiting-pill geometry) ELSE a calm green "done"; followed by a muted, tabular
// secondary (`N agents · X/Y tasks`). This is the SINGLE source of truth for the
// roll-up markup, consumed by BOTH the overview TEAM CARD (`density="card"`) and
// the focus session-strip group header (`density="strip"`) so the two never
// drift. The only difference between the two sites is sizing/spacing tokens,
// selected by the `density` prop — the structure + semantics are identical.

import { needsYouCount, taskProgress, type Team } from '@/lib/api/teams'

/** The two consumption sites. Each selects the size/gap tokens that match its
 *  host (the overview card vs the 320px focus strip) while keeping the exact
 *  same markup + semantics. */
export type TeamRollupDensity = 'card' | 'strip'

/** Per-density token map. `card` mirrors the overview TeamCard header (a `done`
 *  pill that can fall after the lead chip, a secondary hidden below `sm`); `strip`
 *  mirrors the compact focus-strip header (always-visible terse secondary). */
const TOKENS: Record<
  TeamRollupDensity,
  {
    /** Trailing-edge secondary container classes. */
    secondary: string
    /** Whether the secondary spells out the `tasks` suffix (card) or is terse
     *  (strip uses `· X/Y`). */
    spellTasks: boolean
  }
> = {
  card: {
    secondary:
      'ml-auto hidden shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground/70 sm:flex',
    spellTasks: true,
  },
  strip: {
    secondary:
      'ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70',
    spellTasks: false,
  },
}

/** The shared roll-up badges: the PRIMARY attention token (needs-you blue pill
 *  ELSE green "done") + the muted secondary (`N agents · X/Y tasks`). Render
 *  inside the host's `<header>` so its flex layout (team name, lead chip,
 *  density toggle) wraps these consistently at each site.
 *
 *  `hideSecondary` lets the host force-drop the muted secondary regardless of
 *  the viewport-gated default (TOKENS.card.secondary uses `hidden sm:flex` for
 *  the screen-width breakpoint; the team-card uses this prop instead for its
 *  own CARD-width breakpoint, so a Compact-width team card on a wide desktop
 *  still drops the secondary). */
export function TeamRollupBadges({
  team,
  density,
  hideSecondary = false,
}: {
  team: Team
  density: TeamRollupDensity
  hideSecondary?: boolean
}) {
  const needs = needsYouCount(team)
  const { done, total } = taskProgress(team)
  const agentCount = team.members.length
  const t = TOKENS[density]

  return (
    <>
      {/* PRIMARY attention token. */}
      {needs > 0 ? (
        <span className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
          needs you · {needs}
        </span>
      ) : (
        <span className="shrink-0 rounded-full bg-status-ready/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-ready">
          done
        </span>
      )}

      {/* SECONDARY, muted, tabular. Suppressed when the host wants it gone
          (Compact-width team card — header chrome won't fit). */}
      {!hideSecondary && (t.spellTasks ? (
        <span className={t.secondary}>
          {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
          {total > 0 && (
            <>
              <span aria-hidden>·</span>
              {done}/{total} tasks
            </>
          )}
        </span>
      ) : (
        <span className={t.secondary}>
          {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
          {total > 0 && ` · ${done}/${total}`}
        </span>
      ))}
    </>
  )
}

// TeamCrewChip — the persistent crew signal on a LEAD's thread header.
//
// ── Why it exists ────────────────────────────────────────────────────────────
// A team lead's conversation IS the team's thread (OD-1 = A, "talk to the
// lead"). Opened, that thread reused the plain bot chrome, so the only team
// affordance was a lone unlabelled people icon — a first-time viewer could not
// tell "lead + a 5-bot crew" from "one bot" (design jury R1, TEAM_THREAD 82,
// the one sub-83 axis). This chip is the fix: a small pile of the teammates'
// faces with their LIVE status, a `N bots` count, and a needs/working glance,
// all in one tap target that opens the crew panel. It replaces the bare icon,
// so the header now SAYS crew.
//
// ── Where it lives ───────────────────────────────────────────────────────────
// Injected into `ChatPanel`'s `headerTrailing` slot by the two team surfaces
// that mount a lead thread — the desktop grok roster pane and the phone `/team`
// route. It never renders on a non-team thread (those callers pass their own
// trailing), so the shared header pill and the base app stay byte-identical:
// this is team code, in the lazy team paths, drawing only when a crew is behind
// the thread.
//
// ── Kept dependency-light on purpose ─────────────────────────────────────────
// The pile is drawn from `SessionMark` directly with inline overlap — NOT the
// `Facepile` wrapper and NOT `.gr-pile` (which is scoped to `.grok-roster` and
// so does not reach the phone route's full-screen thread). Its imports are all
// already in the roster's graph (SessionMark, cn, the teams model), so it costs
// the 295 KB app gate only its own handful of lines. Each face carries its own
// state (working / idle / offline) and the needs-you halo, so the pile reads the
// crew's live attention, matching the roster row it was opened from.

import { cn } from '@/lib/utils'
import { SessionMark, type MarkState } from '@/brand/marks'
import { needsYouCount, type MemberStatus, type Team } from '@/lib/api/teams'

/** Teammate status → mark face. The same reading the teammate rows use
 *  (`member-status-dot` maps to the session vocabulary, `mark-status` to the
 *  face): working is heads-down, needs_you rests calm while the halo shouts,
 *  idle is the ready disc, offline is the stopped grey. Inlined (not imported)
 *  so the chip pulls no extra module into the app chunk. */
const FACE: Record<MemberStatus, MarkState> = {
  working: 'working',
  needs_you: 'waiting',
  idle: 'idle',
  offline: 'stopped',
}

/** The crew's live one-word glance, in priority order: waiting-on-you wins, then
 *  working, then calm. Mirrors the roster row's L2 state word so the two never
 *  disagree about the same crew. */
function crewGlance(team: Team): { text: string; hot: boolean } | null {
  const needs = needsYouCount(team)
  if (needs > 0) return { text: `${needs} needs you`, hot: true }
  const working = team.members.filter((m) => m.status === 'working').length
  if (working > 0) return { text: `${working} working`, hot: false }
  return null
}

export interface TeamCrewChipProps {
  team: Team
  /** Open the crew — the desktop pane's TeamPanel toggle, or the phone sheet. */
  onOpen: () => void
  /** VR hook the e2e roster spec drives (`pane-team-toggle` on desktop). */
  vr?: string
  className?: string
}

/** The lead thread's crew rail, as one tap target. Faces + `N bots` + a live
 *  glance; click opens the crew. */
export function TeamCrewChip({ team, onOpen, vr, className }: TeamCrewChipProps) {
  const faces = team.members.slice(0, 4)
  const count = team.members.length
  const word = count === 1 ? 'bot' : 'bots'
  const glance = crewGlance(team)

  return (
    <button
      type="button"
      onClick={onOpen}
      data-vr={vr}
      data-team-crew-chip=""
      aria-label={`Crew — ${count} ${word}${glance ? `, ${glance.text}` : ''}`}
      title="Crew"
      className={cn(
        'inline-flex shrink-0 items-center gap-2 rounded-full border-[0.5px] border-hairline py-1 pl-1.5 pr-3',
        'text-ink-2 transition-colors hover:bg-fill-soft hover:text-ink',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {faces.length > 0 && (
        // Inline overlap — each face keylined in the pane's own ground so the
        // stack stays readable instead of fusing into one lumpy pigment.
        <span aria-hidden className="flex shrink-0 items-center">
          {faces.map((m, i) => (
            <span key={m.agent_id} style={{ marginLeft: i === 0 ? 0 : -6, zIndex: i + 1 }}>
              <SessionMark
                seed={m.name}
                size={22}
                ring="var(--gr-bg)"
                animate={false}
                label={null}
                state={FACE[m.status]}
                attention={m.status === 'needs_you' ? 'needs' : null}
              />
            </span>
          ))}
        </span>
      )}
      <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap text-[12.5px] leading-none">
        <span className="font-semibold text-ink">
          {count} {word}
        </span>
        {glance && (
          <span
            className={cn(
              'hidden font-medium sm:inline',
              glance.hot ? 'text-[color:var(--gr-need)]' : 'text-ink-3',
            )}
          >
            · {glance.text}
          </span>
        )}
      </span>
    </button>
  )
}

export default TeamCrewChip

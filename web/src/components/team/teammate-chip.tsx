// TeammateChip — one teammate as a compact 44pt glass row inside the TEAM CARD.
// The default density (Chips) renders teammates as these rows below the lead tile.
//
// ANATOMY (design critic):
//   • h-11 (44pt) glass row, rounded-[10px], with a 2px LEFT COLOUR RAIL =
//     member.color (identity) — distinct from the status dot (state). Both legible.
//   • LEADING: <MemberStatusDot> — amber spinner (working), STATIC blue disc
//     (needs_you; the loud blue is the trailing pill, not the dot), green (idle),
//     dim (offline).
//   • BODY: name (text-sm font-medium, truncate) + live <ActivityLine> (reused
//     from activity-status.tsx) inline/under it, muted + truncating.
//   • TRAILING (tabular): a `needs you` pill (tile waiting-pill geometry) when
//     needs_you — THE ONLY loud element — ELSE a muted task-count (`2/3`).
//
// GESTURES:
//   • Tap → navigate to the teammate's focus page (the lead's focus route with
//     `?teammate=<agent_id>` so the focus view auto-selects this teammate).
//     There is no in-overview peek half-sheet anymore — the focus page IS the
//     single teammate-view surface across desktop + mobile (one source of truth,
//     no sync drift).

import { cn } from '@/lib/utils'
import { ActivityLine } from '@/components/session-tile/activity-status'
import { MemberStatusDot } from './member-status-dot'
import { tasksForMember, type Team, type TeamMember } from '@/lib/api/teams'

const TASK_DONE = 'completed'

export interface TeammateChipProps {
  team: Team
  member: TeamMember
  /** Live "what this teammate is doing now" label (optional — not yet carried
   *  in the team model; threaded for forward-compat). */
  activity?: string
  /** Tap → navigate to this teammate's focus page. */
  onFocus: () => void
}

export function TeammateChip({
  team,
  member,
  activity,
  onFocus,
}: TeammateChipProps) {
  const needsYou = member.status === 'needs_you'
  const memberTasks = tasksForMember(team, member)
  const taskTotal = memberTasks.length
  const taskDone = memberTasks.filter((t) => t.status === TASK_DONE).length

  const rail = member.color || 'hsl(var(--status-idle))'

  return (
    <div
      // The row is the tap target → focus page. No long-press / no peek — the
      // focus page is the single teammate-view surface.
      className={cn(
        'group/chip relative flex h-11 items-center gap-2.5 overflow-hidden rounded-[10px] border border-border/60 bg-card/60 pl-3 pr-3',
        'cursor-pointer select-none transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // A calm tint when needs_you — the row itself reads as "attention here"
        // without an alarmist fill; the pill is the loud token.
        needsYou && 'bg-status-waiting/[0.06]',
      )}
      role="button"
      tabIndex={0}
      aria-label={`Open ${member.name}${needsYou ? ', needs you' : ''} full screen`}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onFocus()
        }
      }}
    >
      {/* 2px left colour rail = identity colour. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-[2px]"
        style={{ backgroundColor: rail }}
      />

      {/* Leading status dot. */}
      <MemberStatusDot status={member.status} className="ml-0.5" />

      {/* Body: name (line 1) + live activity (line 2 / inline). min-w-0 so it
          truncates first and never pushes the trailing column. */}
      <div className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
        <span className="truncate text-sm font-medium">{member.name}</span>
        {activity ? (
          <ActivityLine activity={activity} className="text-xs" />
        ) : (
          <span className="truncate text-xs text-muted-foreground/70">
            {member.model || 'teammate'}
          </span>
        )}
      </div>

      {/* Trailing (tabular). needs_you → the ONE loud blue pill (tile waiting-pill
          geometry). Else → muted task-count. */}
      <div className="flex shrink-0 items-center gap-1">
        {needsYou ? (
          <span className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
            needs you
          </span>
        ) : (
          taskTotal > 0 && (
            <span className="shrink-0 px-1 text-[11px] font-medium tabular-nums text-muted-foreground/70">
              {taskDone}/{taskTotal}
            </span>
          )
        )}
      </div>
    </div>
  )
}

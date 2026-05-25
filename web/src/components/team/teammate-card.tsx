// TeammateCard — the CARDS density variant of a teammate (AT-F-FRONT / F5).
//
// When a TEAM CARD's per-team density toggle is set to Cards, teammates render as
// these richer cards (vs the compact 44pt chips) — each with a mini read-only
// LIVE terminal, mirroring the desktop session tile's at-a-glance live preview.
// The header carries the same identity (colour rail), status dot, name, and the
// attention-first trailing token (the loud `needs you` pill or muted task-count).
//
// Tap the header → focus full-screen. The mini terminal is read-only and streams
// only while the card is mounted (the WS tears down on unmount). When there's no
// live pane this tick (offline / null %id) the card shows a calm placeholder
// instead of a failing stream.

import { cn } from '@/lib/utils'
import { MemberStatusDot } from './member-status-dot'
import { ActivityLine } from '@/components/session-tile/activity-status'
import { TeammateTerminal } from '@/components/terminal/teammate-terminal'
import { tasksForMember, type Team, type TeamMember } from '@/lib/api/teams'

const TASK_DONE = 'completed'

export interface TeammateCardProps {
  team: Team
  member: TeamMember
  activity?: string
  /** Tap the header → focus this teammate full-screen. */
  onFocus: () => void
}

export function TeammateCard({
  team,
  member,
  activity,
  onFocus,
}: TeammateCardProps) {
  const needsYou = member.status === 'needs_you'
  const gone = member.status === 'offline' || !member.tmux_pane_id
  const memberTasks = tasksForMember(team, member)
  const taskTotal = memberTasks.length
  const taskDone = memberTasks.filter((t) => t.status === TASK_DONE).length
  const rail = member.color || 'hsl(var(--status-idle))'

  return (
    <div
      className={cn(
        'relative flex flex-col overflow-hidden rounded-xl border border-border bg-card',
        needsYou && 'ring-1 ring-status-waiting/30',
      )}
    >
      {/* 2px left colour rail = identity colour. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[2px]"
        style={{ backgroundColor: rail }}
      />

      {/* Header — tap to focus. */}
      <button
        type="button"
        onClick={onFocus}
        aria-label={`Open ${member.name}${needsYou ? ', needs you' : ''}`}
        className="flex items-start gap-2 px-3 pl-3.5 pt-2.5 pb-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <MemberStatusDot status={member.status} className="mt-0.5" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium">{member.name}</div>
          {activity ? (
            <ActivityLine activity={activity} className="text-xs" />
          ) : (
            <div className="truncate text-xs text-muted-foreground/70">
              {member.model || 'teammate'}
            </div>
          )}
        </div>
        {needsYou ? (
          <span className="mt-0.5 shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
            needs you
          </span>
        ) : (
          taskTotal > 0 && (
            <span className="mt-0.5 shrink-0 px-1 text-[11px] font-medium tabular-nums text-muted-foreground/70">
              {taskDone}/{taskTotal}
            </span>
          )
        )}
      </button>

      {/* Mini read-only live terminal — the at-a-glance live preview, like the
          desktop session tile. Fixed height so the card grid stays tidy. */}
      <div
        className="relative mx-2 mb-2 h-32 overflow-hidden rounded-lg"
        style={{ backgroundColor: 'var(--terminal-bg)' }}
      >
        {gone ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {member.status === 'offline'
              ? 'Offline — no live terminal'
              : 'No live pane right now'}
          </div>
        ) : (
          <div className="absolute inset-0">
            <TeammateTerminal
              key={`${team.team_name}/${member.name}/${member.tmux_pane_id}`}
              team={team.team_name}
              member={member.name}
              paneId={member.tmux_pane_id}
              className="rounded-none"
              // Slightly larger font so the shrunk pane stays legible (mirrors the
              // overview hover-zoom embed's approach).
              fontSize={11}
            />
          </div>
        )}
      </div>
    </div>
  )
}

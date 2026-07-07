// TeammateCard — the CARDS density variant of a teammate.
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
import { KillTeammateButton } from './kill-teammate-button'
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
  // Only gate on pane absence (not status). Claude flips teammates to
  // isActive:false the moment their turn ends, but the tmux pane keeps
  // streaming — show whatever's in the pane while it's alive.
  const gone = !member.tmux_pane_id
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

      {/* Header — the identity block is the tap-to-focus target; the trailing
          token + kill-pane trash sit BESIDE it (a button can't nest a button,
          and the trash must never trigger a navigation). */}
      <div className="flex items-start gap-2 px-3 pl-3.5 pt-2.5 pb-1.5">
        <button
          type="button"
          onClick={onFocus}
          aria-label={`Open ${member.name}${needsYou ? ', needs you' : ''}`}
          className="flex min-w-0 flex-1 items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
        </button>
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
        {/* Kill-pane trash (manual Agent Teams cleanup — renders nothing when
            there's no live pane). */}
        <KillTeammateButton team={team} member={member} className="-mt-0.5" />
      </div>

      {/* Mini read-only live terminal — the at-a-glance live preview, like the
          desktop session tile. Fixed height so the card grid stays tidy.
          PEEK-DIMENSION FIX (peek-diff-audit.md, Variant D root cause).
          `min-w-[160px]` is a width FLOOR for the xterm container: without it,
          when the team card hosts these two-up in `sm:grid-cols-2`, the grid's
          flex-distribution can briefly hand a cell 0–5 px width DURING the very
          first paint — exactly when `useLiveTerm`'s mount-rAF runs `fit()`. A
          0-width container makes FitAddon compute `cols=0`, which trips the
          `if (term.cols <= 0) return` guard at `use-live-term.ts:643` and
          PERMANENTLY skips the WebGL renderer attach (the ResizeObserver later
          re-fits but NEVER re-attempts `loadAddon(new WebglAddon())`). The
          terminal then ends up stuck on the DOM renderer at the wrong cell
          metrics with no second-fit correction, producing the catastrophic
          mis-render the user reported as "klopt HELEMAAL van geen kanten" —
          1000x more broken than the normal session peek. A 160 px floor
          guarantees ≥24 cols at fontSize=11 (cellWidth ≈ 6.6 px), which is
          well above the fit guard's threshold, so the mount-rAF always lands
          a real WebGL attach AND a real second fit. On the natural sm: layout
          the grid cell is already ≥250 px so this floor is a no-op there too. */}
      <div
        className="relative mx-2 mb-2 h-32 min-w-[160px] overflow-hidden rounded-lg"
        style={{ backgroundColor: 'var(--terminal-bg)' }}
      >
        {gone ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            No live pane right now
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

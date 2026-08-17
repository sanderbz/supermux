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

import * as React from 'react'

import { cn } from '@/lib/utils'
import { useRovingItem } from '@/hooks/use-roving'
import { ActivityLine } from '@/components/session-tile/activity-status'
import { MemberStatusDot } from './member-status-dot'
import { KillTeammateButton } from './kill-teammate-button'
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
  const roving = useRovingItem(member.agent_id)
  // Pulled out of the object before the JSX: the lint's ref rule reads
  // `roving.ref` on a `ref=` prop plus a sibling property access as "a ref read
  // during render". These are a stable callback set, not a ref value.
  const rovingRef = roving.ref
  // Handed to `ref=` through a callback, the way `<SessionTile>` already does:
  // passing the roving handle straight into a JSX `ref` prop makes the compiler
  // lint read every sibling property of the same object as a ref access.
  const setChipRef = React.useCallback(
    (el: HTMLButtonElement | null) => rovingRef(el),
    [rovingRef],
  )

  return (
    <div
      // The row is the tap target → focus page, but the ROW ITSELF is not the
      // control: it carries a trash button, and a focusable <button> inside a
      // role="button" tabIndex=0 wrapper is axe's `nested-interactive` (serious)
      // — a screen reader announces one control and finds two, and the inner one
      // is unreachable by the role's own semantics. The activation lives on a
      // stretched overlay <button> below instead, with the trash as its SIBLING.
      className={cn(
        'group/chip relative flex h-11 items-center gap-2.5 overflow-hidden rounded-[10px] border border-border/60 bg-card/60 pl-3 pr-3',
        'cursor-pointer select-none transition-colors hover:bg-card',
        // A calm tint when needs_you — the row itself reads as "attention here"
        // without an alarmist fill; the pill is the loud token.
        needsYou && 'bg-status-waiting/[0.06]',
      )}
    >
      {/* 2px left colour rail = identity colour. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-[2px]"
        style={{ backgroundColor: rail }}
      />

      {/* THE control: a real <button> stretched over the row. Above the passive
          content (z-10) so a tap anywhere lands on it, below the trailing
          controls (z-20) so the trash still wins its own 44pt. It draws the
          row's focus ring, so keyboard focus looks exactly as it did.

          IT IS ALSO THE ROVING ITEM. The two fixes that met here want the same
          element: the roster needs ONE tab stop per row with arrows moving
          between them (finding 20), and the row must not be a control wrapping
          a control (finding 14). A real <button> is both — it is a legitimate
          roving item, and unlike `div role="button" tabIndex=0` it does not
          swallow the trash beside it. Enter/Space are native here, so the
          hand-rolled activation branch is gone; the roving handler still runs
          FIRST and consumes only arrows/Home/End. */}
      <button
        type="button"
        className="absolute inset-0 z-10 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        aria-label={`Open ${member.name}${needsYou ? ', needs you' : ''} full screen`}
        // ROVING TABINDEX (finding 20). The team's agents were the one roster of
        // colleagues with no roving list: six chips, six tab stops, arrows dead
        // — in every view mode, because the card renders above the grid and the
        // overview's provider has never reached it. Outside a provider (a bench)
        // `tabIndex` is `undefined` and the literal 0 applies, exactly as before.
        tabIndex={roving.tabIndex ?? 0}
        data-roving-item={member.agent_id}
        ref={setChipRef}
        onFocus={roving.onFocus}
        onKeyDown={(e) => {
          roving.onKeyDown(e)
        }}
        onClick={onFocus}
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
          <span className="truncate text-xs text-muted-foreground">
            {member.model || 'teammate'}
          </span>
        )}
      </div>

      {/* Trailing (tabular). needs_you → the ONE loud blue pill (tile waiting-pill
          geometry). Else → muted task-count. Then the remove trash (state-aware:
          "Kill & remove" for a live teammate, "Remove" for an offline one). */}
      <div className="relative z-20 flex shrink-0 items-center gap-1">
        {needsYou ? (
          <span className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting-ink">
            needs you
          </span>
        ) : (
          taskTotal > 0 && (
            <span className="shrink-0 px-1 text-[11px] font-medium tabular-nums text-muted-foreground">
              {taskDone}/{taskTotal}
            </span>
          )
        )}
        <KillTeammateButton team={team} member={member} />
      </div>
    </div>
  )
}

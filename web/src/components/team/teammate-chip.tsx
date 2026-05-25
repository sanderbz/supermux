// TeammateChip — one teammate as a compact 44pt glass row inside the TEAM CARD
// (AT-F-FRONT / F1, plan §5.3 + the design-critic anatomy). The default density
// (Chips) renders teammates as these rows below the lead tile.
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
//     needs_you — THE ONLY loud element — ELSE a muted task-count (`2/3`) + a
//     small zero-click PEEK GLYPH.
//
// GESTURES (no-extra-clicks + @dnd-kit clash avoidance):
//   • Tap        → focus that teammate's terminal (onFocus).
//   • Peek glyph → half-sheet peek (onPeek). Zero-click, always present (the
//                  preferred trigger per the no-extra-clicks feedback).
//   • Long-press → peek too, but ONLY when NOT in custom mode (custom mode owns
//                  the @dnd-kit TouchSensor long-press for reorder; firing our own
//                  long-press there would clash). The glyph is the universal path.

import { cn } from '@/lib/utils'
import { useLongPress } from '@/hooks/use-long-press'
import { ActivityLine } from '@/components/session-tile/activity-status'
import { MemberStatusDot } from './member-status-dot'
import { tasksForMember, type Team, type TeamMember } from '@/lib/api/teams'

const TASK_DONE = 'completed'

export interface TeammateChipProps {
  team: Team
  member: TeamMember
  /** Live "what this teammate is doing now" label (optional — AT-B doesn't carry
   *  a per-teammate activity line yet; threaded for forward-compat + AT-F3). */
  activity?: string
  /** Tap → focus this teammate's terminal full-screen. */
  onFocus: () => void
  /** Peek glyph / long-press → half-sheet peek. */
  onPeek: () => void
  /** True while the overview is in custom (drag-reorder) mode — disables the
   *  chip's own long-press so it doesn't clash with @dnd-kit's TouchSensor. The
   *  peek glyph still works (it's the universal, no-extra-clicks trigger). */
  customMode?: boolean
}

export function TeammateChip({
  team,
  member,
  activity,
  onFocus,
  onPeek,
  customMode = false,
}: TeammateChipProps) {
  const needsYou = member.status === 'needs_you'
  const memberTasks = tasksForMember(team, member)
  const taskTotal = memberTasks.length
  const taskDone = memberTasks.filter((t) => t.status === TASK_DONE).length

  // Long-press → peek, suppressed in custom mode (TouchSensor owns the gesture
  // there). A short tap → focus. The glyph (below) handles peek in every mode.
  const longPress = useLongPress({
    onLongPress: () => {
      if (!customMode) onPeek()
    },
    onClick: onFocus,
  })

  const rail = member.color || 'hsl(var(--status-idle))'

  return (
    <div
      // The row is the tap target → focus. Long-press → peek (non-custom mode).
      // relative + overflow-hidden so the colour rail clips to the rounded corner.
      className={cn(
        'group/chip relative flex h-11 items-center gap-2.5 overflow-hidden rounded-[10px] border border-border/60 bg-card/60 pl-3 pr-1.5',
        'cursor-pointer select-none transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // A calm tint when needs_you — the row itself reads as "attention here"
        // without an alarmist fill; the pill is the loud token.
        needsYou && 'bg-status-waiting/[0.06]',
      )}
      role="button"
      tabIndex={0}
      aria-label={`Teammate ${member.name}${needsYou ? ', needs you' : ''}. Tap to open, long-press or peek to preview.`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onFocus()
        }
      }}
      {...longPress}
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
          geometry). Else → muted task-count + the zero-click peek glyph. */}
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

        {/* Peek glyph — zero-click peek trigger, ≥44pt hit target (size-9 visible,
            the row is 44pt tall so the vertical target is met; horizontal padding
            on the parent keeps the tap zone generous). Stops propagation so it
            never also triggers the row's tap→focus. */}
        <button
          type="button"
          aria-label={`Peek ${member.name}`}
          title="Peek"
          onClick={(e) => {
            e.stopPropagation()
            onPeek()
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex size-9 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PeekGlyph />
        </button>
      </div>
    </div>
  )
}

/** A small "peek" glyph — an eye-like preview mark. Kept inline (no new icon dep)
 *  and sized to read at the chip's trailing edge without crowding. */
function PeekGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="1.75" />
    </svg>
  )
}

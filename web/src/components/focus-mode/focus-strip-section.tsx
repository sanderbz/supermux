// FocusStripSection — one collapsible user-group section in the desktop
// focus session-strip (feat-focus-strip-groups).
//
// VISUAL LANGUAGE.
//
//   • Section header row: small disclosure caret + group name + `· N` count
//     suffix on the LEFT, the shared <GroupSortChip> on the RIGHT. Sits at
//     the same density as the strip's "Sessions" header (text-[12px],
//     font-semibold, muted-foreground until hover) so it never reads as a
//     bolt-on.
//
//   • Body: a flex column of <CompactTile> rows beneath the header. When
//     collapsed, the body unmounts (no AnimatePresence here — the strip is a
//     dense list and animating each section's expand/collapse would compete
//     with the focused-row's spring + the per-tile peek popover; we prefer a
//     calm instant flip).
//
//   • Implicit "Ungrouped" sections render a slightly more muted label
//     ("Ungrouped") to telegraph the system-bucket status, mirroring the
//     overview's ungrouped-label affordance.
//
// A11Y. The disclosure caret is keyboard-accessible via the surrounding
// <button>; aria-expanded reflects collapsed state; the group name is part
// of the button's accessible label so the SR reads "Group <name>, expanded,
// N sessions." The sort chip is the existing keyboard-friendly Radix menu.
//
// REDUCED MOTION. There is no expand/collapse motion to honour — collapse
// is an instant flip. The caret's rotation (0° → 90°) is a CSS-driven
// transform; we set `motion-reduce:transition-none` so it never animates
// under prefers-reduced-motion.

import * as React from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import { GroupSortChip } from '@/components/session-tile/group-sort-chip'
import type { GroupSortMode } from '@/lib/overview-layout'
import type { TileSession } from '@/components/session-tile/types'

import { CompactTile } from './compact-tile'
import type { StripUserGroup } from './focus-strip-groups'

/** The set of per-group sort modes the strip exposes. Smaller than the
 *  overview's six — `'custom'` (per-group drag order) and `'age'` add no
 *  value on a 320 px sidebar with no drag affordance. */
const STRIP_PER_GROUP_SORT_MODES: GroupSortMode[] = [
  'smart',
  'recent',
  'status',
  'name',
]

export interface FocusStripSectionProps {
  group: StripUserGroup
  /** The focused session name from the route — highlights its row + suppresses
   *  the peek-popover. */
  focusedSessionName: string
  /** True when a teammate is selected in the main pane — used to suppress the
   *  "current" highlight on any session row (the focused session is no longer
   *  the active main-pane subject). */
  teammateActive: boolean
  /** Click → navigate to a session's focus route. */
  onSelectSession: (name: string) => void
  /** Persist a per-group sort mode (the strip owns its own namespace; the
   *  strip's hook routes the write to the right localStorage row). */
  onSortModeChange: (mode: GroupSortMode) => void
  /** Per-section collapse state + setter (strip-local, persisted). */
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  /** Map of session name → 1-indexed Cmd+N slot (≤9). Used to surface the
   *  ⌘N / Ctrl+N hint on the first 9 jumpable rows. */
  jumpIndexBySession?: Map<string, number>
}

export function FocusStripSection({
  group,
  focusedSessionName,
  teammateActive,
  onSelectSession,
  onSortModeChange,
  collapsed,
  onCollapsedChange,
  jumpIndexBySession,
}: FocusStripSectionProps) {
  const [sortOpen, setSortOpen] = React.useState(false)
  const headerId = React.useId()
  const bodyId = `${headerId}-body`

  return (
    <section
      aria-labelledby={headerId}
      data-vr="strip-section"
      data-vr-group-id={group.groupId}
      data-vr-sort-mode={group.sortMode}
      data-vr-collapsed={collapsed ? 'true' : 'false'}
      data-vr-implicit={group.isImplicit ? 'true' : 'false'}
      className="flex flex-col gap-1.5"
    >
      {/* Header row — disclosure on the LEFT, sort chip on the RIGHT.
          The whole row is a button so the click target is generous;
          inner <GroupSortChip> stops propagation to keep its menu working. */}
      <div className="flex items-center gap-1 pl-0.5 pr-0.5">
        <button
          id={headerId}
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={`${group.groupName}, ${
            collapsed ? 'collapsed' : 'expanded'
          }, ${group.sessions.length} ${
            group.sessions.length === 1 ? 'session' : 'sessions'
          }`}
          onClick={() => onCollapsedChange(!collapsed)}
          className={cn(
            // Tight 28px row (the strip's "Sessions" header is 44px; section
            // headers sit visually nested under it). h-7 keeps the strip
            // density without making the chevron feel cramped.
            'group/strip-section flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-[12px] font-semibold tracking-tight text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            // Implicit Ungrouped sits a touch more muted so a real user group
            // wins the eye — mirrors the overview's `Ungrouped · N` treatment.
            group.isImplicit && 'text-muted-foreground/70',
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none',
              !collapsed && 'rotate-90',
            )}
          />
          <span className="min-w-0 truncate">{group.groupName}</span>
          <span
            aria-hidden
            className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground/70"
          >
            · {group.sessions.length}
          </span>
        </button>
        {/* Shared sort chip — same component the overview uses on its
            group headers, in 'strip' density (compact "<Mode> ▾"). The
            strip renders a CURATED 4-mode set (Smart / Recent / Status /
            Name) — Custom is meaningless on a 320 px sidebar without a
            drag affordance, and Age overlaps with Recent.
            Only renders in 'as-overview' view mode; flat modes don't
            render section headers at all. */}
        <GroupSortChip
          open={sortOpen}
          onOpenChange={setSortOpen}
          sortMode={group.sortMode}
          onChange={onSortModeChange}
          density="strip"
          vrTag="strip-sort-chip"
          modes={STRIP_PER_GROUP_SORT_MODES}
        />
      </div>

      {/* Body — a flex column of CompactTile rows. Collapsed → unmount; we
          prefer a calm instant flip over animation in a dense strip. */}
      {!collapsed && (
        <div
          id={bodyId}
          data-vr="strip-section-body"
          data-vr-group-id={group.groupId}
          className="flex flex-col gap-1.5"
        >
          {group.sessions.length === 0 ? (
            // Zero-state for a user-defined group with no sessions — keeps the
            // section visible (the user explicitly created it) but signals it
            // empty without competing for attention.
            <p className="px-2 py-1 text-[11px] text-muted-foreground/70">
              No sessions in this group yet.
            </p>
          ) : (
            group.sessions.map((s: TileSession) => (
              <CompactTile
                key={s.name}
                session={s}
                current={!teammateActive && s.name === focusedSessionName}
                onSelect={onSelectSession}
                jumpIndex={jumpIndexBySession?.get(s.name)}
              />
            ))
          )}
        </div>
      )}
    </section>
  )
}

export default FocusStripSection

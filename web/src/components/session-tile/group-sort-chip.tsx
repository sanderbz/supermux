// GroupSortChip — the shared per-group sort chip + Radix DropdownMenu.
//
// EXTRACTED FROM group-header.tsx so both the overview's <GroupHeader> AND the
// desktop focus session-strip's <FocusStripSection> can render the EXACT SAME
// 6-mode chip + menu UI without forking it. The 6 modes (Smart / Custom /
// Name / Status / Recent / Age), their labels, hints, and icons live in one
// place; this component just owns the chip's anchor + menu rendering so both
// surfaces stay visually identical even as we evolve the per-mode glyphs.
//
// NAMING: there's already a `SortControl` in this directory — that one drives
// the GLOBAL sort mode (Smart / A-Z / Custom, persisted server-side via
// `useOverviewLayout`). This is a separate concern: the per-GROUP chip
// rendered ON a group header (overview or strip). Keeping the names distinct
// avoids the next reader having to guess which one a call site means.
//
// THE CONTRACT.
//
//   • Controlled `open` so callers can drive it from a keyboard shortcut
//     (overview group-header's `o` chord) without re-implementing menu state.
//   • `density` switches between two visual presentations:
//       - 'overview' — full chip "Sort: <Mode> ▾", responsive (hides the
//         "Sort:" prefix below sm:).
//       - 'strip'    — compact "<Mode> ▾" — fits the 320px focus strip where
//         the chip sits beside a group title + count + collapse caret.
//     Same Radix DropdownMenu content for both; only the trigger button
//     varies.
//   • All pointer events from the trigger are `stopPropagation()`'d — when the
//     chip lives inside a draggable row header (overview), we MUST NOT let a
//     click bubble up and start a drag. Strip headers also call it as a
//     simple <button> so stopping propagation here is harmless.

import {
  ArrowDownAZ,
  ArrowUpDown,
  Check,
  GripVertical,
  Sparkles,
} from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  GROUP_SORT_HINT,
  GROUP_SORT_LABEL,
  GROUP_SORT_MODES,
  type GroupSortMode,
} from '@/lib/overview-layout'

/** Default rendered mode list when the caller doesn't override. Mirrors the
 *  overview's 6-mode set; the strip passes a curated 4-mode list via `modes`. */
const DEFAULT_RENDERED_MODES = GROUP_SORT_MODES

/** A tiny per-mode glyph for the chip + popover. Single source of truth — both
 *  the overview group-header and the focus-strip section header read the same
 *  table so the icon never drifts between surfaces. */
export const GROUP_SORT_MODE_ICON: Record<GroupSortMode, typeof Sparkles> = {
  smart: Sparkles,
  custom: GripVertical,
  name: ArrowDownAZ,
  status: ArrowUpDown,
  recent: ArrowUpDown,
  age: ArrowUpDown,
}

export interface GroupSortChipProps {
  /** Controlled open state — caller (group-header / strip section) owns it so a
   *  keyboard shortcut can pop the menu without re-implementing menu state. */
  open: boolean
  onOpenChange: (next: boolean) => void
  /** Current active mode (drives the chip's icon + label + the menu's check). */
  sortMode: GroupSortMode
  /** Persist a new mode. The chip closes automatically on select. */
  onChange: (mode: GroupSortMode) => void
  /** 'overview' = full chip ("Sort: <Mode> ▾"); 'strip' = compact ("<Mode> ▾").
   *  Defaults to 'overview' to preserve the original group-header look when this
   *  component is dropped into legacy call sites. */
  density?: 'overview' | 'strip'
  /** Optional extra data-vr attribute for visual-regression hooks. Caller can
   *  set e.g. `data-vr="strip-sort-chip"` to differentiate from the overview's
   *  `data-vr="group-sort-chip"`. Defaults to 'group-sort-chip' for back-compat. */
  vrTag?: string
  /** Optional override for which modes appear in the menu. Defaults to the
   *  overview's 6-mode set. The strip passes the curated 4-mode list
   *  (`STRIP_SORT_MODES` from focus-strip-layout). The TYPE accepts any
   *  GroupSortMode, so stale localStorage values (e.g. 'custom' or 'age' set
   *  by a previous build) still resolve to a working sort kernel — they just
   *  don't appear in the dropdown anymore. */
  modes?: ReadonlyArray<GroupSortMode>
}

export function GroupSortChip({
  open,
  onOpenChange,
  sortMode,
  onChange,
  density = 'overview',
  vrTag = 'group-sort-chip',
  modes = DEFAULT_RENDERED_MODES,
}: GroupSortChipProps) {
  const ActiveIcon = GROUP_SORT_MODE_ICON[sortMode]
  // Compact strip density is "<Mode> ▾" with no responsive switch — the strip
  // is 320px and a "Sort:" prefix steals tile-title width. Overview density
  // keeps the original behaviour ("Sort: …" on ≥sm, "<Mode>" on <sm).
  const isStrip = density === 'strip'
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={`Sort: ${GROUP_SORT_LABEL[sortMode]}. Change`}
          title={`Sort: ${GROUP_SORT_LABEL[sortMode]}`}
          data-vr={vrTag}
          data-vr-sort-mode={sortMode}
          // Stop pointer/click from bubbling — the overview group-header is a
          // drag handle, so a chip click must NOT initiate a drag. Harmless on
          // the strip where the header isn't draggable.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={
            isStrip
              ? // Strip: tight 24px-tall chip, only the active icon + label. No
                // "Sort:" prefix — the section header already advertises that
                // this is a sort control via its position next to the caret.
                'flex h-6 min-h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              : // Overview: the original h-8 chip with responsive prefix +
                // larger touch target (≥sm) used by the existing surface.
                'flex h-8 min-h-8 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-11'
          }
        >
          <ActiveIcon className="size-3.5" aria-hidden />
          {isStrip ? (
            <span>{GROUP_SORT_LABEL[sortMode]}</span>
          ) : (
            <>
              <span className="hidden sm:inline">
                Sort: {GROUP_SORT_LABEL[sortMode]}
              </span>
              <span className="sm:hidden">{GROUP_SORT_LABEL[sortMode]}</span>
            </>
          )}
          <span aria-hidden className="opacity-60">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-52">
        {modes.map((mode) => {
          const Icon = GROUP_SORT_MODE_ICON[mode]
          const active = mode === sortMode
          return (
            <DropdownMenuItem
              key={mode}
              onSelect={() => onChange(mode)}
              aria-current={active ? 'true' : undefined}
              className="flex items-start gap-2"
            >
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1 text-foreground">
                  {GROUP_SORT_LABEL[mode]}
                  {active && (
                    <Check
                      className="size-3.5 text-muted-foreground"
                      aria-hidden
                    />
                  )}
                </span>
                <span className="text-[11px] leading-tight text-muted-foreground">
                  {GROUP_SORT_HINT[mode]}
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default GroupSortChip

// SortControl — the overview's tiny "sort mode" affordance
// (feat-sort-and-groups).
//
// Geometry mirrors <ViewToggle> / <OverviewSizeControl> so all three cluster
// in the header chrome with shared rhythm: h-9 outer pill, size-7 inner icon
// well, sentence-case labels, no UPPERCASE.
//
// Critical UX requirement: ZERO interference for users who never open it.
// Default = `smart` (the existing sort), the button is a single 36pt-tall icon
// that just shows the current mode glyph, and the popover stays closed until
// the user pokes it. No badge, no banner, no "DID YOU KNOW?" microcopy.

import { ArrowDownAZ, ArrowUpDown, GripVertical, Sparkles } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type SortMode } from '@/lib/overview-layout'

/** Glyph + short label per mode — keyed by `SortMode`. Sentence case. */
const MODE_META: Record<
  SortMode,
  { label: string; hint: string; Icon: typeof Sparkles }
> = {
  smart: {
    label: 'Smart',
    hint: 'Active and pinned sessions first',
    Icon: Sparkles,
  },
  alpha: {
    label: 'A–Z',
    hint: 'Alphabetical by name',
    Icon: ArrowDownAZ,
  },
  custom: {
    label: 'Custom',
    hint: 'Drag to reorder, group with section headers',
    Icon: GripVertical,
  },
}

export interface SortControlProps {
  value: SortMode
  onChange: (mode: SortMode) => void
}

/** Read-only access to the per-mode metadata. The renderer also uses this for
 *  the group header chrome's tooltips so the language is consistent. */
export function sortLabel(mode: SortMode): string {
  return MODE_META[mode].label
}

export function SortControl({ value, onChange }: SortControlProps) {
  // The current-mode icon goes in the trigger so the user sees "what's on"
  // before opening the menu. `ArrowUpDown` (the generic "sort" glyph) appears
  // only in tests + assistive tech — kept for the aria-label fallback.
  const ActiveIcon = MODE_META[value].Icon
  const currentLabel = MODE_META[value].label

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            {/* Match the geometry of the density and view-toggle pills (h-9 +
                rounded-lg + bg-muted) so the chrome reads as ONE cluster. */}
            <button
              type="button"
              aria-label={`Sort: ${currentLabel}. Change`}
              title={`Sort: ${currentLabel}`}
              className="relative flex h-9 items-center gap-1.5 rounded-lg bg-muted px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ActiveIcon className="size-4" aria-hidden />
              {/* The label is small + tabular so width is stable across modes
                  ("Smart" / "A–Z" / "Custom" are visually similar widths). */}
              <span className="hidden sm:inline">{currentLabel}</span>
              <ArrowUpDown className="size-3 opacity-60 sm:hidden" aria-hidden />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Sort</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-44">
        {(Object.keys(MODE_META) as SortMode[]).map((mode) => {
          const { Icon, label, hint } = MODE_META[mode]
          const active = mode === value
          return (
            <DropdownMenuItem
              key={mode}
              onSelect={() => onChange(mode)}
              aria-current={active ? 'true' : undefined}
              className="flex items-start gap-2"
            >
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span
                  className={
                    active
                      ? 'text-foreground font-medium'
                      : 'text-foreground'
                  }
                >
                  {label}
                </span>
                <span className="text-[11px] leading-tight text-muted-foreground">
                  {hint}
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

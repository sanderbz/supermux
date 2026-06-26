// OverviewDisplayMenu — the mobile "Display" sheet that folds the overview's
// four display controls into one tap target: View (tiles/list), Sort, Size, and
// the Hide-stopped filter. Desktop keeps the separate header chips; on a coarse
// pointer the chips are cramped, so they collapse here.
//
// Reuses the app's existing vocabulary so nothing is reinvented: the segmented
// rail mirrors <ViewToggle>, the sort rows reuse <SortControl>'s SORT_MODE_META, the
// size icons match <OverviewSizeControl>, and the Eye/EyeOff toggle matches the
// focus strip's hide-stopped affordance. Container is the same glass Vaul
// bottom-sheet the "+" menu uses.

import * as React from 'react'
import { motion } from 'framer-motion'
import { Drawer } from 'vaul'
import {
  Check,
  Eye,
  EyeOff,
  LayoutGrid,
  List,
  Rows2,
  Rows3,
  SlidersHorizontal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type ViewMode } from '@/stores/ui-store'
import {
  MAX_OVERVIEW_SIZE_MOBILE,
  MIN_OVERVIEW_SIZE,
  type OverviewSize,
} from '@/lib/overview-size'
import { type SortMode } from '@/lib/overview-layout'
import { SORT_MODE_META } from '@/lib/sort-modes'

export interface OverviewDisplayMenuProps {
  viewMode: ViewMode
  onViewMode: (v: ViewMode) => void
  sortMode: SortMode
  onSortMode: (m: SortMode) => void
  size: OverviewSize
  onSize: (s: OverviewSize) => void
  hideStopped: boolean
  onHideStopped: (v: boolean) => void
}

export function OverviewDisplayMenu({
  viewMode,
  onViewMode,
  sortMode,
  onSortMode,
  size,
  onSize,
  hideStopped,
  onHideStopped,
}: OverviewDisplayMenuProps) {
  const [open, setOpen] = React.useState(false)
  // Mobile size only has two meaningful tiers (the grid is single-column, so
  // the tier just changes tile HEIGHT) — collapse to Compact / Roomy.
  const sizeValue = (
    size >= MAX_OVERVIEW_SIZE_MOBILE ? MAX_OVERVIEW_SIZE_MOBILE : MIN_OVERVIEW_SIZE
  ) as OverviewSize

  return (
    <Drawer.Root open={open} onOpenChange={setOpen}>
      <Drawer.Trigger asChild>
        <Button
          type="button"
          aria-label="Display options"
          className="size-9 rounded-md p-0"
        >
          <SlidersHorizontal className="size-4" aria-hidden />
        </Button>
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Drawer.Content
          aria-describedby={undefined}
          className="glass fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-border/60 pb-safe outline-none"
        >
          <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-muted-foreground/30" />
          <div className="flex flex-col gap-5 px-5 pb-6 pt-4">
            <Drawer.Title className="text-base font-semibold">Display</Drawer.Title>

            <Section label="View">
              <Segmented
                value={viewMode}
                onChange={onViewMode}
                options={[
                  { id: 'tile', icon: LayoutGrid, label: 'Tiles' },
                  { id: 'list', icon: List, label: 'List' },
                ]}
                layoutId="display-view"
              />
            </Section>

            <Section label="Sort">
              <div className="flex flex-col gap-1">
                {(Object.keys(SORT_MODE_META) as SortMode[]).map((mode) => {
                  const { Icon, label, hint } = SORT_MODE_META[mode]
                  const active = mode === sortMode
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => onSortMode(mode)}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                        active ? 'bg-card shadow-sm' : 'hover:bg-accent/40',
                      )}
                    >
                      <Icon
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium">{label}</span>
                        <span className="text-[11px] leading-tight text-muted-foreground">
                          {hint}
                        </span>
                      </span>
                      {active && (
                        <Check className="size-4 shrink-0 text-primary" aria-hidden />
                      )}
                    </button>
                  )
                })}
              </div>
            </Section>

            {viewMode === 'tile' && (
              <Section label="Size">
                <Segmented
                  value={sizeValue}
                  onChange={onSize}
                  options={[
                    { id: MIN_OVERVIEW_SIZE, icon: Rows2, label: 'Compact' },
                    { id: MAX_OVERVIEW_SIZE_MOBILE, icon: Rows3, label: 'Roomy' },
                  ]}
                  layoutId="display-size"
                />
              </Section>
            )}

            <button
              type="button"
              onClick={() => onHideStopped(!hideStopped)}
              aria-pressed={hideStopped}
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
            >
              {hideStopped ? (
                <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <Eye className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="flex-1 text-sm font-medium">Hide stopped sessions</span>
              <Switch on={hideStopped} />
            </button>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

/** The desktop sibling — a single Eye/EyeOff chip that sits in the header
 *  control cluster (mobile folds it into the sheet above). Same global state,
 *  same glyph as the focus-strip toggle. */
export function HideStoppedChip({
  value,
  onChange,
}: {
  value: boolean
  onChange: (v: boolean) => void
}) {
  const label = value ? 'Showing only running — tap to show stopped' : 'Hide stopped sessions'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onChange(!value)}
          aria-pressed={value}
          aria-label={label}
          className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {value ? (
            <EyeOff className="size-4" aria-hidden />
          ) : (
            <Eye className="size-4" aria-hidden />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {value ? 'Stopped hidden' : 'Hide stopped'}
      </TooltipContent>
    </Tooltip>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/** A generic two-or-more segmented rail with an animated `bg-card` thumb —
 *  the exact pattern <ViewToggle> uses, parameterised so View and Size share it. */
function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  layoutId,
}: {
  value: T
  onChange: (v: T) => void
  options: { id: T; icon: LucideIcon; label: string }[]
  layoutId: string
}) {
  return (
    <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-muted p-1">
      {options.map(({ id, icon: Icon, label }) => {
        const active = id === value
        return (
          <button
            key={String(id)}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            className={cn(
              'relative flex h-9 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={springs.snappy}
                className="absolute inset-0 rounded-md bg-card shadow-sm"
              />
            )}
            <Icon className="relative size-4" aria-hidden />
            <span className="relative">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** A compact iOS-style switch thumb (display-only; the parent button owns the
 *  press + aria-pressed). */
function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors',
        on ? 'bg-primary' : 'bg-muted-foreground/30',
      )}
    >
      <motion.span
        animate={{ x: on ? 18 : 2 }}
        transition={springs.snappy}
        className="absolute left-0 top-1/2 size-5 -translate-y-1/2 rounded-full bg-white shadow-sm"
      />
    </span>
  )
}

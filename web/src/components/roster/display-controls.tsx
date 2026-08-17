/**
 * `<DisplayControls>` — the DESKTOP half of the one canonical prefs surface.
 * ─────────────────────────────────────────────────────────────────────────────
 * The overview's display options existed twice: a mobile "Display" sheet
 * (`OverviewDisplayMenu`, View / Sort / Size / Hide-stopped / renderer) and four
 * separate desktop chips. Two implementations of one idea drift, and they had
 * already started to — the mobile sheet grew A5's renderer option and the chips
 * did not, and neither of them could reach the group-by preset or the tag filter
 * B2 adds.
 *
 * So this is the desktop rendering of the SAME option model
 * (`lib/sort-modes.ts`): view · sort · group-by · size · tag filter ·
 * hide-stopped · default renderer, in a popover behind one trigger. The mobile
 * sheet keeps its own container (a bottom sheet is the right shape on a phone)
 * and reads the same model, so a new option is added once.
 *
 * Settings → Appearance and the ⌘K palette are documented cross-references to
 * these, never third sources.
 */
import * as React from 'react'
import { Check, Eye, EyeOff, LayoutGrid, List, Minus, Plus, SlidersHorizontal } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useUI, type ViewMode } from '@/stores/ui-store'
import type { Renderer } from '@/components/chat/renderer-pref'
import {
  MIN_OVERVIEW_SIZE,
  type OverviewSize,
} from '@/lib/overview-size'
import {
  GROUP_BY_MODES,
  type GroupBy,
  type SortMode,
} from '@/lib/overview-layout'
import { GROUP_BY_META, SORT_MODE_META } from '@/lib/sort-modes'

export interface DisplayControlsProps {
  viewMode: ViewMode
  onViewMode: (v: ViewMode) => void
  sortMode: SortMode
  onSortMode: (m: SortMode) => void
  groupBy: GroupBy
  onGroupBy: (g: GroupBy) => void
  size: OverviewSize
  onSize: (s: OverviewSize) => void
  /** The tier ceiling for this viewport (the density control is tile-only). */
  sizeMax: OverviewSize
  /** Whether the density control is offered at all. It is not "tile view only":
   *  the LIST view's fact ladder is driven by exactly the same number (see
   *  `lib/fact-ladder.ts` — tier 2 adds the preview line, 3 the tokens, 4 the
   *  tag chips), and hiding the control there meant the only route to a list's
   *  richer rungs was to switch to Tiles, raise the density, and switch back. */
  sizeApplies: boolean
  /** What the density is called in THIS view. Tiles get bigger; rows get more
   *  facts — one number, two honest names. */
  sizeLabel?: string
  hideStopped: boolean
  onHideStopped: (v: boolean) => void
  /** Every tag on the roster, for the filter. Empty ⇒ the row is not rendered:
   *  a filter with nothing to filter is chrome. */
  tags: readonly string[]
  activeTags: readonly string[]
  onToggleTag: (tag: string) => void
  className?: string
}

export function DisplayControls({
  viewMode,
  onViewMode,
  sortMode,
  onSortMode,
  groupBy,
  onGroupBy,
  size,
  onSize,
  sizeMax,
  sizeApplies,
  sizeLabel = 'Density',
  hideStopped,
  onHideStopped,
  tags,
  activeTags,
  onToggleTag,
  className,
}: DisplayControlsProps) {
  const [open, setOpen] = React.useState(false)
  // A5's global default renderer. Read from the store rather than taken as two
  // more props: the value has no overview-local meaning, and this popover is the
  // home of the account-wide display choices. Hidden while the experiment is
  // off — a control that decides nothing is worse than an absent one.
  const chatExperiment = useUI((s) => s.chatRenderer)
  const defaultRenderer = useUI((s) => s.defaultRenderer)
  const setDefaultRenderer = useUI((s) => s.setDefaultRenderer)

  // The dot on the trigger: something is filtering or grouping the view in a
  // way the grid itself does not announce. Sort and size change what you see
  // obviously; a hidden-stopped filter and a tag filter do not.
  const modified = hideStopped || activeTags.length > 0 || groupBy !== 'none'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Display options"
          data-vr="display-controls-trigger"
          className={cn('relative h-9 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground', className)}
        >
          <SlidersHorizontal className="size-4" aria-hidden />
          <span className="hidden lg:inline">Display</span>
          {modified && (
            <span
              aria-hidden
              className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        data-vr="display-controls"
        className="w-72 rounded-[10px] p-0"
      >
        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-4 py-4 [scrollbar-width:thin]">
          <Section label="View">
            <Segmented<ViewMode>
              value={viewMode}
              onChange={onViewMode}
              options={[
                { id: 'tile', label: 'Tiles', Icon: LayoutGrid },
                { id: 'list', label: 'List', Icon: List },
              ]}
            />
          </Section>

          <Section label="Sort">
            <RadioRows
              value={sortMode}
              onChange={onSortMode}
              options={(Object.keys(SORT_MODE_META) as SortMode[]).map((id) => ({
                id,
                ...SORT_MODE_META[id],
              }))}
            />
          </Section>

          {/* Group-by is a DERIVED split over the flat body, and the flat body
              is not rendered in custom mode — `GroupGrid` owns the canvas
              there, with the user's own hand-dragged groups. The control used
              to keep its state and draw its checkmark anyway while regrouping
              nothing (0 preset headers), which is the project's own "a control
              that decides nothing is worse than no control" in miniature. Now
              it says why. */}
          <Section label="Group by">
            <RadioRows
              value={groupBy}
              onChange={onGroupBy}
              disabled={sortMode === 'custom'}
              options={GROUP_BY_MODES.map((id) => ({ id, ...GROUP_BY_META[id] }))}
            />
            {sortMode === 'custom' && (
              <p className="text-[11px] leading-snug text-muted-foreground">
                Custom sort uses your own groups — switch Sort to use a preset.
              </p>
            )}
          </Section>

          {sizeApplies && (
            <Section label={sizeLabel}>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={sizeLabel === 'Density' ? 'Smaller tiles' : 'Less row detail'}
                  disabled={size <= MIN_OVERVIEW_SIZE}
                  onClick={() => onSize((size - 1) as OverviewSize)}
                  className="size-8 p-0"
                >
                  <Minus className="size-4" aria-hidden />
                </Button>
                <span className="w-6 text-center text-sm tabular-nums">{size}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={sizeLabel === 'Density' ? 'Bigger tiles' : 'More row detail'}
                  disabled={size >= sizeMax}
                  onClick={() => onSize((size + 1) as OverviewSize)}
                  className="size-8 p-0"
                >
                  <Plus className="size-4" aria-hidden />
                </Button>
              </div>
            </Section>
          )}

          {tags.length > 0 && (
            <Section label="Tags">
              <div className="flex flex-wrap gap-1.5" data-vr="display-tag-filter">
                {tags.map((tag) => {
                  const active = activeTags.includes(tag)
                  return (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={active}
                      onClick={() => onToggleTag(tag)}
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] leading-none transition-colors',
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {tag}
                    </button>
                  )
                })}
              </div>
            </Section>
          )}

          {chatExperiment && (
            <Section label="Default renderer">
              <Segmented<Renderer>
                value={defaultRenderer}
                onChange={setDefaultRenderer}
                options={[
                  { id: 'chat', label: 'Chat' },
                  { id: 'terminal', label: 'Terminal' },
                ]}
              />
              <p className="text-[11px] leading-snug text-muted-foreground">
                Per-session pins (a session’s ⋯ → Renderer) win over this.
              </p>
            </Section>
          )}

          <button
            type="button"
            onClick={() => onHideStopped(!hideStopped)}
            aria-pressed={hideStopped}
            data-vr="display-hide-stopped"
            className="flex items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm hover:bg-accent/40"
          >
            {hideStopped ? (
              <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <Eye className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="flex-1">Hide stopped sessions</span>
            {hideStopped && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/* ── the two row shapes ──────────────────────────────────────────────────── */

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { id: T; label: string; Icon?: React.ComponentType<{ className?: string }> }[]
}) {
  return (
    <div
      role="group"
      className="grid gap-1 rounded-lg bg-muted p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map(({ id, label, Icon }) => {
        const active = id === value
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(id)}
            className={cn(
              'flex h-8 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors',
              active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="size-4" />}
            {label}
          </button>
        )
      })}
    </div>
  )
}

function RadioRows<T extends string>({
  value,
  onChange,
  options,
  disabled = false,
}: {
  value: T
  onChange: (v: T) => void
  options: {
    id: T
    label: string
    hint: string
    Icon: React.ComponentType<{ className?: string }>
  }[]
  /** The whole group decides nothing right now. Rows are muted and inert —
   *  and, crucially, the checkmark goes with them, so the control cannot claim
   *  a state it is not applying. */
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5" aria-disabled={disabled || undefined}>
      {options.map(({ id, label, hint, Icon }) => {
        const active = id === value && !disabled
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(id)}
            className={cn(
              'flex items-start gap-2 rounded-md px-1 py-1.5 text-left hover:bg-accent/40',
              active && 'bg-accent/30',
              disabled && 'pointer-events-none opacity-45',
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm">{label}</span>
              <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span>
            </span>
            {active && <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}

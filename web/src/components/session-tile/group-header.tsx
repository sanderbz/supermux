// GroupHeader — the section divider shown ONLY in custom-sort mode.
// Inline-renameable (click the label, type, blur/Enter to commit), delete +
// "Move to top / Move up / Move down / Move to bottom" via kebab menu (the
// keyboard / non-drag accessibility path required by the 2026 spec), and a
// per-group **Sort chip** anchored on the right that opens a Radix Popover
// with the 6 Linear-style modes (Smart / Custom / Name / Status / Recent / Age).
//
// Visual-critic hooks:
//   * `data-vr="group-header"` on the root row.
//   * `data-vr-drag-state="idle|lifted|over"` flips as the dnd-kit state moves.
//   * `data-vr-container-indicate="smart|custom|off"` set by the parent when a
//     tile is being dragged OVER this group (the body container — set on the
//     wrapper that contains the group's tiles, not on the header).
//
// The drag activation lives ON THE WHOLE HEADER BAR — per the spec, "Group-header
// drag = whole-row reorder, columns ignored." The label is still clickable for
// rename, the sort chip stops propagation, etc. — we just spread the dnd-kit
// listeners on the root so any otherwise-inert pixel of the header initiates a
// drag.

import * as React from 'react'
import { ArrowDownAZ, ArrowUpDown, Check, GripVertical, Sparkles, Trash2 } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  GROUP_SORT_HINT,
  GROUP_SORT_LABEL,
  GROUP_SORT_MODES,
  type GroupSortMode,
} from '@/lib/overview-layout'

/** A tiny per-mode glyph for the chip + popover. */
const MODE_ICON: Record<GroupSortMode, typeof Sparkles> = {
  smart: Sparkles,
  custom: GripVertical,
  name: ArrowDownAZ,
  status: ArrowUpDown,
  recent: ArrowUpDown,
  age: ArrowUpDown,
}

export interface GroupHeaderProps {
  /** Stable id used as the dnd-kit sortable key + group identity. */
  id: string
  name: string
  /** Live session count inside the group (sessions until the next group / EOL). */
  count: number
  /** Drag listeners from `useSortable` — when present, the WHOLE HEADER row is
   *  a drag handle (per the 2026 spec: "Hit target: only the group header bar.").
   *  When null, drag is disabled (e.g. while a rename is active or for the
   *  pseudo-Ungrouped header which isn't reorderable). */
  dragListeners?: React.HTMLAttributes<HTMLDivElement> | null
  /** Current per-group sort mode (the chip's active state). */
  sortMode: GroupSortMode
  /** Persist a new per-group sort mode. */
  onSortModeChange: (mode: GroupSortMode) => void
  /** Drop-intent indication while a tile drag hovers THIS group container.
   *  `smart` → outline + tinted background; `custom` → quieter outline; `off`
   *  → no indication. Set by the parent based on the dragging tile's
   *  destination + this group's `sortMode`. */
  containerIndicate?: 'smart' | 'custom' | 'off'
  /** True while THIS group header itself is the active drag (renders dimmed). */
  dragLifted?: boolean
  /** True while THIS group header is being dragged-over by another group
   *  (used in conjunction with the parent-rendered full-grid drop line). */
  dragOver?: boolean
  onRename: (next: string) => void
  onDelete: () => void
  /** Optional kebab move-actions (the alternative path to drag for keyboard /
   *  touch users). Provide all four; unbound buttons are disabled if undefined. */
  onMoveUp?: () => void
  onMoveDown?: () => void
  onMoveTop?: () => void
  onMoveBottom?: () => void
}

export function GroupHeader({
  id,
  name,
  count,
  dragListeners,
  sortMode,
  onSortModeChange,
  containerIndicate = 'off',
  dragLifted = false,
  dragOver = false,
  onRename,
  onDelete,
  onMoveUp,
  onMoveDown,
  onMoveTop,
  onMoveBottom,
}: GroupHeaderProps) {
  // Editing-mode state. `inputRef` lets us read the input value at blur/commit
  // time without re-rendering on every keystroke (uncontrolled input).
  const [editing, setEditing] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  // Per-group sort popover open-state — for the `o` keyboard shortcut.
  const [sortOpen, setSortOpen] = React.useState(false)

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = () => {
    const trimmed = (inputRef.current?.value ?? '').trim()
    setEditing(false)
    if (trimmed && trimmed !== name) onRename(trimmed)
  }
  const cancel = () => {
    setEditing(false)
  }

  // Keyboard `o` opens the per-group sort menu while the header is focused.
  // Listen on the row so the shortcut is scoped — we don't want a stray `o`
  // anywhere on the page opening every menu at once.
  const onRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'o' && e.key !== 'O') return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const target = e.target as HTMLElement | null
    // Don't hijack `o` while typing into the rename input.
    if (target) {
      const tag = target.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable
      ) {
        return
      }
    }
    e.preventDefault()
    setSortOpen(true)
  }

  return (
    // role="group" gives screen readers the right semantic. The row sits
    // INSIDE the main grid (col-span-full on the parent wrapper) so it acts
    // as a section divider that wraps across tile columns.
    //
    // dragListeners (whole-row) → spread onto the root: per the spec, the
    // HEADER BAR is the drag target. Inner controls (rename label, sort chip,
    // kebab) all call `stopPropagation()` so they remain usable.
    <div
      role="group"
      aria-label={`Group: ${name} (${count})`}
      tabIndex={0}
      onKeyDown={onRowKeyDown}
      data-vr="group-header"
      data-vr-group-id={id}
      data-vr-drag-state={dragLifted ? 'lifted' : dragOver ? 'over' : 'idle'}
      data-vr-container-indicate={containerIndicate}
      {...(dragListeners ?? {})}
      // touch-none so a press-and-hold initiates the drag instead of scrolling.
      className={
        'group/group flex h-10 items-center gap-1.5 border-b border-border/40 pl-1 pr-1.5 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-none' +
        (dragLifted ? ' opacity-40' : '')
      }
      style={{ cursor: dragListeners ? 'grab' : undefined }}
    >
      {/* Decorative grip — purely visual cue that the row is draggable.
          Not a separate hit target now (the whole row is); the icon just
          telegraphs the affordance at a glance. */}
      <span
        aria-hidden
        className="flex size-8 items-center justify-center text-muted-foreground/40 group-hover/group:text-muted-foreground"
      >
        <GripVertical className="size-4" />
      </span>

      {editing ? (
        <input
          ref={inputRef}
          defaultValue={name}
          onBlur={commit}
          onKeyDown={(e) => {
            // Stop Space / Enter / arrow keys from bubbling to the dnd-kit
            // KeyboardSensor wired onto the parent header row via
            // `dragListeners` (see line 163 above) — otherwise Space is
            // interpreted as "pick up a drag", which steals focus and runs
            // our onBlur → commit prematurely, making the rename input look
            // broken. Browser default still inserts the space character.
            // Product: group names accept spaces (no validator rejects them).
            if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.stopPropagation()
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          // Prevent the row-level drag listeners from initiating a drag while
          // typing into the rename input.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          aria-label="Group name"
          className="min-w-0 flex-1 rounded border border-input bg-transparent px-2 py-1 text-base md:text-sm font-medium tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setEditing(true)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm font-medium tracking-tight text-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Rename ${name}`}
          title="Click to rename"
        >
          <span className="truncate">{name}</span>
          <span
            aria-hidden
            className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground"
          >
            · {count}
          </span>
        </button>
      )}

      {/* Per-group SORT CHIP — right-aligned. Spec: small, muted text,
          `Sort: <Mode> ▾`, Radix DropdownMenu. */}
      <GroupSortChip
        open={sortOpen}
        onOpenChange={setSortOpen}
        sortMode={sortMode}
        onChange={onSortModeChange}
      />

      {/* Per-group menu — delete + the alternative-path move-actions.
          Stays a tiny icon-button so the row chrome is minimal. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More actions for ${name}`}
            data-vr="group-kebab"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground/40 opacity-0 transition-opacity hover:text-muted-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/group:opacity-100"
          >
            <span className="text-base leading-none">⋯</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6}>
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Move-up / Move-down / Move-to-top / Move-to-bottom — the alt path
              (Atlassian "Designed for Delight") so keyboard + touch users can
              reorder without ever picking up a drag handle. */}
          <DropdownMenuItem
            disabled={!onMoveTop}
            onSelect={() => onMoveTop?.()}
          >
            Move to top
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!onMoveUp} onSelect={() => onMoveUp?.()}>
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!onMoveDown}
            onSelect={() => onMoveDown?.()}
          >
            Move down
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!onMoveBottom}
            onSelect={() => onMoveBottom?.()}
          >
            Move to bottom
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onDelete}>
            <Trash2 className="size-4" aria-hidden />
            Delete group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** The right-aligned `Sort: <Mode> ▾` chip — opens a Radix DropdownMenu with
 *  the 6 per-group modes. Honors the keyboard `o` shortcut (handled by the
 *  GroupHeader row) by controlling `open` from outside. */
function GroupSortChip({
  open,
  onOpenChange,
  sortMode,
  onChange,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  sortMode: GroupSortMode
  onChange: (mode: GroupSortMode) => void
}) {
  const ActiveIcon = MODE_ICON[sortMode]
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={`Sort: ${GROUP_SORT_LABEL[sortMode]}. Change`}
          title={`Sort: ${GROUP_SORT_LABEL[sortMode]}`}
          data-vr="group-sort-chip"
          data-vr-sort-mode={sortMode}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          // 44pt hit target on touch via the surrounding row's h-10 + the chip's
          // padding-y; the visible chip is small + muted to keep the header calm.
          className="flex h-8 min-h-8 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-11"
        >
          <ActiveIcon className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">
            Sort: {GROUP_SORT_LABEL[sortMode]}
          </span>
          <span className="sm:hidden">{GROUP_SORT_LABEL[sortMode]}</span>
          <span aria-hidden className="opacity-60">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-52">
        {GROUP_SORT_MODES.map((mode) => {
          const Icon = MODE_ICON[mode]
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

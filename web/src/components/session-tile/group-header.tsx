// GroupHeader — the thin labelled section divider shown ONLY in custom-sort
// mode. Inline-renameable (click the label, type, blur/Enter to commit),
// delete via context menu, drag handle on the left for reordering with the
// rest of the items via @dnd-kit.
//
// Visual language: matches the existing "small chrome" feel — h-10 row,
// 11px uppercase-but-tracking-tight label (sentence case actually, per the
// anti-vision rule against UPPERCASE — we use medium font + tracking-wide
// for visual weight without screaming).
//
// The count is the live number of sessions in the group (computed by the
// parent so this component stays pure).

import * as React from 'react'
import { GripVertical, Trash2 } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface GroupHeaderProps {
  /** Stable id used as the dnd-kit sortable key + group identity. */
  id: string
  name: string
  /** Live session count inside the group (sessions until the next group / EOL). */
  count: number
  /** Drag-handle listener props from useSortable (or `null` if drag disabled,
   *  e.g. while a name edit is active). */
  dragListeners?: React.HTMLAttributes<HTMLButtonElement> | null
  onRename: (next: string) => void
  onDelete: () => void
}

export function GroupHeader({
  name,
  count,
  dragListeners,
  onRename,
  onDelete,
}: GroupHeaderProps) {
  // Editing-mode state. `draftRef` lets us read the input value at blur/commit
  // time without re-rendering on every keystroke (the input is uncontrolled
  // while editing, so a parent re-render mid-typing — say from a peer SSE
  // tick — never overwrites in-progress text). On enter-edit we seed the
  // input via `defaultValue`; on exit-edit React unmounts it.
  const [editing, setEditing] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

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

  return (
    // role="group" gives screen readers the right semantic. The row sits
    // INSIDE the main grid (col-span-full on the parent wrapper) so it acts
    // as a section divider that wraps across tile columns.
    <div
      role="group"
      aria-label={`Group: ${name} (${count})`}
      className="group flex h-10 items-center gap-1.5 border-b border-border/40 pl-1 pr-1.5"
    >
      {/* Drag handle — 44pt hit area via h-10 even though the icon is small.
          Cursor changes to indicate draggability; spring-friendly hover-only
          styling. Hidden on touch is wrong here — touch users still need to
          long-press the handle to start drag. */}
      <button
        type="button"
        aria-label={`Drag group ${name}`}
        title="Drag to reorder"
        // Spread the dnd-kit listeners onto the handle so only this button
        // initiates a drag — the label remains clickable for rename.
        {...(dragListeners ?? {})}
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground/40 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-none"
        // Stop the click from bubbling into rename-on-label-click below.
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="size-4" aria-hidden />
      </button>

      {editing ? (
        <input
          ref={inputRef}
          defaultValue={name}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          aria-label="Group name"
          className="min-w-0 flex-1 rounded border border-input bg-transparent px-2 py-1 text-base md:text-sm font-medium tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          // The label is the primary affordance — full row width so the click
          // target is generous, but inner content is text-sized.
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

      {/* Per-group menu — delete only, since rename is inline. Stays a tiny
          icon-button so the row chrome is minimal. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More actions for ${name}`}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground/40 opacity-0 transition-opacity hover:text-muted-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
            // On touch the menu trigger is always discoverable (no hover).
            style={{ opacity: undefined }}
          >
            <span className="text-base leading-none">⋯</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6}>
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDelete}>
            <Trash2 className="size-4" aria-hidden />
            Delete group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

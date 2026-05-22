// M16 — <ManageSheet />: edit the keyboard-accessory groups.
//
// A Vaul full-height sheet (consistent with focus-mode/specials-sheet.tsx) that
// opens from the Settings (gear) chip on the accessory bar. Per TECH_PLAN §M16
// + research/termius-ios-native-spec.md §"Swipeable 4-key accessory groups"
// edit-mode bullet:
//   • All groups listed with drag handles (`framer-motion` `Reorder.Group`).
//   • Within a group: tap a key chip to edit its label inline.
//   • `+` adds a new group (4 blank-ish keys); `−` removes a group.
//   • Grab haptic = medium (`navigator.vibrate(15)`); drop = light
//     (`navigator.vibrate(8)`) — Android only, documented no-op on iOS Safari.
//
// Persistence is TABLE-BACKED and SINGLE-CANONICAL: every reorder / add / remove
// / edit funnels into ONE `replaceKbdGroups` PUT of the whole list (M9 table;
// NO new migration). The body is keyed by `open` so the local draft always
// starts fresh from the server list — no sync setState-in-effect.

import * as React from 'react'
import { Drawer } from 'vaul'
import { Reorder, useDragControls, motion } from 'framer-motion'
import { GripVertical, Plus, Trash2, Check } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { KbdGroup } from '@/lib/api'
import { useReplaceKbdGroups } from '@/hooks/use-kbd-groups'

/** Medium grab haptic — Android only; documented no-op on iOS Safari (§4.4). */
function grabHaptic(): void {
  if ('vibrate' in navigator) navigator.vibrate(15)
}
/** Light drop haptic — Android only; no-op on iOS Safari. */
function dropHaptic(): void {
  if ('vibrate' in navigator) navigator.vibrate(8)
}

export interface ManageSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Current ordered group list (from `useKbdGroups`). */
  groups: KbdGroup[]
}

export function ManageSheet({ open, onOpenChange, groups }: ManageSheetProps) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[70] bg-black/40" />
        <Drawer.Content
          aria-describedby={undefined}
          className={cn(
            'glass fixed inset-x-0 bottom-0 top-12 z-[70] flex flex-col rounded-t-[10px]',
            'border-t border-border/60 pb-safe outline-none',
          )}
        >
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
          <Drawer.Title className="px-4 pb-1 pt-3 text-[15px] font-semibold">
            Manage keys
          </Drawer.Title>
          {/* Keyed by `open` so the draft is fresh from the server each open. */}
          {open && <ManageBody key={String(open)} groups={groups} />}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

// ── Editable body ─────────────────────────────────────────────────────────────

function ManageBody({ groups }: { groups: KbdGroup[] }) {
  const [draft, setDraft] = React.useState<KbdGroup[]>(groups)
  const replace = useReplaceKbdGroups()

  // Single canonical commit — the whole list, every mutation type.
  const commit = React.useCallback(
    (next: KbdGroup[]) => {
      setDraft(next)
      replace.mutate(next)
    },
    [replace],
  )

  const editKey = (gi: number, ki: number, value: string) => {
    commit(
      draft.map((g, i) =>
        i === gi
          ? { ...g, keys: g.keys.map((k, j) => (j === ki ? value : k)) }
          : g,
      ),
    )
  }

  const removeGroup = (gi: number) => {
    dropHaptic()
    commit(draft.filter((_, i) => i !== gi))
  }

  const addGroup = () => {
    grabHaptic()
    const id = `group-${Date.now().toString(36)}`
    commit([
      ...draft,
      { id, name: `Group ${draft.length + 1}`, keys: ['Esc', 'Tab', '~', '|'] },
    ])
  }

  const renameGroup = (gi: number, name: string) => {
    commit(draft.map((g, i) => (i === gi ? { ...g, name } : g)))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <Reorder.Group
          axis="y"
          values={draft}
          onReorder={(next) => commit(next)}
          className="flex flex-col gap-3"
        >
          {draft.map((g, gi) => (
            <GroupRow
              key={g.id}
              group={g}
              onRename={(name) => renameGroup(gi, name)}
              onEditKey={(ki, v) => editKey(gi, ki, v)}
              onRemove={draft.length > 1 ? () => removeGroup(gi) : undefined}
            />
          ))}
        </Reorder.Group>

        {/* `+` add a new group. */}
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          transition={springs.buttonPress}
          onClick={addGroup}
          className={cn(
            'mt-3 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg',
            'border border-dashed border-border text-[13px] font-medium text-muted-foreground',
            'active:bg-secondary',
          )}
        >
          <Plus className="size-4" />
          Add group
        </motion.button>
      </div>
    </div>
  )
}

// ── One reorderable group: drag handle + name + 4 editable key chips ──────────

function GroupRow({
  group,
  onRename,
  onEditKey,
  onRemove,
}: {
  group: KbdGroup
  onRename: (name: string) => void
  onEditKey: (ki: number, value: string) => void
  onRemove?: () => void
}) {
  const controls = useDragControls()

  return (
    <Reorder.Item
      value={group}
      dragListener={false}
      dragControls={controls}
      className="rounded-xl border border-border bg-card p-2.5"
    >
      <div className="flex items-center gap-2">
        {/* Drag handle — ≥44 pt hit target; medium grab haptic on pointerdown. */}
        <button
          type="button"
          aria-label={`Reorder ${group.name}`}
          onPointerDown={(e) => {
            grabHaptic()
            controls.start(e)
          }}
          className="flex size-11 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-5" />
        </button>

        <input
          value={group.name}
          onChange={(e) => onRename(e.target.value)}
          aria-label="Group name"
          className="h-9 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 text-[13px] font-semibold outline-none focus:border-border focus:bg-background"
        />

        {/* `−` remove this group (kept ≥44 pt; hidden when only one remains). */}
        {onRemove && (
          <button
            type="button"
            aria-label={`Remove ${group.name}`}
            onClick={onRemove}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-destructive active:bg-destructive/10"
          >
            <Trash2 className="size-[18px]" />
          </button>
        )}
      </div>

      {/* The 4 editable key chips — tap to edit the label / tmux key name. */}
      <div className="mt-1.5 flex items-center gap-1.5">
        {group.keys.slice(0, 4).map((key, ki) => (
          <KeyEditChip
            key={ki}
            value={key}
            onCommit={(v) => onEditKey(ki, v)}
          />
        ))}
      </div>
    </Reorder.Item>
  )
}

/** A key chip in edit mode: tap → becomes an inline text field; the visible
 *  surface stays ≥44 pt tall (HIG) in both states. */
function KeyEditChip({
  value,
  onCommit,
}: {
  value: string
  onCommit: (value: string) => void
}) {
  const [editing, setEditing] = React.useState(false)
  const [text, setText] = React.useState(value)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const finish = () => {
    setEditing(false)
    const next = text.trim()
    if (next && next !== value) onCommit(next)
    else setText(value)
  }

  if (editing) {
    return (
      <div className="flex min-h-11 flex-1 items-center gap-1">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finish()
            if (e.key === 'Escape') {
              setText(value)
              setEditing(false)
            }
          }}
          aria-label="Key label"
          className="h-11 w-full rounded-lg border border-primary/60 bg-background px-1.5 text-center font-mono text-[13px] font-semibold outline-none focus:ring-2 focus:ring-ring"
        />
        <span className="text-primary" aria-hidden>
          <Check className="size-4" />
        </span>
      </div>
    )
  }

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.96 }}
      transition={springs.buttonPress}
      onClick={() => {
        setText(value)
        setEditing(true)
      }}
      aria-label={`Edit key ${value}`}
      className="flex min-h-11 flex-1 items-center justify-center px-1 py-1.5"
    >
      <span className="flex h-8 w-full items-center justify-center rounded-lg border border-border bg-secondary font-mono text-[13px] font-semibold text-secondary-foreground active:bg-secondary/70">
        {value}
      </span>
    </motion.button>
  )
}

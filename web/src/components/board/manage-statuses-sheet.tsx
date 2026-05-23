import { useState } from 'react'
import { Reorder, useDragControls } from 'framer-motion'
import { GripVertical, Lock, Plus, Trash2 } from 'lucide-react'

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { BoardStatus } from '@/lib/api'

export interface ManageStatusesSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  statuses: BoardStatus[]
  onCreate: (label: string) => Promise<void>
  onRename: (id: string, label: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onReorder: (order: string[]) => Promise<void>
}

/**
 * Column (status) management sheet (TECH_PLAN §M19): reorder columns by dragging
 * (Framer Motion `Reorder.Group`), rename inline, add custom columns, remove
 * non-builtin ones. Built-in columns are protected (lock icon, no delete). The
 * body is keyed by open so the local drag order starts fresh from the server
 * order each open (no sync setState-in-effect).
 */
export function ManageStatusesSheet({
  open,
  onOpenChange,
  statuses,
  onCreate,
  onRename,
  onDelete,
  onReorder,
}: ManageStatusesSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-sm">
        {open && (
          <ManageStatusesBody
            statuses={statuses}
            onCreate={onCreate}
            onRename={onRename}
            onDelete={onDelete}
            onReorder={onReorder}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function ManageStatusesBody({
  statuses,
  onCreate,
  onRename,
  onDelete,
  onReorder,
}: {
  statuses: BoardStatus[]
  onCreate: (label: string) => Promise<void>
  onRename: (id: string, label: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onReorder: (order: string[]) => Promise<void>
}) {
  const [order, setOrder] = useState<BoardStatus[]>(statuses)
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function commitReorder(next: BoardStatus[]) {
    setOrder(next)
    setError(null)
    try {
      await onReorder(next.map((s) => s.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reorder.')
    }
  }

  async function add() {
    const label = newLabel.trim()
    if (!label) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(label)
      setNewLabel('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the column.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>Columns</SheetTitle>
        <SheetDescription>
          Drag to reorder. Built-in columns can be renamed but not removed.
        </SheetDescription>
      </SheetHeader>

      <Reorder.Group
        axis="y"
        values={order}
        onReorder={(next) => void commitReorder(next as BoardStatus[])}
        className="flex flex-col gap-2 py-4"
      >
        {order.map((status) => (
          <StatusRow
            key={status.id}
            status={status}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </Reorder.Group>

      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
        <span className="text-xs font-medium text-muted-foreground">
          Add a column
        </span>
        <div className="flex gap-2">
          <Input
            value={newLabel}
            placeholder="Column name"
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
            }}
          />
          <Button onClick={() => void add()} disabled={busy || !newLabel.trim()}>
            <Plus className="size-4" />
            Add
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </>
  )
}

function StatusRow({
  status,
  onRename,
  onDelete,
}: {
  status: BoardStatus
  onRename: (id: string, label: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const controls = useDragControls()
  // Keyed remount (parent re-keys on status changes via the server list) means
  // the prop is a safe initial value — no sync effect needed.
  const [label, setLabel] = useState(status.label)
  const builtin = status.is_builtin !== 0

  return (
    <Reorder.Item
      value={status}
      dragListener={false}
      dragControls={controls}
      className="flex items-center gap-2 rounded-md border border-border bg-background/80 p-2"
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        onPointerDown={(e) => controls.start(e)}
        className="grid size-8 shrink-0 cursor-grab touch-none place-items-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </button>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => {
          const trimmed = label.trim()
          if (trimmed && trimmed !== status.label) void onRename(status.id, trimmed)
          else setLabel(status.label)
        }}
        className="h-8 flex-1 rounded-md bg-transparent px-2 text-base md:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {builtin ? (
        <span
          aria-label="Built-in column"
          className="grid size-8 place-items-center text-muted-foreground/60"
        >
          <Lock className="size-3.5" />
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Delete ${status.label} column`}
          onClick={() => void onDelete(status.id)}
          className="grid size-8 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
      )}
    </Reorder.Item>
  )
}

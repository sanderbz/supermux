import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ClipboardList, Plus, Settings } from 'lucide-react'

import { EmptyStatePlaceholder } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useBoard, sortIssues } from '@/hooks/use-board'
import { useStartAgent, claimErrorMessage } from '@/hooks/use-send-to-agent'
import { type BoardIssue } from '@/lib/api'
import { IssueCard } from '@/components/board/issue-card'
import { NewIssueDialog } from '@/components/board/new-issue-dialog'
import { IssueDetailSheet } from '@/components/board/issue-detail-sheet'
import { ManageStatusesSheet } from '@/components/board/manage-statuses-sheet'
import { BoardSkeleton } from '@/components/board/board-skeleton'
import { midpointPos } from '@/components/board/pos'

interface Toast {
  id: number
  message: string
  tone: 'error' | 'info'
}

/** The drop slot resolved from dnd-kit's `over` target: a column id + the index
 *  the dragged card would land at within that column. Mirrors what the old
 *  custom controller's `computeDropTarget` produced, so `handleDrop` / midpoint
 *  pos / drag-to-doing logic are reused verbatim. */
interface DropSlot {
  status: string
  index: number
}

export function Board() {
  const board = useBoard()
  const reduce = useReducedMotion()
  const { startAgent } = useStartAgent()

  // Track the OPEN issue by id (not a snapshot) so the detail sheet re-derives
  // from the live `board.issues` cache — comments / acceptance ticks / links
  // that arrive over SSE update the open sheet in place. A snapshot would go
  // stale the moment the agent (or another tab) touched the card.
  const [detailId, setDetailId] = useState<string | null>(null)
  const [newIssueStatus, setNewIssueStatus] = useState<string | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])

  const pushToast = useCallback((message: string, tone: Toast['tone'] = 'error') => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev, { id, message, tone }])
    window.setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      3200,
    )
  }, [])

  // The live issue object for the open sheet, re-derived from the cache so SSE
  // pushes (agent comments, acceptance ticks, link adds) flow straight into the
  // open sheet. Null when nothing is open or the issue was deleted out from
  // under us.
  const detailIssue = useMemo(
    () => board.issues.find((i) => i.id === detailId) ?? null,
    [board.issues, detailId],
  )

  // Group issues by column. Non-deleted only (server already omits deleted).
  const issuesByStatus = useMemo(() => {
    const map = new Map<string, BoardIssue[]>()
    for (const s of board.statuses) map.set(s.id, [])
    for (const issue of board.issues) {
      if (!map.has(issue.status)) map.set(issue.status, [])
      map.get(issue.status)!.push(issue)
    }
    for (const [k, v] of map) map.set(k, sortIssues(v))
    return map
  }, [board.issues, board.statuses])

  // ── @dnd-kit drag controller (matches the overview's sensor setup) ──────────
  // MOUSE + TOUCH, never PointerSensor. On iOS Safari a single finger fires BOTH
  // `pointerdown` AND `touchstart`; a registered PointerSensor (no delay, small
  // distance) claims that pointer first, then `touch-action` lets the browser
  // begin native scrolling and fire `pointercancel` — aborting the would-be drag
  // before the TouchSensor's long-press can ever arm. Net: touch drag never
  // started on iOS. Splitting into a MouseSensor (mouse events only — ignores
  // touch entirely) + TouchSensor (touch events only) lets the long-press own
  // touch cleanly, exactly as the working overview route does. Desktop keeps a
  // small distance constraint so a click/tap-to-open never accidentally drags.
  const sensors = useSensors(
    useSensor(MouseSensor, {
      // 6px activation distance == the old DRAG_THRESHOLD, so a click on the card
      // (which opens the sheet) never accidentally starts a drag.
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      // 250ms long-press + 5px tolerance: a tap or a vertical scroll never
      // triggers a drag on mobile; an intentional press-and-hold lifts the card.
      // Matches the overview's TouchSensor (which uses 200ms) — slightly longer
      // here because the whole card is the grab target (no dedicated handle), so
      // a touch more dwell makes "lift vs scroll" unambiguous.
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  // The issue currently being dragged (drives the DragOverlay ghost). The id is
  // the issue id; we resolve the live issue from the cache.
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIssue = useMemo(
    () => board.issues.find((i) => i.id === activeId) ?? null,
    [board.issues, activeId],
  )
  // The resolved drop slot (column + index) for the live drag — drives the
  // column highlight + drop indicator, same visuals as before.
  const [dropTarget, setDropTarget] = useState<DropSlot | null>(null)

  // Resolve dnd-kit's `over` (a card id or a column id) into a {status, index}
  // drop slot. Dropping over a card → that card's column at the card's index;
  // dropping over a column's empty area → end of that column. Excludes the
  // dragged card from the index math so cross-list/in-list reorder lands right.
  const resolveDropSlot = useCallback(
    (activeIssueId: string, overId: string): DropSlot | null => {
      // `overId` is either a column id (droppable column) or an issue id (a
      // sortable card). Columns are registered under their status id; cards
      // under their issue id.
      if (issuesByStatus.has(overId)) {
        // Hovering the column container itself → append to the end (after any
        // existing cards, excluding the dragged one if it lives here).
        const list = (issuesByStatus.get(overId) ?? []).filter(
          (i) => i.id !== activeIssueId,
        )
        return { status: overId, index: list.length }
      }
      // Otherwise `overId` is a card — find its column + position.
      for (const [status, list] of issuesByStatus) {
        const idx = list.findIndex((i) => i.id === overId)
        if (idx === -1) continue
        // Insert at the hovered card's index. dnd-kit's sortable strategy keeps
        // the visual order honest while dragging; we land the card where the
        // placeholder sits. When dragging within the same column past the
        // dragged card's original slot, the filtered-list math in `handleDrop`
        // collapses any off-by-one, so a raw index is correct here.
        return { status, index: idx }
      }
      return null
    },
    [issuesByStatus],
  )

  const handleDrop = useCallback(
    async (issue: BoardIssue, toStatus: string, dropIndex: number) => {
      const samePlace =
        issue.status === toStatus &&
        isAtIndex(issuesByStatus.get(toStatus) ?? [], issue.id, dropIndex)
      if (samePlace) return

      // Compute the new midpoint pos in the target column (excluding the dragged
      // card if it already lives there).
      const targetList = (issuesByStatus.get(toStatus) ?? []).filter(
        (i) => i.id !== issue.id,
      )
      const clampedIndex = Math.max(0, Math.min(dropIndex, targetList.length))
      const newPos = midpointPos(
        targetList.map((i) => i.pos),
        clampedIndex,
      )

      // DRAG-TO-DOING → START AGENT: a card dragged out of `todo`/`backlog` INTO
      // `doing` runs the unified Start flow (BR1) rather than a bare status flip —
      // start makes the issue agent-owned, atomic-claims it (so two agents can't
      // both grab the same task), and auto-delivers the issue context into the
      // linked session via the steering deliver-loop. State drives the action, not
      // `owner_type`, so the affordance never needs the internal "claim" verb.
      //   • Live linked session → start + deliver. The card slides to `doing`
      //     optimistically; a "Sent to <session>" toast offers an Undo that
      //     retracts the still-undelivered steer (via the shared toast system).
      //   • NO linked session → DON'T error. Open the detail sheet so BR3's
      //     attach-or-spawn start picker handles it (pick a running agent, or
      //     spawn a new one in a chosen project). Drop the old "assign a session"
      //     dead-end entirely.
      const startable = issue.status === 'todo' || issue.status === 'backlog'
      if (startable && toStatus === 'doing') {
        const session = issue.session
        if (!session || !issue.session_live) {
          // No confidently-live session to deliver into → hand off to the sheet's
          // attach-or-spawn picker instead of a status-flip-with-a-nudge.
          setDetailId(issue.id)
          return
        }
        // The shared start-agent flow (start → toast → Undo). Drives start through
        // the board's OPTIMISTIC mutation so the card slides to `doing` and rolls
        // back on a lost race; the success toast + Undo come from the shared toast
        // system, while errors route through the route's own toaster for parity
        // with the other drag failures (plain language, never "claim").
        await startAgent({
          id: issue.id,
          session,
          start: (a) => board.startIssue(a),
          sentMessage: () => `Sent to ${session}`,
          sentDuration: 6000,
          assignedMessage: () => `Agent started on ${session}`,
          onUndoError: () =>
            pushToast('Already picked up — can’t undo.', 'info'),
          onError: (e) => pushToast(claimErrorMessage(e)),
        })
        return
      }

      try {
        await board.patchIssue(issue.id, { status: toStatus, pos: newPos })
      } catch (e) {
        pushToast(e instanceof Error ? e.message : 'Could not move the card.')
      }
    },
    [board, issuesByStatus, pushToast, startAgent],
  )

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveId(String(e.active.id))
  }, [])

  const handleDragOver = useCallback(
    (e: DragOverEvent) => {
      const { active, over } = e
      if (!over) {
        setDropTarget(null)
        return
      }
      setDropTarget(resolveDropSlot(String(active.id), String(over.id)))
    },
    [resolveDropSlot],
  )

  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    setDropTarget(null)
  }, [])

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e
      const issue = board.issues.find((i) => i.id === String(active.id))
      setActiveId(null)
      setDropTarget(null)
      if (!issue || !over) return
      const slot = resolveDropSlot(issue.id, String(over.id))
      if (!slot) return
      void handleDrop(issue, slot.status, slot.index)
    },
    [board.issues, handleDrop, resolveDropSlot],
  )

  // ── render ──────────────────────────────────────────────────────────────────
  if (board.isLoading) {
    return (
      <BoardPage onManage={() => setManageOpen(true)} hasColumns={false}>
        <BoardSkeleton />
      </BoardPage>
    )
  }

  if (board.isError) {
    return (
      <BoardPage onManage={() => setManageOpen(true)} hasColumns={false}>
        <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
          <p className="max-w-xs text-sm text-muted-foreground">
            Can’t reach supermux-server. Retrying…
          </p>
          <Button size="sm" variant="outline" onClick={board.refetch}>
            Retry now
          </Button>
        </div>
      </BoardPage>
    )
  }

  const isEmpty = board.issues.length === 0

  return (
    <>
      <BoardPage
        onManage={() => setManageOpen(true)}
        hasColumns={board.statuses.length > 0}
      >
        {isEmpty ? (
          <div className="flex h-full items-center justify-center">
            <EmptyStatePlaceholder
              icon={<ClipboardList />}
              message="Your board is clear."
              cta={{
                label: 'Add an issue',
                onClick: () =>
                  setNewIssueStatus(board.statuses[0]?.id ?? 'todo'),
              }}
            />
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={boardCollision}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div className="flex h-full gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]">
              {board.statuses.map((status) => {
                const list = issuesByStatus.get(status.id) ?? []
                return (
                  <BoardColumn
                    key={status.id}
                    status={status.id}
                    label={status.label}
                    list={list}
                    dropTarget={dropTarget}
                    activeId={activeId}
                    onAdd={() => setNewIssueStatus(status.id)}
                    onOpen={(i) => setDetailId(i.id)}
                  />
                )
              })}
            </div>

            {/* Floating drag ghost — dnd-kit's DragOverlay follows the pointer
                (and the keyboard sensor), replacing the old hand-rolled motion
                ghost. Spring scale/tilt on lift, reduced-motion safe. */}
            <DragOverlay dropAnimation={null}>
              {activeIssue ? (
                <motion.div
                  className="pointer-events-none"
                  initial={reduce ? false : { scale: 1 }}
                  animate={reduce ? {} : { scale: 1.04, rotate: -1.5 }}
                  transition={springs.cardExpand}
                >
                  <div className="rounded-[10px] border border-primary/40 bg-card p-3 shadow-2xl">
                    <span className="line-clamp-3 text-sm font-medium leading-snug">
                      {activeIssue.title}
                    </span>
                  </div>
                </motion.div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </BoardPage>

      {/* Toasts — a lost-race 409 from drag-to-start surfaces here, in plain
          language (the success "Sent to …" toast + Undo come from the shared
          toast system inside useStartAgent). */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={reduce ? false : { opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
              transition={springs.snappy}
              className={cn(
                'pointer-events-auto max-w-sm rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg',
                t.tone === 'error'
                  ? 'bg-destructive text-destructive-foreground'
                  : 'bg-card text-foreground border border-border',
              )}
            >
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <NewIssueDialog
        open={newIssueStatus !== null}
        onOpenChange={(o) => !o && setNewIssueStatus(null)}
        status={newIssueStatus ?? board.statuses[0]?.id ?? 'todo'}
        statusLabel={
          board.statuses.find((s) => s.id === newIssueStatus)?.label ?? 'Backlog'
        }
        onCreate={async (input) => {
          await board.createIssue(input)
        }}
      />

      {/* BR3's sheet drives Start internally (attach-or-spawn via useStartAgent /
          board.startIssue) and owns its own success toast + Undo + in-place 409,
          so the route no longer passes an `onClaim` — it only feeds the live
          issue + the patch/delete/status wiring. */}
      <IssueDetailSheet
        issue={detailIssue}
        statuses={board.statuses}
        onClose={() => setDetailId(null)}
        onPatch={async (id, patch) => {
          await board.patchIssue(id, patch)
        }}
        onDelete={async (id) => {
          await board.deleteIssue(id)
        }}
      />

      <ManageStatusesSheet
        open={manageOpen}
        onOpenChange={setManageOpen}
        statuses={board.statuses}
        onCreate={async (label) => {
          await board.createStatus(label)
        }}
        onRename={async (id, label) => {
          await board.renameStatus(id, label)
        }}
        onDelete={async (id) => {
          try {
            await board.deleteStatus(id)
          } catch (e) {
            pushToast(e instanceof Error ? e.message : 'Could not delete column.')
          }
        }}
        onReorder={async (order) => {
          await board.reorderStatuses(order)
        }}
      />
    </>
  )
}

/** A custom collision strategy: prefer the nearest card/column corner so the
 *  drop slot tracks the pointer cleanly across columns (the standard kanban
 *  choice — `closestCorners` reads better than `closestCenter` for tall lists
 *  of varying-height cards). */
const boardCollision: CollisionDetection = (args) => closestCorners(args)

/** One board column: a droppable container that also hosts a vertical
 *  SortableContext for its cards. The whole column is droppable (so an empty
 *  column / the gap below the last card still accepts a drop), and each card is
 *  a sortable. Highlights + drop indicator are driven by the resolved
 *  `dropTarget` exactly as the old controller did. */
function BoardColumn({
  status,
  label,
  list,
  dropTarget,
  activeId,
  onAdd,
  onOpen,
}: {
  status: string
  label: string
  list: BoardIssue[]
  dropTarget: DropSlot | null
  activeId: string | null
  onAdd: () => void
  onOpen: (issue: BoardIssue) => void
}) {
  // The column itself is a droppable so dropping onto its empty area (or the
  // gap under the last card) resolves to this status. `data-column-id` is kept
  // for any external probes / tests that relied on it.
  const { setNodeRef } = useDroppable({ id: status })
  const isDropCol = dropTarget?.status === status
  const itemIds = useMemo(() => list.map((i) => i.id), [list])

  return (
    <section
      data-column-id={status}
      className={cn(
        'flex w-[280px] shrink-0 flex-col rounded-xl border bg-card/40 transition-colors',
        isDropCol ? 'border-primary/60 bg-primary/5' : 'border-border',
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <h2 className="flex-1 text-sm font-semibold tracking-tight">{label}</h2>
        <span className="rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground">
          {list.length}
        </span>
        <button
          type="button"
          aria-label={`Add issue to ${label}`}
          onClick={onAdd}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      </header>
      {/* `touch-action: pan-x pan-y` (Tailwind `touch-pan-x touch-pan-y`) permits
          BOTH native scroll axes on this list: a vertical swipe scrolls the
          column (`overflow-y-auto`), and a horizontal swipe — which this list
          can't consume — bubbles up to the board's outer `overflow-x-auto` so
          columns scroll sideways on mobile (the regression: `pan-y` alone
          trapped horizontal swipes that started on a column). The TouchSensor's
          250ms long-press still claims a deliberate press-and-hold for a card
          drag, so drag-vs-scroll from 7bf3e7f stays intact. */}
      <div
        ref={setNodeRef}
        className="flex flex-1 touch-pan-x touch-pan-y flex-col gap-2 overflow-y-auto px-2 pb-2 [scrollbar-width:thin]"
      >
        {list.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-2 py-6 text-center text-xs text-muted-foreground/60">
            {isDropCol ? 'Drop here' : 'No issues'}
          </div>
        ) : (
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            <AnimatePresence initial={false}>
              {list.map((issue, idx) => (
                <div key={issue.id} className="flex flex-col gap-2">
                  {isDropCol && dropTarget?.index === idx && <DropIndicator />}
                  <SortableIssueCard
                    issue={issue}
                    activeId={activeId}
                    onOpen={onOpen}
                  />
                  {isDropCol &&
                    dropTarget?.index === idx + 1 &&
                    idx === list.length - 1 && <DropIndicator />}
                </div>
              ))}
            </AnimatePresence>
          </SortableContext>
        )}
      </div>
    </section>
  )
}

/** A board card wrapped in dnd-kit's `useSortable`. The whole card is the grab
 *  target (no separate handle): on desktop a 6px press-move drags; on touch a
 *  250ms press-and-hold lifts it (a quick swipe scrolls the column instead).
 *  The card's own inner buttons (Start / Open / Stop) stop pointer propagation
 *  already, so they keep working as taps without arming a drag.
 *
 *  We spread `attributes` + `listeners` and let IssueCard render the card body;
 *  the card's existing `onClick` opens the detail sheet (dnd-kit suppresses the
 *  click when a drag actually fired, so tap-to-open and drag stay distinct). */
function SortableIssueCard({
  issue,
  activeId,
  onOpen,
}: {
  issue: BoardIssue
  activeId: string | null
  onOpen: (issue: BoardIssue) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id })
  // The transform + ref live on this wrapper (not the card's motion root) so the
  // sortable's CSS transform never fights framer-motion's `whileTap` scale or the
  // card's `layoutId` focus-route morph. The wrapper tightly boxes the card, so
  // dnd-kit measures the same rect.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
  }
  return (
    <div ref={setNodeRef} style={style}>
      <IssueCard
        dragAttributes={attributes}
        dragListeners={listeners}
        issue={issue}
        onOpen={onOpen}
        // The source card dims while its overlay ghost floats (matches the old
        // `drag?.issue.id === issue.id` behaviour). dnd-kit reports `isDragging`
        // per sortable; `activeId` is a belt-and-suspenders for the overlay state.
        isDragging={isDragging || activeId === issue.id}
      />
    </div>
  )
}

/** Page chrome: title row with a "Columns" gear. Unlike the shared `<Page>`
 *  (which vertically centres its child), the board fills the full height so the
 *  columns scroll inside the viewport. */
function BoardPage({
  children,
  onManage,
  hasColumns,
}: {
  children: React.ReactNode
  onManage: () => void
  hasColumns: boolean
}) {
  return (
    // R5: the shared mobile top bar was removed, so this container owns the
    // safe-area top inset on mobile (≤md) — folded into the top padding via an
    // arbitrary `calc(env(safe-area-inset-top)+1.5rem)` so the title clears the
    // notch / Dynamic Island. `sm:pt-6` restores the normal inset once the
    // desktop SideNav owns the chrome. Mirrors overview.tsx.
    <div className="mx-auto flex h-full w-full max-w-none flex-col px-4 py-6 pt-[calc(env(safe-area-inset-top)+1.5rem)] sm:px-6 sm:pt-6">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="flex-1 text-2xl font-semibold tracking-tight">Board</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={onManage}
          disabled={!hasColumns}
        >
          <Settings className="size-4" />
          Columns
        </Button>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

function DropIndicator() {
  return (
    <motion.div
      layout
      className="h-0.5 rounded-full bg-primary"
      transition={springs.snappy}
    />
  )
}

/** True if `id` already occupies `index` in `list` (used to skip no-op drops). */
function isAtIndex(list: BoardIssue[], id: string, index: number): boolean {
  return list[index]?.id === id
}

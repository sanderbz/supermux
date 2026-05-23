import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
} from 'framer-motion'
import { ClipboardList, Plus, Settings } from 'lucide-react'

import { EmptyStatePlaceholder } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useBoard, sortIssues } from '@/hooks/use-board'
import { BoardError, type BoardIssue } from '@/lib/api'
import { IssueCard } from '@/components/board/issue-card'
import { NewIssueDialog } from '@/components/board/new-issue-dialog'
import { IssueDetailSheet } from '@/components/board/issue-detail-sheet'
import { ManageStatusesSheet } from '@/components/board/manage-statuses-sheet'
import { BoardSkeleton } from '@/components/board/board-skeleton'
import { midpointPos } from '@/components/board/pos'

// A move is interpreted as a drag (not a tap) only past this pointer distance.
const DRAG_THRESHOLD = 6

interface DragState {
  issue: BoardIssue
  /** Pointer offset within the card at grab time (keeps the ghost under the cursor). */
  offsetX: number
  offsetY: number
  width: number
  height: number
}

interface Toast {
  id: number
  message: string
  tone: 'error' | 'info'
}

export function Board() {
  const board = useBoard()
  const reduce = useReducedMotion()

  const [detailIssue, setDetailIssue] = useState<BoardIssue | null>(null)
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

  // ── cross-column drag controller (pointer-based, spring-physics ghost) ──────
  const [drag, setDrag] = useState<DragState | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    status: string
    index: number
  } | null>(null)
  const ghostX = useMotionValue(0)
  const ghostY = useMotionValue(0)
  const candidate = useRef<{
    issue: BoardIssue
    startX: number
    startY: number
    rect: DOMRect
    moved: boolean
  } | null>(null)

  const computeDropTarget = useCallback(
    (clientX: number, clientY: number) => {
      const colEl = document
        .elementsFromPoint(clientX, clientY)
        .find((el) => el instanceof HTMLElement && el.dataset.columnId) as
        | HTMLElement
        | undefined
      if (!colEl) return null
      const status = colEl.dataset.columnId!
      // Find insert index by comparing pointer Y to each card's vertical centre.
      const cards = Array.from(
        colEl.querySelectorAll<HTMLElement>('[data-issue-id]'),
      )
      let index = cards.length
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect()
        if (clientY < r.top + r.height / 2) {
          index = i
          break
        }
      }
      return { status, index }
    },
    [],
  )

  const onCardDragStart = useCallback(
    (issue: BoardIssue, e: React.PointerEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      candidate.current = {
        issue,
        startX: e.clientX,
        startY: e.clientY,
        rect,
        moved: false,
      }
    },
    [],
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

      // DRAG-TO-CLAIM: an agent-owned card moved out of todo/backlog INTO `doing`
      // goes through the ATOMIC claim endpoint (§3.2.10), not a plain status
      // PATCH. This is the headline board behaviour: two agents can't both grab
      // the same task.
      const wasClaimable =
        issue.owner_type === 'agent' &&
        (issue.status === 'todo' || issue.status === 'backlog')
      if (wasClaimable && toStatus === 'doing') {
        const session = issue.session
        if (!session) {
          pushToast('Assign a session before claiming this task.', 'info')
          return
        }
        try {
          await board.claimIssue({ id: issue.id, session })
        } catch (e) {
          if (e instanceof BoardError && e.status === 409) {
            pushToast(e.message || 'Claim lost — another session took it.')
          } else {
            pushToast(e instanceof Error ? e.message : 'Claim failed.')
          }
        }
        return
      }

      try {
        await board.patchIssue(issue.id, { status: toStatus, pos: newPos })
      } catch (e) {
        pushToast(e instanceof Error ? e.message : 'Could not move the card.')
      }
    },
    [board, issuesByStatus, pushToast],
  )

  // Global pointer move/up while a drag is in flight or pending.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const cand = candidate.current
      if (!cand) return
      const dx = e.clientX - cand.startX
      const dy = e.clientY - cand.startY
      if (!cand.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        cand.moved = true
        setDrag({
          issue: cand.issue,
          offsetX: cand.startX - cand.rect.left,
          offsetY: cand.startY - cand.rect.top,
          width: cand.rect.width,
          height: cand.rect.height,
        })
      }
      ghostX.set(e.clientX - (cand.startX - cand.rect.left))
      ghostY.set(e.clientY - (cand.startY - cand.rect.top))
      setDropTarget(computeDropTarget(e.clientX, e.clientY))
    }

    function onUp(e: PointerEvent) {
      const cand = candidate.current
      candidate.current = null
      if (!cand) return
      const wasDragging = cand.moved
      setDrag(null)
      const target = computeDropTarget(e.clientX, e.clientY)
      setDropTarget(null)
      if (!wasDragging || !target) return // a tap → onClick handles it
      void handleDrop(cand.issue, target.status, target.index)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [computeDropTarget, handleDrop, ghostX, ghostY])

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
          <div className="flex h-full gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]">
            {board.statuses.map((status) => {
              const list = issuesByStatus.get(status.id) ?? []
              const isDropCol = dropTarget?.status === status.id
              return (
                <section
                  key={status.id}
                  data-column-id={status.id}
                  className={cn(
                    'flex w-[280px] shrink-0 flex-col rounded-xl border bg-card/40 transition-colors',
                    isDropCol
                      ? 'border-primary/60 bg-primary/5'
                      : 'border-border',
                  )}
                >
                  <header className="flex items-center gap-2 px-3 py-2.5">
                    <h2 className="flex-1 text-sm font-semibold tracking-tight">
                      {status.label}
                    </h2>
                    <span className="rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground">
                      {list.length}
                    </span>
                    <button
                      type="button"
                      aria-label={`Add issue to ${status.label}`}
                      onClick={() => setNewIssueStatus(status.id)}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Plus className="size-4" />
                    </button>
                  </header>
                  <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 [scrollbar-width:thin]">
                    {list.length === 0 ? (
                      <div className="flex flex-1 items-center justify-center px-2 py-6 text-center text-xs text-muted-foreground/60">
                        {isDropCol ? 'Drop here' : 'No issues'}
                      </div>
                    ) : (
                      <AnimatePresence initial={false}>
                        {list.map((issue, idx) => (
                          <div key={issue.id} className="flex flex-col gap-2">
                            {isDropCol && dropTarget?.index === idx && (
                              <DropIndicator />
                            )}
                            <IssueCard
                              issue={issue}
                              onOpen={setDetailIssue}
                              isDragging={drag?.issue.id === issue.id}
                              onDragStart={onCardDragStart}
                            />
                            {isDropCol &&
                              dropTarget?.index === idx + 1 &&
                              idx === list.length - 1 && <DropIndicator />}
                          </div>
                        ))}
                      </AnimatePresence>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </BoardPage>

      {/* Floating drag ghost — follows the pointer with spring physics. */}
      <AnimatePresence>
        {drag && (
          <motion.div
            className="pointer-events-none fixed left-0 top-0 z-[60]"
            style={{ x: ghostX, y: ghostY, width: drag.width }}
            initial={reduce ? false : { scale: 1 }}
            animate={reduce ? {} : { scale: 1.04, rotate: -1.5 }}
            exit={reduce ? {} : { scale: 1 }}
            transition={springs.cardExpand}
          >
            <div className="rounded-[10px] border border-primary/40 bg-card p-3 shadow-2xl">
              <span className="line-clamp-3 text-sm font-medium leading-snug">
                {drag.issue.title}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toasts (atomic-claim 409 surfaces here, visibly). */}
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

      <IssueDetailSheet
        issue={detailIssue}
        statuses={board.statuses}
        onClose={() => setDetailIssue(null)}
        onPatch={async (id, patch) => {
          await board.patchIssue(id, patch)
        }}
        onDelete={async (id) => {
          await board.deleteIssue(id)
        }}
        onClaim={async (id, session) => {
          try {
            await board.claimIssue({ id, session })
            pushToast(`Claimed for ${session}.`, 'info')
          } catch (e) {
            if (e instanceof BoardError && e.status === 409) {
              pushToast(e.message || 'Claim lost — another session took it.')
            }
            throw e
          }
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

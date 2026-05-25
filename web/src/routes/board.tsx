import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
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

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import {
  useBoard,
  useBoards,
  useSelectedBoard,
  sortIssues,
} from '@/hooks/use-board'
import { useStartAgent, claimErrorMessage } from '@/hooks/use-send-to-agent'
import { useToast } from '@/components/ui/use-toast'
import { useNavigateMorph } from '@/components/view-transitions/morph'
import {
  ALL_BOARD_ID,
  MAIN_BOARD_ID,
  type BoardIssue,
  type NewBoardIssue,
} from '@/lib/api'
import { BoardCard } from '@/components/board/board-card'
import { BoardComposer } from '@/components/board/board-composer'
import { BoardCardEditor } from '@/components/board/board-card-editor'
import { BoardDetailPane } from '@/components/board/board-detail-pane'
import { BoardSkeleton } from '@/components/board/board-skeleton'
import { BoardSwitcher } from '@/components/board/board-switcher'
import { midpointPos } from '@/components/board/pos'
import { useMediaQuery } from '@/hooks/use-media-query'

/** The three fixed lanes (BM2 §1). No add/rename/delete column UI — these are
 *  the whole board. Lane ids map to the backend column ids {todo,doing,done}. */
type Lane = 'todo' | 'doing' | 'done'
const LANES: { id: Lane; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' },
]

/** The Done lane is condensed: show the most-recent N, then a "Show all". */
const DONE_PREVIEW = 6

interface DropSlot {
  lane: Lane
  index: number
}

export function Board() {
  // ── multi-board selection (AT-C, plan §5.5) ─────────────────────────────────
  const { boards } = useBoards()
  const [selectedBoard, setSelectedBoard] = useSelectedBoard()
  // A persisted selection can point at a board that was since deleted (e.g. a
  // team board). Fall back to Main so the view never shows an empty/404 board.
  // `'all'` is always valid (it's synthetic, not a row).
  const boardExists =
    selectedBoard === ALL_BOARD_ID ||
    boards.length === 0 || // boards still loading — trust the selection for now
    boards.some((b) => b.id === selectedBoard)
  const activeBoardId = boardExists ? selectedBoard : MAIN_BOARD_ID
  const isAll = activeBoardId === ALL_BOARD_ID

  const board = useBoard(activeBoardId)
  const reduce = useReducedMotion()
  const { startAgent } = useStartAgent()
  const { toast } = useToast()
  const navigateMorph = useNavigateMorph()

  const [editId, setEditId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAllDone, setShowAllDone] = useState(false)

  // A fine pointer (desktop trackpad/mouse) → the master–detail pane is shown
  // (lg+ in the layout); a coarse pointer (touch) → the existing edit sheet.
  // Drives the card-tap fork below at the ROUTE level so the card click handlers
  // stay untouched.
  const fine = useMediaQuery('(pointer: fine)')

  // The live card behind the open editor — re-derived from the cache so SSE
  // pushes (acceptance ticks, links) flow into the open sheet in place.
  const editIssue = useMemo(
    () => board.issues.find((i) => i.id === editId) ?? null,
    [board.issues, editId],
  )

  // The live card open in the desktop detail pane — re-derived from the cache
  // the same way, so live agent deltas (status, comments, acceptance, the live
  // tail) flow into the open pane in place. If the selected card disappears from
  // the cache this returns null and the pane empties gracefully.
  const selectedIssue = useMemo(
    () => board.issues.find((i) => i.id === selectedId) ?? null,
    [board.issues, selectedId],
  )

  // Esc clears the desktop selection (only meaningful when the pane is open).
  useEffect(() => {
    if (!selectedId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId])

  // AT-C "All" overview: a board id → name map for the grouped sub-headers.
  const boardNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const b of boards) m.set(b.id, b.name)
    if (!m.has(MAIN_BOARD_ID)) m.set(MAIN_BOARD_ID, 'Main')
    return m
  }, [boards])

  // Group issues into the three lanes. Anything in an unexpected/legacy column
  // (a leftover custom column the backend hasn't folded yet) is shown under
  // To do so no card is ever lost from view.
  const byLane = useMemo(() => {
    const map: Record<Lane, BoardIssue[]> = { todo: [], doing: [], done: [] }
    for (const issue of board.issues) {
      const lane: Lane =
        issue.status === 'doing'
          ? 'doing'
          : issue.status === 'done'
            ? 'done'
            : 'todo'
      map[lane].push(issue)
    }
    map.todo = sortIssues(map.todo)
    // Doing: attention cards (needs-input, then review) float to the top.
    map.doing = sortDoing(map.doing)
    // Done: newest first (recent work at the top of the condensed list).
    map.done = [...map.done].sort((a, b) => b.updated - a.updated)
    return map
  }, [board.issues])

  // ── @dnd-kit sensors (matches the overview setup; touch long-press) ─────────
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIssue = useMemo(
    () => board.issues.find((i) => i.id === activeId) ?? null,
    [board.issues, activeId],
  )
  const [dropTarget, setDropTarget] = useState<DropSlot | null>(null)

  const laneList = useCallback(
    (lane: Lane) => byLane[lane],
    [byLane],
  )

  // Resolve dnd-kit's `over` (lane id or card id) into a {lane, index} slot.
  const resolveDropSlot = useCallback(
    (activeIssueId: string, overId: string): DropSlot | null => {
      if (overId === 'todo' || overId === 'doing' || overId === 'done') {
        const list = laneList(overId).filter((i) => i.id !== activeIssueId)
        return { lane: overId, index: list.length }
      }
      for (const lane of LANES) {
        const list = laneList(lane.id)
        const idx = list.findIndex((i) => i.id === overId)
        if (idx !== -1) return { lane: lane.id, index: idx }
      }
      return null
    },
    [laneList],
  )

  // ── Start an agent on a To do card (spawn-by-default) ───────────────────────
  // No picker is forced: if the card already links a live session we deliver to
  // it; otherwise the server spawns a fresh session named from the card. The
  // card slides to Doing optimistically.
  const startIssue = useCallback(
    async (issue: BoardIssue, provider?: string) => {
      const hasLive = !!issue.session && issue.session_live
      await startAgent({
        id: issue.id,
        session: hasLive ? (issue.session as string) : undefined,
        // Spawn-by-default; honour the composer's agent pick (SD-3) when given.
        spawn: hasLive ? undefined : provider ? { provider } : {},
        start: (a) => board.startIssue(a),
        sentDuration: 6000,
        sentMessage: (r) =>
          r.issue.session ? `Started ${r.issue.session}` : 'Agent started',
        assignedMessage: (r) =>
          r.issue.session ? `Agent on ${r.issue.session}` : 'Agent started',
        assignedTone: 'active',
        onUndoError: () =>
          toast({ message: 'Already picked up — can’t undo', tone: 'default' }),
        onError: (e) =>
          toast({ message: claimErrorMessage(e), tone: 'error' }),
      })
    },
    [board, startAgent, toast],
  )

  // ── Reply inline into a Doing card's agent (THE headline UX) ────────────────
  const replyIssue = useCallback(
    async (issue: BoardIssue, text: string) => {
      try {
        await board.replyIssue(issue.id, text)
        toast({ message: `Sent to ${issue.session ?? 'the agent'}`, tone: 'active' })
      } catch (e) {
        toast({
          message: e instanceof Error ? e.message : 'Could not reach the agent',
          tone: 'error',
        })
        throw e
      }
    },
    [board, toast],
  )

  // ── Discard a card → undo toast (no confirm dialog) ─────────────────────────
  const discardIssue = useCallback(
    (issue: BoardIssue) => {
      if (editId === issue.id) setEditId(null)
      void board.discardIssue(issue.id).then(
        () =>
          toast({
            message: 'Task discarded',
            duration: 5000,
            action: {
              label: 'Undo',
              onClick: () => void board.restoreIssue(issue.id),
            },
          }),
        () => toast({ message: 'Could not discard the task', tone: 'error' }),
      )
    },
    [board, editId, toast],
  )

  const openFocus = useCallback(
    (issue: BoardIssue) => {
      if (!issue.session) {
        // No session to open yet — fall back to the editor.
        setEditId(issue.id)
        return
      }
      navigateMorph(`/focus/${issue.session}`)
    },
    [navigateMorph],
  )

  // ── Create handlers (description-first composer) ─────────────────────────────
  // A new card lands on the board currently in view. On the "All" aggregate
  // (which isn't a real board) new cards default to Main.
  const createBoardId = isAll ? MAIN_BOARD_ID : activeBoardId
  const onAdd = useCallback(
    async (input: NewBoardIssue) => {
      await board.createIssue({ ...input, status: 'todo', board_id: createBoardId })
    },
    [board, createBoardId],
  )
  const onAddAndStart = useCallback(
    async (input: NewBoardIssue, opts: { provider: string }) => {
      const created = await board.createIssue({
        ...input,
        status: 'todo',
        board_id: createBoardId,
      })
      await startIssue(created, opts.provider)
    },
    [board, startIssue, createBoardId],
  )

  // ── Drag → move / drag-to-Doing starts the agent ────────────────────────────
  const handleDrop = useCallback(
    async (issue: BoardIssue, toLane: Lane, dropIndex: number) => {
      const fromLane: Lane =
        issue.status === 'doing'
          ? 'doing'
          : issue.status === 'done'
            ? 'done'
            : 'todo'
      const samePlace =
        fromLane === toLane &&
        isAtIndex(laneList(toLane), issue.id, dropIndex)
      if (samePlace) return

      // To do → Doing runs Start (spawn-by-default), not a bare status flip.
      if (fromLane === 'todo' && toLane === 'doing') {
        await startIssue(issue)
        return
      }

      const targetList = laneList(toLane).filter((i) => i.id !== issue.id)
      const clampedIndex = Math.max(0, Math.min(dropIndex, targetList.length))
      const newPos = midpointPos(
        targetList.map((i) => i.pos),
        clampedIndex,
      )
      try {
        await board.patchIssue(issue.id, { status: toLane, pos: newPos })
      } catch (e) {
        toast({
          message: e instanceof Error ? e.message : 'Could not move the card',
          tone: 'error',
        })
      }
    },
    [board, laneList, startIssue, toast],
  )

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveId(String(e.active.id))
  }, [])
  const handleDragOver = useCallback(
    (e: DragOverEvent) => {
      const { active, over } = e
      if (!over) return setDropTarget(null)
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
      void handleDrop(issue, slot.lane, slot.index)
    },
    [board.issues, handleDrop, resolveDropSlot],
  )

  // The board-switcher next to the title (plan §5.5). Persisted selection; live
  // boards list via SSE. Shown in every render state so it's always reachable.
  const switcher = (
    <BoardSwitcher
      boards={boards}
      selected={activeBoardId}
      onSelect={setSelectedBoard}
    />
  )

  // ── render ──────────────────────────────────────────────────────────────────
  if (board.isLoading) {
    return (
      <BoardPage switcher={switcher}>
        <BoardSkeleton />
      </BoardPage>
    )
  }
  if (board.isError) {
    return (
      <BoardPage switcher={switcher}>
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

  return (
    <>
      <BoardPage switcher={switcher}>
        <DndContext
          sensors={sensors}
          collisionDetection={boardCollision}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <div className="flex h-full min-h-0 gap-4">
            <div
              className="flex h-full min-w-0 flex-1 gap-3 overflow-x-auto pb-2 [scrollbar-width:thin] lg:max-w-[1100px]"
              // Clicking the lane-row background (not a card) clears the desktop
              // selection. Cards stopPropagation on their own pointer/click, so
              // only true empty-space clicks reach here.
              onClick={(e) => {
                if (e.target === e.currentTarget) setSelectedId(null)
              }}
            >
              {LANES.map((lane) => (
                <LaneColumn
                  key={lane.id}
                  lane={lane.id}
                  label={lane.label}
                  list={laneList(lane.id)}
                  count={byLane[lane.id].length}
                  dropTarget={dropTarget}
                  activeId={activeId}
                  selectedId={selectedId}
                  showAllDone={showAllDone}
                  onShowAllDone={() => setShowAllDone(true)}
                  onDeselect={() => setSelectedId(null)}
                  composer={
                    // The "All" overview is read-through — the composer would
                    // create on Main (ambiguous), so hide it there.
                    lane.id === 'todo' && !isAll ? (
                      <BoardComposer onAdd={onAdd} onAddAndStart={onAddAndStart} />
                    ) : null
                  }
                  onOpen={(i) => (fine ? setSelectedId(i.id) : setEditId(i.id))}
                  onFocus={openFocus}
                  onStart={(i) => void startIssue(i)}
                  onReply={replyIssue}
                  onDiscard={discardIssue}
                  boardNameById={isAll ? boardNameById : undefined}
                />
              ))}
            </div>

            <BoardDetailPane
              className="hidden shrink-0 lg:flex lg:w-[460px] xl:w-[540px]"
              issue={selectedIssue}
              onClose={() => setSelectedId(null)}
              onEdit={(i) => setEditId(i.id)}
              onFocus={openFocus}
              onReply={replyIssue}
              onDiscard={discardIssue}
            />
          </div>

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
                    {activeIssue.title || activeIssue.desc.split('\n')[0] || activeIssue.id}
                  </span>
                </div>
              </motion.div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </BoardPage>

      <BoardCardEditor
        issue={editIssue}
        onClose={() => setEditId(null)}
        onPatch={async (id, patch) => {
          await board.patchIssue(id, patch)
        }}
        onDiscard={discardIssue}
        onStart={(i) => void startIssue(i)}
      />
    </>
  )
}

const boardCollision: CollisionDetection = (args) => closestCorners(args)

/** Sort the Doing lane so attention cards float to the top: needs-input first,
 *  then review, then everything else by pos (calm running). */
function sortDoing(list: BoardIssue[]): BoardIssue[] {
  const rank = (i: BoardIssue) =>
    i.awaiting_input ? 0 : i.needs_review ? 1 : 2
  return [...list].sort((a, b) => {
    const r = rank(a) - rank(b)
    if (r !== 0) return r
    if (a.pinned !== b.pinned) return b.pinned - a.pinned
    return a.pos - b.pos
  })
}

/** One lane: a droppable column hosting a vertical SortableContext. The To do
 *  lane renders the composer above its cards; the Done lane is condensed. */
function LaneColumn({
  lane,
  label,
  list,
  count,
  dropTarget,
  activeId,
  selectedId,
  showAllDone,
  onShowAllDone,
  onDeselect,
  composer,
  onOpen,
  onFocus,
  onStart,
  onReply,
  onDiscard,
  boardNameById,
}: {
  lane: Lane
  label: string
  list: BoardIssue[]
  count: number
  dropTarget: DropSlot | null
  activeId: string | null
  selectedId: string | null
  showAllDone: boolean
  onShowAllDone: () => void
  onDeselect: () => void
  composer: React.ReactNode
  onOpen: (issue: BoardIssue) => void
  onFocus: (issue: BoardIssue) => void
  onStart: (issue: BoardIssue) => void
  onReply: (issue: BoardIssue, text: string) => Promise<void>
  onDiscard: (issue: BoardIssue) => void
  /** AT-C "All" aggregate: a board id → name map. When present, the lane groups
   *  cards by board under a muted sub-header (read-through overview). When
   *  undefined, the lane renders a flat single-board list (the normal case). */
  boardNameById?: Map<string, string>
}) {
  const { setNodeRef } = useDroppable({ id: lane })
  const isDropCol = dropTarget?.lane === lane

  // Done is condensed: show the recent N unless "Show all" was tapped.
  const condensed = lane === 'done' && !showAllDone && list.length > DONE_PREVIEW
  const visible = condensed ? list.slice(0, DONE_PREVIEW) : list
  const itemIds = useMemo(() => visible.map((i) => i.id), [visible])

  // "All" aggregate: group the visible cards by board, preserving lane order.
  const grouped = useMemo(() => {
    if (!boardNameById) return null
    const order: string[] = []
    const byBoard = new Map<string, BoardIssue[]>()
    for (const issue of visible) {
      const bid = issue.board_id ?? 'main'
      if (!byBoard.has(bid)) {
        byBoard.set(bid, [])
        order.push(bid)
      }
      byBoard.get(bid)!.push(issue)
    }
    return order.map((bid) => ({
      boardId: bid,
      name: boardNameById.get(bid) ?? bid,
      items: byBoard.get(bid)!,
    }))
  }, [boardNameById, visible])

  return (
    <section
      data-column-id={lane}
      className={cn(
        'flex w-[300px] shrink-0 flex-col rounded-xl border bg-card/40 transition-colors',
        // Desktop (lg+): drop the fixed 300px for a comfortable fluid 300–360px
        // within the bounded left region, so 3 lanes spread across the width
        // instead of clustering with a dead right gutter. Mobile keeps w-[300px].
        'lg:w-auto lg:min-w-[300px] lg:max-w-[360px] lg:flex-1',
        isDropCol ? 'border-primary/60 bg-primary/5' : 'border-border',
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <h2 className="flex-1 text-sm font-semibold tracking-tight">{label}</h2>
        <span className="rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      </header>

      <div
        ref={setNodeRef}
        className="flex flex-1 touch-pan-x touch-pan-y flex-col gap-2 overflow-y-auto px-2 pb-2 [scrollbar-width:thin]"
        // Clicking the column's empty background clears the desktop selection.
        // Cards/controls stopPropagation, so only true empty-space taps reach here.
        onClick={(e) => {
          if (e.target === e.currentTarget) onDeselect()
        }}
      >
        {composer && <div className="px-0.5 pt-0.5">{composer}</div>}

        {visible.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-2 py-8 text-center text-xs text-muted-foreground/60">
            {isDropCol
              ? 'Drop here'
              : lane === 'todo'
                ? 'Add a task above'
                : lane === 'doing'
                  ? 'Start a task to put an agent on it'
                  : 'Finished work lands here'}
          </div>
        ) : grouped ? (
          // "All" overview: cards grouped by board under a muted sub-header. A
          // read-through overview, so cards aren't draggable here (cross-board
          // drag-to-start is ambiguous — switch to the team's own board to act).
          grouped.map((g) => (
            <div key={g.boardId} className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                <span className="truncate">{g.name}</span>
                <span className="tabular-nums opacity-70">{g.items.length}</span>
              </div>
              {g.items.map((issue) => (
                <BoardCard
                  key={issue.id}
                  issue={issue}
                  lane={lane}
                  draggable={false}
                  onOpen={onOpen}
                  onFocus={onFocus}
                  onStart={onStart}
                  onReply={onReply}
                  onDiscard={onDiscard}
                  isSelected={issue.id === selectedId}
                />
              ))}
            </div>
          ))
        ) : (
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            {visible.map((issue, idx) => (
              <div key={issue.id} className="flex flex-col gap-2">
                {isDropCol && dropTarget?.index === idx && <DropIndicator />}
                <SortableCard
                  issue={issue}
                  lane={lane}
                  activeId={activeId}
                  isSelected={issue.id === selectedId}
                  onOpen={onOpen}
                  onFocus={onFocus}
                  onStart={onStart}
                  onReply={onReply}
                  onDiscard={onDiscard}
                />
                {isDropCol &&
                  dropTarget?.index === idx + 1 &&
                  idx === visible.length - 1 && <DropIndicator />}
              </div>
            ))}
          </SortableContext>
        )}

        {condensed && (
          <button
            type="button"
            onClick={onShowAllDone}
            className="mx-auto mb-1 inline-flex h-11 items-center rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Show all {list.length}
          </button>
        )}
      </div>
    </section>
  )
}

/** A card wrapped in dnd-kit's `useSortable`. Done cards aren't draggable (they
 *  auto-settle); To do + Doing cards drag. The whole card is the grab target. */
function SortableCard({
  issue,
  lane,
  activeId,
  isSelected,
  onOpen,
  onFocus,
  onStart,
  onReply,
  onDiscard,
}: {
  issue: BoardIssue
  lane: Lane
  activeId: string | null
  isSelected: boolean
  onOpen: (issue: BoardIssue) => void
  onFocus: (issue: BoardIssue) => void
  onStart: (issue: BoardIssue) => void
  onReply: (issue: BoardIssue, text: string) => Promise<void>
  onDiscard: (issue: BoardIssue) => void
}) {
  const draggable = lane !== 'done'
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, disabled: !draggable })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
  }
  return (
    <div ref={setNodeRef} style={style}>
      <BoardCard
        issue={issue}
        lane={lane}
        draggable={draggable}
        dragAttributes={draggable ? attributes : undefined}
        dragListeners={draggable ? listeners : undefined}
        onOpen={onOpen}
        onFocus={onFocus}
        onStart={onStart}
        onReply={onReply}
        onDiscard={onDiscard}
        isDragging={isDragging || activeId === issue.id}
        isSelected={isSelected}
      />
    </div>
  )
}

/** Page chrome: title row + the board-switcher (AT-C). The board fills the full
 *  height so lanes scroll inside the viewport. No "Columns" gear — the 3 lanes
 *  are fixed (BM2 §1).
 *
 *  The switcher sits next to the title (plan §5.5): on desktop, inline after
 *  "Board"; on mobile, the same compact pill stays in the header (it forks to a
 *  Vaul half-sheet internally), reachable without clutter. */
function BoardPage({
  children,
  switcher,
}: {
  children: React.ReactNode
  switcher?: React.ReactNode
}) {
  return (
    <div className="mx-auto flex h-full w-full max-w-none flex-col px-4 py-6 pt-[calc(env(safe-area-inset-top)+1.5rem)] sm:px-6 sm:pt-6">
      <div className="mb-3 flex items-center gap-2.5">
        <h1 className="text-2xl font-semibold tracking-tight">Board</h1>
        {switcher}
        <div className="flex-1" />
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

function isAtIndex(list: BoardIssue[], id: string, index: number): boolean {
  return list[index]?.id === id
}

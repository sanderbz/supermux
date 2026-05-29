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
import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import {
  useBoard,
  useBoards,
  useSelectedBoard,
  sortIssues,
} from '@/hooks/use-board'
import { useTeams } from '@/hooks/use-teams'
import { useStartAgent, claimErrorMessage } from '@/hooks/use-send-to-agent'
import { useToast } from '@/components/ui/use-toast'
import { useNavigateMorph } from '@/components/view-transitions/morph'
import {
  ALL_BOARD_ID,
  MAIN_BOARD_ID,
  decodeBoardId,
  type BoardIssue,
  type NewBoardIssue,
} from '@/lib/api'
import { useLastActiveSession } from '@/stores/board-create-session-store'
import { BoardCard } from '@/components/board/board-card'
import { BoardComposer } from '@/components/board/board-composer'
import { BoardCardEditor } from '@/components/board/board-card-editor'
import { BoardDetailPane } from '@/components/board/board-detail-pane'
import { BoardSkeleton } from '@/components/board/board-skeleton'
import { BoardSwitcher } from '@/components/board/board-switcher'
import { midpointPos } from '@/components/board/pos'
import { useMediaQuery } from '@/hooks/use-media-query'

/** The three fixed lanes. No add/rename/delete column UI — these are
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
  // ── multi-board selection ───────────────────────────────────────────────────
  const { boards } = useBoards()
  // Team data — needed by the composer's default-session resolver: a per-team
  // board prefers that team's lead session.
  const { teams } = useTeams()
  const [selectedBoard, setSelectedBoardRaw] = useSelectedBoard()
  // App-wide "last-active session" — written when the user picks a per-session
  // board (`session:<name>`) from the switcher, so /files (no `:name`) lands in
  // that session's dir on the next visit. Picking Main / All / a team board
  // leaves it untouched (those aren't a session selection, so the last real one
  // stands). See stores/board-create-session-store.ts.
  const [, setLastActiveSession] = useLastActiveSession()
  const setSelectedBoard = useCallback(
    (id: string) => {
      setSelectedBoardRaw(id)
      const { sessionFilter } = decodeBoardId(id)
      if (sessionFilter) setLastActiveSession(sessionFilter)
    },
    [setSelectedBoardRaw, setLastActiveSession],
  )
  // A persisted selection can point at a board that was since deleted (e.g. a
  // team board). Fall back to Main so the view never shows an empty/404 board.
  // `'all'` is always valid (it's synthetic, not a row).
  const boardExists =
    selectedBoard === ALL_BOARD_ID ||
    boards.length === 0 || // boards still loading — trust the selection for now
    boards.some((b) => b.id === selectedBoard)
  const activeBoardId = boardExists ? selectedBoard : MAIN_BOARD_ID
  const isAll = activeBoardId === ALL_BOARD_ID
  // A team board is a READ-THROUGH mirror of the team's on-disk task list — the
  // server re-syncs it every ~3s, so any drag/edit would snap back. Treat it
  // like the "All" aggregate in the UI: non-draggable cards, no composer, and no
  // per-card write affordances (Start / Reply / Discard). Board→file write-back
  // is out of scope.
  const activeBoard = boards.find((b) => b.id === activeBoardId)
  const readThrough = activeBoard?.kind === 'team'

  // When the persisted selection points at a board that no longer exists (a team
  // board was deregistered / deleted), realign the stored selection to Main so the
  // active cards query targets a live board immediately — without this the query
  // briefly 404s on the vanished id and flashes the error banner. We only fall
  // back once the boards list has actually loaded (length > 0) so a slow initial
  // fetch doesn't bounce a valid persisted selection to Main.
  useEffect(() => {
    if (selectedBoard === ALL_BOARD_ID) return
    if (boards.length === 0) return
    if (!boards.some((b) => b.id === selectedBoard)) {
      setSelectedBoard(MAIN_BOARD_ID)
    }
  }, [boards, selectedBoard, setSelectedBoard])

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

  // "All" overview: a board id → name map for the grouped sub-headers.
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
        // Spawn-by-default; honour the composer's agent pick when given.
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

  // Detail-pane composer: deliver into the agent's PTY while it's LIVE, but when
  // it isn't (stale/ended session, or a card marked done while the agent died
  // mid-error) a reply would vanish into a dead PTY — so route it to a durable
  // board COMMENT instead. This is the manual-recovery path: leave a note on the
  // card, then drag it back to Doing to re-engage the agent link.
  const replyOrCommentIssue = useCallback(
    async (issue: BoardIssue, text: string) => {
      if (issue.session_live) {
        await replyIssue(issue, text)
        return
      }
      try {
        await board.commentIssue(issue.id, text)
        toast({ message: 'Comment added to the card', tone: 'active' })
      } catch (e) {
        toast({
          message: e instanceof Error ? e.message : 'Could not add the comment',
          tone: 'error',
        })
        throw e
      }
    },
    [board, replyIssue, toast],
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

  // ── Clear the whole Done lane → one batched undo toast ─────────────────────
  // SD-CLEAR-DONE. The Done column accumulates and becomes noisy; clearing it
  // is a one-tap bulk version of the per-card Discard. We fan out the existing
  // `discardIssue` mutations in parallel (Promise.allSettled so one failing row
  // never short-circuits the rest) and post a SINGLE undo toast at the end —
  // tapping Undo restores every successfully-discarded card. Mirrors the
  // archive sheet's bulk-purge pattern, but uses soft-discard so Undo works.
  const clearDoneLane = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      if (editId && ids.includes(editId)) setEditId(null)
      const results = await Promise.allSettled(
        ids.map((id) => board.discardIssue(id)),
      )
      const discarded: string[] = []
      let failed = 0
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') discarded.push(ids[i])
        else failed += 1
      })
      if (discarded.length === 0) {
        toast({ message: 'Couldn’t clear the Done column', tone: 'error' })
        return
      }
      const noun = discarded.length === 1 ? 'task' : 'tasks'
      const message =
        failed === 0
          ? `Cleared ${discarded.length} ${noun}`
          : `Cleared ${discarded.length} ${noun}, ${failed} couldn’t be cleared`
      toast({
        message,
        tone: failed === 0 ? 'default' : 'error',
        duration: 5000,
        action: {
          label: 'Undo',
          // Restore in parallel; ignore individual failures so a partially
          // restorable batch still puts most of the work back.
          onClick: () => {
            void Promise.allSettled(
              discarded.map((id) => board.restoreIssue(id)),
            )
          },
        },
      })
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
  // (which isn't a real board) new cards default to Main. A `session:<name>`
  // board is a virtual filter on Main — `decodeBoardId`
  // rewrites it to Main here so the server-side card row lands on Main with the
  // selected session attached (the filter then surfaces it on the per-session
  // view).
  const decoded = decodeBoardId(activeBoardId)
  const createBoardId = isAll ? MAIN_BOARD_ID : decoded.fetchBoardId

  // The board-scoped "preferred" session for the composer's session picker
  // Resolution chain (highest priority first):
  //   1. Per-session board (`session:<name>`)         → that session.
  //   2. Per-team board (kind `team`, with a lead)     → the team's lead session.
  //   3. Main / All / a team with no live lead         → null (composer falls
  //      back to the last-used persisted session, see use-last-create-session).
  // `null` is "no recommendation — use the persisted last-used"; `''` means "no
  // session" (the composer treats it as an explicit zero-attachment pick).
  const boardScopedSession: string | null = useMemo(() => {
    if (decoded.sessionFilter !== null) return decoded.sessionFilter
    if (activeBoard?.kind === 'team' && activeBoard.team_name) {
      const team = teams.find((t) => t.team_name === activeBoard.team_name)
      const lead = team?.lead_supermux_session
      if (lead) return lead
    }
    return null
  }, [decoded.sessionFilter, activeBoard, teams])
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

  // The board-switcher next to the title. Persisted selection; live
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
                  onClearLane={
                    // Only on the Done lane on a writable (non-team / non-All)
                    // board. The "All" overview spans multiple boards (a bulk
                    // discard there would be ambiguous), and team boards mirror
                    // on-disk task files — a discard wouldn't persist.
                    lane.id === 'done' && !isAll && !readThrough
                      ? clearDoneLane
                      : undefined
                  }
                  onDeselect={() => setSelectedId(null)}
                  composer={
                    // The "All" overview AND team boards are read-through — the
                    // composer would create on Main (ambiguous) / can't write
                    // back to the team's files, so hide it there.
                    lane.id === 'todo' && !isAll && !readThrough ? (
                      <BoardComposer
                        onAdd={onAdd}
                        onAddAndStart={onAddAndStart}
                        defaultSession={boardScopedSession}
                      />
                    ) : null
                  }
                  hint={
                    // A calm, non-alarmist note so a team board reads as a live
                    // mirror, not a stuck interactive board (only on To do so it
                    // sits once at the top, like the composer it replaces).
                    lane.id === 'todo' && readThrough ? (
                      <p className="px-1.5 pt-0.5 text-xs leading-snug text-muted-foreground">
                        Reflecting {activeBoard?.name ?? 'the team'}’s live task
                        list — read-only here.
                      </p>
                    ) : null
                  }
                  readThrough={readThrough}
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
              onReply={replyOrCommentIssue}
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
  onClearLane,
  onDeselect,
  composer,
  hint,
  readThrough,
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
  /** When set, render a "Clear all" action in the lane header (left of the
   *  count). Receives every visible card id in the lane. The lane decides
   *  *whether* to surface the affordance (e.g. Done only); the route owns the
   *  batched mutation + undo toast. */
  onClearLane?: (ids: string[]) => void | Promise<void>
  onDeselect: () => void
  composer: React.ReactNode
  /** A calm read-only note shown in place of the composer on a team board. */
  hint?: React.ReactNode
  /** True for a `kind='team'` board: cards are non-draggable + write-affordance
   *  free (the board is a read-through mirror of the team's task files). */
  readThrough?: boolean
  onOpen: (issue: BoardIssue) => void
  onFocus: (issue: BoardIssue) => void
  onStart: (issue: BoardIssue) => void
  onReply: (issue: BoardIssue, text: string) => Promise<void>
  onDiscard: (issue: BoardIssue) => void
  /** "All" aggregate: a board id → name map. When present, the lane groups
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
        {onClearLane && count > 0 && (
          <ClearLaneAction
            count={list.length}
            label={label}
            onConfirm={() => void onClearLane(list.map((i) => i.id))}
          />
        )}
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
        {hint && <div className="px-0.5 pt-0.5">{hint}</div>}

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
                  readThrough={readThrough}
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

/** SD-CLEAR-DONE — inline "Clear all" affordance that lives in a lane header,
 *  left of the count badge. Matches the archive sheet's `DeleteAllAction`
 *  shape (h-7, text-xs, Trash2 icon, ghost → destructive on confirm) so the
 *  vocabulary stays consistent: a stray tap can't sweep the lane, but one
 *  intentional confirmation does. Stays icon-only on the narrowest mobile
 *  widths (the label tucks behind `sm:`) so the lane header keeps its rhythm
 *  alongside the count badge on 320pt phones.
 *
 *  Local-only `confirming` state: a leaf widget so its morph doesn't rerender
 *  the rest of the column. The route owns the actual mutation (`onConfirm`).
 */
function ClearLaneAction({
  count,
  label,
  onConfirm,
}: {
  count: number
  /** Lane label — drives the aria description (e.g. "Clear all 8 Done tasks"). */
  label: string
  onConfirm: () => void
}) {
  const reduce = useReducedMotion()
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <motion.div
        initial={reduce ? false : { opacity: 0, x: 4 }}
        animate={{ opacity: 1, x: 0 }}
        transition={springs.snappy}
        className="flex items-center gap-1"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="flex h-7 items-center rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false)
            onConfirm()
          }}
          className="flex h-7 items-center gap-1 rounded-md bg-destructive px-2 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2 className="size-3.5" aria-hidden />
          Clear {count}
        </button>
      </motion.div>
    )
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        setConfirming(true)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={`Clear all ${count} ${label} tasks`}
      title="Clear all"
      className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Trash2 className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">Clear all</span>
    </button>
  )
}

/** A card wrapped in dnd-kit's `useSortable`. Done cards aren't draggable (they
 *  auto-settle); To do + Doing cards drag. The whole card is the grab target. */
function SortableCard({
  issue,
  lane,
  activeId,
  isSelected,
  readThrough,
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
  /** Read-through (team) board: non-draggable + no write affordances. */
  readThrough?: boolean
  onOpen: (issue: BoardIssue) => void
  onFocus: (issue: BoardIssue) => void
  onStart: (issue: BoardIssue) => void
  onReply: (issue: BoardIssue, text: string) => Promise<void>
  onDiscard: (issue: BoardIssue) => void
}) {
  // A team board mirrors the on-disk task files (re-synced every ~3s); a drag
  // would just snap back, so cards are never draggable there.
  const draggable = lane !== 'done' && !readThrough
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
        readOnly={readThrough}
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

/** Page chrome: title row + the board-switcher. The board fills the full
 *  height so lanes scroll inside the viewport. No "Columns" gear — the 3 lanes
 *  are fixed.
 *
 *  The switcher sits next to the title: on desktop, inline after
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

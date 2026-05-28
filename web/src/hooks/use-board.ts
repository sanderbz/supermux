// useBoard — the kanban data layer (TECH_PLAN §M19; M6 backend contract).
//
// TanStack Query against the M6 board endpoints, invalidated by the SSE `board`
// event — NEVER polled (anti-vision: "WebSocket-only — no 3s polling fallback").
//
// SSE wiring: the shared `use-sse.ts` hook (M12) opens ONE authenticated
// EventSource to `/api/events` and fans events out to per-event-type callbacks —
// it is the single live channel for the whole app. The board no longer opens its
// own EventSource; instead `useBoardSse` subscribes to the shared stream's
// `board` event through `useSse`'s `onEvent` callback. One connection, app-wide.
//
// Mutations (create / patch / claim / delete) apply OPTIMISTIC updates against the
// `['board']` cache and ROLL BACK on error (§4 board reference: "optimistic update
// + rollback"). The atomic claim surfaces a 409 visibly via the thrown
// `BoardError` (§3.2.10).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'

import {
  boardApi,
  boardsApi,
  BoardError,
  sessionsApi,
  ALL_BOARD_ID,
  MAIN_BOARD_ID,
  decodeBoardId,
  isSessionBoardId,
  type ApiSession,
  type Board,
  type BoardIssue,
  type BoardIssuePatch,
  type BoardStatus,
  type ClaimResult,
  type NewBoardIssue,
  type StartSpawn,
} from '@/lib/api'
import { useSse, type SseEventType } from '@/hooks/use-sse'
import { SESSIONS_KEY } from '@/hooks/use-sessions'

// The issues cache is keyed by the selected board (AT-C, plan §5.5) so each
// board's view is cached independently; `'all'` holds the cross-board aggregate.
const issuesKey = (boardId: string) => ['board', 'issues', boardId] as const
const STATUSES_KEY = ['board', 'statuses'] as const

export interface ClaimArgs {
  id: string
  session: string
  /** Auto-send the work to the agent (S3). Defaults to true (user decision).
   *  Pass `false` for "Claim only" — flip the link without dispatching. */
  deliver?: boolean
}

/** Args for the unified Start-agent action (BR1). Either attach an existing live
 *  `session`, OR pass `spawn` to create a NEW agent for the issue. */
export interface StartArgs {
  id: string
  /** Attach to an existing live session. */
  session?: string
  /** Spawn a new session for the issue (name auto-derived server-side). */
  spawn?: StartSpawn
}

export interface UseBoardResult {
  issues: BoardIssue[]
  statuses: BoardStatus[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  /** Force a refetch of issues + statuses. */
  refetch: () => void

  // Mutations (each optimistic + rollback). Promises reject with `BoardError`.
  createIssue: (input: NewBoardIssue) => Promise<BoardIssue>
  patchIssue: (id: string, patch: BoardIssuePatch) => Promise<BoardIssue>
  /** ATOMIC claim (§3.2.10) that also auto-sends the work to the agent (S3).
   *  Resolves to `{ issue, delivered, steer_id }` — use `steer_id` with
   *  `boardApi.unsend` for the Undo toast. Rejects with a `BoardError` (status
   *  409) on a lost race / not-claimable so the UI can show the conflict. */
  claimIssue: (args: ClaimArgs) => Promise<ClaimResult>
  /** Unified Start-agent action (BR1): make the issue agent-owned, attach an
   *  existing session or spawn a new one, then claim + deliver. Optimistic (card
   *  slides to `doing`), rolls back on error, surfaces 409 like `claimIssue`.
   *  Resolves to `{ issue, delivered, steer_id }` — use `steer_id` with
   *  `boardApi.unsend` for the Undo toast. */
  startIssue: (args: StartArgs) => Promise<ClaimResult>
  deleteIssue: (id: string) => Promise<void>
  /** BM2 §2.4: deliver `text` into the card's linked agent + clear awaiting. */
  replyIssue: (id: string, text: string) => Promise<void>
  /** Post a durable human comment on the card (author `'user'`). Used for manual
   *  recovery when the linked agent isn't live, so the note lands on the card
   *  instead of a dead PTY. */
  commentIssue: (id: string, text: string) => Promise<void>
  /** BM2 §2.6: soft-archive the card (optimistic removal). */
  discardIssue: (id: string) => Promise<void>
  /** BM2 §2.6: un-discard (undo). */
  restoreIssue: (id: string) => Promise<void>
}

/** Sort a column's issues for display: pinned first, then ascending `pos`. The
 *  midpoint-`pos` scheme means smaller `pos` = nearer the top (§2.4). */
export function sortIssues(issues: BoardIssue[]): BoardIssue[] {
  return [...issues].sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned - a.pinned
    return a.pos - b.pos
  })
}

function patchCache(
  qc: QueryClient,
  key: readonly unknown[],
  updater: (prev: BoardIssue[]) => BoardIssue[],
) {
  qc.setQueryData<BoardIssue[]>([...key], (prev) => updater(prev ?? []))
}

/** A live set of issue ids with an IN-FLIGHT optimistic move (patch / claim /
 *  start / create / delete that has changed the card's column / position /
 *  session / existence and is still awaiting the server). The SSE `board`
 *  reconciler reads this so a snapshot pushed mid-flight — possibly loaded
 *  before THIS client's move persisted — never clobbers the optimistic state of
 *  a card the user just dropped. Each id is added in `onMutate` and removed in
 *  `onSettled`, after which the authoritative refetch reconciles it for real. */
type PendingMoves = Set<string>

/** Merge a server board snapshot into the optimistic cache while PRESERVING any
 *  issue with a pending in-flight move (TanStack-standard "don't clobber
 *  optimistic state from a concurrent push"). For non-pending cards the snapshot
 *  is authoritative — so live agent deltas (comments, acceptance, status,
 *  needs_review) still land. For a pending card we keep the optimistic entry
 *  (its column/pos the user just chose); its own `onSettled` refetch reconciles
 *  it once the move resolves. A pending card the snapshot DROPS (e.g. a
 *  still-uncommitted optimistic create) is carried over so it doesn't vanish
 *  mid-flight; a pending DELETE that's already gone from the optimistic cache
 *  simply isn't re-added. */
function reconcileBoard(
  prev: BoardIssue[],
  snapshot: BoardIssue[],
  pending: PendingMoves,
): BoardIssue[] {
  if (pending.size === 0) return snapshot
  const prevById = new Map(prev.map((i) => [i.id, i]))
  const seen = new Set<string>()
  const merged: BoardIssue[] = []
  for (const incoming of snapshot) {
    seen.add(incoming.id)
    if (pending.has(incoming.id)) {
      // A card with a pending move keeps its optimistic entry. If the optimistic
      // cache no longer has it, the user optimistically DELETED it — so drop the
      // snapshot's still-present copy rather than resurrecting it mid-flight.
      const optimistic = prevById.get(incoming.id)
      if (optimistic) merged.push(optimistic)
      continue
    }
    // Not pending → take the fresh server truth (live agent deltas land here).
    merged.push(incoming)
  }
  // Carry over pending cards the snapshot doesn't yet include (in-flight creates,
  // or a move whose persist the snapshot predates) so they don't pop out.
  for (const id of pending) {
    if (seen.has(id)) continue
    const optimistic = prevById.get(id)
    if (optimistic) merged.push(optimistic)
  }
  return merged
}

/** The live state of the session a card is linked to (U1). `null` when the card
 *  has no linked session. The board joins this onto each card by `issue.session`
 *  so the card renders the real overview `StatusDot` + tail-peek instead of a
 *  hard-coded dot. */
export interface LiveSession {
  status: ApiSession['status']
  /** Last ~6 lines of the session's `last_capture`, ANSI-stripped (§3.6) — the
   *  same source as the overview `TailPreview`. */
  preview_lines: string[]
  /** Same tail WITH SGR escapes preserved (colour-true peek), when present. */
  preview_ansi?: string[]
  /** Mutable human label (migration 0019) for rendering the card's session pill
   *  via `displayLabel`; the slug `issue.session` stays the key. */
  display_name?: string
}

/** Join a board card to the LINKED session's live status + tail by name (U1).
 *
 *  Reads the SHARED `['sessions']` TanStack cache — the exact source the overview
 *  tiles render from — so live `status`/`sessions` SSE deltas (merged into that
 *  cache by the `useSessions` mounted on the board route) reach the card with NO
 *  new EventSource and NO server fan-out. The query is deduped by key; we only
 *  read the cache here (`enabled:false` keeps this selector from firing its own
 *  fetch — the board's `useSessions` owns the fetch + the live subscription).
 *
 *  Returns `null` when `name` is null/empty or the session isn't in the cache
 *  yet (the card then falls back to its static link pill until the row arrives).
 */
export function useLiveSession(name: string | null | undefined): LiveSession | null {
  const sessionsQuery = useQuery({
    queryKey: [...SESSIONS_KEY],
    queryFn: sessionsApi.list,
    // The board route already mounts `useSessions`, which owns the fetch + the
    // SSE live-merge. This selector only READS the resulting cache — never
    // fetches — so it adds zero round-trips and zero subscribers.
    enabled: false,
    staleTime: 30_000,
  })
  return useMemo(() => {
    if (!name) return null
    const row = (sessionsQuery.data ?? []).find((s) => s.name === name)
    if (!row) return null
    return {
      status: row.status,
      preview_lines: row.preview_lines ?? [],
      preview_ansi: row.preview_ansi,
      display_name: row.display_name,
    }
  }, [name, sessionsQuery.data])
}

/** Subscribe the board cache to the SHARED SSE stream's `board` event. No
 *  standalone EventSource — `useSse` owns the one app-wide connection (M12).
 *  No polling.
 *
 *  `pendingRef` holds the ids of cards with an in-flight optimistic move. A
 *  `board` snapshot that arrives DURING a drag's PATCH can be a server view
 *  loaded BEFORE this client's move persisted (it's pushed by ANY mutation /
 *  agent write, not just ours) — so a blind `setQueryData(snapshot)` would
 *  overwrite the optimistic card with its stale old column and the card would
 *  pop back. We MERGE instead: every card takes the fresh snapshot EXCEPT those
 *  with a pending move, whose optimistic state is preserved until their own
 *  `onSettled` refetch reconciles them. */
function useBoardSse(
  qc: QueryClient,
  boardId: string,
  issuesK: readonly unknown[],
  pendingRef: MutableRefObject<PendingMoves>,
) {
  const onEvent = useCallback(
    (type: SseEventType, payload: unknown) => {
      // The `boards` event re-publishes the SWITCHER list — invalidate it so the
      // dropdown reflects a created/renamed/deleted/registered board live.
      if (type === 'boards') {
        void qc.invalidateQueries({ queryKey: BOARDS_KEY })
        return
      }
      if (type !== 'board') return
      // The `board` event payload IS the full board ACROSS ALL boards (M6/AT-C
      // `emit_board`). Prefer the pushed payload over a refetch round-trip; fall
      // back to invalidation.
      const board = Array.isArray(payload)
        ? (payload as BoardIssue[])
        : Array.isArray((payload as { payload?: unknown })?.payload)
          ? ((payload as { payload: BoardIssue[] }).payload)
          : null
      if (board) {
        // Scope the all-boards push to THIS view. Three shapes:
        //   • `all`          → keep the whole snapshot.
        //   • `session:<name>` (FEAT-BOARD-SESSION) → keep Main's cards filtered
        //     to the named session (per-session boards are a virtual filter on
        //     Main; team-board cards live under their team board).
        //   • a real board id → keep only that board's cards.
        const { fetchBoardId, sessionFilter } = decodeBoardId(boardId)
        const scoped =
          boardId === ALL_BOARD_ID
            ? board
            : sessionFilter !== null
              ? board.filter(
                  (i) =>
                    (i.board_id ?? MAIN_BOARD_ID) === fetchBoardId &&
                    i.session === sessionFilter,
                )
              : board.filter((i) => (i.board_id ?? MAIN_BOARD_ID) === fetchBoardId)
        qc.setQueryData<BoardIssue[]>([...issuesK], (prev) =>
          reconcileBoard(prev ?? [], scoped, pendingRef.current),
        )
        // FEAT-BOARD-SESSION: ALSO update the Main-cards cache the switcher reads
        // to compute per-session entries — so a new card linked to a session
        // appears in the switcher live, even when the user is currently on a
        // team / all / per-session view. Skip when THIS view already wrote into
        // Main's cache (boardId === MAIN_BOARD_ID handled above).
        if (boardId !== MAIN_BOARD_ID) {
          const mainScoped = board.filter(
            (i) => (i.board_id ?? MAIN_BOARD_ID) === MAIN_BOARD_ID,
          )
          qc.setQueryData<BoardIssue[]>(
            [...issuesKey(MAIN_BOARD_ID)],
            (prev) => reconcileBoard(prev ?? [], mainScoped, pendingRef.current),
          )
        }
        return
      }
      void qc.invalidateQueries({ queryKey: [...issuesK] })
      void qc.invalidateQueries({ queryKey: [...STATUSES_KEY] })
    },
    [qc, boardId, issuesK, pendingRef],
  )
  // On a focus/visibility/online resync after a quiet stretch, re-pull the board
  // so a missed delta is reconciled. Still no polling.
  const onResync = useCallback(() => {
    void qc.invalidateQueries({ queryKey: [...issuesK] })
    void qc.invalidateQueries({ queryKey: [...STATUSES_KEY] })
    void qc.invalidateQueries({ queryKey: BOARDS_KEY })
  }, [qc, issuesK])
  const handlers = useMemo(() => ({ onEvent, onResync }), [onEvent, onResync])
  useSse(handlers)
}

/** The boards-list (switcher options) cache key. */
export const BOARDS_KEY = ['boards'] as const

export function useBoard(boardId: string = ALL_BOARD_ID): UseBoardResult {
  const qc = useQueryClient()
  // The issues cache key for THIS board (AT-C). Each board view caches
  // independently; `'all'` holds the cross-board aggregate.
  const issuesK = useMemo(() => issuesKey(boardId), [boardId])
  // Ids of cards with an in-flight optimistic move. The SSE `board` reconciler
  // reads this so a snapshot pushed mid-drag can't clobber the optimistic
  // column/pos of a card the user just dropped (the pop-back race). Stable
  // across renders (a ref) so the SSE subscription never re-runs for it.
  const pendingRef = useRef<PendingMoves>(new Set())
  useBoardSse(qc, boardId, issuesK, pendingRef)
  const markPending = useCallback((id: string) => {
    pendingRef.current.add(id)
  }, [])
  const clearPending = useCallback((id: string) => {
    pendingRef.current.delete(id)
  }, [])

  const issuesQuery = useQuery({
    queryKey: [...issuesK],
    // Scope the fetch to the selected board: a specific board hits its
    // `/cards` endpoint; `'all'` hits the cross-board aggregate. Coerce the
    // result to an array AT THE SOURCE: a malformed / 404 board payload (a
    // non-array error body that slipped past the client's envelope unwrap)
    // must degrade to an EMPTY board, never a truthy non-array that crashes
    // every consumer's `.filter` / `.map` (CommandPalette, BoardCard, the
    // column renderers) — the `?? []` fallback elsewhere can't catch a truthy
    // non-array, so the array guarantee is established here, once, for all of
    // them.
    queryFn: async () => {
      // A `session:<name>` (FEAT-BOARD-SESSION) board is a virtual filter on
      // Main's cards — fetch Main, filter client-side. Otherwise hit the real
      // board endpoint (real id or the `all` aggregate, both handled server-side).
      const { fetchBoardId, sessionFilter } = decodeBoardId(boardId)
      const data = await boardsApi.cards(fetchBoardId)
      const arr = Array.isArray(data) ? data : []
      if (sessionFilter !== null) {
        return arr.filter((i) => i.session === sessionFilter)
      }
      return arr
    },
    staleTime: 30_000,
  })
  const statusesQuery = useQuery({
    queryKey: [...STATUSES_KEY],
    queryFn: boardApi.statuses,
    staleTime: 60_000,
  })

  // ── create (optimistic insert, rollback on error) ──────────────────────────
  const create = useMutation({
    mutationFn: (input: NewBoardIssue) => boardApi.create(input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: [...issuesK] })
      const prev = qc.getQueryData<BoardIssue[]>([...issuesK]) ?? []
      const optimisticId = `optimistic-${Date.now()}`
      // Guard the not-yet-persisted card so a concurrent `board` snapshot (which
      // can't contain this client-only id) doesn't drop it before it commits.
      markPending(optimisticId)
      const optimistic: BoardIssue = {
        id: optimisticId,
        title: input.title ?? '',
        desc: input.description,
        status: input.status ?? 'todo',
        session: input.session ?? null,
        creator: '',
        due: input.due ?? null,
        due_time: input.due_time ?? null,
        created: Math.floor(Date.now() / 1000),
        updated: Math.floor(Date.now() / 1000),
        // BM2: every card is an agent task — owner_type is fixed server-side.
        owner_type: 'agent',
        pinned: 0,
        // New cards sit at the top of their column (negative pos).
        pos: Math.min(0, ...prev.map((i) => i.pos)) - 1024,
        tags: input.tags ?? [],
        // A brand-new card has no relations yet (S1/S2: always-present arrays).
        // Acceptance lines are created server-side; they arrive on the refetch.
        comments: [],
        acceptance: [],
        links: [],
        // R1/R2 flags default off; a freshly-created card with a live session
        // link reads live until the server says otherwise (session_live true so
        // the optimistic card shows the live dot, not a stale-link badge).
        needs_review: false,
        awaiting_input: false,
        session_live: input.session != null,
        latest_question: null,
        // AT-C: the card lands on the board it's created for (the input's
        // board_id when set; otherwise the board this view is scoped to —
        // `'all'` falls back to `main`, since the aggregate isn't a real board).
        // FEAT-BOARD-SESSION: a `session:<name>` board is a virtual filter on
        // Main, so cards created from it land on Main too (with `session` set).
        board_id:
          input.board_id ??
          (boardId === ALL_BOARD_ID || isSessionBoardId(boardId)
            ? MAIN_BOARD_ID
            : boardId),
      }
      patchCache(qc, issuesK, (p) => [optimistic, ...p])
      return { prev, optimisticId }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...issuesK], ctx.prev)
    },
    onSettled: (_d, _e, _v, ctx) => {
      if (ctx?.optimisticId) clearPending(ctx.optimisticId)
      return qc.invalidateQueries({ queryKey: [...issuesK] })
    },
  })

  // ── patch (optimistic merge, rollback on error) ────────────────────────────
  const patch = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: BoardIssuePatch }) =>
      boardApi.patch(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: [...issuesK] })
      const prev = qc.getQueryData<BoardIssue[]>([...issuesK]) ?? []
      // A move (column / position / session change) must survive a concurrent
      // `board` snapshot that predates this PATCH's persist — otherwise the card
      // pops back to its old column mid-drag. Guard it until settle.
      markPending(id)
      patchCache(qc, issuesK, (p) =>
        p.map((i) =>
          i.id === id
            ? {
                ...i,
                ...patch,
                // `session: null` from the patch means "unassign".
                session: 'session' in patch ? patch.session ?? null : i.session,
                pinned:
                  patch.pinned === undefined ? i.pinned : patch.pinned ? 1 : 0,
              }
            : i,
        ),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...issuesK], ctx.prev)
    },
    onSettled: (_d, _e, { id }) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...issuesK] })
    },
  })

  // ── atomic claim (optimistic move → doing, rollback shows the 409) ─────────
  const claim = useMutation({
    mutationFn: ({ id, session, deliver }: ClaimArgs) =>
      boardApi.claim(id, session, deliver ?? true),
    onMutate: async ({ id, session }) => {
      await qc.cancelQueries({ queryKey: [...issuesK] })
      const prev = qc.getQueryData<BoardIssue[]>([...issuesK]) ?? []
      markPending(id)
      patchCache(qc, issuesK, (p) =>
        p.map((i) =>
          i.id === id ? { ...i, status: 'doing', session } : i,
        ),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      // Lost the race / not claimable → roll the card back to where it was so the
      // user SEES the 409 (the route surfaces the BoardError as a toast).
      if (ctx?.prev) qc.setQueryData([...issuesK], ctx.prev)
    },
    onSettled: (_d, _e, { id }) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...issuesK] })
    },
  })

  // ── start agent (optimistic move → doing, rollback shows the 409) ──────────
  // The unified BR1 action. Optimistically links the card to the chosen session
  // and slides it to `doing`; a spawn (no session yet) just slides to `doing`
  // and lets the server-confirmed payload fill in the freshly-created session
  // name. Same rollback-on-error contract as `claim`.
  const start = useMutation({
    mutationFn: ({ id, session, spawn }: StartArgs) =>
      boardApi.start(id, { session, spawn }),
    onMutate: async ({ id, session }) => {
      await qc.cancelQueries({ queryKey: [...issuesK] })
      const prev = qc.getQueryData<BoardIssue[]>([...issuesK]) ?? []
      markPending(id)
      patchCache(qc, issuesK, (p) =>
        p.map((i) =>
          i.id === id
            ? { ...i, status: 'doing', session: session ?? i.session }
            : i,
        ),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...issuesK], ctx.prev)
    },
    onSettled: (_d, _e, { id }) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...issuesK] })
    },
  })

  // ── delete (optimistic removal, rollback on error) ─────────────────────────
  const remove = useMutation({
    mutationFn: (id: string) => boardApi.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: [...issuesK] })
      const prev = qc.getQueryData<BoardIssue[]>([...issuesK]) ?? []
      // Guard the optimistic removal: a `board` snapshot loaded before this
      // soft-delete persisted would otherwise re-add the card mid-flight. The
      // reconciler keeps the optimistic (absent) state for a pending id.
      markPending(id)
      patchCache(qc, issuesK, (p) => p.filter((i) => i.id !== id))
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...issuesK], ctx.prev)
    },
    onSettled: (_d, _e, id) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...issuesK] })
    },
  })

  // ── reply (deliver text into the linked agent; clear awaiting_input) ────────
  // BM2 §2.4: the inline board reply. Optimistically clears the card's
  // `awaiting_input` + `latest_question` so the amber "Needs your input" state
  // resolves the moment the human hits Send; the SSE `board` push reconciles the
  // real state once the agent receives the text. Rolls back on error.
  const reply = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      boardApi.reply(id, text),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: [...issuesK] })
      const prev = qc.getQueryData<BoardIssue[]>([...issuesK]) ?? []
      markPending(id)
      patchCache(qc, issuesK, (p) =>
        p.map((i) =>
          i.id === id
            ? { ...i, awaiting_input: false, latest_question: null }
            : i,
        ),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...issuesK], ctx.prev)
    },
    onSettled: (_d, _e, { id }) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...issuesK] })
    },
  })

  // ── comment (durable human note on the card; author 'user') ────────────────
  // The detail pane routes here instead of `reply` when the linked agent isn't
  // live, so a manual-recovery message lands ON the card rather than into a dead
  // PTY. The server re-publishes the board over SSE, so an invalidate confirms.
  const comment = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      boardApi.comment(id, text),
    onSettled: () => qc.invalidateQueries({ queryKey: [...issuesK] }),
  })

  // ── discard (optimistic removal from the board; undo via restore) ──────────
  const discard = useMutation({
    mutationFn: (id: string) => boardApi.discard(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: [...issuesK] })
      const prev = qc.getQueryData<BoardIssue[]>([...issuesK]) ?? []
      markPending(id)
      patchCache(qc, issuesK, (p) => p.filter((i) => i.id !== id))
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...issuesK], ctx.prev)
    },
    onSettled: (_d, _e, id) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...issuesK] })
    },
  })

  // ── restore (un-discard — powers the discard toast's Undo) ─────────────────
  const restore = useMutation({
    mutationFn: (id: string) => boardApi.restore(id),
    onSettled: () => qc.invalidateQueries({ queryKey: [...issuesK] }),
  })

  const error = (issuesQuery.error ?? statusesQuery.error) as Error | null

  return useMemo<UseBoardResult>(
    () => ({
      // Final array guarantee for consumers (CommandPalette / BoardCard / the
      // columns all assume an array): even if a non-array somehow reached the
      // cache, a malformed board degrades to empty, never blanks the app.
      issues: Array.isArray(issuesQuery.data) ? issuesQuery.data : [],
      statuses: Array.isArray(statusesQuery.data) ? statusesQuery.data : [],
      isLoading: issuesQuery.isLoading || statusesQuery.isLoading,
      isError: issuesQuery.isError || statusesQuery.isError,
      error,
      refetch: () => {
        void issuesQuery.refetch()
        void statusesQuery.refetch()
      },
      createIssue: (input) => create.mutateAsync(input),
      patchIssue: (id, p) => patch.mutateAsync({ id, patch: p }),
      claimIssue: (args) => claim.mutateAsync(args),
      startIssue: (args) => start.mutateAsync(args),
      deleteIssue: (id) => remove.mutateAsync(id).then(() => undefined),
      replyIssue: (id, text) =>
        reply.mutateAsync({ id, text }).then(() => undefined),
      commentIssue: (id, text) =>
        comment.mutateAsync({ id, text }).then(() => undefined),
      discardIssue: (id) => discard.mutateAsync(id).then(() => undefined),
      restoreIssue: (id) => restore.mutateAsync(id).then(() => undefined),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      issuesQuery.data,
      statusesQuery.data,
      issuesQuery.isLoading,
      statusesQuery.isLoading,
      issuesQuery.isError,
      statusesQuery.isError,
      error,
    ],
  )
}

// ── boards (the switcher list) ─────────────────────────────────────────────────

export interface UseBoardsResult {
  boards: Board[]
  isLoading: boolean
  refetch: () => void
}

/** Fetch the boards list (the switcher options). Live-updated via the SSE
 *  `boards` event (invalidated by `useBoardSse`); cached app-wide under
 *  {@link BOARDS_KEY}. The Main board is always first (server order).
 *
 *  FEAT-BOARD-SESSION: appends one synthetic `kind:'session'` board per session
 *  that currently has ≥1 card on Main. These entries are CLIENT-SIDE virtual
 *  filters — they share Main's cards (and write back to Main) via `decodeBoardId`
 *  in `useBoard`/the SSE reconciler. Derived from a lightweight Main-cards query
 *  (same cache key as `useBoard('main')`, so the data is shared when the user is
 *  viewing Main and added once when they aren't). Order in the returned list:
 *  Main → team boards (server order) → per-session boards (sorted by name). */
export function useBoards(): UseBoardsResult {
  const query = useQuery({
    queryKey: BOARDS_KEY,
    queryFn: boardsApi.list,
    staleTime: 60_000,
  })
  // A piggyback query keyed identically to `useBoard('main')` — TanStack dedupes
  // on the key so this DOES NOT double-fetch when the user is on Main; when the
  // user is on a team / session / all view, one extra fetch on mount keeps the
  // per-session group accurate. The SSE `board` event reconciles this cache too
  // (see `useBoardSse`), so the list stays live without polling.
  const mainCardsQuery = useQuery({
    queryKey: issuesKey(MAIN_BOARD_ID),
    queryFn: async () => {
      const data = await boardsApi.cards(MAIN_BOARD_ID)
      return Array.isArray(data) ? data : []
    },
    staleTime: 30_000,
  })
  const boards = useMemo(() => {
    const real = query.data ?? []
    const mainCards = mainCardsQuery.data ?? []
    return [...real, ...synthesizeSessionBoards(mainCards)]
  }, [query.data, mainCardsQuery.data])
  return {
    boards,
    isLoading: query.isLoading,
    refetch: () => {
      void query.refetch()
      void mainCardsQuery.refetch()
    },
  }
}

/** Build per-session board options from Main's cards. One entry per distinct
 *  session that owns ≥1 non-discarded card on Main; cards with no session don't
 *  produce an entry (the "(no session)" composer option creates them; they live
 *  under Main itself). Order: alphabetical by session name (stable, predictable).
 *  An empty result hides the per-session group entirely. */
function synthesizeSessionBoards(mainCards: BoardIssue[]): Board[] {
  const names = new Set<string>()
  for (const card of mainCards) {
    const s = card.session
    if (typeof s === 'string' && s.length > 0) names.add(s)
  }
  const sorted = Array.from(names).sort((a, b) => a.localeCompare(b))
  return sorted.map((name, i) => ({
    id: `session:${name}`,
    name,
    kind: 'session' as const,
    team_name: null,
    created_at: 0,
    // After server boards (their `position` is finite); preserve order.
    position: 1_000_000 + i,
  }))
}

const SELECTED_BOARD_KEY = 'supermux.board.selected'

/** Persist the last-selected board across reloads (localStorage). Returns the
 *  selected id + a setter. Defaults to the Main board. If the persisted board no
 *  longer exists (e.g. a team board was deleted), the caller falls it back to
 *  Main — keep this hook a pure storage cell so it stays simple. */
export function useSelectedBoard(): [string, (id: string) => void] {
  const [selected, setSelected] = useState<string>(() => {
    if (typeof window === 'undefined') return MAIN_BOARD_ID
    return window.localStorage.getItem(SELECTED_BOARD_KEY) ?? MAIN_BOARD_ID
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SELECTED_BOARD_KEY, selected)
  }, [selected])
  return [selected, setSelected]
}

export { BoardError }

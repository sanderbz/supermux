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

import { useCallback, useMemo, useRef, type MutableRefObject } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'

import {
  boardApi,
  BoardError,
  sessionsApi,
  type ApiSession,
  type BoardIssue,
  type BoardIssuePatch,
  type BoardStatus,
  type ClaimResult,
  type NewBoardIssue,
  type StartSpawn,
} from '@/lib/api'
import { useSse, type SseEventType } from '@/hooks/use-sse'
import { SESSIONS_KEY } from '@/hooks/use-sessions'

const ISSUES_KEY = ['board', 'issues'] as const
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

function patchCache(qc: QueryClient, updater: (prev: BoardIssue[]) => BoardIssue[]) {
  qc.setQueryData<BoardIssue[]>([...ISSUES_KEY], (prev) => updater(prev ?? []))
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
function useBoardSse(qc: QueryClient, pendingRef: MutableRefObject<PendingMoves>) {
  const onEvent = useCallback(
    (type: SseEventType, payload: unknown) => {
      if (type !== 'board') return
      // The `board` event payload IS the full board (M6 `emit_board`). Prefer the
      // pushed payload over a refetch round-trip; fall back to invalidation.
      const board = Array.isArray(payload)
        ? (payload as BoardIssue[])
        : Array.isArray((payload as { payload?: unknown })?.payload)
          ? ((payload as { payload: BoardIssue[] }).payload)
          : null
      if (board) {
        qc.setQueryData<BoardIssue[]>([...ISSUES_KEY], (prev) =>
          reconcileBoard(prev ?? [], board, pendingRef.current),
        )
        return
      }
      void qc.invalidateQueries({ queryKey: [...ISSUES_KEY] })
      void qc.invalidateQueries({ queryKey: [...STATUSES_KEY] })
    },
    [qc, pendingRef],
  )
  // On a focus/visibility/online resync after a quiet stretch, re-pull the board
  // so a missed delta is reconciled. Still no polling.
  const onResync = useCallback(() => {
    void qc.invalidateQueries({ queryKey: [...ISSUES_KEY] })
    void qc.invalidateQueries({ queryKey: [...STATUSES_KEY] })
  }, [qc])
  const handlers = useMemo(() => ({ onEvent, onResync }), [onEvent, onResync])
  useSse(handlers)
}

export function useBoard(): UseBoardResult {
  const qc = useQueryClient()
  // Ids of cards with an in-flight optimistic move. The SSE `board` reconciler
  // reads this so a snapshot pushed mid-drag can't clobber the optimistic
  // column/pos of a card the user just dropped (the pop-back race). Stable
  // across renders (a ref) so the SSE subscription never re-runs for it.
  const pendingRef = useRef<PendingMoves>(new Set())
  useBoardSse(qc, pendingRef)
  const markPending = useCallback((id: string) => {
    pendingRef.current.add(id)
  }, [])
  const clearPending = useCallback((id: string) => {
    pendingRef.current.delete(id)
  }, [])

  const issuesQuery = useQuery({
    queryKey: [...ISSUES_KEY],
    queryFn: boardApi.list,
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
      await qc.cancelQueries({ queryKey: [...ISSUES_KEY] })
      const prev = qc.getQueryData<BoardIssue[]>([...ISSUES_KEY]) ?? []
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
      }
      patchCache(qc, (p) => [optimistic, ...p])
      return { prev, optimisticId }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...ISSUES_KEY], ctx.prev)
    },
    onSettled: (_d, _e, _v, ctx) => {
      if (ctx?.optimisticId) clearPending(ctx.optimisticId)
      return qc.invalidateQueries({ queryKey: [...ISSUES_KEY] })
    },
  })

  // ── patch (optimistic merge, rollback on error) ────────────────────────────
  const patch = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: BoardIssuePatch }) =>
      boardApi.patch(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: [...ISSUES_KEY] })
      const prev = qc.getQueryData<BoardIssue[]>([...ISSUES_KEY]) ?? []
      // A move (column / position / session change) must survive a concurrent
      // `board` snapshot that predates this PATCH's persist — otherwise the card
      // pops back to its old column mid-drag. Guard it until settle.
      markPending(id)
      patchCache(qc, (p) =>
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
      if (ctx?.prev) qc.setQueryData([...ISSUES_KEY], ctx.prev)
    },
    onSettled: (_d, _e, { id }) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...ISSUES_KEY] })
    },
  })

  // ── atomic claim (optimistic move → doing, rollback shows the 409) ─────────
  const claim = useMutation({
    mutationFn: ({ id, session, deliver }: ClaimArgs) =>
      boardApi.claim(id, session, deliver ?? true),
    onMutate: async ({ id, session }) => {
      await qc.cancelQueries({ queryKey: [...ISSUES_KEY] })
      const prev = qc.getQueryData<BoardIssue[]>([...ISSUES_KEY]) ?? []
      markPending(id)
      patchCache(qc, (p) =>
        p.map((i) =>
          i.id === id ? { ...i, status: 'doing', session } : i,
        ),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      // Lost the race / not claimable → roll the card back to where it was so the
      // user SEES the 409 (the route surfaces the BoardError as a toast).
      if (ctx?.prev) qc.setQueryData([...ISSUES_KEY], ctx.prev)
    },
    onSettled: (_d, _e, { id }) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...ISSUES_KEY] })
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
      await qc.cancelQueries({ queryKey: [...ISSUES_KEY] })
      const prev = qc.getQueryData<BoardIssue[]>([...ISSUES_KEY]) ?? []
      markPending(id)
      patchCache(qc, (p) =>
        p.map((i) =>
          i.id === id
            ? { ...i, status: 'doing', session: session ?? i.session }
            : i,
        ),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...ISSUES_KEY], ctx.prev)
    },
    onSettled: (_d, _e, { id }) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...ISSUES_KEY] })
    },
  })

  // ── delete (optimistic removal, rollback on error) ─────────────────────────
  const remove = useMutation({
    mutationFn: (id: string) => boardApi.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: [...ISSUES_KEY] })
      const prev = qc.getQueryData<BoardIssue[]>([...ISSUES_KEY]) ?? []
      // Guard the optimistic removal: a `board` snapshot loaded before this
      // soft-delete persisted would otherwise re-add the card mid-flight. The
      // reconciler keeps the optimistic (absent) state for a pending id.
      markPending(id)
      patchCache(qc, (p) => p.filter((i) => i.id !== id))
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...ISSUES_KEY], ctx.prev)
    },
    onSettled: (_d, _e, id) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...ISSUES_KEY] })
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
      await qc.cancelQueries({ queryKey: [...ISSUES_KEY] })
      const prev = qc.getQueryData<BoardIssue[]>([...ISSUES_KEY]) ?? []
      markPending(id)
      patchCache(qc, (p) =>
        p.map((i) =>
          i.id === id
            ? { ...i, awaiting_input: false, awaiting_question: null }
            : i,
        ),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...ISSUES_KEY], ctx.prev)
    },
    onSettled: (_d, _e, { id }) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...ISSUES_KEY] })
    },
  })

  // ── discard (optimistic removal from the board; undo via restore) ──────────
  const discard = useMutation({
    mutationFn: (id: string) => boardApi.discard(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: [...ISSUES_KEY] })
      const prev = qc.getQueryData<BoardIssue[]>([...ISSUES_KEY]) ?? []
      markPending(id)
      patchCache(qc, (p) => p.filter((i) => i.id !== id))
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...ISSUES_KEY], ctx.prev)
    },
    onSettled: (_d, _e, id) => {
      clearPending(id)
      return qc.invalidateQueries({ queryKey: [...ISSUES_KEY] })
    },
  })

  // ── restore (un-discard — powers the discard toast's Undo) ─────────────────
  const restore = useMutation({
    mutationFn: (id: string) => boardApi.restore(id),
    onSettled: () => qc.invalidateQueries({ queryKey: [...ISSUES_KEY] }),
  })

  const error = (issuesQuery.error ?? statusesQuery.error) as Error | null

  return useMemo<UseBoardResult>(
    () => ({
      issues: issuesQuery.data ?? [],
      statuses: statusesQuery.data ?? [],
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

export { BoardError }

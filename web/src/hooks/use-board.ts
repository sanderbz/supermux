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

import { useCallback, useMemo } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'

import {
  boardApi,
  BoardError,
  type BoardIssue,
  type BoardIssuePatch,
  type BoardStatus,
  type ClaimResult,
  type NewBoardIssue,
} from '@/lib/api'
import { useSse, type SseEventType } from '@/hooks/use-sse'

const ISSUES_KEY = ['board', 'issues'] as const
const STATUSES_KEY = ['board', 'statuses'] as const

export interface ClaimArgs {
  id: string
  session: string
  /** Auto-send the work to the agent (S3). Defaults to true (user decision).
   *  Pass `false` for "Claim only" — flip the link without dispatching. */
  deliver?: boolean
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
  deleteIssue: (id: string) => Promise<void>

  // Column (status) management.
  createStatus: (label: string) => Promise<BoardStatus>
  renameStatus: (id: string, label: string) => Promise<void>
  deleteStatus: (id: string) => Promise<void>
  reorderStatuses: (order: string[]) => Promise<void>
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

/** Subscribe the board cache to the SHARED SSE stream's `board` event. No
 *  standalone EventSource — `useSse` owns the one app-wide connection (M12).
 *  No polling. */
function useBoardSse(qc: QueryClient) {
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
        qc.setQueryData<BoardIssue[]>([...ISSUES_KEY], board)
        return
      }
      void qc.invalidateQueries({ queryKey: [...ISSUES_KEY] })
      void qc.invalidateQueries({ queryKey: [...STATUSES_KEY] })
    },
    [qc],
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
  useBoardSse(qc)

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
      const optimistic: BoardIssue = {
        id: `optimistic-${Date.now()}`,
        title: input.title,
        desc: input.desc ?? '',
        status: input.status ?? 'todo',
        session: input.session ?? null,
        creator: '',
        due: input.due ?? null,
        due_time: input.due_time ?? null,
        created: Math.floor(Date.now() / 1000),
        updated: Math.floor(Date.now() / 1000),
        owner_type: input.owner_type ?? 'human',
        pinned: 0,
        // New cards sit at the top of their column (negative pos).
        pos: Math.min(0, ...prev.map((i) => i.pos)) - 1024,
        tags: input.tags ?? [],
        // A brand-new card has no relations yet (S1/S2: always-present arrays).
        comments: [],
        acceptance: [],
        links: [],
      }
      patchCache(qc, (p) => [optimistic, ...p])
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...ISSUES_KEY], ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [...ISSUES_KEY] }),
  })

  // ── patch (optimistic merge, rollback on error) ────────────────────────────
  const patch = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: BoardIssuePatch }) =>
      boardApi.patch(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: [...ISSUES_KEY] })
      const prev = qc.getQueryData<BoardIssue[]>([...ISSUES_KEY]) ?? []
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
    onSettled: () => qc.invalidateQueries({ queryKey: [...ISSUES_KEY] }),
  })

  // ── atomic claim (optimistic move → doing, rollback shows the 409) ─────────
  const claim = useMutation({
    mutationFn: ({ id, session, deliver }: ClaimArgs) =>
      boardApi.claim(id, session, deliver ?? true),
    onMutate: async ({ id, session }) => {
      await qc.cancelQueries({ queryKey: [...ISSUES_KEY] })
      const prev = qc.getQueryData<BoardIssue[]>([...ISSUES_KEY]) ?? []
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
    onSettled: () => qc.invalidateQueries({ queryKey: [...ISSUES_KEY] }),
  })

  // ── delete (optimistic removal, rollback on error) ─────────────────────────
  const remove = useMutation({
    mutationFn: (id: string) => boardApi.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: [...ISSUES_KEY] })
      const prev = qc.getQueryData<BoardIssue[]>([...ISSUES_KEY]) ?? []
      patchCache(qc, (p) => p.filter((i) => i.id !== id))
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...ISSUES_KEY], ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [...ISSUES_KEY] }),
  })

  // ── column management (invalidate statuses on settle) ──────────────────────
  const invalidateStatuses = () =>
    qc.invalidateQueries({ queryKey: [...STATUSES_KEY] })
  const createStatus = useMutation({
    mutationFn: (label: string) => boardApi.createStatus(label),
    onSettled: invalidateStatuses,
  })
  const renameStatus = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      boardApi.renameStatus(id, label),
    onSettled: invalidateStatuses,
  })
  const deleteStatus = useMutation({
    mutationFn: (id: string) => boardApi.deleteStatus(id),
    onSettled: invalidateStatuses,
  })
  const reorderStatuses = useMutation({
    mutationFn: (order: string[]) => boardApi.reorderStatuses(order),
    onMutate: async (order) => {
      await qc.cancelQueries({ queryKey: [...STATUSES_KEY] })
      const prev = qc.getQueryData<BoardStatus[]>([...STATUSES_KEY]) ?? []
      const byId = new Map(prev.map((s) => [s.id, s]))
      const next = order
        .map((id, idx) => {
          const s = byId.get(id)
          return s ? { ...s, position: idx } : null
        })
        .filter((s): s is BoardStatus => s !== null)
      if (next.length) qc.setQueryData([...STATUSES_KEY], next)
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([...STATUSES_KEY], ctx.prev)
    },
    onSettled: invalidateStatuses,
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
      deleteIssue: (id) => remove.mutateAsync(id).then(() => undefined),
      createStatus: (label) => createStatus.mutateAsync(label),
      renameStatus: (id, label) =>
        renameStatus.mutateAsync({ id, label }).then(() => undefined),
      deleteStatus: (id) => deleteStatus.mutateAsync(id).then(() => undefined),
      reorderStatuses: (order) =>
        reorderStatuses.mutateAsync(order).then(() => undefined),
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

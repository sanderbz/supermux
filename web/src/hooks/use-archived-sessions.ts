// useArchivedSessions — the recovery data layer for the Archived sheet
// (feat-archive-recover).
//
// Archive is a soft delete (`archived = 1`, never DELETE) with an existing
// `unarchive` endpoint, but archived rows are otherwise unbrowsable (the main
// `GET /api/sessions` filters `archived = 0`) and there is no UI to restore or
// permanently delete them. This hook backs the opt-in Archived sheet:
//
//   • `GET /api/sessions/archived` via TanStack Query, keyed separately from the
//     live list so it never competes with the overview's SSE-merged cache.
//   • `restore(name)` → `POST .../unarchive`: the server flips `archived = 0`
//     and broadcasts a `sessions` SSE delta that re-adds the row to the LIVE
//     overview cache live (handled in use-sessions.ts). Here we only drop the
//     row from the ARCHIVED cache so the sheet updates in place.
//   • `purge(name)` → `DELETE .../purge`: hard delete (archived-only). We drop
//     the row from the archived cache on success.
//
// No SSE feeds the archived list (it's an opt-in surface, not always-on estate),
// so we refetch on each open via `enabled` + `staleTime: 0`.

import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { sessionsApi, type ApiSession } from '@/lib/api'

export const ARCHIVED_SESSIONS_KEY = ['sessions', 'archived'] as const

export interface UseArchivedSessionsResult {
  archived: ApiSession[]
  isLoading: boolean
  isError: boolean
  /** Force a refetch of the archived list. */
  refetch: () => void
  /** Restore (unarchive) a session — returns to the live overview via SSE. */
  restore: (name: string) => Promise<void>
  /** Permanently delete an archived session (irreversible). */
  purge: (name: string) => Promise<void>
  /** Permanently delete EVERY archived session in the current list. Best-effort
   *  per-row — fans out [`purge`] calls in parallel, resolves with `{ ok, failed }`
   *  counts so the sheet can toast a precise outcome. Each row that succeeds
   *  drops from the archived cache the moment its individual mutation lands, so
   *  the sheet empties progressively even on slow networks. */
  purgeAll: () => Promise<{ ok: number; failed: number }>
  /** Names currently mid-flight, so the sheet can disable their row actions. */
  pending: Set<string>
}

/** Drop one row (by name) from the cached archived list. */
function dropFromArchivedCache(
  qc: ReturnType<typeof useQueryClient>,
  name: string,
) {
  qc.setQueryData<ApiSession[]>(ARCHIVED_SESSIONS_KEY, (prev) =>
    (prev ?? []).filter((s) => s.name !== name),
  )
}

/** `enabled` gates the fetch so the request only fires while the sheet is open
 *  (the entry points pass their open state). Defaults to always-enabled so the
 *  overflow item can read a count without mounting the sheet. */
export function useArchivedSessions(
  enabled = true,
): UseArchivedSessionsResult {
  const qc = useQueryClient()
  const [pending, setPending] = React.useState<Set<string>>(() => new Set())

  const query = useQuery({
    queryKey: ARCHIVED_SESSIONS_KEY,
    queryFn: sessionsApi.listArchived,
    enabled,
    // Opt-in surface with no SSE backing — always re-pull when (re)enabled so a
    // session archived since the last open shows up.
    staleTime: 0,
  })

  const mark = React.useCallback((name: string, on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev)
      if (on) next.add(name)
      else next.delete(name)
      return next
    })
  }, [])

  const restoreMut = useMutation({
    mutationFn: (name: string) => sessionsApi.unarchive(name),
    onMutate: (name) => mark(name, true),
    onSuccess: (_data, name) => {
      // The live overview re-adds the row via the unarchive SSE delta; here we
      // only need to remove it from the archived list so the sheet updates.
      dropFromArchivedCache(qc, name)
    },
    onSettled: (_d, _e, name) => mark(name, false),
  })

  const purgeMut = useMutation({
    mutationFn: (name: string) => sessionsApi.purge(name),
    onMutate: (name) => mark(name, true),
    onSuccess: (_data, name) => dropFromArchivedCache(qc, name),
    onSettled: (_d, _e, name) => mark(name, false),
  })

  // "Delete all": fan out individual purge mutations in parallel so each
  // row drops from the archived cache (via `purgeMut.onSuccess`) the moment
  // ITS request resolves — the sheet empties progressively rather than waiting
  // for the whole batch. We deliberately reuse the per-row mutation rather
  // than calling `sessionsApi.purge` directly so:
  //   1. The `pending` set marks every in-flight name (rows go busy together).
  //   2. The cache-drop side-effect runs per row, matching the per-row UX.
  //   3. A backend purge-all endpoint can later replace the inner call here
  //      without touching the sheet.
  // `allSettled` (not `all`) so one row's failure never short-circuits the rest.
  const purgeAll = React.useCallback(async () => {
    const names = (query.data ?? []).map((s) => s.name)
    const results = await Promise.allSettled(
      names.map((n) => purgeMut.mutateAsync(n)),
    )
    let ok = 0
    let failed = 0
    for (const r of results) {
      if (r.status === 'fulfilled') ok += 1
      else failed += 1
    }
    return { ok, failed }
  }, [query.data, purgeMut])

  return {
    archived: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
    restore: (name) => restoreMut.mutateAsync(name),
    purge: (name) => purgeMut.mutateAsync(name),
    purgeAll,
    pending,
  }
}

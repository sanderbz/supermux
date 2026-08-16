// useOverviewLayout — the account-wide sort + custom-groups state hook
// (feat-sort-and-groups).
//
// ONE TanStack query against `/api/prefs/overview_layout`, ONE mutation that
// PUTs the same key. The pref is opaque to the server — we serialize the
// `OverviewLayout` JSON ourselves so the server stays a dumb key/value store
// and the data shape lives in ONE place (`lib/overview-layout.ts`).
//
// Cross-tab / cross-device sync: the existing SSE `prefs` event from the
// backend invalidates this query when any peer writes (the listener is added
// to `use-sessions.ts`'s shared SSE subscription so we don't open a second
// EventSource — anti-vision: WebSocket-only, no polling).
//
// Optimistic update: typing in the sort control or dragging a tile must FEEL
// instant. The mutation writes through to the cache immediately and rolls back
// on error (rare — would only happen on a 5xx; offline auto-retries via TQ's
// default mutation handling).

import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { settingsApi } from '@/lib/api'
import {
  DEFAULT_LAYOUT,
  migrateLegacyGroupSort,
  OVERVIEW_LAYOUT_PREF_KEY,
  parseLayout,
  serializeLayout,
  withGroupSortMode,
  withoutGroupSortMode,
  type GroupBy,
  type GroupSortMode,
  type OverviewLayout,
  type SortMode,
} from '@/lib/overview-layout'

export const OVERVIEW_LAYOUT_KEY = ['prefs', OVERVIEW_LAYOUT_PREF_KEY] as const

export interface UseOverviewLayoutResult {
  layout: OverviewLayout
  isLoading: boolean
  setMode: (mode: SortMode) => void
  setLayout: (next: OverviewLayout) => void
  /** Per-group sort (fase B2 T9 — this used to be localStorage). */
  setGroupSort: (groupId: string, mode: GroupSortMode) => void
  /** Drop a deleted group's sort mode so the blob does not grow forever. */
  clearGroupSort: (groupId: string) => void
  /** The derived grouping preset. */
  setGroupBy: (groupBy: GroupBy) => void
}

export function useOverviewLayout(): UseOverviewLayoutResult {
  const qc = useQueryClient()

  const query = useQuery({
    queryKey: OVERVIEW_LAYOUT_KEY,
    queryFn: async () => parseLayout(await settingsApi.getPref(OVERVIEW_LAYOUT_PREF_KEY)),
    // Pref data is essentially fresh forever — SSE invalidates it on writes.
    staleTime: Infinity,
    // 404 (unknown key on an older server) is treated as "unset" by `getPref`,
    // so this only fires on a real network/server failure. One retry is enough.
    retry: 1,
  })

  const mutate = useMutation({
    mutationFn: async (next: OverviewLayout) => {
      await settingsApi.putPref(OVERVIEW_LAYOUT_PREF_KEY, serializeLayout(next))
      return next
    },
    // Optimistic: cache writes first so the UI feels instant (no round-trip
    // delay on the sort flip). On error, rollback to the prior snapshot.
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: OVERVIEW_LAYOUT_KEY })
      const prev = qc.getQueryData<OverviewLayout>(OVERVIEW_LAYOUT_KEY)
      qc.setQueryData<OverviewLayout>(OVERVIEW_LAYOUT_KEY, next)
      return { prev }
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(OVERVIEW_LAYOUT_KEY, ctx.prev)
      }
    },
    // The SSE `prefs` event re-invalidates the key when peers write; we don't
    // need an extra invalidate on success (avoids a redundant refetch).
  })

  const layout = query.data ?? DEFAULT_LAYOUT

  const setMode = React.useCallback(
    (mode: SortMode) => {
      mutate.mutate({ ...layout, mode })
    },
    [layout, mutate],
  )

  const setLayout = React.useCallback(
    (next: OverviewLayout) => {
      mutate.mutate(next)
    },
    [mutate],
  )

  const setGroupSort = React.useCallback(
    (groupId: string, mode: GroupSortMode) => {
      mutate.mutate(withGroupSortMode(layout, groupId, mode))
    },
    [layout, mutate],
  )

  const clearGroupSort = React.useCallback(
    (groupId: string) => {
      const next = withoutGroupSortMode(layout, groupId)
      if (next !== layout) mutate.mutate(next)
    },
    [layout, mutate],
  )

  const setGroupBy = React.useCallback(
    (groupBy: GroupBy) => {
      mutate.mutate({ ...layout, groupBy })
    },
    [layout, mutate],
  )

  // ONE-TIME localStorage → blob migration (fase B2 T9). Runs once the pref has
  // actually loaded, so a slow first fetch cannot fold values into DEFAULT_LAYOUT
  // and PUT a blob that discards the user's real one. `migrateLegacyGroupSort`
  // returns null when there is nothing to move, so a user who never set a
  // per-group sort never triggers a write.
  const migrated = React.useRef(false)
  React.useEffect(() => {
    if (migrated.current || query.isLoading || !query.data) return
    migrated.current = true
    const next = migrateLegacyGroupSort(query.data)
    if (next) mutate.mutate(next)
  }, [query.isLoading, query.data, mutate])

  return {
    layout,
    isLoading: query.isLoading,
    setMode,
    setLayout,
    setGroupSort,
    clearGroupSort,
    setGroupBy,
  }
}

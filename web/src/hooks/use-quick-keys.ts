// useQuickKeys — the account-wide quick-keys selection state hook.
//
// ONE TanStack query against `/api/prefs/quick_keys`, ONE optimistic mutation
// that PUTs the same key. The pref is opaque to the server — we serialize the
// id list ourselves so the server stays a dumb key/value store and the data
// shape lives in ONE place (`components/focus-mode/quick-keys.ts`). Mirrors the
// `useOverviewLayout` pattern end-to-end (read-once + SSE-invalidate + 404-as-
// unset graceful fallback), so a server lagging the client degrades to the
// default selection, never a crash.
//
// Cross-tab / cross-device sync: the SSE `prefs` event (routed in
// use-sessions.ts) invalidates this query when any peer writes — no second
// EventSource (anti-vision: WebSocket-only, no polling).

import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { settingsApi } from '@/lib/api'
import {
  DEFAULT_QUICK_SELECTION,
  QUICK_KEYS_PREF_KEY,
  parseQuickKeys,
  serializeQuickKeys,
} from '@/components/focus-mode/quick-keys'

export const QUICK_KEYS_QUERY_KEY = ['prefs', QUICK_KEYS_PREF_KEY] as const

export interface UseQuickKeysResult {
  /** The ordered selected entry ids (always populated — defaults on a miss). */
  selected: string[]
  isLoading: boolean
  /** Replace the whole ordered selection (toggle on/off, reorder). */
  setSelected: (next: string[]) => void
}

export function useQuickKeys(): UseQuickKeysResult {
  const qc = useQueryClient()

  const query = useQuery({
    queryKey: QUICK_KEYS_QUERY_KEY,
    queryFn: async () =>
      parseQuickKeys(await settingsApi.getPref(QUICK_KEYS_PREF_KEY)).selected,
    // Pref data is essentially fresh forever — SSE invalidates it on writes.
    staleTime: Infinity,
    // 404 (unknown key on an older server) is treated as "unset" by `getPref`,
    // which yields the default selection; one retry covers a real flake.
    retry: 1,
  })

  const mutate = useMutation({
    mutationFn: async (next: string[]) => {
      await settingsApi.putPref(
        QUICK_KEYS_PREF_KEY,
        serializeQuickKeys({ selected: next }),
      )
      return next
    },
    // Optimistic: cache writes first so a toggle feels instant. Rollback on err.
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: QUICK_KEYS_QUERY_KEY })
      const prev = qc.getQueryData<string[]>(QUICK_KEYS_QUERY_KEY)
      qc.setQueryData<string[]>(QUICK_KEYS_QUERY_KEY, next)
      return { prev }
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(QUICK_KEYS_QUERY_KEY, ctx.prev)
      }
    },
    // SSE re-syncs on peer writes; no extra invalidate on success.
  })

  const selected = query.data ?? DEFAULT_QUICK_SELECTION

  const setSelected = React.useCallback(
    (next: string[]) => {
      mutate.mutate(next)
    },
    [mutate],
  )

  return {
    selected,
    isLoading: query.isLoading,
    setSelected,
  }
}

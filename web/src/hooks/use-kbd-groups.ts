// M16 — keyboard-accessory groups data hook.
//
// TanStack Query wrapper around `kbdApi` (`/api/kbd-groups`). The backend M9
// table is the single canonical store; this hook just reads/writes it. Until a
// build has that handler wired, the GET 404/501s — `retry: false` surfaces it
// immediately and the hook falls back to the local `DEFAULT_KBD_GROUPS` seed
// (the same four groups the server seeds), so the accessory bar always renders
// the four function groups regardless of backend state.
//
// The manage-sheet does reorder / add / remove, but persistence is a single
// canonical PUT of the WHOLE list (`replaceKbdGroups`) — the table is never
// left half-written. An optimistic `setQueryData` makes the edit feel instant.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'

import { kbdApi, type KbdGroup } from '@/lib/api'
import { DEFAULT_KBD_GROUPS } from '@/components/focus-mode/kbd-groups'

const KBD_KEY = ['kbd-groups'] as const

/** The live ordered group list. `data` is ALWAYS populated — on a backend miss
 *  it resolves to `DEFAULT_KBD_GROUPS` so callers never branch on undefined. */
export function useKbdGroups(): UseQueryResult<KbdGroup[]> & {
  groups: KbdGroup[]
} {
  const query = useQuery({
    queryKey: KBD_KEY,
    queryFn: kbdApi.listKbdGroups,
    retry: false,
    staleTime: 60_000,
  })
  return { ...query, groups: query.data ?? DEFAULT_KBD_GROUPS }
}

/** Replace the whole ordered list (reorder / add / remove all funnel here).
 *  Optimistic: the cache updates before the round-trip; a failure rolls back. */
export function useReplaceKbdGroups() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (groups: KbdGroup[]) => kbdApi.replaceKbdGroups(groups),
    onMutate: async (groups) => {
      await qc.cancelQueries({ queryKey: KBD_KEY })
      const prev = qc.getQueryData<KbdGroup[]>(KBD_KEY)
      qc.setQueryData(KBD_KEY, groups)
      return { prev }
    },
    onError: (_err, _groups, ctx) => {
      if (ctx?.prev) qc.setQueryData(KBD_KEY, ctx.prev)
    },
    onSuccess: (data) => qc.setQueryData(KBD_KEY, data),
  })
}

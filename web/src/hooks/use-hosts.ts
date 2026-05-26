// useHosts — TanStack-Query data layer for the remote-hosts surface
// (REMOTE_PLAN.md RT9). Hosts CRUD is on-demand only: the data is fetched when
// the /hosts route mounts AND when the new-session sheet opens its host
// picker. No SSE deltas (RT8 doesn't broadcast host changes — they're rare and
// user-driven), so this is a vanilla TanStack Query against `GET /api/hosts`
// with mutations invalidating the cache. `useHostsLight` is a thinner variant
// for the host-picker dropdown — same cache key, same fetch, just so the read
// site doesn't have to spell out the QueryKey twice.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  hostsApi,
  type BootstrapInput,
  type BootstrapReport,
  type CheckResult,
  type CreateHostInput,
  type Host,
} from '@/lib/api'

export const HOSTS_KEY = ['hosts'] as const

/** Fetch the live host list. Shared cache key — both /hosts and the
 *  host-picker call this; the second mount hits the cache instantly. */
export function useHosts() {
  return useQuery<Host[]>({
    queryKey: HOSTS_KEY,
    queryFn: hostsApi.list,
    staleTime: 30_000,
  })
}

/** `POST /api/hosts` + cache invalidate. The server runs an auto-check on
 *  create, so the returned `Host` already carries a fresh `status`. */
export function useCreateHost() {
  const qc = useQueryClient()
  return useMutation<Host, Error, CreateHostInput>({
    mutationFn: hostsApi.create,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: HOSTS_KEY })
    },
  })
}

/** `DELETE /api/hosts/{id}` + cache invalidate. 409 (active sessions) bubbles
 *  up as a `HostError` so the route can show the message inline. */
export function useDeleteHost() {
  const qc = useQueryClient()
  return useMutation<void, Error, number>({
    mutationFn: (id) => hostsApi.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: HOSTS_KEY })
    },
  })
}

/** `POST /api/hosts/{id}/check` + cache invalidate (so the row's `status`
 *  pill flips after a manual recheck). */
export function useCheckHost() {
  const qc = useQueryClient()
  return useMutation<CheckResult, Error, number>({
    mutationFn: (id) => hostsApi.check(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: HOSTS_KEY })
    },
  })
}

/** `POST /api/hosts/{id}/bootstrap`. Doesn't invalidate (the report is shown
 *  inline in the sheet; host state didn't change as a result of running it). */
export function useBootstrapHost() {
  return useMutation<
    BootstrapReport,
    Error,
    { id: number; input?: BootstrapInput }
  >({
    mutationFn: ({ id, input }) => hostsApi.bootstrap(id, input),
  })
}

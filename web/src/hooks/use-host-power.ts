// The host-power state: what this host supports and a pending Mac restart.
// Read once, then kept live by the owner-only `host-power` SSE frame, so a
// countdown started on the phone shows (with Cancel) on every open app.

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { hostPowerApi, type HostPower } from '@/lib/api/host-power'
import { useSse, type SseEventType } from '@/hooks/use-sse'

export const HOST_POWER_KEY = ['host-power'] as const

export function useHostPower(enabled: boolean) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: HOST_POWER_KEY,
    queryFn: hostPowerApi.get,
    enabled,
    staleTime: 60_000,
    // A member (or an older server) gets a 404: nothing to show, not an error.
    retry: false,
  })
  const handlers = React.useMemo(
    () => ({
      onEvent: (type: SseEventType, payload: unknown) => {
        if (type !== 'host-power') return
        const pending = (payload as { pending?: HostPower['pending'] } | null)?.pending ?? null
        qc.setQueryData<HostPower>(HOST_POWER_KEY, (prev) => (prev ? { ...prev, pending } : prev))
      },
      onResync: () => {
        void qc.invalidateQueries({ queryKey: HOST_POWER_KEY })
      },
    }),
    [qc],
  )
  useSse(handlers)
  return query
}

/** Re-render once a second while `active`, for a countdown. */
export function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const t = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [active])
  return now
}

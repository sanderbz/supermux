// The A1 transcript poll: /recall?chat=true for the FOCUSED session only,
// re-pulled on the session's own SSE ticks (status flips, activity deltas)
// with a trailing debounce — never an interval, never other sessions. The
// chat WS replaces this in fase A2.

import * as React from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'

import { sessionsApi, type RecallResponse } from '@/lib/api'
import { useSse, type SseEventType } from '@/hooks/use-sse'

const DEBOUNCE_MS = 1200

export function useChatTail(
  name: string,
  enabled: boolean,
): UseQueryResult<RecallResponse> {
  const qc = useQueryClient()
  const key = React.useMemo(() => ['chat-tail', name] as const, [name])

  const query = useQuery({
    queryKey: key,
    queryFn: () => sessionsApi.recall(name, { chat: true, limit: 30 }),
    enabled,
    staleTime: 1_000,
    retry: false,
  })

  // Trailing debounce so a burst of deltas (a landing batch) costs one refetch.
  // (Turn-END confirmation is NOT debounced — ChatPanel calls query.refetch()
  // directly on the active→idle edge; a 1.2s blank gap there is the exact
  // supersede glitch checkpoint (c) forbids.)
  const timer = React.useRef<number | null>(null)
  const bump = React.useCallback(() => {
    if (timer.current != null) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      void qc.invalidateQueries({ queryKey: key })
    }, DEBOUNCE_MS)
  }, [qc, key])
  React.useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = null
    },
    [name],
  )

  const handlers = React.useMemo(
    () => ({
      onEvent: (type: SseEventType, payload: unknown) => {
        if (!enabled) return
        if (type !== 'sessions' && type !== 'status') return
        const p = payload as {
          name?: string
          delta?: { name?: string }[]
        } | null
        const hit =
          p?.name === name || p?.delta?.some((d) => d?.name === name) === true
        if (hit) bump()
      },
      onResync: () => {
        if (enabled) void qc.invalidateQueries({ queryKey: key })
      },
    }),
    [enabled, name, bump, qc, key],
  )
  useSse(handlers)

  return query
}

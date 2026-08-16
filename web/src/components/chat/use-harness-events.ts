// The harness feed for the FOCUSED session — the transcript's management log.
//
// Deliberately shaped like `use-chat-tail.ts`, because it has the same job for
// the other half of the transcript: one query for one session, re-pulled on the
// server's own ticks with a trailing debounce, never an interval and never
// another session's events.
//
// SSE IS THE ECHO, THE LEDGER IS THE TRUTH. The `harness` frame carries the new
// row inline, and this hook throws it away on purpose: it uses the frame only
// to decide whether THIS session is affected, then refetches `/events`. Merging
// the frame into the cache would build a second, divergent source of transcript
// truth that a reload would silently correct — which is exactly the class of bug
// the durable feed exists to end.

import * as React from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'

import { harnessApi, type HarnessEvent } from '@/lib/api/harness'
import { useSse, type SseEventType } from '@/hooks/use-sse'

const DEBOUNCE_MS = 1200

/** The `harness` SSE payload — an invalidation hint, not content. */
interface HarnessFrame {
  sessions?: unknown
}

function affects(payload: unknown, name: string): boolean {
  const sessions = (payload as HarnessFrame | null)?.sessions
  return Array.isArray(sessions) && sessions.some((s) => s === name)
}

export function useHarnessEvents(
  name: string,
  enabled: boolean,
): UseQueryResult<HarnessEvent[]> {
  const qc = useQueryClient()
  const key = React.useMemo(() => ['harness-events', name] as const, [name])

  const query = useQuery({
    queryKey: key,
    queryFn: () => harnessApi.events(name),
    enabled,
    staleTime: 1_000,
    retry: false,
  })

  // Trailing debounce: a fan-out that writes six delegate rows in one breath
  // costs one refetch, not six.
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
        if (!enabled || type !== 'harness') return
        if (affects(payload, name)) bump()
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

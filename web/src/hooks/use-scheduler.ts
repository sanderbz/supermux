// useScheduler — TanStack Query bindings for the M8 scheduler backend (M21).
//
// Real-time, not polled (anti-vision: "WebSocket-only — no 3s polling"). The
// scheduler tick pushes `alerts` SSE events (server/src/scheduler/runner.rs)
// when a job fires; `useSchedulerStream` opens ONE authenticated EventSource to
// `/api/events` and invalidates the schedules + runs caches on each scheduler
// event, so the list's next_run / last_run / run history refresh live the moment
// a fire lands — no interval, ever. (The shared `use-sse.ts` is still a M12 stub
// in this milestone's tree, so this hook owns its own scheduler-scoped stream;
// it converges with the shared store once M12 merges.)

import * as React from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'

import {
  schedulerApi,
  type ScheduleCreateInput,
  type SchedulePatchInput,
  type ScheduleRow,
  type ScheduleRunRow,
} from '@/lib/api'
import { authToken, baseUrl } from '@/env'

const SCHEDULES_KEY = ['schedules'] as const
const runsKey = (id: string) => ['schedules', 'runs', id] as const

/** All schedules. SSE invalidates this on every fire — see useSchedulerStream. */
export function useSchedules() {
  return useQuery<ScheduleRow[]>({
    queryKey: SCHEDULES_KEY,
    queryFn: schedulerApi.list,
    staleTime: 30_000,
    retry: false,
  })
}

/** Last 20 runs for one schedule (the detail-sheet history). Disabled until a
 *  schedule is opened. */
export function useScheduleRuns(id: string | null) {
  return useQuery<ScheduleRunRow[]>({
    queryKey: runsKey(id ?? ''),
    queryFn: () => schedulerApi.runs(id as string),
    enabled: !!id,
    staleTime: 10_000,
    retry: false,
  })
}

/** Create a schedule, then refresh the list. */
export function useCreateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ScheduleCreateInput) => schedulerApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  })
}

/** Patch a schedule (inline edit / enable-disable toggle), then refresh. */
export function usePatchSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SchedulePatchInput }) =>
      schedulerApi.patch(id, patch),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: SCHEDULES_KEY })
      qc.invalidateQueries({ queryKey: runsKey(id) })
    },
  })
}

/** Run a schedule now, then refresh its runs + the list (last_run changes). */
export function useRunSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => schedulerApi.runNow(id),
    // The fire is async on the server (202); the SSE event will land the fresh
    // run row, but we also nudge the cache after a short beat for snappiness.
    onSuccess: (_data, id) => {
      window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: SCHEDULES_KEY })
        qc.invalidateQueries({ queryKey: runsKey(id) })
      }, 600)
    },
  })
}

/** Delete a schedule, then refresh the list. */
export function useDeleteSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => schedulerApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  })
}

/** Test-fire a candidate schedule (run once, no persistence). */
export function useTestFire() {
  return useMutation({
    mutationFn: (input: ScheduleCreateInput) => schedulerApi.testFire(input),
  })
}

// ── live stream (SSE — never polling) ─────────────────────────────────────────

/** SSE endpoint base (same-origin fallback). The token rides as a query param
 *  because EventSource cannot set an Authorization header; the auth layer
 *  accepts `?_token=` (server/src/auth.rs). Token is read from `window` at
 *  runtime — never embedded in source. */
function eventsUrl(): string {
  const base = baseUrl().replace(/\/$/, '')
  const token = authToken()
  const q = token ? `?_token=${encodeURIComponent(token)}` : ''
  return `${base}/api/events${q}`
}

function invalidateScheduler(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: SCHEDULES_KEY })
  // Invalidate all run histories (any open detail sheet refreshes too).
  qc.invalidateQueries({ queryKey: ['schedules', 'runs'] })
}

/**
 * Subscribe the schedules cache to the live event stream. Mount once on the
 * Scheduler route. On any scheduler-sourced event (the tick fires a job → an
 * `alerts` event with `source:"scheduler"`, plus future `schedules` deltas),
 * invalidate the caches so the UI reflects the new run/next_run live. Pure
 * push — there is NO interval here.
 *
 * Reconnect: EventSource auto-reconnects on transient drops. On a hard error we
 * close + re-open with capped backoff so a server restart heals without a
 * reload.
 */
export function useSchedulerStream() {
  const qc = useQueryClient()

  React.useEffect(() => {
    let es: EventSource | null = null
    let closed = false
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const onMessage = (raw: MessageEvent) => {
      retry = 0
      let evt: { type?: string; payload?: { source?: string } } | null
      try {
        evt = JSON.parse(raw.data)
      } catch {
        return
      }
      if (!evt) return
      // Scheduler fires arrive as `alerts` with source "scheduler"; a dedicated
      // `schedules` delta channel (added by later milestones) also refreshes.
      const isScheduler =
        evt.type === 'schedules' ||
        (evt.type === 'alerts' && evt.payload?.source === 'scheduler')
      if (isScheduler) invalidateScheduler(qc)
    }

    const connect = () => {
      if (closed) return
      es = new EventSource(eventsUrl())
      es.onmessage = onMessage
      // Named events (the server may tag the SSE `event:` field).
      es.addEventListener('alerts', onMessage as EventListener)
      es.addEventListener('schedules', onMessage as EventListener)
      es.onerror = () => {
        if (closed) return
        es?.close()
        es = null
        // Decorrelated-ish capped backoff (300ms × 2^n, max 30s).
        const delay = Math.min(300 * 2 ** retry, 30_000)
        retry += 1
        timer = setTimeout(connect, delay)
      }
    }

    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      es?.close()
    }
  }, [qc])
}

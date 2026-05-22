// useScheduler — TanStack Query bindings for the M8 scheduler backend (M21).
//
// Real-time, not polled (anti-vision: "WebSocket-only — no 3s polling"). The
// scheduler tick pushes `alerts` SSE events (server/src/scheduler/runner.rs)
// when a job fires; `useSchedulerStream` subscribes to the SHARED `use-sse.ts`
// stream (M12) — the one app-wide EventSource — and invalidates the schedules +
// runs caches on each scheduler event, so the list's next_run / last_run / run
// history refresh live the moment a fire lands — no interval, ever, and no
// second connection.

import { useCallback, useMemo } from 'react'
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
import { useSse, type SseEventType } from '@/hooks/use-sse'

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

function invalidateScheduler(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: SCHEDULES_KEY })
  // Invalidate all run histories (any open detail sheet refreshes too).
  qc.invalidateQueries({ queryKey: ['schedules', 'runs'] })
}

/**
 * Subscribe the schedules cache to the SHARED live event stream (`use-sse.ts`,
 * M12 — the one app-wide EventSource). Mount once on the Scheduler route. On any
 * scheduler-sourced event (the tick fires a job → an `alerts` event with
 * `source:"scheduler"`, plus `schedules` deltas), invalidate the caches so the
 * UI reflects the new run/next_run live. Pure push — there is NO interval here,
 * and NO second EventSource: reconnect/backoff/staleness are all owned by
 * `useSse`.
 */
export function useSchedulerStream() {
  const qc = useQueryClient()

  const onEvent = useCallback(
    (type: SseEventType, payload: unknown) => {
      // Scheduler fires arrive as `alerts` with source "scheduler"; a dedicated
      // `schedules` delta channel also refreshes.
      const source = (payload as { source?: string; payload?: { source?: string } })
      const isScheduler =
        type === 'schedules' ||
        (type === 'alerts' &&
          (source?.source === 'scheduler' ||
            source?.payload?.source === 'scheduler'))
      if (isScheduler) invalidateScheduler(qc)
    },
    [qc],
  )
  // On a focus/visibility/online resync after a quiet stretch, re-pull schedules
  // so a missed fire is reconciled. Still no polling.
  const onResync = useCallback(() => invalidateScheduler(qc), [qc])
  const handlers = useMemo(() => ({ onEvent, onResync }), [onEvent, onResync])
  useSse(handlers)
}

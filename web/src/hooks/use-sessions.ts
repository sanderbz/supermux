// useSessions — the session data layer (TECH_PLAN §M12; M2 backend contract;
// §3.6 hero data flow).
//
// TanStack Query against `GET /api/sessions`, invalidated/merged by the SSE
// `sessions` + `status` deltas — NEVER polled (anti-vision: "WebSocket-only —
// no 3s polling"). The query is the source of truth for the full list; the SSE
// stream pushes deltas that we merge KEY-BY-KEY into the cached rows (each delta
// item updates only the keys it carries — `preview_lines` and `status` move
// independently, §3.6). This is what makes the overview's live tail-preview the
// hero moment without a per-tile WebSocket.

import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  sessionsApi,
  SessionError,
  type ApiSession,
  type NewSession,
} from '@/lib/api'
import { useSse, type SseEventType } from '@/hooks/use-sse'
import { useSseConnectionLink } from '@/hooks/use-connection-link'

export const SESSIONS_KEY = ['sessions'] as const

export interface UseSessionsResult {
  sessions: ApiSession[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  /** Force a refetch of the full list. */
  refetch: () => void
  /** Create a session + (optionally) send its initial prompt. Resolves to the
   *  created row's name so the caller can navigate to `/focus/{name}`. */
  createSession: (input: NewSession) => Promise<string>
}

/** Merge one SSE delta row into a cached row, key by key (§3.6): only the keys
 *  present in `delta` overwrite — `preview_lines` and `status` update
 *  independently, so a status-only flip never blanks the tail-preview. */
function mergeRow(prev: ApiSession, delta: Partial<ApiSession>): ApiSession {
  const next: ApiSession = { ...prev }
  for (const k of Object.keys(delta) as (keyof ApiSession)[]) {
    const v = delta[k]
    if (v !== undefined) {
      // @ts-expect-error — index assignment across the union of value types.
      next[k] = v
    }
  }
  return next
}

/** Apply a `sessions` SSE payload to the cached list. The payload is an array of
 *  delta rows keyed by `name`; unknown names are appended (a session created in
 *  another tab), known names are merged. A row carrying `missing: true` /
 *  `status: 'stopped'` stays in the list (the tile shows the right state) — we
 *  only drop rows the next full refetch removes. */
function applyDelta(
  prev: ApiSession[] | undefined,
  delta: Partial<ApiSession>[],
): ApiSession[] {
  const list = prev ? [...prev] : []
  const indexByName = new Map(list.map((s, i) => [s.name, i]))
  for (const row of delta) {
    if (!row || typeof row.name !== 'string') continue
    const idx = indexByName.get(row.name)
    if (idx === undefined) {
      // New session seen via SSE before the next list refetch. Seed sane
      // defaults so the tile renders even from a partial delta.
      list.push({
        name: row.name,
        status: row.status ?? 'idle',
        dir: row.dir ?? '',
        provider: row.provider ?? 'claude',
        preview_lines: row.preview_lines ?? [],
        ...row,
      } as ApiSession)
      indexByName.set(row.name, list.length - 1)
    } else {
      list[idx] = mergeRow(list[idx], row)
    }
  }
  return list
}

/** Normalise a `status` event payload (`{name, status, version}`) into the same
 *  delta shape `applyDelta` consumes. */
function statusToDelta(payload: unknown): Partial<ApiSession>[] {
  if (!payload || typeof payload !== 'object') return []
  const p = payload as Record<string, unknown>
  if (typeof p.name !== 'string') return []
  const status = p.status
  if (typeof status !== 'string') return []
  return [{ name: p.name, status: status as ApiSession['status'] }]
}

/** DEV-only: `?mock=1` seeds the cache from the M11 mocks (overview dogfooding
 *  without a backend). When active, the live fetch is disabled so it can't
 *  overwrite the seed. Always `false` in a production build. */
function devMockActive(): boolean {
  return (
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('mock')
  )
}

export function useSessions(): UseSessionsResult {
  const qc = useQueryClient()
  const mock = devMockActive()

  const query = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: sessionsApi.list,
    staleTime: 30_000,
    enabled: !mock,
  })

  // The ONE place SSE deltas land. Calling setQueryData (not invalidate) means
  // the tail-preview updates in place with zero refetch round-trip — the §3.6
  // hero data flow. `status` deltas merge the same way.
  const handlers = React.useMemo(
    () => ({
      onEvent: (type: SseEventType, payload: unknown) => {
        if (type === 'sessions') {
          const delta = Array.isArray(payload)
            ? (payload as Partial<ApiSession>[])
            : Array.isArray((payload as { payload?: unknown })?.payload)
              ? ((payload as { payload: Partial<ApiSession>[] }).payload)
              : null
          if (delta) {
            qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) =>
              applyDelta(prev, delta),
            )
          }
        } else if (type === 'status') {
          const delta = statusToDelta(
            (payload as { payload?: unknown })?.payload ?? payload,
          )
          if (delta.length) {
            qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) =>
              applyDelta(prev, delta),
            )
          }
        }
      },
      // On focus/visibility/online after a quiet stretch, re-pull the list so a
      // missed delta (the stream was down) is reconciled. Still no polling.
      onResync: () => {
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
      },
    }),
    [qc],
  )

  // ONE SSE subscription for the whole app (§3.6). Its live `status` is the
  // SSE link in the global connection store — the <ReconnectBanner> (§M23a)
  // aggregates it with the live-terminal WebSockets. Single source, no polling.
  const { status: sseStatus } = useSse(handlers)
  useSseConnectionLink(sseStatus)

  const create = useMutation({
    mutationFn: async (input: NewSession): Promise<string> => {
      const created = await sessionsApi.create(input)
      const name = created?.name ?? input.name
      // Boot tmux + deliver the initial prompt (the Quick-start presets set a
      // `command`). Non-fatal if it fails — the row exists; the focus route can
      // start it. We swallow only network/501s, never a 409 from create.
      try {
        await sessionsApi.start(name, input.command)
      } catch {
        /* the session exists; start can be retried from focus */
      }
      return name
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
    },
  })

  return {
    sessions: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error) ?? null,
    refetch: () => void query.refetch(),
    createSession: (input) => create.mutateAsync(input),
  }
}

export { SessionError }

// ── Single-session selector (focus route) ──────────────────────────────────
// Derive one session from the shared list cache rather than a dedicated fetch,
// so the focus route shares the same SSE-merged source of truth.

export interface UseSessionResult {
  session: ApiSession | null
  isLoading: boolean
  isError: boolean
  error: Error | null
}

export function useSession(name: string): UseSessionResult {
  const { sessions, isLoading, isError, error } = useSessions()
  const session = React.useMemo(
    () => sessions.find((s) => s.name === name) ?? null,
    [sessions, name],
  )
  return { session, isLoading, isError, error }
}

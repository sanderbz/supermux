// useSessions — the session data layer.
//
// TanStack Query against `GET /api/sessions`, invalidated/merged by the SSE
// `sessions` + `status` deltas — NEVER polled (anti-vision: "WebSocket-only —
// no 3s polling"). The query is the source of truth for the full list; the SSE
// stream pushes deltas that we merge KEY-BY-KEY into the cached rows (each delta
// item updates only the keys it carries — `preview_lines` and `status` move
// independently). This is what makes the overview's live tail-preview the
// hero moment without a per-tile WebSocket.

import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  sessionsApi,
  SessionError,
  type ApiSession,
  type GitInfo,
  type NewSession,
} from '@/lib/api'
import { useSse, type SseEventType } from '@/hooks/use-sse'
import { OVERVIEW_LAYOUT_KEY } from '@/hooks/use-overview-layout'
import {
  parseLayout,
  OVERVIEW_LAYOUT_PREF_KEY,
  type OverviewLayout,
} from '@/lib/overview-layout'
import { QUICK_KEYS_QUERY_KEY } from '@/hooks/use-quick-keys'
import {
  parseQuickKeys,
  QUICK_KEYS_PREF_KEY,
} from '@/components/focus-mode/quick-keys'

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

/** Merge one SSE delta row into a cached row, key by key: only the keys
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
 *  only drop rows the backend tells us are gone (`archived: true`) or the next
 *  full refetch removes.
 *
 *  `allowAdd` gates the "append unknown name" branch: full `sessions` deltas
 *  may add (a session created in another tab); status-only deltas may NOT
 *  (otherwise a `stopped`-status event from a session we just optimistically
 *  removed via archive would re-add it — the archive bug). */
function applyDelta(
  prev: ApiSession[] | undefined,
  delta: Partial<ApiSession>[],
  allowAdd: boolean,
): ApiSession[] {
  const list = prev ? [...prev] : []
  const indexByName = new Map(list.map((s, i) => [s.name, i]))
  // Track removals so we rebuild the index only once at the end.
  let removed = false
  for (const row of delta) {
    if (!row || typeof row.name !== 'string') continue
    const idx = indexByName.get(row.name)
    // The backend broadcasts `archived: true` synchronously after flipping the
    // DB flag — drop the row immediately so every tab's overview updates
    // without waiting for a refetch.
    if (row.archived === true) {
      if (idx !== undefined) {
        list.splice(idx, 1)
        removed = true
        // Rebuild the index lazily after the loop; we keep iterating but use
        // a fresh lookup on the next mutation to avoid stale offsets.
        indexByName.clear()
        list.forEach((s, i) => indexByName.set(s.name, i))
      }
      continue
    }
    if (idx === undefined) {
      if (!allowAdd) continue
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
  // `removed` is just a marker so future maintainers see we intentionally
  // rebuild the index above; no-op otherwise.
  void removed
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

/** DEV-only: `?mock=1` seeds the cache from the mocks (overview dogfooding
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
  // the tail-preview updates in place with zero refetch round-trip — the
  // hero data flow. `status` deltas merge the same way.
  const handlers = React.useMemo(
    () => ({
      onEvent: (type: SseEventType, payload: unknown) => {
        if (type === 'sessions') {
          // Backend sends `{ delta: [...] }` (sessions/auto_actions.rs +
          // sessions/lifecycle.rs archive). Tolerate a bare array or
          // `{ payload: [...] }` envelope too — both older shapes are still
          // safe to merge.
          const obj = (payload ?? null) as
            | { delta?: unknown; payload?: unknown }
            | null
          const delta = Array.isArray(payload)
            ? (payload as Partial<ApiSession>[])
            : Array.isArray(obj?.delta)
              ? (obj.delta as Partial<ApiSession>[])
              : Array.isArray(obj?.payload)
                ? (obj.payload as Partial<ApiSession>[])
                : null
          if (delta) {
            qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) =>
              applyDelta(prev, delta, /* allowAdd */ true),
            )
          }
        } else if (type === 'status') {
          const delta = statusToDelta(
            (payload as { payload?: unknown })?.payload ?? payload,
          )
          if (delta.length) {
            // Status deltas merge into existing rows only — never add a new
            // tile. Otherwise a `stopped` status event from a session we just
            // optimistically removed via archive would re-add it.
            qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) =>
              applyDelta(prev, delta, /* allowAdd */ false),
            )
          }
        } else if (type === 'prefs') {
          // Account-wide prefs change from a peer tab / device
          // (feat-sort-and-groups). The server's `/api/prefs/:key` PUT handler
          // emits `{ key, value }` so we can route just the keys we own — the
          // overview layout cache, today; future keys can extend this switch.
          const p = (payload as { key?: unknown; value?: unknown }) ?? {}
          const valueIsStr = typeof p.value === 'string' || p.value === null
          if (p.key === OVERVIEW_LAYOUT_PREF_KEY && valueIsStr) {
            qc.setQueryData<OverviewLayout>(
              OVERVIEW_LAYOUT_KEY,
              parseLayout(p.value as string | null),
            )
          } else if (p.key === QUICK_KEYS_PREF_KEY && valueIsStr) {
            // Mobile quick-keys selection changed on a peer tab / device.
            qc.setQueryData<string[]>(
              QUICK_KEYS_QUERY_KEY,
              parseQuickKeys(p.value as string | null).selected,
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

  // Subscribe to the ONE shared SSE stream (singleton inside
  // `use-sse.ts`). The global connection-store link is registered once at the
  // shell level (Layout → useSseConnectionStatus) so the ReconnectBanner never
  // sees racing `'sse'` reports from multiple useSessions mount points.
  useSse(handlers)

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

/** Live git status for a session's working dir (feat-session-info). Fetched
 *  ON DEMAND — `enabled` gates it to when the info panel is open, so a closed
 *  panel never shells out to `git`. Short `staleTime` keeps a re-open snappy
 *  without re-running git on every render; not part of the SSE stream (git state
 *  isn't pushed), so window-focus refetch stays off to avoid surprise spawns. */
export function useSessionGit(name: string, enabled: boolean) {
  return useQuery<GitInfo>({
    queryKey: ['session-git', name],
    queryFn: () => sessionsApi.git(name),
    enabled: enabled && !!name,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  })
}

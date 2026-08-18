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
import { SESSION_RENDERER_QUERY_KEY } from '@/hooks/use-renderer-prefs-sync'
import {
  parseRendererPrefsOrNull,
  SESSION_RENDERER_PREF_KEY,
  type RendererState,
} from '@/components/chat/renderer-pref'

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

/** A short-lived record of names the backend just told us are gone, so a delta
 *  that was already in flight when the delete landed cannot resurrect the tile.
 *
 *  WHY this exists (the resurrection race): a hard DELETE / archive drops the
 *  row here, but the SSE stream is not ordered against the delete — a
 *  preview/activity/error `sessions` delta for that same name can have been
 *  queued microseconds earlier and arrive AFTER the removal. With no memory of
 *  the delete, that late delta takes the unknown-name branch (`allowAdd`) and
 *  RE-ADDS the session with synthetic defaults (`status: 'idle'`) — a deleted
 *  session comes back as a green Idle tile and lingers until a full resync.
 *
 *  The tombstone denies only a SYNTHETIC PARTIAL re-add (a preview/status/
 *  activity tick that carries a handful of keys) for a brief window after the
 *  delete — that is the only shape that can wrongly resurrect the tile. A FULL
 *  AUTHORITATIVE row for the name (the server re-listing the whole SessionView
 *  on unarchive/recreate — identifiable by its `dir` + `provider` identity
 *  columns, which no partial carries) is NEVER blocked: it means the session is
 *  really back, so it applies at once and clears the tombstone (w7). The window
 *  is intentionally short anyway: a genuine RE-CREATE of the same name (names
 *  are reusable) is a human action seconds+ later and must be allowed, so even
 *  a partial older than the TTL no longer blocks. An explicit create also
 *  clears it eagerly (`clearRemovalTombstone`), and any full refetch bypasses
 *  this path entirely (it replaces the cache from server truth). */
const REMOVAL_TOMBSTONE_TTL_MS = 15_000
const removalTombstones = new Map<string, number>()

/** Forget a name's tombstone — called on an explicit create so the recreated
 *  session's own deltas flow immediately instead of waiting out the TTL. */
export function clearRemovalTombstone(name: string): void {
  removalTombstones.delete(name)
}

/** Apply a `sessions` SSE payload to the cached list. The payload is an array of
 *  delta rows keyed by `name`; unknown names are appended (a session created in
 *  another tab), known names are merged. A row carrying `missing: true` /
 *  `status: 'stopped'` stays in the list (the tile shows the right state) — we
 *  only drop rows the backend tells us are gone (`archived: true` for a soft
 *  archive, `removed: true` for a hard delete) or the next full refetch removes.
 *
 *  `allowAdd` gates the "append unknown name" branch: full `sessions` deltas
 *  may add (a session created in another tab); status-only deltas may NOT
 *  (otherwise a `stopped`-status event from a session we just optimistically
 *  removed via archive would re-add it — the archive bug). Even when `allowAdd`
 *  is on, a name tombstoned by a just-seen delete is NOT re-added (see
 *  `removalTombstones`). */
export function applyDelta(
  prev: ApiSession[] | undefined,
  delta: Partial<ApiSession>[],
  allowAdd: boolean,
  tombstones: Map<string, number> = removalTombstones,
  now: number = Date.now(),
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
    // without waiting for a refetch. A hard DELETE broadcasts `removed: true`
    // the same way (the row is gone from the DB, not just soft-archived): both
    // mean "drop this tile now", so a deleted session's focus-header dot,
    // roster tile and composer all clear at once instead of lingering as a
    // green Idle until an unrelated focus/visibility/online resync.
    if (row.archived === true || row.removed === true) {
      // Tombstone the name so an in-flight delta cannot resurrect it (the
      // resurrection race). Done whether or not the row is currently present:
      // the removal can itself arrive before the row we would have dropped.
      tombstones.set(row.name, now)
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
      // The tombstone must block ONE thing: a SYNTHETIC PARTIAL add (a late
      // preview/status/activity tick — a handful of keys) resurrecting a tile
      // we just saw removed (the w6 #3 resurrection race). It must NOT block a
      // FULL AUTHORITATIVE row: the server re-listing the session for real —
      // an archive→unarchive re-broadcasts the whole SessionView
      // (lifecycle.rs::unarchive), a recreate broadcasts one. That row means
      // "the session is genuinely back" and has to WIN outright, or the restore
      // is stranded behind the 15s TTL — invisible until an unrelated resync
      // (w7 regression). So gate the deny on "this is a partial", not on "the
      // name is tombstoned". The discriminator: a full row always carries the
      // identity columns `dir` + `provider`; no partial delta ever does.
      const isFullRow =
        typeof row.dir === 'string' && typeof row.provider === 'string'
      if (isFullRow) {
        // Authoritative: the session is really back. Clear any tombstone so it
        // can't re-block a follow-up delta, and fall through to add.
        tombstones.delete(row.name)
      } else {
        // Synthetic partial: honour the tombstone. Inside the TTL: deny. Past
        // it: a real recreate we missed — forget the tombstone and fall through.
        const tombstonedAt = tombstones.get(row.name)
        if (tombstonedAt !== undefined) {
          if (now - tombstonedAt < REMOVAL_TOMBSTONE_TTL_MS) continue
          tombstones.delete(row.name)
        }
      }
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
      // The row is present and alive: any stale tombstone for it is moot.
      if (tombstones.has(row.name)) tombstones.delete(row.name)
      // Version guard for `status` events (w6 #8). The server stamps every
      // status broadcast with a per-session monotonic counter. Two lifecycle
      // tasks can allocate N/N+1 and, after an await, send them REVERSED — the
      // stale N would then overwrite N+1 and regress a `stopped`/blocked row
      // back to `active`/`idle`. Drop a status delta whose version is strictly
      // older than the one already applied to the row. Only status events carry
      // `status_version` (full `sessions` deltas do not), so this never gates a
      // richer merge — and a first event on a freshly-fetched row (no stored
      // version) always applies.
      const incoming = row.status_version
      const applied = list[idx].status_version
      if (
        typeof incoming === 'number' &&
        typeof applied === 'number' &&
        incoming < applied
      ) {
        continue
      }
      list[idx] = mergeRow(list[idx], row)
    }
  }
  // `removed` is just a marker so future maintainers see we intentionally
  // rebuild the index above; no-op otherwise.
  void removed
  return list
}

/** Normalise a `status` event payload (`{name, status, version}`) into the same
 *  delta shape `applyDelta` consumes.
 *
 *  The `version` is carried through as `status_version` so `applyDelta` can drop
 *  a status event that lost a race — see `ApiSession.status_version`. It is a
 *  per-session monotonic counter, so any FINITE number is meaningful; a payload
 *  without one (an older server) simply skips the version guard. */
export function statusToDelta(payload: unknown): Partial<ApiSession>[] {
  if (!payload || typeof payload !== 'object') return []
  const p = payload as Record<string, unknown>
  if (typeof p.name !== 'string') return []
  const status = p.status
  if (typeof status !== 'string') return []
  const row: Partial<ApiSession> = {
    name: p.name,
    status: status as ApiSession['status'],
  }
  if (typeof p.version === 'number' && Number.isFinite(p.version)) {
    row.status_version = p.version
  }
  return [row]
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
          } else if (p.key === SESSION_RENDERER_PREF_KEY && valueIsStr) {
            // Fase A5 — the renderer preference changed on a peer tab / device.
            // `use-renderer-prefs-sync` reconciles it into the UI store, skipping
            // any session the user is mid-change on (local wins for what you are
            // looking at; the peer wins otherwise).
            qc.setQueryData<RendererState | null>(
              SESSION_RENDERER_QUERY_KEY,
              parseRendererPrefsOrNull(p.value as string | null),
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
      // An explicit create is the "until a real create" that lifts a delete
      // tombstone: if this name was just deleted and is being recreated, its
      // own deltas must land immediately instead of waiting out the TTL.
      clearRemovalTombstone(name)
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

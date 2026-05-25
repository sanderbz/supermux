// useTeams — the Agent Teams data layer (AT-F-FRONT; AT-B backend contract).
//
// TanStack Query against `GET /api/teams`, kept live by the SSE `teams` event —
// NEVER polled (anti-vision: "WebSocket/SSE-only — no 3s polling"), mirroring
// `useSessions` / `useBoard`.
//
// SSE wiring: the shared `use-sse.ts` singleton (one EventSource for the whole
// app) fans the `teams` event out to this hook's `onEvent`. Unlike the `sessions`
// event (per-row deltas), AT-B sends the `teams` event as the FULL snapshot (a
// bare `Team[]`, CHANGE-ONLY — re-sent only when the snapshot diffs). So we do a
// GET on mount for the first paint, then REPLACE the cache wholesale on each
// `teams` push. (`coerceTeams` keeps a drifting/partial experimental payload
// from crashing the render.)

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { teamsApi, coerceTeams, type Team } from '@/lib/api/teams'
import { useSse, type SseEventType } from '@/hooks/use-sse'

export const TEAMS_KEY = ['teams'] as const

export interface UseTeamsResult {
  teams: Team[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  /** Force a refetch of the full snapshot. */
  refetch: () => void
}

/** Unwrap the `teams` SSE payload to a `Team[]`. AT-B sends the BARE array, but
 *  tolerate a `{ payload: [...] }` / `{ data: [...] }` envelope too (other SSE
 *  events on this app wrap that way) so a future server shape still merges. */
function teamsFromSse(payload: unknown): Team[] | null {
  if (Array.isArray(payload)) return coerceTeams(payload)
  const obj = (payload ?? null) as
    | { payload?: unknown; data?: unknown }
    | null
  if (Array.isArray(obj?.payload)) return coerceTeams(obj.payload)
  if (Array.isArray(obj?.data)) return coerceTeams(obj.data)
  return null
}

/** The single live data source for every TEAM CARD. Mount it once on the
 *  overview; downstream components read the shared `['teams']` cache. */
export function useTeams(): UseTeamsResult {
  const qc = useQueryClient()

  const query = useQuery({
    queryKey: TEAMS_KEY,
    queryFn: teamsApi.list,
    staleTime: 30_000,
  })

  // The ONE place the `teams` SSE snapshot lands. A change-only full snapshot →
  // wholesale replace (not a per-row merge): the backend already diffed it, so a
  // push means "this is the new truth". setQueryData (not invalidate) avoids a
  // refetch round-trip — the cards update in place.
  const handlers = React.useMemo(
    () => ({
      onEvent: (type: SseEventType, payload: unknown) => {
        if (type !== 'teams') return
        const next = teamsFromSse(payload)
        if (next) qc.setQueryData<Team[]>(TEAMS_KEY, next)
      },
      // On focus/visibility/online after a quiet stretch, re-pull the snapshot so
      // a `teams` event missed while the stream was down is reconciled.
      onResync: () => {
        void qc.invalidateQueries({ queryKey: TEAMS_KEY })
      },
    }),
    [qc],
  )

  // Subscribe to the ONE shared SSE stream (the singleton in use-sse.ts).
  useSse(handlers)

  return {
    teams: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error) ?? null,
    refetch: () => void query.refetch(),
  }
}

// ── Single-team selector ────────────────────────────────────────────────────
// Derive one team from the shared list cache (by team_name) so any consumer
// shares the same SSE-merged source of truth without a second fetch.

export function useTeam(teamName: string): Team | null {
  const { teams } = useTeams()
  return React.useMemo(
    () => teams.find((t) => t.team_name === teamName) ?? null,
    [teams, teamName],
  )
}

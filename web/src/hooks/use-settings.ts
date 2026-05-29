// Settings data hooks.
//
// TanStack Query wrappers around `settingsApi` (web/src/lib/api.ts). The prefs /
// audit / snippets backend handlers ship in a later backend milestone, so every
// query uses `retry: false` — a 404/501 surfaces immediately as `isError` and
// the route renders a calm "not wired yet" inline state instead of spinning or
// crashing. The localStorage-backed settings (theme, view, default model) work
// regardless, which is what the Settings acceptance bar checks.

import * as React from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'

import {
  AGENT_TEAMS_PREF_KEY,
  settingsApi,
  type AgentTeamsSetting,
  type AuditEntry,
  type MaskedEnv,
  type RegenerateTokenResult,
} from '@/lib/api'
import { useSse, type SseEventType } from '@/hooks/use-sse'

const ENV_KEY = ['settings', 'env'] as const
const AUDIT_KEY = ['settings', 'audit'] as const
const AGENT_TEAMS_KEY = ['settings', 'agent-teams'] as const

/** Masked API-key previews. */
export function useEnvKeys(): UseQueryResult<MaskedEnv> {
  return useQuery({
    queryKey: ENV_KEY,
    queryFn: settingsApi.getEnv,
    retry: false,
    staleTime: 60_000,
  })
}

export function usePatchEnvKeys() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: MaskedEnv) => settingsApi.patchEnv(patch),
    onSuccess: (data) => qc.setQueryData(ENV_KEY, data),
  })
}

/** Best-effort backend sync for the default model (localStorage is authoritative
 *  in the UI via `useUI`). A failure here is swallowed by the caller. */
export function usePatchDefaultModel() {
  return useMutation({
    mutationFn: (model: string) => settingsApi.patchDefaultModel(model),
  })
}

/** Last 200 audit rows. */
export function useAuditLog(limit = 200): UseQueryResult<AuditEntry[]> {
  return useQuery({
    queryKey: [...AUDIT_KEY, limit],
    queryFn: () => settingsApi.getAudit(limit),
    retry: false,
    staleTime: 15_000,
  })
}

// NOTE: snippet hooks (`useSnippets` / `useCreateSnippet` / `useDeleteSnippet`)
// were removed here. Snippets are owned by `use-commands.ts`,
// which speaks the wire contract (`{title, body, position}`, integer ids) and
// uses the `['snippets']` query key. The Settings snippets manager imports those
// hooks directly so it shares ONE client + cache with the focus snippet panel.

export function useRegenerateToken() {
  return useMutation<RegenerateTokenResult>({
    mutationFn: () => settingsApi.regenerateToken(),
  })
}

// ── Experimental: Agent Teams ────────────────────────────────────────────────
//
// The toggle state lives server-side (default OFF) and is kept live by the SSE
// `settings` event — never polled, mirroring `useTeams`. An older server build
// that lacks the endpoint surfaces as `isError` (retry:false), which the
// Settings UI renders as a calm "not supported yet" state with a disabled
// switch.

/** Current Agent Teams toggle state. Subscribes to the shared SSE stream so a
 *  change from a peer tab / device reconciles live (no polling). */
export function useAgentTeams(): UseQueryResult<AgentTeamsSetting> {
  const qc = useQueryClient()

  const query = useQuery({
    queryKey: AGENT_TEAMS_KEY,
    queryFn: settingsApi.getAgentTeams,
    retry: false,
    staleTime: 60_000,
  })

  // The ONE place the `settings` SSE event lands for this key. The server emits
  // `{ key, enabled }`; route only our key into the cache (mirrors the `prefs`
  // routing in use-sessions.ts). setQueryData (not invalidate) updates the
  // toggle in place without a refetch round-trip.
  const handlers = React.useMemo(
    () => ({
      onEvent: (type: SseEventType, payload: unknown) => {
        if (type !== 'settings') return
        const p = (payload as { key?: unknown; enabled?: unknown }) ?? {}
        if (p.key !== AGENT_TEAMS_PREF_KEY) return
        qc.setQueryData<AgentTeamsSetting>(AGENT_TEAMS_KEY, {
          enabled: !!p.enabled,
        })
      },
      // On focus/visibility/online after a quiet stretch, re-pull the state so a
      // `settings` event missed while the stream was down is reconciled.
      onResync: () => {
        void qc.invalidateQueries({ queryKey: AGENT_TEAMS_KEY })
      },
    }),
    [qc],
  )
  useSse(handlers)

  return query
}

/** Toggle Agent Teams with an OPTIMISTIC update: flip the cache immediately,
 *  reconcile to the server echo on success, roll back on error (mirrors the
 *  env-keys mutation, plus optimistic onMutate). */
export function usePatchAgentTeams() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) => settingsApi.setAgentTeams(enabled),
    onMutate: async (enabled: boolean) => {
      await qc.cancelQueries({ queryKey: AGENT_TEAMS_KEY })
      const previous = qc.getQueryData<AgentTeamsSetting>(AGENT_TEAMS_KEY)
      qc.setQueryData<AgentTeamsSetting>(AGENT_TEAMS_KEY, { enabled })
      return { previous }
    },
    onSuccess: (data) => qc.setQueryData(AGENT_TEAMS_KEY, data),
    onError: (_err, _enabled, ctx) => {
      if (ctx?.previous !== undefined) {
        qc.setQueryData(AGENT_TEAMS_KEY, ctx.previous)
      }
    },
  })
}

// Settings data hooks (M22).
//
// TanStack Query wrappers around `settingsApi` (web/src/lib/api.ts). The prefs /
// audit / snippets backend handlers ship in a later backend milestone, so every
// query uses `retry: false` — a 404/501 surfaces immediately as `isError` and
// the route renders a calm "not wired yet" inline state instead of spinning or
// crashing. The localStorage-backed settings (theme, view, default model) work
// regardless, which is what the M22 acceptance bar checks.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'

import {
  settingsApi,
  type AuditEntry,
  type MaskedEnv,
  type RegenerateTokenResult,
} from '@/lib/api'

const ENV_KEY = ['settings', 'env'] as const
const AUDIT_KEY = ['settings', 'audit'] as const

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

/** Last 200 audit rows (§6.4). */
export function useAuditLog(limit = 200): UseQueryResult<AuditEntry[]> {
  return useQuery({
    queryKey: [...AUDIT_KEY, limit],
    queryFn: () => settingsApi.getAudit(limit),
    retry: false,
    staleTime: 15_000,
  })
}

// NOTE: snippet hooks (`useSnippets` / `useCreateSnippet` / `useDeleteSnippet`)
// were removed here (review R3-003). Snippets are owned by `use-commands.ts`,
// which speaks the M9 wire contract (`{title, body, position}`, integer ids) and
// uses the `['snippets']` query key. The Settings snippets manager imports those
// hooks directly so it shares ONE client + cache with the focus snippet panel.

export function useRegenerateToken() {
  return useMutation<RegenerateTokenResult>({
    mutationFn: () => settingsApi.regenerateToken(),
  })
}

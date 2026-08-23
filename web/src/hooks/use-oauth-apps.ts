// OAuth-app registry hooks (P2b) — the TanStack Query surface the guided
// "Enable Sign-in with GitHub" wizard reads and mutates. Same shape as
// `use-external-access`: one keyed query, a mutation that invalidates it.
//
// The list query is the OWNER PROBE: `GET /api/oauth/apps` is owner/admin-only and
// 404s for a member. `retry: false` means a member's 404 resolves fast to
// `isError`, so the registration entry point never flickers in for them
// (`ownerCanRegister` below is the single gate the entry reads).

import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  listOauthApps,
  registerOauthApp,
  type OauthAppSummary,
  type RegisterAppBody,
} from '@/lib/api/oauth'
import { ApiError } from '@/lib/api/client'

export const OAUTH_APPS_KEY = ['oauth-apps'] as const

export interface UseOauthAppsResult {
  apps: OauthAppSummary[]
  isLoading: boolean
  /** True once the owner probe has SUCCEEDED — the caller may show the entry. A
   *  member's 404 (or any error) keeps this false, hiding registration. */
  ownerCanRegister: boolean
  /** Is a `(provider, company)` app already registered? Drives "already enabled". */
  hasApp: (provider: string, companyId?: number | null) => boolean
  refetch: () => void
}

/** `GET /api/oauth/apps`. Owner/admin-only — the query doubling as the role probe.
 *  `enabled` lets a closed entry point skip the fetch entirely. */
export function useOauthApps(opts: { enabled?: boolean } = {}): UseOauthAppsResult {
  const query = useQuery<OauthAppSummary[]>({
    queryKey: OAUTH_APPS_KEY,
    queryFn: listOauthApps,
    enabled: opts.enabled ?? true,
    staleTime: 30_000,
    // A member's 404 is an EXPECTED terminal state (hidden entry), not a flake —
    // don't retry it, so the gate resolves in one round-trip.
    retry: false,
  })
  const data = query.data
  const apps = useMemo(() => data ?? [], [data])
  const hasApp = useMemo(
    () =>
      (provider: string, companyId?: number | null) =>
        apps.some(
          (a) => a.provider === provider && (a.company_id ?? null) === (companyId ?? null),
        ),
    [apps],
  )
  return {
    apps,
    isLoading: query.isLoading,
    ownerCanRegister: query.isSuccess,
    hasApp,
    refetch: () => void query.refetch(),
  }
}

/** `POST /api/oauth/apps` — register (idempotent). Invalidates the probe so a
 *  freshly-enabled provider's card flips to Lane A on its next fetch. */
export function useRegisterOauthApp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: RegisterAppBody) => registerOauthApp(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: OAUTH_APPS_KEY })
      // The connector cards' lane is server-derived from the registered app, so
      // refetch the grid + one card so GitHub flips to "Sign in with GitHub".
      void qc.invalidateQueries({ queryKey: ['connectors'] })
      void qc.invalidateQueries({ queryKey: ['connector'] })
    },
  })
}

/** Narrow an unknown error to an HTTP status (member 404 vs a real failure). */
export function oauthErrorStatus(e: unknown): number | null {
  return e instanceof ApiError ? e.status : null
}

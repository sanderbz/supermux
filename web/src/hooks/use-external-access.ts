// External-access + invite hooks (Companies, Bot Mode) — the TanStack Query
// surface the onboarding wizard reads and mutates. Mirrors `use-companies`: one
// query per resource keyed stably, mutations that invalidate those keys so every
// panel re-reads one source of truth. The status query POLLS while a step is
// connecting (tunnel provisioning) and idles otherwise, so the "Connecting… →
// Connected ✓" chip is live without a socket.
//
// Under `?mock` (`devMockActive()`) every call routes to the in-memory mock
// (`external-access-mock.ts`, dynamically imported behind the DEV guard so it is
// absent from the production bundle), which is how the whole wizard is
// exercisable offline with no live Cloudflare token / Google app / server.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  externalAccessApi,
  type AddHumanInput,
  type ExternalStatus,
  type HumanInvitee,
  type ZonesResult,
} from '@/lib/api'
import { devMockActive } from '@/hooks/use-sessions'

/** Dynamically pull the DEV mock only when it is actually active. Behind the
 *  `import.meta.env.DEV` short-circuit in `devMockActive`, so the bundler keeps
 *  the mock out of the shipped hero path. */
async function mockClient() {
  const m = await import('@/lib/external-access-mock')
  return m.externalAccessMock
}

export function externalStatusKey(companyId?: number) {
  return ['external-status', companyId ?? null] as const
}
export function externalZonesKey() {
  return ['external-zones'] as const
}
export function companyHumansKey(companyId: number) {
  return ['company-humans', companyId] as const
}

// ── Status (the live-verify source; polls while connecting) ───────────────────

export interface UseExternalStatusResult {
  status: ExternalStatus | undefined
  isLoading: boolean
  isError: boolean
  error: unknown
  refetch: () => void
}

/** `GET /api/external-access/status[?company_id=]`. Polls every 1.5s while the
 *  tunnel is mid-provision (`tunnel === 'connecting'`), and stops once it is
 *  `healthy` / `none` — so the wizard's chips go live without a manual refresh
 *  but the query idles the rest of the time. `enabled` lets a closed sheet skip
 *  the fetch entirely. */
export function useExternalStatus(
  companyId?: number,
  opts: { enabled?: boolean } = {},
): UseExternalStatusResult {
  const enabled = opts.enabled ?? true
  const query = useQuery({
    queryKey: externalStatusKey(companyId),
    queryFn: async (): Promise<ExternalStatus> => {
      if (devMockActive()) return (await mockClient()).status(companyId)
      return externalAccessApi.status(companyId)
    },
    enabled,
    staleTime: 0,
    refetchInterval: (q) => {
      const data = q.state.data as ExternalStatus | undefined
      return data?.box_status.tunnel === 'connecting' ? 1500 : false
    },
  })
  return {
    status: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  }
}

/** Shared success handler: invalidate the box + this-company status so every
 *  chip re-reads after a mutation lands. */
function useInvalidateStatus(companyId?: number) {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: externalStatusKey(companyId) })
    void qc.invalidateQueries({ queryKey: externalStatusKey(undefined) })
  }
}

// ── Step 1 — Cloudflare token + tunnel ────────────────────────────────────────

export function useCfToken(companyId?: number) {
  const invalidate = useInvalidateStatus(companyId)
  return useMutation({
    mutationFn: async (token: string) => {
      if (devMockActive()) return (await mockClient()).cfToken(token)
      return externalAccessApi.cfToken(token)
    },
    onSuccess: invalidate,
  })
}

export function useProvisionTunnel(companyId?: number) {
  const invalidate = useInvalidateStatus(companyId)
  return useMutation({
    mutationFn: async () => {
      if (devMockActive()) return (await mockClient()).provisionTunnel()
      return externalAccessApi.provisionTunnel()
    },
    onSuccess: invalidate,
  })
}

// ── "Try without a domain" — zero-config quick tunnel ─────────────────────────

/** `POST /api/external-access/quick-tunnel` — start a temporary link for THIS
 *  company. The mutation stays pending for the few seconds cloudflared takes to
 *  report its URL (the wizard shows a spinner), then status re-reads and the
 *  `box_status.quick_tunnel` block goes live. */
export function useStartQuickTunnel(companyId: number) {
  const invalidate = useInvalidateStatus(companyId)
  return useMutation({
    mutationFn: async () => {
      if (devMockActive()) return (await mockClient()).startQuickTunnel(companyId)
      return externalAccessApi.startQuickTunnel(companyId)
    },
    onSuccess: invalidate,
  })
}

/** `DELETE /api/external-access/quick-tunnel` — tear the temporary link down. */
export function useStopQuickTunnel(companyId?: number) {
  const invalidate = useInvalidateStatus(companyId)
  return useMutation({
    mutationFn: async () => {
      if (devMockActive()) return (await mockClient()).stopQuickTunnel()
      return externalAccessApi.stopQuickTunnel()
    },
    onSuccess: invalidate,
  })
}

// ── Step 1b — Choose your domain (CF zone auto-discovery) ──────────────────────

export interface UseZonesResult {
  zones: string[]
  isLoading: boolean
  isError: boolean
  error: unknown
  refetch: () => void
}

/** `GET /api/external-access/zones` — the base-domain choices the saved CF token
 *  controls. `enabled` should be flipped on only once the token is valid AND the
 *  base domain is still unset, so we never hit CF before there is a token. */
export function useZones(opts: { enabled?: boolean } = {}): UseZonesResult {
  const query = useQuery({
    queryKey: externalZonesKey(),
    queryFn: async (): Promise<ZonesResult> => {
      if (devMockActive()) return (await mockClient()).zones()
      return externalAccessApi.zones()
    },
    enabled: opts.enabled ?? false,
    staleTime: 30_000,
  })
  return {
    zones: query.data?.zones ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  }
}

/** `POST /api/external-access/base-domain` — persist the chosen base domain, then
 *  invalidate status so the wizard advances from "Choose your domain" to provision. */
export function useSetBaseDomain(companyId?: number) {
  const invalidate = useInvalidateStatus(companyId)
  return useMutation({
    mutationFn: async (baseDomain: string) => {
      if (devMockActive()) return (await mockClient()).setBaseDomain(baseDomain)
      return externalAccessApi.setBaseDomain(baseDomain)
    },
    onSuccess: invalidate,
  })
}

// ── Step 2 — Google login ─────────────────────────────────────────────────────

export function useGoogleConfig(companyId?: number) {
  const invalidate = useInvalidateStatus(companyId)
  return useMutation({
    mutationFn: async (v: { client_id: string; client_secret: string }) => {
      if (devMockActive()) return (await mockClient()).google(v.client_id, v.client_secret)
      return externalAccessApi.google(v.client_id, v.client_secret)
    },
    onSuccess: invalidate,
  })
}

/** `POST /api/companies/{id}/host` — Entry B: write just this company's host on
 *  an already-configured box (no secret paste). */
export function useCompanyHost(companyId: number) {
  const invalidate = useInvalidateStatus(companyId)
  return useMutation({
    mutationFn: async () => {
      if (devMockActive()) return (await mockClient()).host(companyId)
      return externalAccessApi.host(companyId)
    },
    onSuccess: invalidate,
  })
}

export function useVerifyLogin(companyId: number) {
  const invalidate = useInvalidateStatus(companyId)
  return useMutation({
    mutationFn: async () => {
      if (devMockActive()) return (await mockClient()).verifyLogin(companyId)
      return externalAccessApi.verifyLogin(companyId)
    },
    onSuccess: invalidate,
  })
}

// ── Step 3 — Invite people ────────────────────────────────────────────────────

export interface UseCompanyHumansResult {
  humans: HumanInvitee[]
  isLoading: boolean
  isError: boolean
  refetch: () => void
}

export function useCompanyHumans(
  companyId: number,
  opts: { enabled?: boolean } = {},
): UseCompanyHumansResult {
  const query = useQuery({
    queryKey: companyHumansKey(companyId),
    queryFn: async (): Promise<HumanInvitee[]> => {
      if (devMockActive()) return (await mockClient()).listHumans(companyId)
      return externalAccessApi.listHumans(companyId)
    },
    enabled: opts.enabled ?? true,
    staleTime: 5_000,
  })
  return {
    humans: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  }
}

export function useInviteHuman(companyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: AddHumanInput) => {
      if (devMockActive()) return (await mockClient()).addHuman(companyId, input)
      return externalAccessApi.addHuman(companyId, input)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: companyHumansKey(companyId) })
    },
  })
}

export function useRemoveHuman(companyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (hid: number) => {
      if (devMockActive()) return (await mockClient()).removeHuman(companyId, hid)
      return externalAccessApi.removeHuman(companyId, hid)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: companyHumansKey(companyId) })
    },
  })
}

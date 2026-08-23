// Connector-store query cache + mutation verbs (TanStack Query).
//
// Mirrors the app's established query idiom (`use-sessions.ts`): a keyed
// `useQuery` per read surface, plus optimistic mutation verbs that patch the
// cache, call the API, and invalidate so the authoritative rows land. The
// connector mutations emit no SSE (like the session-config PATCH), so the
// invalidate is what propagates a grant/revoke to every other surface.
//
// Three read surfaces:
//   • useConnectors(params)          — the merged store grid
//   • useSessionConnectors(name)     — one bot's applied grants
//   • useConnector(id)               — one card's detail
//
// One verb bag: useConnectorActions() → install / grant / revoke / putCredential
// / remove, each resolving the server's `restartHint` so callers can surface the
// honest "restart to apply" affordance.

import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  grant as apiGrant,
  getConnector,
  listConnectors,
  putCredential as apiPutCredential,
  type CredentialResponse,
  removeConnector,
  revoke as apiRevoke,
  sessionConnectors,
  upsertConnector,
  type ConnectorCard,
  type ConnectorConsumer,
  type ListParams,
  type Manifest,
  type PutCredentialArgs,
  type SessionConnector,
  connectorGrants as apiConnectorGrants,
  disconnectAccount as apiDisconnect,
  reconnectAccount as apiReconnect,
  testConnection as apiTestConnection,
  type TestConnectionResult,
} from '@/lib/api/connectors'
import { ApiError } from '@/lib/api/client'
import { useToast } from '@/components/ui/use-toast'

// ── query keys ────────────────────────────────────────────────────────────────

export const CONNECTORS_KEY = ['connectors'] as const
export const connectorsKey = (params: ListParams = {}) =>
  [...CONNECTORS_KEY, params] as const
export const sessionConnectorsKey = (name: string) =>
  ['session-connectors', name] as const
export const connectorKey = (id: string) => ['connector', id] as const
export const connectorGrantsKey = (id: string) =>
  ['connector-grants', id] as const

// ── reads ─────────────────────────────────────────────────────────────────────

/** The merged store grid. `params` narrows source / q / category / featured. A
 *  404/501 (foundation not deployed) degrades to an empty grid, never a crash. */
export function useConnectors(params: ListParams = {}) {
  return useQuery<ConnectorCard[]>({
    queryKey: connectorsKey(params),
    queryFn: () => listConnectors(params),
    staleTime: 30_000,
    retry: (count, err) => !(err instanceof ApiError) && count < 2,
  })
}

/** One bot's applied grants (own + all-agents). */
export function useSessionConnectors(name: string | null | undefined) {
  return useQuery<SessionConnector[]>({
    queryKey: sessionConnectorsKey(name ?? ''),
    queryFn: () => sessionConnectors(name as string),
    enabled: !!name,
    staleTime: 15_000,
    retry: (count, err) => !(err instanceof ApiError) && count < 2,
  })
}

/** One card's full detail (tools, credential schema). */
export function useConnector(id: string | null | undefined) {
  return useQuery<ConnectorCard>({
    queryKey: connectorKey(id ?? ''),
    queryFn: () => getConnector(id as string),
    enabled: !!id,
    staleTime: 60_000,
  })
}

/** The CONSUMERS of one connector (its grants' blast-radius) — powers the
 *  Installed detail's "Used by" list. Member-filtered server-side. */
export function useConnectorGrants(id: string | null | undefined) {
  return useQuery<ConnectorConsumer[]>({
    queryKey: connectorGrantsKey(id ?? ''),
    queryFn: () => apiConnectorGrants(id as string),
    enabled: !!id,
    staleTime: 15_000,
    retry: (count, err) => !(err instanceof ApiError) && count < 2,
  })
}

// ── mutation verbs ────────────────────────────────────────────────────────────

export interface ConnectorActions {
  pending: boolean
  /** Install a catalog card into the local registry (idempotent upsert). Returns
   *  the stored id. */
  install: (manifest: Manifest) => Promise<string>
  /** Grant a connector to one session or `*`. Resolves `restartHint`. Pass
   *  `accountRef` to pin which account the grant feeds (multi-account). */
  grant: (id: string, sessionName: string, secretRef?: string, accountRef?: string) => Promise<boolean>
  /** Revoke a grant from one session. Resolves `restartHint`. */
  revoke: (id: string, sessionName: string) => Promise<boolean>
  /** Disconnect an account — revoke every grant it feeds but KEEP the sealed
   *  secret + the account row (status → disconnected) for one-tap reconnect. */
  disconnect: (id: string, accountRef: string) => Promise<boolean>
  /** Reconnect / re-grant an account reusing its KEPT secret (server resolves the
   *  secret_ref, so this is the account-aware grant path). Flips it back to active
   *  and, with a session, re-grants that scope. Resolves `restartHint`. */
  reconnect: (id: string, accountRef: string, sessionName?: string) => Promise<boolean>
  /** Run a per-kind liveness probe for one account and record the honest health
   *  verdict (ok / expired / error / can't-test). Returns the full result so the
   *  caller can show a note; the stored health rides the grid invalidation. */
  testConnection: (id: string, accountRef: string) => Promise<TestConnectionResult>
  /** Flip a grant's `enabled` flag WITHOUT dropping the grant row — an at-a-glance
   *  enable/disable that survives a re-enable (revoke would forget it). Re-grants
   *  to the same session with the new flag. Resolves `restartHint`. */
  setEnabled: (id: string, sessionName: string, enabled: boolean) => Promise<boolean>
  /** Seal a credential (write-only) + optional one-tap grant. Resolves the
   *  secret_ref so a follow-up grant can attach it. */
  putCredential: (id: string, args: PutCredentialArgs) => Promise<string | null>
  /** Seal a credential and return the FULL response — the `secret_ref` PLUS the
   *  minted `account_ref` / `account_label` the shared ConnectFlow needs for the
   *  "Connected as …" line and the "Test connection" probe. Throws on failure. */
  putCredentialFull: (id: string, args: PutCredentialArgs) => Promise<CredentialResponse>
  /** Remove a connector (grants + vault CASCADE). */
  remove: (id: string) => Promise<void>
}

export function useConnectorActions(): ConnectorActions {
  const qc = useQueryClient()
  const { toast } = useToast()

  const invalidateAll = React.useCallback(
    (sessionName?: string) => {
      void qc.invalidateQueries({ queryKey: CONNECTORS_KEY })
      void qc.invalidateQueries({ queryKey: ['session-connectors'] })
      // The Installed tab's per-account rows + the detail's consumers ride the
      // grid + the grants route — refresh both so a grant/disconnect lands live.
      void qc.invalidateQueries({ queryKey: ['connector-grants'] })
      if (sessionName) {
        void qc.invalidateQueries({ queryKey: sessionConnectorsKey(sessionName) })
      }
    },
    [qc],
  )

  const install = useMutation({
    mutationFn: (m: Manifest) => upsertConnector(m),
    onSuccess: () => invalidateAll(),
    onError: (e: unknown) =>
      toast({ message: `Install failed — ${(e as Error).message}`, tone: 'error', duration: 4000 }),
  })

  const grantM = useMutation({
    mutationFn: (v: { id: string; sessionName: string; secretRef?: string; accountRef?: string }) =>
      apiGrant(v.id, {
        session_name: v.sessionName,
        secret_ref: v.secretRef,
        account_ref: v.accountRef,
      }),
    onSuccess: (_r, v) => invalidateAll(v.sessionName),
    onError: (e: unknown) =>
      toast({ message: `Grant failed — ${(e as Error).message}`, tone: 'error', duration: 4000 }),
  })

  const disconnectM = useMutation({
    mutationFn: (v: { id: string; accountRef: string }) => apiDisconnect(v.id, v.accountRef),
    onSuccess: () => invalidateAll(),
    onError: (e: unknown) =>
      toast({ message: `Disconnect failed — ${(e as Error).message}`, tone: 'error', duration: 4000 }),
  })

  const reconnectM = useMutation({
    mutationFn: (v: { id: string; accountRef: string; sessionName?: string }) =>
      apiReconnect(v.id, v.accountRef, v.sessionName),
    onSuccess: (_r, v) => invalidateAll(v.sessionName),
    onError: (e: unknown) =>
      toast({ message: `Couldn't reconnect — ${(e as Error).message}`, tone: 'error', duration: 4000 }),
  })

  const revokeM = useMutation({
    mutationFn: (v: { id: string; sessionName: string }) => apiRevoke(v.id, v.sessionName),
    onSuccess: (_r, v) => invalidateAll(v.sessionName),
    onError: (e: unknown) =>
      toast({ message: `Revoke failed — ${(e as Error).message}`, tone: 'error', duration: 4000 }),
  })

  // Test connection: the probe WRITES the stored health, so invalidate the grid to
  // repaint the row/detail dot. The verdict is also returned to the caller for an
  // immediate note.
  const testM = useMutation({
    mutationFn: (v: { id: string; accountRef: string }) => apiTestConnection(v.id, v.accountRef),
    onSuccess: () => invalidateAll(),
    onError: (e: unknown) =>
      toast({ message: `Couldn't test — ${(e as Error).message}`, tone: 'error', duration: 4000 }),
  })

  // Enable/disable rides the SAME grant endpoint (it already takes an `enabled`
  // flag), so no new route: a disabled grant stays a row, ready to flip back on.
  const enableM = useMutation({
    mutationFn: (v: { id: string; sessionName: string; enabled: boolean }) =>
      apiGrant(v.id, { session_name: v.sessionName, enabled: v.enabled }),
    onSuccess: (_r, v) => invalidateAll(v.sessionName),
    onError: (e: unknown) =>
      toast({ message: `Couldn't update — ${(e as Error).message}`, tone: 'error', duration: 4000 }),
  })

  const credM = useMutation({
    mutationFn: (v: { id: string; args: PutCredentialArgs }) => apiPutCredential(v.id, v.args),
    onSuccess: (_r, v) => invalidateAll(v.args.session_name),
    onError: (e: unknown) =>
      toast({ message: `Couldn't save — ${(e as Error).message}`, tone: 'error', duration: 4000 }),
  })

  const removeM = useMutation({
    mutationFn: (id: string) => removeConnector(id),
    onSuccess: () => invalidateAll(),
    onError: (e: unknown) =>
      toast({ message: `Remove failed — ${(e as Error).message}`, tone: 'error', duration: 4000 }),
  })

  const pending =
    install.isPending ||
    grantM.isPending ||
    revokeM.isPending ||
    enableM.isPending ||
    credM.isPending ||
    removeM.isPending ||
    disconnectM.isPending ||
    reconnectM.isPending ||
    testM.isPending

  return {
    pending,
    install: (m) => install.mutateAsync(m),
    grant: async (id, sessionName, secretRef, accountRef) => {
      const r = await grantM.mutateAsync({ id, sessionName, secretRef, accountRef })
      return !!r.restartHint
    },
    revoke: async (id, sessionName) => {
      const r = await revokeM.mutateAsync({ id, sessionName })
      return !!r.restartHint
    },
    disconnect: async (id, accountRef) => {
      const r = await disconnectM.mutateAsync({ id, accountRef })
      return !!r.restartHint
    },
    reconnect: async (id, accountRef, sessionName) => {
      const r = await reconnectM.mutateAsync({ id, accountRef, sessionName })
      return !!r.restartHint
    },
    testConnection: (id, accountRef) => testM.mutateAsync({ id, accountRef }),
    setEnabled: async (id, sessionName, enabled) => {
      const r = await enableM.mutateAsync({ id, sessionName, enabled })
      return !!r.restartHint
    },
    putCredential: async (id, args) => {
      const r = await credM.mutateAsync({ id, args })
      return r.secret_ref ?? null
    },
    putCredentialFull: (id, args) => credM.mutateAsync({ id, args }),
    remove: (id) => removeM.mutateAsync(id),
  }
}

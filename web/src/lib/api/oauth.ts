// OAuth-app registry client (P2b) — the owner/admin-only endpoints that enable
// Lane A device sign-in. Registering a `(provider, company)` app is the ENABLER:
// once an app is on the box, the server's context-aware `derive_auth` flips that
// provider's card to `oauth_device`, and "Sign in with GitHub" appears.
//
// SECRET HYGIENE (load-bearing): a `client_secret` is only ever SENT (in
// `registerOauthApp`). It never comes back — the GET/POST responses carry only a
// MASKED `client_id_masked` (`…123456`), never a secret, never the full id. The
// server persists the secret 0600 + hot-reloads (P2a); nothing here reads it back.
//
// The list endpoint is owner/admin-only and 404s for a member (uniform
// hide-existence). Callers use that 404 to HIDE the registration entry point —
// there is no client-side role context in this codebase, so the probe IS the gate.

import { settingsRequest } from './client'

export type OauthProvider = 'github' | 'google'

/** One registered app, masked (GET /api/oauth/apps row). Secret-free. */
export interface OauthAppSummary {
  provider: OauthProvider
  /** `null` = a box-wide (global) app; a number = a company-scoped app. */
  company_id: number | null
  client_id_masked: string
  scopes: string[]
}

/** The server-authored "how to create the app" copy (register response). */
export interface OauthGuidance {
  create_url: string
  device_flow_note: string
  /** `null` by design — device flow uses NO redirect URI. */
  redirect_uri: string | null
  recommended_scopes: string[]
}

/** POST /api/oauth/apps result — masked echo + the guidance block. Secret-free. */
export interface RegisterAppResult {
  provider: OauthProvider
  company_id: number | null
  client_id_masked: string
  scopes: string[]
  registered: boolean
  guidance: OauthGuidance
}

/** `GET /api/oauth/apps` — owner/admin-only. THROWS (404) for a member; the caller
 *  uses that to HIDE the registration entry point (there is no other role signal). */
export async function listOauthApps(): Promise<OauthAppSummary[]> {
  const r = await settingsRequest<{ apps: OauthAppSummary[] }>(`/api/oauth/apps`)
  return r.apps ?? []
}

export interface RegisterAppBody {
  provider: OauthProvider
  /** `null`/omitted = a box-wide (global) app reused by every bot. */
  company_id?: number | null
  client_id: string
  /** WRITE-ONLY — sent once, never echoed. */
  client_secret: string
  /** Optional least-privilege override; empty → the server defaults. */
  scopes?: string[]
}

/** `POST /api/oauth/apps` — register (idempotent upsert). Owner/admin-only. The
 *  `client_secret` is write-only; the response is masked. */
export async function registerOauthApp(
  body: RegisterAppBody,
): Promise<RegisterAppResult> {
  return settingsRequest<RegisterAppResult>(`/api/oauth/apps`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** `DELETE /api/oauth/apps/{provider}/{company_id?}` — remove an app. */
export async function deleteOauthApp(
  provider: OauthProvider,
  companyId?: number | null,
): Promise<void> {
  const path =
    companyId == null
      ? `/api/oauth/apps/${provider}`
      : `/api/oauth/apps/${provider}/${companyId}`
  await settingsRequest(path, { method: 'DELETE' })
}

// ── supermux-brokered remote-MCP OAuth (the `mcp_oauth` lane) ─────────────────
//
// SECRET HYGIENE: the client only ever sees the provider's `authorize_url` and an
// opaque `state`. The PKCE verifier, the DCR client secret and the tokens live
// server-side; the public callback stashes the exchange in RAM and the
// AUTHENTICATED `complete` is what seals + grants. The `state` is kept in
// `sessionStorage` (this tab), never in a URL.

export interface McpOauthStart {
  /** The provider's consent page — `location.assign` it (same tab, iOS PWA). */
  authorize_url: string
  /** Opaque; the finishing `complete` call needs it back. */
  state: string
  expires_in: number
}

export interface McpOauthComplete {
  ok: boolean
  account_ref: string
  /** The connected identity ("sander@…"), or the resource host as a fallback. */
  label: string
  /** The REAL probe verdict written for the account: only `ok` is green. */
  health: { status: string | null; error?: string | null }
  target: string
}

/** `POST /api/connectors/{id}/oauth/start { session_name, return_to }`. */
export async function startMcpOauth(
  id: string,
  args: { session_name: string; return_to: string },
): Promise<McpOauthStart> {
  return settingsRequest<McpOauthStart>(`/api/connectors/${encodeURIComponent(id)}/oauth/start`, {
    method: 'POST',
    body: JSON.stringify(args),
  })
}

/** `POST /api/connectors/{id}/oauth/complete { state }` — the finishing step. */
export async function completeMcpOauth(
  id: string,
  args: { state: string },
): Promise<McpOauthComplete> {
  return settingsRequest<McpOauthComplete>(`/api/connectors/${encodeURIComponent(id)}/oauth/complete`, {
    method: 'POST',
    body: JSON.stringify(args),
  })
}

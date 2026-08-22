// External-access + colleague-invite client (Companies, Bot Mode). The onboarding
// wizard's whole data plane: the Cloudflare tunnel setup, the Google login config,
// and the per-company invite roster. Every call rides the SAME `sessionRequest`
// (bearer auth + `{ok,data}` envelope unwrap + `SessionError`) as the rest of the
// app, so there is exactly one fetch discipline — no second, subtly-different
// client. All endpoints are owner/admin-only server-side (`require_admin`); the
// wizard lives on the bearer/owner dashboard, which a company `member` never reaches.
//
// Wire shapes mirror `server/src/external_access/mod.rs` (committed 957674b) and
// `server/src/db/human_users.rs` exactly — keep them in lockstep.

import { sessionRequest } from './sessions'

// ── Wire types (mirror the Rust `Serialize` structs) ─────────────────────────

/** `POST /api/external-access/cf-token` result. Never echoes the token. */
export interface CfTokenResult {
  valid: boolean
  account_id: string
  zone_id: string
}

/** `POST /api/external-access/provision-tunnel` result. `connector` is
 *  `"started"` or a degrade reason (`connector_detail` carries the human note). */
export interface ProvisionResult {
  tunnel_id: string
  connector: string
  connector_detail?: string
  reachable_host: string
}

/** Box-wide external-access state — the wizard's entry-routing + live chips. */
export interface BoxStatus {
  /** `none` | `valid`. */
  cf_token: string
  /** `none` | `connecting` | `healthy`. */
  tunnel: string
  dns_ok: boolean
  /** `unset` | `configured`. */
  google: string
}

/** Per-company external-access state (present when `company_id` is passed). */
export interface CompanyStatus {
  company_id: number
  company_host_written: boolean
  /** `unknown` | `ok` | `mismatch`. */
  redirect_registered: string
  reachable: boolean
  host: string
  redirect_uri: string
}

export interface ExternalStatus {
  box_status: BoxStatus
  company?: CompanyStatus
}

export interface GoogleResult {
  configured: boolean
}

export interface HostResult {
  host: string
  redirect_uri: string
}

export interface VerifyLoginResult {
  ok: boolean
  detail: string
  redirect_uri: string
}

/** A seeded colleague row (from `POST /humans` → `.user`). */
export interface HumanUser {
  id: number
  email: string
  display_name: string
  company_id: number | null
  role: string
  created_at: number
}

export interface AddHumanResult {
  user: HumanUser
  login_url: string
}

/** A colleague row + derived live status (`GET /humans`). */
export interface HumanInvitee {
  id: number
  email: string
  display_name: string
  company_id: number | null
  role: string
  created_at: number
  /** `invited` | `pending` | `active`. */
  status: string
}

export type HumanRole = 'owner' | 'admin' | 'member'

export interface AddHumanInput {
  email: string
  role: HumanRole
  display_name?: string
}

// ── The client ───────────────────────────────────────────────────────────────

export const externalAccessApi = {
  /** `GET /api/external-access/status[?company_id=]` — the single live-verify
   *  source. Read-only, safe to poll while a step is connecting. */
  status: (companyId?: number): Promise<ExternalStatus> =>
    sessionRequest<ExternalStatus>(
      companyId == null
        ? '/api/external-access/status'
        : `/api/external-access/status?company_id=${companyId}`,
    ),

  /** `POST /api/external-access/cf-token` — verify + store the Cloudflare API
   *  token (0600, never echoed). Returns `{valid, account_id, zone_id}`. */
  cfToken: (token: string): Promise<CfTokenResult> =>
    sessionRequest('/api/external-access/cf-token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  /** `POST /api/external-access/provision-tunnel` — idempotent one-time wildcard
   *  tunnel + DNS + connector unit. Poll `status.tunnel` for health after. */
  provisionTunnel: (): Promise<ProvisionResult> =>
    sessionRequest('/api/external-access/provision-tunnel', { method: 'POST' }),

  /** `POST /api/external-access/google` — write the Google client id + secret
   *  (secret 0600, never echoed). Returns `{configured}`. */
  google: (client_id: string, client_secret: string): Promise<GoogleResult> =>
    sessionRequest('/api/external-access/google', {
      method: 'POST',
      body: JSON.stringify({ client_id, client_secret }),
    }),

  /** `POST /api/companies/{id}/host` — derive + write this company's
   *  `company_hosts` entry (Entry B). Returns `{host, redirect_uri}`. */
  host: (companyId: number): Promise<HostResult> =>
    sessionRequest(`/api/companies/${companyId}/host`, { method: 'POST' }),

  /** `POST /api/companies/{id}/verify-login` — real authorize round-trip; surfaces
   *  the exact URI to register on `redirect_uri_mismatch`. */
  verifyLogin: (companyId: number): Promise<VerifyLoginResult> =>
    sessionRequest(`/api/companies/${companyId}/verify-login`, { method: 'POST' }),

  /** `POST /api/companies/{id}/humans` — seed one colleague row. */
  addHuman: (companyId: number, input: AddHumanInput): Promise<AddHumanResult> =>
    sessionRequest(`/api/companies/${companyId}/humans`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** `GET /api/companies/{id}/humans` — the invite roster + derived status. */
  listHumans: async (companyId: number): Promise<HumanInvitee[]> => {
    const body = await sessionRequest<unknown>(`/api/companies/${companyId}/humans`)
    return Array.isArray(body) ? (body as HumanInvitee[]) : []
  },

  /** `DELETE /api/companies/{id}/humans/{hid}` — revoke an invite. */
  removeHuman: (companyId: number, hid: number): Promise<{ deleted: boolean; sessions_revoked: number }> =>
    sessionRequest(`/api/companies/${companyId}/humans/${hid}`, { method: 'DELETE' }),
}

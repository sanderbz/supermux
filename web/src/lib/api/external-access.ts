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

/** `POST /api/external-access/cf-token` result. Never echoes the token. The zone
 *  is no longer known at token-verify time — the operator picks a base domain from
 *  `zones()` in the next wizard step, which is where Zone:Read is proven. */
export interface CfTokenResult {
  valid: boolean
  account_id: string
}

/** `GET /api/external-access/zones` result — the apex names the saved CF token
 *  controls (never ids/token). The wizard's "Choose your domain" step lists these. */
export interface ZonesResult {
  zones: string[]
}

/** `POST /api/external-access/base-domain` result — the persisted base domain. */
export interface BaseDomainResult {
  base_domain: string
}

/** `POST /api/external-access/provision-tunnel` result. `connector` is
 *  `"started"` or a degrade reason (`connector_detail` carries the human note). */
export interface ProvisionResult {
  tunnel_id: string
  connector: string
  connector_detail?: string
  reachable_host: string
}

/** The active zero-config quick tunnel (ephemeral). Present on `box_status` only
 *  while a temporary trial is configured — omitted otherwise. Mirrors the server's
 *  `QuickTunnelStatus`. `active` is honest: a crashed cloudflared child ⇒ false. */
export interface QuickTunnelStatus {
  active: boolean
  url: string
  host: string
  company_id: number
  /** Always true — the honesty flag ("this link changes on restart"). */
  ephemeral: boolean
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
  /** The operator's chosen base domain (a CF zone they control), e.g. `example.com`.
   *  Absent/`null` ⇒ the "Choose your domain" sub-step has not run yet (fail-closed:
   *  external access is not configured until this is set). */
  base_domain?: string | null
  /** The active quick tunnel (the "try without a domain" branch). Absent ⇒ no
   *  temporary trial is running. */
  quick_tunnel?: QuickTunnelStatus | null
}

/** `POST /api/external-access/quick-tunnel` result — the freshly-started ephemeral
 *  tunnel. `ephemeral` is always true. */
export interface QuickTunnelResult {
  url: string
  host: string
  ephemeral: boolean
  company_id: number
}

/** `DELETE /api/external-access/quick-tunnel` result. */
export interface QuickTunnelTeardownResult {
  torn_down: boolean
}

/** The company's Cloudflare agent-inbox (`agent@<domain>` → a connected mailbox),
 *  present on `company` once provisioned. `verification_pending` is the honesty
 *  flag: Cloudflare forwards only after the owner clicks the one verify link. */
export interface AgentInboxStatus {
  address: string
  destination: string
  verified: boolean
  verification_pending: boolean
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
  /** The provisioned agent-inbox, or absent when this company's bots have no
   *  address yet. */
  agent_inbox?: AgentInboxStatus | null
}

/** `POST /api/external-access/agent-inbox` result. */
export interface AgentInboxResult {
  address: string
  destination: string
  verification_pending: boolean
  routing_enabled: boolean
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
   *  token (0600, never echoed). Returns `{valid, account_id}`. */
  cfToken: (token: string): Promise<CfTokenResult> =>
    sessionRequest('/api/external-access/cf-token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  /** `GET /api/external-access/zones` — the DNS zones the saved CF token controls,
   *  the operator's base-domain choices. Names only; never the token. */
  zones: (): Promise<ZonesResult> =>
    sessionRequest<ZonesResult>('/api/external-access/zones'),

  /** `POST /api/external-access/base-domain` — persist the chosen base domain
   *  (server re-checks it is a zone the token controls; fail-closed on a typo),
   *  hot-reloading the live config. Returns `{base_domain}`. */
  setBaseDomain: (base_domain: string): Promise<BaseDomainResult> =>
    sessionRequest('/api/external-access/base-domain', {
      method: 'POST',
      body: JSON.stringify({ base_domain }),
    }),

  /** `POST /api/external-access/provision-tunnel` — idempotent one-time wildcard
   *  tunnel + DNS + connector unit. Poll `status.tunnel` for health after. */
  provisionTunnel: (): Promise<ProvisionResult> =>
    sessionRequest('/api/external-access/provision-tunnel', { method: 'POST' }),

  /** `POST /api/external-access/quick-tunnel` — the zero-config "try without a
   *  domain" branch. Starts a Cloudflare quick tunnel FOR `companyId` (no token,
   *  no zone, no Google) and returns the ephemeral `*.trycloudflare.com` URL. One
   *  active quick tunnel per box — starting one for another company replaces it. */
  startQuickTunnel: (companyId: number): Promise<QuickTunnelResult> =>
    sessionRequest('/api/external-access/quick-tunnel', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId }),
    }),

  /** `DELETE /api/external-access/quick-tunnel` — stop the child + drop the
   *  ephemeral host, hot-reloading auth. */
  stopQuickTunnel: (): Promise<QuickTunnelTeardownResult> =>
    sessionRequest('/api/external-access/quick-tunnel', { method: 'DELETE' }),

  /** `POST /api/external-access/google` — write the Google client id + secret
   *  (secret 0600, never echoed). Returns `{configured}`. */
  google: (client_id: string, client_secret: string): Promise<GoogleResult> =>
    sessionRequest('/api/external-access/google', {
      method: 'POST',
      body: JSON.stringify({ client_id, client_secret }),
    }),

  /** `POST /api/external-access/agent-inbox` — mint `<local_part>@<domain>` via
   *  Cloudflare Email Routing forwarding to `destination_email` (a connected
   *  mailbox). Idempotent — re-running refreshes the destination's verified state.
   *  Returns `{address, destination, verification_pending, routing_enabled}`. */
  agentInbox: (
    companyId: number,
    localPart: string,
    destinationEmail: string,
  ): Promise<AgentInboxResult> =>
    sessionRequest('/api/external-access/agent-inbox', {
      method: 'POST',
      body: JSON.stringify({
        company_id: companyId,
        local_part: localPart,
        destination_email: destinationEmail,
      }),
    }),

  /** `DELETE /api/external-access/agent-inbox?company_id=` — remove this company's
   *  agent-inbox (CF rule + record). */
  deleteAgentInbox: (companyId: number): Promise<{ deleted: boolean }> =>
    sessionRequest(`/api/external-access/agent-inbox?company_id=${companyId}`, {
      method: 'DELETE',
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

// DEV-only in-memory mock of the external-access / invite data plane, so the
// onboarding wizard is fully exercisable offline at `/?mock` (and on the
// `/dev/invite` bench) with NO live Cloudflare token, Google app, or server.
//
// It is a tiny state machine that mirrors `server/src/external_access/mod.rs`'s
// observable behaviour: token verify, tunnel provision → "connecting" → "healthy"
// over a couple seconds, Google config + a first-try redirect_uri_mismatch that
// clears on "Check again", and an invite roster. The `use-external-access` hooks
// route here when `devMockActive()` is true; production never imports this at
// runtime (it is dynamically imported only under the dev/mock guard, so it stays
// out of the shipped hero path).
//
// Entry condition is chosen by `?entry=A|B|C` (default A) so a reviewer can see
// each of the three resumable starting points the design specifies:
//   A — box has NO external access        → Domain (token → Choose domain → tunnel) → …
//   B — box set up, company not yet wired  → "add one URL" mini Google step → …
//   C — company already reachable+verified → Add person → Success (repeat invite)
//
// `?zones=multi` returns TWO zones from `zones()` so the reviewer can see the
// pick-one radio list; the default returns ONE, exercising the auto-select+confirm.

import type {
  AddHumanInput,
  AddHumanResult,
  AgentInboxResult,
  BaseDomainResult,
  CfTokenResult,
  ExternalStatus,
  GoogleResult,
  HostResult,
  HumanInvitee,
  ProvisionResult,
  QuickTunnelResult,
  QuickTunnelTeardownResult,
  TightenDnsResult,
  VerifyLoginResult,
  ZonesResult,
} from '@/lib/api'
import { SessionError } from '@/lib/api'
import { subdomainError } from '@/lib/company-subdomain'

// Entry `Q` is the "try without a domain" quick-tunnel branch. `?tunnel=1` on top
// of it seeds an ALREADY-active temporary link so the offline rig can screenshot
// the success screen directly (without waiting for the provisioning spinner);
// `?tunnel=dead` seeds one that is no longer running (the honest stopped panel).
type Entry = 'A' | 'B' | 'C' | 'Q' | 'I'

function readEntry(): Entry {
  if (typeof window === 'undefined') return 'A'
  const e = new URLSearchParams(window.location.search).get('entry')
  if (e === 'B' || e === 'C' || e === 'Q' || e === 'I') return e
  // `?tunnel=1` is an alias for the quick-tunnel entry.
  if (new URLSearchParams(window.location.search).get('tunnel') != null) return 'Q'
  return 'A'
}

/** What `?tunnel=` seeds on entry Q:
 *  - `1`    → an already-ACTIVE temporary link (the success panel).
 *  - `dead` → a link the box still has a record of that is NOT running — the
 *    honest "the tunnel stopped" panel. Seedable on purpose: that state used to
 *    render as the chooser (i.e. as if the button had done nothing), so the
 *    bench has to be able to show it. */
function tunnelSeed(): 'none' | 'active' | 'dead' {
  if (typeof window === 'undefined') return 'none'
  const v = new URLSearchParams(window.location.search).get('tunnel')
  if (v === '1') return 'active'
  if (v === 'dead') return 'dead'
  return 'none'
}

function multiZones(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('zones') === 'multi'
}

/** `?wildcard=1` seeds a box provisioned by an OLD build: it still holds a
 *  `*.<base>` record, so the wizard's "tighten" affordance is reviewable
 *  offline. */
function wildcardSeed(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('wildcard') === '1'
}

interface QuickTunnelMock {
  host: string
  companyId: number
  active: boolean
  createdAt: number
}

interface MockState {
  cfToken: 'none' | 'valid'
  baseDomain: string | null // chosen in the "Choose your domain" sub-step (null ⇒ unset)
  subdomain: string | null // the label in front of it — the owner may change it (null ⇒ the slug)
  provisionedAt: number | null // when provision-tunnel was called (drives connecting→healthy)
  google: 'unset' | 'configured'
  hostWritten: boolean
  verifyAttempts: number // first attempt mismatches, second clears — shows both paths
  humans: HumanInvitee[]
  quickTunnel: QuickTunnelMock | null // the "try without a domain" branch
  agentInbox: { address: string; destination: string } | null // CF agent-inbox
  agentInboxAttempts: number // first provision pending; a re-run ("Check again") verifies
  wildcardDns: boolean // a legacy `*.<base>` record this box still has (?wildcard=1)
  seededAt: number
}

const CONNECT_MS = 2500 // connecting → healthy dwell, long enough to SEE the spinner
const QUICK_HOST = 'calm-frog-1a2b3c4d.trycloudflare.com'
const SLUG = 'acme'

/** Host / redirect for the CHOSEN base domain + label — empty until a base is set,
 *  mirroring the server's fail-closed `CompanyStatus` (never a fake host). The
 *  label is the owner's if they picked one, else the slug the wizard suggests,
 *  exactly like the server's entry-authoritative resolution. */
function derived(baseDomain: string | null): { host: string; redirect: string } {
  if (!baseDomain) return { host: '', redirect: '' }
  const host = `${state.subdomain ?? SLUG}.${baseDomain}`
  return { host, redirect: `https://${host}/auth/callback` }
}

function initialState(entry: Entry): MockState {
  const now = Date.now()
  const base: MockState = {
    cfToken: 'none',
    baseDomain: null,
    subdomain: null,
    provisionedAt: null,
    google: 'unset',
    hostWritten: false,
    verifyAttempts: 0,
    humans: [],
    quickTunnel: null,
    agentInbox: null,
    agentInboxAttempts: 0,
    wildcardDns: wildcardSeed(),
    seededAt: now,
  }
  // Q — the "try without a domain" branch. No CF token, no base domain, no Google:
  // the wizard opens on the two-card chooser. `?tunnel=1` seeds an already-live
  // temporary link so the success screen renders immediately.
  if (entry === 'Q') {
    const seed = tunnelSeed()
    if (seed !== 'none') {
      base.quickTunnel = {
        host: QUICK_HOST,
        companyId: 42,
        active: seed === 'active',
        createdAt: now - 60_000,
      }
    }
    return base
  }
  // I — the agent-inbox showcase: a fully-configured, verified box (like C) plus a
  // freshly-provisioned agent-inbox in the PENDING state, so the `agent-inbox`
  // step renders its verification-pending panel for the offline rig.
  if (entry === 'B' || entry === 'C' || entry === 'I') {
    base.cfToken = 'valid'
    base.baseDomain = 'example.com' // already chosen
    base.provisionedAt = now - CONNECT_MS - 1000 // already healthy
    base.google = 'configured'
  }
  if (entry === 'C' || entry === 'I') {
    base.hostWritten = true
    base.verifyAttempts = 2 // already verified
    base.humans = [
      row(1, 'dana@acme.co', 'Dana Ruiz', 'admin', 'active', now - 86_400_000),
      row(2, 'lee@acme.co', 'Lee Park', 'member', 'pending', now - 3_600_000),
    ]
  }
  if (entry === 'I') {
    base.agentInbox = { address: 'agent@example.com', destination: 'owner@example.com' }
    base.agentInboxAttempts = 1 // provisioned but not yet verified (pending)
  }
  return base
}

function row(
  id: number,
  email: string,
  display_name: string,
  role: string,
  status: string,
  created_at: number,
): HumanInvitee {
  return { id, email, display_name, company_id: 42, role, created_at, status }
}

/** A plausible-looking (but fake) signed invite token for the offline bench. */
function mockInviteToken(userId: number): string {
  const payload = btoa(`${userId}:42:${Math.floor(Date.now() / 1000) + 604800}`).replace(/=+$/, '')
  return `${payload}.f${(userId * 2654435761).toString(16).slice(0, 24)}`
}

let state: MockState = initialState(readEntry())

/** Reset the mock (the dev bench calls this on mount so re-runs start clean). */
export function resetExternalAccessMock() {
  state = initialState(readEntry())
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function tunnelPhase(): 'none' | 'connecting' | 'healthy' {
  if (state.provisionedAt == null) return 'none'
  return Date.now() - state.provisionedAt >= CONNECT_MS ? 'healthy' : 'connecting'
}

export const externalAccessMock = {
  async status(companyId?: number): Promise<ExternalStatus> {
    const tunnel = tunnelPhase()
    const { host, redirect } = derived(state.baseDomain)
    const qt = state.quickTunnel
    const out: ExternalStatus = {
      box_status: {
        cf_token: state.cfToken,
        tunnel,
        dns_ok: tunnel === 'healthy',
        google: state.google,
        base_domain: state.baseDomain,
        wildcard_dns: state.wildcardDns && state.baseDomain != null,
        // One record per company host — and nothing until an address is written.
        dns_records: state.hostWritten && host ? [host] : [],
        // The mock box always has a live supervised connector — the honest
        // "nothing is running" branch is exercised by the unit tests.
        connector:
          state.provisionedAt == null
            ? { running: false, via: 'none', detail: 'the connector has not been started on this box' }
            : { running: true, via: 'child', pid: 4242, detail: 'supermux is running the connector' },
        quick_tunnel: qt
          ? {
              active: qt.active,
              url: `https://${qt.host}`,
              host: qt.host,
              company_id: qt.companyId,
              ephemeral: true,
            }
          : null,
      },
    }
    if (companyId != null) {
      const verified = state.verifyAttempts >= 2
      const ai = state.agentInbox
      const aiVerified = state.agentInboxAttempts >= 2
      out.company = {
        company_id: companyId,
        // Only a real host write counts. Treating "Google is configured" as a
        // written host hid entry B's actual state: a new company on a set-up box
        // has NO address until `host` is posted, which is exactly when the wizard
        // must offer to name it.
        company_host_written: state.baseDomain != null && state.hostWritten,
        redirect_registered: verified ? 'ok' : state.verifyAttempts > 0 ? 'mismatch' : 'unknown',
        reachable: verified && tunnel === 'healthy',
        host, // '' until a base domain is chosen — never a fake host
        redirect_uri: redirect,
        agent_inbox: ai
          ? {
              address: ai.address,
              destination: ai.destination,
              verified: aiVerified,
              verification_pending: !aiVerified,
            }
          : null,
      }
    }
    return out
  },

  async cfToken(token: string): Promise<CfTokenResult> {
    await wait(650)
    if (token.trim().length < 8) {
      throw new SessionError('That token looks too short — paste the full Cloudflare API token.', 400)
    }
    if (token.trim().toLowerCase().startsWith('bad')) {
      throw new SessionError(
        'This Cloudflare token is missing a permission: Zone · DNS: Edit — add that row to the token and create it again.',
        400,
      )
    }
    state.cfToken = 'valid'
    return { valid: true, account_id: 'a1b2c3d4e5f6a7b8c9d0' }
  },

  async zones(): Promise<ZonesResult> {
    await wait(500)
    return { zones: multiZones() ? ['example.com', 'other.test'] : ['example.com'] }
  },

  async setBaseDomain(baseDomain: string): Promise<BaseDomainResult> {
    await wait(450)
    const allowed = multiZones() ? ['example.com', 'other.test'] : ['example.com']
    const d = baseDomain.trim().toLowerCase()
    if (!allowed.includes(d)) {
      throw new SessionError(`${d} isn’t a domain this Cloudflare token controls — pick one from the list.`, 400)
    }
    state.baseDomain = d
    return { base_domain: d }
  },

  async provisionTunnel(): Promise<ProvisionResult> {
    await wait(500)
    state.provisionedAt = Date.now()
    // Per-host records only: provisioning creates one CNAME for each company
    // address already chosen — never a `*.<base>` wildcard.
    const records = state.hostWritten ? [derived(state.baseDomain).host] : []
    return {
      tunnel_id: 'e1a2b3c4-5678-90ab-cdef-1234567890ab',
      connector: 'started',
      connector_detail: 'the connector is running (child, pid 4242)',
      reachable_host: records.join(', '),
      dns_records: records,
    }
  },

  async startQuickTunnel(companyId?: number): Promise<QuickTunnelResult> {
    // cloudflared takes a couple of seconds to come up and print its URL — the
    // wizard shows a spinner via the mutation's pending state for this whole await.
    await wait(2200)
    const cid = companyId ?? 42
    state.quickTunnel = { host: QUICK_HOST, companyId: cid, active: true, createdAt: Date.now() }
    return { url: `https://${QUICK_HOST}`, host: QUICK_HOST, ephemeral: true, company_id: cid }
  },

  async stopQuickTunnel(): Promise<QuickTunnelTeardownResult> {
    await wait(400)
    const torn = state.quickTunnel != null
    state.quickTunnel = null
    return { torn_down: torn }
  },

  async google(clientId: string, clientSecret: string): Promise<GoogleResult> {
    await wait(650)
    if (!/\.apps\.googleusercontent\.com$/.test(clientId.trim())) {
      throw new SessionError('That is not a Google client id — it should end in .apps.googleusercontent.com', 400)
    }
    if (clientSecret.trim().length < 6) {
      throw new SessionError('Paste the client secret from the same Google OAuth client.', 400)
    }
    state.google = 'configured'
    state.hostWritten = true
    return { configured: true }
  },

  async tightenDns(): Promise<TightenDnsResult> {
    await wait(700)
    const records = state.hostWritten ? [derived(state.baseDomain).host] : []
    const wildcard_removed = state.wildcardDns
    state.wildcardDns = false
    return { records, wildcard_removed }
  },

  async host(_companyId?: number, subdomain?: string): Promise<HostResult> {
    await wait(400)
    const before = derived(state.baseDomain).host
    if (subdomain != null) {
      const bad = subdomainError(subdomain)
      if (bad) throw new SessionError(`${bad}.`, 400)
      state.subdomain = subdomain.trim().toLowerCase()
    }
    state.hostWritten = true
    const { host, redirect } = derived(state.baseDomain)
    return {
      host,
      redirect_uri: redirect,
      // Only when the address actually moved — same honesty as the server.
      previous_host: before && before !== host ? before : null,
      // No tunnel yet ⇒ the record is created by "Set up access", not here.
      dns: state.provisionedAt == null ? 'pending' : before === host ? 'exists' : 'created',
      previous_dns_removed: Boolean(before) && before !== host && state.provisionedAt != null,
    }
  },

  async verifyLogin(_companyId?: number): Promise<VerifyLoginResult> {
    await wait(800)
    const { redirect } = derived(state.baseDomain)
    state.verifyAttempts += 1
    if (state.verifyAttempts >= 2) {
      return { ok: true, detail: 'Google recognises this address.', redirect_uri: redirect }
    }
    return {
      ok: false,
      detail: `Google doesn’t recognise ${redirect} yet — add it under Authorized redirect URIs and press Check again.`,
      redirect_uri: redirect,
    }
  },

  async addHuman(_companyId: number, input: AddHumanInput): Promise<AddHumanResult> {
    await wait(450)
    const id = state.humans.length + 10
    const r = row(
      id,
      input.email.trim(),
      input.display_name?.trim() || input.email.trim().split('@')[0],
      input.role,
      'invited',
      Date.now(),
    )
    state.humans = [r, ...state.humans]
    // On the quick-tunnel branch the colleague gets a SIGNED magic link on the
    // ephemeral host (no Google); otherwise the permanent company host they sign
    // in to with Google.
    const qt = state.quickTunnel
    const login_url = qt
      ? `https://${qt.host}/auth/invite?token=${mockInviteToken(r.id)}`
      : `https://${derived(state.baseDomain).host}`
    return {
      user: {
        id: r.id,
        email: r.email,
        display_name: r.display_name,
        company_id: 42,
        role: r.role,
        created_at: r.created_at,
      },
      login_url,
    }
  },

  async agentInbox(_companyId: number, localPart: string, destinationEmail: string): Promise<AgentInboxResult> {
    await wait(700)
    const dest = destinationEmail.trim().toLowerCase()
    if (!/.+@.+\..+/.test(dest)) {
      throw new SessionError('That destination isn’t a valid email — paste the mailbox mail should forward to.', 400)
    }
    const lp = (localPart.trim() || 'agent').toLowerCase()
    const address = `${lp}@${state.baseDomain ?? 'example.com'}`
    state.agentInboxAttempts += 1
    state.agentInbox = { address, destination: dest }
    const verified = state.agentInboxAttempts >= 2 // first provision pending, re-run verifies
    return { address, destination: dest, verification_pending: !verified, routing_enabled: true }
  },

  async deleteAgentInbox(_companyId: number): Promise<{ deleted: boolean }> {
    await wait(350)
    const had = state.agentInbox != null
    state.agentInbox = null
    state.agentInboxAttempts = 0
    return { deleted: had }
  },

  async listHumans(_companyId?: number): Promise<HumanInvitee[]> {
    return state.humans
  },

  async removeHuman(_companyId: number, hid: number) {
    await wait(300)
    state.humans = state.humans.filter((h) => h.id !== hid)
    return { deleted: true, sessions_revoked: 0 }
  },
}

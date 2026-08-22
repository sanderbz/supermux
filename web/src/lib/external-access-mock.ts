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
//   A — box has NO external access        → Domain → Google → Add person → Success
//   B — box set up, company not yet wired  → "add one URL" mini Google step → …
//   C — company already reachable+verified → Add person → Success (repeat invite)

import type {
  AddHumanInput,
  AddHumanResult,
  CfTokenResult,
  ExternalStatus,
  GoogleResult,
  HostResult,
  HumanInvitee,
  ProvisionResult,
  VerifyLoginResult,
} from '@/lib/api'
import { SessionError } from '@/lib/api'

type Entry = 'A' | 'B' | 'C'

function readEntry(): Entry {
  if (typeof window === 'undefined') return 'A'
  const e = new URLSearchParams(window.location.search).get('entry')
  return e === 'B' || e === 'C' ? e : 'A'
}

interface MockState {
  cfToken: 'none' | 'valid'
  provisionedAt: number | null // when provision-tunnel was called (drives connecting→healthy)
  google: 'unset' | 'configured'
  hostWritten: boolean
  verifyAttempts: number // first attempt mismatches, second clears — shows both paths
  humans: HumanInvitee[]
  seededAt: number
}

const CONNECT_MS = 2500 // connecting → healthy dwell, long enough to SEE the spinner
const HOST = 'acme.s.iwd.nl'
const REDIRECT = 'https://acme.s.iwd.nl/auth/callback'

function initialState(entry: Entry): MockState {
  const now = Date.now()
  const base: MockState = {
    cfToken: 'none',
    provisionedAt: null,
    google: 'unset',
    hostWritten: false,
    verifyAttempts: 0,
    humans: [],
    seededAt: now,
  }
  if (entry === 'B' || entry === 'C') {
    base.cfToken = 'valid'
    base.provisionedAt = now - CONNECT_MS - 1000 // already healthy
    base.google = 'configured'
  }
  if (entry === 'C') {
    base.hostWritten = true
    base.verifyAttempts = 2 // already verified
    base.humans = [
      row(1, 'dana@acme.co', 'Dana Ruiz', 'admin', 'active', now - 86_400_000),
      row(2, 'lee@acme.co', 'Lee Park', 'member', 'pending', now - 3_600_000),
    ]
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
    const out: ExternalStatus = {
      box_status: {
        cf_token: state.cfToken,
        tunnel,
        dns_ok: tunnel === 'healthy',
        google: state.google,
      },
    }
    if (companyId != null) {
      const verified = state.verifyAttempts >= 2
      out.company = {
        company_id: companyId,
        company_host_written: state.hostWritten || state.google === 'configured',
        redirect_registered: verified ? 'ok' : state.verifyAttempts > 0 ? 'mismatch' : 'unknown',
        reachable: verified && tunnel === 'healthy',
        host: HOST,
        redirect_uri: REDIRECT,
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
      throw new SessionError('Token active but missing DNS · Edit — recreate it with the listed scopes.', 400)
    }
    state.cfToken = 'valid'
    return { valid: true, account_id: 'a1b2c3d4e5f6a7b8c9d0', zone_id: 'z9y8x7w6v5u4t3s2r1q0' }
  },

  async provisionTunnel(): Promise<ProvisionResult> {
    await wait(500)
    state.provisionedAt = Date.now()
    return {
      tunnel_id: 'e1a2b3c4-5678-90ab-cdef-1234567890ab',
      connector: 'started',
      reachable_host: HOST,
    }
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

  async host(_companyId?: number): Promise<HostResult> {
    await wait(400)
    state.hostWritten = true
    return { host: HOST, redirect_uri: REDIRECT }
  },

  async verifyLogin(_companyId?: number): Promise<VerifyLoginResult> {
    await wait(800)
    state.verifyAttempts += 1
    if (state.verifyAttempts >= 2) {
      return { ok: true, detail: 'Google recognises this address.', redirect_uri: REDIRECT }
    }
    return {
      ok: false,
      detail: `Google doesn’t recognise ${REDIRECT} yet — add it under Authorized redirect URIs and press Check again.`,
      redirect_uri: REDIRECT,
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
    return {
      user: {
        id: r.id,
        email: r.email,
        display_name: r.display_name,
        company_id: 42,
        role: r.role,
        created_at: r.created_at,
      },
      login_url: `https://${HOST}`,
    }
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

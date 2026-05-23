// M22 — Settings client.
//
// Envelope: HTTP responses are `{ ok, data?, error? }` (§3.4). We unwrap `data`
// on success and throw `ApiError` (carrying the status code) otherwise — the
// settings hooks turn a 404/501 into a graceful "backend not wired yet" state
// rather than a crash, since the prefs/audit handlers land in a later backend
// milestone.
//
// The dashboard bearer token is read from `window._SUPERMUX_AUTH_TOKEN` at call time
// (env.ts, via the shared `settingsRequest` in ./client) and sent as
// `Authorization: Bearer …`. It is NEVER hard-coded here.

import { settingsRequest } from './client'

// ── M0 stub domain types (legacy skeleton) ────────────────────────────────────

export interface Snippet {
  id: string
  label: string
  command: string
}

export interface KbdGroup {
  id: string
  name: string
  keys: string[]
}

/** Audit-log row (§6.4). */
export interface AuditEntry {
  id: number
  at: string
  action: string
  detail?: string
}

// ── M22 settings wire types ───────────────────────────────────────────────────

/** API-key settings — values arrive MASKED from the server (§1.8); never raw. */
export interface MaskedEnv {
  /** e.g. `sk-ant-…last4`, or `''` when unset. */
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
}

export interface DefaultModelInfo {
  model: string
}

export interface RegenerateTokenResult {
  token: string
}

export const settingsApi = {
  /** GET `/api/settings/env` — returns MASKED key previews (§1.8). */
  getEnv: (): Promise<MaskedEnv> => settingsRequest('/api/settings/env'),
  /** PATCH `/api/settings/env` — write `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. */
  patchEnv: (patch: MaskedEnv): Promise<MaskedEnv> =>
    settingsRequest('/api/settings/env', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** GET `/api/settings/default-model`. */
  getDefaultModel: (): Promise<DefaultModelInfo> =>
    settingsRequest('/api/settings/default-model'),
  /** PATCH `/api/settings/default-model` — `{ model }` → `CC_DEFAULT_FLAGS`. */
  patchDefaultModel: (model: string): Promise<DefaultModelInfo> =>
    settingsRequest('/api/settings/default-model', {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    }),
  /** GET `/api/audit?limit=N` — last N audit rows (§6.4). */
  getAudit: (limit = 200): Promise<AuditEntry[]> =>
    settingsRequest(`/api/audit?limit=${limit}`),
  // NOTE: snippet CRUD lives in `./commands.ts` (`commandsApi`), the M9 wire
  // contract (`{title, body, position}`, integer ids). The legacy `label/command`
  // snippet methods that used to live here were removed (review R3-003) so the
  // Settings manager and the focus snippet panel share ONE client + cache key.
  /** POST `/api/settings/regenerate-token` — rotate the dashboard bearer. */
  regenerateToken: (): Promise<RegenerateTokenResult> =>
    settingsRequest('/api/settings/regenerate-token', { method: 'POST' }),

  /** `GET /api/prefs/:key` — fetch the account-wide opaque pref value (or `null`
   *  if unset). Currently used by `overview_layout` (sort mode + custom-mode
   *  ordering + groups). The server allowlists the key set; unknown keys 404.
   *  We treat 404 as "unset" so a client running ahead of the server doesn't
   *  hard-error — the UI falls back to its default state. */
  getPref: async (key: string): Promise<string | null> => {
    try {
      const data = await settingsRequest<{ key: string; value: string | null }>(
        `/api/prefs/${encodeURIComponent(key)}`,
      )
      return data?.value ?? null
    } catch (err) {
      // ApiError carries .status; a 404 (unknown key) is the same as "unset"
      // from the UI's perspective.
      const status = (err as { status?: number }).status
      if (status === 404) return null
      throw err
    }
  },
  /** `PUT /api/prefs/:key` — upsert the opaque value. The server broadcasts an
   *  SSE `prefs` event so peer tabs reconcile live (no polling). */
  putPref: (key: string, value: string): Promise<{ key: string; value: string }> =>
    settingsRequest(`/api/prefs/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
}

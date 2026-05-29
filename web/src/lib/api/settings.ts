// Settings client.
//
// Envelope: HTTP responses are `{ ok, data?, error? }`. We unwrap `data`
// on success and throw `ApiError` (carrying the status code) otherwise — the
// settings hooks turn a 404/501 into a graceful "backend not wired yet" state
// rather than a crash, since the prefs/audit handlers land in a later backend
// milestone.
//
// The dashboard bearer token is read from `window._SUPERMUX_AUTH_TOKEN` at call time
// (env.ts, via the shared `settingsRequest` in ./client) and sent as
// `Authorization: Bearer …`. It is NEVER hard-coded here.

import { settingsRequest } from './client'

// ── Stub domain types (legacy skeleton) ───────────────────────────────────────

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

/** Audit-log row. Field shape mirrors the server serializer exactly
 *  (`server/src/db/runtime_state.rs` `AuditEntry`, serialized verbatim with no
 *  `serde(rename)`): `ts` is epoch **seconds** as a number — NOT `at`/string.
 *  Reading `row.at` here used to yield `undefined`, corrupting the timestamp
 *  column to `—`. */
export interface AuditEntry {
  id: number
  /** Epoch seconds (server: `ts = Utc::now().timestamp()`). */
  ts: number
  actor: string
  action: string
  target: string
  detail?: string
}

// ── Settings wire types ───────────────────────────────────────────────────────

/** API-key settings — values arrive MASKED from the server; never raw. */
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

/** Experimental Agent Teams toggle. Server default is OFF; the change
 *  takes effect on the NEXT session start. */
export interface AgentTeamsSetting {
  enabled: boolean
}

/** Pref key the server stamps onto the SSE `settings` event so peer tabs can
 *  route just the keys they own (mirrors `OVERVIEW_LAYOUT_PREF_KEY` in
 *  use-sessions). The `settings` event payload is `{ key, enabled }`. */
export const AGENT_TEAMS_PREF_KEY = 'experimental.agent_teams'

export const settingsApi = {
  /** GET `/api/settings/env` — returns MASKED key previews. */
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
  /** GET `/api/audit?limit=N` — last N audit rows. */
  getAudit: (limit = 200): Promise<AuditEntry[]> =>
    settingsRequest(`/api/audit?limit=${limit}`),
  // NOTE: snippet CRUD lives in `./commands.ts` (`commandsApi`), the live wire
  // contract (`{title, body, position}`, integer ids). The legacy `label/command`
  // snippet methods that used to live here were removed so the Settings manager
  // and the focus snippet panel share ONE client + cache key.
  /** POST `/api/settings/regenerate-token` — rotate the dashboard bearer. */
  regenerateToken: (): Promise<RegenerateTokenResult> =>
    settingsRequest('/api/settings/regenerate-token', { method: 'POST' }),

  /** GET `/api/settings/experimental/agent-teams` — current toggle state.
   *  Default OFF. An older server build (404/501) surfaces as `isError` and the
   *  Settings UI shows a calm "not supported yet" state. */
  getAgentTeams: (): Promise<AgentTeamsSetting> =>
    settingsRequest('/api/settings/experimental/agent-teams'),
  /** PUT `/api/settings/experimental/agent-teams` — `{ enabled }`. The server
   *  echoes the new state and broadcasts an SSE `settings` event so peer tabs
   *  reconcile live (no polling). Takes effect on the next new session. */
  setAgentTeams: (enabled: boolean): Promise<AgentTeamsSetting> =>
    settingsRequest('/api/settings/experimental/agent-teams', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),

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

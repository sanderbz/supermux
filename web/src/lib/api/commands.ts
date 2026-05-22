// M18 — slash-commands + snippets client.
//
// Consumes the M9 backend endpoints the composer needs:
//   * `GET  /api/slash-commands` — built-ins (§5.3) merged with user skills, for
//     the "/" autocomplete menu. Returns `{ ok, data: [{cmd, desc}, …] }`.
//   * `GET    /api/snippets`      — saved-command picker (§4.4.1).
//   * `POST   /api/snippets`      — create (returns `{ ok, id }`).
//   * `PATCH  /api/snippets/{id}` — edit title / body / position.
//   * `DELETE /api/snippets/{id}` — remove.
//
// These mirror the M9 wire contract EXACTLY (server/src/agents/skills.rs::
// SlashCommand, server/src/prefs.rs snippet handlers, db::prefs::Snippet) — the
// M0 `Snippet` stub in ./settings.ts predates this contract and is left alone.
//
// Auth: every request rides the dashboard bearer read from `window
// ._SUPERMUX_AUTH_TOKEN` at call time via the shared `apiToken()` (client.ts) —
// NEVER hard-coded. These are the M9 authed routes; no new unauthed surface.

import { ApiError, apiToken, apiUrl } from './client'

// ── wire types (mirror the M9 backend) ───────────────────────────────────────

/** One row of `GET /api/slash-commands` (skills.rs::SlashCommand). Built-ins
 *  carry an empty `desc`; user skills carry their frontmatter description. */
export interface SlashCommand {
  cmd: string
  desc: string
}

/** A row of the `snippets` table (db::prefs::Snippet). `id` is an integer. */
export interface SnippetRow {
  id: number
  title: string
  body: string
  position: number
  created: number
}

/** Create payload — `position` optional (server defaults to 0). */
export interface SnippetCreateInput {
  title: string
  body: string
  position?: number
}

/** Patch payload — every field optional; unset fields stay untouched. */
export interface SnippetPatchInput {
  title?: string
  body?: string
  position?: number
}

// ── envelope-aware request ────────────────────────────────────────────────────
//
// The M9 success envelope varies: list/`slash-commands` wrap the payload in
// `data`, but `POST /api/snippets` returns `{ ok, id }` (no `data`). This helper
// returns the WHOLE parsed envelope so callers can pick `data` or `id` as the
// endpoint dictates — never crashing on a shape it didn't expect.

interface RawEnvelope {
  ok?: boolean
  data?: unknown
  id?: unknown
  error?: unknown
}

async function cmdRequest(path: string, init?: RequestInit): Promise<RawEnvelope> {
  const headers = new Headers(init?.headers)
  const token = apiToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')

  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers })
  } catch {
    throw new ApiError(0, 'Can’t reach supermux-server.')
  }
  if (res.status === 204) {
    if (!res.ok) throw new ApiError(res.status, res.statusText)
    return { ok: true }
  }
  let env: RawEnvelope = {}
  try {
    env = (await res.json()) as RawEnvelope
  } catch {
    /* non-JSON body — fall through to the status check */
  }
  if (!res.ok) {
    throw new ApiError(res.status, String(env.error ?? res.statusText))
  }
  if (env.ok === false) {
    throw new ApiError(res.status, String(env.error ?? 'request failed'))
  }
  return env
}

// ── public surface ────────────────────────────────────────────────────────────

export const commandsApi = {
  /** `GET /api/slash-commands` — built-ins + skills for the "/" menu. */
  listSlashCommands: async (): Promise<SlashCommand[]> => {
    const env = await cmdRequest('/api/slash-commands')
    return Array.isArray(env.data) ? (env.data as SlashCommand[]) : []
  },

  /** `GET /api/snippets` — all snippets, ordered by `position`. */
  listSnippets: async (): Promise<SnippetRow[]> => {
    const env = await cmdRequest('/api/snippets')
    return Array.isArray(env.data) ? (env.data as SnippetRow[]) : []
  },

  /** `POST /api/snippets` — create; returns the new row id. */
  createSnippet: async (input: SnippetCreateInput): Promise<number> => {
    const env = await cmdRequest('/api/snippets', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return typeof env.id === 'number' ? env.id : -1
  },

  /** `PATCH /api/snippets/{id}` — edit title / body / position. */
  patchSnippet: async (id: number, patch: SnippetPatchInput): Promise<void> => {
    await cmdRequest(`/api/snippets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  /** `DELETE /api/snippets/{id}` — remove. */
  deleteSnippet: async (id: number): Promise<void> => {
    await cmdRequest(`/api/snippets/${id}`, { method: 'DELETE' })
  },
}

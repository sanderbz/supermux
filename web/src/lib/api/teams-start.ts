// "Start a team" API client — the START flow only.
//
// Distinct file from the team DETECTION client (`teams.ts`, which consumes
// `GET /api/teams` + the SSE `teams` event) so the two frontend slices never
// collide. This module owns exactly ONE endpoint:
//   POST /api/teams/start  → create + boot a Claude LEAD with Agent Teams
//   enabled for it + a seed prompt that forms the team of N teammates.
//
// The bearer token is read off `window._SUPERMUX_AUTH_TOKEN` at call time via the
// shared client primitives — never embedded here.

import { apiToken, apiUrl } from './client'
import { SessionError, type ApiSession } from './sessions'

/** Body for `POST /api/teams/start`. `task` (the goal) is required; the rest is
 *  optional and defensively clamped/sanitized server-side. */
export interface StartTeamInput {
  /** The team's goal / intent. Required, non-empty. */
  task: string
  /** How many TEAMMATES the lead spawns (the lead is +1). Clamped 1..=8 server
   *  side; omit to let the server default (3). */
  teammates?: number
  /** Optional model alias applied to every teammate (e.g. `opus`, `sonnet`). */
  model?: string
  /** Optional working directory for the lead (defaults to the server home). */
  dir?: string
  /** Optional explicit lead session name (auto-generated `team-<id>` if omitted). */
  name?: string
}

/** Body for `POST /api/teams/start-from-existing`. The
 *  existing session's `dir` is authoritative — there is no `dir` field. */
export interface ConvertToTeamInput {
  /** The existing session's name. Required. */
  name: string
  /** The team's goal. Required, non-empty. */
  task: string
  /** Teammate count (lead is +1). Clamped 1..=8 server-side. */
  teammates?: number
  /** Optional per-teammate model alias. */
  model?: string
}

/** Success payload from `POST /api/teams/start`: the created LEAD session (so the
 *  caller can navigate to `/focus/<name>`) + the resolved teammate count. */
export interface StartTeamResult {
  team: true
  teammates: number
  lead: ApiSession
}

/** Same request/error discipline as the sessions client: lifts the
 *  `{ ok, data, error }` envelope and throws a `SessionError` (carrying the HTTP
 *  status) so callers can branch 409 (duplicate lead name) / 400 (bad goal) /
 *  0 (server unreachable). */
async function teamsReq<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const token = apiToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers })
  } catch {
    throw new SessionError('Can’t reach supermux-server.', 0)
  }
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status}).`
    throw new SessionError(message, res.status)
  }
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data
  }
  return body as T
}

export const teamsStartApi = {
  /** `POST /api/teams/start` — spin up a team lead and form the team. Returns the
   *  LEAD session so the route can navigate into its focus view; the TEAM CARD
   *  appears via detection once the lead spawns its panes. */
  start: (input: StartTeamInput): Promise<StartTeamResult> =>
    teamsReq<StartTeamResult>('/api/teams/start', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** `POST /api/teams/start-from-existing` — convert an
   *  EXISTING session into a team lead in place. The session keeps its name,
   *  dir, tags / pin / branch / mcp; only the desc is refreshed and a `team`
   *  tag is added. The Claude agent is restarted (fresh conversation) because
   *  the Agent Teams env+settings only take effect at process launch — the
   *  caller surfaces this in confirm copy. Errors map to: 404 unknown name,
   *  409 already-a-lead / archived, 400 bad name / empty task / wrong provider. */
  convert: (input: ConvertToTeamInput): Promise<StartTeamResult> =>
    teamsReq<StartTeamResult>('/api/teams/start-from-existing', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
}

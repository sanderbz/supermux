// Agents — cross-session delegation (`/api/agents/*`).
//
// One session hands work to another. The server delivers the prompt through the
// same lifecycle path a human `send` uses, wraps it in `<supermux-delegation>`
// for a Claude recipient so their transcript knows who asked, and records an
// `audit_log` row that both ends' harness feeds read back (the durable ledger
// design — SSE is only its invalidation tick).
//
// **`actor` IS HONEST LABELLING, NOT AUTHENTICATION.** This client sends
// `actor: 'human'` because a composer hand-off genuinely is the owner speaking,
// and the ledger should say `user` rather than `agent:<session>` so the
// transcript does not attribute the owner's instruction to their own agent. The
// server's module doc is explicit that it cannot verify the claim — the route
// is bearer-only, and the bearer is admin-equivalent. Nothing here is a
// privilege boundary; it is the difference between two true sentences in a log.
//
// Envelope + token handling exactly as its siblings: `{ ok, data }` unwrapped,
// `{ ok:false, error }` lifted into a typed error carrying the HTTP status, and
// the bearer read from `window._SUPERMUX_AUTH_TOKEN` at call time.

import { apiToken, apiUrl } from './client'

/** A delegation edge (`delegations` table, migration 0005). */
export interface DelegationEdge {
  id: number
  from_session: string
  to_session: string
  prompt: string
  /** Epoch SECONDS. */
  ts: number
}

/** `GET /api/agents/delegations?session=X` — the graph in and out of `X`. */
export interface DelegationsView {
  outgoing: DelegationEdge[]
  incoming: DelegationEdge[]
}

/** An error from `/api/agents/*`, carrying the status so a caller can tell a
 *  refusal (400 — wrapper markup, oversized prompt) from a gone session (404)
 *  from an unreachable server (0). */
export class AgentsError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AgentsError'
    this.status = status
  }
}

async function agentsReq<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const token = apiToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')
  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers })
  } catch {
    throw new AgentsError('Can’t reach supermux-server.', 0)
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
    // The server's refusals are written to be read by a person ("prompt may not
    // contain supermux wrapper markup"), so they go straight onto the composer's
    // receipt rather than being flattened into "something went wrong".
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status}).`
    throw new AgentsError(message, res.status)
  }
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data
  }
  return body as T
}

export const agentsApi = {
  /**
   * Hand `prompt` from `from` to `to`.
   *
   * Resolving means the SERVER accepted and delivered it — the receipt the
   * composer raises is about that, not about the recipient having read it.
   * Rejections arrive as `AgentsError` with the server's own sentence.
   */
  delegate: (input: { from: string; to: string; prompt: string }): Promise<{ id?: number }> =>
    agentsReq('/api/agents/delegate', {
      method: 'POST',
      body: JSON.stringify({ ...input, actor: 'human' }),
    }),

  /** The delegation graph in and out of `session`. */
  delegations: (session: string): Promise<DelegationsView> =>
    agentsReq(`/api/agents/delegations?session=${encodeURIComponent(session)}`),
}

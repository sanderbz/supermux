// Board (M19) — real client for the M6 backend kanban (issues + statuses + the
// atomic claim).
//
// Envelope: M6 success bodies use the standard `{ ok:true, data }` envelope
// (§3.4); errors use `{ ok:false, error }`. `boardRequest` unwraps `data` on
// success and lifts `error` into a typed `BoardError` (carrying the HTTP status)
// so the UI can branch 409 (atomic-claim lost / not-claimable — §3.2.10) vs 404
// vs 400 without ever crashing.

import { apiToken, apiUrl } from './client'

// ── M0 stub domain types (legacy skeleton) ────────────────────────────────────
//
// The `Issue`/`CreateIssueInput` stub types pre-date the M6 contract and are
// intentionally left untouched; the `BoardIssue`/`BoardStatus` shapes below
// match what M6 actually returns (server/src/board/mod.rs `IssueView` +
// server/src/db/board.rs `BoardStatus`).

export interface Issue {
  id: string
  title: string
  status: string
  tags: string[]
  prefix: string
  body?: string
  claimed_by?: string
  created_at: string
  updated_at: string
}

export interface CreateIssueInput {
  title: string
  body?: string
  tags?: string[]
  status?: string
}

// ── M6 wire types ─────────────────────────────────────────────────────────────

/** An issue exactly as M6's `IssueView` serialises it (server/src/board/mod.rs). */
export interface BoardIssue {
  id: string
  title: string
  desc: string
  status: string
  session: string | null
  creator: string
  due: string | null
  due_time: string | null
  created: number
  updated: number
  owner_type: 'human' | 'agent'
  pinned: number
  pos: number
  tags: string[]
}

/** A board column (server/src/db/board.rs `BoardStatus`). */
export interface BoardStatus {
  id: string
  label: string
  position: number
  is_builtin: number
}

/** Fields a NewIssueDialog can set. `session: null` = unassigned. */
export interface NewBoardIssue {
  title: string
  desc?: string
  status?: string
  session?: string | null
  due?: string | null
  due_time?: string | null
  owner_type?: 'human' | 'agent'
  tags?: string[]
}

/** A partial patch. Only the keys present are written (M6 PATCH semantics). */
export interface BoardIssuePatch {
  title?: string
  desc?: string
  status?: string
  session?: string | null
  due?: string | null
  due_time?: string | null
  owner_type?: 'human' | 'agent'
  pinned?: boolean
  pos?: number
  tags?: string[]
}

/** A failed board request; carries the HTTP status so the UI can branch on 409
 *  (atomic-claim lost / not an agent task / wrong column) vs 404 vs 400. */
export class BoardError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'BoardError'
    this.status = status
  }
}

async function boardRequest<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new BoardError('Can’t reach amux-server.', 0)
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
    throw new BoardError(message, res.status)
  }
  // Success envelope: `{ ok:true, data }` — unwrap `data`; tolerate a bare body.
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data
  }
  return body as T
}

export const boardApi = {
  /** `GET /api/board` — the full board (issues across all columns). */
  list: (): Promise<BoardIssue[]> => boardRequest('/api/board'),

  /** `GET /api/board/statuses` — the column config, in display order. */
  statuses: (): Promise<BoardStatus[]> => boardRequest('/api/board/statuses'),

  /** `POST /api/board` — create an issue. */
  create: (input: NewBoardIssue): Promise<BoardIssue> =>
    boardRequest('/api/board', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** `PATCH /api/board/{id}` — partial update (move column, reorder, edit). */
  patch: (id: string, patch: BoardIssuePatch): Promise<BoardIssue> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /** `DELETE /api/board/{id}` — soft-delete. */
  remove: (id: string): Promise<{ ok: boolean; deleted: string }> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** `POST /api/board/{id}/claim` — the ATOMIC claim (§3.2.10). Throws a
   *  `BoardError` with `status === 409` when the race is lost / the issue is
   *  not a claimable agent task. */
  claim: (id: string, session: string): Promise<BoardIssue> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}/claim`, {
      method: 'POST',
      body: JSON.stringify({ session }),
    }),

  /** `POST /api/board/clear-done` — soft-delete every `done` issue. */
  clearDone: (): Promise<{ ok: boolean; remaining: number }> =>
    boardRequest('/api/board/clear-done', { method: 'POST' }),

  /** `POST /api/board/statuses` — add a custom column. */
  createStatus: (label: string): Promise<BoardStatus> =>
    boardRequest('/api/board/statuses', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),

  /** `PATCH /api/board/statuses/{id}` — rename a column. */
  renameStatus: (id: string, label: string): Promise<{ ok: boolean }> =>
    boardRequest(`/api/board/statuses/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    }),

  /** `DELETE /api/board/statuses/{id}` — remove a custom column (409 on builtin). */
  deleteStatus: (id: string): Promise<{ ok: boolean }> =>
    boardRequest(`/api/board/statuses/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  /** `PUT /api/board/statuses/reorder` — set the column display order. */
  reorderStatuses: (order: string[]): Promise<{ ok: boolean }> =>
    boardRequest('/api/board/statuses/reorder', {
      method: 'PUT',
      body: JSON.stringify({ order }),
    }),
}

/** A live session as the M2/M3 `/api/sessions` endpoint lists it. Only the
 *  fields the board's session-combo needs are typed. */
export interface BoardSession {
  name: string
  status: string
}

/** Fetch live sessions for the NewIssueDialog combo. Hits `/api/sessions`
 *  directly (the typed `api.listSessions` is filled in by M12); returns `[]` on
 *  any failure so the dialog degrades to "unassigned" rather than crashing. */
export async function listBoardSessions(): Promise<BoardSession[]> {
  try {
    const body = await boardRequest<unknown>('/api/sessions')
    const arr = Array.isArray(body)
      ? body
      : ((body as { data?: unknown })?.data ?? [])
    if (!Array.isArray(arr)) return []
    return arr
      .map((s) => s as Record<string, unknown>)
      .filter((s) => typeof s.name === 'string')
      .map((s) => ({
        name: String(s.name),
        status: typeof s.status === 'string' ? s.status : 'idle',
      }))
  } catch {
    return []
  }
}

// Boards (AT-C, plan §5.5) — the multi-board client. The single Kanban board
// became MULTIPLE boards selectable via a switcher; this module lists boards and
// loads a single board's cards (or the cross-board "All" aggregate).
//
// Reuses the same `{ ok, data }` envelope + `BoardError` as the issues client
// (board.ts), so 404 (stale board selection) / 409 (main is fixed) / 400 surface
// cleanly without crashing.

import { apiToken, apiUrl } from './client'
import { BoardError, type BoardIssue } from './board'

/** The fixed user board's id (seeded by migration 0015). Non-deletable /
 *  non-renameable — the API 409s those for it. */
export const MAIN_BOARD_ID = 'main'

/** The synthetic id for the switcher's "All" overview. NOT a real board row —
 *  the cards endpoint special-cases it to a read-through across every board. */
export const ALL_BOARD_ID = 'all'

/** A board row (server/src/db/boards.rs `Board`). */
export interface Board {
  id: string
  name: string
  /** `'main'` (the fixed user board) or `'team'` (one per Claude Code team). */
  kind: 'main' | 'team'
  /** The on-disk team id for a `kind='team'` board; `null` for main. */
  team_name: string | null
  created_at: number
  position: number
}

async function boardsRequest<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new BoardError('Can’t reach supermux-server.', 0)
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
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data
  }
  return body as T
}

export const boardsApi = {
  /** `GET /api/boards` — every board in switcher order (main pinned first). */
  list: (): Promise<Board[]> => boardsRequest('/api/boards'),

  /** `GET /api/boards/{id}/cards` — one board's cards. Pass {@link ALL_BOARD_ID}
   *  for the cross-board aggregate (each card carries its `board_id`). */
  cards: (boardId: string): Promise<BoardIssue[]> =>
    boardsRequest(`/api/boards/${encodeURIComponent(boardId)}/cards`),

  /** `POST /api/boards` — create a team/custom board. The fixed `main` board is
   *  seeded server-side and can't be created here. */
  create: (input: {
    name: string
    kind?: 'team'
    team_name?: string | null
  }): Promise<Board> =>
    boardsRequest('/api/boards', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** `POST /api/boards/register-team` — idempotent UPSERT of a team's board (the
   *  AT-D/AT-F3 entry point). Returns the existing board for `team_name` or a new
   *  one. Safe to call on every team-detect tick. */
  registerTeam: (team_name: string, name?: string): Promise<Board> =>
    boardsRequest('/api/boards/register-team', {
      method: 'POST',
      body: JSON.stringify({ team_name, name }),
    }),

  /** `PATCH /api/boards/{id}` — rename a board (409 for the Main board). */
  rename: (id: string, name: string): Promise<Board> =>
    boardsRequest(`/api/boards/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  /** `DELETE /api/boards/{id}` — delete a board + CASCADE its cards (409 for the
   *  Main board). */
  remove: (id: string): Promise<{ ok: boolean; deleted: string }> =>
    boardsRequest(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

// NB: `BoardError` is re-exported from `./board` (the barrel surfaces it once);
// we import it here for `boardsRequest` but don't re-export to avoid a duplicate.

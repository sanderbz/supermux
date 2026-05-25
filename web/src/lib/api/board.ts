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

/** A comment on an issue (server/src/db/board.rs `IssueComment`). The `author`
 *  is `'user'` (human via bearer), `'agent:<session>'` (agent via hook), or
 *  `'human:<name>'`. */
export interface IssueComment {
  id: number
  issue_id: string
  author: string
  body: string
  created: number
}

/** An acceptance-checklist item (server/src/db/board.rs `AcceptanceItem`).
 *  `done` is a 0/1 integer (mirrors the board's SQLite booleans). */
export interface AcceptanceItem {
  id: number
  issue_id: string
  body: string
  done: number
  pos: number
}

/** A PR/commit ref attached to an issue (server/src/db/board.rs `IssueLink`).
 *  Note the JSON key is `ref` (not `r#ref`). */
export interface IssueLink {
  id: number
  issue_id: string
  kind: 'pr' | 'commit'
  ref: string
  label: string
  created: number
}

/** An issue exactly as M6's `IssueView` serialises it (server/src/board/mod.rs).
 *  The `comments`/`acceptance`/`links` relations (S1/S2) are always present —
 *  empty arrays when the issue has none — so the card + sheet render with no
 *  extra round-trips. */
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
  comments: IssueComment[]
  acceptance: AcceptanceItem[]
  links: IssueLink[]
  /** R1 session→board reaction flags (migration 0011). `needs_review` is set
   *  when the owning agent finished its turn (went idle) and a human should
   *  look; `awaiting_input` is set when the agent has been sitting in `waiting`
   *  (it needs you). Always present (default false). The card badges off these. */
  needs_review: boolean
  awaiting_input: boolean
  /** R2 computed link-liveness. True when `session` points to a session row that
   *  exists AND is not archived; false when unassigned, archived, or deleted. A
   *  card with `session !== null` but `session_live === false` shows
   *  "session archived — reassign?" instead of a confidently-wrong live dot. */
  session_live: boolean
  /** BM1 (§4): the latest "needs your input" question the agent posted via the
   *  `needs-input` hook — surfaced on the amber Doing card so the human sees what
   *  the agent is asking without opening the session. `null`/absent when the card
   *  isn't awaiting input or the backend hasn't shipped the field yet (the card
   *  then falls back to the most recent agent comment). */
  latest_question?: string | null
}

/** The claim response (S3): the full issue PLUS the dispatch outcome. When
 *  `delivered` is true the work was auto-sent to the agent and `steer_id` holds
 *  the steering-queue row id — pass it to `boardApi.unsend(session, steer_id)`
 *  to power the Undo toast (retracts a still-undelivered steer). */
export interface ClaimResult {
  issue: BoardIssue
  delivered: boolean
  steer_id: number | null
}

/** Spawn options for the unified Start-agent action (BR1). When passed to
 *  {@link boardApi.start} (and no `session` is given) the server creates a NEW
 *  session for the issue — name auto-derived from the issue title/id — then boots
 *  it before claiming + delivering. `dir` empty/omitted defaults to home. */
export interface StartSpawn {
  dir?: string
  provider?: string
  worktree?: boolean
}

/** A board column (server/src/db/board.rs `BoardStatus`). */
export interface BoardStatus {
  id: string
  label: string
  position: number
  is_builtin: number
}

/** Fields the description-first composer can set (BM2 §2.1 / §4). `description`
 *  is the only required field; everything else lives behind "More". `owner_type`
 *  is gone — the server always treats cards as agent tasks now (§4). `acceptance`
 *  is one criterion per line (the server splits + creates the checklist items).
 *  `session: null`/omitted = unassigned (a new session is spawned on Start). */
export interface NewBoardIssue {
  /** The required, description-first field. */
  description: string
  title?: string
  status?: string
  session?: string | null
  due?: string | null
  due_time?: string | null
  tags?: string[]
  /** Acceptance criteria, one per line (the server creates the checklist). */
  acceptance?: string[]
}

/** A partial patch. Only the keys present are written (M6 PATCH semantics).
 *  `owner_type` is intentionally absent — BM2 drops the human/agent distinction
 *  (every card is an agent task). */
export interface BoardIssuePatch {
  title?: string
  desc?: string
  status?: string
  session?: string | null
  due?: string | null
  due_time?: string | null
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

  /** `POST /api/board` — create an issue (BM2 §4: description-first, no
   *  `owner_type`; the server always treats it as an agent task). The body maps
   *  the composer fields straight to the frozen contract
   *  `{ description, title?, session?, tags?, acceptance?, due? }`. */
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

  /** `POST /api/board/{id}/claim` — the ATOMIC claim (§3.2.10) that ALSO
   *  auto-sends the work to the agent (S3). `deliver` defaults to true (the
   *  user-chosen default); pass `false` for "Claim only" (flip the link without
   *  dispatching). Returns `{ issue, delivered, steer_id }` — use `steer_id`
   *  with {@link boardApi.unsend} for the Undo toast. Throws a `BoardError` with
   *  `status === 409` when the race is lost / the issue is not a claimable agent
   *  task. */
  claim: (
    id: string,
    session: string,
    deliver = true,
  ): Promise<ClaimResult> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}/claim`, {
      method: 'POST',
      body: JSON.stringify({ session, deliver }),
    }),

  /** `POST /api/board/{id}/start` — the unified "Start agent" action (BR1). Makes
   *  the issue agent-owned, attaches an existing live `session` OR spawns a NEW
   *  one (pass `spawn`), then atomic-claims + delivers the work via the same
   *  steering path as {@link boardApi.claim}. Returns `{ issue, delivered,
   *  steer_id }` — `steer_id` drives the Undo via {@link boardApi.unsend}. Throws
   *  a `BoardError` (`status === 409`) when another session is already working it,
   *  400 when neither `session` nor `spawn` is given. `claim` stays available for
   *  back-compat but the UI starts agents through this. */
  start: (
    id: string,
    opts: { session?: string; spawn?: StartSpawn },
  ): Promise<ClaimResult> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  /** `POST /api/board/{id}/reply` — THE headline UX (BM2 §2.4 / §4). Delivers
   *  `text` straight into the card's linked session (`send_text` + Enter,
   *  auto-waking a stopped session). Clears the card's `awaiting_input` state so
   *  the amber "Needs your input" badge resolves. 400 when the card has no linked
   *  live session. Returns `{ ok: true }`. */
  reply: (id: string, text: string): Promise<{ ok: boolean }> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  /** `POST /api/board/{id}/discard` — soft-archive a card (BM2 §2.6 / §4). Data
   *  is preserved; the board list excludes discarded cards by default. Pair with
   *  {@link boardApi.restore} for the undo toast. Returns ok. */
  discard: (id: string): Promise<{ ok: boolean }> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}/discard`, {
      method: 'POST',
    }),

  /** `POST /api/board/{id}/restore` — un-discard a card (BM2 §2.6). Powers the
   *  "Undo" on the discard toast, bringing the card back to the board. */
  restore: (id: string): Promise<{ ok: boolean }> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
    }),

  /** Undo a just-claimed auto-send: retract the enqueued steer before the agent
   *  receives it. `DELETE /api/sessions/{session}/steer` with the `steer_id`
   *  returned by {@link boardApi.claim}. No-op (0 cleared) if the agent already
   *  consumed it. */
  unsend: (
    session: string,
    steerId: number,
  ): Promise<{ ok: boolean; cleared: number }> =>
    boardRequest(`/api/sessions/${encodeURIComponent(session)}/steer`, {
      method: 'DELETE',
      body: JSON.stringify({ id: steerId }),
    }),

  /** Steer a board comment into the linked session as a mid-task nudge (the
   *  detail sheet's "notify agent" toggle). `POST /api/sessions/{session}/steer`
   *  with the comment prefixed so the agent reads it as a board note. Reuses the
   *  session steer endpoint; the caller treats a failure as non-fatal. */
  nudge: (session: string, body: string): Promise<unknown> =>
    boardRequest(`/api/sessions/${encodeURIComponent(session)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ text: `Board note: ${body}` }),
    }),

  // ── activity stream + acceptance + links (human side, bearer; AB2) ──────────
  // Every mutation returns the refreshed BoardIssue (with relations) and also
  // re-publishes the board over SSE, so the optimistic update is confirmed.

  /** `POST /api/board/{id}/comment` — post a human comment (author `'user'`). */
  comment: (id: string, body: string): Promise<BoardIssue> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),

  /** `POST /api/board/{id}/acceptance` — add an acceptance item (appended). */
  addAcceptance: (id: string, body: string): Promise<BoardIssue> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}/acceptance`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),

  /** `PATCH /api/board/{id}/acceptance/{itemId}` — edit body and/or toggle done. */
  patchAcceptance: (
    id: string,
    itemId: number,
    patch: { body?: string; done?: boolean },
  ): Promise<BoardIssue> =>
    boardRequest(
      `/api/board/${encodeURIComponent(id)}/acceptance/${itemId}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),

  /** `DELETE /api/board/{id}/acceptance/{itemId}` — remove an acceptance item. */
  removeAcceptance: (id: string, itemId: number): Promise<BoardIssue> =>
    boardRequest(
      `/api/board/${encodeURIComponent(id)}/acceptance/${itemId}`,
      { method: 'DELETE' },
    ),

  /** `PUT /api/board/{id}/acceptance/reorder` — set the checklist order. */
  reorderAcceptance: (id: string, order: number[]): Promise<BoardIssue> =>
    boardRequest(
      `/api/board/${encodeURIComponent(id)}/acceptance/reorder`,
      { method: 'PUT', body: JSON.stringify({ order }) },
    ),

  /** `POST /api/board/{id}/link` — attach a PR/commit ref. */
  addLink: (
    id: string,
    link: { kind: 'pr' | 'commit'; ref: string; label?: string },
  ): Promise<BoardIssue> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}/link`, {
      method: 'POST',
      body: JSON.stringify(link),
    }),

  /** `DELETE /api/board/{id}/link/{linkId}` — remove a PR/commit ref. */
  removeLink: (id: string, linkId: number): Promise<BoardIssue> =>
    boardRequest(`/api/board/${encodeURIComponent(id)}/link/${linkId}`, {
      method: 'DELETE',
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

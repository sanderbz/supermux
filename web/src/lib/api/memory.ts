// Bot-memory client — the ARCHIVAL (learned-notes) surface.
//
// The CORE notes (`sessions.memory`, the capped always-injected set) already
// round-trip via the session-config PATCH. This module reads the ARCHIVAL store:
// the plain-Markdown notes the bot writes itself with the `supermux-memory` CLI
// and recalls a handful of per turn. Server side is `sessions::memory`.
//
// READ-ONLY by design. The bot writes its own notes; the owner browses them.
// There is deliberately no create/edit/delete route to call.
//
// Two tiers are unioned server-side exactly as recall unions them — the bot's
// private `bot` tier and its role's shared `role` tier, private winning a slug
// collision — and `searchNotes` ranks with the very scorer the recall hook uses,
// so what this panel shows IS what the bot would recall.

import { settingsRequest, ApiError } from './client'

/** Note types (mirror the store's `NoteType`). */
export type NoteType = 'reference' | 'feedback' | 'decision' | 'bugfix' | string

/** Which tier a note lives in: private to this bot, or shared across its role. */
export type NoteTier = 'bot' | 'role'

/** One row of the browsable list — enough to render without fetching the body. */
export interface LearnedNote {
  /** Filename stem; the id `getNote` takes. */
  slug: string
  /** The one-line gist (frontmatter `description`) — the note's headline. */
  description: string
  tier: NoteTier
  note_type: NoteType
  /** RFC3339; empty on a hand-authored note that omitted the stamp. */
  modified: string
  /** Whitespace-collapsed first ~200 chars of the body. */
  snippet: string
  /** Recall score — search results only. */
  score?: number
}

/** One note in full, for the expanded read view. */
export interface LearnedNoteDetail {
  slug: string
  description: string
  tier: NoteTier
  note_type: NoteType
  modified: string
  /** Raw Markdown (Why / How-to-apply / `[[links]]`). */
  body: string
}

export interface NotesResponse {
  notes: LearnedNote[]
  bot_count: number
  role_count: number
  /** The role key whose shared tier was unioned in; empty for a private-only bot. */
  role: string
}

const EMPTY: NotesResponse = { notes: [], bot_count: 0, role_count: 0, role: '' }

/** A `404` here means "this session is not a bot" (no role, no core notes, no
 *  store) — an empty archive, not a broken call. A bot that simply hasn't
 *  written anything yet answers `200` with an empty list. Either way the panel
 *  shows its empty state; anything else is a real error and propagates. */
function emptyOn404(e: unknown): NotesResponse {
  if (e instanceof ApiError && e.status === 404) return EMPTY
  throw e
}

const base = (name: string) => `/api/sessions/${encodeURIComponent(name)}/memory`

/** `GET /api/sessions/{name}/memory/notes` — every note this bot can see
 *  (private ∪ role), freshest first. */
export async function listNotes(name: string): Promise<NotesResponse> {
  try {
    return await settingsRequest<NotesResponse>(`${base(name)}/notes`)
  } catch (e) {
    return emptyOn404(e)
  }
}

/** `GET /api/sessions/{name}/memory/search?q=` — the recall scorer's ranking.
 *  An empty `q` returns the freshness baseline rather than nothing. */
export async function searchNotes(
  name: string,
  q: string,
  limit?: number,
): Promise<NotesResponse> {
  const params = new URLSearchParams({ q })
  if (limit) params.set('limit', String(limit))
  try {
    return await settingsRequest<NotesResponse>(`${base(name)}/search?${params}`)
  } catch (e) {
    return emptyOn404(e)
  }
}

/** `GET /api/sessions/{name}/memory/notes/{slug}` — one note's full Markdown.
 *  `tier` pins which copy to read; omitted, the private one wins. */
export async function getNote(
  name: string,
  slug: string,
  tier?: NoteTier,
): Promise<LearnedNoteDetail> {
  const qs = tier ? `?tier=${tier}` : ''
  return settingsRequest<LearnedNoteDetail>(
    `${base(name)}/notes/${encodeURIComponent(slug)}${qs}`,
  )
}

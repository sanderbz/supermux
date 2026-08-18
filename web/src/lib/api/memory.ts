// Bot-memory client — the ARCHIVAL (learned-notes) surface.
//
// The CORE notes (`sessions.memory`, the capped always-injected set) already
// round-trip via the session-config PATCH. This module reads the ARCHIVAL store —
// the per-bot ∪ per-role notes the bot writes as it works, today reachable only
// via the `supermux-memory` CLI + recall hook.
//
// BLOCKED ON BACKEND: the memory HTTP routes are the one missing server piece.
// Until they land, `listNotes` / `searchNotes` resolve to an empty list on a
// 404/501 (the panel degrades to an honest empty state, never a crash) — see
// `MEMORY_ROUTES_LIVE`.

import { settingsRequest, ApiError } from './client'

/** Note types (mirror the memory model's `NoteType`). */
export type NoteType = 'reference' | 'feedback' | 'decision' | 'bugfix' | string

/** Scope of a learned note: private to the bot, or shared across a role. */
export type NoteScope =
  | { kind: 'bot' }
  | { kind: 'role'; role: string }

export interface LearnedNote {
  id: string
  type: NoteType
  /** Short title / the note's headline. */
  title: string
  /** The note body (a snippet is shown; full on expand). */
  body?: string
  scope: NoteScope
  /** Epoch seconds. */
  created_at: number
}

interface NotesResponse {
  notes: LearnedNote[]
}

/** Whether the archival routes appear to be live. Flipped to false the first
 *  time a call 404/501s, so the panel can render its honest "not wired yet"
 *  state without re-hammering a missing endpoint. */
export let MEMORY_ROUTES_LIVE = true

function degrade(e: unknown): LearnedNote[] {
  if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
    MEMORY_ROUTES_LIVE = false
    return []
  }
  throw e
}

/** `GET /api/sessions/{name}/memory/notes` — the bot's learned notes (own +
 *  role). Degrades to `[]` until the routes exist. */
export async function listNotes(name: string): Promise<LearnedNote[]> {
  try {
    const r = await settingsRequest<NotesResponse>(
      `/api/sessions/${encodeURIComponent(name)}/memory/notes`,
    )
    return r.notes ?? []
  } catch (e) {
    return degrade(e)
  }
}

/** `GET /api/sessions/{name}/memory/notes?q=` — lexical search over the store. */
export async function searchNotes(name: string, q: string): Promise<LearnedNote[]> {
  try {
    const r = await settingsRequest<NotesResponse>(
      `/api/sessions/${encodeURIComponent(name)}/memory/notes?q=${encodeURIComponent(q)}`,
    )
    return r.notes ?? []
  } catch (e) {
    return degrade(e)
  }
}

/** `DELETE /api/sessions/{name}/memory/notes/{id}` — forget one note. */
export async function deleteNote(name: string, id: string): Promise<void> {
  await settingsRequest(
    `/api/sessions/${encodeURIComponent(name)}/memory/notes/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}

// The harness-event feed — `GET /api/sessions/{name}/events`.
//
// The transcript's management log is sourced HERE and not from SSE: SSE has no
// replay, so anything rendered only from a live frame vanishes on reload. The
// server reads `audit_log` (the ledger that already records every delegation,
// rename and schedule fire) and returns the rows where this session is the
// SUBJECT, oldest first, cursor-paged by `since_id`. The `harness` SSE frame is
// the invalidation tick for this query and nothing more.
//
// One parse, one place: `AuditEntry.detail` is a JSON *string* on the wire (it
// is a TEXT column, and the server serialises the row as it stands). Every
// consumer wants the object, so it is parsed once, here, and a row whose detail
// is not an object degrades to `{}` rather than throwing a whole feed away.

import { apiToken, apiUrl } from './client'

/**
 * The `detail` blob, as far as anything renders it.
 *
 * Deliberately partial and all-optional: `detail` is free-form JSON written by
 * whichever handler logged the row, and the client must never assume a key that
 * a pre-existing row (logged before the key existed) cannot have. Unknown keys
 * survive the parse untouched.
 */
export interface HarnessDetail {
  /** `session.delegate`: the sender's slug. `session.rename`: the old name. */
  from?: string
  /** `session.rename`: the new name. */
  to?: string
  /** `schedule.create` / `schedule.run`: the session the schedule belongs to. */
  session?: string
  /** `schedule.create` / `schedule.run`: the schedule's title. */
  title?: string
  /** `schedule.run`: `"ok"` or a failure word. */
  status?: string
  [key: string]: unknown
}

/** One `audit_log` row, with its detail already parsed. */
export interface HarnessEvent {
  id: number
  /** Epoch SECONDS (`Utc::now().timestamp()`) — the same unit as `ChatItem.ts`. */
  ts: number
  actor: string
  action: string
  target: string
  detail: HarnessDetail
}

/** The wire shape: `detail` is still a string here. */
interface WireEntry {
  id: number
  ts: number
  actor: string
  action: string
  target: string
  detail: string
}

/** Server ceiling on one page (`sessions/mod.rs::events_handler`). */
export const EVENTS_MAX = 200

function parseDetail(raw: string | undefined): HarnessDetail {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as HarnessDetail)
      : {}
  } catch {
    return {}
  }
}

async function harnessReq<T>(path: string): Promise<T> {
  const headers = new Headers()
  const token = apiToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(apiUrl(path), { headers })
  const body = (await res.json()) as { ok?: boolean; data?: T; error?: string }
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.error ?? res.statusText)
  }
  return (body?.data ?? (body as unknown as T)) as T
}

export const harnessApi = {
  /**
   * This session's harness events, oldest first. `sinceId` is EXCLUSIVE, so
   * `0` is "from the beginning" and the last id of a page is the cursor for the
   * next one.
   */
  events: async (
    name: string,
    sinceId = 0,
    limit = 100,
  ): Promise<HarnessEvent[]> => {
    const params = new URLSearchParams()
    if (sinceId > 0) params.set('since_id', String(sinceId))
    params.set('limit', String(Math.min(Math.max(1, limit), EVENTS_MAX)))
    const body = await harnessReq<{ events?: WireEntry[] }>(
      `/api/sessions/${encodeURIComponent(name)}/events?${params.toString()}`,
    )
    const rows = Array.isArray(body?.events) ? body.events : []
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      actor: row.actor,
      action: row.action,
      target: row.target,
      detail: parseDetail(row.detail),
    }))
  },
}

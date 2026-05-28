// Scheduler (M21) — real client for the M8 backend (cron / boot / send / shell
// jobs, idempotent fires, run history, preview, test-fire).
//
// Envelope: M8 success bodies are wrapped (`{ ok:true, data }`); errors use
// `{ ok:false, error }` (§3.4). `schedRequest` unwraps `data` on success and
// lifts `error` on a non-2xx so the UI surfaces parse failures (400
// "invalid time …") gracefully — never a crash.
//
// The `Schedule`/`CreateScheduleInput` stub types pre-date the M8 contract and
// are intentionally left untouched; the types below mirror what M8 returns
// (server/src/db/schedules.rs::Schedule, schedule_runs).

import { apiToken, apiUrl } from './client'

// ── M0 stub domain types (legacy skeleton) ────────────────────────────────────

export interface Schedule {
  id: string
  name: string
  cron: string
  next_run?: string
  enabled: boolean
}

export interface CreateScheduleInput {
  name: string
  /** Free-text or cron expression; the backend parses it (§3.8). */
  when: string
  command: string
}

// ── M8 wire types ─────────────────────────────────────────────────────────────

/** Job kinds (server/src/scheduler/mod.rs::create validates these three). */
export type ScheduleKind = 'boot' | 'tmux' | 'shell'

/** A row of the `schedules` table (mirrors db::schedules::Schedule). */
export interface ScheduleRow {
  id: string
  title: string
  session: string
  command: string
  /** Optional free-text prompt sent right after `command` (0014). */
  prompt: string
  kind: ScheduleKind
  boot_dir: string
  boot_provider: string
  boot_worktree: number
  sched_type: string
  recurrence: string | null
  run_at: string | null
  next_run: string | null
  last_run: string | null
  enabled: number
  run_count: number
  schedule_expr: string | null
  watch: number
  watch_timeout: number
  done_pattern: string | null
  done_action: string
  /** Agent-confirmed finish (tmux only): the runner appends a completion-call
   *  footer so the agent signals done itself. 0/1. */
  confirm_finish: number
  created: number
  updated: number
  deleted: number | null
}

/** A row of `schedule_runs` — the per-fire ledger (idempotency-gated). */
export interface ScheduleRunRow {
  id: number
  schedule_id: string
  ran_at: number
  status: string
  note: string
}

/** Create / test-fire payload. Field set matches CreateScheduleInput on M8. */
export interface ScheduleCreateInput {
  title: string
  command: string
  /** Optional free-text prompt sent after the command (≥1 of the two required). */
  prompt?: string
  kind: ScheduleKind
  schedule_expr: string
  session?: string
  boot_dir?: string
  boot_provider?: string
  boot_worktree?: boolean
  watch?: boolean
  watch_timeout?: number
  done_pattern?: string
  done_action?: string
  /** tmux + notify only: ask the agent to confirm completion (most reliable). */
  confirm_finish?: boolean
}

/** PATCH payload — every field optional; unset fields stay untouched server-side. */
export interface SchedulePatchInput {
  title?: string
  session?: string
  command?: string
  prompt?: string
  kind?: ScheduleKind
  enabled?: boolean
  watch?: boolean
  watch_timeout?: number
  done_pattern?: string
  done_action?: string
  confirm_finish?: boolean
  schedule_expr?: string
}

/** Test-fire result: the single run's terminal status + note. */
export interface TestFireResult {
  status: string
  note: string
}

/** One REAL installed agent command for the recipe / command picker
 *  (server registry::InstalledCommand). `source` distinguishes the user's skills,
 *  user/managed commands, and claude.ai MCP connectors. Built-ins are excluded. */
export interface RecipeCommand {
  cmd: string
  desc: string
  source: 'skill' | 'command' | 'mcp'
}

/** A scheduler request that failed; carries the HTTP status so callers can
 *  branch on 400 (bad expression) vs 0 (unreachable) vs 404. */
export class SchedError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'SchedError'
    this.status = status
  }
}

async function schedRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const token = apiToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')
  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers })
  } catch {
    throw new SchedError('Can’t reach supermux-server.', 0)
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
    throw new SchedError(message, res.status)
  }
  // M8 wraps success bodies in `{ ok, data }`; unwrap to `data`.
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data
  }
  return body as T
}

export const schedulerApi = {
  /** `GET /api/schedules` — all non-deleted schedules, newest first. */
  list: (): Promise<ScheduleRow[]> => schedRequest('/api/schedules'),

  /** `GET /api/schedules/{id}/runs` — last 20 runs for one schedule. */
  runs: (id: string): Promise<ScheduleRunRow[]> =>
    schedRequest(`/api/schedules/${encodeURIComponent(id)}/runs`),

  /** `POST /api/schedules` — create a live schedule (computes first next_run). */
  create: (input: ScheduleCreateInput): Promise<ScheduleRow> =>
    schedRequest('/api/schedules', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** `POST /api/schedules` with `_test_fire` — run once now, return result, no
   *  live schedule left behind. */
  testFire: (input: ScheduleCreateInput): Promise<TestFireResult> =>
    schedRequest('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({ ...input, _test_fire: true }),
    }),

  /** `GET /api/schedules/commands` — the REAL installed agent commands (skills +
   *  user/managed commands + claude.ai MCP connectors) for the recipe / command
   *  picker. Built-in Claude slash commands are deliberately excluded. */
  commands: (): Promise<RecipeCommand[]> => schedRequest('/api/schedules/commands'),

  /** `POST /api/schedules/preview` — parse `expression`, get next ≤5 fire times
   *  (no persistence). Powers the next-5-runs live preview. */
  preview: (expression: string): Promise<{ next_runs: string[] }> =>
    schedRequest('/api/schedules/preview', {
      method: 'POST',
      body: JSON.stringify({ expression }),
    }),

  /** `PATCH /api/schedules/{id}` — inline edit + enable/disable toggle. */
  patch: (id: string, patch: SchedulePatchInput): Promise<ScheduleRow> =>
    schedRequest(`/api/schedules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /** `POST /api/schedules/{id}/run` — fire now (202; cadence untouched). */
  runNow: (id: string): Promise<{ ran: boolean }> =>
    schedRequest(`/api/schedules/${encodeURIComponent(id)}/run`, {
      method: 'POST',
    }),

  /** `DELETE /api/schedules/{id}` — soft-delete. */
  remove: (id: string): Promise<{ deleted: boolean }> =>
    schedRequest(`/api/schedules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
}

/** Resolve session names for the tmux-job target combo. Hits `/api/sessions`
 *  directly (the typed `api.listSessions` is filled in by M12); returns [] if
 *  unreachable so the dialog degrades to a free-text session field. */
export async function listSessionNames(): Promise<
  Array<{ name: string; display_name?: string }>
> {
  try {
    const body = await schedRequest<unknown>('/api/sessions')
    const arr = Array.isArray(body)
      ? body
      : ((body as { sessions?: unknown[] })?.sessions ?? [])
    const out: Array<{ name: string; display_name?: string }> = []
    for (const raw of arr as Array<Record<string, unknown>>) {
      const name = (raw.name ?? raw.id) as unknown
      if (typeof name !== 'string') continue
      out.push({
        name,
        display_name:
          typeof raw.display_name === 'string' ? raw.display_name : undefined,
      })
    }
    return out
  } catch {
    return []
  }
}

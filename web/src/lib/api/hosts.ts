// Hosts — typed client for the remote-host CRUD + bootstrap surface in
// `server/src/hosts/mod.rs`. Wire format mirrors the server's `HostView` /
// `CheckReport` / `BootstrapReport` exactly so the FE can render the
// onboarding checklist without re-shaping anything.
//
// The dashboard bearer token + base URL come from the shared `apiToken`/
// `apiUrl` accessors in ./client (window-resolved at call time) — no token is
// ever embedded here, no per-feature duplication of the fetch primitives. The
// `{ok, data}` envelope is unwrapped to T just like the sessions client does,
// and a typed `HostError` (carrying the HTTP status) lets the route branch on
// 409 (duplicate / active-session-still-references) vs 404 vs 0 (server down).
//
// IMPORTANT: this module is ADDITIVE — the backend types are read-only here.
// We do NOT mutate server-side state on import; all calls are on-demand from
// the new /hosts route or the host-picker in the new-session sheet.

import { apiToken, apiUrl } from './client'

/** Reachability state mirrored from the server's `hosts.status` column
 *  (CHECK constraint enforces these three literals). */
export type HostStatus = 'unknown' | 'reachable' | 'unreachable'

/** One row from `GET /api/hosts` (server `HostView`). `id` is the FK referenced
 *  by `sessions.host_id`; `host_id = null` on a session means LOCAL.
 *
 *  `ssh_key_path` + `last_seen` are absent (not `null`) when the server's
 *  `skip_serializing_if = "Option::is_none"` fires — we model them as
 *  `string | null` / `number | null` so the FE can render "—" without
 *  juggling undefined-vs-null. */
export interface Host {
  id: number
  name: string
  ssh_target: string
  ssh_key_path: string | null
  status: HostStatus
  last_seen: number | null
  created_at: number
}

/** Input for `POST /api/hosts`. `ssh_key_path` is optional (the server falls
 *  back to `~/.ssh/config` + the user's ssh-agent when absent). */
export interface CreateHostInput {
  name: string
  ssh_target: string
  ssh_key_path?: string
}

/** Result of `POST /api/hosts/{id}/check` (server `CheckReport`). The server
 *  auto-fires this after `POST /api/hosts`, so a freshly-created row already
 *  carries a non-`unknown` status by the time the FE re-renders. */
export interface CheckResult {
  status: HostStatus
  last_seen?: number
  /** SSH stderr snippet on failure (omitted on success). */
  error?: string
}

/** Optional body for `POST /api/hosts/{id}/bootstrap`. When `public_key` is
 *  set, the server appends it to the remote `~/.ssh/authorized_keys`
 *  (deduplicated) and reports `authorized_key_added`. */
export interface BootstrapInput {
  public_key?: string
}

/** Result of `POST /api/hosts/{id}/bootstrap` (server `BootstrapReport`).
 *  Drives the onboarding checklist UI in the new-host flow. `warnings` is the
 *  human-readable bullet list shown under the checks. */
export interface BootstrapReport {
  tmux_installed: boolean
  tmux_version: string | null
  supermux_dir: string
  claude_installed: boolean
  authorized_key_added?: boolean
  warnings: string[]
}

/** A failed hosts request; carries the HTTP status so callers can branch on
 *  409 (duplicate / active-session-blocked-delete) vs 404 vs 0 (server down). */
export class HostError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'HostError'
    this.status = status
  }
}

async function hostReq<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new HostError('Can’t reach supermux-server.', 0)
  }
  // 204 No Content (DELETE) — no body to unwrap.
  if (res.status === 204) {
    if (!res.ok) throw new HostError(res.statusText, res.status)
    return undefined as T
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
    throw new HostError(message, res.status)
  }
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data
  }
  return body as T
}

/** Normalise a `HostView` into the FE-facing `Host` shape — fills the
 *  optional/skipped fields with `null` so the table never sees `undefined`. */
function asHost(raw: unknown): Host {
  const r = (raw ?? {}) as Partial<Host> & Record<string, unknown>
  return {
    id: Number(r.id ?? 0),
    name: String(r.name ?? ''),
    ssh_target: String(r.ssh_target ?? ''),
    ssh_key_path:
      typeof r.ssh_key_path === 'string' && r.ssh_key_path.length > 0
        ? r.ssh_key_path
        : null,
    status: (r.status as HostStatus) ?? 'unknown',
    last_seen:
      typeof r.last_seen === 'number' && Number.isFinite(r.last_seen)
        ? r.last_seen
        : null,
    created_at: Number(r.created_at ?? 0),
  }
}

export const hostsApi = {
  /** `GET /api/hosts` — list live (non-deleted) hosts. */
  list: async (): Promise<Host[]> => {
    const body = await hostReq<unknown>('/api/hosts')
    const arr = Array.isArray(body)
      ? body
      : ((body as { data?: unknown })?.data ?? [])
    return Array.isArray(arr) ? arr.map(asHost) : []
  },

  /** `POST /api/hosts` — create + auto-run a reachability check server-side
   *  (so the returned row already carries a fresh `status` + `last_seen`). */
  create: async (input: CreateHostInput): Promise<Host> => {
    const body = await hostReq<unknown>('/api/hosts', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return asHost(body)
  },

  /** `GET /api/hosts/{id}` — single row (404 on miss / tombstoned). */
  get: async (id: number): Promise<Host> => {
    const body = await hostReq<unknown>(`/api/hosts/${id}`)
    return asHost(body)
  },

  /** `DELETE /api/hosts/{id}` — soft-delete. 409 when an active session still
   *  references it; the route surfaces the message and lets the user stop the
   *  session first. */
  remove: (id: number): Promise<void> =>
    hostReq<void>(`/api/hosts/${id}`, { method: 'DELETE' }),

  /** `POST /api/hosts/{id}/check` — manual recheck (the create call already
   *  ran one auto-check; this is the "retry" button on a stale row). */
  check: (id: number): Promise<CheckResult> =>
    hostReq<CheckResult>(`/api/hosts/${id}/check`, { method: 'POST' }),

  /** `POST /api/hosts/{id}/bootstrap` — remote prerequisite probe. When
   *  `public_key` is set the server also appends it to the remote
   *  `~/.ssh/authorized_keys` (deduplicated) and reports it in `authorized_key_added`. */
  bootstrap: (id: number, input?: BootstrapInput): Promise<BootstrapReport> =>
    hostReq<BootstrapReport>(`/api/hosts/${id}/bootstrap`, {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    }),
}

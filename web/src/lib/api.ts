import { authToken, baseUrl } from '@/env'

// Typed API client — M0 SKELETON.
//
// Every endpoint from TECH_PLAN §3.4 has a typed method stub here. Bodies throw
// `not yet implemented`. Later frontend milestones FILL IN the bodies of the
// methods they need (M12 sessions, M14 send/key, M19 board, M20 files,
// M21 scheduler, M22 settings/snippets). Shipping the full skeleton in M0
// eliminates the 4-way merge conflict on this file that the dep-graph fix in
// TECH_PLAN §29 calls out.
//
// Implementation note for later milestones: replace `notImplemented(...)` with a
// `request()` helper that reads `authToken()` from `./../env` and sends
// `Authorization: Bearer <token>` against `baseUrl()`. The HTTP envelope is
// `{ ok, data?, error? }` (§3.4) — unwrap `data` on success, throw on `error`.

function notImplemented(method: string, ..._args: unknown[]): never {
  throw new Error(`api.${method}() — not yet implemented (M0 stub)`)
}

// ── Domain types (minimal; extended by later milestones) ──────────────────────

export type SessionStatus =
  | 'starting'
  | 'active'
  | 'idle'
  | 'waiting'
  | 'stopped'
  | 'error'

/** Per-tile summary. SSE `sessions` events use this same shape (deltas). §3.4 */
export interface SessionSummary {
  name: string
  status: SessionStatus
  dir: string
  provider: string
  /** Last 6 lines of `last_capture`, ANSI-stripped. §3.4 */
  preview_lines: string[]
  updated_at: string
}

export interface Session extends SessionSummary {
  created_at: string
  pid?: number
}

export interface CreateSessionInput {
  name: string
  dir: string
  provider?: string
  command?: string
}

export interface PeekResult {
  /** Static capture-pane snapshot (raw, may contain ANSI). */
  text: string
}

// ── Board ─────────────────────────────────────────────────────────────────────

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

// ── Scheduler ───────────────────────────────────────────────────────────────

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

// ── Files ──────────────────────────────────────────────────────────────────────

export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: string
}

export interface FileContent {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
}

// ── Snippets / keyboard groups ────────────────────────────────────────────────

export interface Snippet {
  id: string
  label: string
  command: string
}

export interface KbdGroup {
  id: string
  name: string
  keys: string[]
}

// ── Agents ──────────────────────────────────────────────────────────────────

export type AgentState = 'idle' | 'active' | 'waiting'

/** §3.7 — `{ reached, status }`. */
export interface WaitResult {
  reached: boolean
  status: SessionStatus
}

export interface DelegateInput {
  from: string
  to: string
  prompt: string
}

// ── Audit / health ──────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number
  at: string
  action: string
  detail?: string
}

export interface Health {
  version: string
  uptime_s: number
  db_ok: boolean
  tmux_ok: boolean
}

// ── Client ────────────────────────────────────────────────────────────────────

export const api = {
  // Sessions
  listSessions: (): Promise<SessionSummary[]> => notImplemented('listSessions'),
  getSession: (name: string): Promise<Session> =>
    notImplemented('getSession', name),
  createSession: (input: CreateSessionInput): Promise<Session> =>
    notImplemented('createSession', input),
  deleteSession: (name: string): Promise<void> =>
    notImplemented('deleteSession', name),
  startSession: (name: string): Promise<Session> =>
    notImplemented('startSession', name),
  stopSession: (name: string): Promise<void> =>
    notImplemented('stopSession', name),
  sendText: (name: string, text: string): Promise<void> =>
    notImplemented('sendText', name, text),
  sendKey: (name: string, key: string): Promise<void> =>
    notImplemented('sendKey', name, key),
  peek: (name: string): Promise<PeekResult> => notImplemented('peek', name),
  archive: (name: string): Promise<void> => notImplemented('archive', name),
  wake: (name: string): Promise<void> => notImplemented('wake', name),
  clone: (name: string): Promise<Session> => notImplemented('clone', name),
  duplicate: (name: string): Promise<Session> =>
    notImplemented('duplicate', name),

  // Board
  listBoard: (): Promise<Issue[]> => notImplemented('listBoard'),
  createIssue: (input: CreateIssueInput): Promise<Issue> =>
    notImplemented('createIssue', input),
  patchIssue: (id: string, patch: Partial<Issue>): Promise<Issue> =>
    notImplemented('patchIssue', id, patch),
  deleteIssue: (id: string): Promise<void> => notImplemented('deleteIssue', id),
  claimIssue: (id: string, sessionName: string): Promise<Issue> =>
    notImplemented('claimIssue', id, sessionName),

  // Scheduler
  listSchedules: (): Promise<Schedule[]> => notImplemented('listSchedules'),
  createSchedule: (input: CreateScheduleInput): Promise<Schedule> =>
    notImplemented('createSchedule', input),
  runSchedule: (id: string): Promise<void> => notImplemented('runSchedule', id),

  // Files
  listFiles: (name: string, path?: string): Promise<FileEntry[]> =>
    notImplemented('listFiles', name, path),
  getFile: (name: string, path: string): Promise<FileContent> =>
    notImplemented('getFile', name, path),
  putFile: (name: string, path: string, content: string): Promise<void> =>
    notImplemented('putFile', name, path, content),
  uploadFile: (name: string, path: string, file: File): Promise<void> =>
    notImplemented('uploadFile', name, path, file),

  // Snippets / keyboard groups
  listSnippets: (): Promise<Snippet[]> => notImplemented('listSnippets'),
  listKbdGroups: (): Promise<KbdGroup[]> => notImplemented('listKbdGroups'),

  // Agents
  waitAgent: (
    name: string,
    state: AgentState,
    timeout?: number,
  ): Promise<WaitResult> => notImplemented('waitAgent', name, state, timeout),
  delegate: (input: DelegateInput): Promise<void> =>
    notImplemented('delegate', input),

  // Audit / health
  listAuditLog: (limit?: number): Promise<AuditEntry[]> =>
    notImplemented('listAuditLog', limit),
  health: (): Promise<Health> => notImplemented('health'),
}

// ─────────────────────────────────────────────────────────────────────────────
// Files (M20) — real client for the M7 backend file browser/editor/uploader.
//
// APPENDED, self-contained block (TECH_PLAN §29 dep-graph fix): this milestone
// touches ONLY the bottom of api.ts so it never collides with the sibling
// frontend milestones (M19 board, M21 scheduler, M22 settings) that fill in the
// matching `api.*` stubs above. The `FileEntry`/`FileContent` stub types above
// pre-date the M7 contract and are intentionally left untouched; the types below
// match what M7 actually returns.
//
// Envelope: M7 success bodies are RAW JSON (`{ path, entries }`, …); only ERRORS
// use the `{ ok:false, error }` envelope (§3.4). `fsRequest` returns the parsed
// body directly and lifts `error` on a non-2xx so the UI can surface path-safety
// failures (403 "refusing to follow symlink", etc.) gracefully — never a crash.
// ─────────────────────────────────────────────────────────────────────────────

export interface FsEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  /** Unix epoch seconds (server `mtime`). */
  modified: number
}

export interface FsListing {
  path: string
  parent: string | null
  entries: FsEntry[]
}

/** Type-tagged read result, discriminated by the `is_*` flags M7 sets (§3.2). */
export type FileMeta =
  | { path: string; is_image: true; data_url: string; mime: string }
  | { path: string; is_pdf: true; data_url: string }
  | {
      path: string
      is_video: true
      mime: string
      size: number
      modified: number
    }
  | { path: string; is_audio: true; mime: string; size: number }
  | { path: string; is_binary: true; size: number; ext: string }
  | {
      path: string
      content: string
      is_markdown?: boolean
      is_csv?: boolean
      is_html?: boolean
      truncated?: boolean
    }

/** A request that failed; carries the HTTP status so callers can branch on 403
 *  (path-safety / symlink refusal) vs 404 vs 400 (too-large). */
export class FsError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'FsError'
    this.status = status
  }
}

// ════════════════════════════════════════════════════════════════════════════
// M22 — Settings client (ADDITIVE).
//
// Appended below the M0 `api` stub instead of filling its method bodies, so this
// milestone never collides with the sibling frontend milestones (M19/M20/M21)
// that fill in their own slices of the stub above. These are the real `fetch`
// implementations the settings route needs.
//
// Envelope: HTTP responses are `{ ok, data?, error? }` (§3.4). We unwrap `data`
// on success and throw `ApiError` (carrying the status code) otherwise — the
// settings hooks turn a 404/501 into a graceful "backend not wired yet" state
// rather than a crash, since the prefs/audit handlers land in a later backend
// milestone.
//
// The dashboard bearer token is read from `window._AMUX_AUTH_TOKEN` at call time
// (env.ts) and sent as `Authorization: Bearer …`. It is NEVER hard-coded here.
// ════════════════════════════════════════════════════════════════════════════

/** HTTP error that preserves the status code so callers can branch on 401/404. */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// Read runtime config off the `window._AMUX_*` globals (typed in env.ts). Kept
// local to this block so the append introduces NO new top-of-file import that
// could conflict with a sibling milestone's import edit.
function fsToken(): string {
  return window._AMUX_AUTH_TOKEN ?? ''
}
function fsApiUrl(path: string): string {
  const base = (window._AMUX_BASE_URL ?? import.meta.env.BASE_URL).replace(
    /\/$/,
    '',
  )
  return `${base}${path}`
}

async function fsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const token = fsToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  let res: Response
  try {
    res = await fetch(fsApiUrl(path), { ...init, headers })
  } catch {
    throw new FsError('Can’t reach amux-server.', 0)
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
    throw new FsError(message, res.status)
  }
  return body as T
}

export const filesApi = {
  /** `GET /api/ls` — directory listing (dirs first, then by name). */
  ls: (path: string, hidden = false): Promise<FsListing> =>
    fsRequest(
      `/api/ls?path=${encodeURIComponent(path)}${hidden ? '&hidden=1' : ''}`,
    ),

  /** `GET /api/file` — type-aware read. */
  readFile: (path: string): Promise<FileMeta> =>
    fsRequest(`/api/file?path=${encodeURIComponent(path)}`),

  /** `PUT /api/file` — write a whitelisted text file. */
  writeFile: (
    path: string,
    content: string,
  ): Promise<{ ok: boolean; path: string }> =>
    fsRequest('/api/file', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),

  /** `DELETE /api/fs/delete`. */
  deleteFile: (path: string): Promise<{ ok: boolean; deleted: string }> =>
    fsRequest('/api/fs/delete', {
      method: 'DELETE',
      body: JSON.stringify({ path }),
    }),

  /** `POST /api/fs/upload` — multipart upload of one or more files into `dir`. */
  uploadFiles: (
    dir: string,
    files: File[],
  ): Promise<{ saved: { name: string; size: number }[] }> => {
    const form = new FormData()
    form.append('dir', dir)
    for (const f of files) form.append('file', f, f.name)
    return fsRequest('/api/fs/upload', { method: 'POST', body: form })
  },

  /** Authenticated direct-GET URL for `<video>`/`<audio>` (Range-served by M7).
   *  Media elements cannot set an Authorization header, so this uses the
   *  `?_token=` fallback the auth layer accepts (server/src/auth.rs). The token
   *  is read from `window` at runtime — never embedded in source. */
  rawUrl: (path: string): string => {
    const token = fsToken()
    const q = `path=${encodeURIComponent(path)}${
      token ? `&_token=${encodeURIComponent(token)}` : ''
    }`
    return fsApiUrl(`/api/file/raw?${q}`)
  },
}

/** Resolve a session's working dir for the `/files/:name` root scope. Hits the
 *  M2/M3 sessions endpoint directly (the typed `api.getSession` is filled in by
 *  M12); returns null if it can't be resolved, so Files falls back to $HOME. */
export async function getSessionDir(name: string): Promise<string | null> {
  try {
    const body = await fsRequest<Record<string, unknown>>(
      `/api/sessions/${encodeURIComponent(name)}`,
    )
    const inner = body.data as Record<string, unknown> | undefined
    const dir = (body.dir ?? inner?.dir) as string | undefined
    return dir ?? null
  } catch {
    return null
  }
}

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: string
}

async function settingsRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = authToken()
  const res = await fetch(`${baseUrl().replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  // 204 / empty body — nothing to unwrap.
  if (res.status === 204) {
    if (!res.ok) throw new ApiError(res.status, res.statusText)
    return undefined as T
  }
  let env: Envelope<T> | null = null
  try {
    env = (await res.json()) as Envelope<T>
  } catch {
    /* non-JSON (e.g. an HTML 404 page) — fall through to the status check */
  }
  if (!res.ok) {
    throw new ApiError(res.status, env?.error ?? res.statusText)
  }
  if (env && env.ok === false) {
    throw new ApiError(res.status, env.error ?? 'request failed')
  }
  return (env?.data ?? (env as unknown as T)) as T
}

/** API-key settings — values arrive MASKED from the server (§1.8); never raw. */
export interface MaskedEnv {
  /** e.g. `sk-ant-…last4`, or `''` when unset. */
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
}

export interface DefaultModelInfo {
  model: string
}

export interface RegenerateTokenResult {
  token: string
}

export const settingsApi = {
  /** GET `/api/settings/env` — returns MASKED key previews (§1.8). */
  getEnv: (): Promise<MaskedEnv> => settingsRequest('/api/settings/env'),
  /** PATCH `/api/settings/env` — write `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. */
  patchEnv: (patch: MaskedEnv): Promise<MaskedEnv> =>
    settingsRequest('/api/settings/env', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** GET `/api/settings/default-model`. */
  getDefaultModel: (): Promise<DefaultModelInfo> =>
    settingsRequest('/api/settings/default-model'),
  /** PATCH `/api/settings/default-model` — `{ model }` → `CC_DEFAULT_FLAGS`. */
  patchDefaultModel: (model: string): Promise<DefaultModelInfo> =>
    settingsRequest('/api/settings/default-model', {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    }),
  /** GET `/api/audit?limit=N` — last N audit rows (§6.4). */
  getAudit: (limit = 200): Promise<AuditEntry[]> =>
    settingsRequest(`/api/audit?limit=${limit}`),
  /** GET `/api/snippets` — saved-command CRUD (§3.4). */
  listSnippets: (): Promise<Snippet[]> => settingsRequest('/api/snippets'),
  createSnippet: (input: Omit<Snippet, 'id'>): Promise<Snippet> =>
    settingsRequest('/api/snippets', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteSnippet: (id: string): Promise<void> =>
    settingsRequest(`/api/snippets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /** POST `/api/settings/regenerate-token` — rotate the dashboard bearer. */
  regenerateToken: (): Promise<RegenerateTokenResult> =>
    settingsRequest('/api/settings/regenerate-token', { method: 'POST' }),
}

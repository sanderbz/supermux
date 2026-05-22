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

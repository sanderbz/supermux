// Sessions (M12) — the real client for the M2 sessions CRUD + the §3.6 hero data
// flow (preview_lines off `last_capture`).
//
// This module ALSO carries the M0 legacy skeleton (`notImplemented` + the typed
// `api` stub object). The M0 `api` object aggregates one method per §3.4
// endpoint across every feature; it predates the per-feature clients below and
// is kept verbatim so the public surface is byte-for-byte identical. It imports
// the non-session stub domain types from their sibling feature modules.
//
// Envelope: M2 wraps success bodies in `{ ok:true, data }` and errors in
// `{ ok:false, error }` (§3.4). Some handlers return a bare array. `sessReq`
// unwraps `data` when present, tolerates a bare body, and lifts `error` into a
// typed `SessionError` (carrying the HTTP status) so the route can branch 409
// (duplicate name) vs 404 (gone) vs 0 (server unreachable) without crashing.
//
// The dashboard bearer token is read from `window._SUPERMUX_AUTH_TOKEN` at call time
// via the shared `apiToken`/`apiUrl` accessors in ./client — so the token is
// NEVER embedded here.

import { apiToken, apiUrl } from './client'
import type { Issue, CreateIssueInput } from './board'
import type { Schedule, CreateScheduleInput } from './scheduler'
import type { FileEntry, FileContent } from './files'
import type { Snippet, KbdGroup, AuditEntry } from './settings'

// ─────────────────────────────────────────────────────────────────────────────
// M0 legacy skeleton — typed stub `api` client (one method per §3.4 endpoint).
// Bodies throw `not yet implemented`; the real per-feature clients live below
// and in the sibling modules. Never imported by consumers, but exported to keep
// the public surface identical.
// ─────────────────────────────────────────────────────────────────────────────

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

/** The Claude Code permission MODE (mode-shift). Parsed from the persistent
 *  status bar server-side and surfaced as `ApiSession.mode`. Three are runtime-
 *  cyclable (Shift+Tab: `normal → accept_edits → plan`); `bypass` is launch-only
 *  and requires a clean relaunch. Matches the backend `Mode` snake_case wire. */
export type SessionMode = 'normal' | 'accept_edits' | 'plan' | 'bypass'

/** Per-tile summary. SSE `sessions` events use this same shape (deltas). §3.4 */
export interface SessionSummary {
  name: string
  status: SessionStatus
  dir: string
  provider: string
  /** Last 6 lines of `last_capture`, ANSI-stripped. §3.4 */
  preview_lines: string[]
  /** Same 6 lines with SGR escape sequences preserved — the colour-true tile
   *  preview source. Empty until the first capture; the UI falls back to
   *  `preview_lines` (plain text) when absent. */
  preview_ansi?: string[]
  /** Claude permission mode parsed from the status bar (mode-shift). Absent until
   *  the first capture; the ⋯ menu defaults the live-checked radio to `normal`. */
  mode?: SessionMode
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

// ── Health ────────────────────────────────────────────────────────────────────

export interface Health {
  version: string
  uptime_s: number
  db_ok: boolean
  tmux_ok: boolean
}

// ── Stub client ────────────────────────────────────────────────────────────────

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
// M12 — real sessions client.
// ─────────────────────────────────────────────────────────────────────────────

/** The fields the SSE `sessions` delta / the `GET /api/sessions` list carry for
 *  a tile. A superset of `SessionSummary` with the optional hero display fields
 *  (§3.6) the detector populates when it has them. Mirrors `TileSession` but
 *  lives here so the API layer owns the wire shape. */
export interface ApiSession {
  name: string
  status: SessionStatus
  dir: string
  provider: string
  /** Last 6 lines of `last_capture`, ANSI-stripped (§3.6). */
  preview_lines: string[]
  /** Same 6 lines with SGR escape sequences preserved — the colour-true tile
   *  preview source. Empty until the first capture; the UI falls back to
   *  `preview_lines` (plain) when absent. */
  preview_ansi?: string[]
  /** Claude permission mode parsed from the persistent status bar (mode-shift):
   *  `normal` / `accept_edits` / `plan` / `bypass`. Absent until the first
   *  capture. Arrives on both the `GET /api/sessions` list and the `sessions`
   *  SSE delta (the ⋯ mode menu live-checks the matching radio). */
  mode?: SessionMode
  updated_at?: string
  /** Claude Code chat title / auto-summary (falls back to `name` in the UI). */
  task_summary?: string
  /** Cumulative token count for the meta row. */
  tokens?: number
  /** Git branch / worktree for the meta row. */
  branch?: string
  /** Provider launch flags, verbatim (e.g. `--model opus`). The model lives
   *  here — there is no separate `model` field. Surfaced verbatim in the
   *  session info panel's Settings section. Sent by `GET /api/sessions`
   *  (SessionView.flags). */
  flags?: string
  /** MCP config the session was launched with (server `SessionView.mcp`). */
  mcp?: string
  /** True when the session runs in an isolated git worktree
   *  (server `SessionView.worktree`). */
  worktree?: boolean
  /** RFC3339 creation timestamp (server `SessionView.created_at`). */
  created_at?: string
  /** Who created the session (server `SessionView.creator`). */
  creator?: string
  /** Free-text description (searchable). */
  desc?: string
  /** Tags (searchable). */
  tags?: string[]
  /** Pin + activity drive the sort (feature-extract §1.2). */
  pinned?: boolean
  /** tmux session alive AND a child process exists. */
  running?: boolean
  /** Epoch seconds — last send / last started (feature-extract §1.2). */
  last_activity?: number
  /** True when the underlying tmux session is gone → tile renders `<TileError>`. */
  missing?: boolean
  /** Set to `true` by the `sessions` SSE delta that announces an archive (the
   *  backend flips `archived = 1` synchronously before broadcasting). The list
   *  endpoint already filters archived rows out, so this flag only appears on
   *  the delta — clients drop the row from their cached list when they see it. */
  archived?: boolean
  /** Live "current activity" line derived from the latest `PreToolUse` hook
   *  PAYLOAD (hooks-10x): a short emoji-prefixed label like `✎ tile.tsx` /
   *  `⚡ npm test`. In-memory only server-side (never persisted); present while
   *  the agent is mid-tool, cleared on `Stop`/`SessionEnd`. Arrives on both the
   *  `GET /api/sessions` list and the `sessions` SSE delta (Track 3 renders it
   *  under the status dot, falling back to the spinner when absent). */
  activity?: string
  /** Machine-readable class for `activity` (`bash`/`edit`/`read`/`search`/`web`/
   *  `task`/`mcp`/`tool`/`failed`) so the UI can style without re-parsing the
   *  emoji. Present iff `activity` is. */
  activity_kind?: string
  /** The latest unrecovered agent error from a `StopFailure` hook (hooks-10x):
   *  `{type, message}` (e.g. `rate_limit` / `billing_error`). In-memory only;
   *  cleared on the next `UserPromptSubmit`/`SessionStart`. Drives the amber
   *  error badge on the card (Track 3). */
  error?: { type: string; message: string }
}

/** A past Claude conversation for a session's working dir (feat-resume-picker).
 *  Surfaced by `GET /api/sessions/{name}/resumable`; picking one resumes it via
 *  `claude --resume <id>`. */
export interface ResumableConversation {
  /** Conversation UUID — the `claude --resume <id>` argument. */
  id: string
  /** Human title: latest `aiTitle`, else first user message, else a fallback. */
  summary: string
  /** RFC3339 last-activity timestamp (the transcript file's mtime). */
  updated_at: string
  /** Count of user + assistant messages (non-sidechain). */
  message_count: number
}

/** Result of `POST /api/sessions/{name}/mode` (mode-shift). `mode` is the mode
 *  ACTUALLY in effect after the op (the UI reflects truth, never an optimistic
 *  guess). `converged` is false when the Shift+Tab cycle couldn't reach the
 *  requested target within the retry cap; `relaunched` is true for the bypass
 *  enter/leave path (so the UI can confirm the session restarted). */
export interface SetModeResult {
  name: string
  mode: SessionMode
  converged: boolean
  relaunched: boolean
}

/** Body for `POST /api/sessions` (§5.1). `command` carries the initial prompt
 *  the Quick-start presets prefill; `worktree` requests an isolated git worktree. */
export interface NewSession {
  name: string
  dir: string
  provider?: 'claude' | 'shell'
  desc?: string
  worktree?: boolean
  command?: string
}

/** A failed sessions request; carries the HTTP status so callers can branch on
 *  409 (duplicate name) vs 404 vs 400 vs 0 (server unreachable). */
export class SessionError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'SessionError'
    this.status = status
  }
}

async function sessReq<T>(path: string, init?: RequestInit): Promise<T> {
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
    // Network down / server restarting. Status 0 lets the route show the
    // "Can't reach supermux-server. Retrying…" state (§4.12) instead of crashing.
    throw new SessionError('Can’t reach supermux-server.', 0)
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
    throw new SessionError(message, res.status)
  }
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data
  }
  return body as T
}

/** Normalise whatever the list endpoint returns into `ApiSession[]`. M2 returns
 *  `SessionSummary[]`; this defends against the envelope being `{ data:[…] }`. */
function asSessions(body: unknown): ApiSession[] {
  const arr = Array.isArray(body)
    ? body
    : ((body as { data?: unknown })?.data ?? [])
  if (!Array.isArray(arr)) return []
  return arr.filter(
    (s): s is ApiSession =>
      !!s && typeof (s as { name?: unknown }).name === 'string',
  )
}

export const sessionsApi = {
  /** `GET /api/sessions` — the tile list incl. `preview_lines` (§3.6). */
  list: async (): Promise<ApiSession[]> =>
    asSessions(await sessReq<unknown>('/api/sessions')),

  /** `GET /api/sessions/archived` — the archived (soft-deleted) rows for the
   *  Archived sheet. Mirror of `list` but on `WHERE archived = 1`, ordered
   *  most-recently-touched first. Each row carries `archived: true`. */
  listArchived: async (): Promise<ApiSession[]> =>
    asSessions(await sessReq<unknown>('/api/sessions/archived')),

  /** `POST /api/sessions` — create the row (§5.1). The route then sends the
   *  initial prompt via `start` if a `command` is set. */
  create: (input: NewSession): Promise<ApiSession> =>
    sessReq('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** `POST /api/sessions/{name}/start` — boot tmux + send the initial prompt. */
  start: (name: string, prompt?: string): Promise<unknown> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}/start`, {
      method: 'POST',
      body: JSON.stringify(prompt ? { prompt } : {}),
    }),

  /** `DELETE /api/sessions/{name}` — drop the session row from supermux (§3.4).
   *  Used by the M27 demo-replay flow to remove the one demo agent it booted. */
  remove: (name: string): Promise<void> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  /** `POST /api/sessions/{name}/archive` — archive the session (§3.2.5). The
   *  R1 fix has `archive()` correctly terminate per-session loops + forget the
   *  session, so once this returns the next SSE `sessions` refetch drops the
   *  row from the overview. Returns 202 + job_id; callers don't need either. */
  archive: (name: string): Promise<void> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}/archive`, {
      method: 'POST',
    }),

  /** `POST /api/sessions/{name}/unarchive` — reverse an archive (the overview's
   *  Undo affordance). Flips `archived = 0` and broadcasts a `sessions` SSE
   *  delta carrying the full row with `archived: false`, so the tile springs
   *  back into every connected tab's overview. The row is never DELETEd on
   *  archive, so this is always recoverable. */
  unarchive: (name: string): Promise<void> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}/unarchive`, {
      method: 'POST',
    }),

  /** `DELETE /api/sessions/{name}/purge` — the "Delete forever" path. Hard
   *  DELETEs an ARCHIVED row permanently (refused with 409 on a live session;
   *  404 if it doesn't exist). Audited `session.purge`; the archived scrollback
   *  dump is best-effort removed too. Irreversible — gate behind a confirm. */
  purge: (name: string): Promise<void> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}/purge`, {
      method: 'DELETE',
    }),

  /** `GET /api/sessions/{name}/resumable` — past Claude conversations for the
   *  session's working dir, newest-first (feat-resume-picker). Empty array when
   *  the dir has no conversations → the UI hides Resume. */
  resumable: async (name: string): Promise<ResumableConversation[]> => {
    const body = await sessReq<unknown>(
      `/api/sessions/${encodeURIComponent(name)}/resumable`,
    )
    const arr = Array.isArray(body)
      ? body
      : ((body as { data?: unknown })?.data ?? [])
    return Array.isArray(arr)
      ? arr.filter(
          (c): c is ResumableConversation =>
            !!c && typeof (c as { id?: unknown }).id === 'string',
        )
      : []
  },

  /** `POST /api/sessions/{name}/resume {id}` — start the session resuming the
   *  chosen Claude conversation (`claude --resume <id>`). The SSE `status` delta
   *  flips the tile to running, same as a fresh start. */
  resume: (name: string, id: string): Promise<unknown> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}/resume`, {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  /** `POST /api/sessions/{name}/mode {mode}` — switch the Claude permission mode
   *  (mode-shift). `normal`/`accept_edits`/`plan` cycle in place via targeted
   *  Shift+Tab (the server re-reads the capture, capped retries); `bypass` does a
   *  clean relaunch (stop → add flag → resume). Resolves to the mode ACTUALLY in
   *  effect after the op so the UI reflects truth even if the cycle didn't
   *  converge. */
  setMode: (name: string, mode: SessionMode): Promise<SetModeResult> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}/mode`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  /** `POST /api/sessions/{name}/duplicate {new_name}` — clone the session's
   *  config (dir / desc / provider / flags / tags / branch / worktree / mcp)
   *  into a NEW row under `new_name`, in the SAME directory. The new row is a
   *  real, independently-startable session (fresh runtime + hook token); the
   *  caller boots it with `start`. Resolves to the created row. 409 if
   *  `new_name` already exists — the caller regenerates the suffix and retries. */
  duplicate: (name: string, new_name: string): Promise<ApiSession> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ new_name }),
    }),

  /** `GET /api/autocomplete/dir?q=…` — directory typeahead for the Advanced tab
   *  (M7). Returns `[]` on any failure so the field degrades to a plain input. */
  autocompleteDir: async (q: string): Promise<string[]> => {
    try {
      const body = await sessReq<unknown>(
        `/api/autocomplete/dir?q=${encodeURIComponent(q)}`,
      )
      const arr = Array.isArray(body)
        ? body
        : ((body as { entries?: unknown; data?: unknown })?.entries ??
          (body as { data?: unknown })?.data ??
          [])
      return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : []
    } catch {
      return []
    }
  },
}

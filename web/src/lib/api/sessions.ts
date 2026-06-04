// Sessions — the real client for the sessions CRUD + the hero data
// flow (preview_lines off `last_capture`).
//
// Envelope: the backend wraps success bodies in `{ ok:true, data }` and errors in
// `{ ok:false, error }`. Some handlers return a bare array. `sessReq`
// unwraps `data` when present, tolerates a bare body, and lifts `error` into a
// typed `SessionError` (carrying the HTTP status) so the route can branch 409
// (duplicate name) vs 404 (gone) vs 0 (server unreachable) without crashing.
//
// The dashboard bearer token is read from `window._SUPERMUX_AUTH_TOKEN` at call time
// via the shared `apiToken`/`apiUrl` accessors in ./client — so the token is
// NEVER embedded here.

import { apiToken, apiUrl } from './client'

// ── Domain types ──────────────────────────────────────────────────────────────

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

/** Per-tile summary. SSE `sessions` events use this same shape (deltas). */
export interface SessionSummary {
  name: string
  /** Mutable human label (migration 0019); the server sends it (= `name` when
   *  unset). Use `displayLabel(s)`/`sessionTitle(s)` for UI; `name` is the key. */
  display_name?: string
  status: SessionStatus
  dir: string
  provider: string
  /** Last 6 lines of `last_capture`, ANSI-stripped. */
  preview_lines: string[]
  /** Same 6 lines with SGR escape sequences preserved — the colour-true tile
   *  preview source. Empty until the first capture; the UI falls back to
   *  `preview_lines` (plain text) when absent. */
  preview_ansi?: string[]
  /** Claude permission mode parsed from the status bar (mode-shift). Absent until
   *  the first capture; the ⋯ menu defaults the live-checked radio to `normal`. */
  mode?: SessionMode
  updated_at: string
  /** Remote host the session runs on. `null` / undefined = LOCAL. Carried
   *  on the tile so <HostBadge> can render without an extra fetch. */
  host_id?: number | null
  /** The user's last sent prompt (≤200 chars), captured by `set_last_send` on
   *  both REST `send`/`paste` and WebSocket Input frames terminated by Enter.
   *  Absent when the session has never received a submission. */
  last_send_text?: string
  /** Epoch seconds when `last_send_text` was written. Absent iff
   *  `last_send_text` is absent. */
  last_send_at?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Real sessions client.
// ─────────────────────────────────────────────────────────────────────────────

/** The fields the SSE `sessions` delta / the `GET /api/sessions` list carry for
 *  a tile. A superset of `SessionSummary` with the optional hero display fields
 *  the detector populates when it has them. Mirrors `TileSession` but
 *  lives here so the API layer owns the wire shape. */
export interface ApiSession {
  /** Immutable slug — the identity used for routes, API calls, SSE filters,
   *  tmux, hooks. Never changes after creation. Use `displayLabel(s)` for UI. */
  name: string
  /** Mutable human label (migration 0019). The server always sends it (= `name`
   *  when unset). Edited by the "rename" action; the slug `name` is untouched. */
  display_name?: string
  status: SessionStatus
  dir: string
  provider: string
  /** Last 6 lines of `last_capture`, ANSI-stripped. */
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
  /** Pin + activity drive the sort. */
  pinned?: boolean
  /** tmux session alive AND a child process exists. */
  running?: boolean
  /** Epoch seconds — last send / last started. */
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
  /** Remote host the session runs on. FK into the `hosts` table; `null` means
   *  LOCAL (the historical default + the in-flight behaviour for every existing
   *  row). The session tile renders a small globe badge when this is set; the
   *  new-session sheet picks it via <HostPicker>. */
  host_id?: number | null
  /** The user's last sent prompt (≤200 chars, control chars stripped), captured
   *  on both REST `send`/`paste` and WebSocket Input frames terminated by Enter.
   *  Absent when the session has never received a submission. Pairs with
   *  `last_send_at` to drive the focus-screen recall affordance (glass bar +
   *  popover + mobile sheet). */
  last_send_text?: string
  /** Epoch seconds when `last_send_text` was written. Absent iff `last_send_text`
   *  is absent. Used for the "<rel time> ago" label in the recall affordance. */
  last_send_at?: number
}

/** The human label to show for a session: its `display_name` when set, else the
 *  slug `name`. Use this for EVERY user-facing title; keep `name` for routes,
 *  API calls, query keys and SSE filters (it's the immutable identity). The
 *  server already coalesces to `name`, so the `?? name` is belt-and-braces for
 *  older payloads / optimistic rows that omit `display_name`. */
export function displayLabel(s: { name: string; display_name?: string }): string {
  return s.display_name?.trim() ? s.display_name : s.name
}

/** The title for the big surfaces (overview tile + focus header). A user-set
 *  `display_name` (one that differs from the slug) ALWAYS wins, so a rename is
 *  immediately visible; otherwise fall back to Claude's live auto chat-title
 *  (`task_summary`), then the slug. Compact switchers (picker, dock pill) use
 *  the plainer [`displayLabel`] instead — a long chat-title is noise in a list. */
export function sessionTitle(s: {
  name: string
  display_name?: string
  task_summary?: string
}): string {
  if (s.display_name?.trim() && s.display_name !== s.name) return s.display_name
  return s.task_summary?.trim() ? s.task_summary : s.name
}

/** A past Claude conversation for a session's working dir.
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

/** Live git status for a session's working dir, from
 *  `GET /api/sessions/{name}/git`. The stored `branch` label goes stale; this is
 *  read on demand when the info panel opens so it shows the TRUTH. Every field
 *  defaults to "no repo" server-side, so a non-git dir degrades cleanly (the
 *  panel hides the section). */
export interface GitInfo {
  /** True when the working dir is inside a git work tree. */
  repo: boolean
  /** Current branch; the short commit SHA when detached; empty when not a repo. */
  branch: string
  /** True when HEAD is detached (then `branch` holds the short SHA). */
  detached: boolean
  /** True when the work tree has uncommitted changes (tracked or untracked). */
  dirty: boolean
  /** Commits ahead of the upstream (0 when no upstream / not a repo). */
  ahead: number
  /** Commits behind the upstream (0 when no upstream / not a repo). */
  behind: number
}

/** Body for `PATCH /api/sessions/{name}/config` — the tmux-free fields. Every
 *  field is optional; send only what changes. A `rename` changes the session's
 *  IDENTITY (its slug = its displayed title), so the server also renames the live
 *  tmux session + rebuilds the pty stream — a running session survives it. */
export interface SessionConfigPatch {
  /** Edit the mutable display label (migration 0019) — the user-facing rename.
   *  Changes ONLY the label; the slug `name` (route/identity) is untouched. */
  display_name?: string
  /** Low-level slug rename (kept out of the UI — mutating the slug is what made
   *  a running pane's hooks go stale). Prefer `display_name`. */
  rename?: string
  desc?: string
  dir?: string
  branch?: string
  mcp?: string
  tags?: string[]
  toggle_pin?: boolean
  toggle_auto_continue?: boolean
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

/** Body for `POST /api/sessions`. `command` carries the initial prompt
 *  the Quick-start presets prefill; `worktree` requests an isolated git worktree.
 *  `host_id` picks the remote host the session runs on — `null` /
 *  omitted = LOCAL (the historical behaviour). */
export interface NewSession {
  name: string
  /** Human display label (migration 0019). Free-form; defaults to the slug
   *  `name` server-side when omitted. The create sheet derives `name` (slug)
   *  from this typed text. */
  display_name?: string
  dir: string
  provider?: 'claude' | 'shell'
  desc?: string
  worktree?: boolean
  command?: string
  host_id?: number | null
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
    // "Can't reach supermux-server. Retrying…" state instead of crashing.
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

/** Normalise whatever the list endpoint returns into `ApiSession[]`. The backend
 *  returns `SessionSummary[]`; this defends against the envelope being `{ data:[…] }`. */
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
  /** `GET /api/sessions` — the tile list incl. `preview_lines`. */
  list: async (): Promise<ApiSession[]> =>
    asSessions(await sessReq<unknown>('/api/sessions')),

  /** `GET /api/sessions/archived` — the archived (soft-deleted) rows for the
   *  Archived sheet. Mirror of `list` but on `WHERE archived = 1`, ordered
   *  most-recently-touched first. Each row carries `archived: true`. */
  listArchived: async (): Promise<ApiSession[]> =>
    asSessions(await sessReq<unknown>('/api/sessions/archived')),

  /** `POST /api/sessions` — create the row. The route then sends the
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

  /** `DELETE /api/sessions/{name}` — drop the session row from supermux.
   *  Used by the demo-replay flow to remove the one demo agent it booted. */
  remove: (name: string): Promise<void> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  /** `POST /api/sessions/{name}/archive` — archive the session. The
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
   *  session's working dir, newest-first. Empty array when
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

  /** `POST /api/sessions/{name}/external-edit/submit` — resolve an in-flight
   *  "edit in native editor" handoff. The native
   *  editor sheet posts the edited `text` on Done/Save, or `cancelled:true` on
   *  dismiss; the server then wakes the `$EDITOR` bridge's long-poll so Claude's
   *  input buffer is replaced (or left unchanged on cancel). DOES NOT submit the
   *  prompt — the edited text sits back at Claude's `❯` for the user to send with
   *  Enter. A stale `requestId` (edit already resolved/expired) → 409; the caller
   *  swallows it (the sheet just closes). */
  externalEditSubmit: (
    name: string,
    body: { requestId: string; text?: string; cancelled?: boolean },
  ): Promise<unknown> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}/external-edit/submit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** `PATCH /api/sessions/{name}/config` — patch the tmux-free fields (rename /
   *  desc / dir / branch / mcp / tags / pins). Resolves to the updated row. A
   *  `rename` also renames the live tmux session + rebuilds the pty so a RUNNING
   *  session survives; 409 if a `rename` target already exists, 400 if the target
   *  isn't a valid slug. */
  config: (name: string, patch: SessionConfigPatch): Promise<ApiSession> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}/config`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /** `PATCH .../config { display_name }` — the user-facing "rename": set the
   *  session's display label. The slug `name` (URL / identity / SSE key) is
   *  unchanged, so the caller does NOT navigate. Resolves to the updated row. */
  setDisplayName: (name: string, displayName: string): Promise<ApiSession> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ display_name: displayName } satisfies SessionConfigPatch),
    }),

  /** `PATCH .../config { rename }` — low-level SLUG rename (kept for internal /
   *  programmatic use; not wired to the UI). Mutating the slug changes the
   *  session's identity everywhere AND can't update a running pane's frozen env,
   *  which is exactly the staleness the display_name split avoids. Prefer
   *  `setDisplayName`. Resolves to the renamed row. */
  rename: (name: string, target: string): Promise<ApiSession> =>
    sessReq(`/api/sessions/${encodeURIComponent(name)}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ rename: target } satisfies SessionConfigPatch),
    }),

  /** `GET /api/sessions/{name}/git` — live git status for the working dir (real
   *  branch / dirty / ahead-behind), read when the info panel opens. */
  git: (name: string): Promise<GitInfo> =>
    sessReq<GitInfo>(`/api/sessions/${encodeURIComponent(name)}/git`),


  /** `GET /api/autocomplete/dir?q=…[&hidden=0]` — directory typeahead for the
   *  Advanced tab. Pass `noHidden:true` to filter the
   *  dotfile subdirs (`.git`, `.cache`, …) out of the typeahead — the new
   *  "Where" picker does this so the suggestions never surface noise the user
   *  has to scroll past. Default (`false`) preserves the legacy contract.
   *  Returns `[]` on any failure so the field degrades to a plain input. */
  autocompleteDir: async (q: string, noHidden = false): Promise<string[]> => {
    try {
      const query = `q=${encodeURIComponent(q)}${noHidden ? '&hidden=0' : ''}`
      const body = await sessReq<unknown>(`/api/autocomplete/dir?${query}`)
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

// ── Project repos endpoint ───────────────────────────────────────────────────

/** One entry from `GET /api/projects/repos` — a subdir of the first
 *  `SUPERMUX_PROJECT_DIRS` entry, with git-repo metadata. The "Where" picker
 *  renders these as primary project candidates; `is_git_repo` drives the tiny
 *  `git` tag vs the calm amber "not a git repo" warning (teammates each need
 *  their own git worktree per the official Agent Teams doc). */
export interface ProjectRepo {
  path: string
  name: string
  is_git_repo: boolean
}

/** Response from `GET /api/projects/repos`. `root` is the scanned dir (empty
 *  when `SUPERMUX_PROJECT_DIRS` is unset — the UI then hides the Projects
 *  section and nudges the user to "Use another folder"). */
export interface ProjectReposResponse {
  root: string
  entries: ProjectRepo[]
}

export const projectsApi = {
  /** `GET /api/projects/repos` — list immediate subdirs of the first
   *  `SUPERMUX_PROJECT_DIRS` entry with `is_git_repo` set per `.git` presence.
   *  Returns `{ root: '', entries: [] }` on any failure so the picker degrades
   *  to the free-text input. */
  list: async (): Promise<ProjectReposResponse> => {
    try {
      const body = await sessReq<unknown>('/api/projects/repos')
      const obj = (body ?? {}) as { root?: unknown; entries?: unknown }
      const root = typeof obj.root === 'string' ? obj.root : ''
      const entries = Array.isArray(obj.entries)
        ? obj.entries.filter(
            (e): e is ProjectRepo =>
              !!e &&
              typeof (e as { path?: unknown }).path === 'string' &&
              typeof (e as { name?: unknown }).name === 'string' &&
              typeof (e as { is_git_repo?: unknown }).is_git_repo === 'boolean',
          )
        : []
      return { root, entries }
    } catch {
      return { root: '', entries: [] }
    }
  },
}

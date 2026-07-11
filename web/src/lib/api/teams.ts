// Agent Teams data types + API client.
//
// A "team" = a LEAD Claude session that spawned N TEAMMATE Claude sessions as
// sibling tmux panes inside the lead's window. The backend watches the
// on-disk team files (~/.claude/teams/*/config.json + tasks/ + inboxes/), derives
// each member's live status, re-validates each teammate's %id every tick, and
// broadcasts the snapshot two ways:
//   • GET /api/teams                → { ok, data: Team[] }   (initial load)
//   • SSE `teams` event             → Team[]  (the BARE array; change-only)
// Both carry the SAME shape. `useTeams` GETs on mount then patches from SSE,
// exactly like `useSessions`/`useBoard` (no polling — WebSocket/SSE only).
//
// The TYPES mirror the backend wire shape byte-for-byte (snake_case status tokens).
// The status semantics drive the whole TEAM CARD attention model:
//   needs_you  → THE loud, attention-first state (blue `needs you` pill). Wins
//                over everything (even survives a dropped %id — it comes from the
//                inbox file, not the live pane).
//   working    → amber spinner (an active member with an in_progress task).
//   idle       → calm green disc (turn ended / no in_progress task).
//   offline    → not-live (is_active=false, shutdown, or its %id vanished). Dim.

import { ApiError, apiToken, apiUrl } from './client'

/** DERIVED live status for a teammate (snake_case wire tokens from the backend). */
export type MemberStatus = 'working' | 'idle' | 'needs_you' | 'offline'

/** One teammate in a team. NOT a supermux session — there is NO `/api/sessions`
 *  row for a teammate, so the TEAM CARD renders teammates ONLY from this payload.
 *  (The LEAD, by contrast, IS a normal session — see `Team.lead_supermux_session`.) */
export interface TeamMember {
  /** Display name (e.g. "researcher"). */
  name: string
  /** Stable id "{name}@{team}" — use as the React key. */
  agent_id: string
  /** Model the teammate runs (e.g. "claude-opus-4"). */
  model: string
  /** The teammate's assigned colour (hex/CSS) — drives the chip left-rail + dot.
   *  May be empty; callers fall back to a neutral token. */
  color: string
  /** The teammate's live tmux pane id ("%17"), or null when absent in config OR
   *  the %id is gone from the lead window THIS tick. NULL = "no live pane right
   *  now" (not "gone forever"); it can flip null↔value across ticks. Never stream
   *  a null pane. */
  tmux_pane_id: string | null
  /** Claude's raw roster liveness flag (surfaced verbatim). */
  is_active: boolean
  /** DERIVED status (see MemberStatus). */
  status: MemberStatus
}

/** A task on the team's shared task list (~/.claude/tasks/{team}/NN.json). */
export interface TeamTask {
  id: string
  subject: string
  description: string
  /** "pending" | "in_progress" | "completed" (other strings pass through). */
  status: string
  /** Member name or agent_id; "" when unassigned. */
  assigned_to: string
  /** Ids of tasks this one blocks / is blocked by. */
  blocks: string[]
  blocked_by: string[]
}

/** A detected agent team. Server-formed; not renameable/deletable by the client. */
export interface Team {
  /** Sanitised ~/.claude/teams/<dir> name — the stable identity (React key). */
  team_name: string
  /** config.json leadSessionId (a CLAUDE session id, NOT a supermux name). */
  lead_session: string
  /** The supermux session hosting the lead (the `supermux-<name>` window that
   *  contains the team's panes) — appears in /api/sessions — or null if unmapped
   *  this tick. The TEAM CARD renders this as the lead's FULL session tile. */
  lead_supermux_session: string | null
  members: TeamMember[]
  tasks: TeamTask[]
}

const TASK_DONE = 'completed'

/** Tasks completed / total, for the muted roll-up secondary (`X/Y tasks`). */
export function taskProgress(team: Team): { done: number; total: number } {
  const total = team.tasks.length
  const done = team.tasks.filter((t) => t.status === TASK_DONE).length
  return { done, total }
}

/** Count of members currently in the loud `needs_you` state — the roll-up's
 *  PRIMARY attention token (a blue pill when > 0, else a green "done"). */
export function needsYouCount(team: Team): number {
  return team.members.filter((m) => m.status === 'needs_you').length
}

/** Tasks assigned to a given member (matched by name OR agent_id, drift-tolerant —
 *  the backend says `assigned_to` may be either). Drives the chip's muted task-count. */
export function tasksForMember(team: Team, member: TeamMember): TeamTask[] {
  return team.tasks.filter(
    (t) => t.assigned_to === member.name || t.assigned_to === member.agent_id,
  )
}

/** Defensive coercion of an unknown wire value into a Team[] — tolerant of the
 *  experimental backend's schema drift (the backend watches an experimental
 *  Claude Code feature). Drops anything missing the identity field; fills sane defaults so a
 *  partial member/task never crashes the render. */
export function coerceTeams(raw: unknown): Team[] {
  if (!Array.isArray(raw)) return []
  const out: Team[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    if (typeof o.team_name !== 'string' || !o.team_name) continue
    out.push({
      team_name: o.team_name,
      lead_session: typeof o.lead_session === 'string' ? o.lead_session : '',
      lead_supermux_session:
        typeof o.lead_supermux_session === 'string'
          ? o.lead_supermux_session
          : null,
      members: coerceMembers(o.members),
      tasks: coerceTasks(o.tasks),
    })
  }
  return out
}

const MEMBER_STATUSES: ReadonlySet<MemberStatus> = new Set([
  'working',
  'idle',
  'needs_you',
  'offline',
])

function coerceMembers(raw: unknown): TeamMember[] {
  if (!Array.isArray(raw)) return []
  const out: TeamMember[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    if (typeof o.name !== 'string' || !o.name) continue
    const status =
      typeof o.status === 'string' && MEMBER_STATUSES.has(o.status as MemberStatus)
        ? (o.status as MemberStatus)
        : 'offline'
    out.push({
      name: o.name,
      agent_id:
        typeof o.agent_id === 'string' && o.agent_id
          ? o.agent_id
          : `${o.name}@`,
      model: typeof o.model === 'string' ? o.model : '',
      color: typeof o.color === 'string' ? o.color : '',
      tmux_pane_id:
        typeof o.tmux_pane_id === 'string' && o.tmux_pane_id
          ? o.tmux_pane_id
          : null,
      is_active: o.is_active === true,
      status,
    })
  }
  return out
}

function coerceTasks(raw: unknown): TeamTask[] {
  if (!Array.isArray(raw)) return []
  const out: TeamTask[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    out.push({
      id: typeof o.id === 'string' ? o.id : '',
      subject: typeof o.subject === 'string' ? o.subject : '',
      description: typeof o.description === 'string' ? o.description : '',
      status: typeof o.status === 'string' ? o.status : 'pending',
      assigned_to: typeof o.assigned_to === 'string' ? o.assigned_to : '',
      blocks: coerceStringArray(o.blocks),
      blocked_by: coerceStringArray(o.blocked_by),
    })
  }
  return out
}

function coerceStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

interface TeamsEnvelope {
  ok?: boolean
  data?: unknown
  error?: string
}

/** The ONE canonical teams-client request. Attaches the bearer read off
 *  `apiToken()` at call time (never embedded in source), parses the JSON
 *  `{ ok, data?, error? }` envelope, and throws `ApiError` (carrying the HTTP
 *  status + the envelope's `error`) on any non-2xx. Returns the parsed envelope
 *  so `listTeams` can read `data`; the void mutations (`dismissTeam`,
 *  `removeTeammate`) ignore the return. Factored out of what were three verbatim
 *  fetch + bearer-header + envelope-unwrap copies — behaviour is unchanged. */
async function teamsRequest(
  path: string,
  init?: RequestInit,
): Promise<TeamsEnvelope | null> {
  const token = apiToken()
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  let env: TeamsEnvelope | null = null
  try {
    env = (await res.json()) as TeamsEnvelope
  } catch {
    /* non-JSON (e.g. an HTML 404 page) — fall through to the status check */
  }
  if (!res.ok) {
    throw new ApiError(res.status, env?.error ?? res.statusText)
  }
  return env
}

/** GET /api/teams — initial load. Unwraps `{ ok, data }` and coerces defensively. */
async function listTeams(): Promise<Team[]> {
  const env = await teamsRequest('/api/teams')
  return coerceTeams(env?.data ?? [])
}

/** POST /api/teams/{name}/dismiss — park an unmapped team's on-disk config under
 *  `.archived/` so it stops surfacing as a card. The only way to clear a team
 *  whose lead no longer maps to a live session. */
async function dismissTeam(name: string): Promise<void> {
  await teamsRequest(`/api/teams/${encodeURIComponent(name)}/dismiss`, {
    method: 'POST',
  })
}

/** DELETE /api/teams/{teamName}/members/{agentId}: REMOVE one teammate from
 *  supermux's team view. A LIVE teammate is killed (its tmux pane) THEN
 *  dismissed, so it disappears at once instead of lingering as a dead chip; a
 *  dead/offline teammate is just dismissed. The hide is supermux-side only:
 *  Claude's on-disk roster (`~/.claude/teams/<team>/config.json`) is NEVER
 *  edited, and it survives restarts (the watcher filters the teammate out on
 *  every tick).
 *
 *  Keyed by the stable member identity `(team_name, agent_id)`, so it works even
 *  when the teammate has no live pane. `agent_id` contains `@`, so both segments
 *  are URL-encoded. */
async function removeTeammate(teamName: string, agentId: string): Promise<void> {
  await teamsRequest(
    `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(agentId)}`,
    { method: 'DELETE' },
  )
}

export const teamsApi = {
  list: listTeams,
  dismiss: dismissTeam,
  removeTeammate,
}

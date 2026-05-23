// skills-mcp-manager — Claude tools manager client (MCP servers · skills ·
// commands). Thin stub authored by the BACKEND worker so the MCP-FE worker has
// the exact wire contract to consume; the FE owns the sheet/UI itself.
//
// Endpoints (all bearer-protected, mounted inside the protected router):
//   * GET    /api/claude/registry?cwd=<dir>
//       → { ok, data: { mcp: McpEntry[], skills: SkillEntry[], commands: CommandEntry[] } }
//       Reads Claude's config FILES directly (fast, no process spawn). MCP
//       env/header VALUES are MASKED ('••• set') — raw secrets never leave the
//       server. Omit `cwd` for global/user-only (the ⌘K / settings entry point).
//   * POST   /api/claude/mcp            — add (guided form OR raw `config` blob).
//       Body: { name, scope?, cwd?, transport?, command?, args?, env?, url?,
//               headers?, config?, confirm_project_write? }.
//       scope defaults to 'local' when cwd is given else 'user' — NEVER 'project'
//       implicitly. A 'project' write (git-tracked .mcp.json) is REFUSED with a
//       400 unless `confirm_project_write: true` (show a loud warning first).
//       env/headers are WRITE-ONLY (sent raw IN, never echoed back).
//   * DELETE /api/claude/mcp/{name}?scope=&cwd=   — remove from its file.
//   * POST   /api/claude/mcp/{name}/disable?cwd=  — untrust a project .mcp.json server.
//   * POST   /api/claude/mcp/{name}/enable?cwd=   — trust a project .mcp.json server.
//   * POST   /api/claude/mcp/{name}/check?cwd=    — OPT-IN live health probe
//       (shells out to `claude mcp`, ~15s timeout). NEVER call on list-read.
//
// Every mutating response carries `restartHint: true` so the UI can show the
// "Restart this session to apply" toast. Auth rides the dashboard bearer read
// from `window._SUPERMUX_AUTH_TOKEN` at call time — NEVER hard-coded.

import { ApiError, apiToken, apiUrl } from './client'

// ── wire types (mirror the backend `claude_tools` module exactly) ─────────────

export type McpScope = 'user' | 'local' | 'project'
export type McpTransport = 'stdio' | 'http' | 'sse'

/** One MCP server row (registry::McpEntry). `config` has env/header VALUES masked
 *  ('••• set') — only KEY names + non-secret fields survive. `enabled` is null
 *  for user/local (always active) and tri-state for project (.mcp.json) servers:
 *  true=trusted, false=disabled, null=pending. `committed` flags the git-tracked
 *  project source. */
export interface McpEntry {
  name: string
  scope: McpScope
  provenance: string
  transport: string
  committed: boolean
  removable: boolean
  enabled: boolean | null
  config: Record<string, unknown>
}

/** One skill row (registry::SkillEntry). `linked` marks a symlinked skill dir
 *  (remove must unlink, not delete the target); read-only sources have
 *  removable=false. */
export interface SkillEntry {
  name: string
  scope: 'global' | 'project' | 'plugin'
  provenance: string
  description: string
  path: string
  linked: boolean
  link_target: string | null
  removable: boolean
}

/** One slash-command row (registry::CommandEntry). `managed` flags a supermux-
 *  owned command (DB-backed / managed marker); built-ins + plugin commands are
 *  read-only. */
export interface CommandEntry {
  name: string
  scope: 'global' | 'project' | 'builtin' | 'plugin'
  provenance: string
  description: string
  path: string | null
  managed: boolean
  removable: boolean
}

export interface ClaudeRegistry {
  mcp: McpEntry[]
  skills: SkillEntry[]
  commands: CommandEntry[]
}

/** Add-MCP payload — guided form OR a raw `config` blob (config wins). */
export interface AddMcpInput {
  name: string
  scope?: McpScope
  cwd?: string
  // guided form:
  transport?: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  // raw-JSON form:
  config?: Record<string, unknown>
  /** REQUIRED true to write the git-tracked .mcp.json (project scope). */
  confirm_project_write?: boolean
}

/** Live health-check result (mcp::check). Opt-in only. */
export interface McpHealth {
  connected: boolean
  status: 'connected' | 'ok' | 'needs_auth' | 'failed' | 'timeout'
  detail: string
}

// ── envelope-aware request (mirrors commands.ts) ──────────────────────────────

interface RawEnvelope {
  ok?: boolean
  data?: unknown
  error?: unknown
  [k: string]: unknown
}

async function claudeRequest(path: string, init?: RequestInit): Promise<RawEnvelope> {
  const headers = new Headers(init?.headers)
  const token = apiToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')

  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers })
  } catch {
    throw new ApiError(0, 'Can’t reach supermux-server.')
  }
  let env: RawEnvelope = {}
  try {
    env = (await res.json()) as RawEnvelope
  } catch {
    /* non-JSON body — fall through to the status check */
  }
  if (!res.ok) {
    throw new ApiError(res.status, String(env.error ?? res.statusText))
  }
  if (env.ok === false) {
    throw new ApiError(res.status, String(env.error ?? 'request failed'))
  }
  return env
}

function scopeQuery(scope?: McpScope, cwd?: string): string {
  const p = new URLSearchParams()
  if (scope) p.set('scope', scope)
  if (cwd) p.set('cwd', cwd)
  const s = p.toString()
  return s ? `?${s}` : ''
}

// ── public surface ────────────────────────────────────────────────────────────

export const claudeToolsApi = {
  /** GET /api/claude/registry — grouped MCP/skills/commands, secrets masked. */
  registry: async (cwd?: string): Promise<ClaudeRegistry> => {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    const env = await claudeRequest(`/api/claude/registry${q}`)
    const d = (env.data ?? {}) as Partial<ClaudeRegistry>
    return {
      mcp: Array.isArray(d.mcp) ? d.mcp : [],
      skills: Array.isArray(d.skills) ? d.skills : [],
      commands: Array.isArray(d.commands) ? d.commands : [],
    }
  },

  /** POST /api/claude/mcp — add a server (guided OR raw). */
  addMcp: async (input: AddMcpInput): Promise<void> => {
    await claudeRequest('/api/claude/mcp', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** DELETE /api/claude/mcp/{name} — remove from its scope's file. */
  removeMcp: async (name: string, scope?: McpScope, cwd?: string): Promise<void> => {
    await claudeRequest(`/api/claude/mcp/${encodeURIComponent(name)}${scopeQuery(scope, cwd)}`, {
      method: 'DELETE',
    })
  },

  /** POST /api/claude/mcp/{name}/enable — trust a project .mcp.json server. */
  enableMcp: async (name: string, cwd: string): Promise<void> => {
    await claudeRequest(
      `/api/claude/mcp/${encodeURIComponent(name)}/enable${scopeQuery(undefined, cwd)}`,
      { method: 'POST' },
    )
  },

  /** POST /api/claude/mcp/{name}/disable — untrust a project .mcp.json server. */
  disableMcp: async (name: string, cwd: string): Promise<void> => {
    await claudeRequest(
      `/api/claude/mcp/${encodeURIComponent(name)}/disable${scopeQuery(undefined, cwd)}`,
      { method: 'POST' },
    )
  },

  /** POST /api/claude/mcp/{name}/check — OPT-IN live health probe. */
  checkMcp: async (name: string, scope?: McpScope, cwd?: string): Promise<McpHealth> => {
    const env = await claudeRequest(
      `/api/claude/mcp/${encodeURIComponent(name)}/check${scopeQuery(scope, cwd)}`,
      { method: 'POST' },
    )
    return {
      connected: Boolean(env.connected),
      status: (env.status as McpHealth['status']) ?? 'failed',
      detail: String(env.detail ?? ''),
    }
  },
}

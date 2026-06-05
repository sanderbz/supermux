// In-UI update mechanism client (v0.3.0).
//
// The Settings → Updates panel polls /api/version every 30s, force-refreshes
// via /api/version/refresh on demand, kicks an update via /api/update/start,
// and tails /api/update/progress/:job_id as SSE for live install steps.
//
// All endpoints are bearer-protected (same AUTH_TOKEN as the rest of /api).

import { settingsRequest } from './client'

/** Compile-time identity of the running binary (baked by server/build.rs). */
export interface VersionInfo {
  /** The release tag (e.g. `v0.2.0`). `null` for a dev build (untagged sha). */
  tag: string | null
  /** The commit sha (40 chars), or `"dev"` outside a git working tree. */
  sha: string
  /** ISO-8601 UTC build timestamp. Empty string when unavailable. */
  build_time: string
}

/** GitHub `releases/latest` (the subset we render). */
export interface LatestRelease {
  tag: string
  sha: string
  body: string
  html_url: string
  published_at: string | null
}

/** Tagged union: switch on `kind` to render mode-specific copy. */
export type InstallMode =
  | { kind: 'systemd'; path_unit_present: boolean }
  | { kind: 'bare_binary' }
  | { kind: 'dev' }
  | { kind: 'docker' }
  | { kind: 'unknown' }

/** Tagged union of every reason "Update now" can be disabled. The `message`
 *  field on each variant is the actionable English copy the UI renders verbatim.
 *  No client-side string interpolation needed. */
export type BlockedReason =
  | { kind: 'uncommitted_changes'; count: number; message: string }
  | { kind: 'not_on_main'; current_branch: string; message: string }
  | { kind: 'detached_head'; message: string }
  | { kind: 'ahead_of_remote'; count: number; message: string }
  | { kind: 'missing_tool'; name: string; message: string }
  | { kind: 'low_disk'; available_mb: number; message: string }
  | { kind: 'no_latest_release'; message: string }
  | { kind: 'path_unit_missing'; message: string }
  | { kind: 'manual_update_required'; command: string; message: string }
  | { kind: 'no_repo_dir'; command: string; message: string }
  | { kind: 'docker_update_unsupported'; message: string }
  | { kind: 'not_privileged_to_write'; message: string }

/** The single payload `/api/version` always returns (200 OK). */
export interface PreflightStatus {
  current: VersionInfo
  latest: LatestRelease | null
  update_available: boolean
  blocked_reasons: BlockedReason[]
  install_mode: InstallMode
  /** True IFF the dashboard should render an "Updates" section at all. A
   *  Docker / unknown install hides it entirely (no actionable surface). */
  manageable: boolean
}

/** The progress event the SSE stream emits for each step. */
export type UpdateStep =
  | 'queued'
  | 'fetching'
  | 'building'
  | 'installing'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'rolled_back'

export interface UpdateEvent {
  job_id: string
  step: UpdateStep
  message: string
  /** Epoch seconds. */
  ts: number
}

export const updatesApi = {
  /** GET /api/version: current + latest + preflight. ALWAYS 200; a blocked
   *  state is information, not an error. */
  getVersion: (): Promise<PreflightStatus> => settingsRequest('/api/version'),

  /** POST /api/version/refresh: force a GitHub fetch even if the cache is
   *  fresh. Response carries the new snapshot + an optional `fetch_error`. */
  refresh: async (): Promise<{ snapshot: PreflightStatus; fetch_error: string | null }> => {
    type Wire = PreflightStatus & { fetch_error?: string | null }
    // settingsRequest unwraps `data`; we need the sibling `fetch_error`, so go
    // through fetch directly to preserve the outer envelope.
    const res = await fetch(
      `${(window._SUPERMUX_BASE_URL ?? import.meta.env.BASE_URL).replace(/\/$/, '')}/api/version/refresh`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(window._SUPERMUX_AUTH_TOKEN
            ? { Authorization: `Bearer ${window._SUPERMUX_AUTH_TOKEN}` }
            : {}),
        },
      },
    )
    const env = await res.json().catch(() => null)
    if (!res.ok || !env?.ok) {
      throw new Error(env?.error ?? `${res.status} ${res.statusText}`)
    }
    return {
      snapshot: env.data as Wire,
      fetch_error: (env.fetch_error ?? null) as string | null,
    }
  },

  /** POST /api/update/start: kick off the install. Returns `{ job_id }` on
   *  202 or throws with the blocked_reasons on 409. */
  start: async (): Promise<{ job_id: string }> => {
    const res = await fetch(
      `${(window._SUPERMUX_BASE_URL ?? import.meta.env.BASE_URL).replace(/\/$/, '')}/api/update/start`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(window._SUPERMUX_AUTH_TOKEN
            ? { Authorization: `Bearer ${window._SUPERMUX_AUTH_TOKEN}` }
            : {}),
        },
      },
    )
    const env = await res.json().catch(() => null)
    if (res.status === 409) {
      const err = new Error(
        (env?.error as string) ?? 'update blocked by preflight',
      ) as Error & { blocked_reasons?: BlockedReason[] }
      err.blocked_reasons = (env?.blocked_reasons ?? []) as BlockedReason[]
      throw err
    }
    if (!res.ok || !env?.ok) {
      throw new Error(env?.error ?? `${res.status} ${res.statusText}`)
    }
    return env.data as { job_id: string }
  },

  /** Returns the SSE URL for a job's progress stream. The frontend opens an
   *  EventSource against this URL; auth uses the `?_token=` query fallback
   *  because EventSource cannot set an Authorization header. */
  progressUrl: (jobId: string): string => {
    const base = (window._SUPERMUX_BASE_URL ?? import.meta.env.BASE_URL).replace(/\/$/, '')
    const token = window._SUPERMUX_AUTH_TOKEN ?? ''
    return `${base}/api/update/progress/${encodeURIComponent(jobId)}?_token=${encodeURIComponent(token)}`
  },
}

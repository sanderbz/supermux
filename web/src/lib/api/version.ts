// Updates / self-update API client (UPDATE-MECH).
//
// The supermux server exposes a small surface to read its own version, fetch
// the latest GitHub release, and (when the install was deployed via the path
// unit) start a self-update that builds + swaps the binary in place.
//
// All HTTP requests funnel through the shared `settingsRequest` (./client) so
// the AUTH_TOKEN (window._SUPERMUX_AUTH_TOKEN) is consistently attached as a
// `Authorization: Bearer …` header — never embedded in source.
//
// The SSE progress stream uses EventSource. Because EventSource cannot set
// custom headers, the token is passed as `?token=<AUTH_TOKEN>` query-string;
// the backend accepts both formats.

import { authToken, baseUrl, settingsRequest } from './client'

// ── Wire types (locked contract — backend ships this exact shape) ─────────────

/** What the local server reports about its OWN binary. `tag` is null on dev
 *  builds (no release tagged yet); `sha` is git HEAD short sha; `built_at` is
 *  ISO-8601 UTC. */
export interface VersionInfo {
  tag: string | null
  sha: string
  built_at: string
}

/** A GitHub release representation, mirrored from the upstream API. `body` is
 *  the release notes (markdown); `html_url` is the GitHub page link. */
export interface LatestRelease {
  tag: string
  sha: string
  body: string
  html_url: string
  published_at: string
}

/** How supermux is installed on this host — drives which actions the UI is
 *  allowed to surface (a `dev` or `bare_binary` install can't self-update via
 *  the path unit, for example). */
export type InstallMode =
  | { kind: 'systemd'; path_unit_present: boolean }
  | { kind: 'bare_binary' }
  | { kind: 'dev' }
  | { kind: 'docker' }
  | { kind: 'unknown' }

/** A single reason a self-update is blocked. Each variant carries a
 *  human-readable `message` plus structured fields the UI uses to render a
 *  specific affordance (a command to run, the branch name, the missing tool).
 *
 *  Discriminated on `kind` so a `switch` in the panel renders the right copy
 *  for each case without prop-drilling formatters. */
export type BlockedReason =
  | { kind: 'path_unit_missing'; message: string }
  | { kind: 'manual_update_required'; message: string; command: string }
  | { kind: 'detached_head'; message: string }
  | { kind: 'not_on_main'; message: string; current_branch: string }
  | { kind: 'uncommitted_changes'; message: string }
  | { kind: 'ahead_of_remote'; message: string; count: number }
  | { kind: 'missing_tool'; message: string; tool: string }
  | { kind: 'low_disk'; message: string; available_mb: number }
  | { kind: 'no_network'; message: string }
  | { kind: 'docker_pull_required'; message: string }

/** The full payload returned by `GET /api/version`. `latest === null` when the
 *  server hasn't reached the GH API yet (cold start, network blip). */
export interface VersionResponse {
  current: VersionInfo
  latest: LatestRelease | null
  update_available: boolean
  blocked_reasons: BlockedReason[]
  install_mode: InstallMode
}

/** Steps the SSE update stream emits, in order. The last event (`done` /
 *  `failed` / `rolled_back`) closes the stream. */
export type UpdateStep =
  | 'fetching'
  | 'building'
  | 'installing'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'rolled_back'

export interface UpdateEvent {
  step: UpdateStep
  message: string
  ts: string
}

// ── HTTP surface ──────────────────────────────────────────────────────────────

export const versionApi = {
  /** `GET /api/version` — no-auth read. The full status of the local install
   *  vs. the latest known release. */
  get: (): Promise<VersionResponse> => settingsRequest('/api/version'),

  /** `POST /api/version/refresh` — force a fresh GitHub fetch. Auth required.
   *  Returns the updated VersionResponse. */
  refresh: (): Promise<VersionResponse> =>
    settingsRequest('/api/version/refresh', { method: 'POST' }),

  /** `POST /api/update/start` — kick off the build+install pipeline. Returns
   *  `{ job_id }` (202) when the preflight is clean, or throws an `ApiError`
   *  carrying the 409 status whose JSON body is `{ blocked_reasons }` (the
   *  server re-checked at call time and found a blocker). */
  start: (): Promise<{ job_id: string }> =>
    settingsRequest('/api/update/start', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
}

/** Build the SSE URL for a job, embedding the auth token as `?token=…` since
 *  `EventSource` doesn't support custom headers. */
export function updateProgressUrl(jobId: string): string {
  const token = authToken()
  const base = baseUrl().replace(/\/$/, '')
  const q = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${base}/api/update/progress/${encodeURIComponent(jobId)}${q}`
}

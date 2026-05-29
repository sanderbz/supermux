// Shared API core. Every per-feature module (files, settings, board, scheduler,
// focus, sessions) imports its primitives from here, so there is exactly ONE
// canonical copy of each shared helper.
//
// This file is the result of splitting the formerly-monolithic lib/api.ts into
// per-feature modules: future frontend changes each touch their own feature file
// instead of all appending to one api.ts, ending the recurring api.ts
// merge-conflict class. Pure structural refactor — ZERO behavior change.

import { authToken, baseUrl } from '@/env'

// Re-export the env accessors so feature modules (and any consumer) can pull the
// shared token/base from a single place. settings + focus use these directly.
export { authToken, baseUrl }

// ── Runtime config accessors (window-based) ───────────────────────────────────
//
// The dashboard bearer token + base URL live on the `window._SUPERMUX_*` globals
// (typed in env.ts) and are read at call time — NEVER embedded in source. The
// files/board/sessions clients historically each defined an identical
// `fsToken`/`fsApiUrl` (and scheduler an identical `schedToken`/`schedApiUrl`);
// those duplicates are now consolidated into this single canonical pair.

/** Bearer token read off `window._SUPERMUX_AUTH_TOKEN` at call time. */
export function apiToken(): string {
  return window._SUPERMUX_AUTH_TOKEN ?? ''
}

/** Resolve `path` against the runtime base URL (`window._SUPERMUX_BASE_URL` →
 *  `import.meta.env.BASE_URL`), trimming a trailing slash. */
export function apiUrl(path: string): string {
  const base = (window._SUPERMUX_BASE_URL ?? import.meta.env.BASE_URL).replace(
    /\/$/,
    '',
  )
  return `${base}${path}`
}

// ── ApiError + the `{ ok, data?, error? }` envelope helper ────────────────────

/** HTTP error that preserves the status code so callers can branch on 401/404. */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export interface Envelope<T> {
  ok: boolean
  data?: T
  error?: string
}

/** Envelope-aware request used by the settings + focus clients. Reads the bearer
 *  off `authToken()` (env.ts) against `baseUrl()`, unwraps `{ ok, data }` on
 *  success and throws `ApiError` (carrying the status code) otherwise. */
export async function settingsRequest<T>(
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

// Global fetch wrapper (V034) — observes every /api/* call and feeds the
// `useApiStatus` connection-state machine.
//
// WHY MONKEY-PATCH. There are ~12 per-feature client modules (sessions, board,
// boards, files, scheduler, hosts, teams, claude, commands, …) each with a
// near-identical try/catch around `fetch(apiUrl(path))`. Refactoring every one
// to take a "report" callback would add 12 dependency edges + 12 PRs of churn
// for ZERO behavior change. A single boot-time `fetch` monkey-patch sees
// every request the same way, even from code we don't own (third-party libs,
// future modules). The patch is additive — it preserves the original behavior
// byte-for-byte, only reading the response/error to drive the store.
//
// SCOPE. We only observe URLs that look like our API (start with `/api/`, OR
// match the configured `baseUrl()` + `/api/`). Cross-origin fetches and
// non-API requests (the woff2 font, the OpenAI proxy, anything) are passed
// through untouched and do NOT affect connection state. SSE (EventSource) and
// WebSocket are NOT touched here — they have their own per-link state machinery
// feeding `useConnection` (M23a).
//
// SAFETY:
//   - Idempotent: a second `installFetchInstrumentation()` is a no-op.
//   - Preserves Request/Response semantics. Body streams are NOT consumed.
//   - Never throws. Reporting is best-effort; any error inside the wrapper is
//     swallowed so a buggy reporter cannot break user-visible requests.

import { useApiStatus } from '@/stores/api-status-store'

/** True when `installFetchInstrumentation()` has already run on this window. */
let installed = false

/** Best-effort check: does this URL belong to our API surface? Accepts:
 *    - relative path starting with `/api/`
 *    - absolute URL whose pathname starts with `/api/`
 *    - URL beginning with the configured BASE_URL + `/api/` */
function isApiUrl(input: RequestInfo | URL): boolean {
  try {
    let urlStr: string
    if (typeof input === 'string') urlStr = input
    else if (input instanceof URL) urlStr = input.toString()
    else if (input instanceof Request) urlStr = input.url
    else return false

    // Relative path — easy case.
    if (urlStr.startsWith('/api/')) return true

    // Absolute URL: only treat as our API when it's same-origin AND starts with /api/.
    // Avoids classifying third-party URLs (e.g. https://example.com/foo/api/bar) as ours.
    if (/^https?:\/\//.test(urlStr)) {
      const u = new URL(urlStr)
      return u.origin === window.location.origin && u.pathname.startsWith('/api/')
    }
    return false
  } catch {
    return false
  }
}

/** Install the fetch wrapper. Called once from main.tsx at boot.
 *  No-op on subsequent calls (HMR-safe). */
export function installFetchInstrumentation(): void {
  if (installed) return
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
  installed = true

  const original = window.fetch.bind(window)

  window.fetch = async (input, init) => {
    const isApi = isApiUrl(input)

    let res: Response
    try {
      res = await original(input, init)
    } catch (err) {
      if (isApi) {
        try {
          // Network error / DNS / connection refused / aborted-by-network.
          // AbortError from a deliberate caller cancel must NOT report — only
          // genuine network failures should mark the link unhealthy.
          const name = (err as { name?: string } | null)?.name
          if (name !== 'AbortError') {
            useApiStatus
              .getState()
              .reportFailure(0, (err as Error | null)?.message ?? 'network')
          }
        } catch {
          /* never let a buggy reporter break the request */
        }
      }
      throw err
    }

    if (isApi) {
      try {
        if (res.ok) {
          useApiStatus.getState().reportSuccess()
        } else if (
          res.status === 401 ||
          res.status === 403 ||
          (res.status >= 500 && res.status <= 599)
        ) {
          useApiStatus
            .getState()
            .reportFailure(res.status, res.statusText)
        }
        // 4xx (404/409/400/…) are real responses from a healthy server —
        // do NOT touch connection state. The caller's error path handles them.
      } catch {
        /* swallow — never disturb the response */
      }
    }
    return res
  }
}

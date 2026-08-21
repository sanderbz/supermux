// Served-version heartbeat — a service-worker-lifecycle-INDEPENDENT safety net
// that surfaces the reload bar when the SERVER is live on a newer build than the
// bundle currently executing in this page.
//
// WHY THIS EXISTS ON TOP OF `lib/pwa.ts`'s `onNeedRefresh` path. The SW path can
// only ever fire when vite-plugin-pwa detects a WAITING worker via the normal
// registration lifecycle. A PWA that is wedged on an OLD service worker —
// installed before the adoption wiring existed, or one whose `update()` check is
// being served a stale `sw.js` from some cache — can never reach `onNeedRefresh`,
// so the SW path alone can never break that deadlock. This poll sidesteps the SW
// entirely: it asks the live server "what sha are you?" and compares that to the
// sha THIS bundle was built from (`__APP_BUILD_SHA__`, injected by
// vite.config.ts `define`; the server's `/api/version` `current.sha` is baked by
// server/build.rs from the SAME checkout at deploy time, so the two are equal for
// a given deploy and differ the instant a new build ships). On a mismatch it
// surfaces the exact same one-tap reload bar via the shared adoption store.
//
// KISS + no data loss: it reuses `markWaiting`, so the idle-guard still applies
// (unsent composer text vetoes any silent reload; a visible tab gets the button,
// never a surprise reload). It is a strict SUPERSET trigger for the bar, never a
// second reload mechanism that could fight the SW path.

import { markWaiting } from '@/lib/sw-update'

/** How often the running bundle asks the server for its live build sha. Matches
 *  the SW `registration.update()` cadence in `lib/pwa.ts`; a plain conditional
 *  GET of a tiny JSON body, negligible cost. */
const VERSION_POLL_MS = 60_000

/** A real, comparable git sha (not the `"dev"` sentinel a non-git build bakes).
 *  Both sides must be real for a mismatch to mean anything. */
export function isRealSha(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{7,40}$/.test(s) && s !== 'dev'
}

/**
 * The load-bearing decision, pure so it unit-tests headlessly: surface the
 * reload bar IFF both shas are real and they differ. A null/unknown served sha
 * (offline, 401, dev server) or a `"dev"` build never triggers a bar — no false
 * positives from a transient failure, and equal shas mean the page is current.
 */
export function isNewerServedSha(served: unknown, built: unknown): boolean {
  return isRealSha(served) && isRealSha(built) && served !== built
}

/** Ask the live server which sha it is running. Returns null on any failure
 *  (offline, 401, malformed) so a transient blip never surfaces a false bar. */
async function fetchServedSha(): Promise<string | null> {
  try {
    const base = (window._SUPERMUX_BASE_URL ?? import.meta.env.BASE_URL).replace(/\/$/, '')
    const res = await fetch(`${base}/api/version`, {
      headers: window._SUPERMUX_AUTH_TOKEN
        ? { Authorization: `Bearer ${window._SUPERMUX_AUTH_TOKEN}` }
        : {},
      // Must hit the network, never a cached copy — this is the freshness probe.
      cache: 'no-store',
    })
    if (!res.ok) return null
    const env = await res.json().catch(() => null)
    const sha = env?.data?.current?.sha
    return isRealSha(sha) ? sha : null
  } catch {
    return null
  }
}

/**
 * Adopt the newer build for the version-mismatch path — deliberately robust
 * against a wedged/absent SW, since that is the exact case this guard exists to
 * rescue:
 *   1. Force the SW to re-check (`registration.update()`) so a genuinely waiting
 *      worker is discovered even if the plugin's callback was missed.
 *   2. If one IS waiting, adopt it the clean way: SKIP_WAITING →
 *      `controllerchange` → reload (with a short timeout fallback in case
 *      `controllerchange` never lands).
 *   3. Otherwise fall back to a plain reload. `index.html` is served `no-cache`
 *      and references content-hashed chunk URLs, so a reload pulls the freshly
 *      deployed bundle from the network even under the old controller — the new
 *      chunk URLs are simply not in the old CacheFirst cache.
 */
async function adoptNewBuild(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    await reg?.update?.()
    if (reg?.waiting) {
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => location.reload(),
        { once: true },
      )
      reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      window.setTimeout(() => location.reload(), 3_000)
      return
    }
  } catch {
    // fall through to a plain reload
  }
  location.reload()
}

let started = false

/**
 * Start the served-version heartbeat. Idempotent. No-op when this bundle has no
 * real sha to compare (a `"dev"` build). Polls on an interval and, crucially, the
 * instant the tab is foregrounded — the common way a phone PWA returns after a
 * deploy happened while it was backgrounded.
 */
export function startVersionGuard(): void {
  if (started) return
  if (!isRealSha(__APP_BUILD_SHA__)) return
  started = true

  const check = async () => {
    const served = await fetchServedSha()
    if (isNewerServedSha(served, __APP_BUILD_SHA__)) {
      // A newer build is live. Surface the same bar the SW path uses; the
      // idle-guard inside markWaiting still decides silent-vs-button.
      markWaiting(() => void adoptNewBuild())
    }
  }

  window.setInterval(() => void check(), VERSION_POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
  void check()
}

/** TEST SEAM: reset module state between cases. */
export function __resetVersionGuardForTest(): void {
  started = false
}

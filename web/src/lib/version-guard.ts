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
// entirely: it asks the live server "what sha is your EMBEDDED FRONTEND?" and
// compares that to the sha THIS bundle was built from (`__APP_BUILD_SHA__`,
// injected by vite.config.ts `define`). The server reports `data.frontend_sha` —
// read at runtime from the embedded `dist/version.json`, which vite stamps from
// the SAME sha source as `__APP_BUILD_SHA__` — so the two are equal for a given
// FRONTEND build and differ the instant a new FRONTEND bundle ships. Crucially
// this is NOT the backend build sha (`data.current.sha`, baked by
// server/build.rs): a backend-only deploy re-embeds no frontend, so frontend_sha
// is unchanged and no false bar appears (the stuck-bar bug this replaced). On a
// genuine mismatch it surfaces the same one-tap reload bar via the shared store.
//
// KISS + no data loss: it reuses `markWaiting`, so the idle-guard still applies
// (unsent composer text vetoes any silent reload; a visible tab gets the button,
// never a surprise reload). It is a strict SUPERSET trigger for the bar, never a
// second reload mechanism that could fight the SW path.

import { markCurrent, markWaiting } from '@/lib/sw-update'

/** How often the running bundle asks the server for its live build sha. Matches
 *  the SW `registration.update()` cadence in `lib/pwa.ts`; a plain conditional
 *  GET of a tiny JSON body, negligible cost. */
const VERSION_POLL_MS = 60_000

/** sessionStorage key for the bounded adopt-escalation counter. First tap =
 *  plain reload (the server now serves index.html no-cache, so that alone yields
 *  the fresh bundle); a second tap after the guard STILL fires escalates to
 *  `unregister()` + reload. Cleared the moment the page is current, so it can
 *  never accumulate across unrelated deploys. */
const ADOPT_ATTEMPT_KEY = 'sm_adopt_attempt'

function readAttempt(): number {
  try {
    const n = Number(globalThis.sessionStorage?.getItem(ADOPT_ATTEMPT_KEY))
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

function bumpAttempt(): void {
  try {
    globalThis.sessionStorage?.setItem(ADOPT_ATTEMPT_KEY, String(readAttempt() + 1))
  } catch {
    // sessionStorage unavailable (private mode / no DOM) — the guard still works,
    // it just always takes the first-tap plain-reload branch.
  }
}

function clearAttempt(): void {
  try {
    globalThis.sessionStorage?.removeItem(ADOPT_ATTEMPT_KEY)
  } catch {
    // ignore
  }
}

/** Delete every Cache Storage bucket so NOTHING stale can be served to the page
 *  after the reload — the wedged-precache escape hatch. Best-effort: a missing
 *  `caches` API (non-secure context, old browser) simply skips it. */
async function clearAllCaches(): Promise<void> {
  try {
    const c = (globalThis as unknown as { caches?: CacheStorage }).caches
    if (!c) return
    const keys = await c.keys()
    await Promise.all(keys.map((k) => c.delete(k)))
  } catch {
    // ignore — a reload against the no-cache index.html still refreshes the shell
  }
}

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
 *  (offline, 401, malformed) so a transient blip never surfaces a false bar.
 *  Exported so the Settings → Advanced → Diagnostics "Build" row can run the
 *  same probe on demand (a manual mirror of the background heartbeat). */
export async function fetchServedSha(): Promise<string | null> {
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
    // The EMBEDDED FRONTEND sha (from dist/version.json, stamped by
    // vite.config.ts), NOT `data.current.sha` (the BACKEND build sha from
    // build.rs). A server-only deploy re-embeds nothing, so frontend_sha is
    // byte-identical and equals this bundle's __APP_BUILD_SHA__ → no false bar;
    // a genuine frontend rebuild changes it → the bar shows and clears on reload.
    // Deliberately NO fallback to current.sha — that would reintroduce the
    // stuck-bar bug. Absent/unparseable frontend_sha → null → no bar (honoring
    // the existing "transient/unknown never shows a false bar" contract).
    const sha = env?.data?.frontend_sha
    return isRealSha(sha) ? sha : null
  } catch {
    return null
  }
}

/**
 * Adopt the newer build for the version-mismatch path — deliberately robust
 * against a wedged/absent SW/precache, since that is the exact case this guard
 * exists to rescue.
 *
 * FIRST, unconditionally clear ALL Cache Storage: whatever happens next ends in a
 * `location.reload()`, and a wedged CacheFirst/precache bucket could otherwise
 * hand the reload the very stale chunks we are trying to escape. With the caches
 * emptied and the server serving `index.html` `no-cache`, the reload is forced to
 * refetch the fresh shell + its fresh hashed chunks from the network.
 *
 * THEN:
 *   1. Force the SW to re-check (`registration.update()`) so a genuinely waiting
 *      worker is discovered even if the plugin's callback was missed.
 *   2. If one IS waiting, adopt it the clean way: SKIP_WAITING →
 *      `controllerchange` → reload (with a short timeout fallback in case
 *      `controllerchange` never lands).
 *   3. Otherwise a BOUNDED last resort. The FIRST tap is a plain reload — the
 *      server's `no-cache` index.html now yields the fresh bundle, so that alone
 *      normally fixes it. If the guard STILL fires after that reload and the user
 *      taps AGAIN, escalate: `unregister()` the SW so the next load is fully
 *      network-fresh and re-registers on the new bundle, then reload. The attempt
 *      counter is cleared the moment the page is found current (see `check`), so
 *      it can never loop or bleed into an unrelated future deploy.
 */
export async function adoptNewBuild(): Promise<void> {
  // Escape a wedged precache first — every branch below ends in a reload.
  await clearAllCaches()
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
      window.setTimeout(() => location.reload(), 2_000)
      return
    }
    // No waiting worker — bounded escalation.
    const attempt = readAttempt()
    bumpAttempt()
    if (attempt >= 1) {
      // Second (or later) tap: the plain reload did not clear the mismatch.
      // Fully de-register so the next load re-registers on the new bundle.
      await reg?.unregister?.()
    }
  } catch {
    // fall through to a plain reload
  }
  location.reload()
}

/**
 * Reconcile one served sha against this bundle's built sha and drive the bar.
 * Exported + pure of the network so it unit-tests headlessly.
 *
 *   * Server is on a NEWER build → surface the bar (idle-guard inside
 *     `markWaiting` still decides silent-adopt vs. one-tap button).
 *   * Server answered and we are CURRENT (equal shas) → retract any bar a
 *     previous poll surfaced so it clears on its own, and reset the bounded
 *     adopt-escalation counter so a future, unrelated deploy starts fresh.
 *   * Served sha unavailable (offline / 401 / dev) → leave the bar untouched: a
 *     transient blip must never dismiss a legitimately-shown bar.
 */
export function reconcileServedSha(served: unknown, built: unknown): void {
  if (isNewerServedSha(served, built)) {
    markWaiting(() => void adoptNewBuild())
  } else if (isRealSha(served)) {
    markCurrent()
    clearAttempt()
  }
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
    reconcileServedSha(await fetchServedSha(), __APP_BUILD_SHA__)
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

/**
 * The served-version heartbeat decision (`lib/version-guard.ts`).
 * ─────────────────────────────────────────────────────────────────────────────
 * This guard is the SW-lifecycle-INDEPENDENT path to the reload bar: a PWA
 * wedged on an ancient service worker (one that can never fire `onNeedRefresh`)
 * still surfaces the bar because the running bundle asks the live server "what
 * sha are you?" and compares it to the sha it was built from. These tests pin
 * the load-bearing decision so it can never regress into either a stuck-stale
 * bundle (missed mismatch) or a false-positive bar (offline blip, dev build).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  adoptNewBuild,
  fetchServedSha,
  isNewerServedSha,
  isRealSha,
  reconcileServedSha,
} from '../../src/lib/version-guard'
import {
  __resetSWUpdateForTest,
  getSWUpdateWaiting,
  markWaiting,
} from '../../src/lib/sw-update'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('isRealSha — a comparable git sha, not the dev sentinel', () => {
  test('a 40-char hex sha is real', () => {
    expect(isRealSha(A)).toBe(true)
  })
  test('a short (7-char) sha is real', () => {
    expect(isRealSha('abc1234')).toBe(true)
  })
  test('"dev" is NOT a real sha', () => {
    expect(isRealSha('dev')).toBe(false)
  })
  test('null / undefined / non-hex are not real', () => {
    expect(isRealSha(null)).toBe(false)
    expect(isRealSha(undefined)).toBe(false)
    expect(isRealSha('')).toBe(false)
    expect(isRealSha('v0.5.0')).toBe(false)
    expect(isRealSha(123 as unknown)).toBe(false)
  })
})

describe('isNewerServedSha — surface the bar IFF a genuinely newer build is live', () => {
  test('server on a different real sha than this bundle → surface', () => {
    expect(isNewerServedSha(B, A)).toBe(true)
  })
  test('equal shas → no bar (the page is already current)', () => {
    expect(isNewerServedSha(A, A)).toBe(false)
  })
  test('NO false positive when the server sha is unavailable (offline / 401)', () => {
    expect(isNewerServedSha(null, A)).toBe(false)
  })
  test('a dev build never compares (nothing to adopt)', () => {
    expect(isNewerServedSha(B, 'dev')).toBe(false)
    expect(isNewerServedSha('dev', A)).toBe(false)
  })
})

describe('reconcileServedSha — the bar surfaces on a newer build, retracts when current', () => {
  beforeEach(() => {
    __resetSWUpdateForTest()
    // A visible tab (no document.visibilityState === 'hidden') so markWaiting
    // surfaces the button rather than silently adopting.
  })
  afterEach(() => {
    __resetSWUpdateForTest()
  })

  test('server on a newer real sha → the bar shows', () => {
    reconcileServedSha(B, A)
    expect(getSWUpdateWaiting()).toBe(true)
  })

  test('served == built → a previously-shown bar RETRACTS (clears on its own)', () => {
    // A bar is up from an earlier poll.
    markWaiting(() => {})
    expect(getSWUpdateWaiting()).toBe(true)
    // Next poll finds us current → the bar clears.
    reconcileServedSha(A, A)
    expect(getSWUpdateWaiting()).toBe(false)
  })

  test('a null served sha (offline / 401) leaves a shown bar untouched', () => {
    markWaiting(() => {})
    expect(getSWUpdateWaiting()).toBe(true)
    reconcileServedSha(null, A)
    expect(getSWUpdateWaiting()).toBe(true)
  })
})

describe('fetchServedSha — reads the EMBEDDED FRONTEND sha, not the backend build sha', () => {
  type G = { window?: unknown; fetch?: unknown }
  const g = globalThis as unknown as G
  const saved: G = {}

  beforeEach(() => {
    saved.window = g.window
    saved.fetch = g.fetch
    // A minimal window so fetchServedSha's `window._SUPERMUX_BASE_URL` read works.
    g.window = { _SUPERMUX_BASE_URL: '', _SUPERMUX_AUTH_TOKEN: undefined }
  })
  afterEach(() => {
    if (saved.window === undefined) delete g.window
    else g.window = saved.window
    if (saved.fetch === undefined) delete g.fetch
    else g.fetch = saved.fetch
  })

  /** Stub the network with one `/api/version` envelope. */
  const stubVersion = (data: unknown) => {
    g.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ ok: true, data }),
    }))
  }

  test('returns data.frontend_sha, NOT data.current.sha (a server-only deploy)', async () => {
    // Backend build sha (B) differs from the embedded FRONTEND sha (A) — the
    // exact server-only-deploy shape. The guard must read the FRONTEND sha.
    stubVersion({ current: { sha: B }, frontend_sha: A })
    expect(await fetchServedSha()).toBe(A)
  })

  test('missing frontend_sha → null (no fallback to current.sha — that was the bug)', async () => {
    stubVersion({ current: { sha: B } })
    expect(await fetchServedSha()).toBeNull()
  })

  test('null / unparseable frontend_sha → null', async () => {
    stubVersion({ current: { sha: B }, frontend_sha: null })
    expect(await fetchServedSha()).toBeNull()
    stubVersion({ current: { sha: B }, frontend_sha: 'not-a-sha' })
    expect(await fetchServedSha()).toBeNull()
  })
})

describe('server-only deploy does NOT surface the bar (the regression this fixes)', () => {
  beforeEach(() => __resetSWUpdateForTest())
  afterEach(() => __resetSWUpdateForTest())

  test('backend sha differs but the frontend sha EQUALS the built sha → no bar', () => {
    // The running bundle was built at sha A (its __APP_BUILD_SHA__). A backend-
    // only deploy leaves the embedded frontend unchanged, so the server reports
    // frontend_sha = A even though its backend build sha moved to B. Reconciling
    // the FRONTEND sha (A) against the built sha (A) must NOT surface a bar.
    reconcileServedSha(A, A)
    expect(getSWUpdateWaiting()).toBe(false)
  })

  test('a genuine frontend deploy (frontend sha differs) → the bar shows', () => {
    // A real frontend rebuild re-embeds a new version.json (sha B) while the
    // running bundle is still A → the bar surfaces.
    reconcileServedSha(B, A)
    expect(getSWUpdateWaiting()).toBe(true)
  })
})

describe('adoptNewBuild — force-clears Cache Storage then reloads', () => {
  type G = {
    caches?: unknown
    navigator?: unknown
    location?: unknown
    window?: unknown
    sessionStorage?: unknown
  }
  const g = globalThis as unknown as G
  const saved: G = {}

  beforeEach(() => {
    for (const k of ['caches', 'navigator', 'location', 'sessionStorage'] as const) {
      saved[k] = g[k]
    }
  })
  afterEach(() => {
    for (const k of ['caches', 'navigator', 'location', 'sessionStorage'] as const) {
      if (saved[k] === undefined) delete g[k]
      else g[k] = saved[k]
    }
  })

  test('deletes every cache bucket and calls location.reload()', async () => {
    const deleted: string[] = []
    g.caches = {
      keys: async () => ['supermux-html', 'supermux-assets', 'workbox-precache'],
      delete: async (k: string) => {
        deleted.push(k)
        return true
      },
    }
    // No service worker registration → the bounded-reload path.
    g.navigator = { serviceWorker: { getRegistration: async () => undefined } }
    const reload = mock(() => {})
    g.location = { reload }
    g.sessionStorage = {
      _m: new Map<string, string>(),
      getItem(k: string) {
        return this._m.get(k) ?? null
      },
      setItem(k: string, v: string) {
        this._m.set(k, v)
      },
      removeItem(k: string) {
        this._m.delete(k)
      },
    }

    await adoptNewBuild()

    expect(deleted.sort()).toEqual([
      'supermux-assets',
      'supermux-html',
      'workbox-precache',
    ])
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

/**
 * THE VIEWER IDENTITY PLANE — the resolution rules, the member lock, and the
 * login gate's verify call.
 * ─────────────────────────────────────────────────────────────────────────────
 * These four owner-reported invite failures all had ONE root cause: the web
 * client had no identity concept at all. It read the admin bearer off
 * `window._SUPERMUX_AUTH_TOKEN` and assumed the owner, so a token-less shell (a
 * company / quick-tunnel host) behaved like a signed-in owner shell with a
 * broken API — which is how an anonymous visitor got the Bot-Mode onboarding
 * intro and an invited colleague got the HQ admin shell.
 *
 * What is pinned here is every decision that is a PURE function of the identity,
 * at the level this repo can test without a DOM (see `botmode-onboarding.test.ts`
 * for the same discipline): the `/auth/me` → viewer mapping, the owner
 * short-circuit that keeps the owner path synchronous, the member lock's
 * SEALED setters, and the three-outcome key check.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

type Store = Record<string, string>

/** A minimal in-memory `localStorage` (this repo has no jsdom).
 *
 *  ONE object for the whole file, cleared between tests rather than replaced:
 *  `zustand/persist` resolves its storage ONCE, when the store module is first
 *  imported, and holds that reference — so swapping the global out from under a
 *  cached module would silently send every later write to an orphan. */
const storageMap: Store = {}
const storageDouble = {
  getItem: (k: string) => (k in storageMap ? storageMap[k] : null),
  setItem: (k: string, v: string) => {
    storageMap[k] = v
  },
  removeItem: (k: string) => {
    delete storageMap[k]
  },
}
function installStorage(seed: Store = {}) {
  for (const k of Object.keys(storageMap)) delete storageMap[k]
  Object.assign(storageMap, seed)
  ;(globalThis as { localStorage?: unknown }).localStorage = storageDouble
  return storageMap
}

/** A minimal `window` carrying only what the modules under test read. */
function installWindow(opts: { token?: string; search?: string; pathname?: string } = {}) {
  const w = {
    _SUPERMUX_AUTH_TOKEN: opts.token,
    // bun has no `import.meta.env.BASE_URL`; the runtime override is the same
    // one the Capacitor wrap uses, so this exercises the real code path.
    _SUPERMUX_BASE_URL: '',
    location: {
      search: opts.search ?? '',
      pathname: opts.pathname ?? '/',
      protocol: 'https:',
      host: 'acme.test',
    },
    localStorage: (globalThis as { localStorage?: unknown }).localStorage,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  ;(globalThis as { window?: unknown }).window = w
  return w
}

/** Swap in a fetch double, returning the calls it saw. */
function installFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  ;(globalThis as { fetch?: unknown }).fetch = (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Promise.resolve(handler(String(url), init))
  }
  return calls
}

/** A `Response`-shaped double — only `ok`, `status` and `json()` are read. */
function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) }
}

const realFetch = globalThis.fetch

beforeEach(() => {
  installStorage()
  installWindow()
})
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
  delete (globalThis as { window?: unknown }).window
  ;(globalThis as { fetch?: unknown }).fetch = realFetch
})

// ── the pure mapping ─────────────────────────────────────────────────────────

describe('viewerFromMe', () => {
  const load = () => import('../../src/lib/viewer')

  test('an unauthenticated answer is ANON — the login gate, never the app', async () => {
    const { viewerFromMe } = await load()
    expect(viewerFromMe({ authenticated: false }).kind).toBe('anon')
    expect(viewerFromMe(null).kind).toBe('anon')
    expect(viewerFromMe(undefined).kind).toBe('anon')
    // A malformed / half-written payload must not be read as authenticated.
    expect(viewerFromMe({} as never).kind).toBe('anon')
  })

  test('the owner bearer answer is OWNER', async () => {
    const { viewerFromMe } = await load()
    const v = viewerFromMe({
      authenticated: true,
      identity: { role: 'owner', company_id: null },
    })
    expect(v.kind).toBe('owner')
  })

  test('an ADMIN-ALL human (company_id null) is owner-equivalent', async () => {
    const { viewerFromMe } = await load()
    // Mirrors the server: `is_admin_or_owner` requires `company_id.is_none()`.
    const v = viewerFromMe({
      authenticated: true,
      identity: { role: 'admin', company_id: null, user_id: 4 },
    })
    expect(v.kind).toBe('owner')
  })

  test('a company-scoped human is a MEMBER — whatever the role string claims', async () => {
    const { viewerFromMe } = await load()
    const v = viewerFromMe({
      authenticated: true,
      identity: {
        user_id: 7,
        email: 'sam@acme.test',
        display_name: 'Sam',
        company_id: 3,
        // A forged role must NOT widen the UI — the server applies the same
        // `company_id is none` conjunct, so the client must agree.
        role: 'owner',
      },
    })
    expect(v).toEqual({
      kind: 'member',
      userId: 7,
      companyId: 3,
      role: 'owner',
      displayName: 'Sam',
      email: 'sam@acme.test',
    })
  })

  test('a member with missing optional fields still resolves (no crash, no owner)', async () => {
    const { viewerFromMe } = await load()
    const v = await Promise.resolve(
      viewerFromMe({ authenticated: true, identity: { company_id: 2 } }),
    )
    expect(v.kind).toBe('member')
    if (v.kind === 'member') {
      expect(v.displayName).toBe('')
      expect(v.email).toBe('')
      expect(v.role).toBe('member')
    }
  })
})

describe('needsDisplayName — the welcome-sheet gate', () => {
  const load = () => import('../../src/lib/viewer')

  test('a member with no name is asked once', async () => {
    const { needsDisplayName } = await load()
    expect(
      needsDisplayName({
        kind: 'member',
        userId: 1,
        companyId: 1,
        role: 'member',
        displayName: '',
        email: 'a@b.c',
      }),
    ).toBe(true)
  })

  test('a whitespace-only placeholder still counts as unnamed', async () => {
    const { needsDisplayName } = await load()
    expect(
      needsDisplayName({
        kind: 'member',
        userId: 1,
        companyId: 1,
        role: 'member',
        displayName: '   ',
        email: '',
      }),
    ).toBe(true)
  })

  test('a member who already has a name is never asked again', async () => {
    const { needsDisplayName } = await load()
    expect(
      needsDisplayName({
        kind: 'member',
        userId: 1,
        companyId: 1,
        role: 'member',
        displayName: 'Sam',
        email: '',
      }),
    ).toBe(false)
  })

  test('the owner and an anon viewer are never asked', async () => {
    const { needsDisplayName, isOwnerPlane } = await load()
    expect(needsDisplayName({ kind: 'owner' })).toBe(false)
    expect(needsDisplayName({ kind: 'anon' })).toBe(false)
    expect(needsDisplayName({ kind: 'pending' })).toBe(false)
    // …and `pending` is fail-closed for the admin plane.
    expect(isOwnerPlane({ kind: 'pending' })).toBe(false)
    expect(isOwnerPlane({ kind: 'owner' })).toBe(true)
  })
})

describe('the stored access key', () => {
  const load = () => import('../../src/lib/viewer')

  test('round-trips, and clearing removes it', async () => {
    const { storedAccessKey, storeAccessKey, clearAccessKey } = await load()
    expect(storedAccessKey()).toBe('')
    expect(storeAccessKey('k-123')).toBe(true)
    expect(storedAccessKey()).toBe('k-123')
    clearAccessKey()
    expect(storedAccessKey()).toBe('')
  })

  test('private-mode storage degrades honestly rather than throwing', async () => {
    const { storedAccessKey, storeAccessKey, clearAccessKey } = await load()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      },
      removeItem: () => {
        throw new Error('storage disabled')
      },
    }
    expect(storedAccessKey()).toBe('')
    // `false`, not a throw — the gate tells the user it won't be remembered.
    expect(storeAccessKey('k')).toBe(false)
    expect(() => clearAccessKey()).not.toThrow()
    installStorage()
  })
})

// ── the login gate's key check ───────────────────────────────────────────────

describe('verifyAccessKey — three outcomes, not two', () => {
  test('a key the server accepts is `ok`, and rides as a Bearer', async () => {
    const calls = installFetch(() => jsonRes({ authenticated: true, identity: { role: 'owner' } }))
    const { verifyAccessKey } = await import('../../src/lib/api/auth')
    expect(await verifyAccessKey('good-key')).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/auth/me')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer good-key')
    // Same-origin credentials so a cookie viewer is answered too.
    expect(calls[0]!.init?.credentials).toBe('same-origin')
  })

  test('a wrong key is `rejected` — 200 `{authenticated:false}`, not an error', async () => {
    installFetch(() => jsonRes({ authenticated: false }))
    const { verifyAccessKey } = await import('../../src/lib/api/auth')
    expect(await verifyAccessKey('bad-key')).toBe('rejected')
  })

  test('an unreachable server is `unreachable`, never silently "wrong key"', async () => {
    ;(globalThis as { fetch?: unknown }).fetch = () => Promise.reject(new Error('offline'))
    const { verifyAccessKey } = await import('../../src/lib/api/auth')
    expect(await verifyAccessKey('any')).toBe('unreachable')
    // A 5xx is equally not a verdict on the key.
    installFetch(() => jsonRes({}, false, 502))
    expect(await verifyAccessKey('any')).toBe('unreachable')
  })
})

// ── the member lock (ui-store) ───────────────────────────────────────────────

describe('the member lock', () => {
  test('locking forces bot mode ON and pins the scope to their company', async () => {
    const { useUI } = await import('../../src/stores/ui-store')
    useUI.setState({ botMode: false, activeCompany: null, memberCompany: null })

    useUI.getState().lockToCompany(42)

    expect(useUI.getState().botMode).toBe(true)
    expect(useUI.getState().activeCompany).toBe(42)
    expect(useUI.getState().memberCompany).toBe(42)
  })

  test('the setters are SEALED while it holds — no UI action can escape', async () => {
    const { useUI } = await import('../../src/stores/ui-store')
    useUI.getState().lockToCompany(42)

    // The Settings toggle, the Bot-Mode intro, the scope switcher's ⌘1 (HQ),
    // and `useCompanyScope`'s stale-id reconcile all funnel through these two.
    useUI.getState().setBotMode(false)
    useUI.getState().setActiveCompany(null)
    useUI.getState().setActiveCompany(99)

    expect(useUI.getState().botMode).toBe(true)
    expect(useUI.getState().activeCompany).toBe(42)
  })

  test('with NO lock the setters behave exactly as they always did (owner path)', async () => {
    const { useUI } = await import('../../src/stores/ui-store')
    useUI.setState({ botMode: false, activeCompany: null, memberCompany: null })

    useUI.getState().setBotMode(true)
    expect(useUI.getState().botMode).toBe(true)
    useUI.getState().setActiveCompany(7)
    expect(useUI.getState().activeCompany).toBe(7)
    useUI.getState().setActiveCompany(null)
    expect(useUI.getState().activeCompany).toBe(null)
    useUI.getState().setBotMode(false)
    expect(useUI.getState().botMode).toBe(false)
  })

  test('the lock is NEVER persisted — it is re-derived from /auth/me each load', async () => {
    const { useUI } = await import('../../src/stores/ui-store')
    useUI.getState().lockToCompany(42)
    // Asserted against `persistedUISlice` — the function wired in as the
    // middleware's `partialize`, i.e. the thing that decides what reaches
    // localStorage — rather than against a storage double: bun shares ONE module
    // registry across test files, so whichever file imports the store first owns
    // the storage `zustand/persist` captured, and reading it here would make
    // this test depend on file order.
    const { persistedUISlice } = await import('../../src/stores/ui-store')
    const persisted = persistedUISlice(useUI.getState()) as unknown as Record<string, unknown>
    expect('memberCompany' in persisted).toBe(false)
    // …while the ordinary preferences still persist exactly as before.
    expect(persisted.activeCompany).toBe(42)
    expect(persisted.botMode).toBe(true)
    expect(persisted.viewMode).toBe(useUI.getState().viewMode)
  })
})

// ── nav filtering ────────────────────────────────────────────────────────────

describe('bottomNavItems — the owner plane leaves the tab bar for a member', () => {
  test('the owner tab bar is unchanged, with Settings present', async () => {
    const { bottomNavItems } = await import('../../src/components/layout')
    const base = bottomNavItems(false).map((i) => i.to)
    expect(base).toContain('/settings')
    // The default call signature (no second argument) must stay owner-shaped —
    // every existing caller and test relies on it.
    expect(bottomNavItems(false, true).map((i) => i.to)).toEqual(base)
  })

  test('a member loses Settings and keeps everything their company reaches', async () => {
    const { bottomNavItems } = await import('../../src/components/layout')
    const member = bottomNavItems(true, false).map((i) => i.to)
    expect(member).not.toContain('/settings')
    // Their own company's surfaces stay: the roster, files, tools, flows.
    expect(member).toContain('/')
    expect(member).toContain('/files')
    expect(member).toContain('/store')
    expect(member).toContain('/workflows')
  })
})

// ── what the gate may honestly offer ─────────────────────────────────────────
//
// Owner-reported: on a company host with Google OIDC configured and verified
// "Ready", the login gate still showed only "This is a private workspace /
// Access key". The server ran the full OIDC start at `GET /auth/login` the whole
// time; nothing in the payload said so. The anonymous `/auth/me` answer now
// carries that one bit, and this is the pure reader of it — deliberately strict,
// because every "maybe" here paints a button that lands on a 404.

describe('loginCapabilitiesFromMe', () => {
  const load = () => import('../../src/lib/viewer')

  test('an anon answer that offers Google says so', async () => {
    const { loginCapabilitiesFromMe } = await load()
    expect(
      loginCapabilitiesFromMe({ authenticated: false, login: { google: true } }),
    ).toEqual({ google: true })
  })

  test('an older server — no `login` block at all — offers nothing', async () => {
    const { loginCapabilitiesFromMe } = await load()
    expect(loginCapabilitiesFromMe({ authenticated: false })).toEqual({ google: false })
    expect(loginCapabilitiesFromMe({ authenticated: false, login: null })).toEqual({
      google: false,
    })
  })

  test('a missing / malformed payload offers nothing — fail closed', async () => {
    const { loginCapabilitiesFromMe } = await load()
    for (const bad of [null, undefined, {}, { login: {} }]) {
      expect(loginCapabilitiesFromMe(bad as never)).toEqual({ google: false })
    }
  })

  test('only a literal `true` counts — a truthy string is not a capability', async () => {
    const { loginCapabilitiesFromMe } = await load()
    for (const truthy of ['true', 1, {}]) {
      expect(
        loginCapabilitiesFromMe({ login: { google: truthy } } as never).google,
      ).toBe(false)
    }
  })

  test('the shipped default is nothing on offer', async () => {
    const { NO_LOGIN_CAPABILITIES } = await load()
    expect(NO_LOGIN_CAPABILITIES).toEqual({ google: false })
  })
})

/**
 * The shared-browser workspace's data layer — the wire, and the honesty.
 * ─────────────────────────────────────────────────────────────────────────────
 * Two classes of bug live here and neither shows up in a screenshot:
 *
 *   · a request that goes to the wrong door. The human's tab CRUD is BEARER-
 *     gated (`/api/browser/*`); the agent's is hook-token'd somewhere else
 *     entirely. A method or a path that drifts is a security-shaped bug, so
 *     every verb is pinned against the routes in
 *     `server/src/connectors/browser/api.rs`.
 *
 *   · a tab that lies about its sign-in. `tabState` is the ONLY place the
 *     workspace resolves `live` × `login_state` into a label, precisely so no
 *     surface can invent a green dot. The cases below are the ones that would
 *     mislead a human into handing an agent a dead tab — a dehydrated tab whose
 *     last known state was `ok`, a live tab nothing has ever probed, and an
 *     expired tab, which must name the browser restart that caused it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { ApiError } from '../../src/lib/api/client'
import {
  activeGrantees,
  ago,
  closeTabPage,
  createTab,
  displayUrl,
  grantCandidates,
  mayGrantAll,
  tabGrantNeedsRestart,
  deleteTab,
  granteeLabel,
  grantTab,
  isSecure,
  listTabs,
  navigateTab,
  normalizeUrl,
  openTab,
  parseAddress,
  patchTab,
  revokeTabGrant,
  sortTabs,
  tabHost,
  tabState,
  type BrowserTab,
  type TabGrant,
} from '../../src/lib/api/browser'
import {
  TakeoverSocket,
  subjectPath,
  type SocketLike,
} from '../../src/lib/browser/takeover-socket'
import { settled, tabErrorMessage } from '../../src/hooks/use-browser-tabs'

/** A tab row, as `GET /api/browser/tabs` renders one. */
function tab(over: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: 'tb_one',
    title: 'Inbox',
    url: 'https://mail.example/inbox',
    pinned: false,
    company_id: null,
    origins: ['mail.example'],
    login_state: 'ok',
    last_probe_at: 1_000,
    live: true,
    grants: [],
    created_at: 0,
    last_used_at: 500,
    ...over,
  }
}

/* ── honest state ────────────────────────────────────────────────────────── */

describe('tabState — the tab never claims more than it knows', () => {
  test('needs_login is the FIRST thing said, even on a live tab', () => {
    const s = tabState(tab({ login_state: 'needs_login', live: true }), 1_360)
    expect(s.tone).toBe('needs-login')
    expect(s.label).toBe('Sign-in needed')
    expect(s.detail).toContain('sign in again')
  })

  test('an EXPIRED, DEHYDRATED tab names the browser restart that caused it', () => {
    // §7.1a: session cookies do not survive a Chrome restart, and the reaper
    // restarts Chrome by design — so this is the common path, not a rare one.
    // A generic "error" here sends the human hunting for a fault that is not
    // theirs.
    const s = tabState(tab({ login_state: 'needs_login', live: false }), 1_360)
    expect(s.tone).toBe('needs-login')
    expect(s.detail).toContain('browser restart')
  })

  test('a DEHYDRATED tab whose last state was ok does NOT read as signed in', () => {
    // The tell that matters: `login_state` is stale the moment the page is gone.
    // Rendering "Signed in" here is exactly the false green light §7.3 forbids.
    const s = tabState(tab({ login_state: 'ok', live: false }), 1_360)
    expect(s.tone).toBe('dehydrated')
    expect(s.label).toBe('Asleep')
    expect(s.detail).not.toContain('Signed in')
  })

  test('signed in states its evidence AND its age', () => {
    const s = tabState(tab({ login_state: 'ok', live: true, last_probe_at: 1_000 }), 1_360)
    expect(s.tone).toBe('ok')
    expect(s.detail).toBe('Signed in · verified 6 min ago')
  })

  test('signed in with NO probe says so rather than dating a check that never ran', () => {
    const s = tabState(tab({ login_state: 'ok', last_probe_at: null }), 1_360)
    expect(s.detail).toContain('not verified yet')
  })

  test('unknown is never dressed up as ok', () => {
    const s = tabState(tab({ login_state: 'unknown' }), 1_360)
    expect(s.tone).toBe('unknown')
    expect(s.label).toBe('Not verified')
    expect(s.detail).not.toContain('Signed in')
  })
})

describe('ago', () => {
  test('sub-minute is "just now", not "0 min ago"', () => {
    expect(ago(3)).toBe('just now')
    expect(ago(44)).toBe('just now')
  })
  test('a clock skew reads as just now rather than a future probe', () => {
    expect(ago(-90)).toBe('just now')
  })
  test('minutes, hours, days', () => {
    expect(ago(360)).toBe('6 min ago')
    expect(ago(7_200)).toBe('2 h ago')
    expect(ago(172_800)).toBe('2 d ago')
  })
})

describe('grantees', () => {
  test('a disabled grant row is NOT a grantee — it confers nothing', () => {
    const t = tab({
      grants: [
        { tab_id: 'tb_one', grantee: 'Ada', enabled: 1, granted_at: 0 },
        { tab_id: 'tb_one', grantee: 'Grace', enabled: 0, granted_at: 0 },
      ],
    })
    expect(activeGrantees(t)).toEqual(['Ada'])
  })
  test('the keyspace reads as words', () => {
    expect(granteeLabel('*')).toBe('All agents')
    expect(granteeLabel('@company:4', 'Acme')).toBe('Acme')
    expect(granteeLabel('Ada')).toBe('Ada')
  })
})

describe('rail ordering + url helpers', () => {
  test('pinned first, then most-recently-used', () => {
    const order = sortTabs([
      tab({ id: 'a', pinned: false, last_used_at: 900 }),
      tab({ id: 'b', pinned: true, last_used_at: 100 }),
      tab({ id: 'c', pinned: false, last_used_at: 950 }),
    ]).map((t) => t.id)
    expect(order).toEqual(['b', 'c', 'a'])
  })
  test('sortTabs does not mutate its input', () => {
    const input = [tab({ id: 'a' }), tab({ id: 'b', pinned: true })]
    sortTabs(input)
    expect(input.map((t) => t.id)).toEqual(['a', 'b'])
  })
  test('a padlock is only drawn for https', () => {
    expect(isSecure('https://a.example/x')).toBe(true)
    expect(isSecure('http://a.example/x')).toBe(false)
    expect(isSecure('not a url')).toBe(false)
  })
  test('tabHost falls back to the raw string rather than throwing', () => {
    expect(tabHost('https://mail.example/inbox')).toBe('mail.example')
    expect(tabHost('half-typed')).toBe('half-typed')
  })
  test('normalizeUrl refuses a non-http scheme outright', () => {
    expect(normalizeUrl('mail.example')).toBe('https://mail.example')
    expect(normalizeUrl('https://a.example')).toBe('https://a.example')
    expect(normalizeUrl('javascript:alert(1)')).toBe(null)
    expect(normalizeUrl('  ')).toBe(null)
  })
})

/* ── the omnibox: GO vs SEARCH ───────────────────────────────────────────── */

/**
 * The parse is the whole of complaint #2's second half.
 *
 * The box this replaces prefixed `https://` to ANYTHING without a scheme, so
 * `how to bake bread` became `https://how to bake bread`, the server's
 * `host_of` failed, and the human got a red toast reading "a tab needs an
 * http(s) URL" for typing a sentence into a search box. Every case below is a
 * branch a real browser has and that one did not.
 */
describe('parseAddress — one line of typing, one act', () => {
  test('a scheme is honoured verbatim', () => {
    expect(parseAddress('https://mail.example/inbox')).toEqual({
      kind: 'navigate',
      url: 'https://mail.example/inbox',
    })
    expect(parseAddress('  http://docs.internal/handbook  ')).toEqual({
      kind: 'navigate',
      url: 'http://docs.internal/handbook',
    })
  })

  test('a bare hostname gets https, keeping port, path and query', () => {
    expect(parseAddress('mail.example')).toEqual({
      kind: 'navigate',
      url: 'https://mail.example',
    })
    expect(parseAddress('a.b.co.uk/x?q=1#f')).toEqual({
      kind: 'navigate',
      url: 'https://a.b.co.uk/x?q=1#f',
    })
    expect(parseAddress('example.com:8080/path')).toEqual({
      kind: 'navigate',
      url: 'https://example.com:8080/path',
    })
  })

  test('loopback and IP literals go to http — https there has no certificate', () => {
    // The dev-server case. `https://localhost:3000` is the one prefix that is
    // wrong more often than it is right, and every real browser agrees.
    expect(parseAddress('localhost:3000')).toEqual({
      kind: 'navigate',
      url: 'http://localhost:3000',
    })
    expect(parseAddress('localhost')).toEqual({ kind: 'navigate', url: 'http://localhost' })
    expect(parseAddress('192.168.1.10:8080')).toEqual({
      kind: 'navigate',
      url: 'http://192.168.1.10:8080',
    })
    expect(parseAddress('[::1]:8080')).toEqual({ kind: 'navigate', url: 'http://[::1]:8080' })
  })

  test('a sentence SEARCHES instead of 400-ing', () => {
    expect(parseAddress('how to bake bread')).toEqual({
      kind: 'search',
      query: 'how to bake bread',
      url: 'https://www.google.com/search?q=how%20to%20bake%20bread',
    })
  })

  test('one word with no dot, a leading `?`, and a dotted non-host all search', () => {
    expect(parseAddress('github').kind).toBe('search')
    expect(parseAddress('?mail.example')).toEqual({
      kind: 'search',
      query: 'mail.example',
      url: 'https://www.google.com/search?q=mail.example',
    })
    // `3.5` is dotted but is not a host: a browser searches for it.
    expect(parseAddress('3.5').kind).toBe('search')
  })

  test('a non-http scheme is refused IN PLACE, naming itself', () => {
    const r = parseAddress('javascript:alert(1)')
    expect(r.kind).toBe('refuse')
    if (r.kind === 'refuse') expect(r.reason).toContain('javascript')
    expect(parseAddress('file:///etc/passwd').kind).toBe('refuse')
    expect(parseAddress('mailto:a@b.example').kind).toBe('refuse')
  })

  test('empty is a no-op, not a request', () => {
    expect(parseAddress('   ')).toEqual({ kind: 'empty' })
  })
})

describe('displayUrl — the idle form hides the noise, never the risk', () => {
  test('https and www are trimmed, a bare slash path drops', () => {
    expect(displayUrl('https://www.example.com/')).toBe('example.com')
    expect(displayUrl('https://mail.example/inbox?q=1')).toBe('mail.example/inbox?q=1')
  })
  test('http stays visible — hiding the insecure scheme is the phishing half', () => {
    expect(displayUrl('http://docs.internal/handbook')).toBe('http://docs.internal/handbook')
  })
  test('anything unparseable is echoed rather than thrown', () => {
    expect(displayUrl('half-typed')).toBe('half-typed')
    expect(displayUrl('')).toBe('')
  })
})

/* ── the wire ────────────────────────────────────────────────────────────── */

describe('the tab CRUD hits the HUMAN door, with the right verbs', () => {
  type G = { window?: unknown; fetch?: unknown }
  const g = globalThis as unknown as G
  const saved: G = {}
  let calls: Array<{ url: string; init?: RequestInit }> = []

  beforeEach(() => {
    saved.window = g.window
    saved.fetch = g.fetch
    g.window = { _SUPERMUX_BASE_URL: '', _SUPERMUX_AUTH_TOKEN: 'test-token' }
    calls = []
  })
  afterEach(() => {
    if (saved.window === undefined) delete g.window
    else g.window = saved.window
    if (saved.fetch === undefined) delete g.fetch
    else g.fetch = saved.fetch
  })

  const stub = (body: unknown) => {
    calls = []
    g.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => body }
    })
  }

  test('list unwraps `{tabs}` and survives an empty body', async () => {
    stub({ tabs: [tab()] })
    expect((await listTabs()).map((t) => t.id)).toEqual(['tb_one'])
    expect(calls[0].url).toBe('/api/browser/tabs')
    stub({})
    expect(await listTabs()).toEqual([])
  })

  test('create POSTs the url + an explicit company (null = HQ)', async () => {
    stub(tab())
    await createTab('https://mail.example')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      url: 'https://mail.example',
      company_id: null,
    })
  })

  test('the bearer rides every call', async () => {
    stub({ tabs: [] })
    await listTabs()
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-token')
  })

  test('pin is a PATCH of exactly one field', async () => {
    stub(tab({ pinned: true }))
    await patchTab('tb_one', { pinned: true })
    expect(calls[0].url).toBe('/api/browser/tabs/tb_one')
    expect(calls[0].init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ pinned: true })
  })

  test('grant POSTs to /grant; revoke DELETEs the ENCODED grantee', async () => {
    stub({ grants: [] })
    await grantTab('tb_one', '@company:4')
    expect(calls[0].url).toBe('/api/browser/tabs/tb_one/grant')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      grantee: '@company:4',
      enabled: true,
    })

    stub({ grants: [] })
    // A grantee is a PATH SEGMENT on revoke, and the keyspace contains `@` and
    // `:` — unencoded, `@company:4` is a different route (and a 404 the human
    // would read as "already revoked").
    await revokeTabGrant('tb_one', '@company:4')
    expect(calls[0].url).toBe('/api/browser/tabs/tb_one/grant/%40company%3A4')
    expect(calls[0].init?.method).toBe('DELETE')

    stub({ grants: [] })
    await revokeTabGrant('tb_one', '*')
    expect(calls[0].url).toBe('/api/browser/tabs/tb_one/grant/*')
  })

  test('create?open=true is the HUMAN path — a row that is already a page', async () => {
    stub(tab({ live: true }))
    await createTab('https://mail.example', null, true)
    expect(calls[0].url).toBe('/api/browser/tabs?open=true')
    expect(calls[0].init?.method).toBe('POST')
    // The agent's lazy path is unchanged and must stay the default.
    stub(tab())
    await createTab('https://mail.example')
    expect(calls[0].url).toBe('/api/browser/tabs')
  })

  test('navigate POSTs the url to /navigate — never PATCH, which is a lie', async () => {
    // PATCH {url} writes the COLUMN: the text would change and the page would
    // not move. The navigate door wakes the tab and drives the page.
    stub(tab({ live: true, url: 'https://elsewhere.example' }))
    const t = await navigateTab('tb_one', 'https://elsewhere.example')
    expect(calls[0].url).toBe('/api/browser/tabs/tb_one/navigate')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      url: 'https://elsewhere.example',
    })
    expect(t.live).toBe(true)
  })

  test('open wakes a dehydrated tab, with the id ENCODED and no body', async () => {
    stub(tab({ live: true }))
    await openTab('tb one/2')
    expect(calls[0].url).toBe('/api/browser/tabs/tb%20one%2F2/open')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.body).toBeUndefined()
  })

  test('close DEHYDRATES and delete DESTROYS — two doors, never one', async () => {
    // The row, the grants and the cookies survive a close; only the page goes.
    stub({ ...tab({ live: false }), closed: true })
    const c = await closeTabPage('tb_one')
    expect(calls[0].url).toBe('/api/browser/tabs/tb_one/close')
    expect(calls[0].init?.method).toBe('POST')
    expect(c.closed).toBe(true)
    expect(c.live).toBe(false)
  })

  test('delete is honest that it clears no cookies', async () => {
    stub({ deleted: true, cookies_cleared: false, note: 'the tab is gone' })
    const r = await deleteTab('tb_one')
    expect(calls[0].init?.method).toBe('DELETE')
    expect(r.cookies_cleared).toBe(false)
  })
})

/* ── the socket's subject ────────────────────────────────────────────────── */

describe('a tab attaches to the TAB route, a session to the session route', () => {
  test('subjectPath', () => {
    expect(subjectPath({ kind: 'tab', id: 'tb_9f' })).toBe('/ws/browser/tab/tb_9f')
    expect(subjectPath({ kind: 'session', name: 'ada bot' })).toBe(
      '/ws/browser/ada%20bot/takeover',
    )
  })

  test('the socket dials the tab route for a tab subject', () => {
    let dialled = ''
    const sock: SocketLike = {
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    }
    new TakeoverSocket(
      { kind: 'tab', id: 'tb_9f' },
      () => {},
      () => {},
      {
        baseUrl: () => 'ws://bench',
        token: () => 'x',
        factory: (u) => {
          dialled = u
          return sock
        },
      },
    ).start()
    expect(dialled).toBe('ws://bench/ws/browser/tab/tb_9f')
  })

  test('a bare string is STILL the session route (the in-chat card is unchanged)', () => {
    let dialled = ''
    const sock: SocketLike = {
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    }
    new TakeoverSocket(
      'ada',
      () => {},
      () => {},
      {
        baseUrl: () => 'ws://bench',
        token: () => 'x',
        factory: (u) => {
          dialled = u
          return sock
        },
      },
    ).start()
    expect(dialled).toBe('ws://bench/ws/browser/ada/takeover')
  })
})

/* ── failure is visible ──────────────────────────────────────────────────── */

describe('a refused mutation says so', () => {
  test('the message carries the SERVER\'s words, not a generic failure', () => {
    // The refusal a human will actually hit: company containment. Its whole
    // value is the sentence the server wrote — "grant failed" alone leaves them
    // guessing at a rule they cannot see.
    const msg = tabErrorMessage(
      'grant',
      new ApiError(400, "'Ada' is not in this tab's company; a tab is never shared across companies"),
    )
    expect(msg).toContain('Grant failed')
    expect(msg).toContain("not in this tab's company")
  })

  test('every verb has its own lead, and a wordless error still reads', () => {
    expect(tabErrorMessage('revoke', new Error('boom'))).toBe('Revoke failed — boom')
    expect(tabErrorMessage('pin', new Error(''))).toBe("Couldn't change the pin")
    expect(tabErrorMessage('close', undefined)).toBe("Couldn't close the tab")
  })

  test('settled resolves null instead of rejecting, so the spinner clears', async () => {
    // `onError` has already toasted by the time this runs; what `settled` adds
    // is that the caller's `finally` runs and no unhandled rejection escapes.
    expect(await settled(Promise.reject(new Error('nope')))).toBe(null)
    expect(await settled(Promise.resolve(7))).toBe(7)
  })

  test('EVERY mutation in the hook reports its failure', () => {
    // The blocker this suite exists for: a grant/revoke/close that failed
    // silently is indistinguishable from one that worked. Counted from source
    // because the alternative is a React renderer this suite does not have.
    const src = readFileSync(
      new URL('../../src/hooks/use-browser-tabs.ts', import.meta.url),
      'utf8',
    )
    const mutations = src.split('useMutation({').length - 1
    const reporters = src.split('onError:').length - 1
    expect(mutations).toBeGreaterThanOrEqual(5)
    expect(reporters).toBe(mutations)
  })
})

/* ── only offer what the server will accept ──────────────────────────────── */

describe('company containment shapes the OPTIONS, not just the outcome', () => {
  const bots = [
    { name: 'Ada', company_id: null },
    { name: 'Grace', company_id: 4 },
    { name: 'Linus', company_id: 7 },
  ]

  test('a company-owned tab offers only that company\'s bots', () => {
    const t = tab({ company_id: 4 })
    expect(grantCandidates(bots, t).map((b) => b.name)).toEqual(['Grace'])
  })

  test('an HQ tab offers only HQ bots — a company bot resolves to a company', () => {
    const t = tab({ company_id: null })
    expect(grantCandidates(bots, t).map((b) => b.name)).toEqual(['Ada'])
  })

  test('all-agents is a legal target ONLY for an HQ tab', () => {
    // `company_of_grant_target('*')` is None, so `*` on a company tab is a 400
    // every single time — the tier is hidden rather than drawn and refused.
    expect(mayGrantAll(tab({ company_id: null }))).toBe(true)
    expect(mayGrantAll(tab({ company_id: 4 }))).toBe(false)
  })

  test('the sheet scopes the company tier to the TAB, not the active roster', () => {
    const src = readFileSync(
      new URL('../../src/components/browser/tab-grant-sheet.tsx', import.meta.url),
      'utf8',
    )
    // The bug this pins: `useUI().activeCompany` is the globally-selected
    // company, which has nothing to do with which company owns this tab.
    expect(src).not.toContain('activeCompany')
    expect(src).toContain('companyOverride={company}')
    expect(src).toContain('allowAll={mayGrantAll(tab)}')
    expect(src).toContain('grantCandidates')
  })
})

/* ── lent ≠ usable ───────────────────────────────────────────────────────────
 *
 * The bug this section pins, measured live: the human lent a bot a tab, the bot
 * had no `browser_*` tools at all, and — with nothing on this surface saying so
 * — it improvised, then told its owner it had sent him a connect card that did
 * not exist. Lending a tab now grants the Shared Browser connector with it, but
 * a connector reaches a bot's toolset only at LAUNCH. So there is a real,
 * temporary in-between state, and the workspace has to name it rather than draw
 * a lend that silently does nothing.
 */
describe('a tab grant that has not reached the running bot yet', () => {
  const g = (over: Partial<TabGrant> = {}): TabGrant => ({
    tab_id: 'tb_a',
    grantee: 'folderwijzer',
    enabled: 1,
    granted_at: 10,
    ...over,
  })

  test('a grant made while the bot is running needs a restart', () => {
    expect(tabGrantNeedsRestart(g({ applied: false, running: true }))).toBe(true)
  })

  test('a bot that has restarted since is done — no nag', () => {
    expect(tabGrantNeedsRestart(g({ applied: true, running: true }))).toBe(false)
  })

  test('a STOPPED bot is not asked to restart — it binds on its next start', () => {
    // Drawing "Restart to apply" over a stopped bot is a button with nothing to
    // press: the grant is already waiting for the launch that has to happen anyway.
    expect(tabGrantNeedsRestart(g({ applied: false, running: false }))).toBe(false)
  })

  test('a `*` / company sentinel names no process, so it claims nothing', () => {
    // The server omits both fields for a sentinel (no one launch to compare
    // against). `undefined` must read as "no claim", never as "not applied".
    expect(tabGrantNeedsRestart(g({ grantee: '*' }))).toBe(false)
    expect(tabGrantNeedsRestart(g({ grantee: '@company:4' }))).toBe(false)
  })

  test('a switched-off grant is not a pending one', () => {
    expect(tabGrantNeedsRestart(g({ enabled: 0, applied: false, running: true }))).toBe(false)
  })

  test('the sheet says it in words AND gives the one tap that fixes it', () => {
    const src = readFileSync(
      new URL('../../src/components/browser/tab-grant-sheet.tsx', import.meta.url),
      'utf8',
    )
    expect(src).toContain('tabGrantNeedsRestart(g)')
    // Reuses the store's existing restart rung rather than growing a second one.
    expect(src).toContain('<RestartToApply name={g.grantee} />')
    expect(src).toContain('running without the browser tools')
  })
})

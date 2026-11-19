/**
 * <OauthConnectButton> + `beginSignIn` — the hop OUT of supermux.
 * ─────────────────────────────────────────────────────────────────────────────
 * The button renders "Sign in with {name}"; its click is `beginSignIn`, which
 * starts the server flow with the `return_to` the surface named, keeps the
 * pending key (incl. the opaque `state`) in THIS tab's storage, refuses a
 * non-`https:` authorize URL (no `assign`, pending cleared), and otherwise hands
 * the tab over with a top-level `assign`. No DOM here: the orchestration is the
 * exported function the button calls, the surface is `renderToStaticMarkup`.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { OauthConnectButton } from '../../src/components/store/oauth-connect-button'
import type { ConnectorCard } from '../../src/lib/api/connectors'
import { PENDING_KEY, beginSignIn, isHttpsUrl, readPending, type PendingStore } from '../../src/lib/oauth-pending'

class MemoryStorage implements PendingStore {
  map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
}

const card: ConnectorCard = {
  id: 'pmcp-inhouseseo',
  kind: 'mcp_catalog',
  display_name: 'InhouseSEO',
  icon: '',
  description: '',
  tools: [],
  credentials: [],
  auth: { kind: 'mcp_oauth' },
  source: 'catalog',
}

describe('<OauthConnectButton>', () => {
  test('renders "Sign in with InhouseSEO" as the one affordance', () => {
    const out = renderToStaticMarkup(<OauthConnectButton card={card} target="folderwijzer" returnTo="/store/pmcp-inhouseseo" />)
    expect(out).toContain('Sign in with InhouseSEO')
    expect(out).toContain('data-vr="connect-oauth"')
    expect(out).not.toContain('terminal')
  })

  test('its click is beginSignIn and nothing else', () => {
    const src = readFileSync(new URL('../../src/components/store/oauth-connect-button.tsx', import.meta.url), 'utf8')
    expect(src).toContain('await beginSignIn(')
    expect(src).not.toContain('window.open(')
    expect(src).toContain('window.location.assign(url)')
  })
})

describe('beginSignIn', () => {
  test('starts with return_to, writes the pending key incl. state, assigns on https', async () => {
    const store = new MemoryStorage()
    const calls: unknown[] = []
    const assigned: string[] = []
    const ok = await beginSignIn(
      {
        start: async (id, args) => {
          calls.push([id, args])
          return { authorize_url: 'https://as.example/authorize?state=abc', state: 'abc' }
        },
        store,
        assign: (u) => assigned.push(u),
        toast: () => {
          throw new Error('no toast on success')
        },
      },
      'pmcp-inhouseseo',
      'folderwijzer',
      '/store/pmcp-inhouseseo',
    )
    expect(ok).toBe(true)
    expect(calls).toEqual([['pmcp-inhouseseo', { session_name: 'folderwijzer', return_to: '/store/pmcp-inhouseseo' }]])
    expect(readPending(store)).toEqual({ id: 'pmcp-inhouseseo', target: 'folderwijzer', returnTo: '/store/pmcp-inhouseseo', state: 'abc' })
    expect(assigned).toEqual(['https://as.example/authorize?state=abc'])
  })

  test('refuses a non-https authorize URL: no assign, pending cleared, toast', async () => {
    const store = new MemoryStorage()
    const assigned: string[] = []
    const toasts: string[] = []
    for (const bad of ['http://as.example/authorize', 'javascript:alert(1)', 'not a url']) {
      const ok = await beginSignIn(
        {
          start: async () => ({ authorize_url: bad, state: 's' }),
          store,
          assign: (u) => assigned.push(u),
          toast: (m) => toasts.push(m),
        },
        'pmcp-inhouseseo',
        '*',
        '/store',
      )
      expect(ok).toBe(false)
    }
    expect(assigned).toEqual([])
    expect(store.getItem(PENDING_KEY)).toBeNull()
    expect(toasts.length).toBe(3)
    expect(toasts[0]).toContain("Couldn't start the sign-in")
    expect(isHttpsUrl('https://x/y')).toBe(true)
    expect(isHttpsUrl('http://x/y')).toBe(false)
  })

  test('a failed start leaves nothing pending and says why', async () => {
    const store = new MemoryStorage()
    store.setItem(PENDING_KEY, JSON.stringify({ id: 'old', state: 'old', target: '*', returnTo: '/store' }))
    const toasts: string[] = []
    const ok = await beginSignIn(
      {
        start: async () => {
          throw new Error('sign-in is not available on this address')
        },
        store,
        assign: () => {
          throw new Error('must not assign')
        },
        toast: (m) => toasts.push(m),
      },
      'pmcp-inhouseseo',
      '*',
      '/store',
    )
    expect(ok).toBe(false)
    expect(store.getItem(PENDING_KEY)).toBeNull()
    expect(toasts[0]).toContain('not available on this address')
  })
})

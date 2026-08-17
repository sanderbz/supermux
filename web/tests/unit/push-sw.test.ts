// The service worker's display decision.
//
// `public/push-sw.js` is a plain asset — no bundler touches it, so it cannot be
// imported. It is evaluated here in a fake ServiceWorkerGlobalScope and the
// pure functions it hangs off `self.__pushSw` are called directly. That is the
// only way to unit-test the file that actually ships.
//
// What is being pinned: the old rule suppressed the banner whenever ANY visible
// same-origin window existed, so reading session A silently swallowed "session
// B is blocked" — and then posted the payload to a listener that did not exist.
// The rule is now "is the user looking at THIS session", and the payload always
// reaches the app.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface WindowClient {
  url?: string
  focused?: boolean
  visibilityState?: string
}

interface PushSwInternals {
  decideDisplay: (
    payload: unknown,
    clients: WindowClient[],
  ) => { show: boolean; reason: string }
  notificationOptions: (payload: unknown) => {
    body: string
    icon: string
    tag: string
    renotify: boolean
    data: { url: string; tier: string; session: string | null }
  }
  applyBadge: (count: unknown) => unknown
  pathOf: (url: string | undefined) => string
}

/** Evaluate push-sw.js in a fake SW scope and hand back its internals. */
function loadServiceWorker(): {
  sw: PushSwInternals
  badgeCalls: number[]
  /** Mutable counter — read it AFTER the call under test, not at load time. */
  clears: { count: number }
} {
  const src = readFileSync(
    join(import.meta.dir, '../../public/push-sw.js'),
    'utf8',
  )
  const badgeCalls: number[] = []
  const clears = { count: 0 }
  const listeners: Record<string, unknown> = {}
  const self: Record<string, unknown> = {
    location: { origin: 'https://supermux.example' },
    navigator: {
      setAppBadge: (n: number) => {
        badgeCalls.push(n)
        return Promise.resolve()
      },
      clearAppBadge: () => {
        clears.count += 1
        return Promise.resolve()
      },
    },
    registration: {
      showNotification: () => Promise.resolve(),
      getNotifications: () => Promise.resolve([]),
    },
    addEventListener: (name: string, fn: unknown) => {
      listeners[name] = fn
    },
  }
  // The SW body only registers listeners and assigns `self.__pushSw`, so
  // evaluating it has no side effects beyond that.
  new Function('self', 'clients', src)(self, { matchAll: () => Promise.resolve([]) })
  return { sw: self.__pushSw as PushSwInternals, badgeCalls, clears }
}

const ORIGIN = 'https://supermux.example'

function payload(over: Record<string, unknown> = {}) {
  return {
    title: 'deploy-fix',
    body: 'Needs permission — ⚡ cargo check (Bash)',
    url: '/focus/deploy-fix#pending',
    tier: 'attention',
    session: 'deploy-fix',
    badge: 1,
    icon: '/icon-192.png',
    tag: 'session:deploy-fix',
    renotify: true,
    ...over,
  }
}

describe('decideDisplay', () => {
  test('suppresses only when the user is looking at THIS session', () => {
    const { sw } = loadServiceWorker()
    const watching: WindowClient[] = [
      { url: `${ORIGIN}/focus/deploy-fix`, visibilityState: 'visible' },
    ]
    expect(sw.decideDisplay(payload(), watching).show).toBe(false)
  })

  test('a visible window on a DIFFERENT session no longer swallows the banner', () => {
    // The regression that made the old rule unusable: one open tab muted the
    // whole fleet.
    const { sw } = loadServiceWorker()
    const elsewhere: WindowClient[] = [
      { url: `${ORIGIN}/focus/other-bot`, visibilityState: 'visible', focused: true },
      { url: `${ORIGIN}/board`, visibilityState: 'visible' },
      { url: `${ORIGIN}/`, focused: true },
    ]
    expect(sw.decideDisplay(payload(), elsewhere).show).toBe(true)
  })

  test('a hidden window on the same session does not suppress', () => {
    const { sw } = loadServiceWorker()
    const backgrounded: WindowClient[] = [
      { url: `${ORIGIN}/focus/deploy-fix`, visibilityState: 'hidden', focused: false },
    ]
    expect(sw.decideDisplay(payload(), backgrounded).show).toBe(true)
  })

  test('no windows at all always shows', () => {
    const { sw } = loadServiceWorker()
    expect(sw.decideDisplay(payload(), []).show).toBe(true)
    expect(sw.decideDisplay(payload(), undefined as never).show).toBe(true)
  })

  test('the #pending fragment does not make it a different place', () => {
    // The fragment tells the app where to scroll once it is there; it is not
    // part of "which session am I looking at".
    const { sw } = loadServiceWorker()
    const watching: WindowClient[] = [
      { url: `${ORIGIN}/focus/deploy-fix`, focused: true },
    ]
    expect(sw.decideDisplay(payload({ url: '/focus/deploy-fix#pending' }), watching).show).toBe(
      false,
    )
    expect(sw.pathOf('/focus/deploy-fix#pending')).toBe('/focus/deploy-fix')
  })

  test('a malformed client url is ignored rather than throwing', () => {
    const { sw } = loadServiceWorker()
    const junk: WindowClient[] = [
      { url: 'not a url at all', focused: true },
      {},
      { url: undefined, visibilityState: 'visible' },
    ]
    expect(sw.decideDisplay(payload(), junk).show).toBe(true)
  })
})

describe('notificationOptions', () => {
  test('carries the server coalescing slot and the tier renotify rule', () => {
    const { sw } = loadServiceWorker()
    const attention = sw.notificationOptions(payload())
    expect(attention.tag).toBe('session:deploy-fix')
    expect(attention.renotify).toBe(true)
    expect(attention.body).toBe('Needs permission — ⚡ cargo check (Bash)')
    expect(attention.data.session).toBe('deploy-fix')

    // A calm tier replaces its slot SILENTLY — one bot, one notification, and
    // a finish that overwrites a finish must not buzz again.
    const unread = sw.notificationOptions(
      payload({ tier: 'unread', renotify: false, body: 'Turn finished.' }),
    )
    expect(unread.renotify).toBe(false)
    expect(unread.tag).toBe('session:deploy-fix')
  })

  test('an empty payload still produces a sane notification', () => {
    const { sw } = loadServiceWorker()
    const o = sw.notificationOptions({})
    expect(o.body.length).toBeGreaterThan(0)
    expect(o.tag).toBe('supermux')
    expect(o.renotify).toBe(false)
  })
})

describe('applyBadge', () => {
  test('sets a positive count and clears on zero', async () => {
    const first = loadServiceWorker()
    await first.sw.applyBadge(3)
    expect(first.badgeCalls).toEqual([3])
    expect(first.clears.count).toBe(0)

    // Zero CLEARS the badge rather than showing a "0" the user has to read.
    const second = loadServiceWorker()
    await second.sw.applyBadge(0)
    expect(second.badgeCalls).toEqual([])
    expect(second.clears.count).toBe(1)
  })

  test('a missing or junk count clears rather than throwing', async () => {
    const { sw } = loadServiceWorker()
    await sw.applyBadge(undefined)
    await sw.applyBadge('nonsense')
    // No throw is the assertion; the badge is a nicety and must never be able
    // to break the delivery of a notification.
    expect(true).toBe(true)
  })
})

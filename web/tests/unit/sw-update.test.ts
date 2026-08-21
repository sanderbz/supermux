/**
 * The PWA bundle-adoption state machine (`lib/sw-update.ts`).
 * ─────────────────────────────────────────────────────────────────────────────
 * A `prompt`-mode service worker leaves a freshly deployed shell WAITING and
 * never adopts it while a tab stays open — which for a home-screen PWA is the
 * bug the owner hit: deploy after deploy, the client kept the old bundle. This
 * module is the adoption path. These tests pin the two guarantees that make it
 * safe:
 *
 *   1. a WAITING worker is adopted (skipWaiting + reload) — silently when the
 *      app is idle, otherwise via a surfaced one-tap "Reload to update"; and
 *   2. the idle-guard BLOCKS an auto-reload while the composer holds unsent
 *      text, so a deploy never yanks a half-typed message off the screen.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  __resetSWUpdateForTest,
  adopt,
  getSWUpdateWaiting,
  markCurrent,
  markWaiting,
  shouldAutoAdopt,
  subscribeSWUpdate,
} from '../../src/lib/sw-update'

/** The smallest honest `sessionStorage`: this runner has no DOM. */
class MemoryStorage implements Storage {
  private map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
}

/** A minimal `document` stub: a settable visibility + a captured
 *  `visibilitychange` handler we can fire by hand. */
function makeDoc(visibility: 'visible' | 'hidden') {
  const handlers: Record<string, Array<() => void>> = {}
  return {
    visibilityState: visibility,
    addEventListener(type: string, fn: () => void) {
      ;(handlers[type] ??= []).push(fn)
    },
    fire(type: string) {
      for (const fn of handlers[type] ?? []) fn()
    },
  }
}

type G = {
  sessionStorage?: Storage
  document?: unknown
}
const g = globalThis as unknown as G

let store: MemoryStorage

beforeEach(() => {
  __resetSWUpdateForTest()
  store = new MemoryStorage()
  g.sessionStorage = store
})
afterEach(() => {
  __resetSWUpdateForTest()
  delete g.sessionStorage
  delete g.document
})

describe('shouldAutoAdopt — the idle decision', () => {
  test('idle = backgrounded AND no unsent text', () => {
    expect(shouldAutoAdopt({ hasUnsentDraft: false, hidden: true })).toBe(true)
  })
  test('a visible tab is never auto-reloaded, even with nothing typed', () => {
    expect(shouldAutoAdopt({ hasUnsentDraft: false, hidden: false })).toBe(false)
  })
  test('unsent text vetoes an auto-reload, backgrounded or not', () => {
    expect(shouldAutoAdopt({ hasUnsentDraft: true, hidden: true })).toBe(false)
    expect(shouldAutoAdopt({ hasUnsentDraft: true, hidden: false })).toBe(false)
  })
})

describe('markWaiting — adopting a waiting worker', () => {
  test('idle + backgrounded → adopts SILENTLY (reload runs, no button)', () => {
    g.document = makeDoc('hidden')
    let reloaded = 0
    markWaiting(() => {
      reloaded++
    })
    expect(reloaded).toBe(1)
    expect(getSWUpdateWaiting()).toBe(false)
  })

  test('visible → surfaces the button instead of reloading', () => {
    g.document = makeDoc('visible')
    let reloaded = 0
    const notified: boolean[] = []
    subscribeSWUpdate(() => notified.push(getSWUpdateWaiting()))

    markWaiting(() => {
      reloaded++
    })

    expect(reloaded).toBe(0)
    expect(getSWUpdateWaiting()).toBe(true)
    expect(notified).toEqual([true])

    // The button's one tap actually adopts.
    adopt()
    expect(reloaded).toBe(1)
  })

  test('IDLE-GUARD: unsent composer text blocks the auto-reload', () => {
    // A half-typed message, persisted the way the composer persists it.
    store.setItem('supermux-draft:release-train', 'half a thought')
    g.document = makeDoc('hidden') // backgrounded, yet still must NOT reload
    let reloaded = 0
    markWaiting(() => {
      reloaded++
    })
    expect(reloaded).toBe(0)
    expect(getSWUpdateWaiting()).toBe(true) // button offered, user drives it
  })

  test('a tab visible at update time adopts when it next goes to background', () => {
    const doc = makeDoc('visible')
    g.document = doc
    let reloaded = 0
    markWaiting(() => {
      reloaded++
    })
    expect(reloaded).toBe(0)

    // User switches away with nothing unsent → silent adoption.
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    expect(reloaded).toBe(1)
  })

  test('…but not while unsent text is still on screen', () => {
    const doc = makeDoc('visible')
    g.document = doc
    let reloaded = 0
    markWaiting(() => {
      reloaded++
    })
    store.setItem('supermux-draft:release-train', 'still typing')
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    expect(reloaded).toBe(0)
    expect(getSWUpdateWaiting()).toBe(true)
  })
})

describe('markCurrent — retract a stale bar once the page is current', () => {
  test('flips waiting back to false and notifies subscribers', () => {
    g.document = makeDoc('visible')
    const notified: boolean[] = []
    subscribeSWUpdate(() => notified.push(getSWUpdateWaiting()))

    markWaiting(() => {})
    expect(getSWUpdateWaiting()).toBe(true)

    markCurrent()
    expect(getSWUpdateWaiting()).toBe(false)
    expect(notified).toEqual([true, false])
  })

  test('no-op (no spurious notify) when nothing is waiting', () => {
    const notified: number[] = []
    subscribeSWUpdate(() => notified.push(1))
    markCurrent()
    expect(getSWUpdateWaiting()).toBe(false)
    expect(notified).toEqual([])
  })
})

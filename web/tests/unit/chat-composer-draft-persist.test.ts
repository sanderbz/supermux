/**
 * An unsent message is not allowed to vanish.
 *
 * TWO SHIPPED FACTS THAT COMPOSED BADLY. The composer's drafts lived in
 * module-level Maps — which die with the DOCUMENT — and the built app registered
 * its service worker in `autoUpdate` mode, whose generated registration reloads
 * the document on any activation or external takeover:
 *
 *   wb.addEventListener('activated', e => (e.isUpdate || e.isExternal) &&
 *     window.location.reload())
 *
 * One harness configuration reloaded itself mid-interaction 5/5 times with SW
 * `controllerchange` immediately preceding `beforeunload`; one of those runs
 * destroyed 31 typed characters with no way to get them back. The trigger
 * frequency was never pinned down (a plainer harness did not reproduce it in 17
 * runs). The data loss on every real deploy did not need pinning down.
 *
 * Both halves are asserted here: the store survives a "reload" (a fresh module
 * registry reading the same `sessionStorage`), and the build does not ship the
 * reload-on-activation registration.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

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

const g = globalThis as unknown as { sessionStorage?: Storage }
let store: MemoryStorage

beforeEach(() => {
  store = new MemoryStorage()
  g.sessionStorage = store
})
afterEach(() => {
  delete g.sessionStorage
})

/** A FRESH module instance — the closest this runner gets to a page reload:
 *  new Maps, same storage. */
async function freshModule() {
  return import(
    `../../src/components/chat/composer-draft.ts?reload=${Math.random()}`
  )
}

describe('a draft survives the document', () => {
  test('a typed draft is readable from a fresh module instance', async () => {
    const before = await freshModule()
    before.setDraft('release-train', 'the half-typed message')
    expect(before.getDraft('release-train')).toBe('the half-typed message')

    // …reload.
    const after = await freshModule()
    expect(after.getDraft('release-train')).toBe('the half-typed message')
  })

  test('sending (or clearing) the draft removes it from storage too', async () => {
    const m = await freshModule()
    m.setDraft('release-train', 'about to send')
    expect(store.getItem('supermux-draft:release-train')).toBe('about to send')
    m.setDraft('release-train', '')
    expect(store.getItem('supermux-draft:release-train')).toBeNull()

    const after = await freshModule()
    expect(after.getDraft('release-train')).toBe('')
  })

  test('drafts are per session, and one session never reads another', async () => {
    const m = await freshModule()
    m.setDraft('a', 'for a')
    m.setDraft('b', 'for b')
    const after = await freshModule()
    expect(after.getDraft('a')).toBe('for a')
    expect(after.getDraft('b')).toBe('for b')
    expect(after.getDraft('c')).toBe('')
  })

  test('no storage at all is not an error — the in-memory draft still works', async () => {
    delete g.sessionStorage
    const m = await freshModule()
    m.setDraft('offline', 'still typed')
    expect(m.getDraft('offline')).toBe('still typed')
  })
})

describe('the service worker does not reload the page under the user', () => {
  const CONFIG = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8')

  test("registerType is 'prompt', never 'autoUpdate'", () => {
    expect(CONFIG).toContain("registerType: 'prompt'")
    expect(CONFIG).not.toContain("registerType: 'autoUpdate'")
  })
})

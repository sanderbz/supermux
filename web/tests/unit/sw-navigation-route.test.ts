/**
 * The service worker must not register a PRECACHE navigation route.
 * ─────────────────────────────────────────────────────────────────────────────
 * `vite-plugin-pwa`'s generateSW defaults `navigateFallback` to `'index.html'`.
 * vite.config.ts carried a paragraph explaining why that fallback would be a
 * hazard here — and never actually set the option, so the shipped `sw.js` did:
 *
 *     registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")))
 *
 * while the precache manifest's only HTML entry is `offline.html`. Two failures
 * in one line:
 *
 *   1. `createHandlerBoundToURL` on a URL that was never precached throws
 *      `non-precached-url` for every navigation the SW handles;
 *   2. the precache NavigationRoute is registered FIRST, so it shadowed the
 *      `supermux-html` NetworkFirst rule below it — that cache was never
 *      created, and the branded offline shell it falls back to was unreachable
 *      dead code.
 *
 * The fix is `navigateFallback: null`. This test pins BOTH halves: the config
 * says it, and (when a build is present — CI builds before it runs the unit
 * suite) the emitted worker proves it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const viteConfig = readFileSync(path('../../vite.config.ts'), 'utf8')

describe('the SW navigation route', () => {
  test('vite.config disables navigateFallback explicitly', () => {
    // `null`, not absent: absent is what shipped the bug.
    expect(viteConfig).toMatch(/navigateFallback:\s*null/)
  })

  test('the built sw.js registers no precache-bound navigation handler', () => {
    const sw = path('../../dist/sw.js')
    if (!existsSync(sw)) {
      // No build in this working tree. CI runs `bun run build` before the unit
      // suite, so the real assertion below always runs there; locally, run
      // `bun run build` first to get it.
      console.warn('dist/sw.js absent — run `bun run build` for the full check')
      return
    }
    const src = readFileSync(sw, 'utf8')
    expect(src).not.toContain('createHandlerBoundToURL')
    expect(src).not.toContain('NavigationRoute')
  })

  test('the built sw.js still owns the supermux-html runtime cache', () => {
    const sw = path('../../dist/sw.js')
    if (!existsSync(sw)) return
    const src = readFileSync(sw, 'utf8')
    // The NetworkFirst rule that carries the auth-bearing document — and the
    // cache name Settings → Rotate token drops.
    expect(src).toContain('supermux-html')
    // …with the offline shell reachable as its fallback.
    expect(src).toContain('offline.html')
  })
})

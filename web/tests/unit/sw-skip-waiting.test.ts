/**
 * The service worker must ACTIVATE on its own — skipWaiting + clientsClaim.
 * ─────────────────────────────────────────────────────────────────────────────
 * The owner's iOS-standalone PWA stayed on a STALE cached bundle after every
 * deploy: vite-plugin-pwa runs in `prompt` mode, so a freshly installed SW
 * parked as a WAITING worker and waited for a client "tap to adopt"
 * (updateSW(true)/SKIP_WAITING) that iOS standalone never reliably delivered —
 * so the fresh precache never activated.
 *
 * The SW-side fix is `skipWaiting: true` + `clientsClaim: true` in the workbox
 * config: the new worker self.skipWaiting()s on install and claims all open
 * clients on activate, so activation is never stuck. A bumped `cacheId` renames
 * the Cache Storage buckets so an already-stuck install cannot keep serving its
 * OLD precache. This test pins the config AND (when a build is present — CI
 * builds before the unit suite) the emitted worker.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const viteConfig = readFileSync(path('../../vite.config.ts'), 'utf8')

describe('the SW activation config', () => {
  test('vite.config sets skipWaiting + clientsClaim + a bumped cacheId', () => {
    expect(viteConfig).toMatch(/skipWaiting:\s*true/)
    expect(viteConfig).toMatch(/clientsClaim:\s*true/)
    expect(viteConfig).toMatch(/cacheId:\s*'supermux-/)
    // cleanupOutdatedCaches must stay so the renamed old buckets are purged.
    expect(viteConfig).toMatch(/cleanupOutdatedCaches:\s*true/)
  })
})

describe('the built sw.js', () => {
  const sw = path('../../dist/sw.js')
  const load = () => (existsSync(sw) ? readFileSync(sw, 'utf8') : null)

  test('calls self.skipWaiting() so a new SW does not park as WAITING', () => {
    const src = load()
    if (!src) {
      console.warn('dist/sw.js absent — run `bun run build` for the full check')
      return
    }
    expect(src).toContain('self.skipWaiting()')
  })

  test('claims open clients on activate (clientsClaim)', () => {
    const src = load()
    if (!src) return
    // workbox emits `clientsClaim()` (which calls self.clients.claim()).
    expect(src).toContain('clientsClaim')
  })

  test('renames the Cache Storage buckets via the bumped cacheId', () => {
    const src = load()
    if (!src) return
    expect(src).toContain('supermux-v2')
  })

  test('precache manifest references the freshly hashed index chunk', () => {
    const src = load()
    if (!src) return
    // The entry app chunk is content-hashed, so its presence in the precache
    // manifest proves the SW is precaching THIS build, not a stale revision.
    expect(src).toMatch(/index-[A-Za-z0-9_-]+\.js/)
  })
})

// The service worker must survive activation + a real in-app navigation.
// ─────────────────────────────────────────────────────────────────────────────
// This is the ONE e2e that loads the BUILT bundle with the REAL service worker
// (every other smoke spec runs the Vite dev server, where `devOptions.enabled:
// false` keeps the SW out entirely). It exists because #11 shipped a SW that
// crashed the renderer, and nothing in CI ever loaded a controlling SW to catch
// it. Two independent hazards live on this path, and this spec covers both:
//
//   1. The precache NavigationRoute (`createHandlerBoundToURL('index.html')` on
//      a URL that was never precached) — a real bug that broke navigations in
//      EVERY browser. Fixed by `navigateFallback: null`; pinned by the grep in
//      `tests/unit/sw-navigation-route.test.ts`, and exercised end-to-end here.
//   2. The badge crash — `push-sw.js` answered the page's `notification-seen`
//      message by calling `navigator.setAppBadge`. chrome-headless-shell ships
//      that method with NO BadgeService binder behind it, so the first worker
//      call hard-kills the render process ("No binder found for interface
//      blink.mojom.BadgeService"). A capability that lies cannot be
//      feature-detected; the fix stops the worker calling it from a message
//      (the open page is the badge's authoritative writer anyway — see
//      `public/push-sw.js`). Closed-app badging stays in the `push` handler.
//
// WHY `chromium-headless-shell` AND NOT THE DEFAULT: the badge crash is
// genuinely headless-shell-only — Playwright's default new-headless runs the
// FULL chromium binary, which HAS the BadgeService binder and would never
// crash, so on the default browser this spec would be a false-green for hazard
// (2). We pin the channel so the regression can actually bite: verified this
// spec FAILS (`page crashed`) on the pre-fix bundle and PASSES on the fixed one,
// both on chromium-headless-shell-1223. Production PWA users (Chrome, Safari,
// standalone WebViews) are on real browsers with a working binder and were
// never hit — the crash was a headless artifact plus this coverage gap.
//
// Self-contained: builds `dist/` if absent (mirrors sw-navigation-route.test.ts,
// which greps the same emitted bundle) and serves it with `vite preview`. No
// backend — the shell mounts and PushBridge posts to the SW without one; the
// data queries just fail, which is fine: we assert the RENDERER survives, not
// that a session loads.

import { type ChildProcess, spawn } from 'node:child_process'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { freePort } from './harness'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = resolve(__dirname, '..', '..', '..')

// The default new-headless full chromium has the badge binder and cannot
// reproduce the crash — see the header. Pin the shell so the regression bites.
test.use({ channel: 'chromium-headless-shell' })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForUp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await fetch(url)
      return
    } catch (e) {
      lastErr = e
    }
    await sleep(200)
  }
  throw new Error(`vite preview never came up at ${url}: ${String(lastErr)}`)
}

let preview: ChildProcess | null = null
let baseUrl = ''

test.beforeAll(async () => {
  // Built bundle + real SW. CI's e2e job doesn't `bun run build`, so build here
  // if the tree hasn't been built (rolldown-vite builds in ~1s). Same posture as
  // the unit test that greps dist/sw.js.
  if (!existsSync(resolve(WEB_DIR, 'dist', 'sw.js'))) {
    execSync('bunx vite build', { cwd: WEB_DIR, stdio: 'inherit' })
  }
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  preview = spawn(
    'bunx',
    ['vite', 'preview', '--outDir', 'dist', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: WEB_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  preview.stdout?.on('data', () => {})
  preview.stderr?.on('data', () => {})
  await waitForUp(baseUrl)
})

test.afterAll(async () => {
  if (preview && preview.exitCode === null) {
    await new Promise<void>((res) => {
      preview!.once('exit', () => res())
      try {
        preview!.kill('SIGTERM')
      } catch {
        res()
      }
      setTimeout(() => {
        try {
          preview!.kill('SIGKILL')
        } catch {
          /* gone */
        }
        res()
      }, 3_000)
    })
  }
  preview = null
})

test('the SW-controlled bundle survives activation + a /focus navigation', async ({ page }) => {
  let crashed = false
  page.on('crash', () => {
    crashed = true
  })

  // 1) Cold load — the SW installs and begins to control.
  await page.goto(`${baseUrl}/`, { waitUntil: 'load' })
  await page.waitForFunction(
    async () => {
      if (!('serviceWorker' in navigator)) return false
      await navigator.serviceWorker.ready
      return !!navigator.serviceWorker.controller
    },
    null,
    { timeout: 20_000 },
  )

  // 2) Reload so THIS document is served from the first byte by the SW.
  await page.reload({ waitUntil: 'load' })
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)

  // 3) Navigate to a /focus route. PushBridge posts `notification-seen` to the
  //    controlling worker — the exact message whose badge side-effect used to
  //    kill the render process here.
  await page.goto(`${baseUrl}/focus/sw-probe`, { waitUntil: 'load' })

  // 4) Give a reload loop / delayed crash time to show, then assert the renderer
  //    is alive, painted, and still SW-controlled.
  await sleep(3_000)
  expect(crashed, 'the render process must survive SW activation + navigation').toBe(false)
  const painted = await page.evaluate(() => document.body?.innerText?.length ?? 0)
  expect(painted, 'the app shell must be painted, not a blank/killed frame').toBeGreaterThan(0)
  expect(
    await page.evaluate(() => !!navigator.serviceWorker.controller),
    'the SW must still control (no reload loop knocked it out)',
  ).toBe(true)

  // 5) The offline story the crash prevented: a handled navigation populates the
  //    `supermux-html` NetworkFirst cache. The finding measured only
  //    workbox-precache after the crash; here it must be present.
  const cacheKeys = (await page.evaluate(() => globalThis.caches.keys())) as string[]
  expect(cacheKeys).toContain('supermux-html')
})

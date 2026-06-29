// Screenshot capture for the snippets editing/visibility PR. Boots a REAL
// backend (smoke harness), seeds two near-identical snippets, and drives the app
// into the states the PR changes — writing PNGs to screens-out/ for the PR.
// Not an assertion suite.

import { test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { injectGlobals, startBackend, type Backend } from '../smoke/harness'

const OUT = join(process.cwd(), 'screens-out')

// Two snippets that share a long body prefix and near-identical titles — the
// exact Issue-3 case where the truncated line can't tell them apart.
const SNIPPETS = [
  {
    title: 'Continue (tests)',
    body: 'continue the current task, and make sure to run the full test suite before you report back as done',
  },
  {
    title: 'Continue (no tests)',
    body: 'continue the current task, but do not run the tests this time — just push the change and open the PR',
  },
]

async function seedSnippets(backend: Backend) {
  for (const s of SNIPPETS) {
    await fetch(`${backend.backendUrl}/api/snippets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${backend.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(s),
    })
  }
}

/** Force `(pointer: coarse)` so the focus route renders the MOBILE dock + Vaul
 *  snippet sheet, without device emulation (which crashes the host's
 *  single-process Chromium). Must run before app scripts. */
async function forceCoarsePointer(page: Page) {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window)
    window.matchMedia = (q: string) => {
      const mql = real(q)
      const want = q.includes('coarse') ? true : q.includes('fine') ? false : null
      if (want === null) return mql
      // Proxy (not spread) so addEventListener/addListener survive — a spread
      // drops the prototype methods and React's useMediaQuery subscribe throws.
      return new Proxy(mql, {
        get(target, prop) {
          if (prop === 'matches') return want
          const v = Reflect.get(target, prop)
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
    }
  })
}

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true })
})

// NOTE: the Settings inline snippets list (edit + expand) was replaced by the
// dedicated manager sheet — its capture now lives in
// `snippets-manager.screens.spec.ts`. This file keeps the focus-panel coverage.

test('focus snippet panel — expand (mobile)', async ({ page }) => {
  const backend = await startBackend()
  try {
    await seedSnippets(backend)
    // A shell session to land the focus route on.
    await fetch(`${backend.backendUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${backend.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'demo', provider: 'shell', dir: backend.dataDir }),
    })
    await fetch(`${backend.backendUrl}/api/sessions/demo/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })

    await page.setViewportSize({ width: 430, height: 932 })
    await forceCoarsePointer(page)
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(`${backend.baseUrl}/focus/demo`)

    await page.getByRole('button', { name: 'Snippets' }).click()
    await page.getByText('Snippets', { exact: true }).first().waitFor()
    await page.getByRole('button', { name: 'Expand Continue (tests)' }).waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(OUT, 'focus-snippets-collapsed.png') })

    await page.getByRole('button', { name: 'Expand Continue (tests)' }).click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(OUT, 'focus-snippets-expanded.png') })
  } finally {
    await backend.dispose()
  }
})

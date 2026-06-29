// Real-backend drive of the redesigned snippets manager: Settings is now a
// compact "Manage" row that opens a dedicated sheet; add/edit reuse the editor.
// The load-bearing assertion: typing into the editor body REGISTERS when the
// editor opens over the manager sheet (catches the Radix-modal pointer-events
// fall-through Paul just fixed elsewhere). Writes PNGs to screens-out/.

import { test, expect, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { injectGlobals, startBackend, type Backend } from '../smoke/harness'

const OUT = join(process.cwd(), 'screens-out')
const SNIPPETS = [
  {
    title: 'Continue (tests)',
    body: 'continue the current task, and make sure to run the full test suite before you report back as done',
  },
  { title: 'Compact', body: '/compact' },
]

async function seed(backend: Backend) {
  for (const s of SNIPPETS) {
    await fetch(`${backend.backendUrl}/api/snippets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    })
  }
}

async function openManager(page: Page) {
  const manage = page.getByRole('button', { name: 'Manage snippets' })
  await manage.waitFor()
  await manage.click()
  await page.getByRole('button', { name: 'New snippet' }).waitFor()
}

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true })
})

test('settings → snippets manager → editor types (desktop)', async ({ page }) => {
  const backend = await startBackend()
  try {
    await seed(backend)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(`${backend.baseUrl}/settings`)

    // 1) Settings is a COMPACT Manage row (no unbounded inline list).
    await page.getByRole('button', { name: 'Manage snippets' }).waitFor()
    await page.screenshot({ path: join(OUT, 'mgr-settings-compact.png') })

    // 2) Manager sheet → the seeded snippets list.
    await openManager(page)
    await page.getByText('Continue (tests)').waitFor()
    await page.screenshot({ path: join(OUT, 'mgr-sheet-list.png') })

    // 3) Editor over the sheet → typing MUST register (no pointer-events lock).
    await page.getByRole('button', { name: 'New snippet' }).click()
    const bodyField = page.getByLabel('Snippet text')
    await bodyField.waitFor()
    await bodyField.click()
    await bodyField.fill('/review the open PR')
    await expect(bodyField).toHaveValue('/review the open PR')
    await page.screenshot({ path: join(OUT, 'mgr-editor-typed.png') })
  } finally {
    await backend.dispose()
  }
})

test('settings → snippets manager (mobile viewport)', async ({ page }) => {
  const backend = await startBackend()
  try {
    await seed(backend)
    await page.setViewportSize({ width: 430, height: 932 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(`${backend.baseUrl}/settings`)
    await openManager(page)
    await page.getByText('Continue (tests)').waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(OUT, 'mgr-sheet-mobile.png') })

    // Editor over the mobile sheet must also type.
    await page.getByRole('button', { name: 'New snippet' }).click()
    const bodyField = page.getByLabel('Snippet text')
    await bodyField.waitFor()
    await bodyField.fill('/compact')
    await expect(bodyField).toHaveValue('/compact')
    await page.screenshot({ path: join(OUT, 'mgr-editor-mobile.png') })
  } finally {
    await backend.dispose()
  }
})

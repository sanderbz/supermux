// Screenshot capture for the archive-on-stop PR. Boots a REAL backend (smoke
// harness) and opens the boot-schedule editor to show the new "On stop" toggle:
// unticked by default (opt-in), and ticked by the user. Writes PNGs to
// screens-out/ for the PR. Not an assertion suite.

import { test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { injectGlobals, startBackend } from '../smoke/harness'

const OUT = join(process.cwd(), 'screens-out')

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true })
})

test('boot schedule editor — archive-on-stop toggle', async ({ page }) => {
  const backend = await startBackend()
  try {
    await page.setViewportSize({ width: 1100, height: 950 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(`${backend.baseUrl}/scheduler`)

    await page.getByRole('button', { name: 'New schedule' }).first().click()
    await page.getByRole('radio', { name: 'Boot session', exact: true }).click()
    await page.getByLabel('Title').fill('Nightly triage')
    await page.getByLabel('Directory').fill('/home/supermux/projects/supermux')

    const toggle = page.getByText('Archive this session when it stops')
    await toggle.waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(OUT, 'schedule-editor-archive-off.png') })

    await toggle.click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(OUT, 'schedule-editor-archive-on.png') })
  } finally {
    await backend.dispose()
  }
})

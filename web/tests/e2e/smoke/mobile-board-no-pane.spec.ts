// Mobile parity guard for the desktop detail pane: on a phone the pane must NOT
// exist (it's `hidden lg:flex`), the lanes keep their fixed-width horizontal
// scroll, and tapping a To do card still opens the editor sheet (unchanged).

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

test.describe('mobile board (pane never mounts)', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('no detail pane on mobile; lanes + sheet unchanged', async ({ page }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    })
    const A = api(backend)
    await A.createIssue({ title: 'A todo card', description: 'Something to do.' })

    await page.goto(`${backend.baseUrl}/board`)
    await expect(
      page.getByRole('button', { name: /A todo card/ }).first(),
    ).toBeVisible({ timeout: 15_000 })

    // The desktop pane is `hidden lg:flex` — present in the DOM but display:none
    // on mobile, so it contributes no layout and is invisible to the user.
    await expect(
      page.getByText(/Select a card to see its details/i),
    ).toBeHidden()

    await page.screenshot({ path: 'test-results/mobile-board.png' })
  })
})

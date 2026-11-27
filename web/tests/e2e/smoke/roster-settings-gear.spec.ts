// The Bot-mode roster's top-right Settings doorway is a gear, for every owner.
//
// It used to draw a hard-coded "SB" monogram and name one particular owner in
// its label, so any other owner saw somebody else's initials on their own
// Settings button. The owner's slot is now the same ghost icon button as
// Archive beside it; it still opens Settings, on desktop and on the phone.
//
// Needs server/target/debug/supermux-server — `cd server && cargo build` first
// (debug; never --release).

import { expect, test, type Page } from '@playwright/test'

import { api, injectGlobals, startBackend, type Backend } from './harness'

async function prime(page: Page, backend: Backend): Promise<void> {
  await page.addInitScript(injectGlobals(backend.token))
  await page.addInitScript(() =>
    window.localStorage.setItem('supermux-ui', JSON.stringify({ state: { botMode: true }, version: 1 })),
  )
}

test.describe('roster settings gear', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend()
    const res = await api(backend).createSession({ name: 'gear-bot', provider: 'shell', dir: backend.dataDir })
    expect(res.status).toBe(201)
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  for (const vp of [
    { name: 'desktop', width: 1280, height: 860 },
    { name: 'phone', width: 390, height: 844 },
  ]) {
    test(`${vp.name}: a gear opens Settings, and nobody's initials are drawn`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await prime(page, backend)
      await page.goto(backend.baseUrl)

      const header = page.locator('.grok-roster header')
      const gear = header.getByRole('button', { name: 'Settings', exact: true })
      await expect(gear).toBeVisible()
      await expect(gear.locator('svg')).toHaveCount(1)
      await expect(header.getByText('SB', { exact: true })).toHaveCount(0)

      await gear.click()
      await expect(page).toHaveURL(/\/settings$/)
    })
  }
})

// B1 T6 — <ShellOverlay>'s MOBILE form (the other half of shell-overlay.spec.ts).
//
// The same component, the same consumer (`<ArchivedSheet>`), on a phone: it must
// render the Vaul drag-detent sheet and NO shell overlay. The reason is
// structural, not cosmetic — on mobile the focus route strips both navs and
// lives in a body-level `position: fixed` sheet, so a shell-absolute overlay
// would simply be occluded by it.
//
// A separate spec file because the mobile form forks on `pointer: coarse`,
// which needs a touch-emulating context, expressed as a file-level `test.use()`.
// (It was also forced once: chromium ran `--single-process` here and a second
// context in one spec file killed the browser — INFRA-01, now fixed.)

import { devices, expect, test } from '@playwright/test'
import { injectGlobals, startBackend, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

test.describe('shell overlay: mobile', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('renders the responsive sheet and no shell overlay', async ({ page }) => {
    test.setTimeout(90_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
      localStorage.setItem('supermux-first-launch', String(Date.now()))
    })

    await page.goto(`${backend.baseUrl}/`)
    const trigger = page.getByRole('button', { name: /Archived/i }).first()
    await expect(trigger).toBeVisible({ timeout: 20_000 })
    await trigger.tap()

    await expect(page.locator('[data-testid="responsive-sheet"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(
      page.locator('[data-testid="shell-overlay"]'),
      'no shell overlay on mobile — the focus sheet would occlude it',
    ).toHaveCount(0)
  })
})

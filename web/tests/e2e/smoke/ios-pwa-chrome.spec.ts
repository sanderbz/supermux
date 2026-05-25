// SD-6 e2e — iOS standalone PWA chrome (no doubled safe-area band).
//
// REGRESSION GUARD for SD-6. Every route owns its own top safe-area inset, so the
// always-present reconnect-banner row must NOT add `pt-safe` a second time when no
// banner is showing — otherwise the iOS standalone PWA (where the notch inset is
// always non-zero) shows a doubled empty band at the very top.
//
// Headless chromium reports 0px safe-area insets, so we SIMULATE a notch by
// overriding the `.pt-safe` utility to a fixed value. A probe element proves the
// override is live; the banner row (the element right before <main>) must then
// still compute `padding-top: 0px` when the connection is healthy.

import { devices, expect, test } from '@playwright/test'
import { injectGlobals, startBackend, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

test.describe('iOS PWA chrome (SD-6)', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('reconnect-banner reserves no top safe-area band when healthy', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(`${backend.baseUrl}/board`)

    // Simulate the iOS notch inset (headless reports 0px) by overriding the
    // utility the banner uses, plus a probe to prove the override is live.
    await page.addStyleTag({
      content: '.pt-safe{padding-top:44px !important}',
    })
    await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.id = 'sd6-probe'
      probe.className = 'pt-safe'
      document.body.appendChild(probe)
    })
    expect(
      await page.evaluate(
        () => getComputedStyle(document.getElementById('sd6-probe')!).paddingTop,
      ),
      'override is live: .pt-safe → 44px',
    ).toBe('44px')

    // The reconnect-banner is the element immediately before <main>. With the
    // connection healthy (no banner) it must reserve ZERO top inset — the route
    // below already owns the single notch inset, so any pt-safe here is a doubled
    // band. (During the brief "connected" success flash it legitimately shows the
    // inset, so we poll until it settles.)
    await expect(async () => {
      const pt = await page.evaluate(() => {
        const main = document.querySelector('main')
        const banner = main?.previousElementSibling as HTMLElement | null
        return banner ? getComputedStyle(banner).paddingTop : 'no-banner'
      })
      expect(pt, 'banner row top inset when healthy').toBe('0px')
    }).toPass({ timeout: 8_000 })

    await page.screenshot({ path: 'test-results/sd-6-board-top.png' })
  })

  test('settings header grows for the notch (title not squished under it)', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(`${backend.baseUrl}/settings`)
    // Simulate the notch inset the fixed-height header used to eat into.
    await page.addStyleTag({ content: '.pt-safe{padding-top:44px !important}' })

    const header = page.locator('header').first()
    await expect(header).toBeVisible({ timeout: 10_000 })
    // min-h-12 (fix) lets the 44px inset ADD to the 48px bar → it grows past 48.
    // A fixed h-12 (bug) would stay 48px and squeeze the title under the notch.
    await expect(async () => {
      const h = await header.evaluate((el) => el.getBoundingClientRect().height)
      expect(h, 'header grew to fit the notch inset').toBeGreaterThan(52)
    }).toPass({ timeout: 5_000 })
    // And the title clears the simulated 44px notch rather than sitting under it.
    const title = header.getByText('Settings', { exact: true })
    const top = await title.evaluate((el) => el.getBoundingClientRect().top)
    expect(top, 'title sits below the notch inset').toBeGreaterThanOrEqual(40)
    await page.screenshot({ path: 'test-results/sd-6-settings-header.png' })
  })
})

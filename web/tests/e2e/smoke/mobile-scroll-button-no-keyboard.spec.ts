// Regression: the mobile "jump to bottom" button must scroll WITHOUT opening the
// soft keyboard. On touch, focusing xterm's hidden helper-textarea pops the iOS
// keyboard — so tapping the button must (1) fire (viewport returns to the live
// bottom) and (2) NOT move focus into `.xterm-helper-textarea`.

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

test.describe('mobile: jump-to-bottom button does not pop the keyboard', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('tap scrolls to bottom and does not focus the terminal textarea', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    })

    const A = api(backend)
    expect(
      (await A.createSession({ name: 'msb', provider: 'shell', dir: backend.dataDir }))
        .status,
    ).toBe(201)
    expect((await A.startSession('msb')).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/msb`)
    await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: 15_000 })

    const term = page.getByRole('application', { name: 'Live terminal for msb' })
    await term.click()
    await page.keyboard.type('seq 1 600')
    await page.keyboard.press('Enter')

    const viewport = page.locator('.xterm-viewport')
    await expect(viewport).toBeVisible({ timeout: 10_000 })
    await expect(async () => {
      const max = await viewport.evaluate((el) => el.scrollHeight - el.clientHeight)
      expect(max).toBeGreaterThan(40)
    }).toPass({ timeout: 8_000 })

    // Scroll up through xterm's internal scrollback paging (reliable in headless,
    // where the canvas renderer reverts a synthetic touch/scrollTop) so the
    // jump-to-bottom button appears. Real users reach this state by touch-drag;
    // the test only needs the scrolled-up state to exercise the button's tap.
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+PageUp')

    const btn = page.getByRole('button', { name: 'Scroll to bottom' })
    await expect(btn).toBeVisible({ timeout: 5_000 })

    // Blur anything first so the assertion is meaningful, then TAP the button.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await btn.tap()

    // (1) The button fired → viewport is back at the live bottom.
    await expect(async () => {
      const gap = await viewport.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      )
      expect(gap, 'viewport back at the bottom').toBeLessThan(5)
    }).toPass({ timeout: 5_000 })

    // (2) Focus did NOT move into xterm's hidden textarea (which would pop the
    // iOS soft keyboard). This is the regression guard.
    const focusedHelper = await page.evaluate(() =>
      document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
    )
    expect(focusedHelper, 'tap must NOT focus the terminal textarea (no keyboard)').toBe(
      false,
    )
  })
})

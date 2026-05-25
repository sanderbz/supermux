// SD-2 e2e — the live terminal's "jump to bottom" button.
//
// REGRESSION GUARD for SD-2. While pinned to the live bottom there must be NO
// button; once the user scrolls up a few rows it appears; clicking it pins the
// viewport back to the bottom and the button disappears again.
//
// We fill the scrollback with `seq 1 600`, scroll UP with the mouse wheel (the
// real user path — xterm's own wheel handler moves the buffer, which fires the
// onScroll our hook listens to), and assert the button toggles + the viewport
// returns to the bottom on click. Drives the real binary through the smoke
// harness against the live Vite frontend (the actual new component).

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.describe('terminal: jump-to-bottom button (SD-2)', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('button appears when scrolled up and pins back to the bottom on click', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.addInitScript(injectGlobals(backend.token))

    const A = api(backend)
    expect(
      (await A.createSession({ name: 'sd2', provider: 'shell', dir: backend.dataDir }))
        .status,
      'create session',
    ).toBe(201)
    expect((await A.startSession('sd2')).ok, 'start session').toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/sd2`)

    const surface = page.locator('[data-state="live"]')
    await expect(surface).toBeVisible({ timeout: 15_000 })

    // Fill the scrollback well past one screen so there's room to scroll up.
    const term = page.getByRole('application', { name: 'Live terminal for sd2' })
    await term.click()
    await page.keyboard.type('seq 1 600')
    await page.keyboard.press('Enter')

    const viewport = page.locator('.xterm-viewport')
    await expect(viewport).toBeVisible({ timeout: 10_000 })

    // Wait for the 600 lines to FINISH streaming (scrollHeight stops growing),
    // then park at the live bottom — so streaming output can't re-pin mid-test
    // and the assertions describe a settled terminal.
    await expect(async () => {
      const a = await viewport.evaluate((el) => el.scrollHeight)
      await new Promise((r) => setTimeout(r, 250))
      const b = await viewport.evaluate((el) => el.scrollHeight)
      expect(a, 'scrollHeight settled').toBe(b)
      expect(
        b - (await viewport.evaluate((el) => el.clientHeight)),
        'scrollback overflows the viewport',
      ).toBeGreaterThan(20)
    }).toPass({ timeout: 12_000 })
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })

    // At the live bottom: the button is NOT mounted.
    const btn = page.getByRole('button', { name: 'Scroll to bottom' })
    await expect(btn).toHaveCount(0)

    // Scroll UP with Shift+PageUp — xterm's internal scrollback paging, which
    // moves the buffer AND re-renders (the canvas renderer ignores a synthetic
    // wheel/scrollTop, but honours real paging). The hook reads `.xterm-viewport`'s
    // scroll position, so the button appears once we leave the bottom.
    await term.click()
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+PageUp')
    await expect(btn).toBeVisible({ timeout: 5_000 })
    // Confirm xterm REALLY scrolled up (not just a state flip): the viewport sits
    // well above the bottom now.
    const distFromBottom = await viewport.evaluate(
      (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
    )
    expect(distFromBottom, 'viewport actually scrolled up').toBeGreaterThan(100)
    await page.screenshot({ path: 'test-results/sd-2-button-visible.png' })

    // Click → viewport pins back to the bottom and the button unmounts.
    await btn.click()
    await expect(btn).toHaveCount(0, { timeout: 5_000 })
    await expect(async () => {
      const gap = await viewport.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      )
      expect(gap, 'viewport back at the bottom').toBeLessThan(5)
    }).toPass({ timeout: 5_000 })
    await page.screenshot({ path: 'test-results/sd-2-after-click.png' })
  })
})

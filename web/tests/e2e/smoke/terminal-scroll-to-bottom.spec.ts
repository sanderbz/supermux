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
import {
  api,
  injectGlobals,
  startBackend,
  xtermScroll,
  xtermToBottom,
  type Backend,
} from './harness'

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

    await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 10_000 })

    // Wait for the 600 lines to FINISH streaming (the scrollback stops growing),
    // then park at the live bottom — so streaming output can't re-pin mid-test
    // and the assertions describe a settled terminal.
    //
    // Measured in BUFFER ROWS. `.xterm-viewport`'s scrollHeight/clientHeight are
    // permanently equal under xterm 6.0's scrollable element, so "settled" was
    // trivially true and "overflows" could never be, whatever the terminal held.
    await expect(async () => {
      const a = (await xtermScroll(page)).baseY
      await new Promise((r) => setTimeout(r, 250))
      const b = (await xtermScroll(page)).baseY
      expect(a, 'scrollback settled').toBe(b)
      expect(b, 'scrollback overflows the viewport').toBeGreaterThan(20)
    }).toPass({ timeout: 12_000 })
    await xtermToBottom(page)

    // At the live bottom: the button is NOT mounted.
    const btn = page.getByRole('button', { name: 'Scroll to bottom' })
    await expect(btn).toHaveCount(0)

    // Scroll UP with Shift+PageUp — xterm's internal scrollback paging, which
    // moves the buffer AND re-renders (the canvas renderer ignores a synthetic
    // wheel/scrollTop, but honours real paging). The hook reads `baseY -
    // viewportY`, so the button appears once we leave the bottom.
    await term.click()
    // The presses live INSIDE the retry, not before it: a Shift+PageUp that
    // lands before xterm has taken focus is simply swallowed, and re-reading a
    // buffer that never moved cannot recover from that. Paging further up is
    // harmless — the assertion is a floor, not an equality. (Measured 1/3 flaky
    // with the presses outside.)
    //
    // SCROLL → SEE THE BUTTON → CLICK IT, as ONE retried unit. Each step is
    // fine and the SEAMS are not: a press that lands before xterm has taken
    // focus is swallowed, and anything that re-pins the terminal to the live
    // bottom between the visibility assertion and the click (a refit, a socket
    // blip remounting the surface) unmounts the button, after which the click
    // waits out its timeout for a control that is correctly gone. Both halves
    // are idempotent — paging further up is harmless, and so is jumping to a
    // bottom you are already at — so a re-pin costs an attempt, not the test.
    // (Measured 1/3 and 1/3 flaky with these as separate steps.)
    await expect(async () => {
      await page.keyboard.press('Shift+PageUp')
      await page.keyboard.press('Shift+PageUp')
      // Confirm xterm REALLY scrolled up (not just a state flip): the viewport
      // sits well above the bottom now — several pages of rows, not pixels.
      const { up } = await xtermScroll(page)
      expect(up, 'viewport actually scrolled up').toBeGreaterThan(10)
      await expect(btn).toBeVisible({ timeout: 2_000 })
      await page.screenshot({ path: 'test-results/sd-2-button-visible.png' })
      await btn.click({ timeout: 3_000 })
    }).toPass({ timeout: 30_000 })

    // …and the button unmounts, because the view is pinned again.
    await expect(btn).toHaveCount(0, { timeout: 5_000 })
    await expect(async () => {
      const back = await xtermScroll(page)
      expect(back.up, 'viewport back at the bottom').toBeLessThan(2)
    }).toPass({ timeout: 5_000 })
    await page.screenshot({ path: 'test-results/sd-2-after-click.png' })
  })
})

// Regression: the mobile "jump to bottom" button must scroll WITHOUT opening the
// soft keyboard. On touch, focusing xterm's hidden helper-textarea pops the iOS
// keyboard — so tapping the button must (1) fire (viewport returns to the live
// bottom) and (2) NOT move focus into `.xterm-helper-textarea`.

import { devices, expect, test } from '@playwright/test'
import {
  api,
  injectGlobals,
  startBackend,
  xtermScroll,
  xtermScrollLines,
  type Backend,
} from './harness'

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

    // BUFFER ROWS, not `.xterm-viewport` scroll geometry — that is permanently
    // 0 under xterm 6.0's scrollable element, which is why this gate had been
    // failing on `Received: 0` with the terminal correctly full. See
    // `xtermScroll` in the harness.
    await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 10_000 })
    await expect(async () => {
      const { max } = await xtermScroll(page)
      expect(max, 'scrollback must overflow the viewport').toBeGreaterThan(40)
    }).toPass({ timeout: 8_000 })

    // BLUR FIRST, THEN SCROLL — order matters, and getting it wrong is what
    // made this spec unfixable by timeouts alone. Blurring closes the soft
    // keyboard, which resizes the visual viewport, which refits xterm and
    // RE-PINS it to the live bottom: with the blur after the scroll-up, the
    // button unmounted in the milliseconds between `toBeVisible()` passing and
    // the tap, and the tap then waited 25 s for a button that was correctly
    // gone.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    // …and scroll through the buffer API rather than `Shift+PageUp`, because
    // paging needs the terminal FOCUSED and the whole point of this spec is a
    // blurred one. This is the same call the product's own touch-drag makes.
    const btn = page.getByRole('button', { name: 'Scroll to bottom' })

    // SCROLL → SEE THE BUTTON → TAP IT, as ONE retried unit.
    //
    // Each step is fine and the SEAMS are not: anything that re-pins the
    // terminal to the live bottom between two of them (a refit after a viewport
    // resize, a socket blip remounting the surface — this spec reproducibly saw
    // the reconnect banner mid-run) unmounts the button, and the tap then waits
    // out its timeout for a control that is correctly gone. Retrying the cycle
    // rather than any one step means a re-pin costs an attempt instead of the
    // test. Both halves are idempotent: scrolling up again is harmless, and so
    // is jumping to a bottom you are already at.
    await expect(async () => {
      await xtermScrollLines(page, -120)
      const { up } = await xtermScroll(page)
      expect(up, 'scrolled up off the live bottom').toBeGreaterThan(10)
      await expect(btn).toBeVisible({ timeout: 2_000 })
      await btn.tap({ timeout: 3_000 })
    }).toPass({ timeout: 40_000 })

    // What must NOT be retried is the FOCUS assertion below, which is the
    // actual regression guard.
    await expect(async () => {
      await btn.tap({ timeout: 5_000 })
    }).toPass({ timeout: 25_000 })

    // (1) The button fired → the viewport is back at the live bottom, i.e. zero
    //     rows above it.
    await expect(async () => {
      const { up } = await xtermScroll(page)
      expect(up, 'viewport back at the bottom').toBeLessThan(2)
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

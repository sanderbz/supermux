// Regression guard: mobile terminal scrollback must scroll on one-finger touch
// EVEN WHILE THE AGENT HOLDS THE MOUSE (DECSET ?1000/?1002/?1006 — what Claude
// Code's TUI does almost always).
//
// xterm 5.5's OWN touch-scroll listeners (registered in Terminal.ts) early-return
// when `coreMouseService.areMouseEventsActive` is true, DROPPING the touch — so on
// mobile, history could not be scrolled by one finger while an agent was attached
// (wheel/2-finger use other paths, so they kept working: the exact reported
// regression). The fix adds our own single-finger touch shim on `.xterm-screen`
// that scrolls via `term.scrollLines()` (line-granular, public API) whenever mouse
// reporting is on and we're in the normal buffer. This complements
// `mobile-terminal-scroll.spec.ts` (the mouse-OFF case, which xterm handles
// natively).
//
// We enable mouse reporting by emitting the DECSET sequences from the shell (then
// `sleep` so the prompt redraw can't reset them), then drive a REAL one-finger
// drag via the cross-engine `touchDragY` helper (so it runs on chromium AND
// webkit — note `new Touch()` throws "Illegal constructor" on WebKit, which is why
// the helper falls back to document.createTouch there). Two assertions make this
// prove the SHIM specifically, not the native path:
//   1. a sub-cell drag must NOT scroll — xterm's native handler would scroll on
//      any pixel, so "no scroll on a tiny drag" proves native is gated (mouse
//      reporting really is on) AND the shim's line-granular accumulator governs.
//   2. a full drag DOES scroll — the shim fires and `scrollLines()` moves history.

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, touchDragY, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

test.describe('mobile: terminal scrolls on touch even with mouse-tracking on', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('one-finger drag scrolls scrollback while the agent holds the mouse', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    })

    const A = api(backend)
    expect((await A.createSession({ name: 'mob-mt', provider: 'shell', dir: backend.dataDir })).status).toBe(201)
    expect((await A.startSession('mob-mt')).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/mob-mt`)
    await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: 15_000 })

    const term = page.getByRole('application', { name: 'Live terminal for mob-mt' })
    await term.click()
    await page.keyboard.type('seq 1 600')
    await page.keyboard.press('Enter')

    const viewport = page.locator('.xterm-viewport')
    await expect(viewport).toBeVisible({ timeout: 10_000 })
    await expect(async () => {
      const max = await viewport.evaluate((el) => el.scrollHeight - el.clientHeight)
      expect(max, 'scrollback must overflow').toBeGreaterThan(20)
    }).toPass({ timeout: 8_000 })

    // Turn ON mouse reporting (so xterm gates its own touch handler), then sleep so
    // the prompt redraw can't reset it during the test. printf interprets \033.
    await page.keyboard.type("printf '\\033[?1000h\\033[?1002h\\033[?1006h'; sleep 30")
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)

    // Park at the bottom.
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    const parked = await viewport.evaluate((el) => el.scrollTop)
    expect(parked, 'parked at bottom').toBeGreaterThan(0)

    // (1) A sub-cell drag (6px, well under one ~13–16px cell at fontSize 13) must
    // NOT scroll. If mouse reporting weren't actually on, xterm's native handler
    // would move scrollTop on the very first pixel — so an unchanged scrollTop here
    // proves native is gated AND the shim's whole-line accumulator is what governs.
    const tiny = await touchDragY(page, '.xterm-screen', 6, 2)
    expect(
      tiny.after,
      `sub-cell drag must NOT scroll under the shim (native would have); method=${tiny.method} before=${tiny.before} after=${tiny.after}`,
    ).toBe(tiny.before)

    // (2) A full drag-down on .xterm-screen (where the shim listens). With
    // mouse-tracking on, xterm's own handler is gated, so this MUST go through our
    // shim → scrollLines() reveals history → scrollTop decreases.
    const moved = await touchDragY(page, '.xterm-screen', 260, 16)
    expect(
      moved.after,
      `scrollTop must change on touch-drag with mouse-tracking on (method=${moved.method} before=${moved.before} after=${moved.after})`,
    ).not.toBe(moved.before)
    expect(moved.after, 'drag-down scrolls UP into history (scrollTop decreases)').toBeLessThan(moved.before)
  })
})

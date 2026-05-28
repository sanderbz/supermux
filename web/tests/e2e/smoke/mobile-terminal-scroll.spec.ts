// R5 e2e — mobile terminal scrollback scroll (iOS).
//
// REGRESSION GUARD for the R5 scroll fix. The M17 joystick used to render an
// `absolute inset-0 z-20 touch-none` overlay that blanketed the whole terminal,
// so a one-finger drag NEVER reached xterm's own touchmove scroll handler — the
// scrollback couldn't scroll on mobile. The fix makes the joystick layer
// pass-through (`pointer-events-none`) until ARMED, observing gestures via
// non-blocking listeners on the wrapper. So:
//   1. while UNARMED, a touch-drag inside the terminal reaches xterm's native
//      touch handler and scrolls the scrollback (viewport.scrollTop changes), and
//   2. the joystick still arms on a 350ms hold (data-armed flips) and disarms on
//      release — the marquee interaction is preserved.
//
// This is the mouse-reporting-OFF case (a plain shell), where xterm's OWN
// `Viewport.handleTouchMove` does the scrolling. The mouse-reporting-ON case (an
// agent holding the mouse) is guarded by `mobile-terminal-scroll-mouse-tracking`.
// We drive the scroll with the cross-engine `touchDragY` helper (real touch
// events that run on chromium AND webkit) and assert `.xterm-viewport.scrollTop`
// changed.

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, touchDragY, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

test.describe('mobile: terminal scrollback scrolls on touch', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('one-finger drag scrolls xterm scrollback; hold still arms the joystick', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.addInitScript(injectGlobals(backend.token))
    // Pre-dismiss the A2HS sheet (it covers the terminal on iOS contexts).
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    })

    const A = api(backend)
    const created = await A.createSession({
      name: 'mob-scroll',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(created.status, 'create session').toBe(201)
    const started = await A.startSession('mob-scroll')
    expect(started.ok, 'start session').toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/mob-scroll`)

    // Wait for the live terminal + joystick layer.
    const surface = page.locator('[data-state="live"]')
    await expect(surface).toBeVisible({ timeout: 15_000 })
    const overlay = page.locator('[data-armed]')
    await expect(overlay).toHaveCount(1, { timeout: 15_000 })
    await expect(overlay).toHaveAttribute('data-armed', 'false')

    // Fill the scrollback well past one screen so there's something to scroll.
    // `seq 1 600` is a SHORT command (won't wrap at the narrow mobile width — a
    // wrapped multi-line command would stall at a shell continuation prompt) and
    // prints 600 lines, each on its own row → a tall scrollback.
    const term = page.getByRole('application', {
      name: 'Live terminal for mob-scroll',
    })
    await term.click()
    await page.keyboard.type('seq 1 600')
    await page.keyboard.press('Enter')

    // Let the pty stream the rows into xterm, then jump the viewport to the
    // BOTTOM (live tail) so a downward drag has scrollback above it to reveal.
    const viewport = page.locator('.xterm-viewport')
    await expect(viewport).toBeVisible({ timeout: 10_000 })
    await expect(async () => {
      const max = await viewport.evaluate(
        (el) => el.scrollHeight - el.clientHeight,
      )
      expect(max, 'scrollback must overflow the viewport').toBeGreaterThan(20)
    }).toPass({ timeout: 8_000 })

    // Park at the bottom so we can scroll UP into history.
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    const before = await viewport.evaluate((el) => el.scrollTop)
    expect(before, 'parked at bottom').toBeGreaterThan(0)

    // Real one-finger DRAG-DOWN on .xterm-screen. With mouse reporting OFF, xterm's
    // native handler scrolls the viewport; dragging the finger DOWN reveals history
    // → scrollTop decreases. The joystick layer must NOT swallow these (it's
    // pointer-events-none / unarmed), so the events reach xterm.
    const moved = await touchDragY(page, '.xterm-screen', 240, 20)

    // The scrollback moved (a drag-down reveals history → scrollTop decreases).
    expect(
      moved.after,
      `scrollTop must change on touch-drag (method=${moved.method} before=${moved.before} after=${moved.after})`,
    ).not.toBe(moved.before)
    expect(
      moved.after,
      'drag-down should scroll UP into history (scrollTop decreases)',
    ).toBeLessThan(moved.before)

    // The joystick is still summonable: a 350ms hold (no move) arms it.
    const armedMs: number = await overlay.evaluate(async (el) => {
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const pointer = (type: string): PointerEvent =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 7,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
        })
      const t0 = performance.now()
      el.dispatchEvent(pointer('pointerdown'))
      let elapsed = -1
      while (performance.now() - t0 < 800) {
        if (el.getAttribute('data-armed') === 'true') {
          elapsed = performance.now() - t0
          break
        }
        await new Promise((res) => setTimeout(res, 16))
      }
      el.dispatchEvent(pointer('pointerup'))
      return elapsed
    })
    expect(armedMs, 'joystick still arms on hold; -1 = never').toBeGreaterThan(0)
    expect(armedMs, `armed in ${Math.round(armedMs)}ms (< 500)`).toBeLessThan(500)
    // Release disarms.
    await expect(overlay).toHaveAttribute('data-armed', 'false', {
      timeout: 1_000,
    })
  })
})

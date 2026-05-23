// R5 e2e — mobile terminal scrollback scroll (iOS).
//
// REGRESSION GUARD for the R5 scroll fix. The M17 joystick used to render an
// `absolute inset-0 z-20 touch-none` overlay that blanketed the whole terminal,
// so a one-finger drag NEVER reached xterm's own touchmove scroll handler — the
// scrollback couldn't scroll on mobile. The fix makes the joystick layer
// pass-through (`pointer-events-none`) until ARMED, observing gestures via
// non-blocking listeners on the wrapper. So:
//   1. while UNARMED, a touch-drag inside the terminal reaches `.xterm-viewport`
//      and scrolls the scrollback (viewport.scrollTop changes), and
//   2. the joystick still arms on a 350ms hold (data-armed flips) and disarms on
//      release — the marquee interaction is preserved.
//
// We drive the scroll by writing enough rows to overflow the viewport, then
// dispatching REAL touch events on the xterm root so xterm's own
// `Viewport.handleTouchMove` runs (it reads `touchmove` directly). Asserting
// `.xterm-viewport.scrollTop` changes proves the scrollback actually scrolled.

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

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

    // Dispatch a real one-finger DRAG-DOWN on the xterm root. xterm's Viewport
    // reads raw touchstart/touchmove and sets `.xterm-viewport.scrollTop` itself
    // (handleTouchMove: scrollTop += lastY - curY). Dragging the finger DOWN
    // (curY increasing) decreases scrollTop → scrolls UP into history. The
    // joystick layer must NOT swallow these (it's pointer-events-none / unarmed),
    // so the events reach xterm and the scrollback moves.
    const moved: { before: number; after: number } = await viewport.evaluate(
      async (vp) => {
        const root =
          (vp.closest('.xterm') as HTMLElement | null) ??
          (vp.parentElement as HTMLElement)
        const r = root.getBoundingClientRect()
        const x = r.left + r.width / 2
        const startY = r.top + r.height * 0.3
        const before = vp.scrollTop
        // Chromium's TouchEvent constructor requires REAL Touch instances (a cast
        // plain object fails to convert) — build them with `new Touch(...)`.
        const mk = (clientY: number) =>
          new Touch({
            identifier: 1,
            target: root,
            clientX: x,
            clientY,
            pageX: x,
            pageY: clientY,
            screenX: x,
            screenY: clientY,
            radiusX: 1,
            radiusY: 1,
            rotationAngle: 0,
            force: 1,
          })
        const fire = (type: string, clientY: number) => {
          const t = mk(clientY)
          root.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              touches: type === 'touchend' ? [] : [t],
              targetTouches: type === 'touchend' ? [] : [t],
              changedTouches: [t],
            }),
          )
        }
        fire('touchstart', startY)
        // Move the finger DOWN in steps (each touchmove pulls history down).
        for (let dy = 12; dy <= 240; dy += 12) {
          fire('touchmove', startY + dy)
          await new Promise((res) => setTimeout(res, 8))
        }
        fire('touchend', startY + 240)
        return { before, after: vp.scrollTop }
      },
    )

    // The scrollback moved (a drag-down reveals history → scrollTop decreases).
    expect(
      moved.after,
      `scrollTop must change on touch-drag (before=${moved.before} after=${moved.after})`,
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

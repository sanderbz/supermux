// Regression guard: mobile terminal scrollback must scroll on one-finger touch
// EVEN WHILE THE AGENT HOLDS THE MOUSE (DECSET ?1000/?1002/?1006 — what Claude
// Code's TUI does almost always).
//
// xterm 5.5's OWN touch-scroll handler (Viewport.handleTouchMove) early-returns
// when `coreMouseService.areMouseEventsActive` is true, forwarding the touch as a
// mouse report instead of panning the scrollback — so on mobile, history could not
// be scrolled by one finger while an agent was attached (wheel/2-finger use other
// paths, so they kept working: the exact reported regression). The fix adds our
// own single-finger touch shim on `.xterm-screen` that scrolls via
// `term.scrollLines()` (renderer-safe — a raw `viewport.scrollTop += dy` does NOT
// repaint the WebGL canvas) whenever mouse reporting is on and we're in the normal
// buffer. This complements `mobile-terminal-scroll.spec.ts` (the mouse-OFF case,
// which xterm handles natively).
//
// We enable mouse reporting by emitting the DECSET sequences from the shell (then
// `sleep` so the prompt redraw can't reset them), then dispatch REAL touch events
// on `.xterm-screen` (where the shim listens) and assert the scrollback moved.

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

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

    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    const before = await viewport.evaluate((el) => el.scrollTop)
    expect(before, 'parked at bottom').toBeGreaterThan(0)

    // Real one-finger DRAG-DOWN on .xterm-screen (where the shim's listener lives).
    // Drag-down reveals history → scrollTop decreases. With mouse-tracking on,
    // xterm's own handler is gated, so this MUST go through our shim.
    const moved = await page.locator('.xterm-screen').evaluate(async (screen) => {
      const vp = document.querySelector('.xterm-viewport') as HTMLElement
      const r = screen.getBoundingClientRect()
      const x = r.left + r.width / 2
      const mk = (clientY: number) =>
        new Touch({ identifier: 1, target: screen, clientX: x, clientY, pageX: x, pageY: clientY, screenX: x, screenY: clientY, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 })
      const fire = (type: string, clientY: number) => {
        const t = mk(clientY)
        screen.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t] }))
      }
      const startY = r.top + r.height * 0.3
      const before = vp.scrollTop
      fire('touchstart', startY)
      for (let dy = 16; dy <= 260; dy += 16) {
        fire('touchmove', startY + dy)
        await new Promise((res) => setTimeout(res, 8))
      }
      fire('touchend', startY + 260)
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      return { before, after: vp.scrollTop }
    })

    expect(moved.after, `scrollTop must change on touch-drag with mouse-tracking on (before=${moved.before} after=${moved.after})`).not.toBe(moved.before)
    expect(moved.after, 'drag-down scrolls UP into history (scrollTop decreases)').toBeLessThan(moved.before)
  })
})

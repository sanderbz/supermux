// M24b e2e — joystick-arms (TECH_PLAN §10 "M24b"; §4; M17 — THE interaction).
//
// Mobile (iPhone 14 Pro) viewport: open mobile focus and long-press the
// terminal viewport. The M17 joystick must ARM (its overlay flips
// `data-armed="true"`) within 400ms of the press — the 350ms hold-to-arm
// threshold plus headroom. A premature release (well under 350ms) must NOT arm.
//
// The press is driven by REAL `PointerEvent`s dispatched on the joystick
// overlay. Playwright's mouse/touch input is funnelled through hit-testing
// against the Vaul focus-sheet's transformed coordinate space, which makes raw
// coordinate gestures flaky here; dispatching genuine pointer events on the
// overlay element exercises the exact `onPointerDown` → 350ms arm-timer →
// `setArmed` render path the real interaction uses.

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

test.describe('mobile: joystick hold-to-arm', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('long-press the terminal → joystick arms within 400ms', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.addInitScript(injectGlobals(backend.token))
    // Pre-dismiss the M23b "Add to Home Screen" sheet — on an iOS-emulating
    // context it auto-opens as a focus-trapping modal that covers the terminal
    // viewport (and the joystick overlay). Setting its localStorage dismiss key
    // reflects the normal returning-user state.
    await page.addInitScript(() => {
      localStorage.setItem('amux-v3-a2hs-dismissed', String(Date.now()))
    })

    const created = await api(backend).createSession({
      name: 'mob-joy',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(created.status, 'create session').toBe(201)

    await page.goto(`${backend.baseUrl}/focus/mob-joy`)

    // The joystick overlay covers the terminal viewport; it exposes its armed
    // state via data-armed. It mounts as soon as MobileFocus renders.
    const overlay = page.locator('[data-armed]')
    await expect(overlay).toHaveCount(1, { timeout: 15_000 })
    await expect(overlay).toHaveAttribute('data-armed', 'false')

    // Hold: dispatch a pointerdown on the overlay centre and poll how long it
    // takes for data-armed to flip. The full press loop runs in-page so the
    // measured elapsed time is the joystick's own arm latency, not Playwright
    // round-trip overhead.
    const armedMs: number = await overlay.evaluate(async (el) => {
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const pointer = (type: string): PointerEvent =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
        })
      const t0 = performance.now()
      el.dispatchEvent(pointer('pointerdown'))
      // Poll every 16ms (a frame) for the arm.
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

    // The joystick must arm — and within 400ms of the press (350ms threshold +
    // slack). A -1 means it never armed inside the 800ms window.
    expect(armedMs, 'joystick arm latency (ms); -1 = never armed').toBeGreaterThan(
      0,
    )
    expect(
      armedMs,
      `joystick armed in ${Math.round(armedMs)}ms (must be < 400ms)`,
    ).toBeLessThan(400)

    // After release the overlay disarms.
    await expect(overlay).toHaveAttribute('data-armed', 'false', {
      timeout: 1_000,
    })

    // Negative path: a quick tap-and-release (well under the 350ms threshold)
    // must NOT arm.
    const armedOnQuickTap: boolean = await overlay.evaluate(async (el) => {
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const pointer = (type: string): PointerEvent =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
        })
      el.dispatchEvent(pointer('pointerdown'))
      await new Promise((res) => setTimeout(res, 120))
      const armedMid = el.getAttribute('data-armed') === 'true'
      el.dispatchEvent(pointer('pointerup'))
      return armedMid
    })
    expect(armedOnQuickTap, 'quick tap must NOT arm the joystick').toBe(false)
    await expect(overlay).toHaveAttribute('data-armed', 'false')
  })
})

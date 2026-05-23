// MTAP e2e — mobile terminal tap-vs-swipe focus gate (iOS soft keyboard fix).
//
// REGRESSION GUARD for the MTAP fix. The terminal-body wrapper used to focus
// xterm on EVERY pointer-up — including the pointer-up that ENDS a scroll
// gesture — so swiping to read scrollback also summoned the iOS soft keyboard.
// The fix gates focus behind TAP detection (same pointer, <10px travel, <500ms):
//   1. a SWIPE over the terminal must NOT focus xterm (no keyboard), and
//   2. a genuine TAP (finger down→up, no movement) MUST focus xterm (keyboard).
//
// We can't observe the iOS keyboard in Chromium, so we use the proxy xterm uses
// itself: `term.focus()` focuses the hidden `.xterm-helper-textarea`, which then
// becomes `document.activeElement`. After a swipe it must NOT be active; after a
// tap it must be active. The wrapper's React handlers listen for PointerEvents,
// so we dispatch real `new PointerEvent(...)` on the wrapper to drive them.

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

test.describe('mobile: terminal tap focuses xterm, swipe does not', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('swipe does NOT focus xterm (no keyboard); tap DOES focus xterm', async ({
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
      name: 'mob-tap',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(created.status, 'create session').toBe(201)
    const started = await A.startSession('mob-tap')
    expect(started.ok, 'start session').toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/mob-tap`)

    // Wait for the live terminal layer.
    const surface = page.locator('[data-state="live"]')
    await expect(surface).toBeVisible({ timeout: 15_000 })

    // Fill the scrollback so a swipe has somewhere to travel (and so the swipe
    // is a real over-the-terminal gesture, not a no-op on an empty screen).
    const term = page.getByRole('application', {
      name: 'Live terminal for mob-tap',
    })
    await term.click()
    await page.keyboard.type('seq 1 600')
    await page.keyboard.press('Enter')

    const viewport = page.locator('.xterm-viewport')
    await expect(viewport).toBeVisible({ timeout: 10_000 })
    await expect(async () => {
      const max = await viewport.evaluate(
        (el) => el.scrollHeight - el.clientHeight,
      )
      expect(max, 'scrollback must overflow the viewport').toBeGreaterThan(20)
    }).toPass({ timeout: 8_000 })

    // The wrapper that owns the tap-vs-swipe handlers (the `data-vaul-no-drag`
    // terminal body). Helper to know whether xterm's hidden textarea is focused.
    const helperFocused = () =>
      page.evaluate(() => {
        const a = document.activeElement
        return !!a && a.classList.contains('xterm-helper-textarea')
      })

    // ── 1. SWIPE must NOT focus xterm ─────────────────────────────────────────
    // First blur xterm (it auto-focuses on mount) so a stale focus can't mask a
    // regression. Then dispatch a one-finger DRAG via real PointerEvents on the
    // wrapper; the React onPointerDown/Up handlers run and must classify it as a
    // swipe (>10px travel) → no focusTerm() → helper textarea stays blurred.
    await page.evaluate(() => {
      const a = document.activeElement
      if (a instanceof HTMLElement) a.blur()
    })
    expect(await helperFocused(), 'blurred before swipe').toBe(false)

    await viewport.evaluate(async (vp) => {
      const wrap = vp.closest('[data-vaul-no-drag]') as HTMLElement
      const r = wrap.getBoundingClientRect()
      const x = r.left + r.width / 2
      const startY = r.top + r.height * 0.4
      const pe = (type: string, clientY: number): PointerEvent =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 11,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY,
          button: 0,
        })
      wrap.dispatchEvent(pe('pointerdown', startY))
      for (let dy = 12; dy <= 200; dy += 12) {
        wrap.dispatchEvent(pe('pointermove', startY + dy))
        await new Promise((res) => setTimeout(res, 6))
      }
      wrap.dispatchEvent(pe('pointerup', startY + 200))
    })
    expect(
      await helperFocused(),
      'swipe must NOT focus xterm (keyboard must not open)',
    ).toBe(false)

    // ── 2. TAP must focus xterm ───────────────────────────────────────────────
    // A pointerdown→pointerup with no movement and short duration → tap → focus.
    await viewport.evaluate((vp) => {
      const wrap = vp.closest('[data-vaul-no-drag]') as HTMLElement
      const r = wrap.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height * 0.5
      const pe = (type: string): PointerEvent =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 12,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
        })
      wrap.dispatchEvent(pe('pointerdown'))
      wrap.dispatchEvent(pe('pointerup'))
    })
    await expect(async () => {
      expect(
        await helperFocused(),
        'tap must focus xterm (keyboard opens, keystrokes route to xterm)',
      ).toBe(true)
    }).toPass({ timeout: 2_000 })
  })
})

// Regression guard: mobile terminal scrollback must scroll on a ONE-FINGER touch
// EVEN WHEN THE AGENT HOLDS THE MOUSE (DECSET ?1000/?1002/?1006 — what Claude
// Code's TUI emits almost continuously).
//
// ROOT CAUSE (proven at the byte level). xterm 5.5's own touch-scroll listeners
// early-return when `coreMouseService.areMouseEventsActive` is true:
//
//     "touchstart", e => { if (!areMouseEventsActive) viewport.handleTouchStart(e) }
//     "touchmove",  e => { if (!areMouseEventsActive) viewport.handleTouchMove(e) }
//
// So once an app turns mouse reporting ON, a one-finger drag is DROPPED and the
// scrollback can no longer be panned. supermux tried to fix this server-side with
// `CLAUDE_CODE_DISABLE_MOUSE=1`, but Claude Code 2.1.156 IGNORES that env var and
// still emits ?1000h/?1002h/?1003h/?1006h (confirmed in the live pty logs). The
// real fix neutralizes mouse mode on the CLIENT: a parser CSI handler in
// use-live-term.ts swallows the mouse-tracking DECSET set/reset sequences before
// xterm's coreMouseService ever sees them, so `areMouseEventsActive` stays false
// and xterm's OWN native one-finger touch-scroll keeps working — no custom shim.
//
// This complements `mobile-terminal-scroll.spec.ts` (the mouse-OFF case xterm
// handles natively). Here we deliberately turn mouse reporting ON from the shell,
// then prove a one-finger drag STILL scrolls — which can only be true if the
// client refuses to enter mouse mode. We drive a REAL one-finger drag via the
// cross-engine `touchDragY` helper (runs on chromium AND webkit).
//
// ENGINE NOTE: the gate is plain xterm JS (engine-independent), so chromium
// proves the fix mechanism. Real iOS WebKit verification runs with
// `SUPERMUX_E2E_WEBKIT=1 npx playwright test --project=webkit`.

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
    // Pre-dismiss the A2HS sheet (it covers the terminal on iOS contexts).
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    })

    const A = api(backend)
    expect(
      (await A.createSession({ name: 'mob-mt', provider: 'shell', dir: backend.dataDir })).status,
      'create session',
    ).toBe(201)
    expect((await A.startSession('mob-mt')).ok, 'start session').toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/mob-mt`)
    await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: 15_000 })

    // Focus the terminal and fill the scrollback so there's history to pan into.
    await page.locator('.xterm-screen').click()
    await page.keyboard.type('seq 1 600')
    await page.keyboard.press('Enter')

    const viewport = page.locator('.xterm-viewport')
    await expect(viewport).toBeVisible({ timeout: 10_000 })
    await expect(async () => {
      const max = await viewport.evaluate((el) => el.scrollHeight - el.clientHeight)
      expect(max, 'scrollback must overflow').toBeGreaterThan(20)
    }).toPass({ timeout: 8_000 })

    // Turn mouse reporting ON from the shell (so xterm WOULD gate its own touch
    // handler), then `sleep` so the prompt redraw can't reset it mid-test. This is
    // exactly what an agent does — and what made one-finger scroll dead.
    await page.keyboard.type("printf '\\033[?1000h\\033[?1002h\\033[?1006h'; sleep 30")
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)

    // Park at the bottom so a drag-down has history to reveal.
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    const parked = await viewport.evaluate((el) => el.scrollTop)
    expect(parked, 'parked at bottom').toBeGreaterThan(0)

    // A full one-finger drag-down on .xterm-screen. With mouse reporting on AND
    // the client neutralizing mouse mode, xterm's NATIVE touch-scroll runs and
    // reveals history → scrollTop decreases. Without the fix the drag is dropped
    // and scrollTop is unchanged (this assertion fails — the reported bug).
    const moved = await touchDragY(page, '.xterm-screen', 260, 16)
    expect(
      moved.after,
      `scrollTop must change on a one-finger drag with mouse-tracking on (method=${moved.method} before=${moved.before} after=${moved.after})`,
    ).not.toBe(moved.before)
    expect(
      moved.after,
      'drag-down scrolls UP into history (scrollTop decreases)',
    ).toBeLessThan(moved.before)
  })
})

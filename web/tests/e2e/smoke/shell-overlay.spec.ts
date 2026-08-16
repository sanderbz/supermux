// B1 T6 — <ShellOverlay>'s two device forms, proven where they are real.
//
// The unit suite pins the desktop frame's markup contract; only a browser can
// prove the two things that actually matter about this component:
//
//   1. DESKTOP — the overlay lives INSIDE the content column. The nav rail is
//      still visible and still clickable beside the scrim, which is the whole
//      difference between "an object on this page" and "a modal that replaced
//      the app". Scrim-click and Esc both dismiss; focus is trapped while open
//      and returns to the trigger on close.
//   2. MOBILE — the SAME component renders the Vaul sheet and NO shell overlay,
//      because the mobile focus route lives in a body-level fixed sheet that
//      would occlude a shell-absolute one. That half lives in
//      `shell-overlay-mobile.spec.ts`: it needs a touch-emulating context, and
//      this host cannot hold two contexts at once.
//
// The subject is `<ArchivedSheet>` — ShellOverlay's first consumer, mounted at
// shell level in layout.tsx and opened from the overview's "Archived" button.

import { expect, test } from '@playwright/test'
import { injectGlobals, startBackend, type Backend } from './harness'

test.describe('shell overlay', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  // Desktop only. The mobile form needs a touch-emulating context
  // (`devices['iPhone 14 Pro']` → `pointer: coarse`), and this host runs
  // chromium `--single-process`, where a second context in the same spec file
  // cannot be created — so it lives in `shell-overlay-mobile.spec.ts`.
  test('desktop: the overlay lives inside the content column and is dismissible', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
      localStorage.setItem('supermux-first-launch', String(Date.now()))
    })

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${backend.baseUrl}/`)

    const rail = page.locator('nav[aria-label="Primary"]').first()
    await expect(rail).toBeVisible({ timeout: 20_000 })

    const trigger = page.getByRole('button', { name: /Archived/i }).first()
    await expect(trigger).toBeVisible({ timeout: 10_000 })
    await trigger.click()

    const overlay = page.locator('[data-testid="shell-overlay"]')
    const frame = page.locator('[data-testid="shell-overlay-frame"]')
    await expect(overlay).toBeVisible({ timeout: 10_000 })

    // ── (1) It is bounded by the CONTENT COLUMN, not the viewport ────────────
    const geom = await page.evaluate(() => {
      const o = document.querySelector('[data-testid="shell-overlay"]')!
      const main = document.querySelector('[data-shell-content]')!
      const or = o.getBoundingClientRect()
      const mr = main.getBoundingClientRect()
      return {
        overlay: { left: or.left, width: or.width },
        column: { left: mr.left, width: mr.width },
        position: getComputedStyle(o).position,
      }
    })
    expect(geom.position, 'the overlay is absolute, never fixed').toBe('absolute')
    expect(
      Math.abs(geom.overlay.left - geom.column.left),
      'the overlay starts where the content column starts',
    ).toBeLessThan(2)
    expect(Math.abs(geom.overlay.width - geom.column.width)).toBeLessThan(2)
    expect(
      geom.overlay.left,
      'it does NOT cover the nav rail (which is to its left)',
    ).toBeGreaterThan(0)

    // ── The nav rail is still visible AND still clickable behind the scrim ───
    await expect(rail).toBeVisible()
    const railHit = await page.evaluate(() => {
      const link = document.querySelector(
        'nav[aria-label="Primary"] a',
      ) as HTMLElement
      const r = link.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit && link.contains(hit)
    })
    expect(railHit, 'the nav rail is hit-testable while the overlay is open').toBe(
      true,
    )

    // ── Focus is trapped inside the frame ───────────────────────────────────
    await page.keyboard.press('Tab')
    const focusInside = await page.evaluate(
      () =>
        !!document
          .querySelector('[data-testid="shell-overlay-frame"]')
          ?.contains(document.activeElement),
    )
    expect(focusInside, 'focus is trapped in the overlay frame').toBe(true)

    // ── Esc dismisses ───────────────────────────────────────────────────────
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0, { timeout: 5_000 })

    // ── Scrim click dismisses too ───────────────────────────────────────────
    await trigger.click()
    await expect(frame).toBeVisible({ timeout: 10_000 })
    // Click the scrim well away from the centred frame (top-left of the column).
    const scrimPoint = await frame.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left / 2, y: 24 }
    })
    await page.mouse.click(scrimPoint.x, scrimPoint.y)
    await expect(overlay).toHaveCount(0, { timeout: 5_000 })
  })
})

// B1 T9.6 — the onboarding tour's step 3 anchors on a REAL element.
//
// Step 3 used to point at the Scheduler nav item. B1 folded the scheduler into
// Settings and dropped that item, so the anchor was retargeted to
// `[data-tour="settings"]`. The failure this guards against is a quiet one:
// `floating-tip.tsx` falls back to a screen-centred card when its anchor is
// missing, so a dangling anchor does not throw, does not log, and does not fail
// any existing test — the tour simply stops pointing at anything while telling
// the user about a feature.
//
// `tests/unit/tour-anchors.test.ts` guarantees every selector EXISTS in the
// source. This spec proves the runtime consequence: on step 3 the tip is
// positioned against the Settings nav item's rect, not parked in the middle of
// the screen.

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.describe('onboarding tour', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('step 3 anchors on the Settings nav item, not the centred fallback', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
      // Deliberately DO NOT set `supermux-first-launch` — the tour only offers
      // itself on a first launch that already has sessions (the migrated-v2
      // branch in onboarding-host.tsx).
      localStorage.removeItem('supermux-first-launch')
    })
    await page.setViewportSize({ width: 1280, height: 800 })

    // The welcome banner only appears when sessions already exist.
    const A = api(backend)
    expect(
      (await A.createSession({ name: 'tourdemo', provider: 'shell', dir: backend.dataDir }))
        .status,
    ).toBe(201)

    await page.goto(`${backend.baseUrl}/`)

    await page.getByRole('button', { name: 'Take the tour' }).click({ timeout: 25_000 })

    // Advance to step 3. The tip's aria-label carries the step number, which is
    // a far more robust progress signal than counting clicks.
    const tip = page.getByRole('dialog', { name: /Tour step \d of \d/ })
    await expect(tip).toBeVisible({ timeout: 10_000 })
    for (let i = 0; i < 2; i++) {
      await tip.getByRole('button', { name: /Next|Got it/ }).click()
    }
    await expect(
      page.getByRole('dialog', { name: /Tour step 3 of \d/ }),
    ).toBeVisible({ timeout: 10_000 })

    // The copy names its new home.
    await expect(page.getByText(/Schedules live in Settings now/)).toBeVisible()

    // ── The load-bearing assertion: anchored, not centred ───────────────────
    const geom = await page.evaluate(() => {
      const card = document.querySelector(
        '[role="dialog"][aria-label^="Tour step 3"]',
      ) as HTMLElement
      // The first VISIBLE `data-tour="settings"` — the attribute is on both the
      // desktop rail and the mobile tab bar, and the off-breakpoint copy is
      // display:none with an all-zero rect.
      const anchors = Array.from(
        document.querySelectorAll('[data-tour="settings"]'),
      ) as HTMLElement[]
      const anchor = anchors.find((el) => el.getBoundingClientRect().width > 0)
      const c = card.getBoundingClientRect()
      const a = anchor?.getBoundingClientRect()
      return {
        cardCentreX: c.left + c.width / 2,
        anchorCentreX: a ? a.left + a.width / 2 : null,
        anchorFound: !!a,
        viewportCentreX: window.innerWidth / 2,
        // The centred fallback is the ONLY thing that sets this transform.
        transform: getComputedStyle(card).transform,
      }
    })

    expect(geom.anchorFound, 'a visible [data-tour="settings"] exists').toBe(true)
    expect(
      Math.abs(geom.cardCentreX - (geom.anchorCentreX ?? 0)),
      'the tip is positioned against the Settings nav item',
    ).toBeLessThan(200)
    expect(
      Math.abs(geom.cardCentreX - geom.viewportCentreX),
      'and it is NOT the screen-centred no-anchor fallback',
    ).toBeGreaterThan(200)
  })
})

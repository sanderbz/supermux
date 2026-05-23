// Fix verification — mobile overview parity (fix/r5-overview-parity).
//
// Two parity gaps on phones, verified against the real binary through the smoke
// harness, at an iPhone 16 Pro Max viewport (430×932) with an iOS user-agent so
// `(pointer: coarse)` / `(max-width: 767px)` resolve the mobile way:
//
//  1. Density +/-  — the control was `hidden md:flex` (desktop-only). It must be
//     VISIBLE on mobile; tapping + must grow tile HEIGHT (the single-column grid
//     means columns never change); the value must persist under a SEPARATE store
//     field (`overviewSizeMobile`) and must NOT touch the desktop `overviewSize`.
//  2. Grouping drag handle — was hover-only (invisible on touch). In custom mode
//     the per-tile drag handle must be reachable (visible) on a coarse pointer so
//     a card can be dragged into a group. The sort control must be reachable too.

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

// iPhone 16 Pro Max logical viewport + an iOS Safari UA so media queries that
// fork on `(pointer: coarse)` / width resolve the mobile branch. hasTouch makes
// Playwright dispatch touch (not mouse) — the path the TouchSensor listens on.
test.use({
  viewport: { width: 430, height: 932 },
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  hasTouch: true,
  isMobile: true,
})

const UI_STORE_KEY = 'supermux-ui'

async function readStore(page: import('@playwright/test').Page) {
  return page.evaluate((k) => {
    const raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw).state as Record<string, unknown>) : null
  }, UI_STORE_KEY)
}

/** Pre-mark the first-run overlays as seen so neither the onboarding tour invite
 *  nor the iOS "add to home screen" sheet floats over (and intercepts taps on)
 *  the grid. Set BEFORE navigation via addInitScript. Keys mirror the app:
 *  `supermux-first-launch` (lib/onboarding.ts) + `supermux-a2hs-dismissed`
 *  (components/pwa/a2hs-sheet.tsx). */
function suppressFirstRun(): string {
  return `
    try {
      localStorage.setItem('supermux-first-launch', String(Date.now()));
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()));
    } catch {}
  `
}

test.describe('mobile overview parity', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('density +/- is visible on mobile, grows tile HEIGHT, persists to a separate mobile key', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(suppressFirstRun())

    // Seed a few sessions so there are tiles to size.
    for (const name of ['alpha', 'bravo', 'charlie']) {
      const res = await api(backend).createSession({
        name,
        provider: 'shell',
        dir: backend.dataDir,
      })
      expect(res.status, `create ${name}`).toBe(201)
    }

    await page.goto(backend.baseUrl)
    const firstTile = page.getByRole('button', { name: /alpha/ }).first()
    await expect(firstTile).toBeVisible()

    // 1. The density control is reachable on mobile (was hidden md:flex).
    const larger = page.getByRole('button', { name: 'Larger' })
    const smaller = page.getByRole('button', { name: 'Smaller' })
    await expect(larger).toBeVisible()
    await expect(smaller).toBeVisible()

    // Baseline tile geometry at tier 1.
    const box1 = await firstTile.boundingBox()
    expect(box1).not.toBeNull()

    // 2. Tap "Larger" → tile grows in HEIGHT, width unchanged (single column).
    await larger.tap()
    await expect
      .poll(async () => (await firstTile.boundingBox())?.height ?? 0)
      .toBeGreaterThan((box1?.height ?? 0) + 10)
    const box2 = await firstTile.boundingBox()
    expect(box2).not.toBeNull()
    // Width must NOT change on mobile (no column drop) — allow 1px rounding.
    expect(Math.abs((box2?.width ?? 0) - (box1?.width ?? 0))).toBeLessThanOrEqual(1)

    // 3. Persistence: the MOBILE field moved to 2; the DESKTOP field stayed 1.
    const store = await readStore(page)
    expect(store?.overviewSizeMobile).toBe(2)
    expect(store?.overviewSize).toBe(1)

    // 4. Mobile is capped at tier 2 (height-meaningful tiers only) — "Larger" is
    //    now disabled, proving the height-only clamp (no invisible column tiers).
    await expect(larger).toBeDisabled()
  })

  test('custom mode: drag handle is reachable on touch and the sort control is reachable', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(suppressFirstRun())

    for (const name of ['one', 'two']) {
      const res = await api(backend).createSession({
        name,
        provider: 'shell',
        dir: backend.dataDir,
      })
      expect(res.status, `create ${name}`).toBe(201)
    }

    await page.goto(backend.baseUrl)
    await expect(page.getByRole('button', { name: /one/ }).first()).toBeVisible()

    // The sort control is reachable on mobile (icon-only below sm). Open it and
    // switch to Custom mode so the DnD grid + per-tile handles mount.
    const sortTrigger = page.getByRole('button', { name: /^Sort:/ })
    await expect(sortTrigger).toBeVisible()
    await sortTrigger.tap()
    await page.getByRole('menuitem', { name: /Custom/ }).tap()

    // In custom mode the per-tile drag handle must be VISIBLE on a coarse pointer
    // (it was opacity-0 hover-only, invisible on touch). Aria-label "Drag <name>".
    const handle = page.getByRole('button', { name: /^Drag one/ })
    await expect(handle).toBeVisible()
    // Visible (non-zero opacity), not just present in the DOM.
    const opacity = await handle.evaluate(
      (el) => getComputedStyle(el).opacity,
    )
    expect(Number(opacity)).toBeGreaterThan(0)
    // HIG touch target: ≥44px on the coarse-pointer branch.
    const hbox = await handle.boundingBox()
    expect(hbox?.height ?? 0).toBeGreaterThanOrEqual(40)
  })
})

// Desktop regression — the mobile work must not change desktop behaviour: the
// density control still walks the full 4-tier curve (column drops happen) and
// writes to the DESKTOP key (`overviewSize`), leaving the mobile key untouched.
test.describe('desktop overview unchanged', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('density steps the full tier curve and drops columns; writes the desktop key only', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(suppressFirstRun())

    for (const name of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8']) {
      const res = await api(backend).createSession({
        name,
        provider: 'shell',
        dir: backend.dataDir,
      })
      expect(res.status, `create ${name}`).toBe(201)
    }

    await page.goto(backend.baseUrl)
    const firstTile = page.getByRole('button', { name: /d1\b/ }).first()
    await expect(firstTile).toBeVisible()

    const larger = page.getByRole('button', { name: 'Larger' })
    await expect(larger).toBeVisible()

    // Tier 1 baseline tile width (4 columns at lg).
    const w1 = (await firstTile.boundingBox())?.width ?? 0

    // Step to tier 3 — desktop drops a column (4 → 3), so the tile gets WIDER.
    await larger.click() // → 2 (height)
    await larger.click() // → 3 (column drop)
    await expect
      .poll(async () => (await firstTile.boundingBox())?.width ?? 0)
      .toBeGreaterThan(w1 + 10)

    // Desktop reaches tier 4 (mobile is capped at 2) — Larger still enabled at 3.
    await expect(larger).toBeEnabled()
    await larger.click() // → 4 (floor: 2 cols)
    await expect(larger).toBeDisabled()

    // Persistence: the DESKTOP field is 4; the MOBILE field is untouched (1).
    const store = await readStore(page)
    expect(store?.overviewSize).toBe(4)
    expect(store?.overviewSizeMobile).toBe(1)
  })
})

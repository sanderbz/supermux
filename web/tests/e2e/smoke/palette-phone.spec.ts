// The palette is reachable — and touch-sized — on a phone.
//
// THE DEFECT. ⌘K had exactly one visible trigger app-wide and it lived in the
// DESKTOP dock, so enumerating every visible control at 390×844 on /overview
// and /focus/<name> returned zero matching /palette|search|command|jump/: the
// app's discovery spine could only be opened by a physical keyboard. And when
// it WAS opened that way it rendered desktop metrics — 38px rows against the
// picker primitive's own documented 44pt phone rung, in a box pinned 20% down
// the screen with no safe-area inset.
//
// B3's ledger carried "the palette becomes reachable on a phone" (T4.4) as an
// unchanged non-negotiable and left it unchecked; this is that task.

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

test.describe('the palette on a phone', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('a finger can open it, and its rows are 44pt', async ({ page }) => {
    test.setTimeout(75_000)
    await page.addInitScript(injectGlobals(backend.token))
    // Pre-mark the first-run overlays as seen — the tour invite is a fixed
    // glass card that intercepts taps on the grid (the same recipe
    // overview-mobile-parity.spec.ts uses).
    await page.addInitScript(() => {
      localStorage.setItem('supermux-first-launch', String(Date.now()))
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    })

    const A = api(backend)
    expect(
      (await A.createSession({ name: 'ph-one', provider: 'shell', dir: backend.dataDir }))
        .status,
    ).toBe(201)

    await page.goto(`${backend.baseUrl}/`)
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 })

    // ── there is a control, and a finger can hit it ──────────────────────────
    const search = page.getByRole('button', { name: 'Search' })
    await expect(search).toBeVisible({ timeout: 10_000 })
    const searchBox = await search.boundingBox()
    expect(searchBox!.height, 'the search tab is a 44pt target').toBeGreaterThanOrEqual(44)

    await search.tap()

    const list = page.getByRole('listbox', { name: 'Palette results' })
    await expect(list).toBeVisible({ timeout: 10_000 })

    // ── and the palette it opens is a touch surface ──────────────────────────
    const firstRow = list.getByRole('option').first()
    await expect(firstRow).toBeVisible({ timeout: 10_000 })
    const rowBox = await firstRow.boundingBox()
    expect(rowBox!.height, 'phone rows are the primitive’s 44pt rung').toBeGreaterThanOrEqual(
      44,
    )

    // The box clears the notch rather than floating 20% down the screen, and
    // it does not run off either edge.
    const dialog = page.getByRole('dialog').filter({ has: list })
    const dialogBox = await dialog.boundingBox()
    expect(dialogBox!.y, 'below the safe-area top, not 20% down').toBeLessThan(80)
    expect(dialogBox!.x, 'inside the left edge').toBeGreaterThanOrEqual(0)
    expect(dialogBox!.x + dialogBox!.width, 'inside the right edge').toBeLessThanOrEqual(391)

    // ── it can be picked with a finger ──────────────────────────────────────
    await page.getByRole('option', { name: /ph-one/ }).first().tap()
    await expect(page).toHaveURL(/\/focus\/ph-one$/, { timeout: 15_000 })
  })
})

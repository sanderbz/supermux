// feat-archive-recover smoke e2e — browse + restore/purge archived sessions.
//
// Archive is a soft delete; this verifies the recovery surface end-to-end
// through the REAL binary + the actual UI (no mocks):
//   1. Seed a session, archive it via the API (no tmux needed — list filters on
//      the row alone). It drops out of the overview.
//   2. Open the Archived sheet via the ⌘K command "View archived sessions" AND
//      via the overview overflow item — both list the archived row.
//   3. Restore (unarchive) → the row returns to the overview live.
//   4. Re-archive → Delete forever (inline confirm) → the row is gone for good
//      and the sheet shows the "No archived sessions." empty state.
//
// Run on desktop (1440) and a mobile viewport (430×932) so both ResponsiveSheet
// shells (right-side dialog / Vaul bottom sheet) are exercised.

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

/** Archive a session straight through the backend (the tile's archive flow
 *  needs no tmux for the DB flip). */
async function archive(backend: Backend, name: string): Promise<void> {
  const res = await fetch(
    `${backend.backendUrl}/api/sessions/${encodeURIComponent(name)}/archive`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.token}` },
    },
  )
  expect(res.status, `archive ${name}`).toBe(202)
}

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'mobile', width: 430, height: 932 },
] as const

for (const vp of VIEWPORTS) {
  test.describe(`archived recover (${vp.label})`, () => {
    let backend: Backend

    test.beforeEach(async ({ page }) => {
      backend = await startBackend()
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.addInitScript(injectGlobals(backend.token))
    })
    test.afterEach(async () => {
      await backend?.dispose()
    })

    test('archive → browse via overflow + ⌘K → restore → re-archive → delete forever', async ({
      page,
    }) => {
      const name = 'arch-e2e'

      // Seed + archive a session.
      expect(
        (await api(backend).createSession({ name, provider: 'shell', dir: backend.dataDir }))
          .status,
      ).toBe(201)
      await archive(backend, name)

      await page.goto(backend.baseUrl)

      // The archived row is NOT in the overview.
      await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveCount(0)

      // ── Entry point A: the overview overflow item (shows the count) ──────────
      const overflow = page.getByRole('button', { name: /archived/i }).first()
      await expect(overflow).toBeVisible()
      await overflow.click()

      // The sheet lists the archived session.
      const sheetRow = page.getByRole('listitem').filter({ hasText: name })
      await expect(sheetRow).toBeVisible()

      // Restore → row leaves the sheet, then returns to the overview live.
      await sheetRow.getByRole('button', { name: `Restore ${name}` }).click()
      await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0)
      // Close the sheet so the (now-restored) tile is the active surface again.
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: new RegExp(name) }).first()).toBeVisible()

      // ── Entry point B: the ⌘K command "View archived sessions" ──────────────
      // Re-archive first so there's something to show.
      await archive(backend, name)
      // Give the overview a beat to drop the row, then open via the palette.
      await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveCount(0)

      await page.keyboard.press('Meta+k')
      await expect(page.getByRole('listbox', { name: 'Palette results' })).toBeVisible()
      await page.getByRole('option', { name: 'View archived sessions' }).click()

      const sheetRow2 = page.getByRole('listitem').filter({ hasText: name })
      await expect(sheetRow2).toBeVisible()

      // Delete forever → inline confirm → permanent removal.
      await sheetRow2.getByRole('button', { name: `Delete ${name} forever` }).click()
      await sheetRow2.getByRole('button', { name: 'Delete forever' }).click()

      // The row is gone and the empty state shows.
      await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0)
      await expect(page.getByText('No archived sessions.')).toBeVisible()

      // And it never came back to the overview.
      await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveCount(0)
    })
  })
}

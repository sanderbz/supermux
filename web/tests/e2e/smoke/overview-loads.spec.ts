// M24a smoke #1 — overview-loads (TECH_PLAN §10 "M24a"; §7.2).
//
// Boot the binary on an ephemeral port; navigate to /. With an EMPTY DB the
// overview must show the empty-state CTA ("No agents yet. Boot your first one.").
// After a session exists in the DB, a reload must render at least one tile.
// This proves the whole boot path holds together: binary → /api/sessions →
// TanStack Query → tile/empty-state render.

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.describe('overview loads', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('empty DB → empty-state CTA; with a session → at least one tile', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))

    // 1. Empty DB → the empty-state placeholder, not a crash.
    await page.goto(backend.baseUrl)
    await expect(page.getByText('No agents yet. Boot your first one.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Boot first agent' })).toBeVisible()

    // 2. Seed one session directly via the API (no need to start tmux — the tile
    //    renders for any row in the list).
    const res = await api(backend).createSession({
      name: 'smoke-tile',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(res.status, 'create session').toBe(201)

    // 3. Reload → at least one tile. The tile is a role=button with an
    //    aria-label "<title> — <status>"; the session name is the title.
    await page.reload()
    const tile = page.getByRole('button', { name: /smoke-tile/ })
    await expect(tile).toBeVisible()
    expect(await page.getByRole('button', { name: /smoke-tile/ }).count()).toBeGreaterThanOrEqual(
      1,
    )

    // The empty state must be gone now that a session exists.
    await expect(
      page.getByText('No agents yet. Boot your first one.'),
    ).toHaveCount(0)
  })
})

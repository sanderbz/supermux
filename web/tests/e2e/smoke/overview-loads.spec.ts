// Smoke e2e — the overview loads against a real booted backend.
//
// Boot the binary on an ephemeral port; navigate to /. With an EMPTY DB the
// overview must show the empty-state CTA ("No agents yet. Boot your first one.").
// After a session exists in the DB, a reload must render at least one tile.
// This proves the whole boot path holds together: binary → /api/sessions →
// TanStack Query → tile/empty-state render.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

    // NO GUARANTEED-404s. `IssueList` used to fall back to an empty board id
    // when given neither a session nor a board, so every page load and every
    // focus navigation fired `GET /api/boards//cards` — a doubled slash, an
    // empty id, a 404 by construction, and a red console error on first paint.
    // Recorded over the WHOLE run below rather than asserted once, so a future
    // surface that reintroduces a dead request is caught wherever it lands.
    const notFound: string[] = []
    page.on('response', (r) => {
      const u = new URL(r.url())
      if (u.pathname.startsWith('/api/') && r.status() === 404) notFound.push(u.pathname)
    })

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

    expect(notFound, 'no API request may 404 on an ordinary load').toEqual([])
  })

  // The guaranteed-404. `team-card.tsx` mounts `IssueSurface` with
  // `boardId={teamBoardId ?? ''}` — unconditionally, even while the overlay is
  // shut — and `useBoard('')` used to fetch `GET /api/boards//cards`: a doubled
  // slash, an empty id, a 404 by construction and a red console error on first
  // paint, once per team card on every load. It needs a team on screen to
  // reproduce, which is what the seed below is for. (It doubles as the proof
  // that the harness really does isolate `$CLAUDE_CONFIG_DIR`: the team the
  // overview shows is THIS test's, and `/api/teams` was empty before it.)
  test('a team card on the overview issues no dead board request', async ({ page }) => {
    await page.addInitScript(injectGlobals(backend.token))

    const before = await fetch(`${backend.backendUrl}/api/teams`, {
      headers: { Authorization: `Bearer ${backend.token}` },
    }).then((r) => r.json())
    expect(before.data, 'a fresh backend must see no teams').toEqual([])

    const teamDir = join(backend.dataDir, 'claude', 'teams', 'smoke-squad')
    mkdirSync(teamDir, { recursive: true })
    writeFileSync(
      join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'smoke-squad',
        leadAgentId: 'team-lead@smoke-squad',
        members: [
          { agentId: 'team-lead@smoke-squad', name: 'team-lead', agentType: 'team-lead' },
          // A teammate needs a pane + backend + colour or `scan.rs`'s
          // structural blank-row rule reads it as the lead's own roster entry,
          // the roster empties, and `drop_rosterless` hides the whole team.
          {
            agentId: 'worker@smoke-squad',
            name: 'worker',
            model: 'claude-opus-5',
            color: 'blue',
            tmuxPaneId: '%9',
            backendType: 'claude',
            isActive: true,
          },
        ],
      }),
    )

    const dead: string[] = []
    const notFound: string[] = []
    page.on('request', (r) => {
      const p = new URL(r.url()).pathname
      if (p.startsWith('/api/') && p.includes('//')) dead.push(p)
    })
    page.on('response', (r) => {
      const p = new URL(r.url()).pathname
      if (p.startsWith('/api/') && r.status() === 404) notFound.push(p)
    })

    await page.goto(backend.baseUrl)
    // The team card is on screen — otherwise this test proves nothing.
    await expect(page.getByText('worker').first()).toBeVisible()

    expect(dead, 'no request may carry an empty path segment').toEqual([])
    expect(notFound, 'a team card must not 404 the board API').toEqual([])
  })
})

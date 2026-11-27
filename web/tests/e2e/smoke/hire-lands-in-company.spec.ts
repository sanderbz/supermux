// Hiring a bot lands you IN the company you hired into, with the new bot open.
// ─────────────────────────────────────────────────────────────────────────────
// The owner's report: after "New bot" → hire, you were no longer inside a
// company and stared at every bot from every company; only Home got you out.
// The hire's `onCreated` navigated to `/focus/<name>` — the terminal route, which
// carries no company scope and whose side rail lists the whole fleet. It now
// follows the bot's address, `/agent/<name>`, which keeps the scope and selects
// the bot (grok-roster.tsx, the `NewSessionSheet` mount).
//
// Both desktop entry points into the sheet are covered by the same mount — the
// rail's "New bot" pill and the palette verb install the same `setSheetOpen` —
// so the scopes are what vary here: a company, and HQ (where `activeCompany` is
// null and the rail shows only bots with no company). Plus the cancel path,
// which must leave the scope and the route alone.
//
// The `/start` call is answered from the page: the hire boots the agent through
// it, and the run's isolated CLAUDE_CONFIG_DIR has no login, so a real launch
// would only park a sign-in-gated `claude` in tmux for the length of the test.
// The sheet already treats a failed start as non-fatal; what is under test is
// where you land, which does not depend on the agent running.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { injectGlobals, startBackend, type Backend } from './harness'

test.describe('hire lands in the company', () => {
  let backend: Backend
  let workDir: string
  let acme: number

  const api = async (path: string, body: unknown) => {
    const res = await fetch(`${backend.backendUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (!json.ok) throw new Error(`${path}: ${JSON.stringify(json)}`)
    return json.data
  }

  test.beforeEach(async ({ page }) => {
    workDir = mkdtempSync(join(tmpdir(), 'supermux-e2e-hire-'))
    // An HQ hire makes its own folder under the projects root (a company hire
    // gets one from the server). Point both halves at this run's temp dir: the
    // server confines the folder create to its project dirs, and the page reads
    // the root from the global the real server would inject.
    backend = await startBackend({ env: { SUPERMUX_PROJECT_DIRS: workDir } })
    acme = (await api('/api/companies', { slug: 'acme', display_name: 'Acme Studio' })).id
    const globex = (await api('/api/companies', { slug: 'globex', display_name: 'Globex Labs' })).id
    // One bot per scope, so "only this company's bots" is a real assertion.
    for (const [name, company] of [
      ['copy-editor', acme],
      ['market-analyst', globex],
      ['inbox-assistant', null],
    ] as const) {
      const dir = join(workDir, name)
      mkdirSync(dir)
      await api('/api/sessions', { name, dir, provider: 'claude', company_id: company ?? undefined })
    }

    await page.setViewportSize({ width: 1280, height: 860 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((dir: string) => {
      ;(window as unknown as { _SUPERMUX_PROJECT_DIR: string })._SUPERMUX_PROJECT_DIR = dir
    }, workDir)
    await page.addInitScript(() =>
      window.localStorage.setItem(
        'supermux-ui',
        JSON.stringify({ state: { botMode: true }, version: 1 }),
      ),
    )
    await page.route('**/api/sessions/*/start', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: null }),
      }),
    )
  })

  test.afterEach(async () => {
    await backend?.dispose()
    rmSync(workDir, { recursive: true, force: true })
  })

  const railNames = (page: Page) => page.locator('.gr-rail .gr-rowA .nm')

  /** Select a scope through the switcher — a persisted id fails open to HQ
   *  until the company list has loaded (invite-wizard.spec.ts). */
  async function enterScope(page: Page, name: RegExp) {
    await page.goto(`${backend.baseUrl}/`)
    const switcher = page.getByRole('combobox', { name: /Company scope/i })
    await switcher.click()
    await page.getByRole('menuitemradio', { name }).click()
    await expect(switcher).toHaveAccessibleName(name)
    return switcher
  }

  async function hire(page: Page, name: string) {
    await page.getByRole('button', { name: 'New bot' }).click()
    await page.locator('#ns-goal').fill('Write the launch post for the spring release.')
    await page.getByRole('textbox', { name: 'Name' }).fill(name)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Skip for now' }).click()
  }

  test('a hire inside a company stays in it, with the new bot selected', async ({ page }) => {
    const switcher = await enterScope(page, /Acme Studio/)
    await hire(page, 'Launch Writer')

    // The new bot is the open one. Asserted FIRST: it only becomes true once
    // the hire has landed, so the URL check below cannot pass on the page as it
    // was before the navigation.
    const active = page.locator('.gr-rail .gr-rowA[data-active]')
    await expect(active.locator('.nm')).toHaveText('Launch Writer')
    await expect(active).toHaveCount(1)
    // Home, not the terminal route — the doorway replaced itself with `/`.
    await expect(page).toHaveURL(`${backend.baseUrl}/`)
    await expect(switcher).toHaveAccessibleName(/Acme Studio/)
    // Only Acme's bots: the new one and its colleague. No Globex, no HQ.
    await expect(railNames(page)).toHaveText(['Launch Writer', 'copy-editor'], {
      useInnerText: true,
    })

    // It really was hired into Acme (the server agrees with the screen).
    const list = await (
      await fetch(`${backend.backendUrl}/api/sessions`, {
        headers: { Authorization: `Bearer ${backend.token}` },
      })
    ).json()
    const row = list.data.find((s: { name: string }) => s.name === 'Launch-Writer')
    expect(row?.company_id).toBe(acme)
  })

  test('a hire from HQ stays in HQ, with the new bot selected', async ({ page }) => {
    const switcher = await enterScope(page, /HQ/)
    await hire(page, 'Inbox Triage')

    const active = page.locator('.gr-rail .gr-rowA[data-active]')
    await expect(active.locator('.nm')).toHaveText('Inbox Triage')
    await expect(active).toHaveCount(1)
    await expect(page).toHaveURL(`${backend.baseUrl}/`)
    await expect(switcher).toHaveAccessibleName(/HQ/)
    await expect(railNames(page)).toHaveText(['Inbox Triage', 'inbox-assistant'], {
      useInnerText: true,
    })
  })

  test('cancelling the hire leaves the scope and the route alone', async ({ page }) => {
    const switcher = await enterScope(page, /Acme Studio/)
    await page.getByRole('button', { name: 'New bot' }).click()
    await page.locator('#ns-goal').fill('Something I changed my mind about.')
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.locator('#ns-goal')).toHaveCount(0)
    await expect(page).toHaveURL(`${backend.baseUrl}/`)
    await expect(switcher).toHaveAccessibleName(/Acme Studio/)
    await expect(railNames(page)).toHaveText(['copy-editor'], { useInnerText: true })
  })
})

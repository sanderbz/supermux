// TEAMS-in-Bot-mode smoke e2e (Phase 6c) — the folded roster + the team pane,
// on the `?mock` fixture (Phase 0 D3: `MOCK_TEAMS` + their lead sessions), so
// this covers the surface offline without a live Claude team on the runner.
//
// It drives the wave's spine end-to-end in the browser:
//   1. Bot mode ON + `/?mock` → the grok roster renders, and the `feature-x`
//      crew is a ROW that sorts into a section (OD-2 fold), not a leading Teams
//      divider. It has a needs_you member, so it lands in `Needs you`.
//   2. the header reads the honest fleet size + the `· N crews` census.
//   3. clicking the crew selects it in place (the URL never leaves `/`), and the
//      right pane opens on the lead's thread; the Team-details toggle flips it to
//      TeamPanel, whose crew list opens a member (MemberPane), and back returns.
//
// Desktop viewport: the phone routes a team tap to `/team/*` instead (Phase 6a),
// which is its own concern; here we exercise the in-place pane.

import { expect, test } from '@playwright/test'
import { injectGlobals, startBackend, type Backend } from './harness'

const FLAG_ON = JSON.stringify({ state: { botMode: true }, version: 1 })

test.describe('grok team roster (folded sections + team pane)', () => {
  let backend: Backend
  test.beforeEach(async ({ page }) => {
    backend = await startBackend()
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, FLAG_ON)
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('folded roster → crew row in a section → select in place → TeamPanel → member → back', async ({
    page,
  }) => {
    await page.goto(`${backend.baseUrl}/?mock`)

    // The grok roster is up.
    await expect(page.locator('.grok-roster')).toBeVisible()

    // OD-2 FOLD: there is no leading "Teams" divider group any more. The team is
    // a row that sorts into a section — `feature-x` has a needs_you member, so it
    // is in `Needs you`. (Its aria-label pluralizes: "feature-x — 5 bots".)
    const crew = page.getByRole('button', { name: /feature-x — 5 bots/ })
    await expect(crew).toBeVisible()

    // The header carries the `· N crews` census and a needs rollup that counts
    // the crew's needs-you member (Σ over the rendered rows — the folded-roster
    // invariant).
    await expect(page.locator('.gr-count')).toContainText('crew')
    await expect(page.locator('.gr-count')).toContainText('need you')

    // Selecting a team never changes the URL (§2b) — it swaps the pane in place.
    await crew.click()
    await expect(page).toHaveURL(new RegExp(`${backend.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\?mock)?$`))

    // The Team-details toggle flips the pane to TeamPanel (the lead's thread is
    // the other face). Then the crew list is the click target for a member.
    const toggle = page.locator('[data-vr="pane-team-toggle"]')
    await expect(toggle).toBeVisible()
    await toggle.click()

    await expect(page.locator('[data-vr="team-tab"]').first()).toBeVisible()
    const firstMember = page.locator('[data-vr="team-member"]').first()
    await expect(firstMember).toBeVisible()
    await firstMember.click()

    // …opens that teammate's read-only pane, in the same right column.
    await expect(page.locator('[data-vr="member-pane"]')).toBeVisible()
    await expect(page.locator('[data-vr="member-readonly"]')).toBeVisible()

    // Back returns to the crew (its Overview list), not the lead's thread.
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-vr="team-member"]').first()).toBeVisible()
  })
})

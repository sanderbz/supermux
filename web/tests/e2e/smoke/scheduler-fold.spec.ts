// B1 T8.6 — "nothing was dropped", proven against a real backend.
//
// The /scheduler route is gone and its 5-column table is now a Settings
// section. The risk that justifies this spec is not "does it render" — it is
// that a capability which no longer FITS gets quietly simplified away. So this
// drives the whole inventory through the UI, in one pass:
//
//   create → see it in the list → toggle off → toggle back on → open it →
//   Run now → see the run in the fire log → delete → it is gone
//
// Plus the two structural claims the fold rests on: `/scheduler` redirects to
// `/settings#schedules`, and the section carries that anchor so the redirect
// lands ON the section rather than at the top of a very long page.

import { expect, test } from '@playwright/test'
import { injectGlobals, startBackend, type Backend } from './harness'

test.describe('scheduler folded into Settings', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('the whole capability inventory still works from Settings', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
      localStorage.setItem('supermux-first-launch', String(Date.now()))
    })
    await page.setViewportSize({ width: 1440, height: 900 })

    // ── The old URL still works ─────────────────────────────────────────────
    await page.goto(`${backend.baseUrl}/scheduler`)
    await expect(page, '/scheduler redirects to the Settings anchor').toHaveURL(
      /\/settings#schedules$/,
      { timeout: 20_000 },
    )

    const section = page.locator('#schedules')
    await expect(section, 'the anchor the redirect targets exists').toBeVisible({
      timeout: 20_000,
    })

    // ── CREATE — the section-header `+` opens the SAME detail sheet ─────────
    await section.getByRole('button', { name: 'New schedule' }).click()
    const title = page.getByPlaceholder('Weekly review')
    await expect(title).toBeVisible({ timeout: 10_000 })

    // THE PRIMARY ACTION IS ON SCREEN THE MOMENT THE SHEET OPENS. It used to
    // live at the end of the sheet's own scroll region — bounding box y=892.5,
    // height 44 at every viewport height tried, so ~7px of the button showed at
    // 900px and none at all below — while the sheet opens at scrollTop 0 with
    // no fade to say there was more.
    //
    // Measured at 700px, on a laptop-sized window, BEFORE anything is typed:
    // that is the state a user lands in, and it is the height at which the old
    // layout put the button ~190px past the bottom of the screen.
    await page.setViewportSize({ width: 1440, height: 700 })
    const saveBtn = page.getByRole('button', { name: /Save schedule/ })
    const box = await saveBtn.boundingBox()
    expect(box, 'Save schedule is laid out').not.toBeNull()
    expect(
      Math.round(box!.y + box!.height),
      'Save schedule is fully inside a 700px-tall window before any scrolling',
    ).toBeLessThanOrEqual(700)
    await page.setViewportSize({ width: 1440, height: 900 })

    await title.fill('e2e-fold')

    // A shell job is the one kind that needs neither a session nor a tmux pane,
    // so the spec exercises the fold rather than the session machinery.
    await page.getByRole('radio', { name: 'Shell job', exact: true }).click()
    await page.getByPlaceholder('touch /tmp/done').fill('echo folded')
    // "Daily" — a cadence far enough away that the runner never races the
    // assertions below. Firing is exercised deliberately, via "Run now".
    await page.getByRole('button', { name: 'Daily', exact: true }).click()

    await page.getByRole('button', { name: /Save schedule/ }).click()

    // ── LIST — the new schedule shows up as a settings Row ──────────────────
    const row = section.getByText('e2e-fold', { exact: true })
    await expect(row, 'the created schedule is listed in Settings').toBeVisible({
      timeout: 15_000,
    })

    // Its hint line carries the columns the old table had.
    const rowHint = section.locator('div', { hasText: 'echo folded' }).last()
    await expect(rowHint).toBeVisible()

    // ── TOGGLE — pause and resume, from the Row's control slot ─────────────
    const toggle = section.getByRole('switch').first()
    await expect(toggle).toBeVisible()
    const wasOn = await toggle.getAttribute('aria-checked')
    await toggle.click()
    await expect(async () => {
      expect(await toggle.getAttribute('aria-checked')).not.toBe(wasOn)
    }).toPass({ timeout: 8_000 })
    // A paused schedule reports "paused" instead of a stale next fire.
    await expect(section.getByText('paused').first()).toBeVisible({
      timeout: 8_000,
    })
    await toggle.click()
    await expect(async () => {
      expect(await toggle.getAttribute('aria-checked')).toBe(wasOn)
    }).toPass({ timeout: 8_000 })

    // ── OPEN — the row opens the same detail sheet, in edit mode ────────────
    await row.click()
    await expect(page.getByRole('button', { name: 'Run now' })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText('Recent runs')).toBeVisible()

    // ── FIRE + FIRE LOG — run it now, see the run appear in the history ─────
    await expect(
      page.getByText('No runs yet. It fires on schedule, or hit “Run now”.'),
    ).toBeVisible({ timeout: 8_000 })
    await page.getByRole('button', { name: 'Run now' }).click()
    await expect(
      page.getByText('No runs yet. It fires on schedule, or hit “Run now”.'),
      'the fire log picked up the run',
    ).toHaveCount(0, { timeout: 25_000 })

    // ── DELETE — behind the inline confirm, then it is gone from the list ───
    await page.getByRole('button', { name: 'Delete' }).click()
    const confirm = page.getByRole('dialog').last()
    await expect(confirm).toBeVisible({ timeout: 8_000 })
    await confirm.getByRole('button', { name: /Delete/ }).last().click()

    await expect(
      section.getByText('e2e-fold', { exact: true }),
      'the schedule is gone from the Settings list',
    ).toHaveCount(0, { timeout: 15_000 })
  })
})

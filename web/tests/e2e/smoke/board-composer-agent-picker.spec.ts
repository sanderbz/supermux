// SD-3 e2e — the board composer's inline "which agent" picker.
//
// REGRESSION GUARD for SD-3. The agent selector must (1) be visible inline next
// to "More" WITHOUT expanding More, (2) default to claude, and (3) remember the
// last-picked value across a reload (localStorage), so the next card defaults to
// whatever you started last.
//
// Drives the real binary through the smoke harness; the live Vite frontend is
// what's under test (the new composer source), so this exercises the actual
// component, not a mock.

import { expect, test } from '@playwright/test'
import { injectGlobals, startBackend, type Backend } from './harness'

test.describe('board composer: inline agent picker (SD-3)', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('agent picker shows inline (no More needed) and remembers the last pick', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(`${backend.baseUrl}/board`)

    // The picker is visible with More still COLLAPSED (its panel — "Acceptance
    // criteria" — is unmounted), proving you don't have to open More for it.
    const picker = page.getByRole('combobox', { name: 'Which agent to start' })
    await expect(picker).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Acceptance criteria')).toHaveCount(0)
    await expect(picker).toHaveValue('claude')
    await page.screenshot({ path: 'test-results/sd-3-picker-inline.png' })

    // Pick a different agent; it persists across a full reload (localStorage).
    await picker.selectOption('shell')
    await expect(picker).toHaveValue('shell')

    await page.reload()
    const pickerAfter = page.getByRole('combobox', { name: 'Which agent to start' })
    await expect(pickerAfter).toBeVisible({ timeout: 15_000 })
    await expect(pickerAfter).toHaveValue('shell')
    await page.screenshot({ path: 'test-results/sd-3-picker-remembered.png' })

    // Belt-and-suspenders: the value the composer remembers is in localStorage.
    const stored = await page.evaluate(() =>
      localStorage.getItem('supermux:board:last-provider'),
    )
    expect(stored).toBe('shell')
  })
})

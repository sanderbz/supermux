// Verification — board U3: drag-to-doing SENDS to the agent (not a bare status
// flip), the ⌘K board verbs claim+deliver, and the mobile board→issue path opens
// the Vaul ResponsiveSheet.
//
// Drives the real binary over HTTP through the smoke harness (same as
// board-claim-picker.spec.ts).

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.describe('board U3 — drag-to-send + ⌘K verbs + mobile sheet', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  async function seed(title: string) {
    // A live session (the claim FK + the steer enqueue both need it to exist).
    const s = await api(backend).createSession({
      name: 'worker-1',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(s.status, 'create session').toBe(201)
    // A claimable agent issue ALREADY linked to that session, so a drag into
    // `doing` takes the auto-send path with no picker.
    const issue = await api(backend).createIssue({
      title,
      owner_type: 'agent',
      status: 'todo',
      session: 'worker-1',
    })
    expect(issue.status, 'create issue').toBe(201)
    return (await issue.json()).data as { id: string }
  }

  /** Probe the backend for one issue by title. */
  async function fetchIssue(title: string) {
    const res = await fetch(`${backend.backendUrl}/api/board?done_limit=0`, {
      headers: { Authorization: `Bearer ${backend.token}` },
    })
    const board = await res.json()
    return (board.data as Array<Record<string, unknown>>).find(
      (i) => i.title === title,
    )
  }

  test('drag a live-session card into `doing` → claim + "Sent to" toast + Undo (not a bare move)', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    const title = 'Drag Me To Doing'
    await seed(title)

    await page.goto(`${backend.baseUrl}/board`)
    const card = page.locator('[data-issue-id]', { hasText: title })
    await expect(card).toBeVisible()

    const doingCol = page.locator('[data-column-id="doing"]')
    await expect(doingCol).toBeVisible()

    // Pointer-drag the card from its column into `doing`. The board's drag
    // controller arms past a 6px threshold; we move in steps so it crosses it.
    const from = await card.boundingBox()
    const to = await doingCol.boundingBox()
    if (!from || !to) throw new Error('missing bounding boxes')
    await page.mouse.move(from.x + from.width / 2, from.y + 16)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, from.y + 28, { steps: 3 })
    await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 12 })
    await page.mouse.up()

    // HEADLINE: the auto-send path fired — a "Sent to worker-1" toast WITH an
    // Undo action (a bare status move would show no toast).
    const toast = page.getByText(/Sent to worker-1/i)
    await expect(toast).toBeVisible()
    await expect(page.getByRole('button', { name: /^Undo$/ })).toBeVisible()

    // The atomic claim landed server-side: status doing, session bound.
    await expect
      .poll(async () => (await fetchIssue(title))?.status)
      .toBe('doing')
    expect((await fetchIssue(title))?.session).toBe('worker-1')

    // Undo retracts the still-undelivered steer (no throw; toast dismisses).
    await page.getByRole('button', { name: /^Undo$/ }).click()
    await expect(page.getByRole('button', { name: /^Undo$/ })).toHaveCount(0)
  })

  test('⌘K shows board verbs; "Send issue to session…" claims + delivers', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    const title = 'Send Via Palette'
    await seed(title)

    await page.goto(`${backend.baseUrl}/board`)
    await expect(page.locator('[data-issue-id]', { hasText: title })).toBeVisible()

    // Open ⌘K. The board verbs are visible (board-scoped to this route).
    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('listbox', { name: 'Palette results' })
    await expect(
      page.getByRole('option', { name: /Send issue to session/i }),
    ).toBeVisible()
    await expect(
      page.getByRole('option', { name: /Comment on issue/i }),
    ).toBeVisible()
    await expect(
      page.getByRole('option', { name: /Mark issue done/i }),
    ).toBeVisible()

    // Run "Send issue to session…" → pick the issue → pick the session.
    await page.getByRole('option', { name: /Send issue to session/i }).click()
    await page.getByRole('option', { name: new RegExp(title, 'i') }).click()
    await page.getByRole('option', { name: /worker-1/i }).click()

    // The claim+deliver fired (toast) and the backend recorded the move.
    await expect(page.getByText(/Sent to worker-1/i)).toBeVisible()
    await expect
      .poll(async () => (await fetchIssue(title))?.status)
      .toBe('doing')
    expect((await fetchIssue(title))?.session).toBe('worker-1')
    void palette
  })

  test('⌘K "Mark issue done" moves the issue to done', async ({ page }) => {
    await page.addInitScript(injectGlobals(backend.token))
    const title = 'Finish Via Palette'
    await seed(title)

    await page.goto(`${backend.baseUrl}/board`)
    await expect(page.locator('[data-issue-id]', { hasText: title })).toBeVisible()

    await page.keyboard.press('Meta+k')
    await page.getByRole('option', { name: /Mark issue done/i }).click()
    await page.getByRole('option', { name: new RegExp(title, 'i') }).click()

    await expect
      .poll(async () => (await fetchIssue(title))?.status)
      .toBe('done')
  })

  // Mobile (430×932, coarse pointer): board → issue opens the Vaul bottom-sheet
  // (ResponsiveSheet forks on `pointer: coarse`), not the desktop side panel.
  test.describe('mobile board→issue opens the Vaul sheet', () => {
    test.use({ viewport: { width: 430, height: 932 }, hasTouch: true, isMobile: true })

    test('tapping a card opens the ResponsiveSheet drawer', async ({ page }) => {
      await page.addInitScript(injectGlobals(backend.token))
      const title = 'Open On Mobile'
      // A plain human issue is fine here — we only assert the sheet route/nav.
      const issue = await api(backend).createIssue({
        title,
        owner_type: 'human',
        status: 'todo',
      })
      expect(issue.status, 'create issue').toBe(201)

      await page.goto(`${backend.baseUrl}/board`)
      const card = page.locator('[data-issue-id]', { hasText: title })
      await expect(card).toBeVisible()
      await card.tap()

      // The Vaul bottom-sheet (not the desktop right-side Sheet) is on screen.
      await expect(page.getByTestId('responsive-sheet')).toBeVisible()
      // It is the issue detail sheet (title "Issue" + the issue id).
      await expect(page.getByText('Issue', { exact: true })).toBeVisible()
    })
  })
})

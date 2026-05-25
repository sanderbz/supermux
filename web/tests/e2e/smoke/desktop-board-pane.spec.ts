// Desktop board mission-control pane — visual + behavioral check.
//
// On a wide desktop (fine pointer) the 3 lanes go fluid+centered and a right
// master–detail pane appears. Clicking a card (incl. a live Doing card) opens it
// in the pane — description, acceptance, the linked agent's live tail, comments,
// reply — without leaving the board. (Mobile parity is covered separately.)

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.use({ viewport: { width: 1600, height: 1000 } })

test.describe('desktop board detail pane', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('lanes + pane: clicking a Doing card opens the live detail pane', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.addInitScript(injectGlobals(backend.token))
    const A = api(backend)

    // A live Doing card: a started shell session + an issue claimed onto it.
    expect(
      (await A.createSession({ name: 'demo', provider: 'shell', dir: backend.dataDir }))
        .status,
      'create session',
    ).toBe(201)
    expect((await A.startSession('demo')).ok, 'start session').toBeTruthy()

    const createRes = await A.createIssue({
      title: 'Refactor the PTY layer',
      description: 'Anchor the live-stream FIFO in the data dir and seed replay on attach.',
      acceptance: ['FIFO anchored in data dir', 'Replay seeds on attach', 'Tests green'],
    })
    expect(createRes.status, 'create doing issue').toBe(201)
    const body = await createRes.json()
    const doingId: string = body?.data?.id ?? body?.id ?? body?.issue?.id
    expect(doingId, 'created issue id').toBeTruthy()

    // A couple of To do cards for visual fullness.
    await A.createIssue({ title: 'Wire the SSE delta merge', description: 'Merge SSE deltas into the sessions cache.' })
    await A.createIssue({ title: 'Board midpoint math', description: 'Stable pos on drag-between.' })

    // Claim the PTY card onto the live session → it lands in Doing.
    expect((await A.claim(doingId, 'demo')).ok, 'claim → doing').toBeTruthy()

    await page.goto(`${backend.baseUrl}/board`)

    // Desktop pane present in its empty state (proves the layout split + lg pane).
    await expect(
      page.getByText(/Select a card to see its details/i),
    ).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: 'test-results/desktop-board-empty-pane.png' })

    // Click the Doing card → it opens in the pane (NOT a full-screen morph).
    await page
      .getByRole('button', { name: /Refactor the PTY layer/ })
      .first()
      .click()

    // The pane filled: close affordance + the reused Acceptance section appear,
    // and we're still on /board (not navigated to /focus).
    await expect(page.getByRole('button', { name: 'Close panel' })).toBeVisible({
      timeout: 5_000,
    })
    await expect(page.getByText('Acceptance', { exact: false }).first()).toBeVisible()
    expect(page.url()).toContain('/board')
    await page.screenshot({ path: 'test-results/desktop-board-pane.png' })
  })
})

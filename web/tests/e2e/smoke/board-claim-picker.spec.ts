// Fix verification — board claim-for-session picker (fix/board-claim).
//
// Regression for "Pick a session to claim this for." with an empty/disabled
// picker. The claim affordance must (1) list the LIVE sessions inline, (2) keep
// the Claim button disabled until one is picked (so the old dead-end guard is
// unreachable), (3) reflect the bound session on the card after a successful
// claim, and (4) show a friendly empty state (with an overview link) when there
// are zero live sessions — never a dead end.
//
// Drives the real binary over HTTP through the smoke harness, same as the other
// UI smoke specs.

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.describe('board claim picker', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('zero sessions → friendly empty state with an overview link (no dead end)', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))

    // A claimable agent-owned issue, but NO sessions exist.
    const createRes = await api(backend).createIssue({
      title: 'Lonely Claimable Task',
      owner_type: 'agent',
      status: 'todo',
    })
    expect(createRes.status, 'create issue').toBe(201)

    await page.goto(`${backend.baseUrl}/board`)

    // Open the card's detail sheet.
    await page.getByRole('button', { name: /Lonely Claimable Task/ }).click()

    // The claim block shows the empty state instead of a disabled control, and
    // links to the overview to start a session.
    await expect(page.getByText(/No active sessions/i)).toBeVisible()
    const overviewLink = page.getByRole('link', {
      name: /start one from the overview/i,
    })
    await expect(overviewLink).toBeVisible()
    // It points at the overview root (basename-relative "/").
    await expect(overviewLink).toHaveAttribute('href', /\/$/)

    // There is NO dead-end "Claim for session" button to click here.
    await expect(
      page.getByRole('button', { name: /^Pick a session above$/ }),
    ).toHaveCount(0)
  })

  test('with live sessions → picker lists them, claim binds the card', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))

    // Two live sessions (the claim FK requires the session to exist).
    for (const name of ['alpha', 'bravo']) {
      const res = await api(backend).createSession({
        name,
        provider: 'shell',
        dir: backend.dataDir,
      })
      expect(res.status, `create session ${name}`).toBe(201)
    }

    const createRes = await api(backend).createIssue({
      title: 'Pick Me To Claim',
      owner_type: 'agent',
      status: 'todo',
    })
    expect(createRes.status, 'create issue').toBe(201)

    await page.goto(`${backend.baseUrl}/board`)
    await page.getByRole('button', { name: /Pick Me To Claim/ }).click()

    // The picker lists the live sessions as options (scope to the claim block's
    // listbox so we don't also match the legacy "Session" <select>'s <option>s).
    const picker = page.getByRole('listbox', { name: 'Sessions' })
    const optAlpha = picker.getByRole('option', { name: /alpha/ })
    const optBravo = picker.getByRole('option', { name: /bravo/ })
    await expect(optAlpha).toBeVisible()
    await expect(optBravo).toBeVisible()

    // Before picking, the primary action is disabled (the old guard is
    // unreachable). U2 promoted it to "Send to agent" (auto-dispatch).
    const sendBtn = page.getByRole('button', { name: /Pick a session above/i })
    await expect(sendBtn).toBeDisabled()

    // Pick alpha → the button enables and reads "Send to alpha".
    await optAlpha.click()
    const sendToAlpha = page.getByRole('button', { name: /Send to alpha/i })
    await expect(sendToAlpha).toBeEnabled()
    await sendToAlpha.click()

    // No dead-end error; the sheet closes; the card now shows the bound session.
    await expect(page.getByText('Pick a session to claim this for.')).toHaveCount(0)
    const card = page.getByRole('button', { name: /Pick Me To Claim/ })
    await expect(card).toBeVisible()
    await expect(card.getByText('alpha')).toBeVisible()

    // Belt-and-suspenders: the backend recorded the claim (status doing, session alpha).
    const list = await fetch(`${backend.backendUrl}/api/board?done_limit=0`, {
      headers: { Authorization: `Bearer ${backend.token}` },
    })
    const board = await list.json()
    const issue = (board.data as Array<Record<string, unknown>>).find(
      (i) => i.title === 'Pick Me To Claim',
    )
    expect(issue?.status).toBe('doing')
    expect(issue?.session).toBe('alpha')
  })
})

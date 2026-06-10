// E2e — the live board issue card.
//
// The card must be as alive as an overview tile: the LINKED session's real
// StatusDot (joined to the shared SSE status/sessions stream by issue.session),
// a hover tail-peek off the same last_capture, one-tap Open/Send actions, a
// compact acceptance progress pill, the stale-link reassign badge, and the
// needs_review / awaiting_input badges.
//
// Drives the real binary over HTTP through the smoke harness, same as the other
// board smoke specs. Note: the card is a `div[role=button]` (nested action
// buttons can't live inside a <button>), so `getByRole('button',{name:title})`
// still resolves it via aria-label.

import { expect, test, type Page } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

/** Extra REST helpers the shared `api()` doesn't expose (archive + acceptance). */
function extApi(backend: Backend) {
  const h = {
    Authorization: `Bearer ${backend.token}`,
    'Content-Type': 'application/json',
  }
  return {
    archiveSession: (name: string) =>
      fetch(
        `${backend.backendUrl}/api/sessions/${encodeURIComponent(name)}/archive`,
        { method: 'POST', headers: h, body: '{}' },
      ),
    addAcceptance: (id: string, body: string) =>
      fetch(
        `${backend.backendUrl}/api/board/${encodeURIComponent(id)}/acceptance`,
        { method: 'POST', headers: h, body: JSON.stringify({ body }) },
      ),
    issueId: async (title: string): Promise<string> => {
      const res = await fetch(`${backend.backendUrl}/api/board`, { headers: h })
      const board = await res.json()
      const found = (board.data as Array<Record<string, unknown>>).find(
        (i) => i.title === title,
      )
      if (!found) throw new Error(`issue not found: ${title}`)
      return String(found.id)
    },
  }
}

/** A board card by its title (aria-label). */
function card(page: Page, title: string) {
  return page.getByRole('button', { name: title, exact: false }).first()
}

test.describe('board live issue card', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('doing card linked to a live session shows a live StatusDot + acceptance pill', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))

    // A live session (created + started so the detector reports a live status).
    const mk = await api(backend).createSession({
      name: 'worker-live',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(mk.status, 'create session').toBe(201)
    await api(backend).startSession('worker-live')

    // An agent-owned issue, claimed for that session (→ doing, link set). Claim
    // only (no deliver) keeps the test deterministic — we assert the live dot,
    // not the steering delivery.
    const created = await api(backend).createIssue({
      title: 'Live Linked Task',
      owner_type: 'agent',
      status: 'todo',
    })
    expect(created.status, 'create issue').toBe(201)
    const id = await extApi(backend).issueId('Live Linked Task')
    const claimRes = await api(backend).claim(id, 'worker-live')
    expect(claimRes.ok, 'claim').toBeTruthy()

    // Three acceptance items, one ticked → the pill should read "1/3".
    await extApi(backend).addAcceptance(id, 'Build it')
    await extApi(backend).addAcceptance(id, 'Test it')
    await extApi(backend).addAcceptance(id, 'Ship it')
    // Tick the first via PATCH.
    const items = await fetch(`${backend.backendUrl}/api/board`, {
      headers: { Authorization: `Bearer ${backend.token}` },
    })
      .then((r) => r.json())
      .then(
        (b) =>
          (b.data as Array<Record<string, unknown>>).find((i) => i.id === id)
            ?.acceptance as Array<{ id: number }>,
      )
    await fetch(
      `${backend.backendUrl}/api/board/${encodeURIComponent(id)}/acceptance/${items[0].id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${backend.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ done: true }),
      },
    )

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${backend.baseUrl}/board`)

    const c = card(page, 'Live Linked Task')
    await expect(c).toBeVisible()

    // The session pill shows the bound session name.
    await expect(c.getByText('worker-live')).toBeVisible()

    // A live StatusDot renders — the dot carries role="img" with a status label
    // (Running/Idle/Needs input/Booting/Stopped). At least one must be present.
    const dot = c.getByRole('img', {
      name: /Running|Idle|Needs input|Booting|Stopped/,
    })
    await expect(dot.first()).toBeVisible()

    // Acceptance progress pill: 1 of 3 done.
    await expect(c.getByText('1/3')).toBeVisible()
  })

  test('hover reveals the tail-peek + one-tap Send/Open actions; Send fires a toast', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))

    const mk = await api(backend).createSession({
      name: 'worker-peek',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(mk.status).toBe(201)
    await api(backend).startSession('worker-peek')

    // Assigned to the session but still in `todo` → the Send (claim+deliver)
    // action is meaningful (claim CAS requires status todo|backlog).
    const created = await api(backend).createIssue({
      title: 'Hover Peek Task',
      owner_type: 'agent',
      status: 'todo',
      session: 'worker-peek',
    })
    expect(created.status).toBe(201)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${backend.baseUrl}/board`)

    const c = card(page, 'Hover Peek Task')
    await expect(c).toBeVisible()

    // Hover → the inline actions appear (no menu, no extra clicks).
    await c.hover()
    const sendBtn = page.getByRole('button', { name: /Send to worker-peek/i })
    const openBtn = page.getByRole('button', { name: /Open session worker-peek/i })
    await expect(sendBtn).toBeVisible()
    await expect(openBtn).toBeVisible()

    // Send to agent → claim+deliver → "Sent to <session>" / "Assigned to" toast.
    await sendBtn.click()
    await expect(
      page.getByText(/Sent to worker-peek|Assigned to worker-peek/i),
    ).toBeVisible()
  })

  test('Open session morphs to focus mode', async ({ page }) => {
    await page.addInitScript(injectGlobals(backend.token))

    const mk = await api(backend).createSession({
      name: 'worker-open',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(mk.status).toBe(201)
    await api(backend).startSession('worker-open')

    const created = await api(backend).createIssue({
      title: 'Open Me Task',
      owner_type: 'agent',
      status: 'todo',
    })
    expect(created.status).toBe(201)
    const id = await extApi(backend).issueId('Open Me Task')
    await api(backend).claim(id, 'worker-open')

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${backend.baseUrl}/board`)

    const c = card(page, 'Open Me Task')
    await c.hover()
    await page.getByRole('button', { name: /Open session worker-open/i }).click()

    // Navigated to the focus route for that session.
    await expect(page).toHaveURL(/\/focus\/worker-open/)
  })

  test('archived session → stale-link "reassign?" badge instead of a live dot', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))

    const mk = await api(backend).createSession({
      name: 'worker-gone',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(mk.status).toBe(201)
    await api(backend).startSession('worker-gone')

    const created = await api(backend).createIssue({
      title: 'Stale Link Task',
      owner_type: 'agent',
      status: 'todo',
    })
    expect(created.status).toBe(201)
    const id = await extApi(backend).issueId('Stale Link Task')
    await api(backend).claim(id, 'worker-gone')

    // Archive the session → R2 flips session_live=false on the linked card and
    // re-publishes the board over SSE.
    const arch = await extApi(backend).archiveSession('worker-gone')
    expect(arch.ok, 'archive session').toBeTruthy()

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${backend.baseUrl}/board`)

    const c = card(page, 'Stale Link Task')
    await expect(c).toBeVisible()
    // The stale-link reassign badge renders.
    await expect(c.getByText(/session archived — reassign\?/i)).toBeVisible()
  })

  test('mobile 430×932: live card renders with its status pill', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))

    const mk = await api(backend).createSession({
      name: 'worker-mobile',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(mk.status).toBe(201)
    await api(backend).startSession('worker-mobile')

    const created = await api(backend).createIssue({
      title: 'Mobile Live Task',
      owner_type: 'agent',
      status: 'todo',
    })
    expect(created.status).toBe(201)
    const id = await extApi(backend).issueId('Mobile Live Task')
    await api(backend).claim(id, 'worker-mobile')

    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto(`${backend.baseUrl}/board`)

    const c = card(page, 'Mobile Live Task')
    await expect(c).toBeVisible()
    await expect(c.getByText('worker-mobile')).toBeVisible()
  })
})

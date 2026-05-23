// U2 — issue detail sheet: live activity stream + inline comment + acceptance
// checklist + "Send to agent" primary + links + stale-link reassign.
//
// Drives the real binary over HTTP through the smoke harness, same as the other
// UI smoke specs. Seeds relations via the bearer board API, then asserts the
// sheet renders + mutates them (and never falls back to window.prompt).

import { expect, test, type Page } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

// Small bearer helpers for the relation endpoints the base harness doesn't wrap.
function rest(backend: Backend) {
  const h = {
    Authorization: `Bearer ${backend.token}`,
    'Content-Type': 'application/json',
  }
  return {
    comment: (id: string, body: string) =>
      fetch(`${backend.backendUrl}/api/board/${id}/comment`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ body }),
      }),
    addAcceptance: (id: string, body: string) =>
      fetch(`${backend.backendUrl}/api/board/${id}/acceptance`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ body }),
      }),
    addLink: (id: string, kind: 'pr' | 'commit', ref: string) =>
      fetch(`${backend.backendUrl}/api/board/${id}/link`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ kind, ref }),
      }),
    board: async () => {
      const res = await fetch(`${backend.backendUrl}/api/board?done_limit=0`, {
        headers: { Authorization: `Bearer ${backend.token}` },
      })
      const body = await res.json()
      return body.data as Array<Record<string, unknown>>
    },
  }
}

async function createIssueId(
  backend: Backend,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await api(backend).createIssue(body)
  expect(res.status, 'create issue').toBe(201)
  const json = await res.json()
  return String(json.data.id)
}

async function openSheet(page: Page, title: string) {
  await page.getByRole('button', { name: new RegExp(title) }).click()
  // Wait on the inline comment box (unique to the opened sheet) rather than the
  // "Activity" section label, which can collide with the empty-state copy.
  await expect(
    page.getByRole('textbox', { name: 'Write a comment' }),
  ).toBeVisible()
}

test.describe('issue detail sheet (U2)', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('activity stream renders a seeded comment + inline human comment posts (no window.prompt)', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    const id = await createIssueId(backend, {
      title: 'Has Activity',
      owner_type: 'human',
      status: 'todo',
    })
    // Seed an agent-style + a system-ish comment via the human API (author
    // 'user'); the activity stream renders it newest-first.
    expect((await rest(backend).comment(id, 'Seeded note from API')).status).toBe(200)

    await page.goto(`${backend.baseUrl}/board`)
    await openSheet(page, 'Has Activity')

    // The seeded comment shows in the stream.
    await expect(page.getByText('Seeded note from API')).toBeVisible()

    // Post a human comment inline — a real textarea, NOT window.prompt. Guard:
    // fail loudly if any window.prompt is ever invoked.
    let promptCalled = false
    await page.exposeFunction('__promptSpy', () => {
      promptCalled = true
    })
    await page.evaluate(() => {
      const orig = window.prompt
      window.prompt = ((...args: unknown[]) => {
        // @ts-expect-error test spy
        window.__promptSpy()
        // @ts-expect-error preserve
        return orig?.apply(window, args) ?? null
      }) as typeof window.prompt
    })

    const commentBox = page.getByRole('textbox', { name: 'Write a comment' })
    await commentBox.fill('A fresh human comment')
    await page.getByRole('button', { name: /^Comment$/ }).click()

    await expect(page.getByText('A fresh human comment')).toBeVisible()
    expect(promptCalled, 'window.prompt must NOT be used').toBe(false)

    // Backend recorded it.
    const issues = await rest(backend).board()
    const mine = issues.find((i) => i.id === id)
    const comments = (mine?.comments ?? []) as Array<{ body: string }>
    expect(comments.some((c) => c.body === 'A fresh human comment')).toBe(true)
  })

  test('acceptance checklist ticks + reflects progress', async ({ page }) => {
    await page.addInitScript(injectGlobals(backend.token))
    const id = await createIssueId(backend, {
      title: 'Checklist Card',
      owner_type: 'agent',
      status: 'doing',
    })
    expect((await rest(backend).addAcceptance(id, 'First criterion')).status).toBe(200)
    expect((await rest(backend).addAcceptance(id, 'Second criterion')).status).toBe(200)

    await page.goto(`${backend.baseUrl}/board`)
    await openSheet(page, 'Checklist Card')

    // Both items render.
    await expect(page.getByText('First criterion')).toBeVisible()
    await expect(page.getByText('Second criterion')).toBeVisible()

    // Tick the first item.
    await page
      .getByRole('checkbox', { name: /Mark "First criterion" complete/ })
      .click()

    // Progress reflects 1/2; the backend persisted the tick.
    await expect
      .poll(async () => {
        const issues = await rest(backend).board()
        const mine = issues.find((i) => i.id === id)
        const accept = (mine?.acceptance ?? []) as Array<{
          body: string
          done: number
        }>
        return accept.find((a) => a.body === 'First criterion')?.done
      })
      .toBe(1)
  })

  test('"Send to agent" is primary + claims + toasts; "Claim only" does not steer', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    // Live session (claim FK requires it to exist).
    expect(
      (
        await api(backend).createSession({
          name: 'worker-1',
          provider: 'shell',
          dir: backend.dataDir,
        })
      ).status,
    ).toBe(201)

    const sendId = await createIssueId(backend, {
      title: 'Send To Agent Card',
      owner_type: 'agent',
      status: 'todo',
    })

    await page.goto(`${backend.baseUrl}/board`)
    await openSheet(page, 'Send To Agent Card')

    // The primary action is "Send to agent" (not a bare "Claim").
    await expect(page.getByText('Send to agent', { exact: true })).toBeVisible()
    const picker = page.getByRole('listbox', { name: 'Sessions' })
    await picker.getByRole('option', { name: /worker-1/ }).click()

    // Primary Send button enables + reads "Send to worker-1".
    const sendBtn = page.getByRole('button', { name: /Send to worker-1/ })
    await expect(sendBtn).toBeEnabled()
    await sendBtn.click()

    // A toast confirms the send (with auto-dispatch).
    await expect(page.getByText(/Sent to worker-1/)).toBeVisible()

    // Backend: issue is now doing+worker-1, AND a steer was enqueued (deliver).
    const issues = await rest(backend).board()
    const sent = issues.find((i) => i.id === sendId)
    expect(sent?.status).toBe('doing')
    expect(sent?.session).toBe('worker-1')
    const steer1 = await fetch(
      `${backend.backendUrl}/api/sessions/worker-1/steer`,
      { headers: { Authorization: `Bearer ${backend.token}` } },
    )
    const steerBody = await steer1.json()
    expect(
      Array.isArray(steerBody.data) ? steerBody.data.length : 0,
      'send-to-agent enqueues a steer',
    ).toBeGreaterThan(0)

    // ── Claim only: a second card, claimed WITHOUT a steer. ──
    const claimOnlyId = await createIssueId(backend, {
      title: 'Claim Only Card',
      owner_type: 'agent',
      status: 'todo',
    })
    expect(
      (
        await api(backend).createSession({
          name: 'worker-2',
          provider: 'shell',
          dir: backend.dataDir,
        })
      ).status,
    ).toBe(201)
    await page.reload()
    await openSheet(page, 'Claim Only Card')
    await page
      .getByRole('listbox', { name: 'Sessions' })
      .getByRole('option', { name: /worker-2/ })
      .click()
    await page.getByRole('button', { name: /Claim only/i }).click()
    await expect(page.getByText(/Claimed for worker-2/)).toBeVisible()

    const after = await rest(backend).board()
    const claimed = after.find((i) => i.id === claimOnlyId)
    expect(claimed?.status).toBe('doing')
    expect(claimed?.session).toBe('worker-2')
    const steer2 = await fetch(
      `${backend.backendUrl}/api/sessions/worker-2/steer`,
      { headers: { Authorization: `Bearer ${backend.token}` } },
    )
    const steer2Body = await steer2.json()
    expect(
      Array.isArray(steer2Body.data) ? steer2Body.data.length : 0,
      'claim-only does NOT enqueue a steer',
    ).toBe(0)
  })

  test('links section shows seeded PR/commit refs', async ({ page }) => {
    await page.addInitScript(injectGlobals(backend.token))
    const id = await createIssueId(backend, {
      title: 'Linked Card',
      owner_type: 'agent',
      status: 'doing',
    })
    expect(
      (await rest(backend).addLink(id, 'pr', 'https://example.com/pr/42')).status,
    ).toBe(200)

    await page.goto(`${backend.baseUrl}/board`)
    await openSheet(page, 'Linked Card')

    await expect(page.getByText('Links')).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'https://example.com/pr/42' }),
    ).toBeVisible()
  })

  test('stale-link banner shows when the linked session was archived', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    expect(
      (
        await api(backend).createSession({
          name: 'gone',
          provider: 'shell',
          dir: backend.dataDir,
        })
      ).status,
    ).toBe(201)
    const id = await createIssueId(backend, {
      title: 'Stale Card',
      owner_type: 'agent',
      status: 'todo',
    })
    // Claim for 'gone' so the issue links to it, THEN archive 'gone' → the link
    // goes stale (session_live=false), and the board re-publishes (R2).
    expect((await api(backend).claim(id, 'gone')).status).toBe(200)
    const archive = await fetch(
      `${backend.backendUrl}/api/sessions/gone/archive`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${backend.token}` },
        body: '{}',
      },
    )
    expect(archive.ok).toBe(true)

    await page.goto(`${backend.baseUrl}/board`)
    await openSheet(page, 'Stale Card')

    await expect(page.getByText(/Session archived — reassign/)).toBeVisible()
  })
})

// ── Mobile (430×932, coarse pointer → Vaul drag-detent bottom sheet) ──────────
test.describe('issue detail sheet (U2) — mobile Vaul', () => {
  let backend: Backend

  // 430×932 with touch → `useMediaQuery('(pointer: coarse)')` matches, so
  // ResponsiveSheet renders the Vaul Drawer (data-testid="responsive-sheet").
  test.use({ viewport: { width: 430, height: 932 }, hasTouch: true, isMobile: true })

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('opens as a Vaul bottom sheet; activity + inline comment work', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    const id = await createIssueId(backend, {
      title: 'Mobile Card',
      owner_type: 'human',
      status: 'todo',
    })
    expect((await rest(backend).comment(id, 'Mobile seeded note')).status).toBe(200)

    await page.goto(`${backend.baseUrl}/board`)
    await page.getByRole('button', { name: /Mobile Card/ }).tap()

    // The Vaul drawer (mobile shell) is present, not the desktop side panel.
    await expect(page.getByTestId('responsive-sheet')).toBeVisible()
    await expect(page.getByText('Mobile seeded note')).toBeVisible()

    // Inline comment posts on mobile too (no window.prompt).
    await page.getByRole('textbox', { name: 'Write a comment' }).fill('Tapped a comment')
    await page.getByRole('button', { name: /^Comment$/ }).tap()
    await expect(page.getByText('Tapped a comment')).toBeVisible()
  })
})

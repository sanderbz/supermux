// Smoke e2e — concurrent board claims must never 500 (regression guard for a
// review-found SQLITE_BUSY bug; backend mirror: `board_claim.rs`).
//
// 100 PARALLEL POSTs to /api/board/{id}/claim against ONE agent-owned issue must
// yield EXACTLY 1 success (200) + 99 conflicts (409) and ZERO 500s. This is the
// end-to-end mirror of the backend `board_claim.rs` integration test: it drives
// the real binary over HTTP so the whole stack (axum extractor → BEGIN IMMEDIATE
// → busy_timeout) is exercised, proving SQLite write contention resolves to the
// 409 path and never bubbles a SQLITE_BUSY 500.

import { expect, test } from '@playwright/test'
import { api, startBackend, type Backend } from './harness'

test.describe('board claim race', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('100 parallel claims → exactly 1×200 + 99×409, zero 500s', async () => {
    const A = api(backend)

    // Two worker sessions so the claim's `issues.session` FK is valid.
    for (const name of ['worker', 'rival']) {
      const res = await A.createSession({ name, provider: 'shell', dir: backend.dataDir })
      expect(res.status, `create session ${name}`).toBe(201)
    }

    // One agent-owned, claimable issue.
    const createRes = await A.createIssue({
      title: 'race me',
      owner_type: 'agent',
      status: 'todo',
    })
    expect(createRes.status, 'create issue').toBe(201)
    const created = await createRes.json()
    const id: string = created.data.id
    expect(id, 'issue id present').toBeTruthy()

    // Fire 100 concurrent claims (alternating sessions), then tally statuses.
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        A.claim(id, i % 2 === 0 ? 'worker' : 'rival').then((r) => r.status),
      ),
    )

    const tally = results.reduce<Record<number, number>>((acc, s) => {
      acc[s] = (acc[s] ?? 0) + 1
      return acc
    }, {})

    const ok = tally[200] ?? 0
    const conflict = tally[409] ?? 0
    const serverErr = tally[500] ?? 0
    const other = results.length - ok - conflict - serverErr

    expect(serverErr, 'zero 500s (busy_timeout + BEGIN IMMEDIATE)').toBe(0)
    expect(other, 'every claim is 200 or 409').toBe(0)
    expect(ok, 'exactly one winner').toBe(1)
    expect(conflict, 'the other 99 conflict').toBe(99)

    // The winning issue is now `doing`, assigned to one of the workers.
    const list = await fetch(`${backend.backendUrl}/api/board?done_limit=0`, {
      headers: { Authorization: `Bearer ${backend.token}` },
    })
    expect(list.status).toBe(200)
    const board = await list.json()
    const issue = (board.data as Array<Record<string, unknown>>).find(
      (i) => i.id === id,
    )
    expect(issue?.status).toBe('doing')
    expect(['worker', 'rival']).toContain(issue?.session)
  })
})

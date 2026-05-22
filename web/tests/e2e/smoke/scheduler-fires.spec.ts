// M24b e2e — scheduler-fires (TECH_PLAN §10 "M24b"; §3.8 the scheduler runner).
//
// Create a one-shot `kind=shell` schedule ("in 5s") that touches a marker file,
// load the Scheduler route so it appears in the list, then WAIT for the runner
// to fire and assert the marker file exists ON DISK. This proves the M8 runner
// loop + M21 scheduler UI cohere end-to-end against a real booted backend.
//
// The runner ticks every 10s, so an "in 5s" job fires inside one tick window —
// the test allows a generous 25s for the firing.

import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectGlobals, startBackend, type Backend } from './harness'

test.describe('scheduler fires a one-shot job', () => {
  let backend: Backend
  let workDir: string

  test.beforeEach(async () => {
    backend = await startBackend()
    workDir = mkdtempSync(join(tmpdir(), 'supermux-e2e-sched-'))
  })
  test.afterEach(async () => {
    await backend?.dispose()
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  test('create "in 5s" shell schedule → marker file appears on disk', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.addInitScript(injectGlobals(backend.token))

    const marker = join(workDir, 'scheduler-marker.txt')
    expect(existsSync(marker), 'marker absent before firing').toBe(false)

    // Create the schedule directly through the bearer-auth REST API — the
    // runner picks it up regardless of whether the UI created it.
    const created = await fetch(`${backend.backendUrl}/api/schedules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${backend.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'e2e-marker',
        command: `touch ${marker}`,
        kind: 'shell',
        schedule_expr: 'in 5s',
      }),
    })
    expect(created.status, 'create schedule').toBe(201)

    // Load the Scheduler route — the new schedule must show up in the list,
    // proving the UI reads the same backend state.
    await page.goto(`${backend.baseUrl}/scheduler`)
    await expect(page.getByText('e2e-marker')).toBeVisible({ timeout: 15_000 })

    // Wait for the runner to fire — poll the marker file on disk. The 10s tick
    // plus the 5s offset means it lands within ~15s; allow 25s of slack.
    await expect(() => {
      expect(existsSync(marker), 'scheduler marker file written').toBe(true)
    }).toPass({ timeout: 25_000, intervals: [500] })
  })
})

// Fase A1 — the renderer switch at the desktop focus seam.
//
// Boots the real binary (harness). This is the suite's FIRST spec that
// creates `provider: 'claude'` (all other smoke specs use 'shell'), which
// makes two things non-negotiable:
//
// 1. The backend's hook installer writes into $CLAUDE_CONFIG_DIR — so this
//    module forces an isolated dir at import time, BEFORE any backend boots
//    (spawnBackend inherits process.env). A plain `bun run test:e2e:smoke`
//    must never touch the real ~/.claude/settings.json.
// 2. The claude-provider tests skip when the CLI isn't on the runner's PATH
//    (a missing binary would stop the session and fail the seam assertion
//    for an unrelated reason). The shell-provider ineligibility test always
//    runs; the flag decision table itself is covered by bun unit tests.
//
// Needs server/target/debug/supermux-server — `cd server && cargo build`
// first (debug; never --release).

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { api, injectGlobals, startBackend, type Backend } from './harness'

// Module scope: runs before any beforeEach/startBackend in this file.
process.env.CLAUDE_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'a1-claude-cfg-'))

const hasClaudeCli = (() => {
  try {
    execSync('command -v claude', { stdio: 'ignore', shell: '/bin/bash' })
    return true
  } catch {
    return false
  }
})()

// zustand persist payload for the UI store with the A1 flag ON.
const FLAG_ON = JSON.stringify({ state: { chatRenderer: true }, version: 0 })

test.describe('chat renderer switch (fase A1)', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('flag on → chat panel default; terminal one tap away and back', async ({
    page,
  }) => {
    test.skip(!hasClaudeCli, 'claude CLI not on this runner')
    await page.setViewportSize({ width: 1280, height: 800 }) // desktop focus seam
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, FLAG_ON)

    const res = await api(backend).createSession({
      name: 'a1-chat',
      provider: 'claude',
      dir: backend.dataDir,
    })
    expect([200, 201]).toContain(res.status)
    // Create leaves the session `stopped`; the seam only renders a renderer at
    // all when status !== 'stopped', so boot the pane.
    expect((await api(backend).startSession('a1-chat')).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/a1-chat`)
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    // The panel's own input surface is mounted. This used to look for the A1
    // "Read-only preview" line; fase A4 made the composer live and deliberately
    // drops that line whenever a send is possible (pinned in
    // `tests/unit/chat-interactive.test.tsx`), so the composer field IS the
    // "this really is the chat renderer, not an empty shell" evidence now.
    await expect(page.getByTestId('chat-composer-field')).toBeVisible()

    // One tap to the terminal fallback…
    await page.getByTestId('renderer-terminal').click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)

    // …and one tap back.
    await page.getByTestId('renderer-chat').click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
  })

  test('kill-switch forces the terminal even with the flag on', async ({
    page,
  }) => {
    test.skip(!hasClaudeCli, 'claude CLI not on this runner')
    await page.setViewportSize({ width: 1280, height: 800 }) // desktop focus seam
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
      window.localStorage.setItem('supermux:chat-renderer', '0')
    }, FLAG_ON)

    const res = await api(backend).createSession({
      name: 'a1-kill',
      provider: 'claude',
      dir: backend.dataDir,
    })
    expect([200, 201]).toContain(res.status)
    expect((await api(backend).startSession('a1-kill')).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/a1-kill`)
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    await expect(page.getByTestId('renderer-chat')).toHaveCount(0)
  })

  test('ineligible provider (shell) never gets the chat renderer', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 }) // desktop focus seam
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, FLAG_ON)

    const res = await api(backend).createSession({
      name: 'a1-shell',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect([200, 201]).toContain(res.status)
    expect((await api(backend).startSession('a1-shell')).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/a1-shell`)
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
  })
})

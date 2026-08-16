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
    // FASE A5 — this used to read `toHaveCount(0)`. That assertion encoded "the
    // toggle UNMOUNTS the other renderer", which is exactly what A5 exists to
    // stop: the panel is now RETAINED, hidden in the other half of one grid
    // cell, so the escape hatch is a crossfade instead of a handshake. It must
    // still be invisible, and Playwright's `toBeHidden` is satisfied by
    // `visibility: hidden` — which is the mechanism, not an accident.
    await expect(page.getByTestId('chat-panel')).toBeHidden()

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

  // ── FASE A5 ──────────────────────────────────────────────────────────────

  test('A5: the panel is RETAINED across toggles — mounted once, never re-created', async ({
    page,
  }) => {
    test.skip(!hasClaudeCli, 'claude CLI not on this runner')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, FLAG_ON)

    const name = 'a5-retain'
    expect([200, 201]).toContain(
      (await api(backend).createSession({ name, provider: 'claude', dir: backend.dataDir }))
        .status,
    )
    expect((await api(backend).startSession(name)).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/${name}`)
    await expect(page.getByTestId('chat-panel')).toBeVisible()

    // Stamp the mounted panel. A remount replaces the ELEMENT, so a property
    // set on it cannot survive one — which is a mount counter without needing
    // product code to carry one.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-panel"]') as HTMLElement & {
        __mountId?: number
      }
      el.__mountId = 4242
    })

    for (let i = 0; i < 20; i++) {
      await page.getByTestId('renderer-terminal').click()
      await expect(page.getByTestId('chat-panel')).toBeHidden()
      await page.getByTestId('renderer-chat').click()
      await expect(page.getByTestId('chat-panel')).toBeVisible()
    }

    const stillTheSameElement = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-panel"]') as HTMLElement & {
        __mountId?: number
      }
      return el?.__mountId
    })
    expect(stillTheSameElement).toBe(4242)

    // …and the terminal is retained in the other direction: after the first
    // tap it never leaves the tree, it only stops being visible.
    await page.getByTestId('renderer-terminal').click()
    await expect(page.locator('.xterm')).toBeVisible()
    await page.getByTestId('renderer-chat').click()
    await expect(page.locator('.xterm')).toHaveCount(1)
    await expect(page.locator('.xterm')).toBeHidden()
  })

  test('A5: the choice PERSISTS across a reload (it is a pref, not useState)', async ({
    page,
  }) => {
    test.skip(!hasClaudeCli, 'claude CLI not on this runner')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.addInitScript(injectGlobals(backend.token))
    // SEED ONLY — `addInitScript` runs on EVERY document, so an unconditional
    // write would re-seed (and wipe the pin) on the reload this test is about.
    await page.addInitScript((flag: string) => {
      if (!window.localStorage.getItem('supermux-ui')) {
        window.localStorage.setItem('supermux-ui', flag)
      }
    }, FLAG_ON)

    const name = 'a5-persist'
    expect([200, 201]).toContain(
      (await api(backend).createSession({ name, provider: 'claude', dir: backend.dataDir }))
        .status,
    )
    expect((await api(backend).startSession(name)).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/${name}`)
    await expect(page.getByTestId('chat-panel')).toBeVisible()

    // Pin Terminal, reload, land on Terminal. Before A5 this reset to chat.
    await page.getByTestId('renderer-terminal').click()
    await expect(page.locator('.xterm')).toBeVisible()
    await page.reload()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    await expect(page.getByTestId('renderer-terminal')).toHaveAttribute(
      'aria-selected',
      'true',
    )

    // Pin Auto, reload, land on the default (chat, with the experiment on).
    await page.getByTestId('renderer-auto').click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expect(page.getByTestId('renderer-auto')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // …and Auto MARKS what it resolved to, so "Auto, currently Chat" is one
    // glance rather than two controls.
    await expect(page.getByTestId('renderer-chat')).toHaveAttribute(
      'data-resolved',
      'true',
    )
  })

  test('A5: ineligibility beats a stale pin', async ({ page }) => {
    // No CLI needed: a `shell` session is ineligible by provider.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, JSON.stringify({
      state: {
        chatRenderer: true,
        // A pin left behind by a session that USED to be eligible, or written
        // by a peer device. It must not conjure a chat surface on a shell.
        rendererOverrides: { 'a5-stale': 'chat' },
      },
      version: 0,
    }))

    const name = 'a5-stale'
    expect([200, 201]).toContain(
      (await api(backend).createSession({ name, provider: 'shell', dir: backend.dataDir }))
        .status,
    )
    expect((await api(backend).startSession(name)).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/${name}`)
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    // …and no switch at all: an ineligible session has exactly one renderer.
    await expect(page.getByTestId('renderer-chat')).toHaveCount(0)
    await expect(page.getByTestId('renderer-auto')).toHaveCount(0)
  })
})

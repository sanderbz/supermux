// AREA 3 — the OAuth login, driven end to end through the real server AND the
// real web UI.
//
// The provider is `server/tests/fixtures/login/fake-login.py`, installed on the
// backend's PATH under the name `claude`. That is what makes this a REAL test of
// the shipped path rather than of a bench: the session is an ordinary
// `provider: 'claude'` session, the launcher execs `claude` exactly as it always
// does, a genuine pty holder owns it, the peek poller feeds the lens, and the
// card that appears is the one a user would see. The only thing that is fake is
// the OAuth server on the other end of it — which is the one thing that must be.
//
// It asserts the two halves that no unit test can:
//   1. the card renders from a LIVE capture — the URL survives the grid's
//      wrapping all the way to an `href`;
//   2. the code typed into the browser reaches the pty as one bracketed-paste
//      burst, a rejection re-prompts in place without respawning anything, and
//      the mandatory Enter after `Login successful` is really sent (the fake
//      provider writes a file to prove it).
//
// Needs server/target/debug/supermux-server — `cd server && cargo build` first
// (debug; never --release).

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { api, injectGlobals, startBackend, type Backend } from './harness'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const FAKE = join(REPO_ROOT, 'server', 'tests', 'fixtures', 'login', 'fake-login.py')

// The shim: a `claude` on the backend's PATH that is really the fake provider.
//
// It is handed to the BACKEND ONLY (`startBackend({ env })`), together with a
// throwaway `HOME`. Both halves are needed. Prepending to `process.env.PATH`
// alone does not work: the launcher types its command into the pane's shell,
// which sources the developer's `~/.bashrc`, and that re-prepends
// `~/.local/bin` — where the REAL claude lives — back in front of the shim. An
// empty `HOME` means no rc file, so the PATH the server was given is the PATH
// the pane gets. It also keeps this spec from reading or writing anything of
// the developer's, which for a test about credentials is the point.
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'login-e2e-shim-'))
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'login-e2e-home-'))
const RESULT = join(SHIM_DIR, 'result')
writeFileSync(
  join(SHIM_DIR, 'claude'),
  `#!/bin/sh\nexec env FAKE_LOGIN_RESULT=${RESULT} python3 ${FAKE}\n`,
)
chmodSync(join(SHIM_DIR, 'claude'), 0o755)
const BACKEND_ENV = {
  PATH: `${SHIM_DIR}:${process.env.PATH ?? ''}`,
  HOME: FAKE_HOME,
}

/** The zustand persist payload that puts the chat renderer on the focus seam. */
const FLAG_ON = JSON.stringify({ state: { chatRenderer: true }, version: 0 })

/** Starts with `c` on purpose: a lone `c` in that field copies the URL and
 *  CLEARS it, so a char-at-a-time writer destroys this code on keystroke one. */
const GOOD = 'cQfTy2QK9nZ8vLpR3sWx7mBd4gHj1kAe#hVQ0m2rXqvY7bK1cLp9sTfR8dNzE4uJa'
/** Well-formed to the server, refused by the provider — the retry path. */
const BAD = 'badQfTy2QK9nZ8vLpR3sWx#hVQ0m2rXqvY7bK1cLp9sTfR8dNzE4uJa'

const hasPython = (() => {
  try {
    return existsSync('/usr/bin/python3') || existsSync('/usr/local/bin/python3')
  } catch {
    return false
  }
})()

test.describe('the OAuth login card (AREA 3)', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({ env: BACKEND_ENV })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('signs a session in from the chat surface, retry and all', async ({ page }) => {
    test.skip(!hasPython, 'python3 not on this runner')
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, FLAG_ON)

    const created = await api(backend).createSession({
      name: 'login-ui',
      provider: 'claude',
      dir: backend.dataDir,
    })
    expect([200, 201]).toContain(created.status)
    expect((await api(backend).startSession('login-ui')).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/login-ui`)
    await expect(page.getByTestId('chat-panel')).toBeVisible()

    // ── the card, off a LIVE capture ────────────────────────────────────────
    const card = page.getByTestId('login-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toHaveAttribute('data-stage', 'paste_prompt')
    // The URL was hard-wrapped across the grid by the pty. It has to arrive
    // here whole, or the link goes nowhere.
    const href = await page.getByTestId('login-open-link').getAttribute('href')
    expect(href).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/)
    expect(href).toContain('&state=hVQ0m2rXqvY7bK1cLp9sTfR8dNzE4uJa')

    // ── a half-paste never reaches the pty ──────────────────────────────────
    await page.getByTestId('login-code').fill('no-hash-here')
    await page.getByTestId('login-submit').click()
    await expect(page.getByRole('alert').first()).toContainText('#')
    await expect(card).toHaveAttribute('data-stage', 'paste_prompt')

    // ── a rejection re-prompts IN PLACE ─────────────────────────────────────
    await page.getByTestId('login-code').fill(BAD)
    await page.getByTestId('login-submit').click()
    await expect(card).toHaveAttribute('data-stage', 'invalid', { timeout: 20_000 })

    // ── the good code, through the same field ───────────────────────────────
    await page.getByTestId('login-code').fill(GOOD)
    await page.getByTestId('login-submit').click()
    await expect(card).toHaveAttribute('data-stage', 'success', { timeout: 20_000 })
    // Byte for byte, unbroken — the burst is what carries the leading `c`
    // safely past the field's copy-and-clear shortcut.
    expect(readFileSync(RESULT, 'utf8')).toBe(GOOD)

    // ── the press that writes the onboarding flags ──────────────────────────
    await page.getByTestId('login-confirm').click()
    await expect
      .poll(() => existsSync(`${RESULT}.confirmed`), { timeout: 20_000 })
      .toBe(true)

    // ── and the credential is nowhere the server persists ───────────────────
    const rows = await (await api(backend).listSessions()).text()
    expect(rows).not.toContain(GOOD)
    expect(await api(backend).peek('login-ui', 200)).not.toContain(GOOD)
  })
})

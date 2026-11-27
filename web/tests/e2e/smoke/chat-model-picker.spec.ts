// The chat header's model chip + picker, driven end to end through the real
// server and the real web UI.
//
// The agent is `server/tests/fixtures/model/fake-model.py`, installed on the
// backend's PATH under the name `claude` (the `login-flow.spec.ts` shim). It
// reproduces Claude Code 2.1.326's `/model` picker and argument form as probed
// live, POSTs statusline payloads to the tap the way the real statusline command
// does, and logs every key that crosses the pty. So this asserts the two halves
// no unit test can:
//   1. the chip renders from a LIVE statusline payload and moves when the agent
//      reports a new model — not on the click;
//   2. a pick reaches the pty as exactly the sequence that was watched working
//      on the shipping CLI: `/model`, the row delta, `s` for this-session-only;
//      `/model <alias>` when the setting says "also the default".
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
const FAKE = join(REPO_ROOT, 'server', 'tests', 'fixtures', 'model', 'fake-model.py')

// Backend-only PATH + an empty HOME, for the reason `login-flow.spec.ts` gives:
// the pane's shell would otherwise source an rc file that puts the real claude
// back in front of the shim.
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'model-e2e-shim-'))
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'model-e2e-home-'))
const LOG = join(SHIM_DIR, 'keys.jsonl')
writeFileSync(join(SHIM_DIR, 'claude'), `#!/bin/sh\nexec env FAKE_MODEL_LOG=${LOG} python3 ${FAKE}\n`)
chmodSync(join(SHIM_DIR, 'claude'), 0o755)
const BACKEND_ENV = { PATH: `${SHIM_DIR}:${process.env.PATH ?? ''}`, HOME: FAKE_HOME }

const FLAG_ON = JSON.stringify({ state: { botMode: true }, version: 1 })

const hasPython = existsSync('/usr/bin/python3') || existsSync('/usr/local/bin/python3')

type Ev = { ev: string; text?: string; key?: string; model?: string; scope?: string }
const events = (): Ev[] =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : []
/** What crossed the pty, compactly: pastes as their text, keys by name. */
const inputs = (from: number) =>
  events()
    .slice(from)
    .filter((e) => e.ev === 'paste' || e.ev === 'key')
    .map((e) => (e.ev === 'paste' ? `paste:${e.text}` : e.key))

test.describe('the chat header model picker', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({ env: BACKEND_ENV })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('shows the live model and switches it, session-only and as default', async ({ page }) => {
    test.skip(!hasPython, 'python3 not on this runner')
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, FLAG_ON)

    const created = await api(backend).createSession({
      name: 'model-ui',
      provider: 'claude',
      dir: backend.dataDir,
    })
    expect([200, 201]).toContain(created.status)
    expect((await api(backend).startSession('model-ui')).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/model-ui`)
    await expect(page.getByTestId('chat-panel')).toBeVisible()

    // ── the chip, off the boot statusline ───────────────────────────────────
    const chip = page.getByTestId('chat-header-model')
    await expect(chip).toHaveText('Opus 5.5', { timeout: 30_000 })

    // ── session only (the default setting): `/model`, one Down, `s` ─────────
    // Opus is row 2 of 5 and the cursor opens on it; Fable is row 3.
    await expect.poll(async () => (await api(backend).listSessions()).text(), { timeout: 20_000 })
      .toContain('"status":"idle"')
    let mark = events().length
    await chip.click()
    const picker = page.getByTestId('model-picker')
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('button', { name: /Opus/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('model-picker-note')).toContainText('this session only')
    await picker.getByRole('button', { name: /Fable/ }).click()
    await expect(chip).toHaveText('Fable 5.2', { timeout: 20_000 })
    expect(inputs(mark)).toEqual(['paste:/model ', 'Enter', 'Down', 's'])
    expect(events().filter((e) => e.ev === 'pick').at(-1)).toMatchObject({ model: 'fable', scope: 'session' })
    // Confirmation reaches the user.
    await expect(page.getByText(/Switched to Fable for this session only/)).toBeVisible()

    // ── setting OFF → Claude Code's own `/model <alias>` (also the default) ──
    const put = await fetch(`${backend.backendUrl}/api/prefs/model.pick_scope`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'default' }),
    })
    expect(put.ok).toBeTruthy()
    await page.reload()
    await expect(chip).toHaveText('Fable 5.2', { timeout: 30_000 })
    mark = events().length
    await chip.click()
    await expect(page.getByTestId('model-picker-note')).toContainText('default for new sessions')
    await page.getByTestId('model-picker').getByRole('button', { name: /Sonnet/ }).click()
    await expect(chip).toHaveText('Sonnet 5.5', { timeout: 20_000 })
    expect(inputs(mark)).toEqual(['paste:/model sonnet', 'Enter'])
    expect(events().filter((e) => e.ev === 'pick').at(-1)).toMatchObject({ model: 'sonnet', scope: 'default' })
  })

  test('refuses to type into a busy composer', async () => {
    test.skip(!hasPython, 'python3 not on this runner')
    test.setTimeout(60_000)
    const created = await api(backend).createSession({
      name: 'model-busy',
      provider: 'claude',
      dir: backend.dataDir,
    })
    expect([200, 201]).toContain(created.status)
    expect((await api(backend).startSession('model-busy')).ok).toBeTruthy()
    const h = { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' }
    // A half-typed draft in the composer: a pick must not land on top of it.
    await fetch(`${backend.backendUrl}/api/sessions/model-busy/keys`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ key: 'y' }),
    })
    await expect.poll(async () => api(backend).peek('model-busy', 20), { timeout: 10_000 }).toContain('❯ y')
    const mark = events().length
    const res = await fetch(`${backend.backendUrl}/api/sessions/model-busy/model`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ model: 'fable', scope: 'session' }),
    })
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('composer')
    expect(inputs(mark)).toEqual([])
  })
})

// THE DEFAULT HOST: no statusline tap — and a LOGGED-IN account's picker
// (`FAKE_MODEL_LOGGED_IN=1`, from a real capture): versioned labels, a row-1
// description naming Opus, an unnumbered `More models` row. The chip has to come from the transcript
// the chat tailer already reads — the main agent's last reply (`message.model`),
// never the sidechain record on Haiku the stand-in also writes — and a pick has
// to move it from the `Set model to …` record Claude Code writes the moment the
// pick lands, BEFORE any turn (the stand-in never takes one).
test.describe('the chat header model picker, without the statusline tap', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({
      env: { ...BACKEND_ENV, FAKE_MODEL_NO_TAP: '1', FAKE_MODEL_LOGGED_IN: '1' },
    })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('reads the model off the transcript and moves on the pick', async ({ page }) => {
    test.skip(!hasPython, 'python3 not on this runner')
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, FLAG_ON)

    const created = await api(backend).createSession({
      name: 'model-jsonl',
      provider: 'claude',
      dir: backend.dataDir,
    })
    expect([200, 201]).toContain(created.status)
    expect((await api(backend).startSession('model-jsonl')).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/model-jsonl`)
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    const chip = page.getByTestId('chat-header-model')
    // Opus from the main reply — not Haiku from the sidechain record after it.
    await expect(chip).toHaveText('Opus 5.5', { timeout: 30_000 })
    // And no statusline was ever posted: this is the transcript plane.
    expect(events().some((e) => e.ev === 'statusline_error')).toBe(false)

    await expect.poll(async () => (await api(backend).listSessions()).text(), { timeout: 20_000 })
      .toContain('"status":"idle"')
    const mark = events().length
    await chip.click()
    // Sonnet: two rows down from Opus, one key at a time, each seen landing.
    await page.getByTestId('model-picker').getByRole('button', { name: /Sonnet/ }).click()
    await expect(chip).toHaveText('Sonnet 5.5', { timeout: 20_000 })
    expect(inputs(mark)).toEqual(['paste:/model ', 'Enter', 'Down', 'Down', 's'])
    expect(events().filter((e) => e.ev === 'pick').at(-1)).toMatchObject({ model: 'sonnet', scope: 'session' })
  })
})

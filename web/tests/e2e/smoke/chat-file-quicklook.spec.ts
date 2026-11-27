// A file Claude names opens over the chat — and the chat is still there after.
//
// The journey the feature exists for: Claude writes "fill in your key in
// `config/.env`", the user clicks the path, edits the file in place, saves, and
// closes — and is back at the exact message they were reading, on the same
// route. Then "Go to file" is the one exit that does leave, into Files at that
// file.
//
// Everything here is the real server: the transcript tailer, `/api/file` reads
// and the `PUT` that writes to disk, the Files route's `?path=&select=` deep
// link. The path in the message is RELATIVE, so it also proves resolution on the
// session's working dir.
//
// Needs server/target/debug/supermux-server — `cd server && cargo build`
// first (debug; never --release).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { CHAT_BACKEND_ENV, chatSession, primePage } from './chat-fixture'
import { startBackend, type Backend } from './harness'

/** The chat's own scroller and where it is — the "where you were" to keep. */
async function readingPosition(page: Page): Promise<number> {
  return page.locator('[data-chat-track]').evaluate((el) => el.scrollTop)
}

test.describe('chat: a file path opens a quick look over the chat', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({ env: CHAT_BACKEND_ENV })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('preview, edit + save, close back to the same place, then Go to file', async ({ page }) => {
    test.setTimeout(180_000)

    const fx = await chatSession(backend, 'quicklook')
    mkdirSync(join(fx.workDir, 'config'), { recursive: true })
    writeFileSync(join(fx.workDir, 'PLAN.md'), '# Launch plan\n\n- ship the quick look\n')
    const envPath = join(fx.workDir, 'config', '.env')
    writeFileSync(envPath, 'API_KEY=\n')

    // The file message sits in the MIDDLE of the transcript, so reading it
    // means being scrolled to a position that is neither end — the position a
    // route change would lose.
    const filler = (from: number) =>
      Array.from({ length: 12 }, (_, i) => ({
        assistant: `Status update ${from + i}: still working through the checklist.`,
      }))
    fx.write('ql-conv', [
      ...filler(1),
      'Where do I put the API key?',
      {
        assistant:
          'I wrote the plan to `PLAN.md`. Put your key in `config/.env` — it must not go through the chat. ' +
          'The old notes in `missing/notes.md` are gone.',
      },
      ...filler(13),
    ])
    await fx.hook('ql-conv')

    await primePage(page, backend)
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`)
    await expect(page.getByTestId('chat-panel')).toBeVisible()

    const planLink = page.getByRole('button', { name: 'Open PLAN.md' })
    const envLink = page.getByRole('button', { name: 'Open .env' })
    await expect(envLink).toBeVisible({ timeout: 20_000 })
    // Relative paths resolved on the session's working dir.
    await expect(envLink).toHaveAttribute('data-file-link', /\/config\/\.env$/)

    // Scroll the message to the middle of the track: not the bottom, not the top.
    await envLink.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(300)
    const before = await readingPosition(page)
    const url = page.url()
    expect(before).toBeGreaterThan(0)

    // ── markdown previews ───────────────────────────────────────────────────
    await planLink.click()
    const dialog = page.getByRole('dialog', { name: 'PLAN.md' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Launch plan' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    // Focus came back to the link it was opened from.
    await expect(planLink).toBeFocused()
    expect(page.url()).toBe(url)
    expect(Math.abs((await readingPosition(page)) - before)).toBeLessThan(2)

    // ── text opens in the editor; edit + save lands on disk ─────────────────
    await envLink.click()
    const envDialog = page.getByRole('dialog', { name: '.env' })
    const editor = envDialog.locator('.cm-content')
    await expect(editor).toContainText('API_KEY=')
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('End')
    await page.keyboard.type('sk-test-123')

    // A dirty buffer is never closed silently.
    await envDialog.getByRole('button', { name: 'Close' }).click()
    await expect(envDialog.getByText('.env has unsaved changes.')).toBeVisible()
    await envDialog.getByRole('button', { name: 'Keep editing' }).click()

    await envDialog.getByRole('button', { name: 'Save' }).click()
    await expect(envDialog.getByText('Unsaved changes')).toHaveCount(0, { timeout: 10_000 })
    await expect(() => {
      expect(readFileSync(envPath, 'utf8')).toBe('API_KEY=sk-test-123\n')
    }).toPass({ timeout: 8_000 })

    await envDialog.getByRole('button', { name: 'Close' }).click()
    await expect(envDialog).toHaveCount(0)
    await expect(envLink).toBeFocused()
    expect(page.url()).toBe(url)
    expect(Math.abs((await readingPosition(page)) - before)).toBeLessThan(2)

    // ── a path with nothing at it says so ───────────────────────────────────
    await page.getByRole('button', { name: 'Open notes.md' }).click()
    const missing = page.getByRole('dialog', { name: 'notes.md' })
    await expect(missing.getByText('File not found')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(missing).toHaveCount(0)

    // ── Go to file: the Files view, at that file ────────────────────────────
    await envLink.click()
    await page.getByRole('dialog', { name: '.env' }).getByRole('button', { name: 'Go to file in Files' }).click()
    await expect(page).toHaveURL(/\/files\?path=.*&select=\.env/)
    await expect(page.locator('.cm-content')).toContainText('API_KEY=sk-test-123')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})

test.describe('chat: the quick look on a phone is the bottom sheet', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({ env: CHAT_BACKEND_ENV })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('opens as a sheet, previews, and closes back to the chat', async ({ page }) => {
    test.setTimeout(180_000)

    const fx = await chatSession(backend, 'qlphone')
    writeFileSync(join(fx.workDir, 'PLAN.md'), '# Launch plan\n\n- ship the quick look\n')
    fx.write('qlp-conv', ['Where is the plan?', { assistant: 'It is in `PLAN.md`.' }])
    await fx.hook('qlp-conv')

    await primePage(page, backend)
    // `primePage` pins the desktop seam; this test is the phone.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`)
    await expect(page.getByTestId('chat-panel')).toBeVisible()

    const url = page.url()
    await page.getByRole('button', { name: 'Open PLAN.md' }).click()
    const sheet = page.getByTestId('responsive-sheet')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('heading', { name: 'Launch plan' })).toBeVisible()
    await sheet.getByRole('button', { name: 'Close' }).click()
    await expect(sheet).toHaveCount(0)
    expect(page.url()).toBe(url)
    await expect(page.getByTestId('chat-panel')).toBeVisible()
  })
})

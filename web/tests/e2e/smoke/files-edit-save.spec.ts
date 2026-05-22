// M24b e2e — files-edit-save (TECH_PLAN §10 "M24b"; §7).
//
// The full file-editing journey end-to-end: write a temp file on disk → browse
// to it through the real Files UI → edit it in the CodeMirror editor → Save →
// assert the new content landed ON DISK via a direct fs read. This proves the
// M20 file editor + M7 files API cohere: GET /api/files/raw → editor → PUT
// /api/files → fsync to disk.

import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectGlobals, startBackend, type Backend } from './harness'

test.describe('files: browse, edit, save', () => {
  let backend: Backend
  let workDir: string

  test.beforeEach(async () => {
    backend = await startBackend()
    workDir = mkdtempSync(join(tmpdir(), 'amux-e2e-files-'))
  })
  test.afterEach(async () => {
    await backend?.dispose()
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  test('edit a temp file in the editor → Save → new content on disk', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 800 }) // desktop split view
    await page.addInitScript(injectGlobals(backend.token))

    // Seed a small text file the editor can open writable (`.txt` is writable
    // and well under the truncation cap).
    const filePath = join(workDir, 'note.txt')
    const original = 'original line one\n'
    writeFileSync(filePath, original, 'utf8')

    // Browse directly to the directory — the Files route reads ?path=.
    await page.goto(`${backend.baseUrl}/files?path=${encodeURIComponent(workDir)}`)

    // The file row renders as a button whose accessible name STARTS with the
    // file name ("note.txt 18 B · just now"); the row's own kebab menu button
    // ("Actions for note.txt") also contains the name, so match on the leading
    // "note.txt " to pick the row, not the menu. Click opens the FileViewer.
    const row = page.getByRole('button', { name: /^note\.txt /, exact: false })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()

    // CodeMirror renders a contenteditable `.cm-content` div with REAL DOM text
    // (unlike xterm's canvas) — assert the original content is shown, then edit.
    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await expect(editor).toContainText('original line one')

    // Append a distinctive marker through the real editor. Click into the
    // editor, jump to the document end, and type.
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('EDITED_BY_E2E_MARKER')

    // The Save button is disabled until the buffer is dirty; once we've typed it
    // must be enabled. Click it.
    const save = page.getByRole('button', { name: 'Save' })
    await expect(save).toBeEnabled()
    await save.click()

    // After a successful save the status line leaves "Unsaved changes".
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, {
      timeout: 10_000,
    })

    // Ground truth: read the file straight off disk and assert the edit landed.
    await expect(() => {
      const onDisk = readFileSync(filePath, 'utf8')
      expect(onDisk).toContain('original line one')
      expect(onDisk).toContain('EDITED_BY_E2E_MARKER')
    }).toPass({ timeout: 8_000 })
  })
})

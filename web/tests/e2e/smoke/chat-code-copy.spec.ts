// One-tap copy on a chat code block, in a real browser against a real backend.
//
// Three behaviours, because each guards a different seam:
//   - fine pointer: the corner button copies the fence source (no trailing
//     newline) and flips to "Copied";
//   - coarse pointer on the DESKTOP surface (a tablet: 1024x768, touch): the
//     button is visually hidden (sr-only) but reachable, the "Tap to copy" hint shows, and tapping the block
//     copies;
//   - fine pointer: a click inside the <pre> does NOT copy (tap-to-copy is
//     coarse-only), so selecting text with a mouse never clobbers the clipboard.
//
// The fixture only writes user prompts, so the assistant line carrying the
// fenced blocks is appended to the same transcript by hand, in the JSONL shape
// the tailer reads from Claude.
//
// Needs server/target/debug/supermux-server — `cd server && cargo build` first.

import { appendFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { CHAT_BACKEND_ENV, chatSession, expectTokenOnce, primePage, type ChatFixture } from './chat-fixture'
import { startBackend, type Backend } from './harness'

const BASH = 'npm run build && echo "done"'
const JSON_SRC = '{\n  "ok": true,\n  "n": 1\n}'
const ANSWER =
  'CODE-COPY-ANSWER here are two blocks.\n\n' +
  '```bash\n' + BASH + '\n```\n\n' +
  '```json\n' + JSON_SRC + '\n```\n'

/** Append one assistant record to the conversation file `fx.write` created. */
function appendAssistant(fx: ChatFixture, conv: string, text: string): void {
  const encoded = realpathSync(fx.workDir).replace(/[/.]/g, '-')
  const file = join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', encoded, `${conv}.jsonl`)
  appendFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      uuid: `${conv}-assistant-1`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString(),
      sessionId: conv,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) + '\n',
  )
}

async function seed(backend: Backend, page: Page, name: string): Promise<void> {
  const fx = await chatSession(backend, name)
  fx.write('copy-conv', ['CODE-COPY-SEED'])
  appendAssistant(fx, 'copy-conv', ANSWER)
  await fx.hook('copy-conv')
  await primePage(page, backend)
}

const readClipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

test.describe('code-block copy', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({ env: CHAT_BACKEND_ENV })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('fine pointer: the button copies the source and the pre does not', async ({ page }) => {
    test.setTimeout(120_000)
    await seed(backend, page, 'copy-fine')
    await page.goto(`${backend.baseUrl}/focus/copy-fine`)
    await expectTokenOnce(page, 'CODE-COPY-ANSWER')

    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false)

    const pre = page.locator('pre', { hasText: 'npm run build' })
    await expect(pre).toBeVisible()
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'))

    // A click inside the block (not the button) must leave the clipboard alone.
    await pre.click({ position: { x: 40, y: 40 } })
    await page.waitForTimeout(300)
    expect(await readClipboard(page)).toBe('SENTINEL')

    const block = page.locator('[data-code-block]', { has: pre })
    await block.getByRole('button', { name: 'Copy code' }).click()
    expect(await readClipboard(page)).toBe(BASH)
    await expect(block.getByRole('button', { name: 'Copied' })).toBeVisible()
  })

  test.describe('tablet (touch, desktop surface)', () => {
    test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true })

    test('coarse pointer: hint shown, button visually hidden but reachable, tapping the block copies', async ({ page }) => {
      test.setTimeout(120_000)
      await seed(backend, page, 'copy-touch')
      // primePage pins 1280x800; the tablet geometry is the subject.
      await page.setViewportSize({ width: 1024, height: 768 })
      await page.goto(`${backend.baseUrl}/focus/copy-touch`)
      await expectTokenOnce(page, 'CODE-COPY-ANSWER')

      expect(
        await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
        'this test only means anything on a coarse pointer',
      ).toBe(true)

      const pre = page.locator('pre', { hasText: 'npm run build' })
      await expect(pre).toBeVisible()
      const block = page.locator('[data-code-block]', { has: pre })
      // Visually gone (sr-only: a 1px box) but still in the a11y tree.
      const button = block.getByRole('button', { name: 'Copy code' })
      await expect(button).toBeAttached()
      const box = await button.boundingBox()
      expect(box === null || (box.width <= 1 && box.height <= 1)).toBe(true)
      await expect(block.getByText('Tap to copy')).toBeVisible()

      await pre.tap({ position: { x: 40, y: 40 } })
      await expect.poll(() => readClipboard(page)).toBe(BASH)
      await expect(block.getByText('Copied').locator('visible=true')).not.toHaveCount(0)

      // The multi-line JSON fence, through the real highlight-span pipeline.
      await page.locator('pre', { hasText: '"ok": true' }).tap({ position: { x: 40, y: 40 } })
      await expect.poll(() => readClipboard(page)).toBe(JSON_SRC)
    })
  })
})

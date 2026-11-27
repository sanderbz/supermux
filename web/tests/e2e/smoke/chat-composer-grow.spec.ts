// The composer grows with a long draft up to ~15 lines (bounded by the visible
// viewport), then scrolls INSIDE the field — and the transcript's newest message
// stays clear of it. It used to stop at 120px (~5 lines).
//
// Needs server/target/debug/supermux-server — `cd server && cargo build` first
// (debug; never --release).

import { expect, test, type Page } from '@playwright/test'

import { CHAT_BACKEND_ENV, chatSession, expectTokenOnce, primePage } from './chat-fixture'
import { startBackend, type Backend } from './harness'

const LINES = 30
const DRAFT = Array.from(
  { length: LINES },
  (_, i) => `${i + 1}. Notes for the migration: check the retry path, then the backoff.`,
).join('\n')

async function metrics(page: Page) {
  return page.evaluate(() => {
    const f = document.querySelector<HTMLElement>('[data-testid="chat-composer-field"]')!
    const cs = getComputedStyle(f)
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const rect = f.getBoundingClientRect()
    const last = [...document.querySelectorAll<HTMLElement>('[data-chat-anchor]')].pop()!
    return {
      height: rect.height,
      line,
      pad,
      lines: (rect.height - pad) / line,
      scrolls: f.scrollHeight > f.clientHeight + 1,
      vv: window.visualViewport?.height ?? window.innerHeight,
      // The newest message's bottom must sit above the composer's top edge.
      clearance: rect.top - last.getBoundingClientRect().bottom,
    }
  })
}

for (const phone of [false, true]) {
  test.describe(phone ? 'phone composer growth' : 'desktop composer growth', () => {
    test.use({
      viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      deviceScaleFactor: 2,
      hasTouch: phone,
      isMobile: phone,
    })

    let backend: Backend
    test.beforeEach(async () => {
      backend = await startBackend({ env: CHAT_BACKEND_ENV })
    })
    test.afterEach(async () => {
      await backend?.dispose()
    })

    test('a 30-line draft stops near 15 lines / the viewport share, scrolls inside, and clears the transcript', async ({
      page,
    }) => {
      test.setTimeout(180_000)
      const fx = await chatSession(backend, 'grow')
      fx.write('grow-conv', [
        ...Array.from({ length: 12 }, (_, i) => `Earlier message number ${i + 1} in this chat.`),
        'GROW-NEWEST-0001',
      ])
      await fx.hook('grow-conv')
      await primePage(page, backend)
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 900 })
      await page.goto(`${backend.baseUrl}/focus/${fx.name}`)
      await expect(page.getByTestId('chat-panel')).toBeVisible()
      await expectTokenOnce(page, 'GROW-NEWEST-0001')

      const field = page.getByTestId('chat-composer-field')
      await field.fill(DRAFT)
      await expect.poll(async () => (await metrics(page)).scrolls).toBe(true)
      await page.waitForTimeout(400) // the transcript reserve re-measures

      const m = await metrics(page)
      if (process.env.SHOTS) {
        await page.screenshot({
          path: `${process.env.SHOTS}/${phone ? 'phone' : 'desktop'}-${process.env.TAG ?? 'after'}.png`,
        })
      }
      // Bound = min(15 lines, 40% desktop / 30% coarse of the visible viewport),
      // floored at the old 120px.
      const share = phone ? 0.3 : 0.4
      const cap = Math.max(120, Math.min(15 * m.line + m.pad, m.vv * share))
      expect(m.height).toBeLessThanOrEqual(cap + 1)
      if (!phone) expect(m.lines).toBeGreaterThan(14) // desktop 900px: the 15-line bound wins
      expect(m.scrolls, 'beyond the cap the field scrolls inside').toBe(true)
      expect(m.clearance, 'newest message is not covered by the composer').toBeGreaterThanOrEqual(0)
      await expect(page.getByText('GROW-NEWEST-0001')).toBeInViewport()
    })
  })
}

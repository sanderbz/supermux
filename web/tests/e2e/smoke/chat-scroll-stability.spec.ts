import { test, expect, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'

let vite: ChildProcess, url: string
// No live server or agent involved. The fixture uses the shipped conversation
// and scroll hook; network arrival/height changes are controlled by the test.
test.beforeAll(async () => {
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()))
  url = `http://127.0.0.1:${port}`
  vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), stdio: 'ignore' })
  const until = Date.now() + 15_000
  while (Date.now() < until) { try { if ((await fetch(url)).ok) return } catch { /* starting */ } await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error('Isolated scroll fixture did not start')
})
test.afterAll(() => { vite?.kill('SIGTERM') })
async function action(page: Page, name: string, value?: unknown) {
  await page.evaluate(({ name, value }) => (window as unknown as { __chatScroll: Record<string, (value?: unknown) => void> }).__chatScroll[name](value), { name, value })
}
async function paint(page: Page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function bottom(page: Page) { return page.locator('[data-chat-track]').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight) }
async function anchor(page: Page) {
  return page.locator('[data-chat-track]').evaluate(el => {
    const top = el.getBoundingClientRect().top
    const row = [...el.querySelectorAll<HTMLElement>('[data-chat-anchor]')].find(row => row.getBoundingClientRect().bottom > top)
    if (!row) throw new Error('No visible transcript row')
    return { key: row.dataset.chatAnchor!, offset: row.getBoundingClientRect().top - top }
  })
}
async function expectAnchor(page: Page, saved: { key: string; offset: number }) {
  await expect.poll(() => page.locator('[data-chat-track]').evaluate((el, saved) => {
    const row = [...el.querySelectorAll<HTMLElement>('[data-chat-anchor]')].find(row => row.dataset.chatAnchor === saved.key)
    return row ? Math.abs(row.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.offset) : 9999
  }, saved)).toBeLessThan(2)
}
for (const phone of [false, true]) {
  test.describe(phone ? 'phone transcript' : 'desktop transcript', () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone })
    test('reader intent survives prepend, late reflow, viewport/keyboard changes, retention and jump', async ({ page }) => {
      await page.goto(url + '/dev/chat-live?mock&grok=1&scroll')
      await expect(page.locator('[data-chat-anchor]')).toHaveCount(41) //40messages +day divider
      await expect.poll(() => bottom(page)).toBeLessThan(2)
      // A no-op wheel down at bottom must not disable follow.
      await page.locator('[data-chat-track]').dispatchEvent('wheel', { deltaY: 200 }); await action(page, 'append')
      await expect.poll(() => bottom(page)).toBeLessThan(2)
      await page.locator('[data-chat-track]').evaluate(el => { el.scrollTop = 650 })
      await expect(page.getByTestId('chat-jump-bottom')).toBeVisible()
      await action(page, 'prepend')
      // The user keeps reading while the network request is in flight.
      await page.locator('[data-chat-track]').evaluate(el => { el.scrollTop = 750 })
      const read = await anchor(page); await action(page, 'append')
      await expectAnchor(page, read)
      await expect(page.locator('[data-chat-anchor]')).toHaveCount(53)
      await expectAnchor(page, read)
      await action(page, 'growEarlier')
      await expect(page.locator('[data-chat-anchor]').nth(1)).toContainText('Earlier content expanded.')
      await paint(page); await expectAnchor(page, read)
      // Native image load changes geometry without a React/network commit.
      await page.locator('[data-chat-anchor]').nth(1).evaluate(async row => {
        const image = new Image(); image.style.width = '100%'; image.style.height = '240px'; row.append(image)
        image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="744" height="240"><rect width="744" height="240" fill="#e7e9e1"/></svg>'); await image.decode()
      }); await paint(page); await expectAnchor(page, read)
      await action(page, 'resize', 540); await expectAnchor(page, read)
      await action(page, 'hidden', true); await action(page, 'append'); await action(page, 'hidden', false); await expectAnchor(page, read)
      await page.getByTestId('chat-jump-bottom').click(); await expect.poll(() => bottom(page)).toBeLessThan(2)
      // Child-only height changes, which never rerender the owning panel.
      await page.getByTestId('scroll-receipt').locator('summary').focus(); await page.keyboard.press('Space')
      await expect.poll(() => bottom(page)).toBeLessThan(2)
      await page.getByTestId('scroll-composer').fill('A growing draft that spans several lines and reserves more space.')
      await expect.poll(() => bottom(page)).toBeLessThan(2)
      await action(page, 'reset'); await expect(page.locator('[data-chat-anchor]')).toHaveCount(6)
      await expect(page.getByText(/Message 204\./)).toBeInViewport()
      await expect.poll(() => page.locator('[data-chat-track]').evaluate(el => el.clientHeight)).toBeGreaterThan(100)
      await expect.poll(() => bottom(page)).toBeLessThan(2)
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations().filter(animation => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))).map(animation => animation.finished.catch(() => {})))
      })
      await paint(page)
      await expect(page.getByText(/Message 204\./)).toHaveCSS('opacity', '1')
      await page.screenshot({ path: test.info().outputPath(phone ? 'chat-scroll-phone.png' : 'chat-scroll-desktop.png') })
    })
  })
}

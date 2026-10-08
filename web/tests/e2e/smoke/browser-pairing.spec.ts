import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'

let vite: ChildProcess, url: string
// No live server or agent involved. The fixture uses the shipped conversation
// and scroll hook; network arrival/height changes are controlled by the test.
test.beforeAll(async () => {
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = (socket.address() as { port: number }).port
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  url = `http://127.0.0.1:${port}`
  vite = spawn(
    process.execPath,
    [
      join(process.cwd(), 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: process.cwd(), stdio: 'ignore' },
  )
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Isolated pairing fixture did not start')
})
test.afterAll(() => {
  vite?.kill('SIGTERM')
})

for (const phone of [false, true]) {
  test.describe(
    phone ? 'phone browser pairing' : 'desktop browser pairing',
    () => {
      test.use({
        viewport: phone
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
        hasTouch: phone,
        isMobile: phone,
      })
      test('same installation across companies; code pairs current website to selected agent; errors stay actionable', async ({
        page,
      }) => {
        const claims: Array<{ url: string; body: unknown }> = []
        await page.route('**/api/sessions/*/browser-*', async (route) => {
          if (route.request().method() === 'POST') {
            claims.push({
              url: route.request().url(),
              body: route.request().postDataJSON(),
            })
            await route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: false,
                error:
                  'conflict: agent workspace is outside its company isolation root',
              }),
            })
          } else
            await route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({ ok: true, data: [] }),
            })
        })
        await page.goto(url + '/dev/chat-live?mock&grok=1&pairing')
        const card = page.getByTestId('browser-feedback-card')
        await expect(card).toBeVisible()
        await expect(card).toContainText(
          'Install once. Reuse the same extension across agents and companies you can access.',
        )
        await expect(card).toContainText('Pair a website with Research')
        await expect(card).toContainText(
          'Open Supermux on the website you want to connect.',
        )
        const download = page.getByTestId('browser-extension-download')
        const originalDownload = await download.getAttribute('href')
        expect(originalDownload).toBe(
          '/downloads/supermux-browser-extension.zip',
        )
        await page
          .getByRole('button', { name: 'Switch fixture company' })
          .click()
        await expect(card).toContainText('Pair a website with Design')
        await expect(download).toHaveAttribute('href', originalDownload!)
        await page.getByTestId('browser-pair-code').fill('4555')
        await card.getByRole('button', { name: 'Pair', exact: true }).click()
        await expect(card.getByRole('alert')).toContainText(
          'Ask an administrator to check its workspace access.',
        )
        await expect(card.getByRole('alert')).toContainText(
          'You don’t need a separate extension.',
        )
        await expect(card.getByRole('alert')).not.toContainText(
          'isolation root',
        )
        await expect(page.getByTestId('browser-pair-code')).toHaveValue('4555')
        expect(claims).toHaveLength(1)
        expect(claims[0].url).toContain(
          '/api/sessions/second-agent/browser-pairings',
        )
        expect(claims[0].body).toEqual({ code: '4555' })
        await expect(download).toHaveAttribute('href', originalDownload!)
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true)
        await page.evaluate(async () => {
          await document.fonts.ready
          await Promise.all(
            document
              .getAnimations()
              .filter((a) =>
                Number.isFinite(Number(a.effect?.getComputedTiming().endTime)),
              )
              .map((a) => a.finished.catch(() => {})),
          )
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          )
        })
        await page.screenshot({
          path: test.info().outputPath('browser-pairing.png'),
          fullPage: true,
        })
      })
    },
  )
}

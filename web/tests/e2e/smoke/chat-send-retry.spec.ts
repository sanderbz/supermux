import { test, expect, type Page } from '@playwright/test'
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
  throw new Error('Isolated retry fixture did not start')
})
test.afterAll(() => {
  vite?.kill('SIGTERM')
})

async function fixture(page: Page, name: string, value?: unknown) {
  await page.waitForFunction(() => '__chatRetry' in window)
  return page.evaluate(
    ({ name, value }) =>
      (
        window as unknown as {
          __chatRetry: Record<string, (value?: unknown) => unknown>
        }
      ).__chatRetry[name](value),
    { name, value },
  )
}
async function draft(page: Page) {
  return page
    .getByTestId('chat-composer-field')
    .evaluate((el) =>
      el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? ''),
    )
}
async function failed(page: Page, text = 'Saved question') {
  await page.goto(url + '/dev/chat-live?mock&grok=1&retry')
  await page.getByTestId('chat-composer-field').fill(text)
  await page.getByTestId('chat-send').click()
  await expect(page.getByTestId('chat-pending')).toHaveCount(1)
  await expect(page.getByTestId('chat-pending')).toHaveAttribute(
    'data-state',
    'undelivered',
  )
  await expect(page.getByTestId('chat-pending-retry')).toBeVisible()
  await expect(page.getByTestId('chat-pending')).toContainText(
    'Finish or clear the draft in Terminal, then retry.',
  )
  await expect(page.getByTestId('chat-pending')).not.toContainText('conflict:')
  await expect.poll(() => draft(page)).toBe(text)
}
for (const phone of [false, true]) {
  test.describe(phone ? 'phone send recovery' : 'desktop send recovery', () => {
    test.use({
      viewport: phone
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      hasTouch: phone,
      isMobile: phone,
    })
    test('Retry sends the saved message once, clears matching draft, preserves new edits', async ({
      page,
    }) => {
      await failed(page)
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter((a) =>
              Number.isFinite(Number(a.effect?.getComputedTiming().endTime)),
            )
            .map((a) => a.finished.catch(() => {})),
        )
      })
      await page.screenshot({
        path: test.info().outputPath('retry-refused.png'),
      })
      await page.getByTestId('chat-pending-retry').click()
      await expect.poll(() => fixture(page, 'requests')).toHaveLength(2)
      await fixture(page, 'accept')
      await expect.poll(() => draft(page)).toBe('')
      await expect(page.getByTestId('chat-pending')).toHaveCount(1)
      await expect(page.getByTestId('chat-pending')).toHaveAttribute(
        'data-state',
        'unconfirmed',
      )
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter((a) =>
              Number.isFinite(Number(a.effect?.getComputedTiming().endTime)),
            )
            .map((a) => a.finished.catch(() => {})),
        )
      })
      await page.screenshot({
        path: test.info().outputPath('retry-recovered.png'),
      })
      const requests = (await fixture(page, 'requests')) as Array<{
        text: string
        send_id: string
      }>
      expect(requests[1]).toEqual(requests[0])
      // A separate refused message can be recovered without erasing the next draft.
      await failed(page, 'Second saved question')
      await page.getByTestId('chat-pending-retry').click()
      await expect.poll(() => fixture(page, 'requests')).toHaveLength(2)
      await page
        .getByTestId('chat-composer-field')
        .fill('An edited next question ')
      await fixture(page, 'accept')
      await expect.poll(() => draft(page)).toBe('An edited next question ')
      await expect(page.getByTestId('chat-pending')).toHaveCount(1)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true)
    })
    test('unchanged Send recovers the original failed row and delivery key', async ({
      page,
    }) => {
      await failed(page)
      await page.getByTestId('chat-send').click()
      await expect.poll(() => fixture(page, 'requests')).toHaveLength(2)
      await expect(page.getByTestId('chat-pending')).toHaveCount(1)
      const requests = (await fixture(page, 'requests')) as Array<{
        text: string
        send_id: string
      }>
      expect(requests[1]).toEqual(requests[0])
      await fixture(page, 'accept')
      await expect.poll(() => draft(page)).toBe('')
      await expect(page.getByTestId('chat-pending')).toHaveAttribute(
        'data-state',
        'unconfirmed',
      )
    })
    test('attachment-only Retry clears original chips and retains a new pending upload', async ({
      page,
    }) => {
      for (const addNew of [false, true]) {
        await page.goto(url + '/dev/chat-live?mock&grok=1&retry')
        await fixture(page, 'attach')
        await expect(
          page.getByText('saved-image.png', { exact: true }),
        ).toBeVisible()
        await page.getByTestId('chat-send').click()
        await expect(page.getByTestId('chat-pending-retry')).toBeVisible()
        await page.getByTestId('chat-pending-retry').click()
        await expect.poll(() => fixture(page, 'requests')).toHaveLength(2)
        if (addNew) {
          await fixture(page, 'attach', true)
          await expect(
            page.getByText('new-upload.png', { exact: true }),
          ).toBeVisible()
        }
        await fixture(page, 'accept')
        await expect(page.getByTestId('chat-pending')).toHaveAttribute(
          'data-state',
          'unconfirmed',
        )
        if (addNew)
          await expect(
            page.getByText('new-upload.png', { exact: true }),
          ).toBeVisible()
        else
          await expect(
            page.getByText('saved-image.png', { exact: true }),
          ).toHaveCount(0)
        const requests = (await fixture(page, 'requests')) as Array<{
          text: string
          send_id: string
        }>
        expect(requests[1]).toEqual(requests[0])
        expect(requests[0].text).toBe('"/fixture/saved-image.png" ')
      }
    })
  })
}

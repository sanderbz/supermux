import { test, expect, type WebSocketRoute } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'

let vite: ChildProcess, url: string
// Controlled transport only. Production hook, backlog, conversation and poll;
// no backend or real agent runs.
test.beforeAll(async () => {
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = (socket.address() as { port: number }).port
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  url = `http://127.0.0.1:${port}`
  vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), stdio: 'ignore' })
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Isolated reload fixture did not start')
})
test.afterAll(() => vite?.kill('SIGTERM'))

function sendSeed(ws: WebSocketRoute) {
  const at = Date.now() - 180_000
  const entry = (seq: number, kind: string, body: unknown, extra = {}) => ({
    seq, uuid: `entry-${seq}`, kind, body, offset: seq * 100,
    ts_ms: at + seq, oversize: false, truncated: false, ...extra,
  })
  ws.send(JSON.stringify({ type: 'seed', conversation_id: 'reload-source', source_epoch: 'fixture', source_generation: 1, has_more: false, next_before: null, entries: [
    entry(1, 'prompt', { text: 'Confirmed user question' }),
    entry(2, 'assistant', { text: 'Confirmed assistant answer' }),
    entry(3, 'tool_use', { input: { command: 'fixture-check --saved-output' } }, { label: 'shell', tool_use_id: 'tool-1' }),
    entry(4, 'tool_result', { content: 'Saved tool output: ' + 'fixture details '.repeat(60) }, { tool_use_id: 'tool-1', ok: true }),
  ] }))
  ws.send(JSON.stringify({ type: 'seed_done', high_water: 5, state: 'live', resync_epoch: 0 }))
}

for (const phone of [false, true]) {
  test.describe(phone ? 'phone source reload' : 'desktop source reload', () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone })
    test('quiet healthy reload preserves confirmed chat and expanded tool; an outage retains qualified evidence', async ({ page }) => {
      let socket: WebSocketRoute | null = null
      let connections = 0, peeks = 0
      await page.route((target) => target.pathname.startsWith('/api/'), (route) => {
        const peek = new URL(route.request().url()).pathname.endsWith('/peek')
        if (peek) peeks++
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: peek ? [
          '• Outage evidence is still arriving.', '', '› Ask Codex to do anything', '',
          '  GPT-6.1-Sol high · ~/projects/workspace · Main', '  [default] · ← for agen', '  ts',
        ].join('\n') : [] }) })
      })
      await page.routeWebSocket('**/ws/sessions/reload-fixture/chat', (ws) => {
        socket = ws
        ws.onMessage((message) => {
          if (JSON.parse(String(message)).type !== 'auth') return
          connections++
          ws.send(JSON.stringify({ type: 'auth_ok' }))
          if (connections > 1) sendSeed(ws)
        })
      })
      await page.goto(url + '/dev/chat-live?mock&grok=1&reload')
      await expect.poll(() => connections).toBe(1)
      await expect(page.getByTestId('reload-source-state')).toHaveText('connecting:false')
      await page.waitForTimeout(500)
      expect(peeks).toBe(0)
      sendSeed(socket!)
      await expect(page.getByTestId('reload-source-state')).toHaveText('live:true')
      await expect(page.getByText('Confirmed user question', { exact: true })).toBeVisible()
      await expect(page.getByText('Confirmed assistant answer', { exact: true })).toBeVisible()
      await expect(page.getByTestId('chat-working-row')).toBeVisible()
      const receipt = page.getByTestId('chat-receipt').first()
      await receipt.click()
      await expect(receipt).toHaveAttribute('aria-expanded', 'true')
      await page.waitForTimeout(1_100)
      await expect(receipt).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByTestId('chat-provisional-tail')).toHaveCount(0)
      expect(peeks).toBe(0)
      await page.reload()
      await expect.poll(() => connections).toBe(2)
      await expect(page.getByTestId('reload-source-state')).toHaveText('live:true')
      await expect(page.getByText('Confirmed user question', { exact: true })).toBeVisible()
      await expect(page.getByText('Confirmed assistant answer', { exact: true })).toBeVisible()
      await expect(page.getByTestId('chat-working-row')).toBeVisible()
      await expect(page.getByTestId('chat-provisional-tail')).toHaveCount(0)
      expect(peeks).toBe(0)
      socket!.send(JSON.stringify({ type: 'state', state: 'reconnecting', reason: 'fixture source unavailable', resync_epoch: 0 }))
      await expect(page.getByTestId('chat-provisional-tail')).toBeVisible()
      await expect(page.getByText('• Outage evidence is still arriving.', { exact: true })).toBeVisible()
      await expect(page.getByText('Confirmed assistant answer', { exact: true })).toBeVisible()
      await expect(page.getByTestId('chat-working-row')).toBeVisible()
      await expect(page.locator('body')).not.toContainText('Ask Codex to do anything')
      await expect(page.locator('body')).not.toContainText('GPT-6.1-Sol high')
      await page.screenshot({ path: test.info().outputPath('qualified-source-outage.png') })
      socket!.send(JSON.stringify({ type: 'state', state: 'live', resync_epoch: 0 }))
      await expect(page.getByTestId('chat-provisional-tail')).toHaveCount(0)
      await expect(page.getByText('Confirmed assistant answer', { exact: true })).toBeVisible()
    })
  })
}

// Fase A6 T3.5 — the terminal end of the data plane: a stopped session, and
// the server's 4404 refusal.
//
// TWO THINGS, because they are the two halves of one contract.
//
// 1. THE HANDOVER. "A stopped session is never chat" is a seam rule
//    (`desktop-split.tsx:354`), and it is the one place where the right answer
//    is to take the chat surface AWAY rather than to annotate it: there is no
//    pty to type into, so a composable-looking chat would be a lie a chip
//    cannot fix. What must NOT happen is the socket outliving the surface —
//    a redial loop against a session that is never coming back is exactly the
//    storm the close-code table exists to prevent. So this asserts both: the
//    stopped surface arrives, AND the chat socket closes once and stays closed.
//
// 2. THE 4404. `CLOSE_NOT_RUNNING` is the server saying this session has no
//    chat data plane at all — gone, codex, remote, a real team lead — and the
//    client's rule is that it is TERMINAL: `conn = 'offline'`, no retry
//    (`chat-socket.ts:373-381`). The unit tests drive that through a fake
//    socket; nothing had ever checked that the server actually sends 4404 to a
//    browser. This dials the real endpoint from the page, with the real
//    first-frame auth handshake, and reads the code off the wire.
//
// One browser context, one test (`playwright.config.ts:35-46`). The THIRD
// half of the same contract — a holder that CRASHED rather than being stopped,
// which reaches the surface by a different signal entirely — is
// `chat-ws-holder-death-handover.spec.ts`, in its own file for the same reason.

import { expect, test } from '@playwright/test'

import {
  chatSession,
  countSockets,
  expectTokenOnce,
  primePage,
  socketCounts,
} from './chat-fixture'
import { api, startBackend, type Backend } from './harness'

const CONV = 'a6t3-stopped-a'
const tok = (n: number) => `A6T3STOPPED-${String(n).padStart(4, '0')}`

test.describe('chat WS — the stopped session and the 4404 refusal (A6 T3.5)', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('hands over to the stopped surface without leaving a socket dialling', async ({ page }) => {
    test.setTimeout(240_000)

    const fx = await chatSession(backend, 'a6t3-stopped')
    fx.write(CONV, [tok(1), tok(2)])
    await fx.hook(CONV)

    // An ineligible session for the 4404 half. `shell` is refused by
    // `chat_eligible` server-side and by `chatEligible` client-side, so the
    // socket is the only way to ask the question.
    expect([200, 201]).toContain(
      (await api(backend).createSession({ name: 'a6t3-noplane', provider: 'shell', dir: backend.dataDir }))
        .status,
    )

    await primePage(page, backend)
    await countSockets(page)
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`)

    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expectTokenOnce(page, tok(2))
    await expect(page.getByTestId('chat-composer-field')).toBeVisible()

    // ── stop it ─────────────────────────────────────────────────────────────
    const stopped = await fetch(`${backend.backendUrl}/api/sessions/${fx.name}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(stopped.ok).toBeTruthy()

    // The surface hands over. `brand/copy.ts:64` owns this sentence.
    await expect(page.getByText('This session is stopped')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    await expect(page.getByTestId('chat-composer-field')).toHaveCount(0)

    // …and the data plane went with it: every socket the page ever opened is
    // closed, and no new one is dialled while nobody is watching. A stopped
    // session would otherwise be re-dialled on the backoff schedule forever.
    const atStop = await socketCounts(page)
    expect(atStop.closed, 'the chat socket must be disposed with its surface').toBe(atStop.opened)
    await page.waitForTimeout(15_000)
    const later = await socketCounts(page)
    expect(later.opened, 'no redial may outlive the surface').toBe(atStop.opened)
    expect(later.closed).toBe(atStop.closed)

    // ── the 4404, off the real wire ─────────────────────────────────────────
    // Full handshake: connect token-less, send `auth` as the FIRST frame, then
    // read the close. The refusal is deliberately AFTER auth — whether a
    // session exists but is ineligible is not information an unauthenticated
    // caller is owed (`ws.rs:665-681`).
    const refusal = await page.evaluate(
      ({ name, token }: { name: string; token: string }) =>
        new Promise<{ code: number; sawAuthOk: boolean }>((resolve) => {
          const proto = location.protocol === 'https:' ? 'wss' : 'ws'
          const sock = new WebSocket(`${proto}://${location.host}/ws/sessions/${name}/chat`)
          let sawAuthOk = false
          sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', token }))
          sock.onmessage = (e: MessageEvent) => {
            if (String(e.data).includes('auth_ok')) sawAuthOk = true
          }
          sock.onclose = (e: CloseEvent) => resolve({ code: e.code, sawAuthOk })
          setTimeout(() => resolve({ code: -1, sawAuthOk }), 15_000)
        }),
      { name: 'a6t3-noplane', token: backend.token },
    )
    expect(refusal.sawAuthOk, 'the refusal comes after auth, not instead of it').toBe(true)
    expect(refusal.code, 'a session with no chat data plane must close 4404, terminally').toBe(4404)
  })
})

// Fase A6 T3.4 — the conversation moves under an open socket.
//
// WHAT THIS PROVES. A `/clear`, a terminal-side `--resume` or a Claude restart
// all do the same thing: the session keeps its name and its pane, and starts
// writing a DIFFERENT transcript file. The server refuses to guess about it —
// it never adopts a file it merely noticed (`tailer.rs:50`) — so the one
// authoritative signal is the hook-carried `session_id`, which is exactly what
// this spec sends.
//
// What must happen on the client is total replacement, and the sharp edge is
// the BACKLOG: pages the reader scrolled back into belong to the OLD
// conversation, are addressed by a cursor keyed on the old conversation id, and
// would splice two different conversations into one scrollback if they
// survived. `use-chat-backlog.ts:136` keys its whole store on the socket's
// resync generation for that reason, and this is the integration proof:
//
//   · a conversation long enough to have a real backlog (>500 entries, so the
//     server's ring itself does not hold the start of the file);
//   · a page of it actually loaded, from the real REST backlog route;
//   · the pointer moved through the real hook endpoint;
//   · then: not one byte of the old conversation left on screen — neither the
//     seed's entries nor the paged-in ones — and the new one fully seeded.
//
// One browser context, one test (`playwright.config.ts:35-46`).

import { expect, test } from '@playwright/test'

import {
  CHAT_BACKEND_ENV,
  chatSession,
  connectionState,
  expectTokenOnce,
  loadOlderPage,
  primePage,
  tokenCount,
} from './chat-fixture'
import { startBackend, type Backend } from './harness'

const CONV_A = 'a6t3-epoch-a'
const CONV_B = 'a6t3-epoch-b'
// Past the server's 500-entry ring, so the seed cannot contain the start of the
// file and `has_more` is true for a real reason rather than a contrived cursor.
const A_COUNT = 520
const a = (n: number) => `A6T3EPOCHA-${String(n).padStart(4, '0')}`
const b = (n: number) => `A6T3EPOCHB-${String(n).padStart(4, '0')}`

test.describe('chat WS — a conversation change under an open socket (A6 T3.4)', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({ env: CHAT_BACKEND_ENV })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('the fresh seed replaces the conversation, and the backlog goes with it', async ({
    page,
  }) => {
    test.setTimeout(240_000)

    const fx = await chatSession(backend, 'a6t3-epoch')
    fx.write(
      CONV_A,
      Array.from({ length: A_COUNT }, (_, i) => a(i + 1)),
    )
    await fx.hook(CONV_A)

    await primePage(page, backend)
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`)

    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expectTokenOnce(page, a(A_COUNT), 40_000)
    await expect.poll(() => connectionState(page), { timeout: 30_000 }).toBe('live')

    // The newest 500 are the server's window; anything older is on disk behind
    // the backlog cursor, which is what makes the control appear at all.
    expect(await tokenCount(page, a(A_COUNT - 400))).toBe(1)
    expect(await tokenCount(page, a(1)), 'the start of the file is BELOW the window').toBe(0)

    await expect(page.getByTestId('chat-load-older')).toBeVisible()
    await loadOlderPage(page)
    await expect
      .poll(() => tokenCount(page, a(20)), { timeout: 30_000, message: 'a real backlog page' })
      .toBe(1)

    // ── the conversation moves ──────────────────────────────────────────────
    fx.write(CONV_B, [b(1), b(2), b(3)])
    await fx.hook(CONV_B)

    await expectTokenOnce(page, b(1), 60_000)
    await expectTokenOnce(page, b(2))
    await expectTokenOnce(page, b(3))

    // Total replacement. The seed's entries AND the page the reader had
    // scrolled back into are both gone — two conversations spliced into one
    // scrollback is the failure this epoch exists to make impossible.
    expect(await tokenCount(page, a(A_COUNT)), 'the old window must be gone').toBe(0)
    expect(await tokenCount(page, a(20)), 'the paged-in backlog must go with it').toBe(0)
    expect(await tokenCount(page, a(A_COUNT - 400))).toBe(0)

    // …and the affordance re-derives from the NEW seed: a three-entry
    // conversation has nothing below it, so there is nothing to offer.
    await expect(page.getByTestId('chat-load-older')).toHaveCount(0)

    // The socket is still the live plane for the new conversation, not merely
    // re-seeded once.
    expect(await connectionState(page)).toBe('live')
    fx.append(CONV_B, [b(4)])
    await expectTokenOnce(page, b(4))
  })
})

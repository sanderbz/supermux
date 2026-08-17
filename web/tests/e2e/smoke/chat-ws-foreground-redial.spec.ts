// Fase A6 T3.3 — background past the attempt cap, then a foreground redial.
//
// THE FAILURE THIS SPEC EXISTS FOR is the one A6 called the single highest-value
// fix in the fase, and it was permanent: `chat-socket.ts` had no
// `visibilitychange` handler while every other live surface in the app did
// (`use-live-term.ts`, `use-sse.ts`, `use-peek-lens.ts`, `use-peek-prewarm.ts`).
// A phone backgrounded past the 8-attempt ceiling lands in `offline` — and
// because the store only disposes when the LAST subscriber leaves
// (`use-chat-ws.ts:183-193`), a backgrounded-but-MOUNTED panel never redialled.
// The user came back to a dead panel that could not heal until they navigated
// away.
//
// So the spec drives the whole shape, against a real backend:
//   · kill the server and let the dialler burn its ENTIRE budget — eight
//     attempts, 300 ms doubling to 30 s with ±20 % jitter, ~68 s of real time.
//     Reaching `offline` is the precondition; short-circuiting it would test
//     nothing;
//   · background the page;
//   · bring the server back and let it produce entries nobody is listening for;
//   · foreground the page — and assert the socket comes back BY ITSELF, with a
//     fresh attempt budget (`chat-socket.ts:239-256`), and that the gap is
//     filled by the fresh seed.
//
// The socket counter is what makes "it gave up" and "it came back" observable
// as facts rather than as inferences from the chip.
//
// One browser context, one test (`playwright.config.ts:35-46`).

import { expect, test } from '@playwright/test'

import {
  CHAT_BACKEND_ENV,
  chatSession,
  connectionState,
  countSockets,
  expectTokenOnce,
  primePage,
  setVisibility,
  socketCounts,
  tokenCount,
} from './chat-fixture'
import { startBackend, type Backend } from './harness'

const CONV = 'a6t3-redial-a'
const tok = (n: number) => `A6T3REDIAL-${String(n).padStart(4, '0')}`

test.describe('chat WS — the foreground redial (A6 T3.3)', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({ env: CHAT_BACKEND_ENV })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('a page that gave up while backgrounded reconnects when it comes forward', async ({
    page,
  }) => {
    test.setTimeout(420_000)

    const fx = await chatSession(backend, 'a6t3-redial')
    fx.write(CONV, [tok(1), tok(2)])
    await fx.hook(CONV)

    await primePage(page, backend)
    await countSockets(page)
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`)

    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expectTokenOnce(page, tok(2))
    await expect.poll(() => connectionState(page), { timeout: 30_000 }).toBe('live')
    const atSeed = await socketCounts(page)

    // ── burn the whole budget ───────────────────────────────────────────────
    await backend.killBackend()
    await expect.poll(() => connectionState(page), { timeout: 30_000 }).toBe('reconnecting')
    await expect
      .poll(() => connectionState(page), {
        // Generous, because this is REAL backoff on a shared box: eight
        // attempts of 300 ms doubling to 30 s with ±20 % jitter is ~68 s of
        // wall clock at best. The assertion is that the loop ENDS, and ends
        // bounded — not that it ends by a stopwatch.
        timeout: 240_000,
        intervals: [2_000],
        message: 'eight attempts of jittered backoff must end in offline, not in a retry storm',
      })
      .toBe('offline')

    // The dialler really did stop, and it stopped after a BOUNDED number of
    // attempts. `MAX_ATTEMPTS` is 8; the count is asserted as a ceiling because
    // the timing of the last attempt against the poll is not deterministic.
    const atOffline = await socketCounts(page)
    const attempts = atOffline.opened - atSeed.opened
    expect(attempts, 'the redial loop must be bounded').toBeLessThanOrEqual(8)
    expect(attempts, 'the loop must actually have tried').toBeGreaterThan(0)

    // The offline chip is the one state that offers a way out — waiting will
    // not help, so it is a button (`connection-note.tsx:51`).
    const chip = page.locator('[data-vr="chat-connection"]').first()
    await expect(chip).toBeVisible()
    await expect(chip).toHaveText(/Offline/i)

    // ── background, and let the world move on without us ────────────────────
    await setVisibility(page, 'hidden')

    await backend.restartBackend()
    fx.append(CONV, [tok(3), tok(4)])
    await fx.hook(CONV)

    // Still nothing. A backgrounded panel that has given up stays given up —
    // this is the exact state the old code could never leave.
    await page.waitForTimeout(5_000)
    expect(await socketCounts(page)).toEqual(atOffline)
    expect(await connectionState(page)).toBe('offline')
    expect(await tokenCount(page, tok(3)), 'nothing may arrive while the socket is dead').toBe(0)

    // ── forward ─────────────────────────────────────────────────────────────
    await setVisibility(page, 'visible')

    await expect
      .poll(() => connectionState(page), { timeout: 120_000, intervals: [500] })
      .toBe('live')
    expect(
      (await socketCounts(page)).opened,
      'coming forward must dial, with the burnt budget forgiven',
    ).toBeGreaterThan(atOffline.opened)

    // The gap is filled by the fresh seed, not by a replay: both entries
    // written while nobody was listening are on screen, exactly once.
    await expectTokenOnce(page, tok(3))
    await expectTokenOnce(page, tok(4))
    await expectTokenOnce(page, tok(1))
    await expectTokenOnce(page, tok(2))

    // …and the socket is a working one, not merely an open one.
    fx.append(CONV, [tok(5)])
    await expectTokenOnce(page, tok(5))
  })
})

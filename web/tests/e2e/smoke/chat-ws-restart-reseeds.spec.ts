// Fase A6 T3.1 — a server restart mid-stream, against a real backend.
//
// WHAT THIS PROVES, and why a unit test could not. A6's honesty layer is
// covered by 21 unit tests through a fake socket; what no test covered is the
// thing the mechanism exists for — a backend that really dies while a chat is
// attached. This spec kills the process with the transcript still growing and
// asserts the four properties T3.1 names:
//
//   (a) the surface entered `reconnecting` VISIBLY — the chip is rendered, and
//       `live` renders nothing, so the two states are not pixel-identical the
//       way they were before A6;
//   (b) it returned to `live` — and NOT before the server said so. A restarted
//       server has an empty `hooks_live` map, so `classify_pointer` reports
//       `Reconnecting { "no hook since start" }` even though the socket is
//       perfectly healthy. The chip stays up until a real hook lands. That is
//       the honesty mechanism working, not a flake;
//   (c) no duplicate and no missing entry — every token exactly once, including
//       the two written while the backend was DEAD, which only the fresh seed
//       can deliver (`chat-socket.ts:19-23`, `:229`);
//   (d) the composer was honest throughout — a send that the server ACKED
//       before the kill stays `unconfirmed` and is never escalated to
//       `undelivered`, because the watchdog measures echo arrival over the very
//       socket that is down (A6 T2.5, `pending.ts:382-397`).
//
// One browser context, one test: chromium runs `--single-process` on this host
// (`playwright.config.ts:35-46`) and dies on a second context.

import { expect, test } from '@playwright/test'

import {
  chatSession,
  connectionState,
  countSockets,
  expectTokenOnce,
  primePage,
  socketCounts,
  tokenCount,
} from './chat-fixture'
import { startBackend, type Backend } from './harness'

const CONV = 'a6t3-restart-a'
const tok = (n: number) => `A6T3RESTART-${String(n).padStart(4, '0')}`

test.describe('chat WS — a server restart mid-stream (A6 T3.1)', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('reconnects visibly, re-seeds the gap, and duplicates nothing', async ({ page }) => {
    test.setTimeout(300_000)

    const fx = await chatSession(backend, 'a6t3-restart')
    fx.write(CONV, [tok(1), tok(2), tok(3), tok(4), tok(5)])
    await fx.hook(CONV)

    await primePage(page, backend)
    await countSockets(page)
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`)

    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expectTokenOnce(page, tok(1))
    for (const n of [2, 3, 4, 5]) expect(await tokenCount(page, tok(n))).toBe(1)

    // The healthy state costs no pixels — the chip is deliberately absent while
    // `live`, or an always-on "Live" badge becomes wallpaper within a day
    // (`connection-note.tsx:32`).
    await expect.poll(() => connectionState(page), { timeout: 30_000 }).toBe('live')
    const atSeed = await socketCounts(page)

    // The live path works before we break it, or the assertions below would
    // pass against a surface that was never streaming.
    fx.append(CONV, [tok(6)])
    await expectTokenOnce(page, tok(6))

    // A send the server ACKNOWLEDGED. `POST /send` is an independent REST path;
    // its receipt is what makes the row `unconfirmed` rather than `sending`,
    // and only an `unconfirmed` row can be falsely escalated later.
    await page.getByTestId('chat-composer-field').click()
    await page.getByTestId('chat-composer-field').fill('a6t3 hello')
    await page.getByTestId('chat-composer-field').press('Enter')
    await expect(page.getByTestId('chat-pending')).toHaveAttribute('data-state', 'unconfirmed', {
      timeout: 20_000,
    })

    // ── the kill ────────────────────────────────────────────────────────────
    await backend.killBackend()

    // (a) visibly reconnecting. The chip carries the state as data AND as copy;
    // asserting both is what distinguishes "the state changed" from "the user
    // can see that it changed".
    await expect.poll(() => connectionState(page), { timeout: 30_000 }).toBe('reconnecting')
    const chip = page.locator('[data-vr="chat-connection"]').first()
    await expect(chip).toBeVisible()
    await expect(chip).toHaveText(/Reconnecting/i)

    // The transcript STAYS. The server's own contract (`tailer.rs:153`) is that
    // a reconnect never blanks what is on screen — it only stops being a claim
    // about now.
    expect(await tokenCount(page, tok(6))).toBe(1)

    // (d) the watchdog does not manufacture a false failure out of a silence it
    // caused itself. `WATCHDOG_MS` is 5 s; this window is well past two of them.
    await page.waitForTimeout(12_000)
    await expect(page.getByTestId('chat-pending')).toHaveAttribute('data-state', 'unconfirmed')

    // Two entries land while nothing is listening. Only a full re-seed can
    // deliver them, which is exactly what a reconnect is by construction.
    fx.append(CONV, [tok(7), tok(8)])

    // ── the restart (same port, same data dir) ──────────────────────────────
    await backend.restartBackend()

    // (c) the gap is filled and nothing is doubled.
    await expectTokenOnce(page, tok(7), 60_000)
    await expectTokenOnce(page, tok(8), 30_000)
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(await tokenCount(page, tok(n)), `${tok(n)} must survive the re-seed exactly once`).toBe(1)
    }

    // (b) …and it is still NOT claiming to be current, because the restarted
    // server has no proof the conversation pointer is the live one: `hooks_live`
    // is in-memory and a restart empties it, which `classify_pointer` reads as
    // `Reconnecting { "no hook since start" }` inside the boot window and as
    // `NoHooks` past it (`tailer.rs:205-224`). Both are honest and which one is
    // showing is a function of how long the restart took, so the assertion is
    // the thing that matters: the surface has stopped claiming to be current.
    // The chip is telling the truth about the SERVER, not about the socket —
    // which is precisely the state that rendered identically to `live` before A6.
    expect(
      ['reconnecting', 'stale'],
      'a restarted server has not proved its conversation pointer',
    ).toContain(await connectionState(page))

    // The one signal that can prove the pointer — the same hook a real Claude
    // fires on every prompt — and the chip goes away.
    await fx.hook(CONV)
    await expect.poll(() => connectionState(page), { timeout: 30_000 }).toBe('live')

    // The live path is live again, on the same socket generation.
    fx.append(CONV, [tok(9)])
    await expectTokenOnce(page, tok(9))

    // The redial really was a redial, and not a socket that somehow survived a
    // process death: sockets were opened AFTER the seed baseline.
    const counts = await socketCounts(page)
    expect(counts.opened, 'the socket must have been re-dialled').toBeGreaterThan(atSeed.opened)
  })
})

// Fase A6 T3.2 — the staleness ceiling, with the socket still open.
//
// WHAT THIS PROVES. Every other failure the honesty layer handles announces
// itself: a socket closes, a tailer stops, a close code arrives. The ceiling
// covers the one that does not — a socket that is open, authenticated and
// SILENT. Before A6 no timestamp was tracked anywhere in the socket layer, so a
// conversation that had not moved in an hour still read as `live`.
//
// The number is 90 s and it is a measurement, not a guess: A0 clocked a
// text-only transcript entry at p50 31.4 s and max 32.8 s, so the ceiling sits
// at ~2.7x the worst healthy silence (`connection.ts:41-53`). This spec is the
// integration half of that: a REAL tailer, sitting on a real transcript that
// nobody is writing to, must flip the surface to `stale` — and must do it
// WITHOUT the socket dropping, or the test would be re-proving T3.1.
//
// The socket counter is what makes that distinguishable from the outside.
//
// One browser context, one test (`playwright.config.ts:35-46`).

import { expect, test } from '@playwright/test'

import {
  chatSession,
  connectionState,
  countSockets,
  expectTokenOnce,
  primePage,
  socketCounts,
} from './chat-fixture'
import { startBackend, type Backend } from './harness'

const CONV = 'a6t3-stale-a'
const tok = (n: number) => `A6T3STALE-${String(n).padStart(4, '0')}`

test.describe('chat WS — the staleness ceiling (A6 T3.2)', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('goes stale past the ceiling without the socket ever dropping', async ({ page }) => {
    test.setTimeout(420_000)

    const fx = await chatSession(backend, 'a6t3-stale')
    fx.write(CONV, [tok(1), tok(2), tok(3)])
    await fx.hook(CONV)

    await primePage(page, backend)
    await countSockets(page)
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`)

    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expectTokenOnce(page, tok(3))
    await expect.poll(() => connectionState(page), { timeout: 30_000 }).toBe('live')

    // The baseline is taken AFTER the seed on purpose: React StrictMode dials,
    // disposes and re-dials on mount, so the interesting number is not "how
    // many sockets ever existed" but "did anything happen to the socket during
    // the silent window".
    const atSeed = await socketCounts(page)
    const t0 = Date.now()

    // Nothing is written for the length of the ceiling. The clock the surface
    // measures against is bucketed to 30 s (`chat-panel.tsx:188`), so the flip
    // is due between 90 s and 120 s after the last authoritative frame.
    await expect
      .poll(() => connectionState(page), {
        timeout: 300_000,
        intervals: [5_000],
        message: 'a socket that has been silent past the ceiling must stop claiming live',
      })
      .toBe('stale')

    const elapsed = Date.now() - t0
    // The ceiling is 90 s and the surface's clock is bucketed to 30 s, so the
    // flip lands in [90 s, 120 s] plus the poll's own granularity. Asserting the
    // WINDOW (not just "eventually") is what keeps a future 10 s ceiling — the
    // regression that would make the chip cry wolf during a normal long prose
    // turn — from passing this spec.
    expect(elapsed, `flipped after ${elapsed} ms; the ceiling is 90 s`).toBeGreaterThan(85_000)
    // 2x the ceiling. Tight enough that a 10 s ceiling fails here, loose enough
    // that a loaded box scheduling the surface's re-render late does not.
    expect(elapsed).toBeLessThan(180_000)

    const chip = page.locator('[data-vr="chat-connection"]').first()
    await expect(chip).toBeVisible()
    await expect(chip).toHaveText(/Not up to date/i)

    // THE POINT: this is not a disguised reconnect. The socket the page held at
    // seed time is the socket it still holds — nothing closed, nothing dialled.
    const now = await socketCounts(page)
    expect(now.opened, 'no redial may have happened').toBe(atSeed.opened)
    expect(now.closed, 'the socket must never have closed').toBe(atSeed.closed)

    // …and what is on screen STAYS on screen. `stale` is a claim about
    // freshness, never a reason to blank a transcript (`tailer.rs:153`).
    await expectTokenOnce(page, tok(1))
    await expectTokenOnce(page, tok(3))

    // One authoritative frame re-stamps the clock and the claim comes back —
    // over the SAME socket, which is the other half of "no drop".
    fx.append(CONV, [tok(4)])
    await expectTokenOnce(page, tok(4))
    await expect.poll(() => connectionState(page), { timeout: 60_000 }).toBe('live')
    expect((await socketCounts(page)).opened).toBe(atSeed.opened)
  })
})

// fix-peek-sticky regression e2e — "type → leave → prompt dismiss" timing.
//
// THE BUG (desktop): hovering a tile opens the live peek; type-on-hover lets you
// type into it. After typing and moving the mouse AWAY, the peek used to take
// the FULL keystroke-silence window (PEEK_STICKY_MS = 4s) to shrink back —
// because `onHoverEnd` early-returned while `sticky` was alive and dismissal was
// driven purely by the 4s silence timeout. The fix decouples the post-mouse-leave
// dismissal (a SHORT PEEK_LEAVE_GRACE_MS, ~400ms) from that long silence window,
// while keeping the "continuous typing re-arms and holds the peek open even with
// the pointer gone" intent.
//
// This spec asserts the THREE behaviours the fix must satisfy:
//   1. hover → type a char → leave  ⇒ peek shrinks WELL under the old 4s
//      (within ~PEEK_LEAVE_GRACE_MS + slack, far below PEEK_STICKY_MS).
//   2. hover → type continuously while the pointer is away ⇒ peek STAYS open
//      (keystrokes re-arm the grace), then dismisses promptly once typing stops.
//   3. plain hover → leave WITHOUT typing ⇒ still dismisses promptly (no regress).
//
// SIGNAL FOR "PEEK OPEN": the live-peek mounts a <LiveTerminal> (which carries a
// `data-state` attribute) only while `hovered` is true. We select it by the CSS
// attribute (NOT by ARIA role — the TileLiveTerminal wrapper is `aria-hidden`, so
// the inner role="application" is intentionally absent from the a11y tree). On
// dismiss, `setHovered(false)` unmounts it (LivePeekLayer has NO exit tween, so
// detach is effectively immediate) — a clean, race-free open/closed marker.

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'
import {
  PEEK_STICKY_MS,
  PEEK_LEAVE_GRACE_MS,
} from '../../../src/hooks/use-peek-type'

const SESSION = 'smoke-peek'

test.describe('peek dismiss after type + mouse-leave', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('type → leave shrinks promptly; continuous typing holds; plain hover/leave dismisses', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    // Desktop 1440 (fine pointer) → hover-peek + type-on-hover are active.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(injectGlobals(backend.token))

    const A = api(backend)
    // A live shell session: create + start so the pty exists and the live peek
    // can actually connect (showLiveTerm requires a live-capable, running tile).
    const created = await A.createSession({
      name: SESSION,
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(created.status, 'create shell session').toBe(201)
    const started = await A.startSession(SESSION)
    expect(started.ok, 'start shell session').toBeTruthy()

    await page.goto(backend.baseUrl)

    // The tile card's aria-label is "<title> — <status>" (e.g. "smoke-peek —
    // Running"). Anchor on that exact shape so we don't also match the hover-
    // revealed "Archive smoke-peek" button (strict-mode would see two buttons).
    const tile = page.getByRole('button', { name: new RegExp(`^${SESSION} —`) })
    await expect(tile).toBeVisible({ timeout: 15_000 })

    // The live peek's terminal — present only while the peek is open. Scoped to
    // the tile and selected by the LiveTerminal `data-state` attribute (CSS,
    // unaffected by the wrapper's aria-hidden).
    const livePeek = tile.locator('[data-state]')
    // A neutral off-tile point to move the pointer to (top-left corner).
    const leave = () => page.mouse.move(5, 5)

    // ── Scenario 1: hover → type one char → leave → shrinks promptly ──────────
    await tile.hover()
    await expect(livePeek).toBeVisible({ timeout: 15_000 })

    // Type one printable char (engages type-on-hover → arms the sticky window).
    await page.keyboard.press('a')

    // Now move the mouse OFF the tile and time how long the peek takes to vanish.
    const t0 = Date.now()
    await leave()
    await expect(livePeek).toHaveCount(0, {
      // Allow the short grace + animation/teardown slack, but assert it is far
      // below the old 4s silence window. This bound is the actual regression
      // guard: a "restored" 4s timer would blow past this and fail.
      timeout: PEEK_LEAVE_GRACE_MS + 600,
    })
    const elapsed = Date.now() - t0
    expect(
      elapsed,
      `peek should shrink within the short grace, not the ${PEEK_STICKY_MS}ms silence window (took ${elapsed}ms)`,
    ).toBeLessThan(PEEK_STICKY_MS - 1000)

    // ── Scenario 2: continuous typing with the pointer AWAY holds it open ─────
    await tile.hover()
    await expect(livePeek).toBeVisible({ timeout: 15_000 })
    await page.keyboard.press('b') // engage
    await leave() // pointer gone, but we keep typing

    // Fire a keystroke every ~150ms for ~1.2s — comfortably longer than the
    // grace (so a non-re-arming impl would have dismissed) but well under the
    // old 4s window. The peek must STAY open the whole time (each key re-arms).
    const burstUntil = Date.now() + 1200
    while (Date.now() < burstUntil) {
      await page.keyboard.press('c')
      await page.waitForTimeout(150)
    }
    await expect(
      livePeek,
      'continuous typing with pointer away must keep the peek open (re-armed)',
    ).toBeVisible()

    // Stop typing → it dismisses promptly (short grace after the LAST keystroke,
    // NOT the full silence window).
    const t1 = Date.now()
    await expect(livePeek).toHaveCount(0, { timeout: PEEK_LEAVE_GRACE_MS + 600 })
    expect(
      Date.now() - t1,
      'after typing stops + pointer is away, dismiss within the short grace',
    ).toBeLessThan(PEEK_STICKY_MS - 1000)

    // ── Scenario 3: plain hover → leave WITHOUT typing → prompt dismiss ───────
    await tile.hover()
    await expect(livePeek).toBeVisible({ timeout: 15_000 })
    const t2 = Date.now()
    await leave()
    // No typing means `sticky` was never armed → onHoverEnd dismisses at once.
    await expect(livePeek).toHaveCount(0, { timeout: 1000 })
    expect(
      Date.now() - t2,
      'plain hover-then-leave (no typing) must still dismiss promptly',
    ).toBeLessThan(PEEK_STICKY_MS - 1000)
  })
})

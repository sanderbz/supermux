// The mobile session pill's tap-vs-swipe gate, locked BEFORE anything moves
// (fase B3 T1.3 — the acceptance criterion for T7).
//
// WHY THIS SPEC EXISTS. `ComposeField` (`dock.tsx:821-935`) is scar tissue: a
// tap-vs-swipe gate with `TAP_SLOP_PX = 10` / `TAP_MAX_MS = 500`, multi-touch
// invalidation, a `draggedRef` interlock with framer's `onDragStart`, and a
// GHOST-CLICK FIX — the action fires on `click`, never `pointerup`, because the
// synthesized touch click was landing on the newly-mounted sheet's Cancel
// button and closing it within ~50 ms, leaving Claude blocked in $EDITOR with
// nothing on screen (the "tapped Edit, nothing visible, terminal frozen"
// Android bug).
//
// B3's T7 rebuilds the sheet this pill opens. T7.2 forbids touching
// `dock.tsx` — but "forbidden" is a comment, and this is the test. If T7 ever
// perturbs the gate, this goes red before a phone does.
//
// ONE TEST, NOT FOUR — every assertion below shares one page, ordered
// least-destructive first: a short drag changes nothing, a committed drag
// switches session, and only then does a tap open the sheet. (Originally forced
// by `--single-process` chromium on the hardened self-host box, where a spec
// could not open a second browser context; that flag is gone — INFRA-01,
// tests/e2e/launch-args.ts.)
//
// A `shell` provider is deliberate: `onEdit` is wired only for claude/codex
// under the terminal (`routes/focus/mobile.tsx:828-834`), so on shell — exactly
// as under the chat renderer, where the composer IS the editor — the pill's tap
// falls through to `onTap`, which opens the session sheet T7 rebuilds. That is
// the path under test, reached without having to stand up the chat flag.

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

test.describe('mobile: the session pill tells a tap from a swipe', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('short drag does nothing, long drag switches, tap opens the sheet', async ({
    page,
  }) => {
    test.setTimeout(75_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    })

    const A = api(backend)
    // Three sessions so the pill is swipeable in both directions and the
    // neighbour a committed swipe lands on is unambiguous.
    for (const name of ['pill-a', 'pill-b', 'pill-c']) {
      expect(
        (await A.createSession({ name, provider: 'shell', dir: backend.dataDir })).status,
      ).toBe(201)
      expect((await A.startSession(name)).ok).toBeTruthy()
    }

    await page.goto(`${backend.baseUrl}/focus/pill-b`)
    await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: 20_000 })

    // The pill's accessible name IS the fallback contract: with no editor to
    // lift text into, the label must say "Switch session" rather than "Edit…".
    // A pill that reads "Edit" and opens a session list is the bug this label
    // was changed to prevent.
    const pill = page.getByRole('button', { name: 'Switch session' })
    await expect(pill).toBeVisible({ timeout: 15_000 })

    const sheet = page.getByRole('dialog').filter({ hasText: 'Sessions' })

    // Drive the gate through its real pointer path. framer's drag and the
    // gate's own candidate both listen to pointer events, and `mouse.up`
    // synthesizes the `click` the ghost-click fix deliberately fires on — so a
    // mouse gesture exercises exactly the same code a finger does, minus the
    // synthetic-click delay that motivated it.
    const gesture = async (dx: number, steps: number) => {
      const box = (await pill.boundingBox())!
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(cx + (dx * i) / steps, cy)
      }
      await page.mouse.up()
    }

    const currentSession = () =>
      page.evaluate(() => location.pathname.split('/').pop() ?? '')

    // ── (c) A drag that stops short snaps back and opens nothing ────────────
    // Past the 10 px slop (so it is NOT a tap) but nowhere near the pill's
    // `width * 0.4` commit threshold (so it is NOT a switch). This is the
    // gesture that must do NOTHING — the one a user makes by brushing the pill
    // while scrolling.
    const box = (await pill.boundingBox())!
    const shortDx = -Math.max(20, Math.round(box.width * 0.15))
    await gesture(shortDx, 8)
    await page.waitForTimeout(700) // let the spring settle + any sheet mount
    await expect(sheet).toBeHidden()
    expect(await currentSession()).toBe('pill-b')

    // ── (b) A committed drag switches session and does NOT open the sheet ───
    // `draggedRef` is set by framer's `onDragStart`, and the click handler bails
    // on it. Without that interlock a swipe would BOTH switch the session and
    // open the picker on top of the session it just left.
    await gesture(-Math.round(box.width * 1.2), 14)
    await expect(async () => {
      expect(await currentSession()).not.toBe('pill-b')
    }).toPass({ timeout: 10_000 })
    await expect(sheet).toBeHidden()

    // ── (a) A short stationary tap opens the session sheet ──────────────────
    await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: 20_000 })
    const pillNow = page.getByRole('button', { name: 'Switch session' })
    await expect(pillNow).toBeVisible({ timeout: 15_000 })
    await pillNow.click()
    await expect(sheet).toBeVisible({ timeout: 10_000 })

    // ── (d) …and the tap did not pop the soft keyboard ─────────────────────
    // Focusing xterm's hidden helper-textarea is what opens the keyboard on
    // iOS. A picker that stole focus into the terminal would raise the keyboard
    // over the very list it just opened.
    const focused = await page.evaluate(() => {
      const el = document.activeElement
      return {
        tag: el?.tagName.toLowerCase() ?? '',
        cls: el?.className?.toString() ?? '',
      }
    })
    expect(focused.cls).not.toContain('xterm-helper-textarea')

    // The sheet lists the other sessions — the contents T7 rebuilds on the
    // shared primitive. Pinning that they are REACHABLE (not how they look)
    // is what makes this spec survive the rebuild unchanged.
    await expect(sheet.getByText('pill-b', { exact: false }).first()).toBeVisible({
      timeout: 10_000,
    })
  })
})

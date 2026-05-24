// fix/focus-flicker regression e2e — desktop overview→focus must NEVER flash the
// mobile branch.
//
// THE BUG (desktop, 1440px): opening a terminal (overview → /focus/:name)
// navigates inside a View Transition (morph.tsx wraps the route swap in
// `flushSync` so the browser snapshots the OLD then NEW DOM and cross-fades).
// The focus route forks desktop (≥768px <DesktopFocus/>, the two-column split)
// vs mobile (<768px <MobileFocus/>, the Vaul sheet) on
// `useMediaQuery('(min-width: 768px)')`. If that fork ever evaluates to the
// MOBILE branch for even a single COMMITTED frame during the flushSync commit,
// `::view-transition-new(root)` snapshots that frame and cross-fades it for the
// full transition — surfacing as a desktop↔mobile↔desktop flash. (A post-commit
// rAF sampler can't catch it: the live DOM has already corrected by the time it
// samples, yet the snapshot froze the bad frame.) The fix reads the fork through
// `useSyncExternalStore`, which keeps the rendered branch in lockstep with the
// live media state at commit time — no transient flip.
//
// SIGNALS:
//   • DESKTOP present     → `[data-testid="desktop-split"]` (the two-column root).
//   • MOBILE present (bug)→ `[data-testid="focus-sheet"]` (the Vaul mobile sheet).
//
// We arm a MutationObserver BEFORE the click that flips a flag the instant the
// mobile-sheet marker ever enters the DOM, and we sample every animation frame
// during the transition. The mobile branch must NEVER appear, the desktop split
// must be present throughout, and `(min-width: 768px)` must stay matched.

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

const SESSION = 'flick-desktop'

test.describe('desktop overview→focus never flashes the mobile branch', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('1440px: mobile sheet never mounts; desktop split present throughout', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    // Desktop viewport — the focus fork must resolve to <DesktopFocus/>.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(injectGlobals(backend.token))

    const A = api(backend)
    const created = await A.createSession({
      name: SESSION,
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(created.status, 'create shell session').toBe(201)
    const started = await A.startSession(SESSION)
    expect(started.ok, 'start shell session').toBeTruthy()

    await page.goto(backend.baseUrl)

    // The overview tile (aria-label "<name> — <status>"). Anchor on the exact
    // shape so we don't also match the hover-revealed "Archive <name>" button.
    const tile = page.getByRole('button', { name: new RegExp(`^${SESSION} —`) })
    await expect(tile).toBeVisible({ timeout: 15_000 })

    // Arm the watchdog BEFORE navigating: a MutationObserver that latches the
    // first time the MOBILE sheet marker ever enters the DOM, plus a per-frame
    // sampler of the fork signals + the media-query value. This catches a flash
    // that the final DOM state would hide.
    await page.evaluate(() => {
      const w = window as unknown as {
        __mobileEverSeen: boolean
        __mmEverFalse: boolean
        __frames: number
        __rec: boolean
      }
      w.__mobileEverSeen = false
      w.__mmEverFalse = false
      w.__frames = 0
      w.__rec = true

      const checkMobile = () =>
        !!document.querySelector('[data-testid="focus-sheet"]')

      // Initial state guard.
      if (checkMobile()) w.__mobileEverSeen = true

      const mo = new MutationObserver(() => {
        if (checkMobile()) w.__mobileEverSeen = true
      })
      mo.observe(document.documentElement, { childList: true, subtree: true })

      const sampler = () => {
        if (!w.__rec) return
        w.__frames += 1
        if (checkMobile()) w.__mobileEverSeen = true
        if (!window.matchMedia('(min-width: 768px)').matches)
          w.__mmEverFalse = true
        requestAnimationFrame(sampler)
      }
      requestAnimationFrame(sampler)
    })

    // Open the terminal — this triggers the View Transition morph.
    await tile.click()

    // Wait for the focus route to settle on the desktop split.
    await expect(page).toHaveURL(new RegExp(`/focus/${SESSION}$`), {
      timeout: 15_000,
    })
    const desktopSplit = page.locator('[data-testid="desktop-split"]')
    await expect(desktopSplit).toBeVisible({ timeout: 15_000 })

    // Let the transition (≤300ms) + a few extra frames fully play out, then stop
    // sampling and harvest the verdict.
    await page.waitForTimeout(900)
    const verdict = await page.evaluate(() => {
      const w = window as unknown as {
        __mobileEverSeen: boolean
        __mmEverFalse: boolean
        __frames: number
        __rec: boolean
      }
      w.__rec = false
      return {
        mobileEverSeen: w.__mobileEverSeen,
        mmEverFalse: w.__mmEverFalse,
        frames: w.__frames,
        mobileSheetNow: !!document.querySelector('[data-testid="focus-sheet"]'),
        desktopSplitNow: !!document.querySelector(
          '[data-testid="desktop-split"]',
        ),
      }
    })

    // We must have actually sampled frames during/after the transition.
    expect(verdict.frames, 'sampler ran during the transition').toBeGreaterThan(5)
    // The mobile branch must NEVER have entered the DOM at any frame/mutation.
    expect(
      verdict.mobileEverSeen,
      'mobile focus sheet must never mount during overview→focus at 1440px',
    ).toBe(false)
    // The desktop breakpoint must stay matched throughout — no transient flip.
    expect(
      verdict.mmEverFalse,
      '(min-width: 768px) must stay matched throughout the navigation',
    ).toBe(false)
    // Final state is the clean desktop split, no mobile sheet.
    expect(verdict.mobileSheetNow, 'no mobile sheet after settle').toBe(false)
    expect(verdict.desktopSplitNow, 'desktop split present after settle').toBe(
      true,
    )

    // And it stays desktop a beat later (no late flip-back).
    await expect(desktopSplit).toBeVisible()
    await expect(page.locator('[data-testid="focus-sheet"]')).toHaveCount(0)

    // NON-REGRESSION: a REAL viewport resize across the 768px breakpoint must
    // still switch the fork. Shrinking below 768px mounts the mobile sheet…
    await page.setViewportSize({ width: 430, height: 932 })
    await expect(page.locator('[data-testid="focus-sheet"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator('[data-testid="desktop-split"]')).toHaveCount(0)

    // …and growing back to desktop returns the split. The hook still reacts to
    // genuine breakpoint crossings (only TRANSIENT mid-navigation flips are
    // eliminated).
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.locator('[data-testid="desktop-split"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator('[data-testid="focus-sheet"]')).toHaveCount(0)
  })
})

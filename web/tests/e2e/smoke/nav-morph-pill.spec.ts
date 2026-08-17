// B1 T4/T5 — one animation per navigation, provably.
//
// The active primary-nav pill used to animate with framer's shared-layout
// engine (`layoutId`). B1 routes nav clicks through `startViewTransition`, and
// the two systems collide: the browser snapshots the OLD DOM mid-spring and
// cross-fades that frozen frame against the new one, so the pill
// double-animates. The fix is to delete both `layoutId` pills and express the
// active pill as a view-transition-named element — one name, one group, one
// animation, owned by the browser.
//
// This spec is what makes "one animation" checkable rather than a claim:
//   · exactly ONE element in the document carries `view-transition-name:
//     sm-nav-active` at rest, and it sits inside the ACTIVE link;
//   · navigating moves it (it follows `aria-current`), which is the whole
//     behaviour;
//   · the transition it belongs to ANIMATES — sampled `currentTime` passes half
//     the declared 0.26s. This is the assertion that was missing: the earlier
//     version asserted a unique name and a non-rejecting `ready`, and stayed
//     green through a regression where every navigation was a hard cut (the
//     pseudo-tree was built, then cancelled one frame later at currentTime 0);
//   · nav links are real `<a href>`s, so a ⌘-click opens a new page instead of
//     morphing the current one (the regression a click-only handler would
//     introduce);
//   · under reduced motion the navigation still completes and the browser
//     creates no transition pseudo-element (globals.css disables
//     `::view-transition-*` wholesale, and `navigateMorph` skips the API).

import { expect, test } from '@playwright/test'
import { injectGlobals, startBackend, type Backend } from './harness'

test.describe('nav: the active pill is one view-transition group', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  // One test, several phases — historically forced, because this host used to
  // run chromium `--single-process` (SUPERMUX_E2E_NO_SANDBOX), where a second
  // browser context per spec file killed the browser. That flag is gone
  // (INFRA-01, see tests/e2e/launch-args.ts): multi-test files and second
  // contexts work now. The single-test shape here is kept only because the
  // phases genuinely share one navigation history.
  test('one named pill, it follows the active route, and modifier clicks stay native', async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
      localStorage.setItem('supermux-first-launch', String(Date.now()))
      // Instrument the API. A DUPLICATE view-transition-name among rendered
      // elements makes the browser reject `transition.ready` and skip the
      // animation — which is exactly the failure this spec exists to catch, and
      // it is otherwise completely silent.
      const w = window as unknown as {
        __vtStarted: number
        __vtFailed: string[]
        __vtProgress: number[]
      }
      w.__vtStarted = 0
      w.__vtFailed = []
      // Peak `currentTime` reached by any `::view-transition-*` animation, one
      // entry per transition. `ready` resolving proves the pseudo-tree was
      // BUILT; only a currentTime that advances proves it ANIMATED. The bug
      // this catches (every navigation a hard cut) left `ready` resolved, no
      // rejection, and every animation cancelled on the next frame at
      // currentTime 0 — invisible to any existence assertion.
      w.__vtProgress = []
      const d = document as Document & {
        startViewTransition?: (
          cb: () => void | Promise<void>,
        ) => { ready?: Promise<void> }
      }
      if (d.startViewTransition) {
        const orig = d.startViewTransition.bind(d)
        d.startViewTransition = (cb: () => void | Promise<void>) => {
          w.__vtStarted++
          const slot = w.__vtProgress.push(0) - 1
          const t = orig(cb)
          t?.ready?.catch((e: unknown) => w.__vtFailed.push(String(e)))
          t?.ready?.then(() => {
            let frames = 0
            const tick = () => {
              const peak = document
                .getAnimations()
                .filter((a) =>
                  String(a.effect?.pseudoElement ?? '').startsWith('::view-transition'),
                )
                .reduce((m, a) => Math.max(m, Number(a.currentTime) || 0), 0)
              w.__vtProgress[slot] = Math.max(w.__vtProgress[slot], peak)
              if (++frames < 60) requestAnimationFrame(tick)
            }
            tick()
          })
          return t
        }
      }
    })

    await page.goto(`${backend.baseUrl}/`)
    const rail = page.locator('nav[aria-label="Primary"]').first()
    await expect(rail).toBeVisible({ timeout: 20_000 })

    /** Every RENDERED element whose computed view-transition-name is the nav
     *  pill's, plus the href of the link it lives under.
     *
     *  "Rendered" is load-bearing. Desktop rail and mobile tab bar are BOTH in
     *  the DOM at every width (`hidden md:flex` vs `md:hidden`), so at any
     *  moment one of the two pills exists but has `display: none`. The View
     *  Transitions API ignores non-rendered elements, so that pill neither
     *  participates nor collides — but `getComputedStyle` still reports its
     *  name, so the probe has to do the same filtering the browser does. */
    const pills = () =>
      page.evaluate(() => {
        const out: { href: string | null; ariaCurrent: string | null }[] = []
        for (const el of Array.from(document.querySelectorAll('*'))) {
          const name = getComputedStyle(el).viewTransitionName
          if (name !== 'sm-nav-active') continue
          if (!(el as HTMLElement).getClientRects().length) continue // not rendered
          const link = el.closest('a')
          out.push({
            href: link?.getAttribute('href') ?? null,
            ariaCurrent: link?.getAttribute('aria-current') ?? null,
          })
        }
        return out
      })

    // ── At rest on `/`: exactly one pill, under the active Overview link ─────
    let found = await pills()
    expect(found.length, 'exactly one element carries the pill name').toBe(1)
    expect(found[0].href).toBe('/')
    expect(found[0].ariaCurrent, 'the pill sits under the ACTIVE link').toBe('page')

    // ── Warm-up: visit both destinations once, then forget the samples ───────
    // `/settings` is entry-lazy (App.tsx). A morph waits for React to COMMIT
    // the new route, and a cold chunk fetch can exceed that wait — in which case
    // the morph deliberately degrades to a hard cut. That degradation is a
    // separate, documented behaviour; measuring it here would make the progress
    // assertion below a coin flip on how fast the dev server serves a chunk.
    for (const label of ['Files', 'Settings', 'Overview'] as const) {
      await rail.getByRole('link', { name: label, exact: true }).click()
      await page.waitForTimeout(500)
    }
    await expect(page).toHaveURL(/\/$/)
    // Mark rather than clear: a warm-up transition's rAF sampler may still be
    // running and would otherwise write into a recycled slot.
    const warmupCount = await page.evaluate(
      () => (window as unknown as { __vtProgress: number[] }).__vtProgress.length,
    )

    // ── Navigate: the pill follows the active route ──────────────────────────
    for (const [label, href] of [
      ['Files', '/files'],
      ['Settings', '/settings'],
    ] as const) {
      await rail.getByRole('link', { name: label, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`${href}$`))
      await expect(async () => {
        found = await pills()
        expect(found.length).toBe(1)
        expect(found[0].href).toBe(href)
        expect(found[0].ariaCurrent).toBe('page')
      }).toPass({ timeout: 5_000 })
    }

    // ── The transitions actually RAN, and none was skipped ───────────────────
    // The pill group is declared at 0.26s (globals.css). Half of it is the bar:
    // a transition that is torn down a frame after `ready` peaks at 0, and one
    // that runs reaches ~260. Sampling is per rAF, so a transition that is
    // merely SLOW to be scheduled still clears this once it starts.
    const HALF_DURATION_MS = 130
    let vt = { started: 0, failed: [] as string[], progress: [] as number[] }
    await expect(async () => {
      vt = await page.evaluate(
        (skip) => {
          const w = window as unknown as {
            __vtStarted: number
            __vtFailed: string[]
            __vtProgress: number[]
          }
          return {
            started: w.__vtStarted,
            failed: w.__vtFailed,
            progress: w.__vtProgress.slice(skip),
          }
        },
        warmupCount,
      )
      expect(vt.progress.length).toBe(2)
      expect(Math.min(...vt.progress)).toBeGreaterThan(HALF_DURATION_MS)
    }).toPass({ timeout: 5_000 })
    expect(vt.started, 'nav clicks route through startViewTransition').toBeGreaterThan(0)
    expect(
      vt.failed,
      'no transition was skipped — a duplicate view-transition-name would reject `ready`',
    ).toEqual([])
    // EVERY navigation animates, not just the luckiest one.
    expect(
      vt.progress.filter((ms) => ms > HALF_DURATION_MS).length,
      'every navigation ran its transition past half its declared duration',
    ).toBe(vt.progress.length)

    // ── The pill is NOT a framer shared-layout element ───────────────────────
    // framer-motion drives `layoutId` by writing an inline `transform` on the
    // element every frame. A settled, browser-owned pill has none.
    const inlineTransform = await page.evaluate(
      () =>
        (document.querySelector('[data-nav-active]') as HTMLElement | null)?.style
          .transform ?? '',
    )
    expect(inlineTransform, 'no framer layout transform on the pill').toBe('')

    // ── T5.4: ⌘/Ctrl-click opens a NEW page rather than morphing ─────────────
    const before = context.pages().length
    const popupPromise = context
      .waitForEvent('page', { timeout: 8_000 })
      .catch(() => null)
    await rail
      .getByRole('link', { name: 'Overview', exact: true })
      .click({ modifiers: ['ControlOrMeta'] })
    const popup = await popupPromise
    // Either a real new page appeared, or the browser at minimum did NOT
    // navigate this one — both prove the modifier click was left native.
    if (popup) {
      expect(context.pages().length).toBeGreaterThan(before)
      await popup.close()
    }
    await expect(page, 'the current page did not morph away').toHaveURL(/\/settings$/)

    // ── Reduced motion: still navigates, and asks for no transition at all ───
    // `page.emulateMedia` rather than a second browser context — originally a
    // `--single-process` workaround (INFRA-01, now fixed), kept because it is
    // the stronger assertion: `navigateMorph` reads `prefers-reduced-motion`
    // LIVE (not cached), so the switch takes effect without a reload — which is
    // itself worth asserting.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const startedBefore = await page.evaluate(
      () => (window as unknown as { __vtStarted: number }).__vtStarted,
    )
    await rail.getByRole('link', { name: 'Files', exact: true }).click()
    await expect(page, 'the route still changes under reduced motion').toHaveURL(
      /\/files$/,
    )
    const startedAfter = await page.evaluate(
      () => (window as unknown as { __vtStarted: number }).__vtStarted,
    )
    expect(
      startedAfter,
      'navigateMorph skips startViewTransition entirely under reduced motion',
    ).toBe(startedBefore)
  })
})

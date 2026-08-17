// B1 T1.1 / T1.2 — the shell's containing-block guard, and the KeyBar's
// z-order, made executable.
//
// THE HAZARD (the master plan names it; this spec is what makes it fail loudly):
// a non-`none` `backdrop-filter` / `filter` / `transform` / `perspective` /
// `contain: paint` / `will-change: transform` on ANY ancestor promotes that
// element to the CONTAINING BLOCK for every `position: fixed` descendant. The
// mobile focus route is built out of fixed chrome — `<MobileSheet>`
// (`[data-testid="focus-sheet"]`, sized from `visualViewport`), the floating
// KeyBar, the joystick, the tour overlay. If a shell column above them grows
// one of those properties, `fixed` starts resolving against the column instead
// of the viewport: the sheet's keyboard math silently measures the wrong box
// and the bar drifts. Nothing throws; it just looks broken on a phone.
//
// So: fase B1's painted substrate is OPAQUE PAINT, never blur — and this spec
// lands BEFORE the substrate does, passes on pre-substrate code, and is
// therefore unambiguous evidence if it ever goes red afterwards. Its static
// counterpart is `tests/unit/shell-chrome-tokens.test.ts`, which asserts the
// same invariant against globals.css.

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

/** Properties that make an element the containing block for `fixed` children.
 *  Run in-page: walk `parentElement` from `selector` up to <html>, collecting
 *  every ancestor whose COMPUTED style carries one of them. */
async function ancestorOffenders(
  page: import('@playwright/test').Page,
  selector: string,
): Promise<{ found: boolean; offenders: string[] }> {
  return page.evaluate((sel) => {
    const trigger = (el: Element): string[] => {
      const s = getComputedStyle(el) as CSSStyleDeclaration & {
        webkitBackdropFilter?: string
      }
      const hits: string[] = []
      if (s.backdropFilter && s.backdropFilter !== 'none')
        hits.push(`backdrop-filter: ${s.backdropFilter}`)
      if (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none')
        hits.push(`-webkit-backdrop-filter: ${s.webkitBackdropFilter}`)
      if (s.filter && s.filter !== 'none') hits.push(`filter: ${s.filter}`)
      if (s.transform && s.transform !== 'none') hits.push(`transform: ${s.transform}`)
      if (s.perspective && s.perspective !== 'none')
        hits.push(`perspective: ${s.perspective}`)
      if (s.contain && /paint|strict|content/.test(s.contain))
        hits.push(`contain: ${s.contain}`)
      if (s.willChange && /transform|filter|perspective/.test(s.willChange))
        hits.push(`will-change: ${s.willChange}`)
      return hits
    }
    const label = (el: Element): string =>
      el.tagName.toLowerCase() +
      (el.id ? `#${el.id}` : '') +
      (typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).join('.')}`
        : '')

    const start = document.querySelector(sel)
    if (!start) return { found: false, offenders: [] as string[] }
    const offenders: string[] = []
    let el: Element | null = start.parentElement
    while (el && el !== document.documentElement) {
      const hits = trigger(el)
      if (hits.length) offenders.push(`${label(el)} \u2192 ${hits.join(', ')}`)
      el = el.parentElement
    }
    return { found: true, offenders }
  }, selector)
}

test.describe('shell: no ancestor may become a containing block for fixed chrome', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  // ONE test, two phases (keyboard closed, then a simulated keyboard). This
  // used to be forced — the box ran chromium with `--single-process`
  // (SUPERMUX_E2E_NO_SANDBOX), where a second browser context in the same file
  // killed the browser. That flag is gone (INFRA-01, tests/e2e/launch-args.ts);
  // the shape is kept because phase 2 builds on phase 1's layout.
  test('focus sheet + KeyBar: clean ancestor chain and correct z-order, keyboard closed and open', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
      // The floating KeyBar defaults to CLOSED (`focus_key_bar`, key-bar.tsx).
      // Open it up front so it is in the DOM for the ancestor walk and the
      // hit-test below, without driving the dock UI.
      localStorage.setItem(
        'focus_key_bar',
        JSON.stringify({
          open: true,
          keys: ['Left', 'Up', 'Down', 'Right', 'Enter', 'Esc'],
        }),
      )
      // Playwright cannot open a soft keyboard, so shim the visual viewport the
      // way iOS reports one: the LAYOUT viewport keeps its height,
      // `visualViewport.height` shrinks. `useKeyboardViewport` reads
      // `innerHeight - vv.height - vv.offsetTop` as the overlap inset and
      // publishes a concrete sheet height once it crosses
      // KEYBOARD_OPEN_THRESHOLD (80px). Installed closed; the test flips it.
      const KEYBOARD = 320
      const vv = window.visualViewport
      if (!vv) return
      let open = false
      Object.defineProperty(vv, 'height', {
        configurable: true,
        get: () => (open ? window.innerHeight - KEYBOARD : window.innerHeight),
      })
      Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 })
      ;(
        window as unknown as { __smFakeKeyboard: (v: boolean) => void }
      ).__smFakeKeyboard = (v: boolean) => {
        open = v
        vv.dispatchEvent(new Event('resize'))
      }
    })

    const A = api(backend)
    expect(
      (
        await A.createSession({
          name: 'shellcb',
          provider: 'shell',
          dir: backend.dataDir,
        })
      ).status,
    ).toBe(201)
    expect((await A.startSession('shellcb')).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/shellcb`)

    const sheet = page.locator('[data-testid="focus-sheet"]')
    await expect(sheet).toBeVisible({ timeout: 20_000 })
    const keyBar = page.locator('[role="toolbar"][aria-label="Key bar"]')
    await expect(keyBar).toBeVisible({ timeout: 10_000 })

    // ── T1.1(2,3): the ancestor walk, from BOTH fixed subjects ───────────────
    const sheetChain = await ancestorOffenders(page, '[data-testid="focus-sheet"]')
    expect(sheetChain.found, 'focus sheet is mounted').toBe(true)
    expect(
      sheetChain.offenders,
      'no ancestor of the focus sheet may create a containing block for fixed children',
    ).toEqual([])

    const barChain = await ancestorOffenders(
      page,
      '[role="toolbar"][aria-label="Key bar"]',
    )
    expect(barChain.found, 'KeyBar is mounted').toBe(true)
    // The KeyBar's own FIXED wrapper carries the static `-translate-x-1/2`
    // centring (and a framer transform during its entrance spring). That
    // element is the fixed subject itself, not an ancestor of it, so it is
    // excluded; everything ABOVE it must be clean.
    expect(
      barChain.offenders.filter((o) => !/\bfixed\b/.test(o)),
      'no ancestor of the KeyBar may create a containing block for fixed children',
    ).toEqual([])

    // ── T1.1(4): a broken containing block MOVES the sheet ───────────────────
    const geom = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="focus-sheet"]')!
      const r = el.getBoundingClientRect()
      return { left: r.left, bottom: r.bottom, innerHeight: window.innerHeight }
    })
    expect(Math.abs(geom.left), 'sheet is flush to the viewport left edge').toBeLessThan(1)
    expect(
      Math.abs(geom.bottom - geom.innerHeight),
      'sheet is flush to the viewport bottom edge',
    ).toBeLessThan(1)

    // ── T1.2: KeyBar z-order + hit-testability, keyboard closed ──────────────
    const zOrder = await page.evaluate(() => {
      const bar = document.querySelector(
        '[role="toolbar"][aria-label="Key bar"]',
      ) as HTMLElement
      const sheetEl = document.querySelector(
        '[data-testid="focus-sheet"]',
      ) as HTMLElement
      // The z-index lives on the fixed wrapper around the toolbar — walk up to
      // the nearest non-`auto` value for each subject.
      const zOf = (el: HTMLElement | null): number => {
        let cur: HTMLElement | null = el
        while (cur) {
          const z = getComputedStyle(cur).zIndex
          if (z && z !== 'auto') return Number(z)
          cur = cur.parentElement
        }
        return 0
      }
      const r = bar.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        barZ: zOf(bar),
        sheetZ: zOf(sheetEl),
        hitIsInsideBar: !!hit && bar.contains(hit),
      }
    })
    expect(
      zOrder.barZ,
      'KeyBar paints at or above the focus sheet',
    ).toBeGreaterThanOrEqual(zOrder.sheetZ)
    expect(zOrder.hitIsInsideBar, 'nothing paints over the KeyBar').toBe(true)

    // ── T1.2 (phase 2): raise the simulated keyboard ─────────────────────────
    const heightBefore = await sheet.evaluate((el) => el.getBoundingClientRect().height)
    await page.evaluate(() =>
      (
        window as unknown as { __smFakeKeyboard: (v: boolean) => void }
      ).__smFakeKeyboard(true),
    )

    // The sheet's height is CSS-transitioned (0.28s) — poll for the settle.
    await expect(async () => {
      const h = await sheet.evaluate((el) => el.getBoundingClientRect().height)
      expect(
        heightBefore - h,
        'sheet shrinks to sit above the simulated keyboard',
      ).toBeGreaterThan(200)
    }).toPass({ timeout: 8_000 })

    // The KeyBar is still on top and still hit-testable with the keyboard up.
    await expect(keyBar).toBeVisible()
    const hitWithKeyboard = await page.evaluate(() => {
      const bar = document.querySelector(
        '[role="toolbar"][aria-label="Key bar"]',
      ) as HTMLElement
      const r = bar.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit && bar.contains(hit)
    })
    expect(hitWithKeyboard, 'KeyBar still hit-testable with the keyboard up').toBe(true)

    // And the ancestor chain is STILL clean in the keyboard-open state.
    const chainWithKeyboard = await ancestorOffenders(
      page,
      '[data-testid="focus-sheet"]',
    )
    expect(chainWithKeyboard.offenders).toEqual([])
  })
})

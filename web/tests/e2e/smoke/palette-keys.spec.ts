// The ⌘K palette's keyboard contract (fase B3 T1.4).
//
// The palette had exactly one surviving e2e after B2 removed the Board page
// (`archived-recover.spec.ts`, which opens it and picks one row by text). Every
// KEYBOARD path in it — the toggle, the wrap, the scroll-follow — was untested,
// which is precisely the surface B3's T4 rebuilds on the shared picker. So this
// lands FIRST, against the palette as it stands, and T4 must leave it green.
//
// WHAT IS DELIBERATELY NOT HERE. The plan's fourth case was "Escape steps back
// one sub-flow level". B2 deleted the board verbs and with them the entire
// step machine (`command-palette.tsx:115-120` is the comment of record) — there
// are no sub-flows left to step back through, so testing it would pin a feature
// that no longer exists. Escape is plain Radix dismiss, asserted as such.

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.describe('the command palette answers its keyboard', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('toggles closed, wraps at the ends, and keeps the highlight in view', async ({
    page,
  }) => {
    test.setTimeout(75_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    })

    const A = api(backend)
    // Enough sessions that the list overflows the palette's 420 px / 60vh box —
    // an 11px-tall row list that fits entirely on screen cannot prove anything
    // about scroll-follow.
    for (let i = 0; i < 14; i++) {
      const name = `pk-${String(i).padStart(2, '0')}`
      expect(
        (await A.createSession({ name, provider: 'shell', dir: backend.dataDir })).status,
      ).toBe(201)
    }

    await page.goto(`${backend.baseUrl}/`)
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 })

    const list = page.getByRole('listbox', { name: 'Palette results' })
    // `combobox`, not `textbox`: the input carries role="combobox" since the
    // a11y fix (it owns a listbox and points at the highlighted option through
    // aria-activedescendant). The role IS the behaviour change — the reason
    // this line moved is asserted in palette-keyboard-only.spec.ts.
    const input = page.getByRole('combobox', { name: 'Command palette' })

    // ── ⌘K TOGGLES, it does not merely open ────────────────────────────────
    // The listener is `setOpen((v) => !v)`, and the second press has to reach it
    // — capture-phase, `preventDefault`, over a Radix dialog that is itself
    // holding focus. A palette that only ever opened would trap a user who
    // reached for the shortcut twice.
    await page.keyboard.press('Meta+k')
    await expect(list).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Meta+k')
    await expect(list).toBeHidden({ timeout: 10_000 })

    // Ctrl+K is the same gesture on a non-mac keyboard, and the browser wants
    // it for the address bar — hence the `preventDefault`.
    await page.keyboard.press('Control+k')
    await expect(list).toBeVisible({ timeout: 10_000 })

    const options = list.getByRole('option')
    await expect(options.first()).toBeVisible({ timeout: 10_000 })
    const count = await options.count()
    expect(count).toBeGreaterThan(12)

    const selectedIndex = async () => {
      const flags = await options.evaluateAll((els) =>
        els.map((el) => el.getAttribute('aria-selected') === 'true'),
      )
      // Exactly ONE highlight. Two would mean keyboard and pointer disagree
      // about which row Enter takes.
      expect(flags.filter(Boolean).length).toBe(1)
      return flags.indexOf(true)
    }

    // The palette opens on the first row, most-relevant-first.
    expect(await selectedIndex()).toBe(0)

    // ── ArrowUp from the top WRAPS to the bottom ────────────────────────────
    // `(i - 1 + len) % len`. Off-by-one here is invisible until a list is long,
    // and then it silently strands the highlight at the top.
    await page.keyboard.press('ArrowUp')
    expect(await selectedIndex()).toBe(count - 1)

    // ── ArrowDown from the bottom WRAPS to the top ──────────────────────────
    await page.keyboard.press('ArrowDown')
    expect(await selectedIndex()).toBe(0)

    // ── 12 downs, and the highlight is still on screen ──────────────────────
    // This is the defect the consolidation exists to spread: the palette
    // scrolls its active row into view, the chat picker (the same list, copied)
    // forgot to. B3 moves the mechanism into the primitive; this asserts the
    // palette had it first and still does.
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown')
    expect(await selectedIndex()).toBe(12)

    const visible = await list.evaluate((box) => {
      const active = box.querySelector('[aria-selected="true"]')
      if (!active) return null
      const a = active.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      // "In view" means inside the SCROLL BOX, not merely inside the window —
      // a row 200 px below the fold is still in the document.
      return a.top >= b.top - 1 && a.bottom <= b.bottom + 1
    })
    expect(visible).toBe(true)

    // ── Escape closes it, once, cleanly ────────────────────────────────────
    await input.fill('pk-')
    await expect(options.first()).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(list).toBeHidden({ timeout: 10_000 })

    // ── ...and re-opening starts CLEAN ─────────────────────────────────────
    // The query and the highlight reset on the open transition, so the palette
    // never reappears mid-search from a filter the user has forgotten typing.
    await page.keyboard.press('Meta+k')
    await expect(list).toBeVisible({ timeout: 10_000 })
    await expect(input).toHaveValue('')
    expect(await selectedIndex()).toBe(0)
  })
})

test.describe('the palette does not eat the keyboard', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  // TWO defects, one gesture apart, both of them WCAG 2.4.3/2.4.7:
  //
  //   · Tab inside the open palette moved DOM focus onto the option buttons.
  //     Every row was a natural tab stop, so after three Tabs the focus ring sat
  //     on `#command-palette-option-2` while `aria-selected` and
  //     `aria-activedescendant` were still on option-0 — two cursors, and typing
  //     went to a <button> and vanished. Enter then picked the HIGHLIGHTED row,
  //     not the focused one.
  //   · Escape dropped focus to <body>, so the next Tab landed on "Skip to
  //     content" — a keyboard user was thrown back to the top of the document
  //     every time they dismissed the palette.
  //
  // Neither was covered: no palette spec had ever pressed Tab, and the Escape
  // assertion stopped at "the listbox is hidden".
  test('Tab keeps the caret in the box, and Escape hands focus back', async ({ page }) => {
    test.setTimeout(75_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    })

    const A = api(backend)
    for (let i = 0; i < 4; i++) {
      const name = `tab-${i}`
      expect(
        (await A.createSession({ name, provider: 'shell', dir: backend.dataDir })).status,
      ).toBe(201)
    }

    await page.goto(`${backend.baseUrl}/`)
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 })

    const list = page.getByRole('listbox', { name: 'Palette results' })
    const input = page.getByRole('combobox', { name: 'Command palette' })

    // Give the page a real, identifiable OPENER — the first tab stop on the
    // document, which is also where the bug used to dump you.
    await page.keyboard.press('Tab')
    const opener = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return { tag: el?.tagName ?? '', text: (el?.textContent ?? '').trim() }
    })
    expect(opener.tag).not.toBe('BODY')

    await page.keyboard.press('Control+k')
    await expect(list).toBeVisible({ timeout: 10_000 })
    await expect(input).toBeFocused()

    // ── Tab does not walk onto the rows ─────────────────────────────────────
    for (let i = 0; i < 3; i++) await page.keyboard.press('Tab')
    const afterTabs = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return { role: el?.getAttribute('role') ?? '', id: el?.id ?? '' }
    })
    expect(afterTabs.role).not.toBe('option')
    expect(afterTabs.id).not.toMatch(/command-palette-option/)

    // ── …so typing still reaches the box ────────────────────────────────────
    // This is the user-visible half: before the fix the keystrokes went to a
    // <button> and the query stayed "".
    await input.focus()
    await page.keyboard.type('tab-')
    await expect(input).toHaveValue('tab-')

    // ── Escape hands focus back to the opener, not to <body> ────────────────
    await page.keyboard.press('Escape')
    await expect(list).toBeHidden({ timeout: 10_000 })
    const restored = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return { tag: el?.tagName ?? '', text: (el?.textContent ?? '').trim() }
    })
    expect(restored.tag).not.toBe('BODY')
    expect(restored).toEqual(opener)
  })
})

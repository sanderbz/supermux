// The palette, driven with ZERO mouse events: open → type → arrow → Enter →
// land, and announced correctly the whole way.
//
// WHY IT IS SEPARATE FROM palette-keys.spec.ts. That spec asserts the highlight
// ARITHMETIC (toggle, wrap, scroll-follow) and it is green — it was green while
// three separate keyboard defects shipped, because none of them is arithmetic:
//
//   * the input was not a combobox (role/aria-controls/aria-activedescendant/
//     aria-expanded all null, option ids all empty), so a screen-reader user
//     arrowing through results was told nothing at all;
//   * the palette could not NAVIGATE — an empty query offered four headings and
//     none of them was a destination, `settings` returned zero rows;
//   * the ranker had no floor, so a query that matched nothing still offered a
//     slash command, and Enter on it WROTE into a live session.
//
// So this asserts the properties, not the elements: the relationship resolves
// to the row that is actually highlighted, and a keyboard-only journey ends on
// the page the user asked for.

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.describe('the palette is usable with the keyboard alone', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('announces the highlighted row, and navigates to Settings without a mouse', async ({
    page,
  }) => {
    test.setTimeout(75_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    })

    const A = api(backend)
    expect(
      (await A.createSession({ name: 'pkb-one', provider: 'shell', dir: backend.dataDir }))
        .status,
    ).toBe(201)

    await page.goto(`${backend.baseUrl}/`)
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 })

    const list = page.getByRole('listbox', { name: 'Palette results' })
    const input = page.getByRole('combobox', { name: 'Command palette' })

    // ── open ────────────────────────────────────────────────────────────────
    await page.keyboard.press('Control+k')
    await expect(list).toBeVisible({ timeout: 10_000 })

    // ── it IS a combobox, and it points at a row that exists ────────────────
    // The four attributes, then the thing they are for: the id in
    // `aria-activedescendant` has to resolve to the element carrying
    // `aria-selected="true"`. Asserting the attributes alone would pass on a
    // pair of ids that never met.
    await expect(input).toHaveAttribute('aria-autocomplete', 'list')
    await expect(input).toHaveAttribute('aria-expanded', 'true')
    const listboxId = await list.getAttribute('id')
    expect(listboxId).toBeTruthy()
    await expect(input).toHaveAttribute('aria-controls', listboxId!)

    const pointsAtHighlight = async () =>
      page.evaluate(() => {
        const box = document.querySelector<HTMLInputElement>('input[role="combobox"]')
        const id = box?.getAttribute('aria-activedescendant')
        if (!id) return 'no aria-activedescendant'
        const target = document.getElementById(id)
        if (!target) return `aria-activedescendant "${id}" resolves to nothing`
        return target.getAttribute('aria-selected') === 'true'
          ? 'ok'
          : `"${id}" is not the highlighted row`
      })

    expect(await pointsAtHighlight()).toBe('ok')

    // ── the "Esc" hint is READABLE ──────────────────────────────────────────
    // The dialog's own close ✕ is `absolute right-4 top-4` and overlapped the
    // Kbd chip by 16px at every desktop width, rendering it as "Es✕". Two
    // controls whose boxes intersect is a geometry fact, so assert the
    // geometry rather than a class.
    const esc = page.getByText('Esc', { exact: true })
    const close = page.getByRole('button', { name: 'Close' })
    const [escBox, closeBox] = await Promise.all([esc.boundingBox(), close.boundingBox()])
    expect(escBox, 'the Esc chip is on screen').toBeTruthy()
    expect(closeBox, 'the close ✕ is on screen').toBeTruthy()
    expect(
      escBox!.x + escBox!.width <= closeBox!.x || closeBox!.x + closeBox!.width <= escBox!.x,
      `Esc ${JSON.stringify(escBox)} overlaps ✕ ${JSON.stringify(closeBox)}`,
    ).toBe(true)

    // ── it moves WITH the highlight ─────────────────────────────────────────
    const before = await input.getAttribute('aria-activedescendant')
    await page.keyboard.press('ArrowDown')
    await expect(input).not.toHaveAttribute('aria-activedescendant', before!)
    expect(await pointsAtHighlight()).toBe('ok')

    // ── the palette can reach a PAGE ────────────────────────────────────────
    // `settings` returned zero rows before this fase. It now opens a "Go to"
    // group, and the row is reachable by typing + arrowing + Enter.
    await page.keyboard.type('settings')
    await expect(list.getByRole('option').first()).toBeVisible({ timeout: 10_000 })
    await expect(list.getByText('Go to', { exact: true })).toBeVisible()

    const options = list.getByRole('option')
    // Walk to the Settings row by keyboard only — no click, no hover.
    const target = 'Settings'
    for (let i = 0; i < 20; i++) {
      const labels = await options.evaluateAll((els) =>
        els.map((el) => ({
          text: el.textContent ?? '',
          on: el.getAttribute('aria-selected') === 'true',
        })),
      )
      const active = labels.find((l) => l.on)
      expect(active).toBeTruthy()
      if (active!.text.includes(target)) break
      await page.keyboard.press('ArrowDown')
    }
    expect(await pointsAtHighlight()).toBe('ok')

    await page.keyboard.press('Enter')
    await expect(list).toBeHidden({ timeout: 10_000 })
    await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 })

    // ── the relevance floor, end to end ─────────────────────────────────────
    // `zzqx` matches nothing. Before the floor, a scattered subsequence over a
    // command's DESCRIPTION scored 200+ and offered a row whose Enter POSTs
    // into a live session — so "no match" has to really mean no rows.
    await page.keyboard.press('Control+k')
    await expect(list).toBeVisible({ timeout: 10_000 })
    await page.keyboard.type('zzqx')
    await expect(list.getByRole('option')).toHaveCount(0, { timeout: 10_000 })
    await expect(list.getByText('No match for')).toBeVisible()

    // ── and `dark` answers with the theme, not with a slash command ─────────
    // The live symptom of the missing floor: `dark` offered /supermux-schedule
    // as its ONLY row. It is now what a user typing "dark" actually wants.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+k')
    await expect(list).toBeVisible({ timeout: 10_000 })
    await page.keyboard.type('dark')
    await expect(list.getByRole('option').first()).toBeVisible({ timeout: 10_000 })
    const rowText = await list
      .getByRole('option')
      .evaluateAll((els) => els.map((el) => el.textContent ?? ''))
    expect(rowText.some((t) => /theme/i.test(t)), rowText.join(' | ')).toBe(true)
    expect(rowText.some((t) => t.trim().startsWith('/')), rowText.join(' | ')).toBe(false)
  })
})

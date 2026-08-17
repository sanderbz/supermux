// The roster's front door, against a real backend: the keyboard reaches it, the
// per-session actions exist in the SHIPPING DEFAULT, and the attention tiers are
// visible and two-way.
//
// Three shipped-but-unshipped claims are pinned here, all measured on the
// default overview (Smart sort — the mode the app boots in, and the one every
// earlier check skipped by switching to Custom first):
//
//   T8.3 "list semantics AND a roving tabindex so a 40-session roster is not 40
//        tab stops" — was checked in the ledger while the roster measured 38
//        tabbables and arrow keys moved nothing.
//   T7   Pin / Rename / Info / Mark unread — all three named entry points were
//        absent by default, because the only menu that carried them lived inside
//        the custom-mode grid.
//   T5   the three-tier attention model — `unread` was computed and drawn
//        nowhere, and the desktop focus route never wrote a seen cursor on a
//        cold load, so the tier could not even be entered.
//
// Every assertion here is about a PROPERTY (focus moved / the panel opened / the
// dot changed), never about an element existing: asserting existence is what let
// all three of these ship green.

import { expect, test, type Page } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

const SESSIONS = ['rk-alpha', 'rk-bravo', 'rk-charlie', 'rk-delta']

/** The roster's own list — scoped away from the team card, which renders a lead
 *  tile outside every session list. */
const ROSTER_LIST = 'main [role="list"]'

async function seed(backend: Backend): Promise<void> {
  for (const name of SESSIONS) {
    const res = await api(backend).createSession({
      name,
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(res.status, `create ${name}`).toBe(201)
  }
}

/** The session name of the currently focused roster item, or null. */
function focusedName(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return el?.getAttribute('data-roving-item') ?? null
  })
}

test.describe('roster keyboard + actions', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
    await seed(backend)
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('the roster is ONE tab stop and the arrows choose the row', async ({ page }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(backend.baseUrl)
    await expect(page.getByRole('button', { name: /rk-alpha/ }).first()).toBeVisible()

    // ── the tab stops ────────────────────────────────────────────────────────
    // Exactly one tabbable item per list. This is the whole point of a composite
    // widget: Tab steps PAST the roster to the next region instead of walking
    // every session in it.
    const counts = await page.evaluate((sel) => {
      const lists = [...document.querySelectorAll(sel)]
      return lists.map((list) => ({
        items: list.querySelectorAll('[data-roving-item]').length,
        stops: list.querySelectorAll('[data-roving-item][tabindex="0"]').length,
      }))
    }, ROSTER_LIST)
    const roster = counts.filter((c) => c.items > 0)
    expect(roster.length, 'the sessions are inside a role=list').toBeGreaterThan(0)
    for (const list of roster) {
      expect(list.items, 'more than one session in the list').toBeGreaterThan(1)
      expect(list.stops, 'exactly one tab stop for the whole list').toBe(1)
    }

    // ── the arrows ───────────────────────────────────────────────────────────
    await page.evaluate((sel) => {
      const first = document.querySelector<HTMLElement>(`${sel} [data-roving-item]`)
      first?.focus()
    }, ROSTER_LIST)
    const first = await focusedName(page)
    expect(first, 'a roster item took focus').not.toBeNull()

    // The default overview is the tile grid, so BOTH axes must move — a user who
    // learned ArrowDown in list view should not find it inert in tiles.
    await page.keyboard.press('ArrowRight')
    const afterRight = await focusedName(page)
    expect(afterRight, 'ArrowRight moved the focus').not.toBe(first)

    await page.keyboard.press('ArrowLeft')
    expect(await focusedName(page), 'ArrowLeft came back').toBe(first)

    await page.keyboard.press('ArrowDown')
    expect(await focusedName(page), 'ArrowDown moved the focus').not.toBe(first)

    await page.keyboard.press('End')
    const last = await focusedName(page)
    expect(last, 'End jumped somewhere else').not.toBe(first)

    await page.keyboard.press('Home')
    expect(await focusedName(page), 'Home returned to the first row').toBe(first)

    // The tab stop FOLLOWS the arrows — otherwise Shift+Tab back into the roster
    // would dump the user on row 0 again, which is the bug the pattern exists to
    // avoid.
    await page.keyboard.press('End')
    const stopIsLast = await page.evaluate(
      (sel) =>
        document
          .querySelector(`${sel} [data-roving-item][tabindex="0"]`)
          ?.getAttribute('data-roving-item') ?? null,
      ROSTER_LIST,
    )
    expect(stopIsLast).toBe(last)
  })

  test('Pin / Rename / Info / Mark unread are reachable in the DEFAULT sort', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(backend.baseUrl)
    await expect(page.getByRole('button', { name: /rk-alpha/ }).first()).toBeVisible()

    // No Display → Sort → Custom detour: this is the mode the app boots in.
    const kebab = page.locator('[data-vr="tile-kebab"]').first()
    await expect(kebab, 'the action menu exists on the default overview').toBeVisible()
    await kebab.click()

    for (const label of ['Info', 'Mark unread', 'Rename', 'Pin']) {
      await expect(page.getByRole('menuitem', { name: label })).toBeVisible()
    }

    // Info must actually OPEN. It used to close the menu and render nothing:
    // the menu's dismiss returns focus to its trigger, and the info popover is
    // anchored to that same trigger, so the restore dismissed it in the same
    // frame.
    await page.getByRole('menuitem', { name: 'Info' }).click()
    await expect(page.getByText('Working dir')).toBeVisible()
  })

  test('Rename opens the same panel with its name editor armed', async ({ page }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(backend.baseUrl)
    await expect(page.getByRole('button', { name: /rk-alpha/ }).first()).toBeVisible()

    await page.locator('[data-vr="tile-kebab"]').first().click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    // Same panel, one rename path — the editor is armed rather than a second
    // rename surface existing.
    await expect(page.getByText('Working dir')).toBeVisible()
    await expect(page.locator('input:focus')).toBeVisible()
  })

  test('an unread session is VISIBLY different from a quiet one', async ({ page }) => {
    // The cursor is planted directly rather than produced by a round trip: what
    // is under test is the render, and the arithmetic that gets a row into the
    // tier has its own suite (`tests/unit/attention-tiers.test.ts`).
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(
      ([name]) => {
        // A cursor from 1970 — every row has spoken since.
        localStorage.setItem('supermux:seen', JSON.stringify({ [name!]: { ts: 1 } }))
      },
      [SESSIONS[0]],
    )
    await page.goto(backend.baseUrl)
    await expect(page.getByRole('button', { name: /rk-alpha/ }).first()).toBeVisible()

    const dot = page.locator(
      `[data-roving-item="${SESSIONS[0]}"] [data-vr="tile-attention-dot"]`,
    )
    await expect(dot, 'the unread row draws a dot').toHaveCount(1)
    await expect(dot).toHaveAttribute('data-attention-kind', 'unread')

    // …and a session with NO cursor stays quiet. Never-opened is deliberately
    // not unread: a fresh install must not light up every row at once.
    await expect(
      page.locator(`[data-roving-item="${SESSIONS[1]}"] [data-vr="tile-attention-dot"]`),
      'a never-opened row stays quiet',
    ).toHaveCount(0)
  })

  test('the Display popover offers only controls that decide something', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(backend.baseUrl)
    await expect(page.getByRole('button', { name: /rk-alpha/ }).first()).toBeVisible()

    const panel = page.locator('[data-vr="display-controls"]')
    const open = async () => {
      await page.getByRole('button', { name: 'Display options' }).click()
      await expect(panel).toBeVisible()
    }

    // (a) Density is reachable in LIST view, under the name it earns there. The
    //     same number drives the list's fact ladder (tier 2 the preview line, 3
    //     the tokens, 4 the tag chips) and the control was hidden in exactly
    //     that view — so the only route to a list's richer rungs was: switch to
    //     Tiles, raise it, switch back.
    await open()
    await panel.getByRole('button', { name: 'List', exact: true }).click()
    await expect(panel.getByText('Row detail')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'More row detail' })).toBeEnabled()

    // …and it is still called Density in tiles: one number, two honest names.
    await panel.getByRole('button', { name: 'Tiles', exact: true }).click()
    await expect(panel.getByText('Density')).toBeVisible()

    // (b) Group-by decides nothing while the order is hand-dragged — GroupGrid
    //     owns the canvas in custom mode. It used to keep its state and draw its
    //     checkmark while regrouping nothing.
    const byFolder = panel.getByRole('button', { name: /Folder/ })
    await expect(byFolder).toBeEnabled()
    await panel.getByRole('button', { name: /^Custom Drag to reorder/ }).click()
    await expect(byFolder).toBeDisabled()
    await expect(
      panel.getByText('Custom sort uses your own groups — switch Sort to use a preset.'),
    ).toBeVisible()
  })

  test('a COLD load of a focus route records the seen cursor', async ({ page }) => {
    // The entry defect: the desktop route keyed its markRead effect on `[name]`
    // alone while `current` is undefined on the first render, so a bookmark, a
    // refresh or a link wrote no cursor at all — and without a cursor the tier
    // function reports `quiet` for that session forever.
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(`${backend.baseUrl}/focus/${SESSIONS[0]}`)
    await expect(page.getByText(SESSIONS[0]!).first()).toBeVisible()

    await expect
      .poll(
        () =>
          page.evaluate((name) => {
            const raw = localStorage.getItem('supermux:seen')
            if (!raw) return null
            return (JSON.parse(raw) as Record<string, { ts: number }>)[name]?.ts ?? null
          }, SESSIONS[0]),
        { message: 'a cold load writes a seen cursor for the session it opened' },
      )
      .toBeGreaterThan(0)
  })
})

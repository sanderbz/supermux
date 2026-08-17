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

  test('the roving tabindex holds in ALL FOUR modes, and the kebab is not a stop', async ({
    page,
  }) => {
    // It shipped in ONE of the four: tiles/smart. List view carried an extra
    // `div[tabindex=0]` per row (framer-motion makes a `whileTap` element
    // focusable), and BOTH custom modes had no provider at all — measured
    // `{0: 22, -1: 0}` on an 11-session roster with every arrow inert, because
    // `tile.tsx` falls back to a literal `0` outside a provider. The ⋯ trigger
    // was a peer stop on top of that, so a 40-session roster was 41 stops.
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(backend.baseUrl)
    await expect(page.getByRole('button', { name: /rk-alpha/ }).first()).toBeVisible()

    const panel = page.locator('[data-vr="display-controls"]')
    const setMode = async (view: 'Tiles' | 'List', sort: 'Smart' | 'Custom') => {
      await page.getByRole('button', { name: 'Display options' }).click()
      await expect(panel).toBeVisible()
      await panel.getByRole('button', { name: view, exact: true }).click()
      await panel.getByRole('button', { name: new RegExp(`^${sort} `) }).click()
      await page.keyboard.press('Escape')
      await expect(panel).toBeHidden()
    }

    for (const view of ['Tiles', 'List'] as const) {
      for (const sort of ['Smart', 'Custom'] as const) {
        const mode = `${view}/${sort}`
        await setMode(view, sort)
        await expect(page.locator(`${ROSTER_LIST} [data-roving-item]`).first()).toBeVisible()

        const shape = await page.evaluate((sel) => {
          const lists = [...document.querySelectorAll(sel)].filter(
            (l) => l.querySelectorAll('[data-roving-item]').length > 0,
          )
          return {
            lists: lists.map((l) => ({
              items: l.querySelectorAll('[data-roving-item]').length,
              stops: l.querySelectorAll('[data-roving-item][tabindex="0"]').length,
            })),
            // Every stray stop the roster used to grow: the framer tap wrapper
            // (`whileTap` makes an element focusable) and the ⋯ trigger. Both
            // are inside the list, so both are counted here.
            //
            // dnd-kit's own drag handles are EXCLUDED and stay in the tab
            // order: in custom mode they are the only keyboard path to reorder
            // a roster (`KeyboardSensor` is wired), so taking their stop away
            // would trade one a11y defect for a worse one.
            strays: lists.reduce(
              (n, l) =>
                n +
                [...l.querySelectorAll<HTMLElement>('[tabindex="0"]')].filter(
                  (el) =>
                    !el.hasAttribute('data-roving-item') &&
                    el.getAttribute('aria-roledescription') !== 'sortable',
                ).length,
              0,
            ),
            kebabsInTabOrder: [
              ...document.querySelectorAll<HTMLElement>('[data-vr="tile-kebab"]'),
            ].filter((el) => el.tabIndex >= 0).length,
          }
        }, ROSTER_LIST)

        expect(shape.lists.length, `${mode}: the sessions are in a role=list`).toBeGreaterThan(0)
        for (const list of shape.lists) {
          expect(list.items, `${mode}: more than one row`).toBeGreaterThan(1)
          expect(list.stops, `${mode}: exactly one tab stop for the list`).toBe(1)
        }
        expect(shape.strays, `${mode}: no stray tab stops inside the list`).toBe(0)
        expect(shape.kebabsInTabOrder, `${mode}: the ⋯ trigger is not a tab stop`).toBe(0)

        // …and the arrows move, which is the half that was inert in custom mode.
        await page.evaluate((sel) => {
          document.querySelector<HTMLElement>(`${sel} [data-roving-item]`)?.focus()
        }, ROSTER_LIST)
        const first = await focusedName(page)
        expect(first, `${mode}: a roster item took focus`).not.toBeNull()
        await page.keyboard.press('ArrowDown')
        expect(await focusedName(page), `${mode}: ArrowDown moved`).not.toBe(first)
        await page.keyboard.press('Home')
        expect(await focusedName(page), `${mode}: Home came back`).toBe(first)
      }
    }
  })

  test('Shift+F10 on the focused row opens its action menu', async ({ page }) => {
    // The replacement for the kebab's own tab stop: the platform's own
    // secondary-action keys on the row that already owns the tab stop.
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(backend.baseUrl)
    await expect(page.getByRole('button', { name: /rk-alpha/ }).first()).toBeVisible()

    await page.evaluate((sel) => {
      document.querySelector<HTMLElement>(`${sel} [data-roving-item]`)?.focus()
    }, ROSTER_LIST)
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menuitem', { name: 'Mark unread' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: 'Mark unread' })).toBeHidden()
  })

  test('in the tile grid ArrowDown moves DOWN a row, not right one item', async ({
    page,
  }) => {
    // The grid pattern the roving module cites, and the half that shipped as
    // `±1` on every arrow: in a multi-column roster ArrowDown was byte-identical
    // to ArrowRight, so reaching the tile visually below took one press per
    // column. Asserted as GEOMETRY (the landing tile is lower and roughly in the
    // same column), never as an index, because the index is what was wrong.
    await page.setViewportSize({ width: 760, height: 900 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(backend.baseUrl)
    await expect(page.getByRole('button', { name: /rk-alpha/ }).first()).toBeVisible()

    const boxes = async () =>
      page.evaluate((sel) => {
        const items = [...document.querySelectorAll<HTMLElement>(`${sel} [data-roving-item]`)]
        return items.map((el) => {
          const r = el.getBoundingClientRect()
          return { name: el.getAttribute('data-roving-item'), top: r.top, left: r.left }
        })
      }, ROSTER_LIST)

    const grid = await boxes()
    expect(grid.length, 'four seeded tiles').toBeGreaterThan(3)
    const columns = grid.filter((b) => Math.abs(b.top - grid[0]!.top) <= 4).length
    expect(columns, 'the 760px viewport wraps the grid into rows').toBeGreaterThan(1)
    expect(columns, '…and is not one flat row').toBeLessThan(grid.length)

    await page.evaluate((sel) => {
      document.querySelector<HTMLElement>(`${sel} [data-roving-item]`)?.focus()
    }, ROSTER_LIST)
    await page.keyboard.press('ArrowDown')

    const landed = await focusedName(page)
    const first = grid[0]!
    const target = grid.find((b) => b.name === landed)
    expect(target, 'ArrowDown landed on a roster tile').toBeTruthy()
    expect(target!.top, 'the landing tile is on a LOWER visual row').toBeGreaterThan(first.top)
    expect(
      Math.abs(target!.left - first.left),
      'and in the same column — not simply the next item',
    ).toBeLessThan(4)
  })

  test('Mark unread lights the row up, and the cursor survives the next load', async ({
    page,
  }) => {
    // The two halves of "Mark unread is a no-op end to end":
    //   (a) the RENDER — clicking the item must light the row up in this frame,
    //       not on the next unrelated invalidation. Asserted on the row the
    //       click acted on, with a short timeout, because "it appears when you
    //       pin something else" is exactly what shipped.
    //   (b) the STORAGE — the roster's prune effect split the NUL-joined roster
    //       signature on a space, so `live` was one NUL-joined string that
    //       matched no session name, every cursor was judged dead and the whole
    //       map was rewritten to `{}` on the first render after boot.
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(backend.baseUrl)
    await expect(page.getByRole('button', { name: /rk-alpha/ }).first()).toBeVisible()

    const row = page.locator(`[data-roving-item="${SESSIONS[0]}"]`)
    const dot = row.locator('[data-vr="tile-attention-dot"]')
    await expect(dot, 'the row starts quiet').toHaveCount(0)

    await page
      .locator(`[data-vr="tile-kebab"][data-vr-session-name="${SESSIONS[0]}"]`)
      .click()
    await page.getByRole('menuitem', { name: 'Mark unread' }).click()

    await expect(dot, 'the dot arrives on the click, not on the next re-render').toHaveAttribute(
      'data-attention-kind',
      'unread',
      { timeout: 2_000 },
    )

    // …and the cursor is still there after a reload — the prune must drop only
    // cursors whose session is really gone.
    await page.reload()
    await expect(page.getByRole('button', { name: /rk-alpha/ }).first()).toBeVisible()
    await expect
      .poll(
        () =>
          page.evaluate((name) => {
            const raw = localStorage.getItem('supermux:seen')
            if (!raw) return null
            const map = JSON.parse(raw) as Record<string, { unread?: boolean }>
            return map[name]?.unread ?? null
          }, SESSIONS[0]),
        { message: 'the prune keeps a live session’s cursor' },
      )
      .toBe(true)
    await expect(dot, 'and the row is still unread after the reload').toHaveAttribute(
      'data-attention-kind',
      'unread',
    )
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
    //     The rung ladder itself is content-bounded (finding 46): the list's
    //     top rungs add token counts and tag chips, and on a roster where no
    //     session has either, raising the density rendered a byte-identical
    //     row — a last step that changes nothing reads as broken. So the "+"
    //     is reachable here, and where it can no longer add a fact it is
    //     disabled WITH the reason, never silently inert.
    const moreDetail = panel.getByRole('button', { name: 'More row detail' })
    await expect(moreDetail).toBeEnabled()
    // Walk it to its ceiling: either it reaches the ladder's top rung, or it
    // stops early WITH the reason on screen. What it may never do is stop
    // silently, which is what "tier 4 was identical to tier 3" looked like.
    for (let i = 0; i < 3 && (await moreDetail.isEnabled()); i++) await moreDetail.click()
    if (await moreDetail.isDisabled()) {
      await expect(
        panel.getByText(/More detail would add/),
        'a disabled last step says why',
      ).toBeVisible()
    }

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

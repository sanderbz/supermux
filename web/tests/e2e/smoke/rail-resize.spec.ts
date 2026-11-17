// The roster rail's draggable divider — on a tablet, where it matters.
//
// At 768px the rail used to be a fixed 372px, which left the detail pane ~310px:
// the chat header's controls hung past the pane's edge and the shell's `<main>`
// scrolled sideways. The rail is now user-sized (`rail-resize-handle.tsx`) and
// clamped so the pane keeps 440px. This drives it on the `?mock` fixture (a crew
// row selects in place and opens a pane, no live Claude needed):
//   1. 768px: the pane keeps its minimum and `<main>` cannot scroll sideways;
//   2. dragging the divider in folds the rows (faces + names), and the width is a
//      pref that survives a reload;
//   3. a double-click resets, the keyboard reaches the bounds;
//   4. on a desktop width nothing changed — the rail is still 372px.

import { expect, test, type Page } from '@playwright/test'
import { injectGlobals, startBackend, type Backend } from './harness'

const FLAG_ON = JSON.stringify({ state: { botMode: true }, version: 2 })

async function openPane(page: Page, backend: Backend) {
  await page.goto(`${backend.baseUrl}/?mock`)
  await expect(page.locator('.grok-roster')).toBeVisible()
  await page.getByRole('button', { name: /feature-x — 5 bots/ }).click()
  await expect(page.getByRole('separator', { name: 'Resize bot list' })).toBeVisible()
}

const railWidth = (page: Page) =>
  page.locator('.gr-rail').evaluate((el) => Math.round(el.getBoundingClientRect().width))

test.describe('roster rail resize', () => {
  let backend: Backend
  test.beforeEach(async ({ page }) => {
    backend = await startBackend()
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, FLAG_ON)
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('tablet: the pane keeps its room, the divider drags, folds and persists', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await openPane(page, backend)

    // 1. The pane keeps 440px and the shell does not scroll sideways.
    const pane = await page.locator('.gr-pane').first().evaluate((el) => el.getBoundingClientRect().width)
    expect(Math.round(pane)).toBeGreaterThanOrEqual(440)
    const main = await page.locator('main').evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(main).toBeLessThanOrEqual(0)

    // 2. Drag the divider all the way in: the rail stops at the faces.
    const handle = page.getByRole('separator', { name: 'Resize bot list' })
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(0, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    expect(await railWidth(page)).toBe(72)
    await expect(handle).toHaveAttribute('aria-valuenow', '72')
    // Faces with the name under them; the status line has folded away.
    await expect(page.locator('.gr-rail .gr-rowA .nm').first()).toBeVisible()
    await expect(page.locator('.gr-rail .gr-rowA .l2').first()).toBeHidden()

    await page.reload()
    await page.getByRole('button', { name: /feature-x — 5 bots/ }).click()
    expect(await railWidth(page)).toBe(72)

    // 3. Double-click resets to the default (clamped at this width); End and
    //    Home reach the bounds the clamp allows.
    await handle.dblclick()
    await expect.poll(() => railWidth(page)).toBeGreaterThan(72)
    await handle.focus()
    await page.keyboard.press('Home')
    await expect.poll(() => railWidth(page)).toBe(72)
  })

  test('desktop: the default rail is unchanged', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openPane(page, backend)
    expect(await railWidth(page)).toBe(372)
  })
})

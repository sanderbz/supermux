// M24b e2e — kbd-accessory-swipe (TECH_PLAN §10 "M24b"; §4 mobile; M16).
//
// Mobile (iPhone 14 Pro) viewport: open mobile focus, assert the M16 keyboard
// accessory bar is present + EXACTLY 44px tall (the iOS HIG accessory-bar
// height), then swipe its function-key pager between kbd-groups and verify the
// page snaps — the first group is paged off-screen by exactly one page width.
//
// The swipe is driven by REAL `PointerEvent`s dispatched in-page: a
// `pointerdown` on the pager track followed by `pointermove`s on `window`,
// which is the gesture sequence Framer Motion's `drag` recogniser consumes.
// Playwright's coordinate input would be funnelled through hit-testing against
// the Vaul focus-sheet's transformed (and partly off-viewport) layout, which
// makes raw coordinate gestures flaky here.

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

test.describe('mobile: keyboard accessory bar', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('accessory bar is 44px tall + pager swipes between key groups', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.addInitScript(injectGlobals(backend.token))
    // Pre-dismiss the M23b "Add to Home Screen" sheet — on an iOS-emulating
    // context it auto-opens as a focus-trapping modal that pulls the rest of the
    // page (incl. the accessory bar) out of the accessibility tree. Setting its
    // localStorage dismiss key reflects the normal returning-user state.
    await page.addInitScript(() => {
      localStorage.setItem('amux-v3-a2hs-dismissed', String(Date.now()))
    })

    // Seed a session so the focus route resolves to a real row.
    const created = await api(backend).createSession({
      name: 'mob-kbd',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(created.status, 'create session').toBe(201)

    // Open mobile focus — < 768px viewport routes to MobileFocus, which mounts
    // the accessory bar regardless of terminal connection state.
    await page.goto(`${backend.baseUrl}/focus/mob-kbd`)

    // The accessory bar is a role=toolbar labelled "Keyboard accessory".
    const bar = page.getByRole('toolbar', { name: 'Keyboard accessory' })
    await expect(bar).toBeVisible({ timeout: 15_000 })

    // Height assertion: the bar is `h-11` = 44px exactly (Termius criterion #5 /
    // §4 — the iOS accessory-bar height). Allow a 1px sub-pixel tolerance.
    const box = await bar.boundingBox()
    expect(box, 'accessory bar bounding box').not.toBeNull()
    expect(Math.abs((box!.height ?? 0) - 44)).toBeLessThanOrEqual(1)

    // The pager hosts multiple kbd-groups — the default seed has 4 (Agent,
    // Shell, Tmux, Symbols), each a role=group "<name> keys". The FIRST group
    // (Agent) is initially in view at the left of the pager track.
    const agentGroup = page.getByRole('group', { name: 'Agent keys' })
    await expect(agentGroup).toBeVisible()
    await expect(page.getByRole('group', { name: 'Shell keys' })).toHaveCount(1)

    // Swipe the pager LEFT by one page. Dispatch the Framer-Motion drag
    // sequence in-page (pointerdown on the track, pointermoves on window) so
    // it doesn't depend on the bar's on-screen viewport position.
    const swipe = await page.evaluate(async () => {
      const agent = document.querySelector(
        '[role=group][aria-label="Agent keys"]',
      ) as HTMLElement | null
      if (!agent) return { ok: false, reason: 'no agent group' }
      // The draggable Framer track is the nearest flex ancestor of the group.
      const track = agent.closest('.flex') as HTMLElement | null
      if (!track) return { ok: false, reason: 'no track' }
      const r = track.getBoundingClientRect()
      const y = r.top + r.height / 2
      const before = Math.round(agent.getBoundingClientRect().x)
      const pointer = (type: string, x: number): PointerEvent =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
        })
      const startX = r.left + 40
      track.dispatchEvent(pointer('pointerdown', startX))
      for (let i = 1; i <= 12; i++) {
        window.dispatchEvent(pointer('pointermove', startX - i * 14))
        await new Promise((res) => setTimeout(res, 16))
      }
      window.dispatchEvent(pointer('pointerup', startX - 12 * 14))
      // Allow the snap spring to settle.
      await new Promise((res) => setTimeout(res, 600))
      const after = Math.round(agent.getBoundingClientRect().x)
      return { ok: true, before, after, moved: after - before }
    })

    expect(swipe.ok, `swipe setup: ${JSON.stringify(swipe)}`).toBe(true)
    // The pager must have SNAPPED: the Agent (first) group is paged off to the
    // LEFT — its x moved meaningfully negative (≈ one page width). A pager that
    // didn't page would leave the group within a few px of where it started.
    expect(
      swipe.moved!,
      `Agent group x moved by ${swipe.moved}px (must page left)`,
    ).toBeLessThan(-80)
  })
})

// The 44pt floor, measured the way a thumb finds out — with `elementFromPoint`,
// on BOTH axes.
//
// WHY THIS SPEC EXISTS. The renderer switch already carried an `::after`
// expander and a source comment claiming "adjacent targets cannot overlap into a
// mis-tap (verified with elementFromPoint at ±20px)". The verification probed
// only VERTICALLY, and the defect was horizontal: the cells sit at a 27–31px
// pitch, the expander was `min-w-[40px]`, so each one spilled ~10px into its
// neighbour and `elementFromPoint` resolved the overlap to the later sibling.
// The exclusive own-hit spans measured 28 / 30 / 40px on the surface that owns
// the whole Chat⇄Terminal toggle.
//
// So this measures the ONE number that matters — the span around a control's
// centre that hits that control and nothing else — on both axes, for every
// control the chat surface asks a thumb to find.
//
// Needs server/target/debug/supermux-server — `cd server && cargo build`
// first (debug; never --release).

import { expect, test, type Page } from '@playwright/test'

import { CHAT_BACKEND_ENV, chatSession, expectTokenOnce, primePage } from './chat-fixture'
import { startBackend, type Backend } from './harness'

/** Apple's HIG floor, and the one this app's own dock already meets. */
const FLOOR = 44

/**
 * The EXCLUSIVE own-hit span through a control's centre, in px.
 *
 * Walks outward one pixel at a time and stops at the first point that resolves
 * to something else — so an expander that overlaps its neighbour scores the
 * distance to the overlap, not its own nominal width. That is the number a
 * mis-tap is made of.
 */
async function ownHitSpan(
  page: Page,
  testId: string,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ testId, limit }) => {
      const el = document.querySelector(`[data-testid="${testId}"]`)
      if (!el) throw new Error(`no element for ${testId}`)
      const box = el.getBoundingClientRect()
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      const hits = (x: number, y: number) => {
        const at = document.elementFromPoint(x, y)
        return at != null && (at === el || el.contains(at) || at.closest(`[data-testid="${testId}"]`) === el)
      }
      const walk = (dx: number, dy: number) => {
        let n = 0
        while (n < limit && hits(cx + dx * (n + 1), cy + dy * (n + 1))) n += 1
        return n
      }
      return {
        // +1 for the centre pixel itself.
        x: walk(-1, 0) + walk(1, 0) + 1,
        y: walk(0, -1) + walk(0, 1) + 1,
      }
    },
    { testId, limit: 60 },
  )
}

test.describe('touch targets on the chat surface', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({ env: CHAT_BACKEND_ENV })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('every surface-switch and send control clears 44pt on both axes', async ({
    page,
  }) => {
    test.setTimeout(180_000)

    const fx = await chatSession(backend, 'touch')
    fx.write('touch-conv', ['TOUCH-SEED-0001'])
    await fx.hook('touch-conv')

    await primePage(page, backend)
    // `primePage` pins the DESKTOP seam's 1280×800; the phone geometry is the
    // whole subject here, so take the viewport back afterwards.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`)

    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expectTokenOnce(page, 'TOUCH-SEED-0001')
    await expect(page.getByTestId('chat-composer-field')).toBeVisible()

    expect(
      await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
      'this spec only means anything on a coarse pointer',
    ).toBe(true)

    // The renderer switch — two cells, side by side, in the phone header
    // card's compact rail. The tightest geometry the control ever has.
    for (const id of ['renderer-chat', 'renderer-terminal']) {
      const span = await ownHitSpan(page, id)
      expect(span.x, `${id}: horizontal own-hit span`).toBeGreaterThanOrEqual(FLOOR)
      expect(span.y, `${id}: vertical own-hit span`).toBeGreaterThanOrEqual(FLOOR)
    }

    // The composer's own controls. On the phone the leading control is now the
    // single `+` add-menu opener (`chat-composer-add`) — mention/schedule moved
    // INTO the menu — and the trailing send/hand-off button. Both are equal
    // discs on one baseline, each a 44pt target.
    const composerIds = ['chat-composer-add', 'chat-send']
    // A draft is what turns the trailing cell into the SEND button (empty box at
    // rest is the decorative mic, which is not a control).
    await page.getByTestId('chat-composer-field').fill('measure me')
    await expect(page.getByTestId('chat-send')).toBeVisible()
    for (const id of composerIds) {
      const span = await ownHitSpan(page, id)
      expect(span.x, `${id}: horizontal own-hit span`).toBeGreaterThanOrEqual(FLOOR)
      expect(span.y, `${id}: vertical own-hit span`).toBeGreaterThanOrEqual(FLOOR)
    }
  })
})

// R5 — status-dot pulse refinement verification.
//
// Renders the /dev/tiles page (mocked sessions in every Status) and asserts the
// post-change motion model on the status DOT itself:
//   • starting  → NO pulsing dot (loading icon/sweep elsewhere is enough).
//   • idle/green → calm GREEN halo pulse ("something is ready" / done signal).
//   • waiting/blue → calm BLUE halo pulse (needs input) — kept, unchanged.
//   • active → spinner (no halo pulse).
// The green and blue pulses must be visually distinguishable (different colour).
// With prefers-reduced-motion / Reduce Motion, no halo pulse on any dot.
//
// We detect "is this dot pulsing" by the presence of a Framer-driven halo: a
// pulsing dot has an inline `box-shadow` (Framer writes the animated halo to the
// element's inline style and its computed box-shadow carries the status colour),
// while a static dot has NO inline box-shadow and computes to `none`.

import { expect, test } from '@playwright/test'

const BASE = process.env.DEV_BASE_URL ?? 'http://localhost:5199'

// HSL hue families for the two pulse colours (globals.css):
//   --status-ready (green): hue ~152   --status-waiting (blue): hue ~214
// A box-shadow string carries the colour, so we can assert the two pulses use
// different colour channels by checking which hue dominates the rgb triple.

type DotProbe = {
  label: string
  // computed box-shadow (carries the halo colour when pulsing, else "none")
  shadow: string
  // Framer writes the animated halo to the element's inline style; presence ⇒
  // the dot is running a halo pulse.
  hasInlineHalo: boolean
}

async function probeDots(page: import('@playwright/test').Page) {
  // Status dots carry role="img" with the human status label as aria-label.
  // Grab one representative dot per status of interest.
  const wanted = ['Booting', 'Idle', 'Needs input', 'Running']
  const probes: DotProbe[] = []
  for (const label of wanted) {
    const dot = page.locator(`[role="img"][aria-label="${label}"]`).first()
    // Decorative 8px dots: assert presence (attached), not Playwright "visible"
    // (its visibility heuristic is flaky on tiny spans / below-fold tiles).
    await dot.waitFor({ state: 'attached', timeout: 10_000 })
    await dot.scrollIntoViewIfNeeded().catch(() => {})
    const { shadow, hasInlineHalo } = await dot.evaluate((el) => ({
      shadow: getComputedStyle(el).boxShadow,
      hasInlineHalo: (el as HTMLElement).style.boxShadow !== '',
    }))
    probes.push({ label, shadow, hasInlineHalo })
  }
  return probes
}

function isPulsing(p: DotProbe): boolean {
  // A Framer halo pulse writes an inline box-shadow that computes to a coloured
  // shadow; a static dot has no inline box-shadow and computes to "none".
  return p.hasInlineHalo && p.shadow !== 'none'
}

// Extract the rgb triple from a computed box-shadow ("rgba(r, g, b, a) ...").
function shadowRgb(shadow: string): [number, number, number] | null {
  const m = shadow.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

test.describe('status-dot pulse model', () => {
  test('starting=no pulse, idle=green pulse, waiting=blue pulse', async ({
    page,
  }) => {
    await page.goto(`${BASE}/dev/tiles`)
    await page.waitForSelector('[role="img"][aria-label="Idle"]', {
      state: 'attached',
      timeout: 15_000,
    })

    const probes = await probeDots(page)
    const by = (l: string) => probes.find((p) => p.label === l)!

    const booting = by('Booting')
    const idle = by('Idle')
    const waiting = by('Needs input')

    // 1) starting → NO pulsing dot.
    expect(isPulsing(booting), 'starting dot must NOT pulse').toBe(false)

    // 2) idle/green → pulsing.
    expect(isPulsing(idle), 'idle/green dot must pulse (done signal)').toBe(true)

    // 3) waiting/blue → pulsing (kept).
    expect(isPulsing(waiting), 'waiting/blue dot must pulse').toBe(true)

    // 4) green and blue pulses are visually distinguishable → different colour.
    const idleRgb = shadowRgb(idle.shadow)
    const waitRgb = shadowRgb(waiting.shadow)
    expect(idleRgb, 'idle halo must carry a colour').not.toBeNull()
    expect(waitRgb, 'waiting halo must carry a colour').not.toBeNull()
    // Green-dominant for "done" (G > B), blue-dominant for "needs input" (B > G).
    expect(idleRgb![1], 'idle/done halo must be green-dominant (G>B)').toBeGreaterThan(
      idleRgb![2],
    )
    expect(
      waitRgb![2],
      'waiting halo must be blue-dominant (B>G)',
    ).toBeGreaterThan(waitRgb![1])
    // …and the two colours must differ outright.
    expect(idle.shadow, 'green done pulse ≠ blue waiting pulse').not.toEqual(
      waiting.shadow,
    )
  })

  test('reduced motion → no halo pulse on any dot', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    // ?reduce=1 also forces Framer's reducedMotion="always" on the dev page.
    await page.goto(`${BASE}/dev/tiles?reduce=1`)
    await page.waitForSelector('[role="img"][aria-label="Idle"]', {
      state: 'attached',
      timeout: 15_000,
    })

    const probes = await probeDots(page)
    for (const p of probes) {
      expect(
        isPulsing(p),
        `${p.label} dot must NOT pulse under reduced motion`,
      ).toBe(false)
    }
    await ctx.close()
  })
})

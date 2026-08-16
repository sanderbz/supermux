// Card-glow (StatusBorder) model verification — the "attention" pulse lives on
// the CARD, not the status dot (this was mis-fixed THREE times on the dot).
//
// Renders /dev/tiles (mocked sessions in every Status) and asserts:
//   CARD GLOW (StatusBorder overlay):
//     • active   (loading / working) → NO card glow (the top-right active
//                 spinner dot is the loading signal; the card stays calm).
//     • idle     (done → green)       → a SUBTLE GREEN card glow, and it must be
//                 visibly subtler (lower peak opacity) than the blue waiting glow.
//     • waiting  (needs input → blue) → the BLUE attention card glow.
//     • starting / stopped            → NO card glow.
//   STATUS DOT:
//     • idle + waiting dots are STATIC (no halo pulse) — the earlier green/blue
//       dot halos (commit 4f2bc52) are reverted; the pulse is the card glow now.
//   REDUCED MOTION:
//     • the card glow is STATIC (no pulse) for every status.
//
// We probe the StatusBorder as the only aria-hidden span pinned inset-0 z-10
// rounded-xl that is a DIRECT child of the card; its inline boxShadow (written
// by Framer) carries the glow colour/alpha. A status with no glow renders no
// such element.

import { expect, test } from '@playwright/test'

const BASE = process.env.DEV_BASE_URL ?? 'http://localhost:5199'

type CardProbe = {
  /** the status dot's aria-label, identifying the tile's status */
  label: string
  /** StatusBorder overlay exists for this card? */
  hasGlow: boolean
  /** inline boxShadow Framer wrote on the StatusBorder (carries colour + alpha) */
  inline: string
}

// Read EVERY card's (dotLabel, StatusBorder inline boxShadow) in one pass.
async function probeCards(
  page: import('@playwright/test').Page,
): Promise<CardProbe[]> {
  return page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll('[role="button"]'),
    ).filter((c) => c.querySelector('[role="img"]'))
    return cards.map((c) => {
      const label =
        c.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '?'
      const border = c.querySelector(
        ':scope > span[aria-hidden].pointer-events-none.absolute.inset-0.z-10.rounded-xl',
      ) as HTMLElement | null
      return {
        label,
        hasGlow: !!border,
        inline: border ? border.style.boxShadow : '',
      }
    })
  })
}

// Highest alpha observed across a few samples — the peak of the breath. The
// inline keyframe form is `inset 0 0 0 1.5px hsl(var(--token) / <alpha>)`.
async function peakAlphaFor(
  page: import('@playwright/test').Page,
  label: string,
  samples = 30,
  gapMs = 100,
): Promise<number> {
  let mx = 0
  for (let i = 0; i < samples; i++) {
    const cards = await probeCards(page)
    const c = cards.find((p) => p.label === label)
    const m = c?.inline.match(/\/\s*([\d.]+)\s*\)/)
    if (m) mx = Math.max(mx, Number(m[1]))
    await page.waitForTimeout(gapMs)
  }
  return mx
}

// Is the StatusBorder inline boxShadow constant over a window (STATIC) or does
// it change frame-to-frame (PULSING)?
async function isPulsing(
  page: import('@playwright/test').Page,
  label: string,
  samples = 8,
  gapMs = 120,
): Promise<boolean> {
  const seen = new Set<string>()
  for (let i = 0; i < samples; i++) {
    const cards = await probeCards(page)
    const c = cards.find((p) => p.label === label)
    seen.add(c?.inline ?? '')
    await page.waitForTimeout(gapMs)
  }
  return seen.size > 1
}

function hueOf(inline: string): 'green' | 'blue' | 'amber' | 'other' {
  // inline carries the css var token name directly.
  if (inline.includes('--status-ready')) return 'green'
  if (inline.includes('--status-waiting')) return 'blue'
  if (inline.includes('--status-active') || inline.includes('--status-error'))
    return 'amber'
  return 'other'
}

test.describe('card-glow (StatusBorder) model', () => {
  test('active=no glow, idle=subtle green glow, waiting=blue glow; dots static', async ({
    page,
  }) => {
    await page.goto(`${BASE}/dev/tiles`)
    await page.waitForSelector('[role="img"][aria-label="Idle"]', {
      state: 'attached',
      timeout: 15_000,
    })
    await page.waitForTimeout(500)

    const cards = await probeCards(page)
    const by = (l: string) => cards.filter((p) => p.label === l)

    // 1) active (loading/working) → NO card glow.
    for (const c of by('Running')) {
      expect(c.hasGlow, 'active/loading card must NOT glow').toBe(false)
    }
    // 2) starting + stopped → NO card glow.
    for (const c of [...by('Booting'), ...by('Stopped')]) {
      expect(c.hasGlow, `${c.label} card must NOT glow`).toBe(false)
    }
    // 3) idle → green card glow.
    const idle = by('Idle')[0]
    expect(idle.hasGlow, 'idle/done card must glow').toBe(true)
    expect(hueOf(idle.inline), 'idle glow must be green').toBe('green')
    // 4) waiting → blue card glow.
    const waiting = by('Needs input')[0]
    expect(waiting.hasGlow, 'waiting card must glow').toBe(true)
    expect(hueOf(waiting.inline), 'waiting glow must be blue').toBe('blue')

    // 5) the green glow must be SUBTLER than the blue glow (lower peak alpha).
    const greenPeak = await peakAlphaFor(page, 'Idle')
    const bluePeak = await peakAlphaFor(page, 'Needs input')
    expect(greenPeak, 'green peak alpha must be > 0').toBeGreaterThan(0)
    expect(bluePeak, 'blue peak alpha must be > 0').toBeGreaterThan(0)
    expect(
      greenPeak,
      `green glow (${greenPeak}) must be subtler than blue (${bluePeak})`,
    ).toBeLessThan(bluePeak)

    // 6) both card glows PULSE under normal motion.
    expect(await isPulsing(page, 'Idle'), 'idle glow must pulse').toBe(true)
    expect(await isPulsing(page, 'Needs input'), 'waiting glow must pulse').toBe(
      true,
    )

    // 7) the status DOTS are static (reverted) — no inline box-shadow halo on
    // the idle/waiting dots themselves.
    const dotHalos = await page.evaluate(() => {
      const wanted = ['Idle', 'Needs input']
      return wanted.map((label) => {
        const dot = document.querySelector(
          `[role="img"][aria-label="${label}"]`,
        ) as HTMLElement | null
        return { label, inlineShadow: dot ? dot.style.boxShadow : 'NO-DOT' }
      })
    })
    for (const d of dotHalos) {
      expect(
        d.inlineShadow,
        `${d.label} DOT must be static (no halo) — pulse lives on the card`,
      ).toBe('')
    }
  })

  test('reduced motion → card glow is static (no pulse) on every status', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/dev/tiles?reduce=1`)
    await page.waitForSelector('[role="img"][aria-label="Idle"]', {
      state: 'attached',
      timeout: 15_000,
    })
    await page.waitForTimeout(400)

    for (const label of ['Idle', 'Needs input', 'Error']) {
      expect(
        await isPulsing(page, label),
        `${label} card glow must be STATIC under reduced motion`,
      ).toBe(false)
    }
    await ctx.close()
  })
})

/**
 * The light theme owes text-sized output 4.5:1, and nothing in the tree was
 * checking it.
 *
 * The audit that produced this file walked six surfaces in both themes with
 * alpha-composited backgrounds: dark was clean everywhere (0 failures on
 * overview / settings / files / focus) and light failed broadly — overview 40,
 * focus 35. The asymmetry was the tell that light had never been audited. Two
 * token families were responsible:
 *
 *   1. the ANSI sixteen, which the tile / roster preview and the chat attention
 *      card paint straight onto a white card — the dark tuning sits at
 *      1.5–2.9:1 there, so "⚠ Transcript saving is off" was invisible;
 *   2. `--status-*`, drawn as 10px 600-weight pill labels: `text-status-ready`
 *      on white measured 2.55:1, `text-status-waiting` 3.33:1.
 *
 * This test parses globals.css and asserts the ratios directly, so the light
 * theme cannot silently regress again. It deliberately measures against pure
 * white (#fff, the light `--card`) rather than the warmer paper step: that is
 * the brightest surface these tokens land on, so it is the honest worst case.
 *
 * `clampToLightSurface` — the runtime half, which handles the 256-colour and
 * truecolour spaces that cannot be tokenised — is exercised here too.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import { AA_TEXT, ANSI_16, clampToLightSurface, contrastOnWhite } from '../../src/lib/ansi'

const css = readFileSync(
  fileURLToPath(new URL('../../src/styles/globals.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

/** The `:root` (light) block — everything before `.dark {`. */
const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf('.dark {'))
/** The `.dark {` block. */
const darkBlock = css.slice(css.indexOf('.dark {'), css.indexOf('}', css.indexOf('.dark {')))

function declaration(block: string, name: string): string {
  const m = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))
  if (!m) throw new Error(`no ${name} in block`)
  return m[1].trim()
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ]
}

/** `H S% L%` (the app's bare-triple form) → sRGB. */
function hslTripleToRgb(triple: string): [number, number, number] {
  const [hs, ss, ls] = triple.split(/\s+/)
  const h = Number.parseFloat(hs) / 360
  const s = Number.parseFloat(ss) / 100
  const l = Number.parseFloat(ls) / 100
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ]
}

describe('the light theme carries text-sized terminal output', () => {
  test('every light --ansi-N clears 4.5:1 on white', () => {
    const failures: string[] = []
    for (let i = 0; i < 16; i++) {
      const hex = declaration(lightBlock, `--ansi-${i}`)
      expect(hex).toMatch(/^#[0-9a-f]{6}$/)
      const ratio = contrastOnWhite(...hexToRgb(hex))
      if (ratio < AA_TEXT) failures.push(`--ansi-${i} ${hex} = ${ratio.toFixed(2)}:1`)
    }
    expect(failures).toEqual([])
  })

  test('the dark --ansi-N set still matches lib/ansi.ts byte for byte', () => {
    // The literals in lib/ansi.ts are the fallback for `var(--ansi-N)` and the
    // live xterm palette's fallback too; a drift between the two would make a
    // headless render and a browser render disagree.
    for (let i = 0; i < 16; i++) {
      expect(declaration(darkBlock, `--ansi-${i}`)).toBe(ANSI_16[i])
    }
  })

  test('the light --ansi-N set is genuinely different from the dark one', () => {
    // Guards the failure mode where someone "fixes" light by copying dark.
    const differing = Array.from({ length: 16 }, (_, i) => i).filter(
      (i) => declaration(lightBlock, `--ansi-${i}`) !== declaration(darkBlock, `--ansi-${i}`),
    )
    expect(differing.length).toBeGreaterThanOrEqual(14)
  })
})

describe('status ink carries a pill label', () => {
  const statuses = ['active', 'waiting', 'ready', 'error', 'idle'] as const

  test('every light --status-*-ink clears 4.5:1 on white', () => {
    const failures: string[] = []
    for (const s of statuses) {
      const triple = declaration(lightBlock, `--status-${s}-ink`)
      const ratio = contrastOnWhite(...hslTripleToRgb(triple))
      if (ratio < AA_TEXT) failures.push(`--status-${s}-ink ${triple} = ${ratio.toFixed(2)}:1`)
    }
    expect(failures).toEqual([])
  })

  test('the dark theme keeps ink === fill', () => {
    for (const s of statuses) {
      expect(declaration(darkBlock, `--status-${s}-ink`)).toBe(`var(--status-${s})`)
    }
  })

  test('the fills themselves are untouched — the dot is not the label', () => {
    // The regression this blocks: darkening `--status-*` wholesale to fix the
    // labels, which would also drag the amber pulse and every /15 fill down.
    expect(declaration(lightBlock, '--status-active')).toBe('38 92% 58%')
    expect(declaration(lightBlock, '--status-ready')).toBe('152 60% 45%')
    expect(declaration(lightBlock, '--status-waiting')).toBe('214 95% 60%')
  })
})

describe('clampToLightSurface — the untokenisable colour spaces', () => {
  test('a colour that already passes is returned unchanged', () => {
    expect(clampToLightSurface(29, 29, 31)).toBe('rgb(29, 29, 31)')
  })

  test('the greys Claude Code actually emits become readable', () => {
    // #999999 — measured on the live overview at 2.85:1 in light theme.
    const out = clampToLightSurface(153, 153, 153)
    const [r, g, b] = out.match(/\d+/g)!.map(Number)
    expect(contrastOnWhite(r, g, b)).toBeGreaterThanOrEqual(AA_TEXT)
    expect(r).toBeLessThan(153)
  })

  test('hue survives the clamp — a red stays red', () => {
    // rgb(215, 119, 87), the box-drawing orange, measured at 3.15:1.
    const [r, g, b] = clampToLightSurface(215, 119, 87).match(/\d+/g)!.map(Number)
    expect(contrastOnWhite(r, g, b)).toBeGreaterThanOrEqual(AA_TEXT)
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
  })

  test('every 256-colour cube entry clears the bar after clamping', () => {
    for (let i = 16; i < 256; i++) {
      let rgb: [number, number, number]
      if (i < 232) {
        const n = i - 16
        const c = (v: number) => (v === 0 ? 0 : 55 + v * 40)
        rgb = [c(Math.floor(n / 36)), c(Math.floor((n % 36) / 6)), c(n % 6)]
      } else {
        const v = 8 + (i - 232) * 10
        rgb = [v, v, v]
      }
      const [r, g, b] = clampToLightSurface(...rgb).match(/\d+/g)!.map(Number)
      expect(contrastOnWhite(r, g, b)).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })
})

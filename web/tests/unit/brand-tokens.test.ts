/**
 * globals.css is the single source of truth for design tokens; brand/tokens.ts
 * is a hand-maintained TS mirror for the contexts that cannot read a custom
 * property (canvas, SVG attributes, Framer Motion keyframes).
 *
 * Two mirrors can drift silently, and did: `--status-ready: 152 60% 45%`
 * resolves to #2eb877, but the mirror claimed #2eaa6e — a visible delta between
 * the CSS-driven status dot and any canvas/motion consumer of the same token.
 *
 * This suite parses globals.css and asserts, for every mirrored token:
 *   · the TS HSL triple is character-identical to the CSS declaration, and
 *   · the TS hex is exactly what that HSL triple resolves to, and
 *   · the B0 `--sm-*` paper/ink/hairline ladder matches PAPER, per theme.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import {
  ACCENT_HSL,
  AGENT_ACCENT,
  BACKGROUND_HSL,
  BRAND,
  HAIRLINE_W,
  PAPER,
  STATUS_ACTIVE_HSL,
  STATUS_ERROR_HSL,
  STATUS_IDLE_HSL,
  STATUS_READY_HSL,
  STATUS_WAITING_HSL,
  type PaperLadder,
} from '../../src/brand/tokens'

const CSS_PATH = fileURLToPath(
  new URL('../../src/styles/globals.css', import.meta.url),
)

/** Comment-stripped, whitespace-collapsed stylesheet. */
const css = readFileSync(CSS_PATH, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

/**
 * Every custom property declared by the rules whose selector list is exactly
 * `selector`. Multiple matching rules are merged in source order (later wins),
 * which is how the cascade resolves them for a single element anyway.
 */
function declarations(selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  const needle = `${selector} {`
  let from = 0
  let found = false
  for (;;) {
    const at = css.indexOf(needle, from)
    if (at === -1) break
    found = true
    const start = at + needle.length
    const end = css.indexOf('}', start)
    for (const decl of css.slice(start, end).split(';')) {
      const colon = decl.indexOf(':')
      if (colon === -1) continue
      const name = decl.slice(0, colon).trim()
      if (!name.startsWith('--')) continue
      out[name] = decl.slice(colon + 1).trim()
    }
    from = end
  }
  if (!found) throw new Error(`no rule with selector list "${selector}"`)
  return out
}

/** `H S% L%` (the bare-triple storage format) → `#rrggbb`. */
function hslTripleToHex(triple: string): string {
  const m = triple.match(/^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/)
  if (!m) throw new Error(`not a bare HSL triple: "${triple}"`)
  const h = Number(m[1]) / 360
  const s = Number(m[2]) / 100
  const l = Number(m[3]) / 100
  const c = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${c(0)}${c(8)}${c(4)}`
}

/** Every token stored as a bare HSL triple, with its TS mirrors. */
const HSL_TOKENS: ReadonlyArray<[cssVar: string, hsl: string, hex: string]> = [
  ['--brand', ACCENT_HSL, BRAND.accent],
  ['--status-active', STATUS_ACTIVE_HSL, BRAND.status.active],
  ['--status-waiting', STATUS_WAITING_HSL, BRAND.status.waiting],
  ['--status-ready', STATUS_READY_HSL, BRAND.status.ready],
  ['--status-error', STATUS_ERROR_HSL, BRAND.status.error],
  ['--status-idle', STATUS_IDLE_HSL, BRAND.status.idle],
]

describe('hslTripleToHex', () => {
  // The assertion engine itself, pinned against known conversions.
  test.each([
    ['0 0% 0%', '#000000'],
    ['0 0% 100%', '#ffffff'],
    ['0 0% 45%', '#737373'],
    ['0 100% 50%', '#ff0000'],
    ['120 100% 50%', '#00ff00'],
    ['240 100% 50%', '#0000ff'],
    ['38 92% 58%', '#f6ae31'],
  ])('%s → %s', (triple, hex) => {
    expect(hslTripleToHex(triple)).toBe(hex)
  })
})

describe('brand + status tokens', () => {
  const root = declarations(':root')

  test.each(HSL_TOKENS)('%s: TS triple matches the CSS declaration', (v, hsl) => {
    expect(root[v]).toBe(hsl)
  })

  // The regression this suite was written for: the hex mirror must be exactly
  // what the HSL triple resolves to, not an eyeballed approximation.
  test.each(HSL_TOKENS)('%s: hex mirror == resolved HSL', (v, _hsl, hex) => {
    expect(hslTripleToHex(root[v])).toBe(hex)
  })

  test('background mirror == resolved HSL, and == the dark theme surface', () => {
    expect(hslTripleToHex(BACKGROUND_HSL)).toBe(BRAND.background)
    expect(declarations('.dark')['--background']).toBe(BRAND.background)
  })
})

describe('B0 warm paper/ink/hairline ladder', () => {
  /** PaperLadder key → CSS custom property. */
  const VARS: Record<keyof PaperLadder, string> = {
    paper: '--sm-paper',
    paperRaised: '--sm-paper-raised',
    surface: '--sm-surface',
    bubbleAgent: '--sm-bubble-agent',
    bubbleUser: '--sm-bubble-user',
    bubbleUserInk: '--sm-bubble-user-ink',
    ink: '--sm-ink',
    ink2: '--sm-ink-2',
    ink3: '--sm-ink-3',
    hairline: '--sm-hairline',
    hairlineSoft: '--sm-hairline-soft',
    fillSoft: '--sm-fill-soft',
    fillSoft2: '--sm-fill-soft-2',
    codeBg: '--sm-code-bg',
    bubbleShadow: '--sm-bubble-shadow',
    cardShadow: '--sm-card-shadow',
    elev: '--sm-elev',
    accentRowMix: '--sm-accent-row-mix',
  }

  const THEMES = {
    light: declarations(":root, [data-theme='light']"),
    dark: declarations(".dark, [data-theme='dark']"),
  } as const

  for (const theme of ['light', 'dark'] as const) {
    describe(theme, () => {
      const decls = THEMES[theme]

      test.each(Object.keys(VARS) as Array<keyof PaperLadder>)(
        '%s mirrors its CSS declaration',
        (key) => {
          expect(decls[VARS[key]]).toBe(PAPER[theme][key])
        },
      )

      test('declares the whole ladder and nothing extra', () => {
        expect(Object.keys(decls).sort()).toEqual(Object.values(VARS).sort())
      })
    })
  }

  test('the two themes are genuinely different surfaces', () => {
    expect(PAPER.light.paper).not.toBe(PAPER.dark.paper)
    // Every rung is themed — a shared value would mean a missed override.
    for (const key of Object.keys(VARS) as Array<keyof PaperLadder>) {
      if (key === 'bubbleUserInk') continue // light ink == dark user-bubble ink, by design
      expect(PAPER.light[key], key).not.toBe(PAPER.dark[key])
    }
  })

  test('the light user bubble and the dark user-bubble ink are the same ink', () => {
    // Not a copy/paste slip: the inverted bubble reuses the opposite theme's ink.
    expect(PAPER.dark.bubbleUserInk).toBe(PAPER.light.ink)
  })

  // A rung can be added to the ladder AND to PAPER and still have no
  // `bg-…`/`text-…`/`border-…` utility, because that mapping lives in a
  // separate `@theme inline` block. Colour rungs must be mapped, and mapped
  // through the var (never inlined literally), so a `[data-theme]` subtree and
  // the character engine's runtime writes both still apply at the use site.
  test('every colour rung is exposed in the Tailwind namespace', () => {
    const theme = declarations('@theme inline')
    // The elevation triple and the mix ratio are not colours — no utility.
    const NOT_COLOURS = new Set<keyof PaperLadder>([
      'bubbleShadow',
      'cardShadow',
      'elev',
      'accentRowMix',
    ])
    for (const key of Object.keys(VARS) as Array<keyof PaperLadder>) {
      if (NOT_COLOURS.has(key)) continue
      const smVar = VARS[key]
      expect(theme[smVar.replace('--sm-', '--color-')], key).toBe(`var(${smVar})`)
    }
    // The per-session accent, likewise — as `agent`, since `accent` is taken by
    // the shadcn hover fill.
    expect(theme['--color-agent']).toBe('var(--sm-accent)')
  })
})

describe('per-session accent (C7)', () => {
  const root = declarations(':root')

  test('the engine writes --sm-accent, and it defaults to the brand amber', () => {
    expect(AGENT_ACCENT.cssVar).toBe('--sm-accent')
    expect(root['--sm-accent']).toBe('hsl(var(--brand))')
    expect(AGENT_ACCENT.DEFAULT).toBe(BRAND.accent)
  })

  test('mix ratios mirror the CSS', () => {
    expect(root['--sm-accent-wash-mix']).toBe(AGENT_ACCENT.mix.wash)
    expect(root['--sm-accent-chip-mix']).toBe(AGENT_ACCENT.mix.chip)
    expect(PAPER.light.accentRowMix).toBe(AGENT_ACCENT.mix.row.light)
    expect(PAPER.dark.accentRowMix).toBe(AGENT_ACCENT.mix.row.dark)
  })

  test('the derived surfaces mix at the use site, not on :root', () => {
    // A custom property containing var() is substituted where it is DECLARED,
    // so a derived var on :root could never see a per-session accent written
    // further down the tree. These must stay utilities.
    for (const derived of ['--sm-accent-row', '--sm-accent-wash', '--sm-accent-chip']) {
      expect(root[derived]).toBeUndefined()
    }
    for (const utility of ['sm-accent-row', 'sm-accent-wash', 'sm-accent-chip']) {
      expect(css).toContain(`@utility ${utility} {`)
    }
  })

  test('hairline width is 0.5px in both the CSS and the mirror', () => {
    expect(root['--sm-hairline-w']).toBe(HAIRLINE_W)
    expect(HAIRLINE_W).toBe('0.5px')
  })
})

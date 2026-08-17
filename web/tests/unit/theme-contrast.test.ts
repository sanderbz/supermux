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

/**
 * Concatenate every top-level rule whose selector list names a theme. The
 * tokens are spread over several blocks (`:root`, `:root, [data-theme='light']`,
 * `.dark, [data-theme='dark']`, plus theme-independent `:root` blocks at the
 * file tail), so slicing "everything before .dark" would silently miss half of
 * them — and a token this test cannot find is a token it cannot guard.
 */
function themeBlocks(match: (selector: string) => boolean): string {
  const out: string[] = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    const selector = css.slice(css.lastIndexOf('}', open) + 1, open).trim()
    let depth = 1
    let j = open + 1
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
    }
    if (match(selector)) out.push(css.slice(open + 1, j - 1))
    i = j
  }
  return out.join('\n')
}

const lightBlock = themeBlocks(
  (sel) => /(^|,)\s*:root\s*(,|$)/.test(sel) || sel.includes("[data-theme='light']"),
)
const darkBlock = themeBlocks((sel) => /(^|,)\s*\.dark\s*(,|$)/.test(sel))

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

/** Contrast ratio between two hex colours. */
function ratio(a: string, b: string): number {
  const la = contrastOnWhite(...hexToRgb(a))
  const lb = contrastOnWhite(...hexToRgb(b))
  // contrastOnWhite(c) = 1.05 / (L(c) + 0.05) ⇒ L(c) = 1.05/r − 0.05.
  const L = (r: number) => 1.05 / r - 0.05
  const [hi, lo] = [Math.max(L(la), L(lb)), Math.min(L(la), L(lb))]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The ink ladder's tertiary step failed AA in BOTH themes — dark #7d766f on
 * #201f1d = 3.68:1, light #a8a09a on #fdfbf9 = 2.49:1 — while carrying real
 * 10–11.5px metadata: palette section headers, the "cloud · manage" subtitle,
 * the light mobile tab-bar active label. Light ink-2 was itself only at 4.64:1,
 * so ink-3 could not simply be darkened past it without collapsing the ladder
 * into two indistinguishable steps; both light steps moved together.
 */
describe('the ink ladder is legible at every step', () => {
  const surfaces = { light: ['#fdfbf9', '#f4f0ec'], dark: ['#201f1d', '#1a1a18'] }

  for (const theme of ['light', 'dark'] as const) {
    const block = theme === 'light' ? lightBlock : darkBlock
    for (const step of ['--sm-ink', '--sm-ink-2', '--sm-ink-3'] as const) {
      test(`${theme} ${step} clears 4.5:1 on both paper steps`, () => {
        const ink = declaration(block, step)
        for (const bg of surfaces[theme]) {
          expect(ratio(ink, bg), `${step} on ${bg}`).toBeGreaterThanOrEqual(AA_TEXT)
        }
      })
    }

    test(`${theme} ink → ink-2 → ink-3 is still a LADDER`, () => {
      // Each step must be visibly weaker than the one above it, or the fix has
      // merely flattened three tiers into one.
      const bg = surfaces[theme][0]
      const steps = ['--sm-ink', '--sm-ink-2', '--sm-ink-3'].map((s) =>
        ratio(declaration(block, s), bg),
      )
      expect(steps[0]).toBeGreaterThan(steps[1] * 1.4)
      expect(steps[1]).toBeGreaterThan(steps[2] * 1.2)
    })
  }
})

/**
 * The tinted-columns DNA: the rail sits one step below the content column. In
 * dark that step was 6/255; in light it was 3/255 (~1.2%), i.e. invisible — the
 * light theme read as one flat white sheet.
 */
describe('the substrate step reads in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} paper → paper-raised is at least 6/255 per channel`, () => {
      const block = theme === 'light' ? lightBlock : darkBlock
      const rail = hexToRgb(declaration(block, '--sm-paper'))
      const content = hexToRgb(declaration(block, '--sm-paper-raised'))
      const deltas = rail.map((v, i) => Math.abs(content[i] - v))
      // The dark ladder — the one that reads correctly — is (6, 5, 5). Light was
      // (3, 4, 5), i.e. ~1.2%: a flat white sheet with no visible rail.
      expect(Math.max(...deltas), 'strongest channel step').toBeGreaterThanOrEqual(6)
      expect(Math.min(...deltas), 'weakest channel step').toBeGreaterThanOrEqual(5)
    })
  }
})

/**
 * `index.html` used to carry a single hard-coded `theme-color` (#0a0a0a) and no
 * inline theme bootstrap: a light-theme user got dark browser chrome and a dark
 * PWA splash, and the `.dark`/`.light` class only landed once main.tsx parsed.
 */
describe('the document bootstraps its own theme', () => {
  const html = readFileSync(
    fileURLToPath(new URL('../../index.html', import.meta.url)),
    'utf8',
  )

  test('theme-color has a light and a dark media variant', () => {
    expect(html).toContain('media="(prefers-color-scheme: dark)"')
    expect(html).toContain('media="(prefers-color-scheme: light)"')
  })

  test('an inline script applies the stored theme before the bundle', () => {
    const head = html.slice(0, html.indexOf('</head>'))
    expect(head).toContain("localStorage.getItem('supermux-theme')")
    expect(head).toContain('colorScheme')
    // It must run BEFORE the module that would otherwise own first paint.
    expect(html.indexOf("localStorage.getItem('supermux-theme')")).toBeLessThan(
      html.indexOf('src/main.tsx'),
    )
  })

  test('the bootstrap mirrors the provider — same key, same dark default', () => {
    const provider = readFileSync(
      fileURLToPath(new URL('../../src/components/theme-provider.tsx', import.meta.url)),
      'utf8',
    )
    expect(provider).toContain("const STORAGE_KEY = 'supermux-theme'")
    expect(provider).toContain("return 'dark' // dark default")
  })
})

/**
 * ALPHA MODIFIERS ARE INVISIBLE TO A TOKEN WALK (round-2 finding 17).
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything above this block walks RAW tokens, which is why the last live AA
 * failures on the product routes were not tokens at all but `text-…/70` and
 * `/80` in classNames: `--muted-foreground` is #6c6c70 = 4.83:1 on white, and at
 * 70% over the same white it is 2.89:1 — the model label on every teammate row,
 * "Ungrouped", the group counts, the keycap chips. Measured live across five
 * surfaces: 16 failures on light/overview, 18 on light/focus, 7 and 10 in dark
 * at 3.58–3.85:1.
 *
 * Two assertions, because the fix has two halves: the composited maths (so
 * nobody re-derives that 70% of a 4.8:1 ink is fine) and a scan of the source
 * (so the next `text-muted-foreground/70` is caught at `bun test` rather than by
 * a contrast walk six months later).
 */
describe('alpha-modified text ink', () => {
  /** `color-mix`-equivalent: `ink` at `alpha` over an opaque `bg`. */
  function composite(
    ink: [number, number, number],
    bg: [number, number, number],
    alpha: number,
  ): [number, number, number] {
    return [0, 1, 2].map((i) => Math.round(ink[i] * alpha + bg[i] * (1 - alpha))) as [
      number,
      number,
      number,
    ]
  }

  const ink = hexToRgb(declaration(lightBlock, '--muted-foreground'))
  const paper = hexToRgb(declaration(lightBlock, '--sm-paper'))
  const raised = hexToRgb(declaration(lightBlock, '--sm-paper-raised'))

  test('the token itself carries text on every light surface', () => {
    for (const [name, bg] of [
      ['white', [255, 255, 255] as [number, number, number]],
      ['--sm-paper', paper],
      ['--sm-paper-raised', raised],
    ] as const) {
      const ratio = contrastOnWhite(...composite(ink, bg, 1))
      expect([name, ratio >= AA_TEXT]).toEqual([name, true])
    }
  })

  test('…and the /70 and /80 forms do not — which is why they are banned below', () => {
    expect(contrastOnWhite(...composite(ink, [255, 255, 255], 0.7))).toBeLessThan(AA_TEXT)
    expect(contrastOnWhite(...composite(ink, raised, 0.8))).toBeLessThan(AA_TEXT)
  })

  test('no text in the app dims muted-foreground with an alpha modifier', () => {
    // The heuristic is the one a reviewer uses: a `text-muted-foreground/NN` in
    // a class list that also sets a TEXT SIZE is prose, not a glyph. Icon-only
    // buttons (`size-4` chevrons, the drag handles) keep their alphas — the
    // non-text contrast rule is 3:1 and they are not this test's business —
    // and so does a `marker:` bullet.
    const files = new Bun.Glob('**/*.{ts,tsx}').scanSync({
      cwd: fileURLToPath(new URL('../../src', import.meta.url)),
      absolute: true,
    })
    const sized = /text-(xs|sm|base|lg|\[\d+(?:\.\d+)?px\])/
    const offenders: string[] = []
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/text-muted-foreground\/\d+/.test(line)) return
        if (/marker:text-muted-foreground/.test(line)) return
        if (!sized.test(line)) return
        offenders.push(`${file.split('/src/')[1]}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

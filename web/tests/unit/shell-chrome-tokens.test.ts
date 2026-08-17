/**
 * B1 T1.3 / T2.5 — the shell's CSS contracts, asserted by parsing globals.css.
 *
 * Two invariants live here, and they are meant to outlive fase B1:
 *
 *  1. `backdrop-filter` appears ONLY inside the `glass` utility (and its two
 *     accessibility fallback blocks). This is not a style preference — a
 *     non-`none` backdrop-filter/filter/transform/perspective on an element
 *     turns it into the CONTAINING BLOCK for every `position: fixed`
 *     descendant. The focus route's mobile sheet, the KeyBar, the joystick and
 *     the tour overlay are all `fixed`, and all of them silently break (their
 *     `visualViewport` math starts measuring the wrong box) the moment a shell
 *     ancestor grows one. The B1 substrate is therefore OPAQUE PAINT, never
 *     blur, and this test is what keeps it that way in every future PR.
 *     The e2e counterpart that proves it end-to-end is
 *     `tests/e2e/smoke/shell-containing-block.spec.ts`.
 *
 *  2. The chrome-token layer (`--sm-toolbar-min-h*`, the z-ladder names,
 *     `.sm-swap`) is declared exactly once and `safe-header` resolves THROUGH
 *     the token rather than restating the literal.
 *
 * Idiom mirrors `brand-tokens.test.ts`: read the stylesheet, parse, assert.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import { springs, tweens } from '../../src/lib/springs'

const CSS_PATH = fileURLToPath(
  new URL('../../src/styles/globals.css', import.meta.url),
)

/** Raw stylesheet with comments stripped (comments legitimately mention
 *  `backdrop-filter` in prose — those must not count as declarations). */
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

interface Decl {
  /** The declaration text, e.g. `backdrop-filter: blur(20px)`. */
  text: string
  /** Enclosing block preludes, outermost → innermost. */
  path: string[]
}

/**
 * Minimal block-aware CSS walker. Good enough for this stylesheet (no strings
 * containing braces, no nested comments — comments are stripped above) and
 * far more honest than a regex: every declaration is reported together with
 * the chain of at-rule / selector preludes that contains it.
 */
function walk(source: string): Decl[] {
  const out: Decl[] = []
  const stack: string[] = []
  let buf = ''
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') {
      stack.push(buf.trim().replace(/\s+/g, ' '))
      buf = ''
    } else if (ch === '}') {
      const decl = buf.trim()
      if (decl) out.push({ text: decl.replace(/\s+/g, ' '), path: [...stack] })
      buf = ''
      stack.pop()
    } else if (ch === ';') {
      const decl = buf.trim()
      if (decl) out.push({ text: decl.replace(/\s+/g, ' '), path: [...stack] })
      buf = ''
    } else {
      buf += ch
    }
  }
  return out
}

const decls = walk(css)

/** Declarations only (drop at-rule statements like `@import x;`). */
const properties = decls.filter((d) => /^[-a-zA-Z]+\s*:/.test(d.text))

function declared(prop: string): Decl[] {
  return properties.filter((d) => d.text.split(':')[0].trim() === prop)
}

describe('backdrop-filter is confined to `glass` (containing-block invariant)', () => {
  const blurs = properties.filter((d) =>
    /^-?(webkit-)?backdrop-filter\s*:/.test(d.text),
  )

  test('the stylesheet actually declares it somewhere (guards a dead test)', () => {
    expect(blurs.length).toBeGreaterThan(0)
  })

  test('every backdrop-filter sits in the glass utility or its fallbacks', () => {
    const allowedInnermost = new Set(['@utility glass', '.glass'])
    const offenders = blurs
      .filter((d) => !allowedInnermost.has(d.path[d.path.length - 1] ?? ''))
      .map((d) => `${d.path.join(' > ')} { ${d.text} }`)
    expect(offenders).toEqual([])
  })

  test('no backdrop-filter on the document, the shell root or a substrate rule', () => {
    const forbidden = /(^|[\s,>])(html|body|#root)([\s,{:]|$)|\[data-substrate\]|--sm-substrate/
    const offenders = blurs
      .filter((d) => d.path.some((p) => forbidden.test(p)))
      .map((d) => d.path.join(' > '))
    expect(offenders).toEqual([])
  })

  test('no other containing-block trigger is declared on a shell column', () => {
    // `filter`, `transform`, `perspective`, `contain: paint` and
    // `will-change: transform` create the same containing block as
    // backdrop-filter. None of them may appear on the substrate rules.
    const triggers = properties.filter((d) => {
      const [prop, value = ''] = d.text.split(':')
      const p = prop.trim()
      if (p === 'filter' || p === 'perspective' || p === 'transform') return true
      if (p === 'contain' && /paint|strict|content/.test(value)) return true
      if (p === 'will-change' && /transform|filter|perspective/.test(value))
        return true
      return false
    })
    const offenders = triggers
      .filter((d) => d.path.some((p) => /\[data-substrate\]/.test(p)))
      .map((d) => `${d.path.join(' > ')} { ${d.text} }`)
    expect(offenders).toEqual([])
  })
})

describe('chrome tokens (T2)', () => {
  const once = [
    '--sm-toolbar-min-h',
    '--sm-toolbar-min-h-compact',
    '--sm-z-content',
    '--sm-z-pane',
    '--sm-z-header',
    '--sm-z-overlay',
    '--sm-z-sheet',
    '--sm-z-compose',
    '--sm-z-actionsheet',
    '--sm-z-tour',
    '--sm-z-tip',
    '--sm-scrim',
  ]

  for (const token of once) {
    test(`${token} is declared exactly once`, () => {
      expect(declared(token).length).toBe(1)
    })
  }

  test('the z-ladder keeps the SHIPPED numbers (B1 renumbers nothing)', () => {
    const expected: Record<string, string> = {
      '--sm-z-content': '10',
      '--sm-z-pane': '20',
      '--sm-z-header': '30',
      '--sm-z-overlay': '50',
      '--sm-z-sheet': '60',
      '--sm-z-compose': '65',
      '--sm-z-actionsheet': '70',
      '--sm-z-tour': '78',
      '--sm-z-tip': '80',
    }
    for (const [token, value] of Object.entries(expected)) {
      const decl = declared(token)[0]
      expect(decl?.text.split(':')[1]?.trim()).toBe(value)
    }
  })

  test('safe-header resolves THROUGH the token, not a literal', () => {
    const minHeights = declared('min-height').filter((d) =>
      d.path.some((p) => p === '@utility safe-header'),
    )
    expect(minHeights.length).toBe(1)
    expect(minHeights[0].text).toContain('var(--sm-toolbar-min-h)')
    expect(minHeights[0].text).not.toMatch(/\d/)
  })

  test('safe-header keeps its additive safe-area padding', () => {
    const pads = declared('padding-top').filter((d) =>
      d.path.some((p) => p === '@utility safe-header'),
    )
    expect(pads.length).toBe(1)
    expect(pads[0].text).toContain('env(safe-area-inset-top)')
  })

  test('safe-header-compact exists and uses the 44px twin', () => {
    const compact = properties.filter((d) =>
      d.path.some((p) => p === '@utility safe-header-compact'),
    )
    expect(compact.length).toBeGreaterThan(0)
    expect(
      compact.some((d) => d.text.includes('var(--sm-toolbar-min-h-compact)')),
    ).toBe(true)
  })

  test('the two toolbar floors are 56px and 44px', () => {
    expect(declared('--sm-toolbar-min-h')[0].text).toContain('3.5rem')
    expect(declared('--sm-toolbar-min-h-compact')[0].text).toContain('2.75rem')
  })
})

describe('.sm-swap — same-cell crossfade with zero layout shift', () => {
  const swapDecls = properties.filter((d) =>
    d.path.some((p) => p.includes('sm-swap')),
  )

  test('it is a 1x1 grid, not absolute positioning', () => {
    expect(swapDecls.some((d) => d.text === 'display: grid')).toBe(true)
    expect(swapDecls.some((d) => /grid-area: 1 ?\/ ?1/.test(d.text))).toBe(true)
    // The old idiom (position:absolute on the outgoing child) re-typesets the
    // content and shifts the row — the whole point of `.sm-swap` is that it
    // cannot.
    expect(swapDecls.some((d) => /^position: absolute/.test(d.text))).toBe(false)
  })

  test('hidden children fade out and stop taking clicks', () => {
    expect(
      swapDecls.some((d) => /^transition: opacity/.test(d.text)),
    ).toBe(true)
    expect(swapDecls.some((d) => d.text === 'opacity: 0')).toBe(true)
    expect(swapDecls.some((d) => d.text === 'pointer-events: none')).toBe(true)
  })

  test('reduced motion drops the transition', () => {
    const reduced = swapDecls.filter((d) =>
      d.path.some((p) => p.includes('prefers-reduced-motion')),
    )
    expect(reduced.some((d) => /^transition:\s*none/.test(d.text))).toBe(true)
  })
})

describe('motion bank — exits are always faster than entries', () => {
  test('the overlay exit is shorter than the settle entry (~0.52s)', () => {
    expect(tweens.overlayExit.duration).toBeLessThan(0.52)
  })

  test('popoverOut is faster than popoverIn', () => {
    expect(tweens.popoverOut.duration).toBeLessThan(tweens.popoverIn.duration)
  })

  test('`settle` is a spring, tuned for an overlay entrance', () => {
    expect(springs.settle.type).toBe('spring')
    expect(springs.settle.stiffness).toBe(210)
    expect(springs.settle.damping).toBe(30)
  })
})

/**
 * Header grammar (B1 §2), asserted against the SOURCE of every header rather
 * than the token block alone.
 *
 * The gap this closes: `border-hairline` (the warm 0.086-alpha separator) landed
 * on Overview and Settings, while Files, the focus pane header, the file viewer
 * and the teammate panes kept the pre-B1 `border-border` — a COOL
 * rgb(56,56,58) line drawn on a warm substrate, one route apart from the
 * correct one. And the focus header hard-coded `h-11` instead of resolving
 * `--sm-toolbar-min-h-compact`, so the documented "never a fixed height, always
 * floor + additive pt-safe" contract was false in the one place it was proven.
 */
describe('header grammar — one separator, one height source', () => {
  const HEADER_FILES = [
    'src/routes/overview.tsx',
    'src/routes/settings.tsx',
    'src/routes/files.tsx',
    'src/components/files/file-viewer.tsx',
    'src/components/focus-mode/focus-header.tsx',
    'src/components/focus-mode/teammate-pane.tsx',
    'src/components/team/teammate-focus.tsx',
    'src/components/shell/shell-overlay.tsx',
  ]

  /** Every className string in `file` that opts into the header contract. */
  function headerClassNames(file: string): string[] {
    // Comments first: prose apostrophes ("the route's header") would otherwise
    // open a phantom string literal and swallow the real className after it.
    const src = readFileSync(
      fileURLToPath(new URL(`../../${file}`, import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    return (src.match(/'[^'\n]*safe-header[^'\n]*'|"[^"\n]*safe-header[^"\n]*"/g) ?? [])
      .map((s) => s.slice(1, -1))
  }

  test('every header opts into the safe-header contract (guards a dead test)', () => {
    for (const file of HEADER_FILES) {
      expect(headerClassNames(file).length, file).toBeGreaterThan(0)
    }
  })

  test('no header draws the cool border-border separator', () => {
    const offenders: string[] = []
    for (const file of HEADER_FILES) {
      for (const cls of headerClassNames(file)) {
        if (/\bborder-border\b/.test(cls)) offenders.push(`${file}: ${cls}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('no header hard-codes its height', () => {
    const offenders: string[] = []
    for (const file of HEADER_FILES) {
      for (const cls of headerClassNames(file)) {
        if (/\bh-\d+(\.\d+)?\b/.test(cls)) offenders.push(`${file}: ${cls}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

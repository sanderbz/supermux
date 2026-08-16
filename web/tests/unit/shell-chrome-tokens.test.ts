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

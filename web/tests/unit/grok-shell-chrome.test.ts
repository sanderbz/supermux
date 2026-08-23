/**
 * WS2 — the Grok-mode shell chrome's CSS contracts, asserted by parsing
 * grok-mode.css. The sibling of `shell-chrome-tokens.test.ts`, which guards the
 * DEFAULT substrate in globals.css; this guards the same containing-block
 * invariant for the grok skin, because grok-mode.css is a separate file that
 * the globals.css test never reads.
 *
 * THE INVARIANT (identical reasoning to shell-chrome-tokens.test.ts §1): a
 * non-`none` backdrop-filter / filter / transform / perspective / paint-contain
 * on a shell COLUMN turns it into the containing block for every
 * `position: fixed` descendant — and the tour overlay, the command palette, the
 * floating tips and the connection overlay are all fixed children of the shell
 * root. Grok mode still needs Grok's one substrate blur, so it puts that blur on
 * a LEAF `[data-grok]::before` pseudo (which has no element descendants → it can
 * be nobody's containing block) and keeps every real shell column
 * (`[data-shell-*]`) filter-free. This test keeps it that way.
 *
 * Idiom mirrors shell-chrome-tokens.test.ts: read the stylesheet, walk it,
 * assert on the declaration + its enclosing selector chain.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const CSS_PATH = fileURLToPath(
  new URL('../../src/styles/grok-mode.css', import.meta.url),
)

/** Raw stylesheet with comments stripped (comments legitimately mention
 *  `backdrop-filter` in prose — those must not count as declarations). */
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

interface Decl {
  text: string
  path: string[]
}

/** Minimal block-aware CSS walker (same as shell-chrome-tokens.test.ts). */
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
const properties = decls.filter((d) => /^[-a-zA-Z]+\s*:/.test(d.text))

/**
 * The shell COLUMNS that are ancestors of the fixed overlays (palette, tour,
 * connection, tips), and so must never become a containing block. The mobile
 * bottom-nav capsule `[data-shell-tabs]` is deliberately NOT in this set: it is
 * itself `position: fixed` with NO fixed descendants (its children are flow + one
 * absolute pill/chip), so its own glass blur and the leaf transforms of the
 * "Liquid Rail" pill glide / icon lift / press-ack are self-contained leaf
 * effects that make nobody's overlay a wrong containing block — the exact
 * reasoning documented at grok-mode.css §"CONTAINING-BLOCK CAVEAT". The invariant
 * still bites every OTHER shell column. */
const OVERLAY_HOSTING_COLUMN = /\[data-shell-(rail|pane|main|content|root)/

describe('grok mode — one substrate blur, on a leaf pseudo only', () => {
  const blurs = properties.filter((d) =>
    /^-?(webkit-)?backdrop-filter\s*:/.test(d.text),
  )

  test('the stylesheet actually declares the blur somewhere (guards a dead test)', () => {
    // Both the prefixed and standard property, at least in the base rule.
    expect(blurs.some((d) => d.text.includes('none') === false)).toBe(true)
  })

  test('the SUBSTRATE blur (--sm-glass-substrate) sits only on `[data-grok][data-grok-root]::before`', () => {
    // The one heavy 80px substrate blur is the containing-block hazard: it must
    // live on the leaf pseudo (no element descendants → nobody's containing
    // block) and nowhere else. It is SHELL-ROOT-SCOPED — `[data-grok][data-grok-
    // root]::before`, not bare `[data-grok]::before` — so the blur paints only on
    // the full-window ground and never on the portalled ⌘K palette (which carries
    // its own `data-grok` but is not the root; commit 6383102). The two a11y
    // fallback blocks restate it with the SAME innermost selector, so one
    // predicate covers all three. WS7's raised popover glass is a DIFFERENT,
    // lighter tier (tokens.md §1.2) — not caught here; it is bounded by the two
    // safety tests below instead.
    const SUBSTRATE_LEAF = '[data-grok][data-grok-root]::before'
    const offenders = blurs
      .filter((d) => d.text.includes('--sm-glass-substrate'))
      .filter((d) => (d.path[d.path.length - 1] ?? '') !== SUBSTRATE_LEAF)
      .map((d) => `${d.path.join(' > ')} { ${d.text} }`)
    expect(offenders).toEqual([])
  })

  test('no backdrop-filter on the bare shell root (containing-block safety)', () => {
    // A blur on the bare `[data-grok]` root (not the `::before` pseudo) would
    // make the root the containing block for its fixed overlay children — the
    // exact bug the substrate pseudo exists to avoid. Raised popover/dialog
    // surfaces (`[data-anchor='token']`, `[role='dialog']`) are DESCENDANTS /
    // portalled boxes, never the root, so they are allowed to carry the raised
    // glass tier; the bare root never is.
    const offenders = blurs
      .filter((d) => {
        const innermost = d.path[d.path.length - 1] ?? ''
        return innermost === '[data-grok]'
      })
      .map((d) => `${d.path.join(' > ')} { ${d.text} }`)
    expect(offenders).toEqual([])
  })

  test('the blur is NEVER on an overlay-hosting shell column', () => {
    const offenders = blurs
      .filter((d) => d.path.some((p) => OVERLAY_HOSTING_COLUMN.test(p)))
      .map((d) => d.path.join(' > '))
    expect(offenders).toEqual([])
  })

  test('no other containing-block trigger on an overlay-hosting shell column', () => {
    // filter / transform / perspective / contain:paint / will-change:transform
    // create the SAME containing block as backdrop-filter.
    const triggers = properties.filter((d) => {
      const [prop, value = ''] = d.text.split(':')
      const p = prop.trim()
      if (p === 'filter' || p === 'perspective' || p === 'transform') return true
      if (p === 'contain' && /paint|strict|content/.test(value)) return true
      if (p === 'will-change' && /transform|filter|perspective/.test(value)) {
        return true
      }
      return false
    })
    const offenders = triggers
      .filter((d) => d.path.some((p) => OVERLAY_HOSTING_COLUMN.test(p)))
      .map((d) => `${d.path.join(' > ')} { ${d.text} }`)
    expect(offenders).toEqual([])
  })
})

describe('grok mode — the shell columns consume the token layer', () => {
  /** Declarations whose enclosing selector chain contains `sel`. */
  function inSelector(sel: string): Decl[] {
    return properties.filter((d) => d.path.some((p) => p.includes(sel)))
  }

  test('the nav rail repaints onto the sidebar tint, not a solid card', () => {
    const rail = inSelector('[data-shell-rail]')
    const bg = rail.find((d) => d.text.startsWith('background'))
    expect(bg?.text).toContain('var(--sm-sidebar-tint)')
    // The 1px default border is neutralised (a 1px line is a Grok tell).
    expect(rail.some((d) => d.text === 'border-right-width: 0')).toBe(true)
  })

  test('column separators are 0.5px, never a border', () => {
    const seams = properties.filter((d) =>
      d.path.some((p) => /\[data-shell-(rail|tabs|pane)\]::after/.test(p)),
    )
    const widths = seams.filter(
      (d) => d.text.startsWith('width') || d.text.startsWith('height'),
    )
    expect(widths.length).toBeGreaterThan(0)
    for (const d of widths) expect(d.text).toContain('0.5px')
  })

  test('the icon-rail active pill is a soft accent WASH, not a solid fill', () => {
    const pill = properties.filter((d) =>
      d.path.some((p) => /\[data-shell-rail\] \[data-nav-active\]/.test(p)),
    )
    const bg = pill.find((d) => d.text.startsWith('background'))
    // A color-mix at low percentage — never `var(--sm-accent)` at full strength.
    expect(bg?.text).toMatch(/color-mix/)
    expect(bg?.text).toContain('var(--sm-accent)')
  })
})

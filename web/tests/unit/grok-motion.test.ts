/**
 * WS3 — the Grok-mode motion contract, enforced by a source scan.
 * ─────────────────────────────────────────────────────────────────────────────
 * The sibling of `motion-tokens.test.ts`. That file keeps the DEFAULT app's
 * bank (`springs.ts` ↔ `globals.css`) honest; this keeps GROK MODE's bank
 * (`grok-motion.ts` ↔ `grok-mode.css`) honest, on the same principle: the motion
 * table is authoritative, and a value that appears in two mediums must appear
 * from one source, never be re-typed as a literal that can drift.
 *
 * WS3 is FOUNDATION — its consumers (WS5/6/8/9) do not exist yet — so this file
 * is deliberately a scan of the two halves in isolation, not a render. What a
 * scan CAN prove is exactly what would rot: the durations exist in one place,
 * the CSS keyframes carry those same numbers, exits are faster than entries, the
 * axes differ, and every keyframe animation ships a reduced-motion twin that
 * keeps its information.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  grokEases,
  grokEaseCss,
  grokDur,
  grokMotion,
  grokKeyframes,
} from '../../src/lib/grok-motion'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const CSS = readFileSync(join(SRC, 'styles/grok-mode.css'), 'utf8')
/** Stylesheet with comments stripped — prose legitimately quotes durations. */
const cssCode = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

// ═══ the two halves agree ════════════════════════════════════════════════════

describe('WS3 — the array and css-string curve forms are the same five curves', () => {
  test('grokEases and grokEaseCss have identical keys', () => {
    expect(Object.keys(grokEaseCss).sort()).toEqual(Object.keys(grokEases).sort())
  })

  test('each css-string is the byte-for-byte cubic-bezier of its array', () => {
    for (const [name, arr] of Object.entries(grokEases)) {
      const [a, b, c, d] = arr
      expect(grokEaseCss[name as keyof typeof grokEaseCss]).toBe(
        `cubic-bezier(${a}, ${b}, ${c}, ${d})`,
      )
    }
  })
})

// ═══ the motion table, reproduced exactly (spec §4 / tokens.md §12.1) ════════

describe('WS3 — the duration vocabulary is the spec table, to the millisecond', () => {
  const TABLE: Record<string, number> = {
    hover: 0.12,
    glass: 0.15,
    dock: 0.18,
    morph: 0.26,
    arrive: 0.28,
    arriveFresh: 0.42,
    exit: 0.3,
    pendingLabel: 0.35,
    facepile: 0.4,
    row: 0.45,
    overlayIn: 0.52,
    popoverOut: 0.1,
    identity: 0.6,
    spin: 2.4,
    typing: 1.3,
    cursor: 2.6,
  }
  for (const [name, value] of Object.entries(TABLE)) {
    test(`grokDur.${name} === ${value}s`, () => {
      expect(grokDur[name as keyof typeof grokDur]).toBe(value)
    })
  }
})

// ═══ the two invariants ══════════════════════════════════════════════════════

describe('WS3 — invariant 1: exits are always faster than entries', () => {
  test('overlay .52 in / .30 out', () => {
    expect(grokMotion.overlayIn.duration).toBe(0.52)
    expect(grokMotion.overlayExit.duration).toBe(0.3)
    expect(grokMotion.overlayExit.duration).toBeLessThan(grokMotion.overlayIn.duration)
  })

  test('popover .15 in / .10 out', () => {
    expect(grokMotion.popoverIn.duration).toBe(0.15)
    expect(grokMotion.popoverOut.duration).toBe(0.1)
    expect(grokMotion.popoverOut.duration).toBeLessThan(grokMotion.popoverIn.duration)
  })
})

describe('WS3 — invariant 2: axis is identity (encoded in the keyframes)', () => {
  test('the transcript entry enters VERTICALLY (translateY), never translateX', () => {
    const kf = keyframeBody('sm-entry-enter')
    expect(kf).toContain('translateY(')
    expect(kf).not.toContain('translateX(')
  })

  test('the roster row enters HORIZONTALLY (translateX), never translateY', () => {
    const kf = keyframeBody('sm-row-enter')
    expect(kf).toContain('translateX(')
    expect(kf).not.toContain('translateY(')
  })

  test('the same-cell swap is pure opacity — linear, no distance to ease', () => {
    expect(grokMotion.swap.ease).toBe('linear')
    expect(grokMotion.swap.duration).toBe(grokDur.morph)
  })
})

// ═══ the slow identity recolour ══════════════════════════════════════════════

describe('WS3 — the .60s identity recolour is the slowest motion in Grok mode', () => {
  test('grokMotion.identity is .6s', () => {
    expect(grokMotion.identity.duration).toBe(0.6)
  })

  test('it is slower than every other framer preset', () => {
    for (const [name, m] of Object.entries(grokMotion)) {
      if (name === 'identity') continue
      expect(m.duration).toBeLessThan(grokMotion.identity.duration)
    }
  })

  test('the CSS twin transitions `fill` over .6s under [data-grok]', () => {
    const rule = cssRule('[data-grok] .grok-identity')
    expect(rule).toContain('fill 0.6s')
  })
})

// ═══ the CSS keyframes carry the JS numbers ══════════════════════════════════

describe('WS3 — every [data-grok] animation names a real keyframe at the bank duration', () => {
  const CASES: [selector: string, keyframe: string, seconds: number][] = [
    ['[data-grok] .grok-entry', grokKeyframes.entryEnter, grokDur.arrive],
    ['[data-grok] .grok-row-enter', grokKeyframes.rowEnter, grokDur.row],
    ['[data-grok] .grok-receipt', grokKeyframes.receiptCheck, grokDur.arrive],
    ['[data-grok] .grok-pending-label', grokKeyframes.pendingLabel, grokDur.pendingLabel],
    ['[data-grok] .grok-typing i', grokKeyframes.typingDot, grokDur.typing],
  ]
  for (const [selector, keyframe, seconds] of CASES) {
    test(`${selector} → ${keyframe} @ ${seconds}s`, () => {
      const rule = cssRule(selector)
      expect(rule).toContain(keyframe)
      expect(rule).toContain(`${seconds}s`)
      // the keyframe it names is actually defined
      expect(() => keyframeBody(keyframe)).not.toThrow()
    })
  }

  test('the `[data-fresh]` transcript entry lengthens to .42s', () => {
    expect(cssRule('[data-grok] .grok-entry[data-fresh]')).toContain(
      `${grokDur.arriveFresh}s`,
    )
  })

  test('the 2.4s tool spinner is REUSED from globals.css, not redefined here', () => {
    // `sm-spin` is the existing global spinner; Grok mode points at it rather
    // than shipping a second 2.4s keyframe that could drift.
    expect(grokKeyframes.spin).toBe('sm-spin')
    expect(cssCode).not.toContain('@keyframes sm-spin')
  })
})

// ═══ reduced motion keeps the information ════════════════════════════════════

describe('WS3 — reduced-motion twins stop the loop but keep the static information', () => {
  const reduce = reduceBlock()

  test('a colocated prefers-reduced-motion block exists in grok-mode.css', () => {
    expect(reduce.length).toBeGreaterThan(0)
  })

  test('the entrances collapse to their end-state (animation: none)', () => {
    for (const sel of [
      '[data-grok] .grok-entry',
      '[data-grok] .grok-row-enter',
      '[data-grok] .grok-mount-fade',
      '[data-grok] .grok-pending-label',
    ]) {
      expect(reduce).toContain(sel)
    }
    expect(reduce).toMatch(/animation:\s*none/)
  })

  test('the completed-tool ✓ still SHOWS (opacity 1), only its pop is removed', () => {
    const m = /\.grok-receipt\s*\{([^}]*)\}/.exec(reduce)
    expect(m).not.toBeNull()
    expect(m![1]).toMatch(/animation:\s*none/)
    expect(m![1]).toMatch(/opacity:\s*1/)
  })

  test('typing dots keep .25/.45/.7 so the row still reads as three dots', () => {
    for (const [n, o] of [[1, '0.25'], [2, '0.45'], [3, '0.7']] as const) {
      expect(reduce).toMatch(
        new RegExp(`\\.grok-typing i:nth-child\\(${n}\\)\\s*\\{[^}]*opacity:\\s*${o}`),
      )
    }
  })
})

// ═══ offscreen pause is inherited, and default motion is untouched ═══════════

describe('WS3 — offscreen pause is inherited; the default app is not touched', () => {
  test('grok-mode.css does not re-declare the offscreen blanket (globals.css owns it)', () => {
    // Grok keyframes are ordinary CSS animations, so the app-wide
    // `[data-offscreen] *` rule in globals.css pauses them for free.
    const GLOBALS = readFileSync(join(SRC, 'styles/globals.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(GLOBALS).toMatch(/\[data-offscreen\]\s*\*/)
    expect(cssCode).not.toContain('[data-offscreen]')
  })

  test('every animation/transition APPLICATION in grok-mode.css is [data-grok]-scoped', () => {
    // The revert guarantee: with the attribute gone, nothing animates. Keyframe
    // DEFINITIONS are global by necessity (and inert); every `animation:` /
    // `transition:` that ACTS must sit behind `[data-grok]`.
    const offenders: string[] = []
    // Scan rule-by-rule: a selector block that sets animation/transition must
    // include [data-grok] in its selector.
    const ruleRe = /([^{}]+)\{([^}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = ruleRe.exec(cssCode)) !== null) {
      const selector = m[1].trim()
      const body = m[2]
      if (selector.startsWith('@') || selector.includes('%') || selector === '') continue
      if (/(?:^|[\s;{])(animation|transition)\s*:/.test(body)) {
        if (!selector.includes('[data-grok]')) offenders.push(selector)
      }
    }
    expect(offenders).toEqual([])
  })
})

// ── helpers ─────────────────────────────────────────────────────────────────

/** The body of the first `[data-grok] …` rule whose selector list contains
 *  `selector` (exact prefix match on the trimmed selector). */
function cssRule(selector: string): string {
  const i = cssCode.indexOf(`${selector} {`)
  if (i < 0) throw new Error(`no CSS rule for ${selector}`)
  return cssCode.slice(i, cssCode.indexOf('}', i))
}

/** The body of a `@keyframes <name>` block. */
function keyframeBody(name: string): string {
  const needle = `@keyframes ${name} {`
  const i = cssCode.indexOf(needle)
  if (i < 0) throw new Error(`no @keyframes ${name}`)
  let depth = 0
  let j = i + needle.length - 1
  do {
    if (cssCode[j] === '{') depth++
    else if (cssCode[j] === '}') depth--
    j++
  } while (depth > 0 && j < cssCode.length)
  return cssCode.slice(i, j)
}

/** The single `@media (prefers-reduced-motion: reduce)` block body. */
/** Every `prefers-reduced-motion: reduce` block in grok-mode.css, concatenated.
 *  The file now carries MORE than one (the WS3 entrance/receipt/typing twin AND
 *  the mobile "Liquid Rail" nav twin, which sits earlier in source); the WS3
 *  contract lives across all of them, so gather them rather than assume order. */
function reduceBlock(): string {
  const needle = '@media (prefers-reduced-motion: reduce) {'
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const i = cssCode.indexOf(needle, from)
    if (i < 0) break
    let depth = 0
    let j = i + needle.length - 1
    do {
      if (cssCode[j] === '{') depth++
      else if (cssCode[j] === '}') depth--
      j++
    } while (depth > 0 && j < cssCode.length)
    blocks.push(cssCode.slice(i + needle.length, j - 1))
    from = j
  }
  return blocks.join('\n')
}

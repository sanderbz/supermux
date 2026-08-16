/**
 * A6 T6.3/T6.4/T6.5/T6.6 — the motion contract, enforced by a source scan.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SOURCE SCAN, AND WHY THIS FILE EXISTS AT ALL
 *
 * `lib/springs.ts` opened with the sentence "EVERY motion in the app MUST use
 * one of these presets", and by the time A6 audited it the claim was false for
 * three of seven tweens: `popoverOut` had no consumer, and
 * `containerIndicate`/`gapReveal`/`reflow` were imported but never read — their
 * durations hand-copied into `duration-[350ms]` / `duration-[120ms]` literals
 * that could drift from the bank without anything noticing. A prose claim with
 * nothing checking it rots. This file is the check.
 *
 * It is a SOURCE SCAN in the idiom of `tour-anchors.test.ts` and
 * `brand-tokens.test.ts` — read the files, parse, assert — rather than a render,
 * for the same reason those are: the motions live across ~30 components in
 * states that need a booted backend and a real compositor, so rendering them
 * would be a worse test of a weaker claim. What a scan CAN prove is exactly what
 * rotted: that the numbers exist in one place and that no call site restates one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT ASSERTED (named, so the gap is not mistaken for
 * coverage):
 *
 *   • `.28s` / `.42s` `data-fresh`-gated entry arrival, `.45s` roster-row
 *     HORIZONTAL arrival, `.6s` identity recolour. These are extracted Grok
 *     reference numbers for animations supermux has NOT BUILT — the transcript
 *     has no entry-pop (`transcript-item.tsx` contains zero framer-motion, see
 *     T6.4 below) and `ui/roster-row.tsx:38` says its arrival animation is
 *     "deliberately NOT here". Adding tokens for them now would recreate the
 *     exact dead-token problem T6.1 just deleted. They belong to whoever builds
 *     the arrival; BRAND.md §6f carries the target numbers.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { springs, tweens, motionOff } from '../../src/lib/springs'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const CSS = readFileSync(join(SRC, 'styles/globals.css'), 'utf8')
/** Stylesheet with comments stripped — prose legitimately quotes durations. */
const cssCode = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

const files = sourceFiles(SRC).map((p) => ({
  path: relative(SRC, p),
  src: readFileSync(p, 'utf8'),
}))

/** Source with line and block comments stripped, so a comment that mentions
 *  a retired literal never fails a rule about writing one. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** The three surfaces fase T6 owns. */
const OWNED = /^components\/(chat|session-tile|shell|focus-mode)\//

// ═══ T6.3 — the three speeds, and only three ════════════════════════════════

describe('T6.3 — the three-speed rule', () => {
  test('the scan found the source tree at all (guards a dead test)', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => OWNED.test(f.path))).toBe(true)
  })

  test('speed 1 — hover/press is .12s, in BOTH banks, from one object', () => {
    expect(tweens.hover.duration).toBe(0.12)
    // `gapReveal` is the SAME OBJECT, not a second 0.12 that could drift.
    expect(tweens.gapReveal).toBe(tweens.hover)
    // The CSS twin carries the identical number.
    expect(cssCode).toContain('.sm-t-hover')
    expect(cssDuration('.sm-t-hover')).toBe(tweens.hover.duration)
  })

  test('speed 1 applies to background-color AND color, not just one', () => {
    // The rule names the pair explicitly: a chip that recolours its text but
    // snaps its background reads as two different components.
    const props = cssBlock('.sm-t-hover')
    expect(props).toContain('background-color')
    expect(props).toContain('color')
  })

  test('speed 2 — the in-place morph is .26s, in both banks', () => {
    expect(tweens.swap.duration).toBe(0.26)
    expect(cssDuration('.sm-t-morph')).toBe(0.26)
    // `.sm-swap`, B1's same-cell crossfade, is the same number by hand — it
    // predates the token, so pin it rather than let it drift away.
    expect(cssCode).toMatch(/\.sm-swap\s*>\s*\*\s*\{[^}]*transition:\s*opacity\s*0\.26s/)
  })

  test('the documented exception is .4s, and it is on PADDING', () => {
    // The facepile's avatar-row morph. An exception is allowed to exist; an
    // undocumented one is not, so the property is asserted too.
    expect(cssDuration('.sm-t-pad')).toBe(0.4)
    expect(cssBlock('.sm-t-pad')).toContain('padding')
  })

  test('exits are always faster than entries', () => {
    // overlay 520 in (springs.settle, response ≈ .43s + settle) / 300 out
    expect(tweens.overlayExit.duration).toBe(0.3)
    expect(springs.settle.stiffness).toBe(210)
    // popover 150 in / 100 out
    expect(tweens.popoverOut.duration).toBeLessThan(tweens.popoverIn.duration)
    expect(tweens.popoverIn.duration).toBe(0.15)
    expect(tweens.popoverOut.duration).toBe(0.1)
  })

  test('popoverOut is not dead — BRAND.md cites it, so it must be applied', () => {
    // T6.1's decision: WIRE it rather than delete it. Before A6 the shell
    // overlay's scrim had no `exit` transition, so it inherited its 150ms
    // ENTRY on the way out — the exits-faster rule inverted on the exact
    // surface the brand doc uses as its worked example.
    const scrim = files.find((f) => f.path === 'components/shell/shell-overlay.tsx')!
    expect(code(scrim.src)).toContain('tweens.popoverOut')
    const consumers = files.filter((f) => code(f.src).includes('tweens.popoverOut'))
    expect(consumers.length).toBeGreaterThan(0)
  })

  test('every token in the bank has at least one consumer', () => {
    // The rot this whole file exists to prevent, stated as a loop.
    const all = files.filter((f) => f.path !== 'lib/springs.ts').map((f) => code(f.src)).join('\n')
    const dead: string[] = []
    for (const name of Object.keys(tweens)) if (!all.includes(`tweens.${name}`)) dead.push(`tweens.${name}`)
    for (const name of Object.keys(springs)) if (!all.includes(`springs.${name}`)) dead.push(`springs.${name}`)
    expect(dead).toEqual([])
  })

  test('statusMorph is an ALIAS of snappy, not a copy that can drift', () => {
    expect(springs.statusMorph).toBe(springs.snappy)
  })

  test('the dnd tokens are READ as values, never re-typed as literals', () => {
    const grid = code(
      files.find((f) => f.path === 'components/session-tile/group-grid.tsx')!.src,
    )
    expect(grid).toContain('tweens.containerIndicate.duration')
    expect(grid).toContain('tweens.gapReveal.duration')
    expect(grid).toContain('tweens.reflow.duration')
    // …and the literals they used to be are gone.
    expect(grid).not.toContain('duration-[350ms]')
    expect(grid).not.toContain('duration-[120ms]')
  })
})

describe('T6.3 — no call site restates a duration', () => {
  test('`transition-all` has zero occurrences, app-wide', () => {
    // The one rule that already held before A6. Keep it holding.
    const offenders = files.filter((f) => f.src.includes('transition-all')).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  test('no arbitrary `duration-[Nms]` in chat, roster, shell or focus', () => {
    // A Tailwind arbitrary duration is a number with no owner. The `.sm-t-*`
    // classes (or a `transitionDuration` read off the bank) are the answer.
    const offenders: string[] = []
    for (const f of files) {
      if (!OWNED.test(f.path)) continue
      for (const m of code(f.src).matchAll(/duration-\[(\d+m?s)\]/g)) {
        offenders.push(`${f.path}: duration-[${m[1]}]`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('no per-file motion constant survives in the chat surface', () => {
    // SWAP_S / ECHO_SWAP_S / FADE_S were four private copies of two numbers.
    // A duration in a framer transition is written in SECONDS, so the shape to
    // ban is a module-scope const holding a bare fraction. Millisecond
    // constants (backoff, debounce, timeouts) are a different thing entirely
    // and are left alone.
    //
    // CARRIED, with the reason: `live-layer.tsx` holds the fourth `SWAP_S` copy
    // and belongs to the concurrent T2 work this fase, so T6 handed over the
    // patch instead of editing it. Delete this entry when it lands — the test
    // is written to go green the moment it does, not to be relaxed again.
    const CARRIED = new Set(['components/chat/live-layer.tsx: SWAP_S'])
    const offenders: string[] = []
    for (const f of files) {
      if (!f.path.startsWith('components/chat/')) continue
      for (const m of code(f.src).matchAll(/^const\s+([A-Z][A-Z0-9_]*)\s*=\s*0?\.\d+\s*$/gm)) {
        const hit = `${f.path}: ${m[1]}`
        if (!CARRIED.has(hit)) offenders.push(hit)
      }
    }
    expect(offenders).toEqual([])
  })

  test('no raw cubic-bezier or `ease: \'linear\'` outside the bank and the stylesheet', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (f.path === 'lib/springs.ts' || !OWNED.test(f.path)) continue
      const c = code(f.src)
      if (/ease:\s*'linear'/.test(c)) offenders.push(`${f.path}: ease:'linear'`)
      if (/ease-\[cubic-bezier/.test(c)) offenders.push(`${f.path}: ease-[cubic-bezier(...)]`)
    }
    expect(offenders).toEqual([])
  })
})

// ═══ T6.4 — never animate a backlog ═════════════════════════════════════════

describe('T6.4 — a seeded backlog never animates', () => {
  /**
   * The most visible "cheap" tell there is: open a session with 200 entries and
   * watch 200 bubbles stagger in. It regresses whenever the seed path is
   * touched — which is exactly what A6's own T2 does.
   *
   * Two mechanisms hold it, and both are asserted:
   *   1. transcript entries have NO enter animation at all, so there is nothing
   *      for a seed to run; and
   *   2. every `<AnimatePresence>` on the surface sets `initial={false}`, so
   *      children present at first mount skip their `initial` state. Without it,
   *      a presence whose children arrive with the seed pops all of them.
   */
  test('transcript items carry no framer-motion enter animation', () => {
    const item = files.find((f) => f.path === 'components/chat/transcript-item.tsx')!
    const c = code(item.src)
    expect(c).not.toContain('framer-motion')
    expect(c).not.toMatch(/\binitial=\{/)
  })

  test('every AnimatePresence in the chat surface sets initial={false}', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (!f.path.startsWith('components/chat/')) continue
      for (const m of code(f.src).matchAll(/<AnimatePresence([^>]*)>/g)) {
        if (!/initial=\{false\}/.test(m[1])) offenders.push(`${f.path}: <AnimatePresence${m[1]}>`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('the things that DO pop are gated on live state, not on the seed', () => {
    // The working row and the provisional live tail are the only entrances on
    // the surface, and both live under the live layer rather than the backlog.
    const conv = code(files.find((f) => f.path === 'components/chat/conversation.tsx')!.src)
    // The backlog track itself has no enter animation.
    expect(conv).not.toMatch(/data-testid="chat-backlog"[\s\S]{0,400}?initial=\{\{/)
  })
})

// ═══ T6.5 — reduced motion ══════════════════════════════════════════════════

describe('T6.5 — the reduced-motion sweep', () => {
  test('the blanket transition reset exists and is scoped to TRANSITIONS', () => {
    const reduce = reduceBlocks()
    expect(reduce.length).toBeGreaterThanOrEqual(6)
    const host = reduce.find((b) => /\*,\s*\*::before,\s*\*::after/.test(b))
    expect(host).toBeDefined()
    // The `*` rule's OWN body — not the whole media block, which legitimately
    // also carries the by-name decorative rules below.
    const star = /\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/.exec(host!)![1]
    expect(star).toMatch(/transition-duration:\s*0\.01ms\s*!important/)
    // NOT `animation` — a `*`-scoped animation reset would freeze
    // `.sm-status-spinner`, which is functional feedback and documented to keep
    // spinning under Reduce Motion.
    expect(star).not.toMatch(/animation/)
  })

  test('functional spinners keep spinning; decorative pulses do not', () => {
    const reduce = reduceBlocks().join('\n')
    expect(reduce).not.toContain('.sm-status-spinner')
    expect(reduce).not.toContain('animate-spin')
    expect(reduce).toMatch(/\.animate-pulse\s*\{[^}]*animation:\s*none/)
  })

  test('the typing dots keep .25/.45/.7 so the row still reads as a still', () => {
    // Grok's standard, and the reason it is right: three identical dots is a
    // different component from three dots mid-wave. Before A6 all three
    // flattened to 0.6 and the row lost its shape.
    const reduce = reduceBlocks().join('\n')
    for (const [n, o] of [[1, '0.25'], [2, '0.45'], [3, '0.7']] as const) {
      expect(reduce).toMatch(
        new RegExp(`\\.sm-dots i:nth-child\\(${n}\\)\\s*\\{[^}]*opacity:\\s*${o}`),
      )
    }
  })

  test('every framer transition in the chat surface is reduce-branched', () => {
    // The concrete bug this catches: `chat/working-row.tsx:73` shipped
    // `transition={springs.cardExpand}` with no branch — in a file that already
    // read `useReducedMotion()` at :57.
    //
    // `springs.buttonPress` is the ONE documented exemption: it only ever rides
    // `whileTap`, and a press-scale bound to a finger already on the glass is
    // direct-manipulation feedback, not vestibular motion. That decision is
    // written down in BRAND.md §6f rather than left implicit — which is the
    // whole reason a root <MotionConfig> was rejected (it would have made this
    // choice silently, for all 63 sites at once).
    const offenders: string[] = []
    for (const f of files) {
      if (!f.path.startsWith('components/chat/')) continue
      for (const m of code(f.src).matchAll(/transition=\{(springs|tweens)\.(\w+)\}/g)) {
        if (m[0] === 'transition={springs.buttonPress}') continue
        offenders.push(`${f.path}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('the reduce branch is one shared object, not 30 inline literals', () => {
    expect(motionOff).toEqual({ duration: 0 })
    const users = files.filter((f) => code(f.src).includes('motionOff'))
    expect(users.length).toBeGreaterThan(5)
  })

  test('reduced-motion coverage is colocated, not one far-away block', () => {
    // Grok ships eight separate colocated blocks; the point is that each rule
    // sits beside the motion it disables so a future edit sees both at once.
    expect(reduceBlocks().length).toBeGreaterThanOrEqual(6)
  })
})

// ═══ T6.6 — offscreen surfaces pause ════════════════════════════════════════

describe('T6.6 — offscreen surfaces pause', () => {
  test('the [data-offscreen] contract exists and PAUSES rather than kills', () => {
    // `paused`, not `none`: a surface scrolled (or toggled) back into view
    // resumes at the frame it left, instead of restarting every loop in unison.
    expect(cssCode).toMatch(
      /\[data-offscreen\][\s\S]{0,60}\{\s*animation-play-state:\s*paused\s*!important/,
    )
  })

  test('it covers the SUBTREE, not just the marked element', () => {
    expect(cssCode).toMatch(/\[data-offscreen\]\s*\*/)
  })

  test('the hidden renderer is marked offscreen', () => {
    // Both renderers stay mounted across the toggle, so exactly one is always
    // invisible — and before A6 it kept running `.sm-blip`, `.sm-spin` and one
    // `.sm-breathe` per face behind the visible one.
    const shell = code(
      files.find((f) => f.path === 'components/chat/renderer-shell.tsx')!.src,
    )
    expect(shell).toMatch(/data-offscreen=\{visible \? undefined : ''\}/)
  })

  test('roster faces already unregister at scale (loop count, not just paint)', () => {
    // The stronger form of the same rule: a mark that scrolls out drops
    // `data-live` AND leaves the shared rAF ticker, so 40 offscreen faces cost
    // zero frames rather than zero pixels.
    const hook = code(readFileSync(join(SRC, 'brand/marks/use-on-screen.ts'), 'utf8'))
    expect(hook).toContain('IntersectionObserver')
    const mark = code(readFileSync(join(SRC, 'brand/marks/session-mark.tsx'), 'utf8'))
    expect(mark).toContain('useOnScreen')
    // `live` = wantsMotion && onScreen, and `live` is what gates registerMark.
    expect(mark).toMatch(/const live = wantsMotion && onScreen/)
    expect(mark).toMatch(/if \(!live[\s\S]{0,40}return[\s\S]{0,120}registerMark/)
  })
})

// ── helpers ─────────────────────────────────────────────────────────────────

/** The body of the first rule whose selector list contains `selector`. */
function cssBlock(selector: string): string {
  const i = cssCode.indexOf(`${selector} {`)
  if (i < 0) throw new Error(`no CSS rule for ${selector}`)
  return cssCode.slice(i, cssCode.indexOf('}', i))
}

/** `transition-duration` of a rule, in SECONDS, to compare against the bank. */
function cssDuration(selector: string): number {
  const m = /transition-duration:\s*([\d.]+)(m?s)/.exec(cssBlock(selector))
  if (!m) throw new Error(`no transition-duration in ${selector}`)
  return m[2] === 'ms' ? Number(m[1]) / 1000 : Number(m[1])
}

/** Every `@media (prefers-reduced-motion: reduce)` block body in globals.css. */
function reduceBlocks(): string[] {
  const out: string[] = []
  const needle = '@media (prefers-reduced-motion: reduce) {'
  let i = cssCode.indexOf(needle)
  while (i >= 0) {
    let depth = 0
    let j = i + needle.length - 1
    do {
      if (cssCode[j] === '{') depth++
      else if (cssCode[j] === '}') depth--
      j++
    } while (depth > 0 && j < cssCode.length)
    out.push(cssCode.slice(i + needle.length, j - 1))
    i = cssCode.indexOf(needle, j)
  }
  return out
}

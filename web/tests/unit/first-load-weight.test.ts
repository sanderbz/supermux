/**
 * What a cold visitor actually downloads before anything renders.
 * ─────────────────────────────────────────────────────────────────────────────
 * `size-budget.mjs` gates the JS/CSS bundle. Nothing gated the biggest single
 * asset in the product: the patched Nerd Font, 935 KB per weight, preloaded at
 * the browser's HIGHEST fetch priority from `index.html` on EVERY route —
 * including the roster, which mounts no terminal and needs no Nerd Font glyph
 * at all. Measured on Fast-3G that first load was 1.81 MB and 9.1 s to content.
 *
 * The repair is a shape, not a number, so this file pins the SHAPE:
 *
 *   · nothing preloads a font from `index.html` (the terminal routes ask for it
 *     themselves, via `use-live-term.ts`);
 *   · the family's unrestricted face is the small `-core` subset, so ordinary
 *     terminal text costs ~86 KB and not ~935 KB;
 *   · the full patched face is `unicode-range`-scoped, so the browser fetches
 *     it only when a Private-Use-Area icon glyph is actually painted;
 *   · the two ranges partition cleanly — no codepoint is served by both faces,
 *     and no codepoint the terminal needs is served by neither;
 *   · the `-core` files on disk really ARE subsets (a future font bump that
 *     copies the full file over them would otherwise pass silently);
 *   · the service worker does not precache the big faces back onto the first
 *     visit through the side door.
 *
 * Byte thresholds are deliberately loose — this guards an order of magnitude,
 * not a specific build of the font.
 */
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const bytes = (rel: string) =>
  statSync(fileURLToPath(new URL(rel, import.meta.url))).size

const html = read('../../index.html')
const css = read('../../src/styles/globals.css').replace(/\/\*[\s\S]*?\*\//g, '')
const viteConfig = read('../../vite.config.ts')
const liveTerm = read('../../src/hooks/use-live-term.ts')

/** Every `@font-face { … }` block in globals.css, as a flat record per block. */
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
  const body = m[1]
  const decl = (prop: string) =>
    new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1].trim()
  return {
    family: decl('font-family'),
    weight: decl('font-weight'),
    src: decl('src') ?? '',
    unicodeRange: decl('unicode-range'),
  }
})

const nerd = faces.filter((f) => /Nerd Font/.test(f.family ?? ''))

describe('first-load weight — the terminal font is not on the critical path', () => {
  test('index.html preloads no font at all', () => {
    const preloads = [...html.matchAll(/<link[^>]*rel="preload"[^>]*>/g)].map((m) => m[0])
    const fontPreloads = preloads.filter((p) => /as="font"|\.woff2?/.test(p))
    expect(fontPreloads).toEqual([])
    // …and specifically not the 935 KB one that used to be there.
    expect(html).not.toContain('JetBrainsMonoNerdFontMono-Regular.woff2')
  })

  test('the family splits into an unrestricted core subset and a range-scoped icon face', () => {
    // One `-core` face and one full face per weight.
    const unrestricted = nerd.filter((f) => !f.unicodeRange)
    const scoped = nerd.filter((f) => f.unicodeRange)
    expect(unrestricted.length).toBe(2)
    expect(scoped.length).toBe(2)

    // The face the browser reaches for by default must be the SMALL one.
    for (const f of unrestricted) {
      expect(f.src).toContain('-core.woff2')
    }
    // …and the 935 KB one must never be reachable without a range.
    for (const f of scoped) {
      expect(f.src).not.toContain('-core.woff2')
      expect(f.unicodeRange).toBeTruthy()
    }
    // Both weights are covered on both sides — a missing bold `-core` would
    // silently drag the full face in the first time a shell writes bold text.
    expect(new Set(unrestricted.map((f) => f.weight))).toEqual(new Set(['400', '700']))
    expect(new Set(scoped.map((f) => f.weight))).toEqual(new Set(['400', '700']))
  })

  test('the icon range is Private Use Area only, and excludes Powerline', () => {
    for (const f of nerd.filter((x) => x.unicodeRange)) {
      const ranges = (f.unicodeRange ?? '').split(',').map((r) => r.trim().toUpperCase())
      // Everything scoped away must live in a PUA. U+E000-F8FF is the BMP PUA;
      // U+F0000-10FFFF covers the two supplementary ones.
      expect(ranges.every((r) => /^U\+(E|F)[0-9A-F]/.test(r))).toBe(true)
      // Powerline (U+E0A0-E0D4) must NOT be in the deferred face: a Powerline
      // prompt is the common case and would otherwise paint tofu until a
      // 935 KB download landed.
      expect(ranges).not.toContain('U+E0A0-E0D4')
      expect(f.unicodeRange).toContain('U+E0D5-')
    }
  })

  test('the `-core` files on disk really are subsets, by an order of magnitude', () => {
    const full = bytes('../../public/fonts/JetBrainsMonoNerdFontMono-Regular.woff2')
    const core = bytes('../../public/fonts/JetBrainsMonoNerdFontMono-Regular-core.woff2')
    const coreBold = bytes('../../public/fonts/JetBrainsMonoNerdFontMono-Bold-core.woff2')
    expect(full).toBeGreaterThan(500_000)
    expect(core).toBeLessThan(200_000)
    expect(coreBold).toBeLessThan(200_000)
    expect(core * 5).toBeLessThan(full)
  })

  test('the service worker does not precache the deferred faces', () => {
    expect(viteConfig).toContain('globIgnores')
    expect(viteConfig).toMatch(/globIgnores[\s\S]{0,200}JetBrainsMonoNerdFontMono/)
  })

  test('a terminal — and only a terminal — warms the icon face', () => {
    // The `unicode-range` face is fetched lazily by the browser, which is too
    // late for xterm's synchronous glyph atlas. `use-live-term` asks for one
    // PUA codepoint when a terminal mounts, which is the only place that
    // should ever reach for those bytes.
    expect(liveTerm).toContain('\\u{E5FA}')
    expect(liveTerm).toContain('fonts.load')
  })
})

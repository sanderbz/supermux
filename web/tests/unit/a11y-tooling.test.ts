/**
 * The a11y tooling is real, and it is dev-only.
 * ─────────────────────────────────────────────────────────────────────────────
 * `eslint.config.js` has cited THIS FILE since fase A6 — "Dev-only by
 * construction (an eslint plugin is never bundled) — verified in
 * `tests/unit/a11y-tooling.test.ts`, not assumed" — and the file did not exist.
 * That is the same class of defect as the ledger ticks it sat next to: a
 * verification claim with no verification behind it. So here it is, asserting
 * both halves of the claim.
 *
 * 1. THE TOOLING EXISTS. An a11y net that is described but not installed is
 *    worse than none, because the description is what stops the next person
 *    installing one. `eslint-plugin-jsx-a11y` must be a real dependency AND
 *    actually extended by the flat config; `@axe-core/playwright` must be
 *    present and driven by a real spec.
 * 2. IT NEVER REACHES THE BUNDLE. A6 had ~4.5 KB of headroom (in fact ~0, see
 *    `scripts/size-budget.mjs`); shipping axe to users would blow it many times
 *    over. A lint plugin cannot be bundled, but `@axe-core/playwright` CAN be
 *    imported by mistake, so the guard is a grep over `src/` plus, when a build
 *    is present, over the emitted chunks.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const read = (rel: string) => readFileSync(at(rel), 'utf8')

const pkg = JSON.parse(read('../../package.json')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const eslintConfig = read('../../eslint.config.js')

const A11Y_TOOLS = ['eslint-plugin-jsx-a11y', '@axe-core/playwright'] as const

describe('the a11y tooling exists', () => {
  test('both tools are installed', () => {
    for (const tool of A11Y_TOOLS) {
      expect(
        pkg.devDependencies?.[tool],
        `${tool} must be a devDependency`,
      ).toBeTruthy()
    }
  })

  test('the lint plugin is actually extended, not merely installed', () => {
    // A plugin in package.json that no config turns on lints nothing.
    expect(eslintConfig).toContain('jsxA11y')
    expect(eslintConfig).toContain('flatConfigs.recommended')
  })

  test('the axe scan is a real spec with an enumerated baseline', () => {
    const spec = at('../e2e/smoke/a11y-axe.spec.ts')
    expect(existsSync(spec), 'T7.7 promises an axe scan — it must exist').toBe(true)
    const src = readFileSync(spec, 'utf8')
    expect(src).toContain('@axe-core/playwright')
    // The point of the baseline is that carried violations are NAMED. A scan
    // that simply asserts "no new failures" against a moving target is not one.
    expect(src).toContain('BASELINE')
  })
})

describe('and none of it ships', () => {
  test('nothing under src/ imports an a11y tool', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) {
          walk(p)
          continue
        }
        if (!/\.(ts|tsx)$/.test(e.name)) continue
        const src = readFileSync(p, 'utf8')
        for (const tool of A11Y_TOOLS) {
          if (src.includes(`from '${tool}`) || src.includes(`require('${tool}`)) {
            hits.push(`${p} imports ${tool}`)
          }
        }
      }
    }
    walk(at('../../src'))
    expect(hits).toEqual([])
  })

  test('no built chunk contains axe', () => {
    // Skipped when there is no build in the tree — `bun test` must not require
    // one. When there IS a build, this is the assertion that actually settles
    // the bundle question.
    const dist = at('../../dist/assets')
    if (!existsSync(dist)) return
    const leaked = readdirSync(dist)
      .filter((n) => n.endsWith('.js'))
      .filter((n) => readFileSync(`${dist}/${n}`, 'utf8').includes('axe-core'))
    expect(leaked).toEqual([])
  })
})

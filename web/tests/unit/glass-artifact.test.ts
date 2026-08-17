/**
 * `.glass` must ship an UNPREFIXED `backdrop-filter` — asserted through the
 * real CSS build pass, not by reading the source.
 *
 * The bug this pins: `globals.css` declared BOTH properties, and the shipped
 * bundle carried only `-webkit-backdrop-filter`. Lightning CSS (the optimiser
 * inside `@tailwindcss/vite`) treats `backdrop-filter` and its `-webkit-`
 * alias as ONE prefix group and emits the group from the LAST declaration it
 * sees; with the standard property written first, the `-webkit-` line won and
 * the standard one was dropped. Any engine without the alias then computed
 * `backdrop-filter: none`, so every sticky `.glass` header was a 72%-opaque
 * fill with the scrolled content printing straight through it.
 *
 * `tests/unit/shell-chrome-tokens.test.ts` reads the SOURCE and is structurally
 * incapable of seeing a build-stage drop, which is why it stayed green. This
 * test runs the authored declarations through `optimize()` — the very function
 * the Vite plugin calls — so it fails on the source order that caused the drop
 * and passes on the order that survives it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { optimize } from '@tailwindcss/node'
import { describe, expect, test } from 'bun:test'

const css = readFileSync(
  fileURLToPath(new URL('../../src/styles/globals.css', import.meta.url)),
  'utf8',
)

/** Pull the body of a top-level `@utility <name> { … }` block out of the sheet. */
function utilityBody(name: string): string {
  const head = `@utility ${name} {`
  const at = css.indexOf(head)
  expect(at).toBeGreaterThan(-1)
  let depth = 1
  let i = at + head.length
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
  }
  return css.slice(at + head.length, i - 1)
}

/** Count `backdrop-filter` declarations that are NOT the `-webkit-` alias. */
function unprefixedCount(out: string): number {
  return out.split(/(?<![-\w])backdrop-filter\s*:/).length - 1
}

describe('glass ships an unprefixed backdrop-filter through the build', () => {
  test('the authored @utility glass survives the Lightning CSS pass', () => {
    const body = utilityBody('glass')
    // Sanity: the source is expected to declare both.
    expect(body).toContain('-webkit-backdrop-filter:')
    expect(unprefixedCount(body)).toBe(1)

    const built = optimize(`.glass {${body}}`, { minify: true }).code
    expect(built).toContain('-webkit-backdrop-filter:blur(20px)')
    // The regression: this was 0 with the standard property declared FIRST.
    expect(unprefixedCount(built)).toBe(1)
  })

  test('the reduce-transparency fallback also keeps the standard property', () => {
    const at = css.indexOf('@media (prefers-reduced-transparency: reduce)')
    expect(at).toBeGreaterThan(-1)
    const block = css.slice(at, css.indexOf('}', css.indexOf('}', at) + 1) + 1)
    const built = optimize(block, { minify: true }).code
    expect(built).toContain('-webkit-backdrop-filter:none')
    expect(unprefixedCount(built)).toBe(1)
  })
})

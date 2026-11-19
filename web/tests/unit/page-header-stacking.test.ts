/**
 * The page-header stacking contract.
 *
 * Owner report (desktop, /store): "Als ik op desktop scroll gaat de connector
 * header verkeerd: z-index of iets anders waardoor het door elkaar loopt."
 *
 * Root cause, measured on a 1440x900 headless desktop against the live app:
 * every sticky route header shipped with a bare `z-10`. That is the SAME rung
 * as `--sm-z-content` (10), which in-flow page content legitimately uses — a
 * connector card stacks its rows at `z-10` over a full-bleed `z-0` hit target,
 * and `.cs-card` is `position: relative` with no z-index, so it opens no
 * stacking context and those child rungs escape into the root one. Equal rungs
 * are broken by TREE ORDER, and content always follows the header in the tree,
 * so the cards painted through the header: 13 of 100 hit-test points inside the
 * header band were owned by a card while the list was scrolled.
 *
 * The fix is a shared CSS contract, not a per-page z-index bump, so this suite
 * parses the stylesheets and pins it:
 *   · `sm-page-header` puts sticky route chrome on `--sm-z-header`, and
 *     isolates it so it stacks as one unit;
 *   · `sm-page-scroll` isolates the scroll body so content cannot reach out;
 *   · `.cs-card` / `.cs-featured` isolate, so a card is one layer in the page;
 *   · `--sm-z-header` stays strictly above `--sm-z-content`;
 *   · and no sticky route header carries a raw `z-<n>` class any more, which is
 *     what let the ladder drift in the first place.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
/** Comment-stripped, whitespace-collapsed stylesheet. */
const flat = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim()

const globals = flat(read('styles/globals.css'))
const storeCss = flat(read('components/store/store.css'))

/** The body of a rule/at-rule whose head matches `head`. */
function block(css: string, head: string): string {
  const i = css.indexOf(head)
  if (i < 0) return ''
  const open = css.indexOf('{', i)
  let depth = 0
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++
    else if (css[j] === '}' && --depth === 0) return css.slice(open + 1, j)
  }
  return ''
}

describe('the z-ladder the contract rests on', () => {
  test('--sm-z-header sits strictly above --sm-z-content', () => {
    const header = globals.match(/--sm-z-header:\s*(\d+)/)?.[1]
    const content = globals.match(/--sm-z-content:\s*(\d+)/)?.[1]
    expect(header).toBeDefined()
    expect(content).toBeDefined()
    expect(Number(header)).toBeGreaterThan(Number(content))
  })
})

describe('sm-page-header — the rung for sticky route chrome', () => {
  const body = block(globals, '@utility sm-page-header')

  test('is declared as a Tailwind utility', () => {
    expect(body).not.toBe('')
  })

  test('takes the named header rung, never a literal', () => {
    expect(body).toMatch(/z-index:\s*var\(--sm-z-header\)/)
    // A hard-coded number is exactly the drift this replaces.
    expect(body).not.toMatch(/z-index:\s*\d/)
  })

  test('isolates, so the chrome stacks as one unit', () => {
    expect(body).toMatch(/isolation:\s*isolate/)
  })
})

describe('sm-page-scroll — the contained scroll body', () => {
  const body = block(globals, '@utility sm-page-scroll')

  test('is declared', () => {
    expect(body).not.toBe('')
  })

  test('traps content z-indexes below the header rung', () => {
    expect(body).toMatch(/isolation:\s*isolate/)
    expect(body).toMatch(/z-index:\s*var\(--sm-z-content\)/)
    // isolation needs a box that participates: keep it positioned.
    expect(body).toMatch(/position:\s*relative/)
  })
})

describe('a store card is ONE layer in the page', () => {
  test('.cs-card / .cs-featured isolate their internal z-0 / z-10 rows', () => {
    const body = block(storeCss, '.cs-card, .cs-featured {')
    expect(body).toMatch(/isolation:\s*isolate/)
  })
})

describe('no sticky route chrome carries a raw z-index class', () => {
  // Walk the tree once; cheap enough and immune to a new page being added
  // somewhere unexpected.
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(p)) files.push(p)
    }
  }
  walk(SRC)

  test('every `sticky top-0` / `sticky bottom-0` header uses sm-page-header', () => {
    const offenders: string[] = []
    for (const f of files) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        // Prose, not markup: the class names are discussed in comments too.
        // (The horizontal `md:sticky md:left-0` pinned-tab chip never matches —
        // it is a rail chip, not route chrome over a scroller.)
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
        if (!/className|class=/.test(line) && !/'[^']*sticky/.test(line)) continue
        if (!/\bsticky\s+(top|bottom)-0\b/.test(line)) continue
        if (/\bz-\[?\d/.test(line) || !line.includes('sm-page-header')) {
          offenders.push(`${f.slice(SRC.length + 1)}: ${line.trim().slice(0, 90)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

/**
 * `RosterRow`'s three densities (fase B2 T3).
 *
 * The primitive B0 shipped was mounted nowhere; B2 makes it the overview's list
 * row, the focus strip and the pickers. The density is the whole of that change,
 * and it is a *behaviour* switch as well as a size one — a `picker` row never
 * ticks and never animates, because it is a list you arrow through.
 *
 * Rendered with `renderToStaticMarkup`, the `chat-ui-primitives.test.tsx`
 * idiom, and imported RELATIVELY: `components/chat/**` is resolved by `bun
 * test` against the root tsconfig, which has no `paths`.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { RosterRow } from '../../src/components/chat/ui/roster-row'

const html = (el: React.ReactElement): string => renderToStaticMarkup(el)

/** The component reads `window.matchMedia` at render time; bun's runner has no
 *  DOM, which the mark treats as "no motion". Stub it so the animated branch is
 *  actually exercised (the `session-mark.test.tsx` helper). */
function withMotion<T>(fn: () => T): T {
  const prev = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }
  try {
    return fn()
  } finally {
    if (prev === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = prev
  }
}

describe('geometry — three rungs, one component', () => {
  test('list is h-16 with a 40px mark (the shipped default)', () => {
    const out = html(<RosterRow seed="supermux" />)
    expect(out).toContain('h-16')
    expect(out).toContain('data-density="list"')
    expect(out).toContain('width="40"')
  })

  test('strip is h-12 with a 28px mark', () => {
    const out = html(<RosterRow seed="supermux" density="strip" />)
    expect(out).toContain('h-12')
    expect(out).toContain('data-density="strip"')
    expect(out).toContain('width="28"')
  })

  test('picker is h-10 with a 24px mark', () => {
    const out = html(<RosterRow seed="supermux" density="picker" />)
    expect(out).toContain('h-10')
    expect(out).toContain('data-density="picker"')
    expect(out).toContain('width="24"')
  })

  test('the default density is list — an unmigrated caller is unchanged', () => {
    expect(html(<RosterRow seed="x" />)).toBe(html(<RosterRow seed="x" density="list" />))
  })
})

describe('picker holds still', () => {
  test('no timestamp, whatever the caller passes', () => {
    const out = html(<RosterRow seed="supermux" density="picker" timestamp="1:47 PM" />)
    expect(out).not.toContain('1:47 PM')
  })

  test('the other densities DO show it', () => {
    for (const density of ['list', 'strip'] as const) {
      expect(html(<RosterRow seed="supermux" density={density} timestamp="1:47 PM" />)).toContain(
        '1:47 PM',
      )
    }
  })

  test('the face does not animate — the density is a behaviour switch too', () => {
    withMotion(() => {
      const still = html(<RosterRow seed="supermux" density="picker" state="working" />)
      const live = html(<RosterRow seed="supermux" density="list" state="working" />)
      expect(still).not.toContain('data-live')
      expect(live).toContain('data-live="1"')
    })
  })
})

describe('the slots the wrappers need', () => {
  test('meta fills the preview slot when there is no preview', () => {
    const out = html(<RosterRow seed="s" density="strip" meta={<span>21k tokens</span>} />)
    expect(out).toContain('21k tokens')
  })

  test('a real preview outranks meta — the session’s own words win', () => {
    const out = html(
      <RosterRow seed="s" preview="one check left." meta={<span>21k tokens</span>} />,
    )
    expect(out).toContain('one check left.')
    expect(out).not.toContain('21k tokens')
  })

  test('trailing renders after the name block', () => {
    const out = html(<RosterRow seed="s" trailing={<span>KBD</span>} />)
    expect(out).toContain('KBD')
    expect(out.indexOf('KBD')).toBeGreaterThan(out.indexOf('</span>'))
  })

  test('leading replaces the drawn mark — the kill switch seam', () => {
    const out = html(<RosterRow seed="s" leading={<i data-dot="" />} />)
    expect(out).toContain('data-dot')
    // …and the primitive draws no face of its own when it is given one.
    expect(out).not.toContain('<svg')
  })

  test('the attention dot still seats itself when a leading is supplied', () => {
    const out = html(<RosterRow seed="s" leading={<i data-dot="" />} attention />)
    expect(out).toContain('rounded-full')
    expect(out).toContain('#e5484d')
  })
})

describe('what did NOT change', () => {
  test('selection is still sm-accent-row and suppresses hover', () => {
    const sel = html(<RosterRow seed="s" selected />)
    expect(sel).toContain('sm-accent-row')
    expect(sel).not.toContain('hover:bg-fill-soft')
    expect(html(<RosterRow seed="s" />)).toContain('hover:bg-fill-soft')
  })

  test('a crew cluster still replaces the single mark', () => {
    const out = html(
      <RosterRow seed="team" crew={[{ seed: 'a' }, { seed: 'b' }, { seed: 'c' }]} />,
    )
    expect(out).toContain('<svg')
  })

  test('radius 12 is still the literal, at every density', () => {
    for (const density of ['list', 'strip', 'picker'] as const) {
      expect(html(<RosterRow seed="s" density={density} />)).toContain('rounded-[12px]')
    }
  })

  test('attention is available at every density (fact-ladder rule 2)', () => {
    for (const density of ['list', 'strip', 'picker'] as const) {
      const on = html(<RosterRow seed="s" density={density} attention />)
      const off = html(<RosterRow seed="s" density={density} />)
      expect(on.length).toBeGreaterThan(off.length)
    }
  })
})

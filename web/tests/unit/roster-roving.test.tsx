/**
 * The roster's roving tabindex — A6 T8.3, which the ledger checked and nobody
 * shipped.
 *
 * The promise was "list semantics AND a roving tabindex so a 40-session roster
 * is not 40 tab stops". Measured on the shipping roster before this landed:
 * `{lists:1, listitems:4, tileButtons:10, totalTabbables:38}`, and ArrowDown /
 * ArrowRight on a focused tile moved nothing.
 *
 * Two halves, tested where each one lives:
 *   · the STATIC contract — exactly one tabbable item per list, and the fallback
 *     when the remembered item leaves the roster — is asserted here, on rendered
 *     markup, because it is a property of the tree and not of a browser.
 *   · the BEHAVIOUR — arrows and Home/End actually moving focus — is asserted in
 *     `tests/e2e/smoke/roster-keyboard.spec.ts` against a real backend, because
 *     "an element exists" is exactly the kind of assertion that let this ship
 *     checked in the first place.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { RovingListProvider, useRovingItem } from '../../src/hooks/use-roving'

function Item({ name }: { name: string }) {
  const roving = useRovingItem(name)
  return (
    <button type="button" data-name={name} tabIndex={roving.tabIndex ?? 0}>
      {name}
    </button>
  )
}

const render = (keys: string[], rendered: string[] = keys): string =>
  renderToStaticMarkup(
    <RovingListProvider keys={keys}>
      {rendered.map((n) => (
        <Item key={n} name={n} />
      ))}
    </RovingListProvider>,
  )

/** The `tabindex` of each rendered button, in DOM order. */
const stops = (html: string): number[] =>
  [...html.matchAll(/tabindex="(-?\d+)"/g)].map((m) => Number(m[1]))

describe('a list is ONE tab stop, not one per row', () => {
  test('ten sessions produce a single tabbable item', () => {
    const names = Array.from({ length: 10 }, (_, i) => `s${i}`)
    const t = stops(render(names))
    expect(t.length).toBe(10)
    expect(t.filter((v) => v === 0).length).toBe(1)
    expect(t.filter((v) => v === -1).length).toBe(9)
  })

  test('the tab stop starts on the first row', () => {
    expect(stops(render(['a', 'b', 'c']))).toEqual([0, -1, -1])
  })

  test('an empty list renders nothing and asserts nothing', () => {
    expect(stops(render([]))).toEqual([])
  })
})

describe('the list can always be entered', () => {
  test('a row that is rendered but not in `keys` is not the tab stop', () => {
    // Guards the failure mode that would be WORSE than the bug: a list where no
    // item has tabIndex 0 is a composite widget the keyboard cannot enter at
    // all. The first key always owns the stop, so a stray render never strands
    // the list.
    const t = stops(render(['a', 'b'], ['a', 'b', 'ghost']))
    expect(t.filter((v) => v === 0).length).toBe(1)
    expect(t[0]).toBe(0)
  })
})

describe('outside a provider nothing changes', () => {
  test('a lone row keeps its ordinary tab stop', () => {
    // Pickers, the archived sheet and the benches render these components with
    // no roster around them. `tabIndex: undefined` means "keep what you had",
    // so they must not silently become untabbable.
    const html = renderToStaticMarkup(<Item name="lonely" />)
    expect(stops(html)).toEqual([0])
  })
})

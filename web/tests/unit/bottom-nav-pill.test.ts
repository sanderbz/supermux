/**
 * grok phone-nav sliding pill — the pill must ALWAYS settle under the
 * active-route cell (the one carrying `aria-current="page"`), and never strand
 * on a merely-tapped cell.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUG (device report): "vaak gaat 't achtergrondje naar de middelste optie
 * terwijl ie niet selected is" — the tinted pill parks behind the MIDDLE cell
 * (Workflows, index 2) while Overview (index 0) is the selected tab.
 *
 * ROOT CAUSE. `onNavTap` writes `--nav-i` on the live <nav> IMPERATIVELY for a
 * sub-100ms glide, before react-router commits. React does NOT know about that
 * mutation: its `style`-prop reconciler diffs each render against the value IT
 * last rendered, not against the live DOM. So on any commit where the new
 * `activeIndex` equals the value React last rendered, React SKIPS the `--nav-i`
 * write — and the imperative tap value stays stranded on the tapped cell while
 * `aria-current` sits on the real active cell. `reactStyleWriteModel` below
 * reproduces exactly that skip.
 *
 * THE FIX. `reconcileNavPill`, called from a layout effect keyed on the route,
 * re-asserts the committed truth (`activeNavIndex`, the same `end`/prefix rule
 * that drives `aria-current`) on the live node after every navigation. This
 * suite proves the strand and proves the reconcile removes it — no DOM/jsdom in
 * this runner, so it drives the SAME pure helpers the component calls against a
 * fake `<nav>` whose `style` is a backing map.
 */
import { describe, expect, test } from 'bun:test'

import {
  activeNavIndex,
  bottomNavItems,
  reconcileNavPill,
} from '../../src/components/layout'

/** A stand-in for the live <nav>: a `style` with the two custom-property verbs
 *  the component uses, backed by a Map so a test can read what was written. */
function fakeNav() {
  const props = new Map<string, string>()
  return {
    props,
    style: {
      setProperty: (p: string, v: string) => {
        props.set(p, v)
      },
      getPropertyValue: (p: string) => props.get(p) ?? '',
    } as unknown as CSSStyleDeclaration,
  }
}

/** Models React's `style`-prop reconciliation of `--nav-i`: it writes the live
 *  DOM ONLY when the newly rendered value differs from the value React last
 *  rendered (its own record) — it never consults the live DOM. Returns the new
 *  record. This is the machinery that lets an imperative tap value strand. */
function reactStyleWriteModel(
  nav: ReturnType<typeof fakeNav>,
  recordedIndex: number,
  nextActiveIndex: number,
): number {
  if (nextActiveIndex !== recordedIndex) {
    nav.style.setProperty('--nav-i', String(nextActiveIndex))
  }
  return nextActiveIndex
}

const GROK_BAR = ['/', '/store', '/workflows', '/browser', '/files']

describe('grok bottom-nav cells', () => {
  test('the grok phone bar is the five expected cells, middle = /workflows', () => {
    const hrefs = bottomNavItems(true).map((i) => i.to)
    expect(hrefs).toEqual(GROK_BAR)
    // The device report is specifically about the MIDDLE cell.
    expect(hrefs[2]).toBe('/workflows')
  })

  test('the BASE bar drops the grok-only doorways (byte-identical default)', () => {
    expect(bottomNavItems(false).map((i) => i.to)).toEqual([
      '/',
      '/files',
      '/settings',
    ])
  })
})

describe('activeNavIndex — the one source of pill truth (== aria-current)', () => {
  const items = bottomNavItems(true)
  const at = (p: string) => activeNavIndex(items, p)

  test('each bar route maps to its own cell', () => {
    expect(at('/')).toBe(0)
    expect(at('/store')).toBe(1)
    expect(at('/workflows')).toBe(2)
    expect(at('/browser')).toBe(3)
    expect(at('/files')).toBe(4)
  })

  test('non-`end` cells match their sub-routes by prefix (aria-current stays)', () => {
    expect(at('/workflows/new')).toBe(2)
    expect(at('/workflows/abc123')).toBe(2)
    expect(at('/files/some/deep/path')).toBe(4)
    expect(at('/store/anything')).toBe(1)
  })

  test('Overview is `end` — it never prefix-swallows another route', () => {
    // If Overview matched by prefix, EVERY path would resolve to cell 0.
    expect(at('/store')).not.toBe(0)
    expect(at('/anything')).toBe(-1)
  })

  test('a sibling that merely shares a name prefix is NOT a match', () => {
    // '/storefront' must not match '/store' (guards the `${to}/` boundary).
    expect(at('/storefront')).toBe(-1)
    expect(at('/workflowsX')).toBe(-1)
  })

  test('chromeful sub-routes not in the bar resolve to -1 (pill hides)', () => {
    expect(at('/settings')).toBe(-1)
    expect(at('/focus/session-a')).toBe(-1)
    expect(at('/team/acme')).toBe(-1)
  })

  test('`/agent/<name>` parks under Home — it IS home, wearing an address', () => {
    // The bot-thread doorway renders the same Overview element and is replaced
    // with `/` once the roster consumes the name; the pill must not blink away
    // to nowhere while that happens.
    expect(at('/agent/session-a')).toBe(0)
    expect(at('/agent/deploy%20fix')).toBe(0)
    // …but the boundary still holds: `/agent` alone is not the doorway.
    expect(at('/agent')).toBe(-1)
    expect(at('/agents/x')).toBe(-1)
  })
})

describe('the strand — and its fix', () => {
  const items = bottomNavItems(true)

  test('REPRODUCE: an optimistic tap strands the pill on the middle cell', () => {
    // Start on Overview ('/'): pill under cell 0, React has recorded 0.
    const nav = fakeNav()
    let recorded = 0
    nav.style.setProperty('--nav-i', '0')

    // The user taps Workflows (cell 2). onNavTap writes --nav-i imperatively for
    // the glide — React does NOT observe this.
    nav.style.setProperty('--nav-i', '2')

    // …but the route does NOT settle on /workflows (an interrupted/redirected/
    // no-op navigation): the committed active route is still Overview, so the
    // next render's activeIndex is 0 — EQUAL to React's recorded 0.
    const activeIndex = activeNavIndex(items, '/') // 0
    recorded = reactStyleWriteModel(nav, recorded, activeIndex)

    // React saw 0 === 0 and skipped the write. The pill is STRANDED on cell 2
    // (Workflows, the middle) while aria-current is on cell 0 (Overview).
    expect(nav.style.getPropertyValue('--nav-i')).toBe('2')
    expect(activeIndex).toBe(0)
    expect(recorded).toBe(0) // React thinks the pill is at 0; the DOM says 2.
  })

  test('FIX: reconcileNavPill re-asserts the active cell over the strand', () => {
    const nav = fakeNav()
    nav.style.setProperty('--nav-i', '2') // stranded on the middle cell
    const activeIndex = activeNavIndex(items, '/') // truth = 0

    reconcileNavPill(nav, true, activeIndex)

    // The pill is back under the active (aria-current) cell — never the middle.
    expect(nav.style.getPropertyValue('--nav-i')).toBe('0')
  })

  test('the reconcile wins over ANY stale/stranded imperative value', () => {
    for (const strandedAt of ['1', '2', '3', '4', '-1', '', 'NaN']) {
      const nav = fakeNav()
      nav.style.setProperty('--nav-i', strandedAt)
      const activeIndex = activeNavIndex(items, '/files') // 4
      reconcileNavPill(nav, true, activeIndex)
      expect(nav.style.getPropertyValue('--nav-i')).toBe('4')
    }
  })

  test('the pill it settles on ALWAYS equals the aria-current cell', () => {
    // For every in-bar route, reconcile writes exactly activeNavIndex — the same
    // index NavLink uses for aria-current — so pill and screen-reader agree.
    for (const path of GROK_BAR) {
      const nav = fakeNav()
      nav.style.setProperty('--nav-i', '2') // pretend a prior tap left the middle
      const activeIndex = activeNavIndex(items, path)
      reconcileNavPill(nav, true, activeIndex)
      expect(nav.style.getPropertyValue('--nav-i')).toBe(String(activeIndex))
    }
  })
})

describe('the fix does not break the glide or the base bar', () => {
  test('a tap that DOES become active keeps its value (glide lands, no jump)', () => {
    // On '/', tap Workflows(2) -> optimistic 2. Route settles on /workflows so
    // activeIndex is 2; reconcile writes the SAME 2 — the CSS transition already
    // gliding toward cell 2 is never interrupted.
    const nav = fakeNav()
    nav.style.setProperty('--nav-i', '2') // optimistic tap write
    const activeIndex = activeNavIndex(bottomNavItems(true), '/workflows') // 2
    reconcileNavPill(nav, true, activeIndex)
    expect(nav.style.getPropertyValue('--nav-i')).toBe('2')
  })

  test('off grok, reconcile is a no-op (base/desktop bars untouched)', () => {
    const nav = fakeNav()
    nav.style.setProperty('--nav-i', '2')
    reconcileNavPill(nav, false, 4)
    // Nothing written — the base bar has no pill and no --nav-i contract.
    expect(nav.style.getPropertyValue('--nav-i')).toBe('2')
  })

  test('a null node is tolerated (ref not yet attached / after unmount)', () => {
    expect(() => reconcileNavPill(null, true, 0)).not.toThrow()
  })
})

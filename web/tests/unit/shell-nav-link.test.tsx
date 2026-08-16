/**
 * `<MorphNavLink>` — the primary nav's link (fase B1 T5).
 * ─────────────────────────────────────────────────────────────────────────────
 * The nav used to render plain `NavLink`s; B1 routes their clicks through the
 * View Transitions API so the active pill morphs between slots. That is only
 * safe if the swap changes NOTHING else about the element, because the nav is
 * the app's most load-bearing affordance. Two properties are asserted here
 * because both are silently losable in a refactor and neither is visible in a
 * screenshot:
 *
 *   1. it still renders a REAL `<a href>`. `MorphNavLink` intercepts only a
 *      plain left-click; middle-click, ⌘-click and "open in new tab" must fall
 *      through to the browser, and they can only do that if there is an href
 *      to fall through to. (An onClick-only `<div role="link">` looks identical
 *      and breaks every one of them.)
 *   2. the active item still carries `aria-current="page"` — the only signal a
 *      screen reader gets about where it is, since the pill is purely visual.
 *
 * Plus: the active pill carries the ONE view-transition name (and no framer
 * `layoutId` machinery), which is what makes the morph a single animation
 * instead of two fighting ones.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import {
  MorphNavLink,
  NAV_ACTIVE_VT_NAME,
} from '../../src/components/view-transitions/morph'

function render(at: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[at]}>
      <nav aria-label="Primary">
        <MorphNavLink to="/" end>
          {({ isActive }) => (
            <>
              {isActive && (
                <span
                  data-nav-active=""
                  style={{ viewTransitionName: NAV_ACTIVE_VT_NAME }}
                />
              )}
              Overview
            </>
          )}
        </MorphNavLink>
        <MorphNavLink to="/files">
          {({ isActive }) => (
            <>
              {isActive && (
                <span
                  data-nav-active=""
                  style={{ viewTransitionName: NAV_ACTIVE_VT_NAME }}
                />
              )}
              Files
            </>
          )}
        </MorphNavLink>
      </nav>
    </MemoryRouter>,
  )
}

describe('MorphNavLink', () => {
  /** Split the markup into one string per anchor (attribute ORDER is a React
   *  implementation detail, so never assert on it). */
  function anchors(html: string): string[] {
    return html.split('<a ').slice(1).map((s) => s.split('</a>')[0])
  }

  test('renders real anchors with hrefs (modifier-clickable, crawlable)', () => {
    const html = render('/')
    const found = anchors(html)
    // Two links, two anchors — nothing became a div/button.
    expect(found.length).toBe(2)
    expect(found.some((a) => a.includes('href="/"'))).toBe(true)
    expect(found.some((a) => a.includes('href="/files"'))).toBe(true)
  })

  test('the active item carries aria-current="page", the inactive one does not', () => {
    const found = anchors(render('/files'))
    const overview = found.find((a) => a.includes('href="/"'))!
    const files = found.find((a) => a.includes('href="/files"'))!
    expect(files).toContain('aria-current="page"')
    expect(overview).not.toContain('aria-current="page"')
  })

  test('exactly one pill exists, and it carries the view-transition name', () => {
    const html = render('/files')
    expect(html.match(/data-nav-active/g)?.length).toBe(1)
    expect(html).toContain(`view-transition-name:${NAV_ACTIVE_VT_NAME}`)
  })

  test('the pill name is a single stable custom-ident (unique per snapshot)', () => {
    // Two names would mean two groups and no morph; a per-item name would mean
    // the browser cross-fades two different elements instead of tweening one.
    expect(NAV_ACTIVE_VT_NAME).toBe('sm-nav-active')
    expect(NAV_ACTIVE_VT_NAME).toMatch(/^[a-z][a-z0-9-]*$/)
  })
})

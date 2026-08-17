// The axe net (fase A6 T7.7, landed for real).
//
// T7.7 was ticked in the A6 ledger and never shipped: `grep -i axe package.json`
// returned nothing, there was no such spec, and `eslint.config.js` cited a
// verification file (`tests/unit/a11y-tooling.test.ts`) that did not exist
// either. So an accessibility pass that closed fourteen named gaps had no
// automated floor under it at all — which is part of why several of them
// regressed silently.
//
// WHAT THIS ASSERTS. Not "axe is green" — it is not, and pretending otherwise
// would mean either deleting real findings or never landing the scan. It
// asserts a BASELINE: the set of `route · surface · rule` triples currently
// violating WCAG 2 A/AA is exactly `BASELINE` below. A NEW violation fails; a
// FIXED violation also fails, loudly, so the baseline shrinks by intent rather
// than rotting. Every entry is attributed to the finding that owns it —
// nothing is carried anonymously.
//
// Aggregated by RULE rather than by node on purpose. A node-level baseline
// churns on every copy change and is abandoned within a fase; a rule-level one
// answers the question that matters ("has this surface grown a new KIND of
// failure?") and is stable enough to keep.
//
// Dev-only by construction: `@axe-core/playwright` is a devDependency and axe
// is injected into the page by the runner, never imported by `src/` — asserted
// in `tests/unit/a11y-tooling.test.ts`.
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

import { injectGlobals, startBackend, type Backend } from './harness'

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

/** The surfaces T7.7 named. The `/dev/*` benches render the real components
 *  against fixture data, which is what makes this runnable with no live agent. */
const SCANS = [
  { route: '/dev/roster', viewport: DESKTOP, surface: 'desktop' },
  { route: '/dev/chat-ui', viewport: DESKTOP, surface: 'desktop' },
  { route: '/dev/chat-live', viewport: DESKTOP, surface: 'desktop' },
  { route: '/dev/focus', viewport: DESKTOP, surface: 'desktop' },
  { route: '/?mock', viewport: DESKTOP, surface: 'desktop' },
  { route: '/dev/focus-mobile', viewport: PHONE, surface: 'phone' },
] as const

const THEMES = ['dark', 'light'] as const

/**
 * Known-failing today. Each line is `<route> <theme>/<surface> <rule>`.
 *
 *   color-contrast     — RE-ATTRIBUTED (round-2 finding 17). This rationale used
 *                        to name the light-theme token gap and the ink-3 ladder;
 *                        both are closed, and the live offender was neither. It
 *                        was ALPHA MODIFIERS in classNames —
 *                        `text-muted-foreground/70` composites to 2.89:1 on the
 *                        light card, `/80` to 3.34:1 — which a token walk cannot
 *                        see by construction, and which `theme-contrast.test.ts`
 *                        now bans for text outright. Whatever remains on these
 *                        dev benches is fixture-only chrome; the routes a user
 *                        actually opens are the ones the unit guard covers.
 *   nested-interactive — the focus surface nests controls inside a control.
 *                        Carried, not excused: it belongs with the roster
 *                        keyboard work ("The roster has no roving tabindex…"),
 *                        which is where the interactive structure gets rebuilt.
 *
 * Shrink this list. Do not grow it without a finding to point at.
 */
const BASELINE: readonly string[] = [
  '/?mock dark/desktop color-contrast',
  '/?mock light/desktop color-contrast',
  '/dev/chat-live light/desktop color-contrast',
  '/dev/chat-ui dark/desktop color-contrast',
  '/dev/chat-ui light/desktop color-contrast',
  '/dev/focus dark/desktop color-contrast',
  '/dev/focus dark/desktop nested-interactive',
  '/dev/focus light/desktop color-contrast',
  '/dev/focus light/desktop nested-interactive',
  '/dev/roster dark/desktop color-contrast',
  '/dev/roster light/desktop color-contrast',
]

test.describe('axe — WCAG 2 A/AA over the shell surfaces', () => {
  let backend: Backend

  test.beforeAll(async () => {
    backend = await startBackend()
  })
  test.afterAll(async () => {
    await backend?.dispose()
  })

  test('the violation set is exactly the enumerated baseline', async ({ page }) => {
    test.setTimeout(240_000)
    await page.addInitScript(injectGlobals(backend.token))

    const found: string[] = []
    for (const theme of THEMES) {
      for (const scan of SCANS) {
        await page.addInitScript(
          (t) => window.localStorage.setItem('supermux-theme', t),
          theme,
        )
        await page.setViewportSize(scan.viewport)
        await page.goto(`${backend.baseUrl}${scan.route}`)
        // Several surfaces mount their content in an effect; axe would
        // otherwise scan a skeleton and report a reassuring nothing.
        await page.waitForTimeout(1_200)
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
        for (const v of results.violations) {
          found.push(`${scan.route} ${theme}/${scan.surface} ${v.id}`)
        }
      }
    }

    const sorted = [...new Set(found)].sort()
    expect(
      sorted,
      'the axe baseline must change only on purpose — a fixed rule must be REMOVED from BASELINE in the same commit that fixes it',
    ).toEqual([...BASELINE].sort())
  })
})

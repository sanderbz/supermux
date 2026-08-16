/**
 * The onboarding tour's anchors must exist (fase B1 T9.5).
 * ─────────────────────────────────────────────────────────────────────────────
 * `STEP_TARGETS` in tour-overlay.tsx is a list of CSS selectors pointing at
 * `data-tour` attributes scattered across the app. `floating-tip.tsx` degrades
 * to a screen-centred card when a target is missing — which is a kind
 * degradation and a terrible failure mode: the tour still "works", it just
 * stops pointing at anything, and nobody notices until a user is being told
 * about a feature while a card floats over the middle of the screen.
 *
 * B1 is exactly the change that causes it: the scheduler's nav item is gone, so
 * step 3's `[data-tour="scheduler"]` would have dangled. This test is the
 * structural guarantee — every selector in STEP_TARGETS must appear as a
 * literal `data-tour="…"` attribute somewhere in `web/src`.
 *
 * It is a SOURCE SCAN, in the `brand-tokens.test.ts` file-parsing idiom, rather
 * than a render: the anchors live on four different routes in states that only
 * exist with a booted backend, so rendering them all would be a worse test of a
 * weaker claim.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const TOUR = join(SRC, 'components/onboarding/tour-overlay.tsx')

/** Every .ts/.tsx file under web/src. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

const allSource = sourceFiles(SRC)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

const tourSrc = readFileSync(TOUR, 'utf8')

/** The selectors listed in STEP_TARGETS, parsed out of the source. */
const selectors = Array.from(
  tourSrc
    .slice(tourSrc.indexOf('const STEP_TARGETS'), tourSrc.indexOf('export interface'))
    .matchAll(/anchor:\s*'(\[data-tour="([^"]+)"\])'/g),
).map((m) => ({ selector: m[1], name: m[2] }))

describe('tour anchors', () => {
  test('STEP_TARGETS was parsed at all (guards a dead test)', () => {
    expect(selectors.length).toBeGreaterThan(0)
  })

  test('there is one target per tour step', () => {
    const copy = readFileSync(join(SRC, 'brand/copy.ts'), 'utf8')
    const tour = copy.slice(copy.indexOf('  tour: ['))
    const steps = Array.from(
      tour.slice(0, tour.indexOf('\n  ],')).matchAll(/^\s{6}title:/gm),
    ).length
    expect(selectors.length, 'STEP_TARGETS length matches ONBOARDING.tour').toBe(
      steps,
    )
  })

  for (const { selector, name } of selectors) {
    test(`${selector} resolves to a real data-tour attribute in web/src`, () => {
      expect(allSource).toContain(`data-tour="${name}"`)
    })
  }

  test('step 3 points at Settings, where schedules now live (B1 T9.3)', () => {
    // The scheduler route is deleted; if this ever reverts to "scheduler" the
    // anchor test above would catch the dangle, but this pins the INTENT.
    expect(selectors[2]?.name).toBe('settings')
  })

  test('no step still points at the deleted scheduler nav item', () => {
    expect(selectors.map((s) => s.name)).not.toContain('scheduler')
    expect(allSource).not.toContain('data-tour="scheduler"')
  })

  test('the copy for step 3 names its new home', () => {
    const copy = readFileSync(join(SRC, 'brand/copy.ts'), 'utf8')
    expect(copy).toContain('Schedules live in Settings now')
  })
})

/**
 * The `/dev/roster` bench — a coverage contract, not a fixture dump.
 * ─────────────────────────────────────────────────────────────────────────────
 * The bench exists so fase B2 has ONE surface where every roster channel is on
 * screen at once, and so every VR sweep in the fase has something stable to diff
 * against. That claim is only true if the bench actually spans the channels — so
 * it is asserted here rather than eyeballed, in the `dev-marks-cast.test.tsx`
 * precedent.
 *
 * Two halves:
 *   1. the CAST (data) spans 3 densities × 6 states × 3 tiers (+ quiet) × 2
 *      themes, the roster of 14 deduped to 14 distinct faces, and every model
 *      named by the matrices actually exists in the cast;
 *   2. the ROUTE (source scan) renders one section per declared section id and
 *      references every channel — so a section cannot be dropped, and a task
 *      that adds a surface has to add it to `BENCH_SECTIONS` first.
 *
 * The route itself is not rendered: it is a `.tsx` full of `@/` aliases the unit
 * runner cannot resolve (no `paths` in the root tsconfig), which is exactly why
 * the cast is a separate module. The rows it is made of ARE rendered, through
 * `RosterRow` directly, so the matrix is proved to produce distinct markup.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { characterFromSeed } from '../../src/brand/marks/character'
import { RosterRow } from '../../src/components/chat/ui/roster-row'
import {
  ATTENTION_TIERS,
  BENCH_SECTIONS,
  BENCH_THEMES,
  DENSITY_ROLES,
  ISSUE_STATES,
  PINNED_NAMES,
  ROLLUP_COUNTS,
  ROSTER_CAST,
  ROSTER_DENSITIES,
  ROSTER_NAMES,
  ROSTER_STATES,
  STATE_MODELS,
  TIER_MODELS,
  TILE_TIERS,
} from '../../src/routes/dev-roster.cast'

const ROUTE = readFileSync(
  fileURLToPath(new URL('../../src/routes/dev-roster.tsx', import.meta.url)),
  'utf8',
)

describe('dev-roster cast — the four channels', () => {
  test('three densities, each with a stated role', () => {
    expect([...ROSTER_DENSITIES]).toEqual(['list', 'strip', 'picker'])
    for (const d of ROSTER_DENSITIES) {
      expect(DENSITY_ROLES[d]?.length ?? 0).toBeGreaterThan(10)
    }
  })

  test('all six mark states are benched', () => {
    expect([...ROSTER_STATES].sort()).toEqual(
      ['done', 'failed', 'idle', 'stopped', 'waiting', 'working'].sort(),
    )
  })

  test('three attention tiers plus quiet, in precedence order', () => {
    expect([...ATTENTION_TIERS]).toEqual(['needs', 'unread', 'working', 'quiet'])
  })

  test('both themes render on one page', () => {
    expect([...BENCH_THEMES]).toEqual(['light', 'dark'])
  })

  test('the matrix the bench claims is 3 × 6 × 4 × 2', () => {
    const cells =
      ROSTER_DENSITIES.length * ROSTER_STATES.length * ATTENTION_TIERS.length * BENCH_THEMES.length
    expect(cells).toBe(144)
  })
})

describe('dev-roster cast — the roster', () => {
  test('fourteen names, fourteen members, no duplicates', () => {
    expect(ROSTER_CAST.length).toBe(ROSTER_NAMES.length)
    expect(new Set(ROSTER_CAST.map((m) => m.name)).size).toBe(ROSTER_CAST.length)
  })

  test('deduped as one unit — fourteen distinct silhouette × pigment pairs', () => {
    const tokens = ROSTER_CAST.map((m) => {
      const c = characterFromSeed(m.name, m.pin)
      return `${c.silhouette}:${c.hue}`
    })
    expect(new Set(tokens).size).toBe(ROSTER_CAST.length)
  })

  test('every member has a preview line and a timestamp — the preview IS the status line', () => {
    for (const m of ROSTER_CAST) {
      expect(m.preview.length).toBeGreaterThan(0)
      expect(m.timestamp.length).toBeGreaterThan(0)
    }
  })

  test('every model named by a matrix exists in the cast', () => {
    const names = new Set(ROSTER_CAST.map((m) => m.name))
    for (const state of ROSTER_STATES) expect(names.has(STATE_MODELS[state])).toBe(true)
    for (const tier of ATTENTION_TIERS) expect(names.has(TIER_MODELS[tier])).toBe(true)
    for (const p of PINNED_NAMES) expect(names.has(p)).toBe(true)
  })

  test('the pinned fixture is the only configuration where a hairline renders', () => {
    // ≥1 pinned AND ≥1 unpinned, or there is no boundary to draw (T7).
    expect(PINNED_NAMES.length).toBeGreaterThan(0)
    expect(ROSTER_CAST.length).toBeGreaterThan(PINNED_NAMES.length)
  })

  test('the other benched surfaces carry their edges', () => {
    expect([...TILE_TIERS]).toEqual([1, 2, 3, 4])
    // 0 (renders nothing) and a count past the collapse threshold are both on
    // the page, or the rollup's two interesting cases are untested by eye.
    expect(ROLLUP_COUNTS).toContain(0)
    expect(Math.max(...ROLLUP_COUNTS)).toBeGreaterThan(3)
    expect([...ISSUE_STATES]).toEqual(['empty', 'loading', 'error', 'populated'])
  })
})

describe('dev-roster route — the bench cannot quietly shrink', () => {
  test('every declared section is rendered by the route', () => {
    for (const id of BENCH_SECTIONS) {
      expect(ROUTE).toContain(`id="${id}"`)
    }
  })

  test('the route renders one panel per theme via the [data-theme] subtree switch', () => {
    expect(ROUTE).toContain('data-theme={theme}')
    expect(ROUTE).toContain('BENCH_THEMES.map')
  })

  test('all three densities and all six states are driven from the cast, not hard-coded', () => {
    expect(ROUTE).toContain('ROSTER_DENSITIES.map')
    expect(ROUTE).toContain('ROSTER_STATES.map')
    expect(ROUTE).toContain('ATTENTION_TIERS.map')
    expect(ROUTE).toContain('TILE_TIERS.map')
  })

  test('EVERY section has landed — no pending plates left', () => {
    // The bench grew task by task, and an unlanded section rendered a loud
    // `data-bench-pending` plate (an empty section and a missing section look
    // identical in a screenshot). By the end of B2 there are none, and this
    // assertion is what stops one from creeping back in as a permanent excuse.
    expect(ROUTE).not.toContain('data-bench-pending')
  })

  test('the rollup and the issue surface render real components, not placeholders', () => {
    expect(ROUTE).toContain('<AttentionRollup')
    expect(ROUTE).toContain('<AcceptanceChecklist')
    expect(ROUTE).toContain('<ReplyComposer')
    expect(ROUTE).toContain('data-vr="pinned-hairline"')
  })
})

describe('dev-roster rows — the matrix produces distinct markup', () => {
  test('each mark state renders a different face', () => {
    const seen = new Map<string, string>()
    for (const state of ROSTER_STATES) {
      const html = renderToStaticMarkup(
        <RosterRow seed="chat-dataplane" state={state} name="chat-dataplane" />,
      )
      for (const [other, prev] of seen) {
        expect(html === prev).toBe(false)
        expect(other).not.toBe(state)
      }
      seen.set(state, html)
    }
    expect(seen.size).toBe(ROSTER_STATES.length)
  })

  test('the attention dot is the only glyph added, and only when attention is set', () => {
    const quiet = renderToStaticMarkup(<RosterRow seed="night-watch" />)
    const needs = renderToStaticMarkup(<RosterRow seed="night-watch" attention />)
    expect(needs.length).toBeGreaterThan(quiet.length)
    // C5: no ring, no notch — the silhouette markup is untouched by attention.
    expect(needs).toContain(quiet.slice(quiet.indexOf('<svg'), quiet.indexOf('</svg>')))
  })
})

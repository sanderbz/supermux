/**
 * Fase B4 T8 — the per-session Schedules sheet, and the coordination rule that
 * makes it safe to ship next to B1.
 * ─────────────────────────────────────────────────────────────────────────────
 * The sheet itself is a list, a filter and a header over components that are
 * already covered: the editor, the run history, the test-fire and the enable
 * toggle are the SHIPPED `components/scheduler/*` ones, exercised end-to-end by
 * `tests/e2e/smoke/scheduler-fold.spec.ts`. Re-rendering them here would only
 * assert that an import statement works.
 *
 * What is worth pinning is the thing no screenshot and no e2e can see: the
 * DEPENDENCY RULE from the plan's §0.6. B4 was written while B1's scheduler
 * fold was in flight, and B4 only compiles and behaves identically in both
 * worlds because it depends on `components/scheduler/*` +
 * `lib/api/scheduler.ts` + `hooks/use-scheduler.ts` and on nothing route-shaped
 * — with exactly one exception, which goes through `scheduleAdminHref()`. That
 * rule is invisible to the type checker and to every other test, so it is
 * asserted here against the source.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import { scheduleAdminHref } from '../../src/components/session-schedules/schedule-href'

const SHEET = readFileSync(
  new URL('../../src/components/session-schedules/session-schedules-sheet.tsx', import.meta.url),
  'utf8',
)
const HREF = readFileSync(
  new URL('../../src/components/session-schedules/schedule-href.ts', import.meta.url),
  'utf8',
)

/** Every module specifier the sheet imports from. */
const imports = [...SHEET.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!)

/** The sheet's source with its comments stripped — so a route NAMED in a
 *  comment (explaining why it is not used) is not mistaken for one used. */
const CODE = SHEET.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the §0.6 dependency rule, executable', () => {
  test('the sheet reaches the scheduler only through its components, api and hook', () => {
    const scheduler = imports.filter((i) => i.includes('scheduler'))
    expect(scheduler.length).toBeGreaterThan(0)
    for (const spec of scheduler) {
      expect(
        spec.startsWith('@/components/scheduler/') ||
          spec === '@/lib/api/scheduler' ||
          spec === '@/hooks/use-scheduler',
      ).toBe(true)
    }
  })

  test('it never imports the route B1 deleted, nor the section B1 added', () => {
    // Either import would tie B4's landing order to B1's. `routes/scheduler`
    // does not exist any more; `settings/schedules-section` does, and importing
    // it would drag the whole settings tree into the chat chunk.
    for (const spec of imports) {
      expect(spec).not.toContain('routes/scheduler')
      expect(spec).not.toContain('settings/schedules-section')
      expect(spec).not.toContain('routes/settings')
    }
  })

  test('no scheduler route is hard-coded anywhere in the component', () => {
    // The ONE link goes through the helper. A `to="/scheduler"` here is exactly
    // what B1 turned into a redirect, and a `to="/settings#schedules"` here is
    // a second place to fix if the fold is ever reverted.
    expect(CODE).not.toContain('/scheduler"')
    expect(CODE).not.toContain("/scheduler'")
    expect(CODE).not.toContain('/settings#schedules')
    expect(CODE).toContain('scheduleAdminHref()')
  })

  test('and the helper is the only file that names one', () => {
    expect(HREF).toContain('/scheduler')
    expect(HREF).toContain('/settings')
    expect(scheduleAdminHref()).toBe('/settings#schedules')
  })
})

describe('what the sheet promises to show', () => {
  test('every column the plan asks for is rendered from the shipped helpers', () => {
    // T8.1's inventory: title, human cadence, next fire, last fire, toggle. A
    // column that stops being rendered is the way this capability would be
    // quietly lost, and the type checker would never notice.
    expect(CODE).toContain('schedule.title')
    expect(CODE).toContain('describeSchedule(schedule.schedule_expr)')
    expect(CODE).toContain('formatRunTime(schedule.next_run)')
    expect(CODE).toContain('formatRunTime(schedule.last_run)')
    expect(CODE).toContain('<EnableToggle')
    // A paused schedule says "paused" rather than showing a next fire it will
    // not honour, and "never run" rather than an empty cell.
    expect(CODE).toContain("'paused'")
    expect(CODE).toContain("'never run'")
  })

  test('the list is filtered to THIS session, and excludes deleted rows', () => {
    expect(CODE).toContain('s.session === session && !s.deleted')
  })

  test('create mode is prefilled with the session and the handed-over draft', () => {
    // T8.1 + T9.1: opening "new" from a session that already knows who it is
    // must not ask the user to pick that session again, and the composer
    // affordance hands its draft over as the prompt.
    expect(CODE).toContain('prefill={detailMode === \'create\' ? { session, prompt: draftPrompt ?? \'\' } : undefined}')
  })

  test('the detail is the SHIPPED sheet, not a second implementation', () => {
    // Test-run and the fire log (T8.2) live in `ScheduleDetailSheet`'s edit
    // body. Re-implementing either here is how two versions of "run it now"
    // start to disagree.
    expect(imports).toContain('@/components/scheduler/schedule-detail-sheet')
    expect(CODE).toContain('<ScheduleDetailSheet')
    for (const forbidden of ['useRunSchedule', 'useDeleteSchedule', 'FireLog', 'ScheduleEditor']) {
      expect(CODE).not.toContain(forbidden)
    }
  })
})

describe('the chip’s destination', () => {
  test('the panel opens the sheet with the id when the ledger row has one', () => {
    const panel = readFileSync(
      new URL('../../src/components/chat/chat-panel.tsx', import.meta.url),
      'utf8',
    )
    expect(panel).toContain('onOpenSchedule={openSchedule}')
    // Both halves of the degradation: an id when the row carries one, `null`
    // (→ the list) when it does not.
    expect(panel).toContain('scheduleId: ref.id ?? null')
    expect(panel).toContain('<SessionSchedulesSheet')
  })

  test('the session-info panel’s rows open the sheet instead of leaving for a route', () => {
    const info = readFileSync(
      new URL('../../src/components/focus-mode/session-info-panel.tsx', import.meta.url),
      'utf8',
    )
    const code = info.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain('<SessionSchedulesSheet')
    // The two hard-coded `/scheduler` links B1 would otherwise have left
    // pointing at a redirect are gone.
    expect(code).not.toContain('to="/scheduler"')
  })
})

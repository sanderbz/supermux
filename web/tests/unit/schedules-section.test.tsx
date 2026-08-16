/**
 * The scheduler fold's ANTI-DROP TEST (fase B1 T8.5).
 * ─────────────────────────────────────────────────────────────────────────────
 * Folding a 5-column `max-w-5xl` table into a 42rem settings column is exactly
 * where a capability gets "simplified away" — a column that no longer fits is
 * the easiest thing in the world to quietly not render. So the plan's inventory
 * table is an ACCEPTANCE LIST, and this suite is its executable half: every
 * text column of the old `ScheduleList` must still be present in the settings
 * row.
 *
 *   old column   | asserted here
 *   -------------|--------------------------------------------------------
 *   Title        | the row's label
 *   Schedule     | the human recurrence string
 *   Next fire    | next-run, or "paused" when the schedule is disabled
 *   Last fired   | last-run, or "never"
 *   On           | the EnableToggle, in the Row control slot
 *   (target)     | the tmux/boot/shell target line, which the old row also had
 *
 * The other half is `tests/e2e/smoke/scheduler-fold.spec.ts`, which drives
 * create → toggle → test-fire → fire log → delete against a real backend. The
 * capabilities that live INSIDE the detail sheet are covered there, because the
 * sheet is imported unchanged and re-testing it here would only test that an
 * import statement works.
 *
 * `scheduleHintParts` is asserted rather than re-derived: the test calls the
 * SAME function the component renders from, so a change to either shows up.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  SCHEDULES_ANCHOR,
  scheduleHintParts,
} from '../../src/components/settings/schedules-section.helpers'
import { Row } from '../../src/components/settings/primitives'
import type { ScheduleRow } from '../../src/lib/api'
import type { SessionPickerOption } from '../../src/components/session/session-picker'

const SESSIONS: SessionPickerOption[] = [
  { name: 'atlas', display_name: 'Atlas' } as SessionPickerOption,
]

/** Three rows covering the branches that decide what a column SAYS: an enabled
 *  tmux job that has fired, a paused one, and a boot job that never fired. */
const FIXTURE: ScheduleRow[] = [
  {
    id: 'sch-1',
    title: 'Nightly digest',
    kind: 'tmux',
    session: 'atlas',
    command: 'summarise today',
    schedule_expr: '0 9 * * *',
    enabled: 1,
    next_run: Math.floor(Date.now() / 1000) + 3600,
    last_run: Math.floor(Date.now() / 1000) - 3600,
    boot_dir: null,
  } as unknown as ScheduleRow,
  {
    id: 'sch-2',
    title: 'Paused sweep',
    kind: 'shell',
    session: null,
    command: 'git gc',
    schedule_expr: '0 3 * * 0',
    enabled: 0,
    next_run: Math.floor(Date.now() / 1000) + 60,
    last_run: null,
    boot_dir: null,
  } as unknown as ScheduleRow,
  {
    id: 'sch-3',
    title: 'Boot the reviewer',
    kind: 'boot',
    session: null,
    command: 'claude',
    schedule_expr: '*/30 * * * *',
    enabled: 1,
    next_run: null,
    last_run: null,
    boot_dir: '/opt/projects/supermux',
  } as unknown as ScheduleRow,
]

describe('every column of the old table survives the fold', () => {
  test('title, human schedule, next, last and target are all derivable', () => {
    for (const s of FIXTURE) {
      const parts = scheduleHintParts(s, SESSIONS)
      expect(parts.human, `human schedule for ${s.id}`).toBeTruthy()
      expect(parts.target, `target for ${s.id}`).toBeTruthy()
      expect(parts.next, `next fire for ${s.id}`).toBeTruthy()
      expect(parts.last, `last fired for ${s.id}`).toBeTruthy()
    }
  })

  test('a PAUSED schedule says "paused" rather than showing a stale next fire', () => {
    // The old table did this too — a disabled job with a next_run in the row
    // data would otherwise claim it is about to run.
    const paused = scheduleHintParts(FIXTURE[1], SESSIONS)
    expect(paused.next).toBe('paused')
  })

  test('a schedule that never fired says "never", not an empty cell', () => {
    expect(scheduleHintParts(FIXTURE[1], SESSIONS).last).toBe('never')
    expect(scheduleHintParts(FIXTURE[2], SESSIONS).last).toBe('never')
  })

  test('the tmux target resolves the session DISPLAY name, not the slug', () => {
    const tmux = scheduleHintParts(FIXTURE[0], SESSIONS)
    expect(tmux.target).toContain('Atlas')
    expect(tmux.target).toContain('summarise today')
  })

  test('the boot target names the directory it boots in', () => {
    const boot = scheduleHintParts(FIXTURE[2], SESSIONS)
    expect(boot.target).toContain('claude')
    expect(boot.target).toContain('/opt/projects/supermux')
  })

  test('a shell target is the bare command', () => {
    expect(scheduleHintParts(FIXTURE[1], SESSIONS).target).toBe('git gc')
  })
})

describe('the section wires every slot', () => {
  const SECTION_SRC = readFileSync(
    fileURLToPath(
      new URL('../../src/components/settings/schedules-section.tsx', import.meta.url),
    ),
    'utf8',
  )

  test('the section anchor is the one the /scheduler redirect targets', () => {
    // `/scheduler` → `/settings#schedules`, and settings.tsx's hash-anchor
    // effect looks up `#${hash}` inside its scroller. If this drifts, the
    // redirect silently lands at the top of a very long page.
    expect(SCHEDULES_ANCHOR).toBe('schedules')
    expect(SECTION_SRC).toContain('id={SCHEDULES_ANCHOR}')
  })

  test('the row is wired with title, schedule, next, last, target and the toggle', () => {
    // `ScheduleSettingsRow` is module-private on purpose (the section is the
    // public surface), so the anti-drop check reads the section source. Crude,
    // but it is the assertion that actually matters: a column silently not
    // rendered is exactly the failure mode this task guards against.
    for (const slot of [
      '{schedule.title}',
      '{human}',
      '{next}',
      '{last}',
      '{target}',
      '<EnableToggle',
    ]) {
      expect(SECTION_SRC, `row slot ${slot}`).toContain(slot)
    }
  })

  test('create and edit still go through the SAME detail sheet, imported unchanged', () => {
    expect(SECTION_SRC).toContain(
      "import { ScheduleDetailSheet } from '@/components/scheduler/schedule-detail-sheet'",
    )
    expect(SECTION_SRC).toContain('<ScheduleDetailSheet')
    expect(SECTION_SRC).toContain('mode={mode}')
  })

  test('live SSE updates moved with the section (never polled)', () => {
    expect(SECTION_SRC).toContain('useSchedulerStream()')
  })

  test('the empty state keeps the brand copy rather than an ad-hoc string', () => {
    expect(SECTION_SRC).toContain('EMPTY.scheduler.body')
    expect(SECTION_SRC).toContain('EMPTY.scheduler.cta')
  })

  test('loading and error+retry both survive as settings rows', () => {
    expect(SECTION_SRC).toContain('schedules.isLoading')
    expect(SECTION_SRC).toContain('schedules.isError')
    expect(SECTION_SRC).toContain('schedules.refetch()')
  })

  test('a settings Row renders every slot it is given', () => {
    // Guards the assumption the row markup rests on: Row's label / hint /
    // control slots all reach the DOM.
    const html = renderToStaticMarkup(
      <Row label="Nightly digest" hint="every day at 09:00" control={<i>toggle</i>} />,
    )
    expect(html).toContain('Nightly digest')
    expect(html).toContain('every day at 09:00')
    expect(html).toContain('<i>toggle</i>')
  })
})

// Pure helpers for the Settings → Schedules section (fase B1 T8).
//
// Split out of `schedules-section.tsx` for two reasons: the section file then
// exports components only (react-refresh keeps working), and the anti-drop unit
// test can import the SAME function the UI renders from without pulling React,
// TanStack Query and an SSE hook into a unit test.

import type { ScheduleRow } from '@/lib/api'
import { displayLabel } from '@/lib/api/sessions'
import type { SessionPickerOption } from '@/components/session/session-picker'
import { describeSchedule, formatRunTime } from '@/components/scheduler/helpers'

/** The section's stable anchor. `settings.tsx`'s hash-anchor effect scrolls to
 *  it, so `/scheduler` → `/settings#schedules` lands on the section rather than
 *  at the top of a long page. */
export const SCHEDULES_ANCHOR = 'schedules'


/** What the old table's four text columns say, as one hint line.
 *  Exported so the anti-drop unit test asserts the SAME function the UI uses
 *  rather than a re-implementation of it. */
export function scheduleHintParts(
  s: ScheduleRow,
  sessions: SessionPickerOption[],
): { human: string; target: string; next: string; last: string } {
  const sessionLabel =
    displayLabel({
      name: s.session,
      display_name: sessions.find((x) => x.name === s.session)?.display_name,
    }) || '—'
  const target =
    s.kind === 'tmux'
      ? `${sessionLabel} · ${s.command}`
      : s.kind === 'boot'
        ? `${s.command} in ${s.boot_dir || '—'}`
        : s.command
  return {
    human: describeSchedule(s.schedule_expr),
    target,
    // A paused schedule has no next fire — say so rather than showing a stale
    // timestamp (the old table did the same).
    next: s.enabled === 1 ? formatRunTime(s.next_run) : 'paused',
    last: s.last_run ? formatRunTime(s.last_run) : 'never',
  }
}


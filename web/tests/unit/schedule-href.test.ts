/**
 * Fase B4 T8.4 — the one function in the tree allowed to know a scheduler route.
 * ─────────────────────────────────────────────────────────────────────────────
 * B4 was written while B1's scheduler fold was in flight, so every B4 surface
 * depends only on `components/scheduler/*` and on nothing route-shaped — with
 * one unavoidable exception, the "manage all schedules" link at the foot of the
 * per-session sheet. Both worlds are tested here so the branch that is not
 * currently taken cannot rot.
 */
import { describe, expect, test } from 'bun:test'

import {
  SETTINGS_HAS_SCHEDULES,
  SETTINGS_SCHEDULES_HASH,
  scheduleAdminHref,
} from '../../src/components/session-schedules/schedule-href'

describe('scheduleAdminHref', () => {
  test('goes to the Settings section when the fold has landed', () => {
    expect(scheduleAdminHref(true)).toBe(`/settings${SETTINGS_SCHEDULES_HASH}`)
  })

  test('goes to the standalone route when it has not', () => {
    // Kept live so a revert of B1 is a one-constant change rather than a hunt.
    expect(scheduleAdminHref(false)).toBe('/scheduler')
  })

  test('defaults to what the built app actually has', () => {
    expect(scheduleAdminHref()).toBe(scheduleAdminHref(SETTINGS_HAS_SCHEDULES))
    // B1 landed as #69, so this is the world we are in.
    expect(SETTINGS_HAS_SCHEDULES).toBe(true)
    expect(scheduleAdminHref()).toBe('/settings#schedules')
  })

  test('the anchor matches the section the app actually renders', () => {
    // `SCHEDULES_ANCHOR` in `components/settings/schedules-section.tsx` is what
    // `<SectionWithAction id=…>` stamps on the DOM; a link to a different hash
    // scrolls nowhere and the failure is silent.
    expect(SETTINGS_SCHEDULES_HASH.startsWith('#')).toBe(true)
    expect(SETTINGS_SCHEDULES_HASH.slice(1)).toBe('schedules')
  })
})

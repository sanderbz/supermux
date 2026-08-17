/**
 * The copy does not name a runtime the user is not running.
 *
 * supermux shipped a tmux-less NATIVE runtime as the default in v0.5.0, and
 * every session on a current install reports `runtime: 'native'`. Four
 * user-facing strings kept describing tmux anyway — the new-session sheet
 * ("Boot an agent in tmux"), the stopped-session card ("Its tmux session is no
 * longer running"), the missing-session error and two confirm dialogs. A user
 * who has never run tmux was being told, at the two moments they most need to
 * trust the app, that their session lives somewhere it does not.
 *
 * The fix is runtime-NEUTRAL wording rather than a branch on `runtime`: two
 * strings to keep true, for a distinction that changes nothing about what to do
 * next.
 *
 * The team copy is deliberately exempt: teammates really are split panes in a
 * tmux window (`TeamMember.tmux_pane_id`), so naming it there is accurate.
 */
import { describe, expect, test } from 'bun:test'

import { CONFIRM, EMPTY, ERROR, MISC } from '../../src/brand/copy'

/** Every user-facing string in a copy record, flattened. */
const strings = (rec: Record<string, Record<string, unknown>>): [string, string][] =>
  Object.entries(rec).flatMap(([key, entry]) =>
    Object.values(entry)
      .filter((v): v is string => typeof v === 'string')
      .map((v) => [key, v] as [string, string]),
  )

describe('no shipped copy promises tmux', () => {
  const exempt = new Set(['killTeamLead'])

  for (const [name, record] of [
    ['EMPTY', EMPTY],
    ['ERROR', ERROR],
    ['CONFIRM', CONFIRM],
  ] as const) {
    test(`${name} is runtime-neutral`, () => {
      const offenders = strings(record as Record<string, Record<string, unknown>>)
        .filter(([key]) => !exempt.has(key))
        .filter(([, text]) => /tmux/i.test(text))
      expect(offenders).toEqual([])
    })
  }

  test('the strings the audit named say what is true instead', () => {
    expect(EMPTY.stoppedSession.body).toContain('Its process is no longer running')
    expect(ERROR.sessionMissing.title).toBe('Session is gone')
    // The new-session sheet's subtitle was inline in the component, i.e. outside
    // every voice rule this file exists to hold. Moving it in is what makes it
    // guardable at all.
    expect(MISC.newSessionSubtitle).not.toMatch(/tmux/i)
  })
})

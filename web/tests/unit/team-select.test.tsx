/**
 * A team is SELECTED, never navigated to (desktop §2b): tapping a team row must
 * fire the roster's `onOpen` (which sets the `{kind:'team'}` selection and swaps
 * the pane in place) and change no URL.
 *
 * There is no DOM/event harness in this repo, so the contract is pinned two
 * ways that together are conclusive:
 *   1. TeamRow (bare) IS a `<button type="button">`, not an `<a href>` — a click
 *      can only run its handler; a button structurally cannot navigate.
 *   2. that handler is `() => onOpen(team)` — calling it opens THIS team and
 *      nothing else. (TeamRow imports no router and calls no navigate, so there
 *      is nothing else it could do.)
 */
import { describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'

import { TeamRow } from '../../src/components/roster/grok-roster'
import type { Team } from '../../src/lib/api/teams'

function team(name: string): Team {
  return {
    team_name: name,
    lead_session: 'l',
    lead_supermux_session: 'sm',
    members: [
      { name: 'r', agent_id: `r@${name}`, model: '', color: '', tmux_pane_id: '%1', is_active: true, status: 'idle' },
    ],
    tasks: [],
  }
}

describe('opening a team selects it, and does not navigate', () => {
  test('the bare row is a button, not a link', () => {
    const el = TeamRow({ team: team('alpha'), onOpen: () => {}, index: 0 }) as ReactElement
    expect(el.type).toBe('button')
    expect(el.props.type).toBe('button')
    expect('href' in el.props).toBe(false)
  })

  test('clicking fires onOpen with THIS team (selection), nothing else', () => {
    const opened: Team[] = []
    const alpha = team('alpha')
    const el = TeamRow({ team: alpha, onOpen: (t) => opened.push(t), index: 0 }) as ReactElement
    // The button's own onClick is the selection handler.
    el.props.onClick()
    expect(opened).toEqual([alpha])
  })

  test('a neighbour team’s row opens its OWN team', () => {
    const opened: string[] = []
    const bravo = team('bravo')
    const el = TeamRow({ team: bravo, onOpen: (t) => opened.push(t.team_name), index: 1 }) as ReactElement
    el.props.onClick()
    expect(opened).toEqual(['bravo'])
  })
})

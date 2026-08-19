/**
 * `<TeamRow>` — the D1 micro-defects (Phase 6b), pinned on rendered markup:
 *   · "1 bot" / "N bots" pluralizes in BOTH the L3 glance and the aria-label.
 *   · a crew bigger than the three-mark pile gets a "+N" fourth slot.
 *   · a rosterless team renders NOTHING (return null) — belt-and-braces with the
 *     server's own drop, and the reason it is also kept out of the counts.
 *   · a member that needs you wears the red halo (`data-attention="needs"`) in
 *     the pile, so the row reads as needs-you at a glance.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { TeamRow } from '../../src/components/roster/grok-roster'
import type { MemberStatus, Team, TeamMember } from '../../src/lib/api/teams'

let seq = 0
function member(status: MemberStatus = 'idle'): TeamMember {
  const name = `m${seq++}`
  return { name, agent_id: `${name}@t`, model: '', color: '', tmux_pane_id: '%1', is_active: true, status }
}
function team(members: TeamMember[]): Team {
  return { team_name: 'crew-x', lead_session: 'l', lead_supermux_session: 'sm', members, tasks: [] }
}
const html = (t: Team): string =>
  renderToStaticMarkup(<TeamRow team={t} onOpen={() => {}} index={0} />)

describe('pluralization (row + aria-label)', () => {
  test('one member reads "1 bot", never "1 bots"', () => {
    const out = html(team([member()]))
    expect(out).toContain('1 bot')
    expect(out).not.toContain('1 bots')
    expect(out).toContain('crew-x — 1 bot')
  })

  test('several members read "N bots"', () => {
    const out = html(team([member(), member()]))
    expect(out).toContain('2 bots')
    expect(out).toContain('crew-x — 2 bots')
  })
})

describe('the "+N" overflow pile slot', () => {
  test('a crew of 5 shows "+2" beyond the three-mark pile', () => {
    const out = html(team([member(), member(), member(), member(), member()]))
    expect(out).toContain('gr-pile-more')
    expect(out).toContain('+2')
  })

  test('a crew of exactly 3 has no overflow slot', () => {
    const out = html(team([member(), member(), member()]))
    expect(out).not.toContain('gr-pile-more')
  })
})

describe('a rosterless row is never rendered', () => {
  test('0 members ⇒ empty markup (null)', () => {
    expect(html(team([]))).toBe('')
  })
})

describe('needs-you halo', () => {
  test('a needs_you member paints the red halo in the pile', () => {
    const out = html(team([member('needs_you'), member('idle')]))
    expect(out).toContain('data-attention="needs"')
  })

  test('a calm crew paints no halo', () => {
    const out = html(team([member('idle'), member('working')]))
    expect(out).not.toContain('data-attention="needs"')
  })
})

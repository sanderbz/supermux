/**
 * The folded roster's ONE invariant (R7/R8): the header can never disagree with
 * the sections. `needCount` is the sum over the RENDERED rows — session-needs
 * plus team-needs — and every section's shown count is `sessions + teams` in that
 * tier. This pins that property with and without crews, purely (no DOM), by
 * composing the SAME two functions the roster composes: `groupSessions`
 * (bots → tiers) and `groupTeamsByTier` (crews → tiers).
 */
import { describe, expect, test } from 'bun:test'

import {
  groupSessions,
  groupTeamsByTier,
  rosteredTeams,
  totalBotCount,
  type GroupKey,
  type LeadSignal,
} from '../../src/lib/team-attention'
import type { ApiSession } from '../../src/lib/api'
import type { MemberStatus, Team, TeamMember } from '../../src/lib/api/teams'

const NOW = 1_800_000_000_000
const KEYS: GroupKey[] = ['needs', 'active', 'done', 'idle']

function session(name: string, status: ApiSession['status']): ApiSession {
  return { name, status, dir: '', provider: 'claude', preview_lines: [], updated_at: new Date(NOW).toISOString() } as ApiSession
}

let seq = 0
function member(status: MemberStatus): TeamMember {
  const name = `m${seq++}`
  return { name, agent_id: `${name}@t`, model: '', color: '', tmux_pane_id: '%1', is_active: true, status }
}
function team(team_name: string, members: TeamMember[]): Team {
  return { team_name, lead_session: 'l', lead_supermux_session: `sm-${team_name}`, members, tasks: [] }
}

describe('header count == Σ section counts', () => {
  test('WITH crews: a needs-you team lands in needs and is counted exactly once', () => {
    const sessions = [
      session('a', 'waiting'), // needs (in needNames)
      session('b', 'active'), // active
      session('c', 'idle'), // done (idle + same day)
      session('d', 'stopped'), // idle bucket
    ]
    const needNames = new Set(['a'])
    const groups = groupSessions(sessions, needNames, NOW)

    const teams = [
      team('needy', [member('needs_you'), member('working')]), // needs
      team('busy', [member('working')]), // active
      team('crewless', []), // rendered nowhere, counted nowhere
    ]
    const teamGroups = groupTeamsByTier(teams, (): LeadSignal | null => null)

    // The header's need count.
    const needCount = groups.needs.length + teamGroups.needs.length
    expect(needCount).toBe(2) // session 'a' + team 'needy'

    // Every section's shown count is bots + crews in that tier; their sum is the
    // whole rendered roster, and it equals sessions + rostered teams — no row
    // counted twice, none uncounted.
    const shown = KEYS.reduce((n, k) => n + groups[k].length + teamGroups[k].length, 0)
    expect(shown).toBe(sessions.length + rosteredTeams(teams).length)
    expect(shown).toBe(4 + 2)

    // …and the header's need count is exactly the size of the rendered needs
    // section — the property the old two-ordering split violated.
    expect(needCount).toBe(groups.needs.length + teamGroups.needs.length)
  })

  test('WITHOUT crews: the team terms vanish and the header is the sessions alone', () => {
    const sessions = [session('a', 'waiting'), session('b', 'active')]
    const needNames = new Set(['a'])
    const groups = groupSessions(sessions, needNames, NOW)
    const teamGroups = groupTeamsByTier([], (): LeadSignal | null => null)

    const needCount = groups.needs.length + teamGroups.needs.length
    expect(needCount).toBe(1)
    const shown = KEYS.reduce((n, k) => n + groups[k].length + teamGroups[k].length, 0)
    expect(shown).toBe(2)
    expect(totalBotCount(sessions.length, [])).toBe(2)
  })

  test('crews suffix counts only rostered teams', () => {
    const teams = [team('a', [member('idle')]), team('solo', [])]
    expect(rosteredTeams(teams).length).toBe(1)
  })
})

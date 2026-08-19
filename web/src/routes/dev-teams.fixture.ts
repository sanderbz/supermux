// Shared team fixtures for the dev benches — the ONE mock team roster both
// /dev/teams (the TeamCard verification page) and /dev/roster (the grok TeamRow
// bench) render, so the two surfaces are reviewed against identical data. A
// plain data module (no component export) so importing it into either route
// never trips react-refresh's only-export-components rule.
//
// Coverage baked in: a full 5-teammate team with every MemberStatus
// (needs_you / working / idle / offline), a null pane, and a 7-row task ledger;
// a 0-teammate solo team; and an unmapped lead (no supermux session this tick).
import type { ApiSession } from '@/lib/api'
import type { Team } from '@/lib/api/teams'

export const MOCK_TEAMS: Team[] = [
  {
    team_name: 'feature-x',
    lead_session: 'sess-lead-abc',
    lead_supermux_session: 'supermux-feature-x',
    members: [
      {
        name: 'researcher',
        agent_id: 'researcher@feature-x',
        model: 'claude-opus-4',
        color: '#5b9dff',
        tmux_pane_id: '%11',
        is_active: true,
        status: 'needs_you',
      },
      {
        name: 'builder',
        agent_id: 'builder@feature-x',
        model: 'claude-sonnet-4',
        color: '#3fc66b',
        tmux_pane_id: '%12',
        is_active: true,
        status: 'working',
      },
      {
        name: 'reviewer',
        agent_id: 'reviewer@feature-x',
        model: 'claude-sonnet-4',
        color: '#c678dd',
        tmux_pane_id: '%13',
        is_active: true,
        status: 'idle',
      },
      {
        name: 'tester',
        agent_id: 'tester@feature-x',
        model: 'claude-haiku-4',
        color: '#e0c050',
        tmux_pane_id: null,
        is_active: false,
        status: 'offline',
      },
      {
        name: 'docs-writer',
        agent_id: 'docs-writer@feature-x',
        model: 'claude-sonnet-4',
        color: '#56c8d8',
        tmux_pane_id: '%15',
        is_active: true,
        status: 'working',
      },
    ],
    tasks: [
      { id: '1', subject: 'Research approach', description: '', status: 'completed', assigned_to: 'researcher', blocks: [], blocked_by: [] },
      { id: '2', subject: 'Build core', description: '', status: 'in_progress', assigned_to: 'builder', blocks: [], blocked_by: [] },
      { id: '3', subject: 'Write tests', description: '', status: 'pending', assigned_to: 'tester', blocks: [], blocked_by: [] },
      { id: '4', subject: 'Review PR', description: '', status: 'pending', assigned_to: 'reviewer', blocks: [], blocked_by: [] },
      { id: '5', subject: 'Docs', description: '', status: 'in_progress', assigned_to: 'docs-writer', blocks: [], blocked_by: [] },
      { id: '6', subject: 'Polish', description: '', status: 'pending', assigned_to: '', blocks: [], blocked_by: [] },
      { id: '7', subject: 'Ship', description: '', status: 'pending', assigned_to: '', blocks: [], blocked_by: [] },
    ],
  },
  {
    team_name: 'solo',
    lead_session: 'sess-lead-def',
    lead_supermux_session: 'supermux-solo-lead',
    members: [],
    tasks: [],
  },
  {
    team_name: 'unmapped-lead',
    lead_session: 'sess-lead-ghi',
    lead_supermux_session: null,
    members: [
      {
        name: 'helper',
        agent_id: 'helper@unmapped-lead',
        model: 'claude-sonnet-4',
        color: '#ff8a80',
        tmux_pane_id: '%21',
        is_active: true,
        status: 'idle',
      },
    ],
    tasks: [{ id: '1', subject: 'Do thing', description: '', status: 'completed', assigned_to: 'helper', blocks: [], blocked_by: [] }],
  },
]

/// The supermux session rows the two mapped fixtures' leads point at
/// (`lead_supermux_session`). Lives here rather than in `/dev/teams` because
/// the `/?mock` seed (`routes/overview.tsx useDevMockSeed`) needs the same
/// rows: a team row whose lead has no session is the "unmapped lead" case, and
/// seeding teams WITHOUT their leads would make every mock team look unmapped.
export const MOCK_LEAD_SESSIONS: ApiSession[] = [
  {
    name: 'supermux-feature-x',
    status: 'active',
    dir: '/work/feature-x',
    provider: 'claude',
    preview_lines: ['$ claude', 'Coordinating 4 teammates…', '✎ planning the split'],
    updated_at: new Date().toISOString(),
    task_summary: 'feature-x team lead',
  } as ApiSession,
  {
    name: 'supermux-solo-lead',
    status: 'idle',
    dir: '/work/solo',
    provider: 'claude',
    preview_lines: ['$ claude', 'Idle — waiting for next prompt'],
    updated_at: new Date().toISOString(),
    task_summary: 'solo team (no teammates yet)',
  } as ApiSession,
]

/// The full 5-teammate team, re-pointed at `lead` — for the FOCUS benches,
/// which map a team onto one of the mock TILES (their lead names are the tile
/// names, not the fixture's own). One team, so the strip stays reviewable.
export function mockTeamsForLead(lead: string): Team[] {
  return [{ ...MOCK_TEAMS[0], lead_supermux_session: lead }]
}

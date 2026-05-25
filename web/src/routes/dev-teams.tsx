// /dev/teams — DEV-only verification page for the Agent Teams overview surface
// (AT-F-FRONT). Lazy-loaded + DEV-guarded so neither this route nor its mock data
// ships in production (mirrors /dev/tiles). Seeds the shared ['teams'] + ['sessions']
// caches with mocks so the TEAM CARD, roll-up, chips, density toggle, peek, and
// full-screen focus can be eyeballed across states (needs_you / working / idle /
// offline, null pane, 0 teammates, 5 teammates) without a live backend.
//
// NOTE: the live teammate terminal WS won't connect here (no backend pane), so the
// peek/focus terminal will show its connecting/stopped state — that exercises the
// read-only WS lifecycle UI exactly as a gone pane would.

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { TeamCard } from '@/components/team'
import type { Team } from '@/lib/api/teams'
import type { ApiSession } from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { TEAMS_KEY } from '@/hooks/use-teams'

const MOCK_LEAD_SESSIONS: ApiSession[] = [
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

const MOCK_TEAMS: Team[] = [
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

export default function DevTeams() {
  const qc = useQueryClient()
  React.useEffect(() => {
    qc.setQueryData(SESSIONS_KEY, MOCK_LEAD_SESSIONS)
    qc.setQueryData(TEAMS_KEY, MOCK_TEAMS)
  }, [qc])

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-3 px-3 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">Teams (dev)</h1>
      <p className="text-sm text-muted-foreground">
        TEAM CARD verification — needs_you / working / idle / offline, null pane, 0
        teammates, 5 teammates, unmapped lead. Toggle Chips↔Cards per team.
      </p>
      {MOCK_TEAMS.map((t) => (
        <TeamCard key={t.team_name} team={t} sizeTier={1} />
      ))}
    </div>
  )
}

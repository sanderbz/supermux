// /dev/teams — DEV-only verification page for the Agent Teams overview surface.
// Lazy-loaded + DEV-guarded so neither this route nor its mock data
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
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { TEAMS_KEY } from '@/hooks/use-teams'

import { MOCK_LEAD_SESSIONS, MOCK_TEAMS } from './dev-teams.fixture'


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

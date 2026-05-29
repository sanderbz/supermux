// /dev/focus/:name — verification page (DEV-only; lazy-loaded so neither
// this route nor the mock data ships in production, matching /dev/tiles).
//
// Renders the REAL desktop focus mode (DesktopFocus → DesktopSplit) with the 12
// mocked sessions so the visual critic can review the two-column split, the
// 320px session-strip with the current-row spring highlight, the compact-tile
// peek-popover (hover a non-current row ≥300ms), the 44px FocusHeader, and the
// DesktopDock — all at the 375/390/1024/1440 breakpoints — WITHOUT a live
// backend. The LiveTerminal shows its "Connecting…" pill (expected without a
// server); against a running supermux-server with a session named in the route it
// streams live, and the keyboard-capture echo can be filmed.
//
// Also seeds a mock Agent Team so the team-aware strip grouping (team
// header + lead row + teammate rows, needs_you / working / idle / offline states)
// is reviewable offline. The mock team's lead maps to one of the mock sessions so
// it renders as a grouped lead; clicking a teammate row shows the read-only
// teammate main-pane view (its WS won't connect without a backend → calm state).
//
// Usage: /dev/focus/web-app

import { useParams } from 'react-router-dom'

import { DesktopFocus } from '@/routes/focus/desktop'
import { MOCK_TILES } from '@/components/session-tile/mock'
import type { Team } from '@/lib/api/teams'

// A mock team whose lead maps to the FIRST mock tile so the strip shows a real
// grouped lead + teammates across all four states.
const MOCK_FOCUS_TEAMS: Team[] = [
  {
    team_name: 'feature-x',
    lead_session: 'sess-lead-abc',
    lead_supermux_session: MOCK_TILES[0]?.name ?? '',
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
    ],
    tasks: [
      { id: '1', subject: 'Research', description: '', status: 'completed', assigned_to: 'researcher', blocks: [], blocked_by: [] },
      { id: '2', subject: 'Build', description: '', status: 'in_progress', assigned_to: 'builder', blocks: [], blocked_by: [] },
      { id: '3', subject: 'Test', description: '', status: 'pending', assigned_to: 'tester', blocks: [], blocked_by: [] },
    ],
  },
]

export default function DevFocus() {
  const { name } = useParams()
  // Default to the first mock so a bare /dev/focus is still meaningful.
  void name
  return (
    <div className="h-full w-full">
      <DesktopFocus mockSessions={MOCK_TILES} mockTeams={MOCK_FOCUS_TEAMS} />
    </div>
  )
}

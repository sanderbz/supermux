// teammate-pane.tsx — AT-H2.
//
// The desktop focus MAIN-PANE view for a selected teammate. When a teammate row
// in the team-aware strip is clicked, the right pane swaps from the focused
// session's editable terminal to THIS: a read-only live terminal of the
// teammate's tmux pane (AT-E `/ws/teams/{team}/{member}`), with a header that
// clearly reads as READ-ONLY (the teammate WS ignores client input — steering is
// a later slice).
//
// REUSE: the terminal itself is the existing <TeammateTerminal> (LiveTerminal with
// the read-only WS override). This component only adds the desktop-split header
// chrome (44px, matching DesktopFocusHeader geometry) + the read-only affordance
// + the calm "no live pane" placeholder for an offline / null-%id teammate.

import { Eye } from 'lucide-react'

import { MemberStatusDot, MEMBER_STATUS_LABEL } from '@/components/team'
import { TeammateTerminal } from '@/components/terminal/teammate-terminal'
import type { Team, TeamMember } from '@/lib/api/teams'

export interface TeammatePaneProps {
  team: Team
  member: TeamMember
}

export function TeammatePane({ team, member }: TeammatePaneProps) {
  // Only gate on pane absence. Claude flips teammates to isActive:false
  // (→ status=offline) the moment their turn ends, but the tmux pane keeps
  // streaming — show whatever's in the pane while it's alive.
  const gone = !member.tmux_pane_id
  const rail = member.color || 'hsl(var(--status-idle))'

  return (
    <>
      {/* Header — mirrors DesktopFocusHeader geometry (glass, h-11) but carries
          the teammate identity + the read-only affordance instead of Detach/Stop
          (a read-only teammate has nothing to detach or stop). */}
      <header className="glass flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-3">
        <span
          aria-hidden
          className="h-5 w-[2px] shrink-0 rounded-full"
          style={{ backgroundColor: rail }}
        />
        <MemberStatusDot status={member.status} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm font-semibold tracking-tight">
            {member.name}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {team.team_name} · {MEMBER_STATUS_LABEL[member.status]}
          </span>
        </span>

        {/* Read-only affordance — a calm pill, not an alarm. Makes it unmistakable
            the main pane can't be typed into for a teammate (steering is later). */}
        <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
          <Eye className="size-3.5" aria-hidden />
          Read-only
        </span>
      </header>

      <div className="relative min-h-0 flex-1" style={{ backgroundColor: 'var(--terminal-bg)' }}>
        {gone ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No live pane for this teammate right now. It may come back shortly.
          </div>
        ) : (
          <TeammateTerminal
            // Remount when the pane id OR member changes so a fresh WS connects.
            key={`${team.team_name}/${member.name}/${member.tmux_pane_id}`}
            team={team.team_name}
            member={member.name}
            paneId={member.tmux_pane_id}
          />
        )}
      </div>
    </>
  )
}

export default TeammatePane

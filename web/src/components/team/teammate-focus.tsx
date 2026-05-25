// TeammateFocus — full-screen READ-ONLY focus for an Agent Teams teammate
// (AT-F-FRONT / F2 / step 6). Tapping a chip opens the teammate's terminal
// full-screen here. Reuses the existing terminal chrome language (glass header,
// chevron-back, status, full-bleed <TeammateTerminal>, safe-area insets) without
// going through the `/api/sessions`-bound focus route — teammates are NOT
// sessions, so a self-contained full-screen overlay is the robust seam (and
// AT-F3 mission control can later host the same <TeammateTerminal> inside its own
// split). Read-only for this slice: no send/steer dock yet.
//
// Rendered as a fixed overlay over the overview (no router route needed) so the
// overview state is preserved underneath; closing returns instantly.

import * as React from 'react'
import { motion } from 'framer-motion'
import { ChevronLeft, Maximize2 } from 'lucide-react'

import { springs } from '@/lib/springs'
import { MemberStatusDot, MEMBER_STATUS_LABEL } from './member-status-dot'
import { TeammateTerminal } from '@/components/terminal/teammate-terminal'
import type { Team, TeamMember } from '@/lib/api/teams'

export interface TeammateFocusProps {
  team: Team
  member: TeamMember
  /** Switch the focused teammate without leaving full-screen (the thin member
   *  strip under the header). Optional — when omitted only this teammate shows. */
  onSelectMember?: (memberName: string) => void
  onClose: () => void
}

export function TeammateFocus({
  team,
  member,
  onSelectMember,
  onClose,
}: TeammateFocusProps) {
  // Esc closes (desktop). Mounted once per focus session.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const gone = member.status === 'offline' || !member.tmux_pane_id
  const teammates = team.members

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={springs.smooth}
      className="fixed inset-0 z-50 flex flex-col bg-[var(--terminal-bg)]"
      role="dialog"
      aria-label={`Teammate ${member.name} terminal`}
    >
      {/* Glass header — chevron-back, colour rail + status + name, team subtitle.
          safe-header packages the top safe-area inset (notch / Dynamic Island). */}
      <header className="safe-header glass z-10 flex items-center gap-2 border-b border-border/60 px-2">
        <button
          type="button"
          aria-label="Back to overview"
          onClick={onClose}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-5" />
        </button>

        <span
          aria-hidden
          className="h-5 w-[2px] shrink-0 rounded-full"
          style={{ backgroundColor: member.color || 'hsl(var(--status-idle))' }}
        />
        <MemberStatusDot status={member.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-tight">
            {member.name}
          </div>
          <div className="truncate text-xs text-muted-foreground leading-tight">
            {team.team_name} · {MEMBER_STATUS_LABEL[member.status]}
          </div>
        </div>
        <Maximize2 className="mr-1 size-4 shrink-0 text-muted-foreground/50" aria-hidden />
      </header>

      {/* Thin member strip — switch teammate inside the team without leaving
          full-screen (only when there's more than one + a handler). Horizontal
          scroll, 44pt chips, active one highlighted. */}
      {onSelectMember && teammates.length > 1 && (
        <div className="z-10 flex gap-1.5 overflow-x-auto border-b border-border/40 bg-card/60 px-2 py-1.5 backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {teammates.map((m) => {
            const active = m.name === member.name
            return (
              <button
                key={m.agent_id}
                type="button"
                onClick={() => onSelectMember(m.name)}
                aria-pressed={active}
                className={
                  'flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors ' +
                  (active
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground')
                }
              >
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: m.color || 'hsl(var(--status-idle))',
                  }}
                />
                <span className="max-w-[8rem] truncate">{m.name}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Full-bleed read-only terminal (or a calm "no live pane" notice). */}
      <div className="relative min-h-0 flex-1">
        {gone ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {member.status === 'offline'
              ? 'This teammate is offline — no live terminal right now.'
              : 'No live pane for this teammate right now. It may come back shortly.'}
          </div>
        ) : (
          <TeammateTerminal
            // Remount when the pane id OR the selected member changes so a fresh
            // WS connects to the new pane.
            key={`${team.team_name}/${member.name}/${member.tmux_pane_id}`}
            team={team.team_name}
            member={member.name}
            paneId={member.tmux_pane_id}
          />
        )}
      </div>
    </motion.div>
  )
}

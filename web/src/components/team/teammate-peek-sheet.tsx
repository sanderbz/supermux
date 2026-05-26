// TeammatePeekSheet — the half-sheet peek for an Agent Teams teammate
// (AT-F-FRONT / F2). A teammate variant of <QuickPeekModal>: a Vaul half-sheet
// over the overview that mounts a READ-ONLY <TeammateTerminal> (the same xterm
// renderer the session peek uses) so the user can glance at a teammate's live
// pane WITHOUT leaving the overview. Opened zero-click via the chip's peek glyph
// (or long-press outside custom mode). The WS opens only while the sheet is
// mounted and tears down on close (this subtree unmounts).
//
// READ-ONLY: there are no Stop/Restart/Archive actions here (a teammate is not a
// supermux session — it has no lifecycle the client owns; cleanup goes via the
// lead, per the plan). The only action is "Open full screen" (focus the
// teammate's terminal), surfaced as a calm header affordance.

import { Drawer } from 'vaul'
import { Maximize2, X } from 'lucide-react'

import { MemberStatusDot } from './member-status-dot'
import { TeammateTerminal } from '@/components/terminal/teammate-terminal'
import type { Team, TeamMember } from '@/lib/api/teams'

export interface TeammatePeekSheetProps {
  team: Team
  member: TeamMember
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Promote the peek to the full-screen teammate focus (tap "Open full screen"
   *  or just tap the chip). Closes the sheet first. */
  onFocus: () => void
}

export function TeammatePeekSheet({
  team,
  member,
  open,
  onOpenChange,
  onFocus,
}: TeammatePeekSheetProps) {
  // Only gate on pane absence (not status). Claude flips teammates to
  // isActive:false the moment their turn ends, but the tmux pane keeps
  // streaming — show whatever's in the pane while it's alive.
  const gone = !member.tmux_pane_id

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex h-[78vh] flex-col rounded-t-2xl border-t border-border bg-card/85 outline-none backdrop-blur-xl">
          {/* Drag handle — 36×5, tertiary tint (matches QuickPeekModal). */}
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-full bg-muted-foreground/30" />

          <div className="flex items-center gap-2 px-4 py-3">
            {/* 2px colour rail = the teammate's identity colour (same as the chip). */}
            <span
              aria-hidden
              className="h-5 w-[2px] shrink-0 rounded-full"
              style={{ backgroundColor: member.color || 'hsl(var(--status-idle))' }}
            />
            <MemberStatusDot status={member.status} />
            <Drawer.Title className="min-w-0 flex-1 truncate text-sm font-medium">
              {member.name}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {team.team_name}
              </span>
            </Drawer.Title>

            {/* Open full screen — the only action (read-only peek; no lifecycle). */}
            <button
              type="button"
              aria-label={`Open ${member.name} full screen`}
              onClick={onFocus}
              className="-my-1 flex h-11 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[13px] font-medium text-foreground/80 active:bg-secondary"
            >
              <Maximize2 className="size-4" />
              <span className="hidden sm:inline">Full screen</span>
            </button>

            <button
              type="button"
              aria-label="Close peek"
              onClick={() => onOpenChange(false)}
              className="-mr-2 flex size-11 items-center justify-center text-muted-foreground"
            >
              <X className="size-5" />
            </button>
          </div>
          <Drawer.Description className="sr-only">
            Live terminal preview of teammate {member.name} in team{' '}
            {team.team_name}
          </Drawer.Description>

          <div
            className="relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-xl"
            style={{ backgroundColor: 'var(--terminal-bg)' }}
          >
            {gone ? (
              // No pane id this tick — calm "no live pane" message rather than a
              // failing WS. The pane can come back (the %id flips across ticks),
              // so this is informational, not an error.
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                No live pane for this teammate right now.
              </div>
            ) : (
              <div className="absolute inset-0">
                <TeammateTerminal
                  // Remount per open so a fresh WS connects (key on the pane id +
                  // open identity keeps it stable across re-renders while open).
                  key={`${team.team_name}/${member.name}/${member.tmux_pane_id}`}
                  team={team.team_name}
                  member={member.name}
                  paneId={member.tmux_pane_id}
                  className="rounded-none"
                />
              </div>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

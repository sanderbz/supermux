// KillTeammateButton — the trash affordance on a teammate chip/card.
//
// Kills the teammate's tmux pane via
// `DELETE /api/sessions/{lead}/teammates/{paneId}` — the MANUAL Agent Teams
// cleanup (the Claude-side graceful shutdown route is unreliable, so the user
// gets an explicit per-teammate kill). Inline destructive confirm — the idle
// trash icon morphs into "Cancel / Kill pane" so a stray tap can never nuke a
// live agent (same pattern as the Archived sheet's per-row delete).
//
// KNOWN TRADE-OFF: killing the pane does NOT remove the member from Claude's
// on-disk roster (~/.claude/teams/…/config.json — mid-session edits are
// unsupported), so the member stays on the card as offline (null %id, at which
// point this button renders nothing) until the lead session ends.
//
// Renders null when there's nothing killable: no live pane this tick, or the
// lead isn't mapped to a supermux session (no endpoint to address).

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useToast } from '@/components/ui/use-toast'
import { TEAMS_KEY } from '@/hooks/use-teams'
import { teamsApi, type Team, type TeamMember } from '@/lib/api/teams'

export interface KillTeammateButtonProps {
  team: Team
  member: TeamMember
  className?: string
}

export function KillTeammateButton({
  team,
  member,
  className,
}: KillTeammateButtonProps) {
  const lead = team.lead_supermux_session
  const paneId = member.tmux_pane_id
  const qc = useQueryClient()
  const { toast } = useToast()
  const reduce = useReducedMotion()
  const [confirming, setConfirming] = React.useState(false)

  const kill = useMutation({
    // Non-null asserted via the render gate below (button never mounts without both).
    mutationFn: () => teamsApi.killTeammate(lead as string, paneId as string),
    onSuccess: () => {
      toast({ message: `Killed ${member.name}’s pane` })
      // Re-pull the roster now: the watcher's next tick flips the member to
      // offline (null %id) — invalidating gets the UI there without waiting
      // for the SSE snapshot.
      void qc.invalidateQueries({ queryKey: TEAMS_KEY })
    },
    onError: () => toast({ message: 'Couldn’t kill teammate pane', tone: 'error' }),
    onSettled: () => setConfirming(false),
  })

  if (!lead || !paneId) return null

  // stopPropagation on click AND keydown: the chip's whole row is a
  // role="button" tap-to-focus target, so inner interactions must never bubble
  // into a navigation.
  const swallow = (e: React.SyntheticEvent) => e.stopPropagation()

  if (confirming) {
    return (
      <motion.div
        initial={reduce ? false : { opacity: 0, x: 8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={springs.snappy}
        className={cn('flex shrink-0 items-center gap-1', className)}
        onClick={swallow}
        onKeyDown={swallow}
      >
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={kill.isPending}
          className="flex h-7 items-center rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => kill.mutate()}
          disabled={kill.isPending}
          className="flex h-7 items-center gap-1 rounded-md bg-destructive px-2 text-[12px] font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Trash2 className="size-3.5" aria-hidden />
          Kill pane
        </button>
      </motion.div>
    )
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        swallow(e)
        setConfirming(true)
      }}
      onKeyDown={swallow}
      disabled={kill.isPending}
      aria-label={`Kill ${member.name}’s pane`}
      title="Kill pane"
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
    >
      <Trash2 className="size-4" aria-hidden />
    </button>
  )
}

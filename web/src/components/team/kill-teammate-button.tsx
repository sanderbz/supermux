// KillTeammateButton: the trash affordance on a teammate chip/card.
//
// REMOVES a teammate from supermux's team view via
// `DELETE /api/teams/{team_name}/members/{agent_id}` (`teamsApi.removeTeammate`).
// State-aware:
//   • LIVE teammate (has a tmux pane this tick) → the server kills the pane THEN
//     records the dismissal, so the chip disappears at once instead of lingering
//     as a dead/offline chip. Confirm label + tooltip: "Kill & remove".
//   • DEAD/offline teammate (no pane) → the server just records the dismissal.
//     Confirm label + tooltip: "Remove".
//
// A dismissal is a SUPERMUX-SIDE hide keyed by (team_name, agent_id): Claude's
// on-disk roster (~/.claude/teams/…/config.json) is NEVER edited (mid-session
// edits are unsupported by Claude Code), and the hide survives restarts (the
// teams watcher filters the teammate out on every tick). This is why the button
// now renders for offline members too: it needs only the stable
// (team_name, agent_id) identity, not a live pane.
//
// Inline destructive confirm: the idle trash icon morphs into "Cancel / <verb>"
// so a stray tap can never nuke a live agent (same pattern as the Archived
// sheet's per-row delete).
//
// Renders null only when there's no addressable identity (no team_name or
// agent_id): nothing we could dismiss.

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
  const teamName = team.team_name
  const agentId = member.agent_id
  // "Live" = has a validated pane this tick. Drives the verb: killing the pane
  // is only relevant when there IS one; an offline teammate is just removed.
  const isLive = Boolean(member.tmux_pane_id)
  const verb = isLive ? 'Kill & remove' : 'Remove'
  const qc = useQueryClient()
  const { toast } = useToast()
  const reduce = useReducedMotion()
  const [confirming, setConfirming] = React.useState(false)

  const remove = useMutation({
    // Non-null asserted via the render gate below (button never mounts without both).
    mutationFn: () => teamsApi.removeTeammate(teamName, agentId),
    onSuccess: () => {
      toast({ message: `Removed ${member.name}` })
      // Re-pull the roster now so the chip disappears without waiting for the
      // watcher's next SSE snapshot (which also drops the dismissed member).
      void qc.invalidateQueries({ queryKey: TEAMS_KEY })
    },
    onError: () => toast({ message: `Couldn’t remove ${member.name}`, tone: 'error' }),
    onSettled: () => setConfirming(false),
  })

  if (!teamName || !agentId) return null

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
          disabled={remove.isPending}
          className="flex h-7 items-center rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
          className="flex h-7 items-center gap-1 rounded-md bg-destructive px-2 text-[12px] font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Trash2 className="size-3.5" aria-hidden />
          {verb}
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
      disabled={remove.isPending}
      aria-label={`${verb} ${member.name}`}
      title={verb}
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
    >
      <Trash2 className="size-4" aria-hidden />
    </button>
  )
}

// FocusHeader — M14 (TECH_PLAN §4.4 desktop, "Header (44px)").
//
// The top chrome of the desktop focus main pane: 44px tall, session name +
// status dot on the left, Detach + Stop buttons on the right. The status banner
// itself is rendered globally inside <LiveTerminal> (the connection pill); this
// header carries the SESSION status (active / waiting / …), which is the
// orthogonal signal the user reads at a glance.
//
// VISUAL: glass material bar, Title-Case labels (Detach / Stop — never
// UPPERCASE), ≥44pt hit targets, spring button-press, no `transition: all`.

import { motion } from 'framer-motion'
import { Minimize2, Square } from 'lucide-react'

import { springs } from '@/lib/springs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import type { SessionStatus } from '@/lib/api'

export interface FocusHeaderProps {
  name: string
  title?: string
  status: SessionStatus
  /** Detach (⌘D): return to overview WITHOUT stopping the session (§4.4). */
  onDetach: () => void
  /** Stop (⌘W): confirm + stop the session, then leave (§4.4.3). */
  onStop: () => void
}

export function FocusHeader({
  name,
  title,
  status,
  onDetach,
  onStop,
}: FocusHeaderProps) {
  return (
    <header className="glass flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-3">
      <StatusDot status={status} className="shrink-0" />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-sm font-semibold tracking-tight">
          {title || name}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {STATUS_LABEL[status]}
        </span>
      </span>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.button
              type="button"
              onClick={onDetach}
              whileTap={{ scale: 0.96 }}
              transition={springs.buttonPress}
              aria-label="Detach (⌘D)"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-foreground/80 hover:bg-secondary"
            >
              <Minimize2 className="size-4" />
            </motion.button>
          </TooltipTrigger>
          <TooltipContent>Detach (⌘D)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <motion.button
              type="button"
              onClick={onStop}
              whileTap={{ scale: 0.96 }}
              transition={springs.buttonPress}
              aria-label="Stop session (⌘W)"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10"
            >
              <Square className="size-4" />
            </motion.button>
          </TooltipTrigger>
          <TooltipContent>Stop session (⌘W)</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}

export default FocusHeader

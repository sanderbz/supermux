// focus-mode/mode-menu.tsx — the ⋯ permission-mode menu (mode-shift).
//
// A chic dropdown that switches a running Claude session's permission mode from
// the focus header. The menu reflects the TRUE current mode (live-checked from
// `session.mode`, which the server parses from the status bar) — never an
// optimistic guess. Three modes cycle in place via targeted Shift+Tab
// (server-side: re-read the capture, capped retries); Bypass is launch-only, so
// it confirms then does a clean relaunch (the server resumes the same chat).
//
// Used by BOTH focus headers (desktop <DesktopFocusHeader> + mobile
// <FocusHeader>). Reuses the shared <DropdownMenu> primitive (Radix → keyboard-
// accessible: ↑/↓ to move, Enter/Space to select, Esc to close, focus trapped).
// ≥44pt trigger, reduced-motion honoured by the primitive's data-state classes.

import * as React from 'react'
import { MoreHorizontal, ShieldAlert } from 'lucide-react'
import { motion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { CONFIRM } from '@/brand/copy'
import { sessionsApi, type SessionMode } from '@/lib/api'
import { modeChipLabel } from '@/components/focus-mode/mode-labels'
import { useToast } from '@/components/ui/use-toast'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** The runtime-cyclable modes, in their Shift+Tab order, plus the launch-only
 *  Bypass row (rendered separately, destructive-styled). */
const CYCLE_MODES: { value: SessionMode; label: string; hint: string }[] = [
  { value: 'normal', label: 'Normal', hint: 'Asks before every edit' },
  { value: 'accept_edits', label: 'Accept edits', hint: 'Auto-accepts file edits' },
  { value: 'plan', label: 'Plan mode', hint: 'Plans first, no changes' },
]

export interface ModeMenuProps {
  /** The session name (the set-mode endpoint target). */
  name: string
  /** The live mode (from `session.mode`); defaults to `normal` when unknown. */
  mode?: SessionMode
  /** Trigger size — desktop uses the 44pt header button; mobile matches its
   *  44pt cluster. Both meet the ≥44pt hit-target floor. */
  className?: string
}

export function ModeMenu({ name, mode, className }: ModeMenuProps) {
  const current: SessionMode = mode ?? 'normal'
  const { toast } = useToast()
  // Disable the whole menu while a switch is in flight so a double-tap can't
  // stack two relaunches / cycles. The live `session.mode` updates over SSE,
  // so we don't optimistically re-check — the radio tracks the real mode.
  const [busy, setBusy] = React.useState(false)

  const applyMode = React.useCallback(
    async (target: SessionMode) => {
      if (busy || target === current) return
      // Bypass restarts the session → confirm first (it's the consequential one).
      if (target === 'bypass') {
        const c = CONFIRM.switchToBypass
        if (!window.confirm(`${c.title}\n\n${c.body}`)) return
      }
      setBusy(true)
      try {
        const res = await sessionsApi.setMode(name, target)
        if (res.relaunched) {
          toast({ message: 'Session restarted in Bypass mode.', tone: 'active' })
        } else if (!res.converged) {
          // The cycle couldn't reach the target — show the REAL mode (truth).
          toast({
            message: `Couldn't switch to ${modeChipLabel(target)} — still ${modeChipLabel(res.mode)}.`,
            tone: 'waiting',
          })
        }
      } catch (e) {
        toast({
          message: e instanceof Error ? e.message : 'Mode switch failed.',
          tone: 'error',
        })
      } finally {
        setBusy(false)
      }
    },
    [busy, current, name, toast],
  )

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <motion.button
              type="button"
              disabled={busy}
              whileTap={{ scale: 0.96 }}
              transition={springs.buttonPress}
              aria-label={`Permission mode: ${modeChipLabel(current)}`}
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-lg text-foreground/80 hover:bg-secondary disabled:opacity-50 data-[state=open]:bg-secondary',
                className,
              )}
            >
              <MoreHorizontal className="size-4" />
            </motion.button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Permission mode</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel className="text-muted-foreground">
          Permission mode
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(v) => void applyMode(v as SessionMode)}
        >
          {CYCLE_MODES.map((m) => (
            <DropdownMenuRadioItem
              key={m.value}
              value={m.value}
              disabled={busy}
              className="flex-col items-start gap-0.5 py-2"
            >
              <span className="text-sm">{m.label}</span>
              <span className="text-[11px] text-muted-foreground">{m.hint}</span>
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          {/* Bypass — launch-only, destructive-styled (amber), confirms then
              relaunches. The radio still reflects whether bypass is the live mode. */}
          <DropdownMenuRadioItem
            value="bypass"
            disabled={busy}
            className="flex-col items-start gap-0.5 py-2 text-status-error focus:text-status-error"
          >
            <span className="flex items-center gap-1.5 text-sm">
              <ShieldAlert className="size-3.5" />
              Bypass permissions
            </span>
            <span className="text-[11px] opacity-80">
              Skips all prompts · restarts the session
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default ModeMenu

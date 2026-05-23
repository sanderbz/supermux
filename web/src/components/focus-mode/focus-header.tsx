// focus-mode/focus-header.tsx — the focus-mode top bars for BOTH viewports.
//
//   • DesktopFocusHeader — M14 (TECH_PLAN §4.4 desktop, "Header (44px)"): session
//     name + status on the left, Detach + Stop on the right. Imported by
//     DesktopSplit.
//   • FocusHeader        — M15 (TECH_PLAN §4.4 mobile "Top bar"): chevron-back,
//     centred truncating title + status, ··· overflow. Imported by focus/mobile.
//
// M14 and M15 each authored a component named FocusHeader with INCOMPATIBLE
// props; the merge keeps both by giving the desktop one a distinct name.

import { motion } from 'framer-motion'
import { ChevronLeft, Minimize2, Square } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { SessionStatus } from '@/lib/api'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import {
  supportsViewTransitions,
  vtSessionName,
} from '@/components/view-transitions/morph'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ── DesktopFocusHeader (M14, TECH_PLAN §4.4 desktop) ──────────────────────────
//
// The top chrome of the desktop focus main pane: 44px tall, session name +
// status dot on the left, Detach + Stop buttons on the right. The status banner
// itself is rendered globally inside <LiveTerminal> (the connection pill); this
// header carries the SESSION status (active / waiting / …), which is the
// orthogonal signal the user reads at a glance.
//
// VISUAL: glass material bar, Title-Case labels (Detach / Stop — never
// UPPERCASE), ≥44pt hit targets, spring button-press, no `transition: all`.

export interface DesktopFocusHeaderProps {
  name: string
  title?: string
  status: SessionStatus
  /** Detach (⌘D): return to overview WITHOUT stopping the session (§4.4). */
  onDetach: () => void
  /** Stop (⌘W): confirm + stop the session, then leave (§4.4.3). */
  onStop: () => void
}

export function DesktopFocusHeader({
  name,
  title,
  status,
  onDetach,
  onStop,
}: DesktopFocusHeaderProps) {
  return (
    <header
      className="glass flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-3"
      // Shared-element View Transition target (§M23a): carries the SAME
      // `view-transition-name` as the session's overview tile, so the tile
      // morphs into this header bar on navigate (Chromium). No-op elsewhere.
      style={
        supportsViewTransitions
          ? { viewTransitionName: vtSessionName(name) }
          : undefined
      }
    >
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

// ── FocusHeader (M15, TECH_PLAN §4.4 mobile "Top bar") ─────────────────────────
//
// 44px + safe-area-top, chevron-back left, session title (truncating) + status
// dot, ··· overflow right. Sentence-case labels, ≥44pt hit targets.

export interface FocusHeaderProps {
  name: string
  status: SessionStatus
  onBack: () => void
  className?: string
}

export function FocusHeader({
  name,
  status,
  onBack,
  className,
}: FocusHeaderProps) {
  return (
    <header
      className={cn(
        // pt-safe is owned by the HEADER itself (not the outer sheet) so the
        // safe-area inset resolves correctly regardless of any transformed
        // ancestor (the swipe-peek motion.div) AND survives the View Transition
        // morph — the UA's `::view-transition-group` pseudo-element inherits
        // the layout from this header, so the morphing top bar reserves the
        // status-bar / Dynamic Island region from the first frame instead of
        // snapping into place when the transition ends. Mirrors the desktop
        // <MobileTopBar> pattern (layout.tsx) where pt-safe also lives ON the
        // header. Use min-h-11 (NOT h-11): the element is border-box, so a fixed
        // h-11 would let pt-safe's env(safe-area-inset-top) eat INTO the 44px
        // box and clip the title from the bottom on notched devices. min-h-11
        // keeps the 44pt hit-target floor while letting the safe-area padding
        // grow the box additively (44px content + inset), so the title clears
        // both the notch above and the terminal below.
        'flex min-h-11 shrink-0 items-center gap-1 border-b border-border/60 px-1 pt-safe',
        className,
      )}
      // Shared-element View Transition target (§M23a): same name as the tile, so
      // the tapped tile morphs into this top bar on navigate (Chromium).
      style={
        supportsViewTransitions
          ? { viewTransitionName: vtSessionName(name) }
          : undefined
      }
    >
      <motion.button
        type="button"
        aria-label="Back to overview"
        whileTap={{ scale: 0.92 }}
        transition={springs.buttonPress}
        onClick={onBack}
        className="flex size-11 items-center justify-center rounded-lg text-primary active:bg-secondary"
      >
        <ChevronLeft className="size-5" />
      </motion.button>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-1">
        <StatusDot status={status} />
        <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">
          {name}
        </h1>
      </div>

      {/* R5 — the title-bar "···" overflow was removed: it opened the same
          SessionPickerSheet as the bottom-left session pill (redundant; the
          pill is the richer affordance). A spacer keeps the title centred
          against the left back-button. */}
      <span className="size-11 shrink-0" aria-hidden />
    </header>
  )
}

export default FocusHeader

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
import {
  ChevronLeft,
  CornerDownLeft,
  Minimize2,
  SlidersHorizontal,
  Square,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { SessionStatus } from '@/lib/api'
import { useClaudeToolsSheet } from '@/stores/claude-tools-store'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import {
  ActivityLine,
  ErrorBadge,
} from '@/components/session-tile/activity-status'
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
  /** Live "what the agent is doing now" label (hooks-10x) — shown next to the
   *  status while the agent is working; falls back to the status label otherwise. */
  activity?: string
  /** Unrecovered agent error (hooks-10x) — drives the amber blocked badge. */
  error?: { type: string; message: string }
  /** Detach (⌘D): return to overview WITHOUT stopping the session (§4.4). */
  onDetach: () => void
  /** Stop (⌘W): confirm + stop the session, then leave (§4.4.3). */
  onStop: () => void
}

export function DesktopFocusHeader({
  name,
  title,
  status,
  activity,
  error,
  onDetach,
  onStop,
}: DesktopFocusHeaderProps) {
  // Entry point 1 (skills-mcp-manager plan §C.1): the Claude tools manager,
  // pre-scoped to THIS session's project so .mcp.json / .claude/* resolve.
  const openClaudeTools = useClaudeToolsSheet((s) => s.openSheet)
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
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
          {title || name}
        </span>
        {error && <ErrorBadge error={error} />}
        {/* While the agent is working with a live activity label, show the
            activity line in place of the static status word (the live "what is
            it doing now" signal). Otherwise fall back to the status label. The
            title keeps `flex-1` priority, so the activity only takes its own
            (shrinkable, truncating) width and never starves the name. */}
        {(status === 'active' || status === 'starting') && activity?.trim() ? (
          <ActivityLine
            activity={activity}
            className="min-w-0 shrink basis-auto text-[11px]"
          />
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {STATUS_LABEL[status]}
          </span>
        )}
      </span>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.button
              type="button"
              onClick={() => openClaudeTools(name)}
              whileTap={{ scale: 0.96 }}
              transition={springs.buttonPress}
              aria-label="Claude tools"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-foreground/80 hover:bg-secondary"
            >
              <SlidersHorizontal className="size-4" />
            </motion.button>
          </TooltipTrigger>
          <TooltipContent>Claude tools</TooltipContent>
        </Tooltip>

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
  /** Live "what the agent is doing now" label (hooks-10x) — shown under the name
   *  while the agent is working. */
  activity?: string
  /** Unrecovered agent error (hooks-10x) — drives the amber blocked badge. */
  error?: { type: string; message: string }
  onBack: () => void
  /** Send Enter (`\r`) to the focused terminal (mobile-only). The header button
   *  lets you submit a prompt WITHOUT the soft keyboard's return key — handy when
   *  the keyboard is hidden, or just for a one-tap submit. Wired in
   *  focus/mobile.tsx to `termRef.current?.sendKey('Enter')`. */
  onEnter?: () => void
  className?: string
}

/** Truncate a session name for the mobile top bar so a long name never overflows
 *  / pushes the right-side controls off-screen. ~8 chars then a trailing ellipsis;
 *  the FULL name stays in the accessible `title`/`aria-label` (see usage). */
const NAME_MAX = 8
function truncateName(name: string): string {
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX)}…` : name
}

export function FocusHeader({
  name,
  status,
  activity,
  error,
  onBack,
  onEnter,
  className,
}: FocusHeaderProps) {
  const showActivity =
    (status === 'active' || status === 'starting') && !!activity?.trim()
  // Entry point 1, mobile (skills-mcp-manager plan §C.1): the right slot — a bare
  // spacer since R5 removed the redundant "···" — now hosts the Claude tools
  // icon, pre-scoped to THIS session's project. Keeps the title centred against
  // the left back-button (same 44pt footprint as the old spacer).
  const openClaudeTools = useClaudeToolsSheet((s) => s.openSheet)
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

      <div className="flex min-w-0 flex-1 flex-col items-center justify-center px-1">
        <div className="flex min-w-0 max-w-full items-center justify-center gap-1.5">
          <StatusDot status={status} />
          {/* Truncate to ~8 chars + ellipsis so a long session name never
              overflows or shoves the right-side controls off-screen. The FULL
              name stays the accessible label (title + aria-label) so it's never
              lost. (CSS `truncate` is still kept as a width-safety net for the
              centred flex column on the narrowest devices.) */}
          <h1
            title={name}
            aria-label={name}
            className="min-w-0 truncate text-[15px] font-semibold tracking-tight"
          >
            {truncateName(name)}
          </h1>
          {error && <ErrorBadge error={error} />}
        </div>
        {/* Live activity sub-line (hooks-10x) — sits under the name while the
            agent is working so "what is it doing now" is obvious. The header is
            min-h-11 (grows additively), so a second line never clips the 44pt
            hit-target floor. */}
        {showActivity && (
          <ActivityLine
            activity={activity}
            className="max-w-full text-center text-[11px] leading-tight"
          />
        )}
      </div>

      {/* Right cluster. The space freed by truncating the name (above) now also
          carries an Enter affordance next to the Claude tools icon — both 44pt
          targets, keeping the title centred against the left back-button. */}
      <div className="flex shrink-0 items-center">
        {/* Enter — sends `\r` to the focused terminal so you can submit a prompt
            WITHOUT the soft keyboard's return key (very handy on mobile). The
            `preventDefault` on pointer/mouse-down is load-bearing: it stops the
            tap from moving DOM focus off xterm's hidden helper textarea, which on
            iOS would dismiss the keyboard. The send still fires on `onClick`, so
            the keyboard stays up. Mirrors the dock accessory-key pattern. */}
        {onEnter && (
          <motion.button
            type="button"
            aria-label="Send Enter"
            whileTap={{ scale: 0.92 }}
            transition={springs.buttonPress}
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onEnter}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground/80 active:bg-secondary"
          >
            <CornerDownLeft className="size-5" />
          </motion.button>
        )}

        {/* R5 removed the redundant "···" overflow (it duplicated the session
            pill). This slot carries the Claude tools manager icon. */}
        <motion.button
          type="button"
          aria-label="Claude tools"
          whileTap={{ scale: 0.92 }}
          transition={springs.buttonPress}
          onClick={() => openClaudeTools(name)}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground/80 active:bg-secondary"
        >
          <SlidersHorizontal className="size-5" />
        </motion.button>
      </div>
    </header>
  )
}

export default FocusHeader

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
  Minimize2,
  SlidersHorizontal,
  Square,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { SessionStatus, SessionMode } from '@/lib/api'
import { useClaudeToolsSheet } from '@/stores/claude-tools-store'
import { ModeMenu } from '@/components/focus-mode/mode-menu'
import { modeChipLabel } from '@/components/focus-mode/mode-labels'
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

// ── ModeChip (mode-shift) ─────────────────────────────────────────────────────
//
// A small glanceable pill next to the title showing the current permission mode
// (zero-click state visibility — the no-extra-clicks principle). Only rendered
// for the non-default modes (Normal needs no chip). Bypass uses the calm
// status-error orange (matches <ErrorBadge>); plan/accept-edits use a quiet
// secondary tint so they read as informational, not alarming.

function ModeChip({ mode }: { mode: SessionMode }) {
  const isBypass = mode === 'bypass'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
        isBypass
          ? 'bg-status-error/15 text-status-error'
          : 'bg-secondary text-muted-foreground',
      )}
      title={`Permission mode: ${modeChipLabel(mode)}`}
    >
      {modeChipLabel(mode)}
    </span>
  )
}

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
  /** Live Claude permission mode (mode-shift) — drives the ⋯ menu's checked radio
   *  and the glanceable title chip. Defaults to `normal` when unknown. */
  mode?: SessionMode
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
  mode,
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
        {/* Glanceable mode chip (mode-shift) — zero-click state visibility next to
            the title. Only shown for the non-default modes so Normal stays clean. */}
        {mode && mode !== 'normal' && <ModeChip mode={mode} />}
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
        {/* ⋯ permission-mode menu (mode-shift) — live-checked radios from `mode`;
            cycle modes via Shift+Tab, Bypass confirms + relaunches. */}
        <ModeMenu name={name} mode={mode} />

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
  /** Live Claude permission mode (mode-shift) — drives the ⋯ menu + the chip. */
  mode?: SessionMode
  onBack: () => void
  className?: string
}

export function FocusHeader({
  name,
  status,
  activity,
  error,
  mode,
  onBack,
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
          {/* CSS `truncate` ellipsises a long name to fit the centred column;
              the full name stays the accessible label (title + aria-label).
              (The hard ~8-char truncation lives on the bottom DOCK session
              switcher, where horizontal room is tight — not here.) */}
          <h1
            title={name}
            aria-label={name}
            className="min-w-0 truncate text-[15px] font-semibold tracking-tight"
          >
            {name}
          </h1>
          {/* Glanceable mode chip (mode-shift) — non-default modes only. */}
          {mode && mode !== 'normal' && <ModeChip mode={mode} />}
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

      {/* Right cluster: the ⋯ permission-mode menu + the Claude tools icon.
          (The Enter affordance lives in the bottom DOCK, beside the session
          switcher — not in this header.) */}
      <div className="flex shrink-0 items-center">
        {/* ⋯ permission-mode menu (mode-shift) — live-checked radios; cycle modes
            via Shift+Tab, Bypass confirms + relaunches. Sits left of Claude tools
            so the title's right cluster stays a single tap-row (≥44pt each). */}
        <ModeMenu name={name} mode={mode} className="size-11" />

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

// focus-mode/focus-header.tsx — the focus-mode top bars for BOTH viewports.
//
//   • DesktopFocusHeader — desktop "Header (44px)": session name + status on
//     the left, Detach + Stop on the right. Imported by DesktopSplit.
//   • FocusHeader        — mobile "Top bar": chevron-back, centred truncating
//     title + status, ··· overflow. Imported by focus/mobile.
//
// The desktop and mobile variants each authored a component named FocusHeader
// with INCOMPATIBLE props; the merge keeps both by giving the desktop one a
// distinct name.

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  ChevronLeft,
  Minimize2,
  SlidersHorizontal,
  Square,
  Users,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { SessionStatus } from '@/lib/api'
import { useAgentToolsSheet } from '@/stores/claude-tools-store'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import {
  ActivityLine,
  ErrorBadge,
} from '@/components/session-tile/activity-status'
import { LastSendButton } from './last-send-recall'
import {
  supportsViewTransitions,
  vtSessionName,
} from '@/components/view-transitions/morph'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ── DesktopFocusHeader (desktop) ──────────────────────────────────────────────
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
  /** Session provider. Agent-specific controls are hidden for shell panes. */
  provider?: string
  title?: string
  status: SessionStatus
  /** Live "what the agent is doing now" label (hooks-10x) — shown next to the
   *  status while the agent is working; falls back to the status label otherwise. */
  activity?: string
  /** Live outstanding Task sub-agent count → the calm `· N subagents` clause. */
  subagents?: number
  /** Unrecovered agent error (hooks-10x) — drives the amber blocked badge. */
  error?: { type: string; message: string }
  /** Detach (⌘D): return to overview WITHOUT stopping the session. */
  onDetach: () => void
  /** Stop (⌘W): confirm + stop the session, then leave. */
  onStop: () => void
  /** Refresh: re-pull a clean full-screen snapshot from the server (the manual
   *  twin of the automatic post-resize resync) to wipe any residual render
   *  garble without a page reload. Omit to hide the control (e.g. a stopped
   *  session with no live pty). */
  onRefresh?: () => void
  /** Open the "Make it a team" sheet for this session. Omit
   *  to hide the affordance entirely (e.g. on a session that's ALREADY a team
   *  lead — the route owns that gating so the header stays presentational). */
  onMakeTeam?: () => void
  /** Open the session info panel (feat-session-info). When set, the title becomes
   *  a bare button (pixel-identical to the span — no padding/border/extra height,
   *  so NO resting space is added). The route owns the panel + its anchor ref. */
  onTitleClick?: () => void
  /** Ref to the title <button> — the route passes it to the info panel's Popover
   *  `virtualRef` so the popover anchors to the title. */
  titleRef?: React.Ref<HTMLButtonElement>
  /** Whether this session has a recallable last prompt. When false the recall
   *  icon is omitted entirely (no dead control in the header cluster). */
  hasLastSend?: boolean
  /** Whether the recall popover is currently open (drives `aria-expanded`). */
  lastSendOpen?: boolean
  /** Toggle the recall popover. The popover itself lives at the DesktopSplit
   *  level so the bar (below this header) can drive the SAME state. */
  onToggleLastSend?: () => void
  /** Ref to the recall icon — anchors the popover at the DesktopSplit level. */
  lastSendButtonRef?: React.Ref<HTMLButtonElement>
}

export function DesktopFocusHeader({
  name,
  provider,
  title,
  status,
  activity,
  subagents,
  error,
  onDetach,
  onStop,
  onMakeTeam,
  onTitleClick,
  titleRef,
  hasLastSend,
  lastSendOpen,
  onToggleLastSend,
  lastSendButtonRef,
}: DesktopFocusHeaderProps) {
  // One provider-aware tools entry point. The host renders Claude's registry
  // manager or Codex's native quick actions from the same focused session.
  const openAgentTools = useAgentToolsSheet((s) => s.openSheet)
  const toolsLabel = provider === 'codex' ? 'Codex tools' : 'Claude tools'
  const showAgentTools = provider === 'claude' || provider === 'codex'
  return (
    <header
      className="glass flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-3"
      // Shared-element View Transition target: carries the SAME
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
        {onTitleClick ? (
          // The title is a bare button (feat-session-info). It keeps the span's
          // typography (text-sm font-semibold tracking-tight, truncate, flex-1)
          // and stays pixel-aligned at rest: the px-1.5 is cancelled by an equal
          // -mx-1.5, so the text sits exactly where the span did — but on hover a
          // subtle rounded `bg-secondary` reveals that the title is interactive
          // (iOS/macOS hover affordance, matching the header's other buttons).
          // `text-left` keeps the truncated text aligned as the span was.
          <button
            ref={titleRef}
            type="button"
            onClick={onTitleClick}
            title={title || name}
            aria-label={`Session info — ${title || name}`}
            aria-haspopup="true"
            className="-mx-1.5 min-w-0 flex-1 truncate rounded-md px-1.5 text-left text-sm font-semibold tracking-tight outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title || name}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
            {title || name}
          </span>
        )}
        {error && <ErrorBadge error={error} />}
        {/* While the agent is working with a live activity label, show the
            activity line in place of the static status word (the live "what is
            it doing now" signal). Otherwise fall back to the status label. The
            title keeps `flex-1` priority, so the activity only takes its own
            (shrinkable, truncating) width and never starves the name. */}
        {(status === 'active' || status === 'starting') && activity?.trim() ? (
          <ActivityLine
            activity={activity}
            subagents={subagents}
            className="min-w-0 shrink basis-auto text-[11px]"
          />
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {STATUS_LABEL[status]}
          </span>
        )}
      </span>

      <div className="flex shrink-0 items-center gap-1">
        {/* Recall last prompt (feat-last-prompt) — left of Claude tools so the
            "what I said" affordance sits adjacent to the session-level config
            cluster. Hidden when the session has no submission yet. */}
        {hasLastSend && onToggleLastSend && (
          <LastSendButton
            onToggle={onToggleLastSend}
            open={!!lastSendOpen}
            buttonRef={lastSendButtonRef}
            shortcutHint="⌘G"
          />
        )}
        {/* Provider-aware tools: Claude opens its registry + permission modes;
            Codex opens native high-use slash panels. */}
        {showAgentTools && (
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                onClick={() => openAgentTools(name)}
                whileTap={{ scale: 0.96 }}
                transition={springs.buttonPress}
                aria-label={toolsLabel}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-foreground/80 hover:bg-secondary"
              >
                <SlidersHorizontal className="size-4" />
              </motion.button>
            </TooltipTrigger>
            <TooltipContent>{toolsLabel}</TooltipContent>
          </Tooltip>
        )}

        {/* "Make it a team": only rendered when the route
            decides this session is eligible (not already a team lead, not
            archived). Placed BEFORE Detach so the destructive Stop button
            stays last in the cluster — iOS-y reading order. */}
        {onMakeTeam && (
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                onClick={onMakeTeam}
                whileTap={{ scale: 0.96 }}
                transition={springs.buttonPress}
                aria-label="Make this a team"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-foreground/80 hover:bg-secondary"
              >
                <Users className="size-4" />
              </motion.button>
            </TooltipTrigger>
            <TooltipContent>Make this a team</TooltipContent>
          </Tooltip>
        )}

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

// ── FocusHeader (mobile "Top bar") ────────────────────────────────────────────
//
// 44px + safe-area-top, chevron-back left, session title (truncating) + status
// dot, ··· overflow right. Sentence-case labels, ≥44pt hit targets.

export interface FocusHeaderProps {
  name: string
  /** Session provider. Agent-specific controls are hidden for shell panes. */
  provider?: string
  /** Visible title text (defaults to `name`). `name` stays the view-transition
   *  anchor + identity; this is only what's rendered. Matches the desktop
   *  header's `title` prop. */
  title?: string
  status: SessionStatus
  /** Live "what the agent is doing now" label (hooks-10x) — shown under the name
   *  while the agent is working. */
  activity?: string
  /** Live outstanding Task sub-agent count → the calm `· N subagents` clause. */
  subagents?: number
  /** Unrecovered agent error (hooks-10x) — drives the amber blocked badge. */
  error?: { type: string; message: string }
  onBack: () => void
  /** Refresh: re-pull a clean full-screen snapshot from the server (manual twin
   *  of the automatic post-resize resync). Omit to hide the control. */
  onRefresh?: () => void
  /** Open the session info panel (feat-session-info). When set, the title becomes
   *  a bare button (pixel-identical to the <h1> — no padding/border/extra height,
   *  so NO resting space is added). Mobile anchors the panel to the viewport
   *  bottom (a Sheet), so no anchor ref is needed here. */
  onTitleClick?: () => void
  /** Whether this session has a recallable last prompt (feat-last-prompt).
   *  When false the recall icon is omitted entirely. */
  hasLastSend?: boolean
  /** Whether the recall sheet is currently open (drives `aria-expanded`). */
  lastSendOpen?: boolean
  /** Toggle the recall sheet. */
  onToggleLastSend?: () => void
  className?: string
}

export function FocusHeader({
  name,
  provider,
  title,
  status,
  activity,
  subagents,
  error,
  onBack,
  onTitleClick,
  hasLastSend,
  lastSendOpen,
  onToggleLastSend,
  className,
}: FocusHeaderProps) {
  const label = title ?? name
  const showActivity =
    (status === 'active' || status === 'starting') && !!activity?.trim()
  // Mobile: the right slot — a bare spacer since the redundant "···" was
  // removed — now hosts the provider-aware tools icon. Keeps the title centred against
  // the left back-button (same 44pt footprint as the old spacer).
  const openAgentTools = useAgentToolsSheet((s) => s.openSheet)
  const toolsLabel = provider === 'codex' ? 'Codex tools' : 'Claude tools'
  const showAgentTools = provider === 'claude' || provider === 'codex'
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
      // Shared-element View Transition target: same name as the tile, so
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
          {onTitleClick ? (
            // The title becomes a bare button (feat-session-info) with the
            // IDENTICAL typography (text-[15px] font-semibold tracking-tight,
            // truncate) and NO padding/border/background/extra height, so it is
            // pixel-identical to the <h1> at rest — zero resting space added.
            <button
              type="button"
              onClick={onTitleClick}
              title={label}
              aria-label={`Session info — ${label}`}
              aria-haspopup="dialog"
              className="min-w-0 truncate text-[15px] font-semibold tracking-tight outline-none focus-visible:underline focus-visible:decoration-dotted focus-visible:underline-offset-4"
            >
              {label}
            </button>
          ) : (
            <h1
              title={label}
              aria-label={label}
              className="min-w-0 truncate text-[15px] font-semibold tracking-tight"
            >
              {label}
            </h1>
          )}
          {error && <ErrorBadge error={error} />}
        </div>
        {/* Live activity sub-line (hooks-10x) — sits under the name while the
            agent is working so "what is it doing now" is obvious. The header is
            min-h-11 (grows additively), so a second line never clips the 44pt
            hit-target floor. */}
        {showActivity && (
          <ActivityLine
            activity={activity}
            subagents={subagents}
            className="max-w-full text-center text-[11px] leading-tight"
          />
        )}
      </div>

      {/* Right cluster: optional Recall icon + provider-aware agent tools.
          Claude's permission-mode switcher lives inside its tools sheet, so
          this cluster stays narrow — the
          right-side counterweight to the back-chevron, with the title centred
          between them. */}
      <div className="flex shrink-0 items-center">
        {hasLastSend && onToggleLastSend && (
          <LastSendButton
            onToggle={onToggleLastSend}
            open={!!lastSendOpen}
            // no shortcutHint on mobile — no hardware-keyboard expectation
          />
        )}
        {showAgentTools && (
          <motion.button
            type="button"
            aria-label={toolsLabel}
            whileTap={{ scale: 0.92 }}
            transition={springs.buttonPress}
            onClick={() => openAgentTools(name)}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground/80 active:bg-secondary"
          >
            <SlidersHorizontal className="size-5" />
          </motion.button>
        )}
      </div>
    </header>
  )
}

export default FocusHeader

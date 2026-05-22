// LiveTerminal — M13. Thin React wrapper over `useLiveTerm` (TECH_PLAN §4.5).
//
// Renders the xterm container full-bleed. Connection health surfaces TWO ways:
//   • A normal (read-write) terminal registers its WS with the global
//     `useConnection` store via `useTerminalConnectionLink` (§M23a); the
//     app-wide <ReconnectBanner> is then THE connection surface — worst-state
//     aggregated across the SSE stream + every open terminal.
//   • A read-only embed (the M11 quick-peek modal) does NOT register — its WS
//     blips shouldn't drive the global banner — so it keeps the small in-place
//     <ConnectionPill> below as its own scoped indicator.
//
// VISUAL: iOS-native xterm theming (background tracks --terminal-bg), glass
// material status pill, Title-Case labels (never UPPERCASE), ≥44pt retry hit
// target, spring physics from lib/springs.ts. No `transition: all`.

import * as React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, WifiOff } from 'lucide-react'

import '@xterm/xterm/css/xterm.css'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useLiveTerm } from '@/hooks/use-live-term'
import type { LiveTermState, UseLiveTermResult } from '@/hooks/use-live-term'
import { useTerminalConnectionLink } from '@/hooks/use-connection-link'

export interface LiveTerminalProps {
  /** Session name — maps to the M4 WS route `/ws/sessions/:name`. */
  name: string
  /** Read-only embed (e.g. the M11 quick-peek modal): no keystrokes sent. */
  readOnly?: boolean
  className?: string
  /** Receive the imperative handle so a parent dock/joystick (M14/M15/M17) can
   *  drive `sendKey` / `copyAll` without re-subscribing. */
  onReady?: (term: UseLiveTermResult) => void
}

export function LiveTerminal({
  name,
  readOnly = false,
  className,
  onReady,
}: LiveTerminalProps) {
  const term = useLiveTerm(name, { readOnly })
  const { containerRef, state, retry } = term

  React.useEffect(() => {
    onReady?.(term)
    // Only re-emit when the imperative surface meaningfully changes (state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Register this terminal's WebSocket as a connection link in the global store
  // (§M23a). The <ReconnectBanner> aggregates it with the SSE stream + any other
  // open terminals — worst-state wins, so the banner never flickers between two
  // terminals reconnecting out of phase (Codex #16). A read-only embed (e.g. the
  // quick-peek modal) does NOT register: its blips shouldn't drive the global
  // banner. The local <ConnectionPill> below stays as the in-terminal surface.
  useTerminalConnectionLink(readOnly ? '' : name, state, retry)

  return (
    <div
      className={cn(
        // Terminal surface tracks the theme token (iOS-native, §4.5). The pill
        // overlays the top-center, glass material, never UPPERCASE.
        'relative h-full w-full overflow-hidden bg-[var(--terminal-bg)]',
        className,
      )}
      data-state={state}
    >
      <div
        ref={containerRef}
        className="h-full w-full p-2"
        // xterm focuses on click; expose to the keyboard-capture layer (M14).
        tabIndex={readOnly ? -1 : 0}
        aria-label={`Live terminal for ${name}`}
        role="application"
      />

      {/* In-terminal connection pill — kept ONLY for read-only embeds (e.g. the
          quick-peek modal), which do NOT register with the global connection
          store and so have no other surface. A normal focus terminal registers
          its WS as a link via `useTerminalConnectionLink`, and the global
          <ReconnectBanner> (§M23a) is then THE connection surface — showing a
          second pill here would be redundant (Steve-Jobs bar: one surface). */}
      {readOnly && <ConnectionPill state={state} onRetry={retry} />}
    </div>
  )
}

// ── Status pill (placeholder for the M23a reconnect banner) ───────────────────

const PILL: Record<
  Exclude<LiveTermState, 'live'>,
  { label: string; tint: string; spin: boolean; retry: boolean }
> = {
  connecting: {
    label: 'Connecting…',
    tint: 'bg-warning/15 text-foreground',
    spin: true,
    retry: false,
  },
  reconnecting: {
    label: 'Reconnecting…',
    tint: 'bg-warning/15 text-foreground',
    spin: true,
    retry: false,
  },
  offline: {
    label: 'Offline',
    tint: 'bg-destructive/15 text-foreground',
    spin: false,
    retry: true,
  },
  // Terminal: the session's pty is gone. No retry — restarting the session is
  // the only way back, which the focus route surfaces as a primary action.
  stopped: {
    label: 'Session stopped',
    tint: 'bg-muted text-muted-foreground',
    spin: false,
    retry: false,
  },
}

function ConnectionPill({
  state,
  onRetry,
}: {
  state: LiveTermState
  onRetry: () => void
}) {
  // `live` shows nothing — the M23a banner owns the green "Connected" flash.
  const cfg = state === 'live' ? null : PILL[state]

  return (
    <AnimatePresence>
      {cfg && (
        <motion.div
          // Slide down from above the safe-area, in-place state morph (§Termius
          // reconnect-banner spec): one surface, spring physics, no slide-out.
          key="conn-pill"
          initial={{ y: -44, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -44, opacity: 0 }}
          transition={springs.smooth}
          className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-safe"
        >
          <motion.div
            layout
            transition={springs.snappy}
            className={cn(
              'glass pointer-events-auto mt-2 flex h-9 items-center gap-2 rounded-full px-4',
              'border border-border/60 text-[13px] font-semibold shadow-sm',
              cfg.tint,
            )}
          >
            {cfg.spin ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <WifiOff className="size-3.5" aria-hidden />
            )}
            <span>{cfg.label}</span>
            {cfg.retry && (
              <button
                type="button"
                onClick={onRetry}
                // ≥44pt hit target (Termius criterion #5) via negative-margin
                // padding while the pill stays 36pt tall.
                className="-my-2 -mr-2 ml-1 flex h-11 items-center rounded-full px-3 text-[13px] font-semibold text-primary"
              >
                Tap to retry
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default LiveTerminal

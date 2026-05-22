// LiveTerminal — M13. Thin React wrapper over `useLiveTerm` (TECH_PLAN §4.5).
//
// Renders the xterm container full-bleed and pipes the connection `state` to a
// small overlay status pill. The FULL store-backed reconnect banner (worst-state
// aggregation, slide-in/morph timing) lands in M23a — for now this is a
// self-contained, iOS-native placeholder per the M13 spec ("show 'Reconnecting…'
// text"). It is deliberately minimal so M23a can replace it without conflict.
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

      <ConnectionPill state={state} onRetry={retry} />
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

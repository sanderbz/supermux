// CompactTile — M14 (TECH_PLAN §4.4.3, desktop session-strip).
//
// The dense session-strip row for the desktop focus mode: 320px × 56px, status
// dot + name + token count + branch chip (matches the cmux sidebar density).
// The CURRENT session is highlighted via a SPRING scale 1.02 + accent border —
// NOT a class flip (§4.4.3). Hovering a NON-current tile for ≥300ms expands a
// 14-line tail-preview popover (left-anchored, 380×220) sourced from that
// session's existing tail data — NO new fetch (single source of truth, the same
// `preview_lines` the overview grid renders).
//
// VISUAL: iOS-native — glass popover material, Title/Sentence-case labels (never
// UPPERCASE), spring physics from lib/springs.ts, no `transition: all`.

import * as React from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { GitBranch } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import { TailPreview } from '@/components/session-tile/tail-preview'
import type { TileSession } from '@/components/session-tile/types'

const DWELL_MS = 300 // §4.4.3 — popover arms after 300ms dwell on a NON-current tile
const POPOVER_W = 380
const POPOVER_H = 220

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

export interface CompactTileProps {
  session: TileSession
  /** This row is the focused session — highlight + suppress its peek-popover. */
  current: boolean
  /** Jump to this session (Cmd+1..9 mirrors a click). */
  onSelect: (name: string) => void
}

/** A single 320×56 strip row. Shared `TileSession` shape with the overview grid
 *  (`@/components/session-tile/types`) — one source for status/tokens/branch and
 *  the tail `preview_lines`, so the peek-popover never re-fetches. */
export function CompactTile({ session, current, onSelect }: CompactTileProps) {
  const reduce = useReducedMotion()
  const [peeking, setPeeking] = React.useState(false)
  const dwellRef = React.useRef<number | null>(null)

  const title = session.task_summary || session.name
  const tokens =
    typeof session.tokens === 'number' ? formatTokens(session.tokens) : null

  const clearDwell = React.useCallback(() => {
    if (dwellRef.current !== null) {
      window.clearTimeout(dwellRef.current)
      dwellRef.current = null
    }
  }, [])

  // Hover dwell → arm the peek-popover. Only for NON-current rows (§4.4.3).
  const onEnter = () => {
    if (current) return
    clearDwell()
    dwellRef.current = window.setTimeout(() => setPeeking(true), DWELL_MS)
  }
  const onLeave = () => {
    clearDwell()
    setPeeking(false)
  }

  React.useEffect(() => clearDwell, [clearDwell])

  return (
    <div className="relative">
      <motion.button
        type="button"
        onClick={() => onSelect(session.name)}
        onHoverStart={onEnter}
        onHoverEnd={onLeave}
        aria-current={current ? 'true' : undefined}
        aria-label={`${title} — ${STATUS_LABEL[session.status]}`}
        // Current row: spring scale 1.02 (NOT a class flip) — §4.4.3. Reduce
        // Motion gets the same resting scale instantly, no spring.
        animate={current && !reduce ? { scale: 1.02 } : { scale: 1 }}
        transition={springs.cardExpand}
        whileTap={reduce ? undefined : { scale: current ? 0.99 : 0.98 }}
        style={{ transformOrigin: 'left center' }}
        className={cn(
          // 320 wide is enforced by the strip container; 56 tall here.
          'flex h-14 w-full items-center gap-2.5 rounded-xl border px-3 text-left outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring',
          current
            ? 'border-primary/70 bg-card shadow-sm'
            : 'border-border bg-card/60 hover:bg-card',
        )}
      >
        <StatusDot status={session.status} className="mt-px shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium leading-tight">
            {title}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            {tokens && <span className="shrink-0">{tokens} tokens</span>}
            {session.branch && (
              <span className="flex min-w-0 items-center gap-1">
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{session.branch}</span>
              </span>
            )}
          </span>
        </span>
      </motion.button>

      {/* Peek-popover — left-anchored, 380×220, 14-line tail (§4.4.3). Same
          content as the overview hover, scaled down. springs.cardExpand. */}
      <AnimatePresence>
        {peeking && !current && (
          <motion.div
            key="peek"
            initial={{ opacity: 0, x: -8, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -8, scale: 0.98 }}
            transition={reduce ? { duration: 0 } : springs.cardExpand}
            style={{ width: POPOVER_W, height: POPOVER_H, transformOrigin: 'left center' }}
            // Left-anchored: sits just right of the 320px strip.
            className="glass pointer-events-none absolute left-[calc(100%+8px)] top-1/2 z-30 -translate-y-1/2 overflow-hidden rounded-2xl border border-border/60 shadow-xl"
          >
            <div className="flex h-9 items-center gap-2 border-b border-border/60 px-3">
              <StatusDot status={session.status} />
              <span className="truncate text-[13px] font-semibold">{title}</span>
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {STATUS_LABEL[session.status]}
              </span>
            </div>
            <TailPreview lines={session.preview_lines} fill className="py-1" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default CompactTile

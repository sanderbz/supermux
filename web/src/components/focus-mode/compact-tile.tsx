// CompactTile — desktop session-strip.
//
// The dense session-strip row for the desktop focus mode: 320px × 48px (56 →
// 48 in fase B2), the session's FACE + name + token count + branch chip.
//
// After B2 this is a thin INTERACTION wrapper, like `SessionRow`: it keeps the
// hover-dwell peek popover, the current-row spring, the ⌘N chip and the select
// callback, and delegates everything DRAWN to `<RosterRow density="strip">`.
// The strip, the overview list and every picker are the same object at three
// densities; `lib/fact-ladder.ts` records which facts each one carries (strip:
// mark · attention · name · tokens · branch · ⌘N — no preview, because the
// strip's preview is the dwell popover, which is an interaction, not a fact).
// The CURRENT session is highlighted via a SPRING scale 1.02 + accent border —
// NOT a class flip. Hovering a NON-current tile for ≥300ms expands a
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
import { motionOff, springs } from '@/lib/springs'
import { STATUS_LABEL } from '@/components/session-tile/status-dot'
import { TailPreview } from '@/components/session-tile/tail-preview'
import { Kbd } from '@/components/ui/kbd'
import { sessionTitle } from '@/lib/api/sessions'
import { markStateFor } from '@/lib/mark-status'
import { usePin } from '@/hooks/use-roster-marks'
import { useRowAttention } from '@/hooks/use-attention'
import { RosterRow } from '@/components/chat/ui'
import { SessionFace } from '@/components/roster/session-face'
import type { TileSession } from '@/components/session-tile/types'

const DWELL_MS = 300 // popover arms after 300ms dwell on a NON-current tile
const POPOVER_W = 380
const POPOVER_H = 220

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

export interface CompactTileProps {
  session: TileSession
  /** This row needs you — the attention tier's `needs` (fase B2 T5). */
  attention?: boolean
  /** This row is the focused session — highlight + suppress its peek-popover. */
  current: boolean
  /** Jump to this session (Cmd+1..9 mirrors a click). */
  onSelect: (name: string) => void
  /** 1-indexed slot in the strip's `jumpSessions` list when ≤9 — used to
   *  render a small ⌘N / Ctrl+N hint on the row so the keyboard shortcut
   *  is discoverable. Undefined for rows past 9 (no hint). */
  jumpIndex?: number
}

/** A single 320×56 strip row. Shared `TileSession` shape with the overview grid
 *  (`@/components/session-tile/types`) — one source for status/tokens/branch and
 *  the tail `preview_lines`, so the peek-popover never re-fetches. */
export function CompactTile({
  session,
  attention,
  current,
  onSelect,
  jumpIndex,
}: CompactTileProps) {
  const reduce = useReducedMotion()
  const pin = usePin(session.name)
  const rowAttention = useRowAttention(session)
  const showAttention = attention ?? rowAttention.dot
  const [peeking, setPeeking] = React.useState(false)
  const dwellRef = React.useRef<number | null>(null)

  const title = sessionTitle(session)
  const tokens =
    typeof session.tokens === 'number' ? formatTokens(session.tokens) : null

  // The strip's secondary line — the ladder's `tokens` + `branch`, unchanged
  // from what this row has always shown.
  const meta =
    tokens || session.branch ? (
      <span className="flex items-center gap-2">
        {tokens && <span className="shrink-0">{tokens} tokens</span>}
        {session.branch && (
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{session.branch}</span>
          </span>
        )}
      </span>
    ) : undefined

  const clearDwell = React.useCallback(() => {
    if (dwellRef.current !== null) {
      window.clearTimeout(dwellRef.current)
      dwellRef.current = null
    }
  }, [])

  // Hover dwell → arm the peek-popover. Only for NON-current rows.
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
      <motion.div
        // Current row: spring scale 1.02 (NOT a class flip). Reduce Motion gets
        // the same resting scale instantly, no spring. The scale lives on the
        // wrapper so the primitive stays a plain button.
        animate={current && !reduce ? { scale: 1.02 } : { scale: 1 }}
        transition={springs.cardExpand}
        whileTap={reduce ? undefined : { scale: current ? 0.99 : 0.98 }}
        style={{ transformOrigin: 'left center' }}
      >
        <RosterRow
          seed={session.name}
          pin={pin}
          name={title}
          density="strip"
          // `SessionFace` owns the kill switch, so `supermux:roster-marks = '0'`
          // puts the pre-B2 status dot back in this exact footprint.
          leading={
            <SessionFace
              name={session.name}
              status={session.status}
              size={28}
              className="shrink-0"
            />
          }
          state={markStateFor(session.status)}
          attention={showAttention}
          selected={current}
          meta={meta}
          trailing={
            /* ⌘N / Ctrl+N hint — only for the first 9 jumpable rows. The
               keystroke itself is wired in `useKeyboardCapture`; the chip is
               purely a discoverability cue. */
            jumpIndex && jumpIndex <= 9 ? (
              <Kbd combo={`mod+${jumpIndex}`} variant="muted" className="shrink-0" />
            ) : undefined
          }
          ariaLabel={`${title} — ${STATUS_LABEL[session.status]}`}
          dataVr="compact-tile"
          onClick={() => onSelect(session.name)}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          className={cn(
            'border outline-none focus-visible:ring-2 focus-visible:ring-ring',
            current ? 'border-primary/70 bg-card shadow-sm' : 'border-border bg-card/60',
          )}
        />
      </motion.div>

      {/* Peek-popover — left-anchored, 380×220, 14-line tail. Same
          content as the overview hover, scaled down. springs.cardExpand. */}
      <AnimatePresence>
        {peeking && !current && (
          <motion.div
            key="peek"
            initial={{ opacity: 0, x: -8, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -8, scale: 0.98 }}
            transition={reduce ? motionOff : springs.cardExpand}
            style={{ width: POPOVER_W, height: POPOVER_H, transformOrigin: 'left center' }}
            // Left-anchored: sits just right of the 320px strip.
            className="glass pointer-events-none absolute left-[calc(100%+8px)] top-1/2 z-30 -translate-y-1/2 overflow-hidden rounded-2xl border border-border/60 shadow-xl"
          >
            <div className="flex h-9 items-center gap-2 border-b border-border/60 px-3">
              <SessionFace
                name={session.name}
                status={session.status}
                size={18}
                animate={false}
                className="shrink-0"
              />
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

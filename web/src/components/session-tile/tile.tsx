import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { GitBranch } from 'lucide-react'

import { springs, eases } from '@/lib/springs'
import { MISC } from '@/brand/copy'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useLongPress } from '@/hooks/use-long-press'
import {
  useNavigateMorph,
  vtSessionName,
  supportsViewTransitions,
} from '@/components/view-transitions/morph'
import { StatusDot, STATUS_LABEL } from './status-dot'
import { TailPreview } from './tail-preview'
import { TileError } from './tile-error'
import { QuickPeekModal } from './quick-peek-modal'
import type { TileSession } from './types'

// Idle geometry (px) — must match the header + 6-line tail so the grid slot
// reserves exactly the idle height. The card is absolutely positioned inside
// that slot, so its hover-growth (tail 6→14) overflows downward over the next
// row WITHOUT reflowing the grid (Codex #8: container-only morph, not canvas).
const HEADER_H = 12 + 32 + 16 + 4 // pt-3 + title row + meta row + mt-1
const TAIL_LINE_H = 14
const TAIL_PAD = 8
const IDLE_LINES = 6
const HOVER_LINES = 14
const IDLE_H = HEADER_H + IDLE_LINES * TAIL_LINE_H + TAIL_PAD // 156

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

/** Animated status border overlay (§4.3). Active = amber pulse 1.6s, Waiting =
 *  blue pulse 2.2s, Error = static calm orange. Reduce Motion → static
 *  full-opacity border (no pulse). Lives on its own inset overlay so it never
 *  competes with the card's hover-scale transform. */
function StatusBorder({
  status,
  reduce,
}: {
  status: TileSession['status']
  reduce: boolean | null
}) {
  let token: string | null = null
  let duration = 1.6
  if (status === 'active' || status === 'starting') token = '--status-active'
  else if (status === 'waiting') {
    token = '--status-waiting'
    duration = 2.2
  } else if (status === 'error') token = '--status-error'

  if (!token) return null

  const isStatic = reduce || status === 'error'
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-xl"
      animate={
        isStatic
          ? { boxShadow: `inset 0 0 0 1.5px hsl(var(${token}) / 0.9)` }
          : {
              boxShadow: [
                `inset 0 0 0 1.5px hsl(var(${token}) / 0.55)`,
                `inset 0 0 0 1.5px hsl(var(${token}) / 0)`,
              ],
            }
      }
      transition={
        isStatic
          ? { duration: 0 }
          : { repeat: Infinity, duration, ease: eases.inOut }
      }
    />
  )
}

export interface SessionTileProps {
  session: TileSession
  onReattach?: (name: string) => void
  onRemove?: (name: string) => void
}

/** The hero surface (§4.3). One tile = one agent: title (Claude chat summary),
 *  status, live tail-preview, hover-peek (desktop) / long-press quick-peek
 *  (mobile), click → focus with a View Transition. Shared verbatim by the
 *  overview grid (M12) and the focus session-strip (M14) — single source, no
 *  per-tile polling (the tail comes from the SSE `sessions` payload). */
export function SessionTile({ session, onReattach, onRemove }: SessionTileProps) {
  const reduce = useReducedMotion()
  const fine = useMediaQuery('(pointer: fine)')
  const coarse = useMediaQuery('(pointer: coarse)')
  const navigateMorph = useNavigateMorph()
  const [hovered, setHovered] = React.useState(false)
  const [peekOpen, setPeekOpen] = React.useState(false)
  const prevStatus = React.useRef(session.status)

  const goFocus = React.useCallback(
    () => navigateMorph(`/focus/${session.name}`),
    [navigateMorph, session.name],
  )

  // One-shot haptic on transition into "waiting" (§4.3), debounced via ref so a
  // re-render with the same status never re-fires. iOS Safari has no
  // `navigator.vibrate` → the blue pulse + pill are the visible fallback.
  React.useEffect(() => {
    if (session.status === 'waiting' && prevStatus.current !== 'waiting') {
      if ('vibrate' in navigator) navigator.vibrate?.(8)
    }
    prevStatus.current = session.status
  }, [session.status])

  const longPress = useLongPress({
    onLongPress: () => setPeekOpen(true),
    onClick: goFocus,
  })

  // A MISSING tmux backing is the only hard error; an "error" *status* agent is
  // still a normal, navigable tile (calm orange border via <StatusBorder>).
  if (session.missing) {
    return (
      <div className="relative" style={{ height: IDLE_H }}>
        <TileError
          session={session}
          onReattach={onReattach}
          onRemove={onRemove}
          className="absolute inset-x-0 top-0"
        />
      </div>
    )
  }

  const title = session.task_summary || session.name
  const expanded = hovered && fine && !reduce
  const tokens =
    typeof session.tokens === 'number' ? formatTokens(session.tokens) : null

  return (
    // The slot reserves the idle height; the card floats inside it so hover
    // growth never reflows neighbours.
    <div className="relative" style={{ height: IDLE_H }}>
      <motion.div
        role="button"
        tabIndex={0}
        aria-label={`${title} — ${STATUS_LABEL[session.status]}`}
        onClick={fine ? goFocus : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            goFocus()
          }
        }}
        {...(coarse ? longPress : null)}
        onHoverStart={() => setHovered(true)}
        onHoverEnd={() => setHovered(false)}
        whileHover={
          fine && !reduce
            ? {
                scale: 1.06,
                zIndex: 10,
                boxShadow: '0 12px 36px -8px rgba(0,0,0,0.18)',
              }
            : undefined
        }
        whileTap={
          reduce
            ? undefined
            : { scale: 0.96, transition: { duration: 0.1, ease: eases.out } }
        }
        transition={springs.tileHover}
        style={
          supportsViewTransitions
            ? { viewTransitionName: vtSessionName(session.name) }
            : undefined
        }
        className="absolute inset-x-0 top-0 flex cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card pt-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <StatusBorder status={session.status} reduce={reduce} />

        {/* Title row (32px) + meta row (16px) */}
        <div className="px-3">
          <div className="flex h-8 items-start gap-2">
            <span className="line-clamp-1 flex-1 text-sm font-medium leading-tight">
              {title}
            </span>
            {session.status === 'waiting' && (
              <span className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
                {MISC.needsInputPill}
              </span>
            )}
            <StatusDot status={session.status} className="mt-1" />
          </div>
          <div className="flex h-4 items-center gap-2 text-xs text-muted-foreground">
            {tokens && <span className="shrink-0">{tokens} tokens</span>}
            {session.branch && (
              <span className="flex min-w-0 items-center gap-1">
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{session.branch}</span>
              </span>
            )}
          </div>
        </div>

        <TailPreview
          lines={session.preview_lines}
          visibleLines={expanded ? HOVER_LINES : IDLE_LINES}
          className="mt-1"
        />
      </motion.div>

      {coarse && (
        <QuickPeekModal
          session={session}
          open={peekOpen}
          onOpenChange={setPeekOpen}
        />
      )}
    </div>
  )
}

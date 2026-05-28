import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { flushSync } from 'react-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { GitBranch } from 'lucide-react'

import { springs } from '@/lib/springs'
import { MISC } from '@/brand/copy'
import { StatusDot, STATUS_LABEL } from './status-dot'
import { HostBadge } from './host-badge'
import { Kbd } from '@/components/ui/kbd'
import { useJumpIndex } from './jump-index-context'
import type { TileSession } from './types'
import { sessionTitle } from '@/lib/api'

/** View Transition navigate (mirrors the tile's, kept local so this row is
 *  self-contained until M23a ships the canonical `<MorphLink>`). Morphs into the
 *  focus header on Chromium; plain navigate elsewhere. */
function useNavigateMorph() {
  const navigate = useNavigate()
  return React.useCallback(
    (to: string) => {
      const doc = document as Document & {
        startViewTransition?: (cb: () => void) => void
      }
      if (doc.startViewTransition) {
        doc.startViewTransition(() => flushSync(() => navigate(to)))
      } else {
        navigate(to)
      }
    },
    [navigate],
  )
}

function relativeTime(updatedAt?: string): string {
  if (!updatedAt) return ''
  const then = Date.parse(updatedAt)
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export interface SessionRowProps {
  session: TileSession
}

/** Compact list row (§4.2 `<SessionRow>`). The list-view counterpart of the
 *  hero tile: status dot + title + branch + last-activity, click → focus. Shares
 *  the same `TileSession` data source as the tile (single source of truth) — no
 *  per-row polling. The overview wraps it in `<motion.div layout layoutId>` so
 *  the tile↔row view toggle morphs each session smoothly. */
export function SessionRow({ session }: SessionRowProps) {
  const reduce = useReducedMotion()
  const navigateMorph = useNavigateMorph()
  const title = sessionTitle(session)
  const when = relativeTime(session.updated_at)
  const jumpIndex = useJumpIndex(session.name)

  const goFocus = React.useCallback(
    () => navigateMorph(`/focus/${session.name}`),
    [navigateMorph, session.name],
  )

  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label={`${title} — ${STATUS_LABEL[session.status]}`}
      onClick={goFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          goFocus()
        }
      }}
      whileTap={reduce ? undefined : { scale: 0.99 }}
      transition={springs.buttonPress}
      className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <StatusDot status={session.status} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium leading-tight">
          {title}
        </span>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">{STATUS_LABEL[session.status]}</span>
          {session.branch && (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">{session.branch}</span>
            </span>
          )}
        </div>
      </div>
      {/* ⌘N / Ctrl+N shortcut hint — leftmost in the right-cluster so the
          existing badges/pills/timestamp keep their order. Hidden on touch /
          narrow viewports (no shortcuts there). */}
      {jumpIndex && jumpIndex <= 9 && (
        <Kbd
          combo={`mod+${jumpIndex}`}
          variant="muted"
          className="hidden shrink-0 md:inline-flex"
        />
      )}
      {/* Remote-host badge (RT9). Small globe + truncated host name; only
          renders when the session has a `host_id`. Muted on purpose so the
          row's status dot + waiting pill stay the primary signals. */}
      {typeof session.host_id === 'number' && (
        <HostBadge hostId={session.host_id} />
      )}
      {session.status === 'waiting' && (
        <span className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
          {MISC.needsInputPill}
        </span>
      )}
      {when && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {when}
        </span>
      )}
    </motion.div>
  )
}

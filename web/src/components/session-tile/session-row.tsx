/**
 * `<SessionRow>` — the overview's list row.
 * ─────────────────────────────────────────────────────────────────────────────
 * After fase B2 this is a thin INTERACTION wrapper: click → focus (with the
 * view-transition morph), keyboard activation, the ⌘N chip, the host badge and
 * the needs-input pill. Everything that is *drawn* — the face, the name, the
 * secondary line, the right-pinned time, the selection tint, the hover speed —
 * is delegated to `<RosterRow density="list">`, the primitive B0 shipped and
 * nothing mounted.
 *
 * Why the delegation is worth it: the overview list, the focus strip and every
 * picker were three separately-maintained rows that had already drifted into
 * three different products (three status treatments, three name sizes, three
 * ideas of what a row shows). They are the same OBJECT. One primitive at three
 * densities is the fix, and the fact ladder (`lib/fact-ladder.ts`) is the
 * written record of which facts each density carries.
 *
 * Facts at `list` tier 1, per the ladder: mark · attention · name · statusLabel
 * · branch · time · ⌘N · host badge · error badge. The preview line arrives at
 * tier 2, and it is the session's OWN last line — A5's `chat_tail`, which is
 * present only while a chat store exists. When there is none the row keeps the
 * status word rather than faking a line the session never said; it never falls
 * back to the ANSI tail, because a terminal frame collapsed to one line reads as
 * noise at 13px.
 */
import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { GitBranch } from 'lucide-react'

import { springs } from '@/lib/springs'
import { useNavigateMorph } from '@/components/view-transitions/morph'
import { MISC } from '@/brand/copy'
import { markStateFor } from '@/lib/mark-status'
import { hasFact, type Tier } from '@/lib/fact-ladder'
import { usePin } from '@/hooks/use-roster-marks'
import { useRowAttention } from '@/hooks/use-attention'
import { RosterRow } from '@/components/chat/ui'
import { SessionFace } from '@/components/roster/session-face'
import { STATUS_LABEL } from './status-dot'
import { HostBadge } from './host-badge'
import { ErrorBadge } from './activity-status'
import { Kbd } from '@/components/ui/kbd'
import { useJumpIndex } from './jump-index-context'
import type { TileSession } from './types'
import { sessionTitle } from '@/lib/api'

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
  /** This row needs you — the attention tier's `needs` (fase B2 T5). */
  attention?: boolean
  /** The overview's density tier. Drives the FACT LADDER, not the geometry:
   *  tier 2 adds the preview line, tier 3 tokens, tier 4 tag chips. Defaults to
   *  1 so a picker/sheet call site is unchanged. */
  sizeTier?: Tier
}

/** Compact list row. The list-view counterpart of the hero tile; shares the same
 *  `TileSession` data source (single source of truth) — no per-row polling. The
 *  overview wraps it in `<motion.div layout layoutId>` so the tile↔row view
 *  toggle morphs each session smoothly. */
export function SessionRow({ session, attention, sizeTier = 1 }: SessionRowProps) {
  const reduce = useReducedMotion()
  const navigateMorph = useNavigateMorph()
  const title = sessionTitle(session)
  const when = relativeTime(session.updated_at)
  const jumpIndex = useJumpIndex(session.name)
  const pin = usePin(session.name)
  const rowAttention = useRowAttention(session)
  const showAttention = attention ?? rowAttention.dot

  const goFocus = React.useCallback(
    () => navigateMorph(`/focus/${session.name}`),
    [navigateMorph, session.name],
  )

  // The preview, at the ladder's tier 2 and up: the session's own last line.
  // `chat_tail` exists only while a chat store does (it is not roster-wide — see
  // `lib/attention-tiers.ts`), so this is `undefined` for most rows and the
  // status word below keeps the slot.
  const preview =
    hasFact('list', sizeTier, 'preview')
      ? session.chat_tail?.agent?.trim() || session.chat_tail?.user?.trim() || undefined
      : undefined

  // The secondary line at tier 1: the status word plus the branch, which is what
  // this row has always shown under the title. The ladder keeps both.
  const meta = (
    <span className="flex items-center gap-2">
      {hasFact('list', sizeTier, 'statusLabel') && (
        <span className="shrink-0">{STATUS_LABEL[session.status]}</span>
      )}
      {hasFact('list', sizeTier, 'branch') && session.branch && (
        <span className="inline-flex min-w-0 items-center gap-1">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{session.branch}</span>
        </span>
      )}
      {/* Tokens at tier 3, tag chips at tier 4 — the ladder's own rungs. The
          `tags` column has been on the wire since forever with nothing
          rendering it (fase B2 T7 gives it an editor). */}
      {hasFact('list', sizeTier, 'tokens') && typeof session.tokens === 'number' && (
        <span className="shrink-0 tabular-nums">{session.tokens} tokens</span>
      )}
      {hasFact('list', sizeTier, 'tags') &&
        session.tags?.slice(0, 3).map((tag) => (
          <span
            key={tag}
            className="shrink-0 rounded-full bg-fill-soft px-1.5 py-0.5 text-[10px] leading-none text-ink-2"
          >
            {tag}
          </span>
        ))}
    </span>
  )

  const trailing = (
    <>
      {/* ⌘N / Ctrl+N shortcut hint — leftmost in the right cluster so the
          badges/pills/timestamp keep their order. Hidden on touch / narrow
          viewports (no shortcuts there). */}
      {jumpIndex && jumpIndex <= 9 && (
        <Kbd combo={`mod+${jumpIndex}`} variant="muted" className="hidden shrink-0 md:inline-flex" />
      )}
      {/* Remote-host badge — only when the session has a `host_id`. Muted on
          purpose so the face and the needs-input pill stay the primary signals. */}
      {typeof session.host_id === 'number' && <HostBadge hostId={session.host_id} />}
      {/* The blocked-agent badge. `session.error` is a FIELD, not a status —
          the list row could not show it before B2. */}
      {session.error && <ErrorBadge error={session.error} />}
      {session.status === 'waiting' && (
        <span className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
          {MISC.needsInputPill}
        </span>
      )}
    </>
  )

  return (
    <motion.div
      whileTap={reduce ? undefined : { scale: 0.99 }}
      transition={springs.buttonPress}
      className="cursor-pointer"
    >
      <RosterRow
        seed={session.name}
        pin={pin}
        name={title}
        density="list"
        // `SessionFace` (not the primitive's own mark) so the kill switch —
        // `localStorage['supermux:roster-marks'] = '0'` — falls back to the
        // pre-B2 StatusDot in this row's own footprint.
        leading={
          <SessionFace name={session.name} status={session.status} size={40} className="shrink-0" />
        }
        state={markStateFor(session.status)}
        attention={showAttention}
        preview={preview}
        meta={meta}
        trailing={trailing}
        timestamp={when || undefined}
        ariaLabel={`${title} — ${STATUS_LABEL[session.status]}`}
        dataVr="session-row"
        onClick={goFocus}
        className="border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </motion.div>
  )
}

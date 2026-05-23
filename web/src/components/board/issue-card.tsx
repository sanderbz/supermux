import * as React from 'react'
import {
  AlertCircle,
  Bot,
  Calendar,
  Maximize2,
  MessageSquare,
  RotateCcw,
  Send,
  User,
} from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { type BoardIssue } from '@/lib/api'
import { useLiveSession } from '@/hooks/use-board'
import { useSendToAgent } from '@/hooks/use-send-to-agent'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useToast } from '@/components/ui/use-toast'
import { useNavigateMorph } from '@/components/view-transitions/morph'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import { TailPreview } from '@/components/session-tile/tail-preview'

/** A human-readable, short due-date label ("May 24", "Today", "Overdue"). */
function dueLabel(due: string): { text: string; overdue: boolean } {
  // `due` is `YYYY-MM-DD`. Compare against local midnight.
  const parts = due.split('-').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return { text: due, overdue: false }
  }
  const [y, m, d] = parts
  const target = new Date(y, m - 1, d)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000)
  const text =
    diffDays === 0
      ? 'Today'
      : diffDays === 1
        ? 'Tomorrow'
        : target.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })
  return { text, overdue: diffDays < 0 }
}

/** Compact acceptance progress glyph — "▣▣▢ 2/3" (§C.4.6). Renders one filled
 *  square per done item, one hollow square per remaining, then the count. Caps
 *  the drawn squares at a small ceiling so a long checklist stays a glance, not
 *  a wall. */
function AcceptancePill({ acceptance }: { acceptance: BoardIssue['acceptance'] }) {
  const total = acceptance.length
  const done = acceptance.reduce((n, a) => n + (a.done ? 1 : 0), 0)
  const allDone = done === total && total > 0
  // Draw at most this many squares; collapse to just the count beyond it.
  const MAX_SQUARES = 6
  const squares =
    total <= MAX_SQUARES
      ? acceptance.map((a) => !!a.done)
      : null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums',
        allDone
          ? 'bg-status-ready/15 text-status-ready'
          : 'bg-muted text-muted-foreground',
      )}
      title={`${done} of ${total} acceptance items done`}
    >
      {squares && (
        <span aria-hidden className="font-mono leading-none tracking-tight">
          {squares.map((d) => (d ? '▣' : '▢')).join('')}
        </span>
      )}
      <span>
        {done}/{total}
      </span>
    </span>
  )
}

export interface IssueCardProps {
  issue: BoardIssue
  /** Open the detail sheet for editing. */
  onOpen: (issue: BoardIssue) => void
  /** True while this card is the drag source (dims the placeholder slot). */
  isDragging?: boolean
  /** Pointer-down begins a drag (the board owns the drag session). */
  onDragStart: (issue: BoardIssue, e: React.PointerEvent) => void
}

/**
 * A board card — alive like an overview tile (§C.4).
 *
 * Borrows the overview's vocabulary: the LINKED session's real `StatusDot`
 * (joined to the shared SSE `status`/`sessions` stream by `issue.session`), a
 * hover tail-peek off the same `last_capture` the tiles render, view-transition
 * morph into focus mode, plus board-native signals (acceptance progress, the
 * R1 needs-review / awaiting-input badges, the R2 stale-link reassign badge).
 *
 * Affordances are HOVER-revealed (desktop, fine pointer) — no menu, no extra
 * clicks. Tap opens the detail sheet; press-and-drag (pointer) hands off to the
 * board's cross-column drag controller with spring physics.
 *
 * iOS-native finish: 10px continuous-corner radius, ≥44pt tap targets, scale
 * press feedback (no `transition: all`), sentence-case copy, reduced-motion safe.
 */
export function IssueCard({
  issue,
  onOpen,
  isDragging,
  onDragStart,
}: IssueCardProps) {
  const reduce = useReducedMotion()
  const fine = useMediaQuery('(pointer: fine)')
  const { toast } = useToast()
  const { sendToAgent } = useSendToAgent()
  const navigateMorph = useNavigateMorph()

  const due = issue.due ? dueLabel(issue.due) : null
  const OwnerIcon = issue.owner_type === 'agent' ? Bot : User

  // Join the card to the LINKED session's live status + tail by name (U1). Reads
  // the shared `['sessions']` cache the overview tiles render from — live status
  // arrives over the already-open SSE stream, no new connection per card.
  const live = useLiveSession(issue.session)
  // The link is "confidently live" only when the server says the session row
  // still exists + isn't archived (R2 `session_live`) AND we have its live row.
  const linkLive = !!issue.session && issue.session_live
  const liveStatus = linkLive ? live?.status : undefined
  // A card whose session was archived/deleted: show "reassign?" instead of a
  // wrong live dot (R2). `session_live` is false but a session is still linked.
  const staleLink = !!issue.session && !issue.session_live

  const [hovered, setHovered] = React.useState(false)
  const [sending, setSending] = React.useState(false)

  // Tail-peek shows on hover (fine pointer) for a card whose session is live and
  // has captured output — the same source as the overview `TailPreview`. Zero
  // extra clicks (hover-reveal, per the no-extra-clicks preference). Reduced
  // motion still shows it (it's information, not motion) — TailPreview itself
  // honours reduce for its own line transitions.
  const tailLines = linkLive ? (live?.preview_lines ?? []) : []
  const showTail = hovered && fine && linkLive && tailLines.length > 0
  // Hover-revealed inline actions appear for any fine-pointer hover.
  const showActions = hovered && fine

  const goFocus = React.useCallback(() => {
    if (!issue.session) return
    navigateMorph(`/focus/${issue.session}`)
  }, [navigateMorph, issue.session])

  // ── Send to agent (claim + deliver) → toast with Undo via the steer_id ──────
  // Delegates the whole claim→toast→Undo(unsend) flow to the shared hook
  // (one source of truth across card / sheet / drag / ⌘K); the card only owns
  // its `sending` latch and its own copy for the edge cases.
  const onSend = React.useCallback(
    async (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation()
      const session = issue.session
      if (!session || sending) return
      setSending(true)
      try {
        await sendToAgent({
          id: issue.id,
          session,
          // A delivered send reads "Sent to <session>" (with Undo when there's a
          // steer to retract); the rare non-delivered outcome still confirms the
          // assignment ("Assigned to <session>"). Both use the `active` tone.
          isSent: (r) => r.delivered,
          sentMessage: () => `Sent to ${session}`,
          sentDuration: 6000,
          claimedMessage: () => `Assigned to ${session}`,
          claimedTone: 'active',
          onUndoError: () => {
            // The agent already consumed it (0 cleared) or a transient failure —
            // non-fatal; the work is on its way.
            toast({
              message: 'Already picked up — can’t undo',
              tone: 'default',
            })
          },
          onError: (err) => {
            toast({
              message:
                err instanceof Error ? err.message : 'Couldn’t send to the agent',
              tone: 'error',
            })
          },
        })
      } finally {
        setSending(false)
      }
    },
    [issue.id, issue.session, sending, sendToAgent, toast],
  )

  // The most-recent comment (newest last in the array, mirroring the server's
  // `id ASC` order) — a one-line "who said what" so the card reflects progress.
  const lastComment =
    issue.comments.length > 0
      ? issue.comments[issue.comments.length - 1]
      : null
  const lastCommentWho = lastComment
    ? lastComment.author.startsWith('agent:')
      ? lastComment.author.slice('agent:'.length)
      : lastComment.author === 'user'
        ? 'You'
        : lastComment.author
    : null

  const hasMetaRow =
    !!issue.session || issue.tags.length > 0 || !!due

  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label={issue.title}
      layout={!reduce}
      layoutId={reduce ? undefined : `issue-${issue.id}`}
      transition={springs.smooth}
      whileTap={reduce ? undefined : { scale: 0.97 }}
      data-issue-id={issue.id}
      onPointerDown={(e) => {
        // Only primary button / touch starts a drag; let the click fall through
        // to onClick for taps (the board cancels the drag if movement < threshold).
        if (e.button !== undefined && e.button !== 0) return
        onDragStart(issue, e)
      }}
      onClick={() => onOpen(issue)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(issue)
        }
      }}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      className={cn(
        'group relative flex min-h-[44px] w-full cursor-pointer touch-none select-none flex-col gap-2 rounded-[10px] border border-border bg-background/80 p-3 text-left shadow-sm',
        'transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isDragging && 'opacity-40',
      )}
    >
      <div className="flex items-start gap-2">
        <OwnerIcon
          aria-hidden
          className={cn(
            'mt-0.5 size-4 shrink-0',
            issue.owner_type === 'agent'
              ? 'text-primary'
              : 'text-muted-foreground',
          )}
        />
        <span className="line-clamp-3 flex-1 text-sm font-medium leading-snug">
          {issue.title}
        </span>

        {/* Live status dot (top-right) — the linked session's real state, joined
            from the shared SSE stream. Swaps to the hover-revealed action
            cluster on hover so the resting card stays calm. */}
        <AnimatePresence mode="wait" initial={false}>
          {showActions ? (
            <motion.div
              key="actions"
              initial={reduce ? false : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
              transition={reduce ? { duration: 0 } : springs.snappy}
              className="-mr-1 -mt-1 flex shrink-0 items-center gap-0.5"
            >
              {/* Send to agent — claim + deliver. Only meaningful for an
                  agent-owned card with a (live) session link. */}
              {issue.owner_type === 'agent' && issue.session && (
                <button
                  type="button"
                  aria-label={`Send to ${issue.session}`}
                  title={`Send to ${issue.session}`}
                  disabled={sending}
                  onClick={onSend}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onSend(e)
                  }}
                  className="grid size-11 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg]:size-4"
                >
                  {sending ? (
                    <RotateCcw aria-hidden className="animate-spin" />
                  ) : (
                    <Send aria-hidden />
                  )}
                </button>
              )}
              {/* Open session — view-transition morph straight into focus mode,
                  reusing the overview's tile↔focus morph vocabulary. */}
              {issue.session && (
                <button
                  type="button"
                  aria-label={`Open session ${issue.session}`}
                  title={`Open ${issue.session}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    goFocus()
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation()
                      goFocus()
                    }
                  }}
                  className="grid size-11 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
                >
                  <Maximize2 aria-hidden />
                </button>
              )}
            </motion.div>
          ) : liveStatus ? (
            <motion.span
              key="status-dot"
              initial={false}
              animate={{ opacity: 1 }}
              className="mt-0.5 shrink-0"
              title={STATUS_LABEL[liveStatus]}
            >
              <StatusDot status={liveStatus} />
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>

      {/* R1/R2 status badges — calm, sentence-case. needs-review (a glance:
          "human, look") + needs-you (awaiting input) + the stale-link reassign
          prompt. Only render when the relevant flag is set. */}
      {(issue.needs_review || issue.awaiting_input || staleLink) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.awaiting_input && (
            <span className="inline-flex items-center gap-1 rounded-full bg-status-waiting/15 px-2 py-0.5 text-[11px] font-semibold text-status-waiting">
              <span className="size-1.5 shrink-0 rounded-full bg-status-waiting" />
              Needs you
            </span>
          )}
          {issue.needs_review && (
            <span className="inline-flex items-center gap-1 rounded-full bg-status-ready/15 px-2 py-0.5 text-[11px] font-medium text-status-ready">
              <span className="size-1.5 shrink-0 rounded-full bg-status-ready" />
              Needs review
            </span>
          )}
          {staleLink && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              <AlertCircle aria-hidden className="size-3" />
              Session archived — reassign?
            </span>
          )}
        </div>
      )}

      {hasMetaRow && (
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.session && (
            <span
              className={cn(
                'inline-flex max-w-[140px] items-center gap-1 truncate rounded-full px-2 py-0.5 text-[11px] font-medium',
                staleLink
                  ? 'bg-muted text-muted-foreground line-through'
                  : 'bg-primary/15 text-primary',
              )}
            >
              {/* The live dot lives top-right; this pill carries a small static
                  swatch (or a muted dot for a stale link) so the pill reads as a
                  session chip without competing with the live indicator. */}
              {liveStatus ? (
                <StatusDot status={liveStatus} className="!size-1.5" />
              ) : (
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    staleLink ? 'bg-muted-foreground' : 'bg-primary',
                  )}
                />
              )}
              <span className="truncate">{issue.session}</span>
            </span>
          )}
          {issue.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            >
              {tag}
            </span>
          ))}
          {due && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                due.overdue
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              <Calendar aria-hidden className="size-3" />
              {due.text}
            </span>
          )}
        </div>
      )}

      {/* Acceptance progress + last comment — board-native progress at a glance. */}
      {(issue.acceptance.length > 0 || lastComment) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {issue.acceptance.length > 0 && (
            <AcceptancePill acceptance={issue.acceptance} />
          )}
          {lastComment && (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1 text-[11px] text-muted-foreground">
              <MessageSquare aria-hidden className="size-3 shrink-0" />
              <span className="truncate">
                <span className="font-medium">{lastCommentWho}:</span>{' '}
                {lastComment.body}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Hover tail-peek (desktop) — last ~3 lines of the live session's output,
          same source as the overview TailPreview. Springs open on hover; never
          shown for an archived/stale link (no confidently-live tail). */}
      <AnimatePresence initial={false}>
        {showTail && (
          <motion.div
            key="tail-peek"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? undefined : { opacity: 0 }}
            transition={reduce ? { duration: 0 } : springs.snappy}
            className="-mx-3 -mb-3 mt-1 overflow-hidden rounded-b-[10px] border-t border-border/60 bg-muted/30"
          >
            <TailPreview
              lines={tailLines}
              ansiLines={linkLive ? live?.preview_ansi : undefined}
              visibleLines={3}
              className="py-2"
            />
          </motion.div>
        )}
      </AnimatePresence>

      <span className="font-mono text-[10px] tracking-wide text-muted-foreground/70">
        {issue.id}
      </span>
    </motion.div>
  )
}

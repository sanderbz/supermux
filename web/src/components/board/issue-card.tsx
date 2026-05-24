import * as React from 'react'
import {
  AlertCircle,
  Bot,
  Calendar,
  GitPullRequest,
  Maximize2,
  MessageSquare,
  Play,
  RotateCcw,
  Square,
  User,
} from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { focusApi, type BoardIssue } from '@/lib/api'
import { useBoard, useLiveSession } from '@/hooks/use-board'
import { useStartAgent } from '@/hooks/use-send-to-agent'
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
  /** @dnd-kit `useSortable` attributes (role / tabIndex / aria-*) spread on the
   *  card root. Narrow by design — `DraggableAttributes` carries no native
   *  `onDrag`, so it won't collide with framer-motion's own drag gesture typing. */
  dragAttributes?: DraggableAttributes
  /** @dnd-kit `useSortable` listeners (pointer/touch/keyboard drag activation)
   *  spread on the card root. The board's sensors (PointerSensor distance +
   *  TouchSensor long-press) decide when a drag actually starts, so a tap still
   *  opens the sheet and a vertical swipe still scrolls the column. */
  dragListeners?: DraggableSyntheticListeners
}

/**
 * A board card — alive like an overview tile (§C.4), now STATE-AWARE.
 *
 * The primary action is chosen by the issue's **status**, not by `owner_type`
 * (board-rework spec). Starting an agent on an issue is what *makes* it
 * agent-owned, so the affordances never gate on `owner_type` and the card never
 * shows the internal "claim" verb:
 *
 *   - `todo` / `backlog` → ▶ Start agent (the primary action). One tap when the
 *     issue already has a live linked session; otherwise it opens the detail
 *     sheet so the start picker can attach-or-spawn.
 *   - `doing` → it's the agent's live face. Primary Open (morph to focus);
 *     secondary, hover-revealed Stop (confirm-on-tap, no accidental stops).
 *   - terminal (review / done / any other column) → calm. A subtle PR/commit
 *     indicator when there are links; heavier actions route to the sheet.
 *
 * Live signals (the linked session's real `StatusDot`, hover tail-peek,
 * acceptance progress, last comment) are UNGATED from `owner_type` — they show
 * whenever a session is linked, regardless of who owns the issue.
 *
 * Affordances are HOVER-revealed on a fine pointer (desktop) and ALWAYS visible
 * on a coarse pointer (mobile) — no menu, no extra clicks. Tap opens the detail
 * sheet; press-and-drag (pointer) hands off to the board's cross-column drag
 * controller with spring physics.
 *
 * iOS-native finish: 10px continuous-corner radius, ≥44pt tap targets, scale
 * press feedback (no `transition: all`), sentence-case copy, reduced-motion safe.
 */
export function IssueCard({
  issue,
  onOpen,
  isDragging,
  dragAttributes,
  dragListeners,
}: IssueCardProps) {
  const reduce = useReducedMotion()
  const fine = useMediaQuery('(pointer: fine)')
  const { toast } = useToast()
  const { startAgent } = useStartAgent()
  const board = useBoard()
  const navigateMorph = useNavigateMorph()

  const due = issue.due ? dueLabel(issue.due) : null
  const OwnerIcon = issue.owner_type === 'agent' ? Bot : User

  // ── State-aware classification (drives the primary action) ──────────────────
  // `startable` columns are the only places an agent gets started; `doing` is the
  // agent's live face; everything else (review/done/custom) is a calm terminal
  // card. This is what structurally removes the old 409 "claim on doing" bug —
  // the Start affordance simply never renders off a startable column.
  const isStartable = issue.status === 'todo' || issue.status === 'backlog'
  const isDoing = issue.status === 'doing'
  const isTerminal = !isStartable && !isDoing

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
  const [busy, setBusy] = React.useState(false)
  // Stop is a two-tap confirm (no accidental stops). The first tap arms it; a
  // second tap within the window actually stops. Leaving the card disarms it.
  const [confirmStop, setConfirmStop] = React.useState(false)

  // Tail-peek shows on hover (fine pointer) for a card whose session is live and
  // has captured output — the same source as the overview `TailPreview`. Zero
  // extra clicks (hover-reveal, per the no-extra-clicks preference). Reduced
  // motion still shows it (it's information, not motion) — TailPreview itself
  // honours reduce for its own line transitions.
  const tailLines = linkLive ? (live?.preview_lines ?? []) : []
  const showTail = hovered && fine && linkLive && tailLines.length > 0
  // Hover-revealed inline actions appear for any fine-pointer hover; on a coarse
  // pointer (mobile) the primary action is ALWAYS shown/tappable (not hover-only).
  const showActions = (hovered && fine) || !fine

  // A live linked session we can confidently start one-tap against.
  const hasLiveSession = !!issue.session && issue.session_live

  const goFocus = React.useCallback(() => {
    if (!issue.session) return
    navigateMorph(`/focus/${issue.session}`)
  }, [navigateMorph, issue.session])

  // ── Start agent (status-aware) → optimistic slide to doing + Undo toast ─────
  // On a `todo`/`backlog` card with a confidently-live linked session, one tap
  // starts + delivers via the shared `useStartAgent` flow (optimistic
  // `board.startIssue` mutation slides the card to `doing`, rolls back on a 409).
  // Plain copy only — never the internal "claim" verb. Without a live session,
  // the detail sheet's start picker owns attach-or-spawn (don't build a second
  // picker on the card).
  const onStart = React.useCallback(
    async (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation()
      if (busy) return
      const session = issue.session
      if (!hasLiveSession || !session) {
        // No live session to attach: let the detail sheet pick/attach/spawn.
        onOpen(issue)
        return
      }
      setBusy(true)
      try {
        await startAgent({
          id: issue.id,
          session,
          // Optimistic: slide the card to `doing` immediately; roll back on 409.
          start: (a) => board.startIssue(a),
          sentMessage: () => `Sent to ${session}`,
          sentDuration: 6000,
          assignedMessage: () => `Agent started on ${session}`,
          assignedTone: 'active',
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
                err instanceof Error ? err.message : 'Couldn’t start the agent',
              tone: 'error',
            })
          },
        })
      } finally {
        setBusy(false)
      }
    },
    [issue, hasLiveSession, busy, startAgent, board, toast, onOpen],
  )

  // ── Stop the working agent (doing card) — safe, two-tap confirm ─────────────
  // First tap arms the confirm (the icon turns into a clear "stop?" affordance);
  // a second tap stops the session via the same control-plane endpoint the focus
  // dock uses. A non-fatal failure is surfaced as a toast.
  const onStop = React.useCallback(
    async (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation()
      const session = issue.session
      if (!session || busy) return
      if (!confirmStop) {
        setConfirmStop(true)
        return
      }
      setConfirmStop(false)
      setBusy(true)
      try {
        await focusApi.stopSession(session)
        toast({ message: `Stopped ${session}`, tone: 'default' })
      } catch (err) {
        toast({
          message:
            err instanceof Error ? err.message : 'Couldn’t stop the agent',
          tone: 'error',
        })
      } finally {
        setBusy(false)
      }
    },
    [issue.session, busy, confirmStop, toast],
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

  // A calm PR/commit indicator for terminal cards (review/done) that shipped
  // something — a glance, not an action. Tapping the card opens the sheet where
  // the full links section lives.
  const linkCount = issue.links.length
  const terminalLinkHint = isTerminal && linkCount > 0

  return (
    <motion.div
      // dnd-kit wiring: the spread attributes/listeners arm the drag via the
      // board's sensors (PointerSensor distance / TouchSensor long-press). They
      // come FIRST so the card's own `onClick` (open sheet), `onKeyDown`, `role`
      // and `tabIndex` below win — keeping tap-to-open and keyboard-open intact
      // (the whole card is the grab target; there's no separate drag handle).
      // The sortable transform + ref live on the wrapper in <SortableIssueCard>
      // so they don't fight framer-motion's `whileTap` / `layoutId` transforms.
      {...dragAttributes}
      {...dragListeners}
      role="button"
      tabIndex={0}
      aria-label={issue.title}
      layout={!reduce}
      layoutId={reduce ? undefined : `issue-${issue.id}`}
      transition={springs.smooth}
      whileTap={reduce ? undefined : { scale: 0.97 }}
      data-issue-id={issue.id}
      onClick={() => onOpen(issue)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(issue)
        }
      }}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => {
        setHovered(false)
        // Leaving the card disarms a pending Stop confirm.
        setConfirmStop(false)
      }}
      className={cn(
        // No `touch-none` here: the column owns `touch-pan-y` so a vertical swipe
        // scrolls natively; the TouchSensor's 250ms long-press is what claims a
        // deliberate press as a card drag. Keeping `touch-none` would re-break
        // scroll (the exact bug being fixed).
        'group relative flex min-h-[44px] w-full cursor-pointer select-none flex-col gap-2 rounded-[10px] border border-border bg-background/80 p-3 text-left shadow-sm',
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

        {/* Top-right cluster — state-aware. The hover/coarse-pointer action set
            swaps in over the resting live status dot so the calm card stays calm.
            Actions are chosen by STATUS, never by owner_type. */}
        <AnimatePresence mode="wait" initial={false}>
          {showActions && (isStartable || isDoing) ? (
            <motion.div
              key="actions"
              initial={reduce ? false : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
              transition={reduce ? { duration: 0 } : springs.snappy}
              className="-mr-1 -mt-1 flex shrink-0 items-center gap-0.5"
            >
              {/* `todo`/`backlog` → ▶ Start agent (the primary action). One tap
                  attaches the live linked session; with no live session it opens
                  the sheet's start picker (attach-or-spawn). */}
              {isStartable && (
                <button
                  type="button"
                  aria-label="Start agent"
                  title="Start agent"
                  disabled={busy}
                  onClick={onStart}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onStart(e)
                  }}
                  className="grid size-11 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg]:size-4"
                >
                  {busy ? (
                    <RotateCcw aria-hidden className="animate-spin" />
                  ) : (
                    <Play aria-hidden />
                  )}
                </button>
              )}

              {/* `doing` → Open (primary, morph to focus). */}
              {isDoing && issue.session && (
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

              {/* `doing` → Stop (secondary, hover-revealed). Two-tap confirm so a
                  brush never stops a working agent. No Start/Send here. */}
              {isDoing && issue.session && (
                <button
                  type="button"
                  aria-label={confirmStop ? `Confirm stop ${issue.session}` : `Stop ${issue.session}`}
                  title={confirmStop ? 'Tap again to stop' : `Stop ${issue.session}`}
                  disabled={busy}
                  onClick={onStop}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onStop(e)
                  }}
                  className={cn(
                    'grid size-11 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg]:size-4',
                    confirmStop
                      ? 'bg-destructive/15 text-destructive hover:bg-destructive/20'
                      : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                  )}
                >
                  {busy ? (
                    <RotateCcw aria-hidden className="animate-spin" />
                  ) : (
                    <Square aria-hidden className="fill-current" />
                  )}
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
          ) : terminalLinkHint ? (
            <motion.span
              key="link-hint"
              initial={false}
              animate={{ opacity: 1 }}
              className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
              title={`${linkCount} ${linkCount === 1 ? 'link' : 'links'}`}
            >
              <GitPullRequest aria-hidden className="size-3.5" />
              {linkCount > 1 && (
                <span className="tabular-nums">{linkCount}</span>
              )}
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
          shown for an archived/stale link (no confidently-live tail). Ungated
          from owner_type: shows whenever a session is confidently live. */}
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

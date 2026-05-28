import * as React from 'react'
import {
  Calendar,
  Check,
  CornerDownLeft,
  GitPullRequest,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Play,
  Send,
  Trash2,
} from 'lucide-react'
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform } from 'framer-motion'
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { type BoardIssue } from '@/lib/api'
import { useLiveSession } from '@/hooks/use-board'
import { displayLabel } from '@/lib/api/sessions'
import { useMediaQuery } from '@/hooks/use-media-query'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import { TailPreview } from '@/components/session-tile/tail-preview'

/** A human-readable, short due-date label ("May 24", "Today", "Overdue"). */
function dueLabel(due: string): { text: string; overdue: boolean } {
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
        : target.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return { text, overdue: diffDays < 0 }
}

/** Parsed view of a team card's special tags (written by `board_sync.rs`): a
 *  `team:<assignee>` tag → an assignee pill, a `color:<colour>` tag → the card
 *  accent. Both are filtered out of `rest` so they never show as raw chips; every
 *  other tag passes through untouched (ordinary cards stay exactly as today). */
interface ParsedTeamTags {
  assignee: string | null
  color: string | null
  rest: string[]
}
function parseTeamTags(tags: string[]): ParsedTeamTags {
  let assignee: string | null = null
  let color: string | null = null
  const rest: string[] = []
  // Defensive: a malformed card payload could carry a non-array `tags`; iterate
  // an empty list rather than throwing (a single bad card must never blank the
  // board).
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (tag.startsWith('team:')) {
      const v = tag.slice('team:'.length).trim()
      if (v && !assignee) {
        assignee = v
        continue
      }
    } else if (tag.startsWith('color:')) {
      const v = tag.slice('color:'.length).trim()
      if (v && !color) {
        color = v
        continue
      }
    }
    rest.push(tag)
  }
  return { assignee, color, rest }
}

/** The card heading: prefer the trimmed title; else the first non-empty line of
 *  the description (reads AS a title); else a muted id placeholder. */
function displayHeading(issue: BoardIssue): { text: string; muted: boolean } {
  const title = issue.title.trim()
  if (title) return { text: title, muted: false }
  const descLine = issue.desc
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (descLine) return { text: descLine, muted: false }
  return { text: issue.id, muted: true }
}

/** Compact acceptance progress pill — "▣▣▢ 2/3" (§6 BM2). */
function AcceptancePill({ acceptance }: { acceptance: BoardIssue['acceptance'] }) {
  const total = acceptance.length
  const done = acceptance.reduce((n, a) => n + (a.done ? 1 : 0), 0)
  const allDone = done === total && total > 0
  const MAX_SQUARES = 6
  const squares = total <= MAX_SQUARES ? acceptance.map((a) => !!a.done) : null
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

/** The latest "needs your input" question. Prefers the dedicated payload field
 *  (BM1 §4 `latest_question`); falls back to the most-recent agent comment so
 *  the question still shows before the backend ships the field. */
function awaitingQuestion(issue: BoardIssue): string | null {
  if (issue.latest_question && issue.latest_question.trim()) {
    return issue.latest_question.trim()
  }
  for (let i = issue.comments.length - 1; i >= 0; i--) {
    const c = issue.comments[i]
    if (c.author.startsWith('agent:') && c.body.trim()) return c.body.trim()
  }
  return null
}

export interface BoardCardProps {
  issue: BoardIssue
  /** The lane this card lives in (drives the affordances). */
  lane: 'todo' | 'doing' | 'done'
  /** Open the editor sheet/popover (To do cards). */
  onOpen: (issue: BoardIssue) => void
  /** Morph to the focus terminal for the linked session (Doing cards). */
  onFocus: (issue: BoardIssue) => void
  /** ▶ Start the agent on a To do card (spawn-by-default). */
  onStart: (issue: BoardIssue) => void
  /** Send an inline reply into the agent (Doing cards). Rejects on failure. */
  onReply: (issue: BoardIssue, text: string) => Promise<void>
  /** Discard the card (swipe-left / ⋯). The route shows the undo toast. */
  onDiscard: (issue: BoardIssue) => void
  /** True while this card is the drag source (dims the placeholder slot). */
  isDragging?: boolean
  /** True when this card is the one open in the desktop detail pane (lg+). Draws
   *  a calm primary ring so the selection reads at a glance. Meaningless on
   *  mobile (the pane is hidden), so it's only ever set on a fine pointer. */
  isSelected?: boolean
  /** Disable swipe-to-discard while a drag is armed (avoids gesture conflict). */
  draggable?: boolean
  /** Read-through (team) board: the card mirrors the team's on-disk task list,
   *  re-synced every ~3s, so no write affordance can persist. Suppresses Start,
   *  the inline reply composer, Discard, and swipe-to-discard — the card stays a
   *  calm, openable status view. Mirrors how the "All" aggregate reads. */
  readOnly?: boolean
  dragAttributes?: DraggableAttributes
  dragListeners?: DraggableSyntheticListeners
}

const SWIPE_THRESHOLD = 96

/**
 * A board card, redesigned for BM2 (§1, §2). It is ALWAYS an agent task — the
 * affordances are chosen by the LANE:
 *
 *   - **To do** → ▶ Start (spawn-by-default); tap opens the editor.
 *   - **Doing** → the agent's live face: status dot, tail-peek, acceptance pill,
 *     attention states ("Needs your input" amber / "Review?" softer), and the
 *     headline inline reply composer (auto-revealed on needs-input). Open morphs
 *     to the focus terminal for deep work.
 *   - **Done** → calm: a check + any PR/commit link.
 *
 * Swipe-left → discard (with an undo toast, no confirm). A ⋯ menu mirrors
 * Discard + Open for desktop/discoverability.
 *
 * iOS-native finish: 10px continuous-corner radius, ≥44pt tap targets, spring
 * press feedback (no `transition: all`), sentence-case copy, reduced-motion safe.
 */
export function BoardCard({
  issue,
  lane,
  onOpen,
  onFocus,
  onStart,
  onReply,
  onDiscard,
  isDragging,
  isSelected,
  draggable = true,
  readOnly = false,
  dragAttributes,
  dragListeners,
}: BoardCardProps) {
  const reduce = useReducedMotion()
  const fine = useMediaQuery('(pointer: fine)')

  const due = issue.due ? dueLabel(issue.due) : null
  const heading = displayHeading(issue)
  // Team cards carry `team:<assignee>` / `color:<colour>` tags (board_sync.rs).
  // Render those as an assignee pill + accent dot, NOT raw chips; every other
  // tag falls through to the generic chip row unchanged.
  const { assignee, color: accentColor, rest: restTags } = React.useMemo(
    () => parseTeamTags(issue.tags),
    [issue.tags],
  )

  const isTodo = lane === 'todo'
  const isDoing = lane === 'doing'
  const isDone = lane === 'done'

  // Live status + tail of the linked session (shared ['sessions'] cache).
  const live = useLiveSession(issue.session)
  const linkLive = !!issue.session && issue.session_live
  const liveStatus = linkLive ? live?.status : undefined
  const staleLink = !!issue.session && !issue.session_live

  const [hovered, setHovered] = React.useState(false)

  // Attention states (Doing). "Needs your input" is amber + auto-reveals the
  // reply; "Review?" is softer (agent idle without reporting). Otherwise calm.
  const needsInput = isDoing && issue.awaiting_input
  const needsReview = isDoing && issue.needs_review && !issue.awaiting_input
  const question = needsInput ? awaitingQuestion(issue) : null

  // A Done card whose agent is STILL active or waiting is the contradiction to
  // surface: the agent declared the work done but kept running (or got stuck on
  // an error). Without this the card reads as calmly finished. Idle/stopped means
  // the turn actually ended, so no cue then. The server's attention reactions
  // (Review?/Needs-input) only fire for `doing` cards (doing_issue_for_session),
  // so a Done card gets no server-side badge — this client cue is the only
  // on-card signal that a "done" agent is still churning.
  const doneButBusy =
    isDone && (liveStatus === 'active' || liveStatus === 'waiting')

  const tailLines = linkLive ? (live?.preview_lines ?? []) : []
  const showTail = hovered && fine && linkLive && tailLines.length > 0

  // Reply composer: auto-open on needs-input; otherwise reachable via a chip.
  const [replyOpen, setReplyOpen] = React.useState(false)
  const replyExpanded = isDoing && (replyOpen || needsInput)

  const linkCount = issue.links.length

  // ── Swipe-to-discard (touch) ───────────────────────────────────────────────
  // A horizontal drag past the threshold flicks the card off to the left and
  // calls onDiscard. The route shows an undo toast (no confirm dialog). Disabled
  // on a fine pointer (desktop uses the ⋯ menu) and while a card-drag is armed.
  const x = useMotionValue(0)
  const swipeBg = useTransform(x, [-SWIPE_THRESHOLD, 0], [1, 0])
  const swipeEnabled = !fine && draggable && !readOnly
  const [swipedOut, setSwipedOut] = React.useState(false)

  const cardBody = (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label={heading.text}
      layout={!reduce}
      layoutId={reduce ? undefined : `issue-${issue.id}`}
      transition={springs.smooth}
      whileTap={reduce || swipeEnabled ? undefined : { scale: 0.98 }}
      data-issue-id={issue.id}
      {...(swipeEnabled
        ? {
            drag: 'x' as const,
            dragDirectionLock: true,
            dragConstraints: { left: 0, right: 0 },
            dragElastic: { left: 0.7, right: 0 },
            style: { x },
            onDragEnd: (_e: unknown, info: { offset: { x: number } }) => {
              if (info.offset.x < -SWIPE_THRESHOLD) {
                setSwipedOut(true)
                onDiscard(issue)
              }
            },
          }
        : {})}
      onClick={() => {
        // Tap routing (SS-2). Every card — Doing included, on EVERY pointer —
        // opens via `onOpen`: the editor sheet on mobile, the mission-control
        // detail pane on desktop. Previously a Doing-card tap on a coarse
        // pointer morphed straight to the focus terminal, which made it
        // impossible to edit a running task without first navigating away;
        // the user lost board context for what is usually a small edit. The
        // dedicated Maximize2 button on a Doing card (always visible on
        // coarse) is the one-tap terminal affordance, so this change keeps
        // the terminal one tap away while letting the card body always mean
        // "open me to read or edit."
        onOpen(issue)
      }}
      onKeyDown={(e) => {
        // Only the card ITSELF responds to Enter/Space. A keydown bubbling up
        // from a child control (the inline reply textarea, the action buttons)
        // must not trigger card-open — otherwise typing Enter or a space while
        // replying to the agent navigates away.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(issue)
        }
      }}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      className={cn(
        'group relative flex min-h-[44px] w-full cursor-pointer select-none flex-col gap-2 rounded-[10px] border bg-background/80 p-3 text-left shadow-sm',
        'transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        needsInput
          ? 'border-warning/60'
          : needsReview
            ? 'border-warning/35'
            : 'border-border',
        // Selected in the desktop detail pane (lg+) — a calm primary ring. Drawn
        // last so it wins over the resting border; harmless on mobile (the pane
        // is hidden, so `isSelected` is never set there).
        isSelected && 'border-primary/50 ring-2 ring-primary/50',
        // A team card with an accent colour clips its left rail to the rounded
        // corner (the teammate-chip identity-rail pattern).
        accentColor && 'overflow-hidden',
        isDragging && 'opacity-40',
      )}
    >
      {/* Team-member identity accent: a 2px left colour rail = the assignee's
          configured colour (parsed from the `color:<c>` tag). */}
      {accentColor && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-[2px]"
          style={{ backgroundColor: accentColor }}
        />
      )}
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'line-clamp-3 flex-1 text-sm font-medium leading-snug',
            heading.muted && 'font-mono text-muted-foreground',
            isDone && 'text-muted-foreground',
          )}
        >
          {heading.text}
        </span>

        {/* Top-right cluster — lane-aware. */}
        <div
          className="-mr-1 -mt-1 flex shrink-0 items-center gap-0.5"
          // Inner controls must not start a card drag or swipe.
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* To do → ▶ Start (always visible on coarse; hover on fine).
              Suppressed on a read-through team board (can't write back). */}
          {isTodo && !readOnly && (hovered || !fine) && (
            <CardIconButton
              label="Start agent"
              title="Start agent"
              onClick={() => onStart(issue)}
              tone="primary"
            >
              <Play aria-hidden />
            </CardIconButton>
          )}

          {/* Doing → Open (morph to focus terminal). */}
          {isDoing && issue.session && (hovered || !fine) && (
            <CardIconButton
              label={`Open session ${issue.session}`}
              title={`Open ${issue.session}`}
              onClick={() => onFocus(issue)}
            >
              <Maximize2 aria-hidden />
            </CardIconButton>
          )}

          {/* Resting live status dot (Doing) — shows whenever the cluster's
              hover actions aren't covering it. */}
          {isDoing && liveStatus && !(hovered && fine) && (
            <span className="mt-0.5 shrink-0" title={STATUS_LABEL[liveStatus]}>
              <StatusDot status={liveStatus} />
            </span>
          )}

          {/* Done → calm check + PR/commit hint. */}
          {isDone && (
            <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-status-ready">
              {linkCount > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground"
                  title={`${linkCount} ${linkCount === 1 ? 'link' : 'links'}`}
                >
                  <GitPullRequest aria-hidden className="size-3.5" />
                  {linkCount > 1 && <span className="tabular-nums">{linkCount}</span>}
                </span>
              )}
              <Check aria-hidden className="size-4" strokeWidth={2.5} />
            </span>
          )}

          {/* ⋯ menu — Open + Discard (discoverability / desktop). */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Card actions"
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'grid size-11 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4',
                  // On a fine pointer keep it discreet until hover; always show
                  // on coarse where there's no hover.
                  fine && !hovered && 'opacity-0',
                )}
              >
                <MoreHorizontal aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {isTodo && (
                <DropdownMenuItem onClick={() => onOpen(issue)}>
                  Edit
                </DropdownMenuItem>
              )}
              {isDoing && issue.session && (
                <DropdownMenuItem onClick={() => onFocus(issue)}>
                  <Maximize2 className="size-4" />
                  Open terminal
                </DropdownMenuItem>
              )}
              {isDone && (
                <DropdownMenuItem onClick={() => onOpen(issue)}>
                  Details
                </DropdownMenuItem>
              )}
              {!readOnly && (
                <DropdownMenuItem
                  onClick={() => onDiscard(issue)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="size-4" />
                  Discard
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Attention badges (Doing) + stale-link prompt + done-but-busy cue. */}
      {(needsInput || needsReview || staleLink || doneButBusy) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {needsInput && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
              <span className="size-1.5 shrink-0 rounded-full bg-warning" />
              Needs your input
            </span>
          )}
          {needsReview && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning/80">
              <span className="size-1.5 shrink-0 rounded-full bg-warning/70" />
              Review?
            </span>
          )}
          {staleLink && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Session ended
            </span>
          )}
          {doneButBusy && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning/80">
              <span className="size-1.5 shrink-0 rounded-full bg-warning/70" />
              Agent still running
            </span>
          )}
        </div>
      )}

      {/* The agent's question (needs-input) — shown verbatim so the human can
          answer without opening the terminal. */}
      {question && (
        <p className="rounded-lg bg-warning/10 px-2.5 py-1.5 text-[13px] leading-snug text-foreground">
          {question}
        </p>
      )}

      {/* Meta row — session chip, assignee pill, tags, due. */}
      {(issue.session || assignee || restTags.length > 0 || due) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {assignee && (
            <span
              className="inline-flex max-w-[160px] items-center gap-1 truncate rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-foreground/80"
              title={`Assigned to ${assignee}`}
            >
              {accentColor && (
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
              )}
              <span className="truncate">{assignee}</span>
            </span>
          )}
          {issue.session && (
            <span
              className={cn(
                'inline-flex max-w-[160px] items-center gap-1 truncate rounded-full px-2 py-0.5 text-[11px] font-medium',
                staleLink
                  ? 'bg-muted text-muted-foreground line-through'
                  : 'bg-primary/15 text-primary',
              )}
            >
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
              <span className="truncate">
                {displayLabel({
                  name: issue.session,
                  display_name: live?.display_name,
                })}
              </span>
            </span>
          )}
          {restTags.map((tag) => (
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

      {/* Acceptance progress pill. */}
      {issue.acceptance.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <AcceptancePill acceptance={issue.acceptance} />
        </div>
      )}

      {/* Hover tail-peek (desktop) — last lines of the live session. */}
      <AnimatePresence initial={false}>
        {showTail && (
          <motion.div
            key="tail-peek"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? undefined : { opacity: 0 }}
            transition={reduce ? { duration: 0 } : springs.snappy}
            className="-mx-3 mt-1 overflow-hidden border-t border-border/60 bg-muted/30"
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

      {/* ── Inline reply composer (Doing) — THE headline UX ─────────────────── */}
      {/* Suppressed on a read-through team board: the card can't deliver into the
          team's agent from here, so showing it would be a dead control. */}
      {isDoing && !readOnly && (
        <ReplyComposer
          issue={issue}
          expanded={replyExpanded}
          emphasized={needsInput}
          onRequestOpen={() => setReplyOpen(true)}
          onReply={onReply}
        />
      )}
    </motion.div>
  )

  // Swipe wrapper: a destructive backdrop reveals as the card slides left.
  if (!swipeEnabled) {
    return (
      <div {...dragAttributes} {...dragListeners}>
        {cardBody}
      </div>
    )
  }
  return (
    <div className="relative" {...dragAttributes} {...dragListeners}>
      <motion.div
        aria-hidden
        style={{ opacity: swipeBg }}
        className="pointer-events-none absolute inset-0 flex items-center justify-end rounded-[10px] bg-destructive/90 pr-5 text-destructive-foreground"
      >
        <Trash2 className="size-5" />
      </motion.div>
      <AnimatePresence>
        {!swipedOut && cardBody}
      </AnimatePresence>
    </div>
  )
}

/** A 44pt icon button used in the card's top-right cluster. */
function CardIconButton({
  label,
  title,
  onClick,
  tone,
  children,
}: {
  label: string
  title: string
  onClick: () => void
  tone?: 'primary'
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'grid size-11 place-items-center rounded-md text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4',
        tone === 'primary'
          ? 'hover:bg-primary/10 hover:text-primary'
          : 'hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/** The compact inline reply field on a Doing card. Collapsed to a single
 *  "Reply" chip until tapped (or auto-expanded on needs-input). Type → Send →
 *  delivers straight into the agent's session via the board /reply endpoint;
 *  sending clears the needs-input state (handled by the mutation). Exported so
 *  the desktop detail pane reuses the exact same drag-safe composer. */
export function ReplyComposer({
  issue,
  expanded,
  emphasized,
  onRequestOpen,
  onReply,
  placeholder,
}: {
  issue: BoardIssue
  expanded: boolean
  emphasized: boolean
  onRequestOpen: () => void
  onReply: (issue: BoardIssue, text: string) => Promise<void>
  /** Override the textarea placeholder. The detail pane sets this to a
   *  "leave a comment" prompt when the agent session is no longer live, so the
   *  field reads honestly as a durable note rather than a message to a dead PTY. */
  placeholder?: string
}) {
  const reduce = useReducedMotion()
  const fine = useMediaQuery('(pointer: fine)')
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)

  // Autofocus when it expands on a needs-input card (desktop only — avoid
  // forcing the mobile keyboard open until the human taps in).
  React.useEffect(() => {
    if (expanded && emphasized && fine) inputRef.current?.focus()
  }, [expanded, emphasized, fine])

  async function send() {
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    try {
      await onReply(issue, t)
      setText('')
    } catch {
      /* the route surfaces a toast; keep the text so it can be retried */
    } finally {
      setSending(false)
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRequestOpen()
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="inline-flex h-11 items-center gap-1.5 self-start rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Send className="size-3.5" />
        Reply to agent
      </button>
    )
  }

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : springs.snappy}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="flex items-end gap-1.5"
    >
      <textarea
        ref={inputRef}
        value={text}
        rows={1}
        placeholder={
          placeholder ?? (emphasized ? 'Answer the agent…' : 'Reply to the agent…')
        }
        aria-label={placeholder ?? 'Reply to the agent'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
        className={cn(
          // text-[16px] on mobile keeps iOS Safari from auto-zooming on focus
          // (it zooms any focused field under 16px); md:text-[13px] restores the
          // compact desktop sizing where there is no focus-zoom behaviour.
          'min-h-[36px] flex-1 resize-none rounded-md border bg-background px-2.5 py-2 text-[16px] leading-snug shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-[13px]',
          emphasized ? 'border-warning/50' : 'border-input',
        )}
      />
      <button
        type="button"
        aria-label="Send reply"
        disabled={!text.trim() || sending}
        onClick={() => void send()}
        className="grid size-11 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg]:size-4"
      >
        {sending ? (
          <Loader2 className="animate-spin" />
        ) : (
          <CornerDownLeft aria-hidden />
        )}
      </button>
    </motion.div>
  )
}

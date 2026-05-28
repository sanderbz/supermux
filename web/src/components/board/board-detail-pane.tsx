import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Maximize2, Pencil, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { type BoardIssue } from '@/lib/api'
import { displayLabel } from '@/lib/api/sessions'
import { useLiveSession } from '@/hooks/use-board'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import { TailPreview } from '@/components/session-tile/tail-preview'
import { AcceptanceChecklist } from '@/components/board/board-card-editor'
import { ReplyComposer } from '@/components/board/board-card'

export interface BoardDetailPaneProps {
  className?: string
  /** The card open in the pane — `null` shows the calm empty state. Re-derived
   *  from the board cache so live SSE deltas (acceptance ticks, comments, status)
   *  flow into the pane in place. */
  issue: BoardIssue | null
  /** Close the pane (✕ / Esc / clicking the lane background). */
  onClose: () => void
  /** Open the existing edit sheet for the card. */
  onEdit: (issue: BoardIssue) => void
  /** Morph to the focus terminal for the linked session. */
  onFocus: (issue: BoardIssue) => void
  /** Send an inline reply into the linked agent. Rejects on failure. */
  onReply: (issue: BoardIssue, text: string) => Promise<void>
  /** Discard the card (route shows the undo toast). */
  onDiscard: (issue: BoardIssue) => void
}

/**
 * The desktop "mission-control" master–detail pane (lg+ only). A SIBLING of the
 * lane row — never inside any SortableContext/useDroppable — so it can't perturb
 * dnd-kit's cached droppable rects. Its width is RESERVED whether empty or
 * filled, so selecting/deselecting a card never reflows the lanes.
 *
 * When a card is selected it shows, top-to-bottom: a header (heading + live
 * status dot + session label + Edit / Open terminal / close), the description,
 * the live acceptance checklist (reused from the editor — agent ticks stream in
 * over SSE), the linked agent's LIVE terminal tail (reused TailPreview), the
 * comment stream, and an always-expanded reply composer (the same drag-safe one
 * the Doing cards use). Everything reuses the board's existing components — no
 * duplicated logic.
 *
 * iOS-native finish: 10px radii, springs from springs.ts, sentence-case copy,
 * ≥44pt targets, reduced-motion safe.
 */
export function BoardDetailPane({
  className,
  issue,
  onClose,
  onEdit,
  onFocus,
  onReply,
  onDiscard,
}: BoardDetailPaneProps) {
  return (
    <aside
      className={cn(
        'flex-col rounded-xl border border-border bg-card/40',
        className,
      )}
    >
      {issue ? (
        // Keyed by id so the pane remounts pristine per card (resets the
        // composer + scroll like the editor sheet does).
        <DetailBody
          key={issue.id}
          issue={issue}
          onClose={onClose}
          onEdit={onEdit}
          onFocus={onFocus}
          onReply={onReply}
          onDiscard={onDiscard}
        />
      ) : (
        <EmptyState />
      )}
    </aside>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      <p className="max-w-[15rem] text-sm leading-relaxed text-muted-foreground">
        Select a card to see its details and reply to the agent.
      </p>
    </div>
  )
}

function DetailBody({
  issue,
  onClose,
  onEdit,
  onFocus,
  onReply,
  onDiscard,
}: {
  issue: BoardIssue
  onClose: () => void
  onEdit: (issue: BoardIssue) => void
  onFocus: (issue: BoardIssue) => void
  onReply: (issue: BoardIssue, text: string) => Promise<void>
  onDiscard: (issue: BoardIssue) => void
}) {
  const live = useLiveSession(issue.session)
  const linkLive = !!issue.session && issue.session_live
  const liveStatus = linkLive ? live?.status : undefined
  const staleLink = !!issue.session && !issue.session_live

  const heading =
    issue.title.trim() ||
    issue.desc
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ||
    issue.id

  const tailLines = linkLive ? (live?.preview_lines ?? []) : []

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex items-start gap-2 border-b border-border px-4 py-3">
        {liveStatus && (
          <span className="mt-1 shrink-0" title={STATUS_LABEL[liveStatus]}>
            <StatusDot status={liveStatus} />
          </span>
        )}
        <h2 className="min-w-0 flex-1 text-sm font-semibold leading-snug tracking-tight">
          {heading}
        </h2>
        <div className="-mr-1 flex shrink-0 items-center gap-0.5">
          <PaneIconButton label="Edit task" onClick={() => onEdit(issue)}>
            <Pencil aria-hidden />
          </PaneIconButton>
          {issue.session && (
            <PaneIconButton
              label={`Open ${issue.session}`}
              onClick={() => onFocus(issue)}
            >
              <Maximize2 aria-hidden />
            </PaneIconButton>
          )}
          <PaneIconButton label="Close panel" onClick={onClose}>
            <X aria-hidden />
          </PaneIconButton>
        </div>
      </header>

      {/* ── Scrolling body ─────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 [scrollbar-width:thin]">
        {/* Session + tags + state. */}
        {(issue.session || issue.tags.length > 0 || staleLink) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.session && (
              <span
                className={cn(
                  'inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-[11px] font-medium',
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
            {staleLink && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Session ended
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
          </div>
        )}

        {/* Description. */}
        <PaneSection label="Description">
          {issue.desc.trim() ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {issue.desc}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No description.</p>
          )}
        </PaneSection>

        {/* Acceptance — reused checklist (agent ticks stream in over SSE). */}
        <AcceptanceChecklist issueId={issue.id} items={issue.acceptance} />

        {/* Live terminal tail of the linked agent. */}
        {issue.session && (
          <PaneSection
            label="Live"
            trailing={
              <button
                type="button"
                onClick={() => onFocus(issue)}
                className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Open terminal
                <Maximize2 className="size-3" />
              </button>
            }
          >
            {linkLive && tailLines.length > 0 ? (
              <div className="-mx-1 overflow-hidden rounded-md border border-border/60 bg-muted/30 py-2">
                <TailPreview
                  lines={tailLines}
                  ansiLines={live?.preview_ansi}
                  visibleLines={14}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {staleLink
                  ? 'The session has ended.'
                  : 'No live output yet.'}
              </p>
            )}
          </PaneSection>
        )}

        {/* Comments. */}
        <PaneSection label="Comments">
          <CommentStream comments={issue.comments} />
        </PaneSection>
      </div>

      {/* ── Reply composer (always expanded) + discard ─────────────────────── */}
      <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
        <ReplyComposer
          issue={issue}
          expanded
          emphasized={issue.awaiting_input}
          onRequestOpen={() => {}}
          onReply={onReply}
          placeholder={
            linkLive ? undefined : 'Leave a comment for the record…'
          }
        />
        <button
          type="button"
          onClick={() => onDiscard(issue)}
          className="inline-flex h-9 items-center self-start rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-destructive"
        >
          Discard task
        </button>
      </div>
    </div>
  )
}

function CommentStream({
  comments,
}: {
  comments: BoardIssue['comments']
}) {
  const reduce = useReducedMotion()
  if (comments.length === 0) {
    return <p className="text-sm text-muted-foreground">No comments yet.</p>
  }
  return (
    <div className="flex flex-col gap-2">
      {comments.map((c) => {
        const agent = c.author.startsWith('agent:')
        const who = agent
          ? c.author.slice('agent:'.length)
          : c.author === 'user'
            ? 'You'
            : c.author.replace(/^human:/, '')
        return (
          <motion.div
            key={c.id}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduce ? { duration: 0 } : springs.snappy}
            className={cn(
              'flex flex-col gap-0.5 rounded-lg border px-2.5 py-2',
              agent
                ? 'border-border bg-muted/30'
                : 'border-primary/20 bg-primary/5',
            )}
          >
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="truncate font-medium">{who}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums">{timeAgo(c.created)}</span>
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-snug text-foreground">
              {c.body}
            </p>
          </motion.div>
        )
      })}
    </div>
  )
}

/** Time-ago for an epoch-seconds timestamp (just now / Nm / Nh / Nd ago) —
 *  matches the rhythm used elsewhere in the app. */
function timeAgo(epochSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - epochSeconds
  if (diff < 60) return 'just now'
  const m = Math.floor(diff / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function PaneSection({
  label,
  trailing,
  children,
}: {
  label: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {trailing}
      </div>
      {children}
    </div>
  )
}

/** A 44pt icon button used in the pane header — mirrors the card's cluster. */
function PaneIconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-11 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
    >
      {children}
    </button>
  )
}

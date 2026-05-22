import { Bot, Calendar, User } from 'lucide-react'
import { motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { BoardIssue } from '@/lib/api'

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
 * A board card. Shows title, session pill (if assigned), tag chips, due date and
 * an owner-type icon. Tap opens the detail sheet; press-and-drag (pointer) hands
 * off to the board's cross-column drag controller with spring physics.
 *
 * iOS-native finish: 10px continuous-corner radius, ≥44pt tap target, scale-0.97
 * press feedback (no `transition: all`), Title Case copy only.
 */
export function IssueCard({
  issue,
  onOpen,
  isDragging,
  onDragStart,
}: IssueCardProps) {
  const reduce = useReducedMotion()
  const due = issue.due ? dueLabel(issue.due) : null
  const OwnerIcon = issue.owner_type === 'agent' ? Bot : User

  return (
    <motion.button
      type="button"
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
      className={cn(
        'group flex min-h-[44px] w-full touch-none select-none flex-col gap-2 rounded-[10px] border border-border bg-background/80 p-3 text-left shadow-sm',
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
      </div>

      {(issue.session || issue.tags.length > 0 || due) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.session && (
            <span className="inline-flex max-w-[140px] items-center gap-1 truncate rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
              <span className="size-1.5 shrink-0 rounded-full bg-primary" />
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

      <span className="font-mono text-[10px] tracking-wide text-muted-foreground/70">
        {issue.id}
      </span>
    </motion.button>
  )
}

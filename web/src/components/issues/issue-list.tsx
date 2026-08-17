/**
 * `<IssueList>` — the issues linked to ONE session, or to ONE team.
 * ─────────────────────────────────────────────────────────────────────────────
 * This is net-new capability, and it is the honest justification for removing
 * the Board page. Before B2 a user in focus mode could not tell that a card was
 * linked to their session at all: `SessionInfoPanel` has sections for Name,
 * Working dir, Settings, Schedules and Git, and ZERO issue information — the
 * only two mentions of "board" in the whole file are style comments. The issues
 * existed, the agent was reporting onto them through `/supermux-task`, and the
 * one place you could see any of it was a Kanban page on a different route.
 *
 * Two scopes, one component:
 *   · per SESSION — Main's cards filtered by `session`, which is exactly what
 *     `sessionBoardId()` + `useBoard()` already do (a `session:<name>` board is
 *     a client-side filter on Main, not a real board row). Reused rather than
 *     re-derived.
 *   · per TEAM — the team's own `kind='team'` board, the read-through mirror of
 *     `~/.claude/tasks/<team>/NN.json` that `teams/board_sync.rs` maintains.
 *
 * Live over the existing `board` / `boards` SSE events (`useBoard` subscribes),
 * so a tick from the agent lands here without a refetch.
 */
import { CalendarClock, GitCommit, GitPullRequest, Link2, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import { EMPTY } from '@/brand/copy'
import { useBoard } from '@/hooks/use-board'
import { sessionBoardId } from '@/lib/api/boards'
import type { BoardIssue } from '@/lib/api'

export interface IssueListProps {
  /** Per-session scope: Main's cards filtered by this session name. */
  session?: string
  /** Per-team scope: the team's own `kind='team'` board id. */
  boardId?: string
  /** Row click — the surface opens the detail for it. */
  onOpen?: (issue: BoardIssue) => void
  /** The row that is currently open in the detail, if any. */
  selectedId?: string | null
  className?: string
}

export function IssueList({
  session,
  boardId,
  onOpen,
  selectedId,
  className,
}: IssueListProps) {
  // One of the two scopes. `sessionBoardId()` produces the virtual
  // `session:<name>` id `useBoard` already knows how to resolve, so the
  // per-session filter is the SHIPPED synthesis rather than a second one.
  const scope = session ? sessionBoardId(session) : (boardId ?? '')
  const { issues, isLoading, isError, refetch } = useBoard(scope)

  if (isLoading) {
    return (
      <div className={cn('flex flex-col gap-1.5', className)} data-vr="issue-list-loading">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 rounded-lg bg-muted/60" />
        ))}
      </div>
    )
  }

  if (isError) {
    return (
      <div className={className} data-vr="issue-list-error">
        <EmptyStatePlaceholder
          icon={<Link2 />}
          message="Couldn’t load issues."
          cta={{ label: 'Try again', onClick: () => refetch() }}
        />
      </div>
    )
  }

  if (issues.length === 0) {
    return (
      <div className={className} data-vr="issue-list-empty">
        {/* `EMPTY.issues` (renamed from the dead `EMPTY.board` in T10) — the
            title is the message; the body explains where issues come from, which
            is the part a user who has never used `/supermux-task` needs. */}
        <EmptyStatePlaceholder icon={<Link2 />} message={EMPTY.issues.body} />
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-1', className)} data-vr="issue-list">
      {issues.map((issue) => (
        <IssueRow
          key={issue.id}
          issue={issue}
          selected={issue.id === selectedId}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}

/** One row: id, title, status, acceptance progress, due, links, `team:` owner. */
function IssueRow({
  issue,
  selected,
  onOpen,
}: {
  issue: BoardIssue
  selected: boolean
  onOpen?: (issue: BoardIssue) => void
}) {
  const done = issue.acceptance.filter((a) => a.done).length
  const total = issue.acceptance.length
  // `team:<name>` rides in the tags — the assignee vocabulary `board_sync` uses.
  const teamTag = issue.tags.find((t) => t.startsWith('team:'))
  const prLink = issue.links.find((l) => l.kind === 'pr')
  const commitLink = issue.links.find((l) => l.kind === 'commit')

  return (
    <button
      type="button"
      onClick={() => onOpen?.(issue)}
      aria-current={selected ? 'true' : undefined}
      data-vr="issue-row"
      data-issue-id={issue.id}
      className={cn(
        'flex min-h-11 w-full flex-col gap-1 rounded-lg px-2 py-1.5 text-left transition-colors',
        selected ? 'bg-accent/50' : 'hover:bg-accent/30',
      )}
    >
      <span className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{issue.id}</span>
        <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
        {/* The two flags `auto_actions.rs` writes when a session goes idle or
            starts waiting — the reverse edge that made the board worth keeping. */}
        {issue.awaiting_input && (
          <span className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
            Needs input
          </span>
        )}
        {!issue.awaiting_input && issue.needs_review && (
          <span className="shrink-0 rounded-full bg-status-ready/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-ready">
            Review
          </span>
        )}
      </span>
      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
        <span className="capitalize">{issue.status}</span>
        {total > 0 && (
          <span className="tabular-nums">
            {done}/{total} done
          </span>
        )}
        {issue.due && (
          <span className="inline-flex items-center gap-1">
            <CalendarClock className="size-3" aria-hidden />
            {issue.due}
          </span>
        )}
        {teamTag && (
          <span className="inline-flex items-center gap-1">
            <Users className="size-3" aria-hidden />
            {teamTag.slice('team:'.length)}
          </span>
        )}
        {prLink && (
          <span className="inline-flex items-center gap-1">
            <GitPullRequest className="size-3" aria-hidden />
            PR
          </span>
        )}
        {commitLink && (
          <span className="inline-flex items-center gap-1">
            <GitCommit className="size-3" aria-hidden />
            {commitLink.ref.slice(0, 7)}
          </span>
        )}
      </span>
    </button>
  )
}

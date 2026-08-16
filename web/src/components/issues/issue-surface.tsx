/**
 * `<IssueSurface>` — where issues live now that the Board page does not.
 * ─────────────────────────────────────────────────────────────────────────────
 * List on the left, detail on the right, hosted in B1's `<ShellOverlay>`: a
 * shell-absolute pane on desktop, a `ResponsiveSheet` on a phone — ONE component
 * with a `variant`, per §11.4's "three fidelities, one component". The nav rail
 * stays visible beside it, which is the whole point of an overlay that is not
 * `fixed`.
 *
 * Reachable from `SessionInfoPanel` (per session), `TeamCard` (per team), and as
 * a navigation target for the palette's issue results. B2 guarantees the target
 * exists; B3 owns the picker.
 *
 * The one capability chat structurally cannot hold is here: a durable COMMENT
 * (`POST /api/board/{id}/comment`) reaches an agent whose session is stopped,
 * gone, or was never live. That is why §12.8 keeps the board API when the page
 * goes — and why the composer below falls back from "reply" to "comment" the
 * moment the linked session is not live, instead of typing into a dead pty.
 */
import * as React from 'react'

import { ShellOverlay } from '@/components/shell/shell-overlay'
import { useBoard, useLiveSession } from '@/hooks/use-board'
import { sessionBoardId } from '@/lib/api/boards'
import type { BoardIssue } from '@/lib/api'
import { IssueDetail } from './issue-detail'
import { IssueList } from './issue-list'

export interface IssueSurfaceProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Per-session scope. Exactly one of `session` / `boardId` is given. */
  session?: string
  /** Per-team scope — the team's `kind='team'` board id. */
  boardId?: string
  /** Label for the overlay header (the session's display name, or the team). */
  title?: string
  /** Open a session's focus route from the detail's "Open terminal". */
  onFocusSession?: (name: string) => void
  /** Open straight onto one issue. The entry points are LISTS — the info
   *  panel's inline list, the team card — so a click there has to carry which
   *  row was clicked, or the overlay opens on a list the user has already read. */
  initialIssueId?: string | null
}

export function IssueSurface({
  open,
  onOpenChange,
  session,
  boardId,
  title,
  onFocusSession,
  initialIssueId,
}: IssueSurfaceProps) {
  const scope = session ? sessionBoardId(session) : (boardId ?? '')
  const { issues, replyIssue, commentIssue, deleteIssue } = useBoard(scope)
  const [selectedId, setSelectedId] = React.useState<string | null>(initialIssueId ?? null)

  // Closing forgets the selection — but it is done in the CLOSE handler, not in
  // an effect on `open`: a setState in an effect re-renders the whole overlay a
  // second time on every open, and the state a surface holds while it is shut is
  // nobody's business anyway.
  const close = React.useCallback(
    (next: boolean) => {
      if (!next) setSelectedId(null)
      onOpenChange(next)
    },
    [onOpenChange],
  )

  // Re-derive the open issue from the LIVE list rather than holding the object:
  // acceptance ticks and comments arrive over the `board` SSE event, and a held
  // copy would freeze the detail at the moment it was opened.
  // `initialIssueId` wins until the user picks another row: the overlay is
  // usually opened BY clicking a row, and re-deriving from the prop means the
  // caller does not have to reset state to open a different issue.
  const activeId = selectedId ?? initialIssueId ?? null
  const selected: BoardIssue | null =
    (activeId && issues.find((i) => i.id === activeId)) || null

  const live = useLiveSession(selected?.session)

  /** Reply if the agent is actually there; otherwise leave a durable comment.
   *  The distinction is the surface's reason to exist, so it is decided here and
   *  the composer's placeholder says which one the user is doing. */
  const onReply = React.useCallback(
    async (issue: BoardIssue, text: string) => {
      if (issue.session && live?.status && live.status !== 'stopped') {
        await replyIssue(issue.id, text)
      } else {
        await commentIssue(issue.id, text)
      }
    },
    [live, replyIssue, commentIssue],
  )

  return (
    <ShellOverlay
      open={open}
      onOpenChange={close}
      variant="pane"
      title="Issues"
      description={title}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-vr="issue-surface">
        <IssueList
          session={session}
          boardId={boardId}
          selectedId={activeId}
          onOpen={(issue) => setSelectedId(issue.id)}
          className="shrink-0"
        />
        {selected && (
          <IssueDetail
            issue={selected}
            onClose={() => setSelectedId(null)}
            // Editing is the removed page's job and stays removed: the detail's
            // Edit affordance re-opens the row for selection rather than
            // resurrecting the 600-line editor sheet. B3 owns an editor if one
            // is wanted.
            onEdit={(issue) => setSelectedId(issue.id)}
            onFocus={(issue) => {
              if (issue.session) onFocusSession?.(issue.session)
            }}
            onReply={onReply}
            onDiscard={(issue) => void deleteIssue(issue.id)}
            className="min-h-0 flex-1"
          />
        )}
      </div>
    </ShellOverlay>
  )
}

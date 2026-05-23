// ResumePicker — pick a past Claude conversation to resume for a stopped
// session's working dir (feat-resume-picker).
//
// Starting a stopped session always launched a CLEAN claude. This picker lists
// the conversations Claude persists for that session's dir
// (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, surfaced by
// `GET /api/sessions/{name}/resumable`) and, on pick, starts the session with
// `claude --resume <id>` via `POST /api/sessions/{name}/resume`. The session's
// SSE `status` delta then flips it to running — same path as a fresh Start.
//
// REUSE: <ResponsiveSheet> (Vaul drag-detent bottom sheet on mobile, shadcn
// side panel on desktop) so the picker matches the board/scheduler detail
// sheets. The conversation list mirrors the scheduler fire-log row rhythm:
// title + dim meta (relative time · message count), newest first.
//
// VISUAL: design tokens only, sentence-case copy, 44pt hit targets on each row,
// springs inherited from <Button>; absolute timestamp on hover (title attr).

import * as React from 'react'
import { Loader2, MessageSquare } from 'lucide-react'

import { cn } from '@/lib/utils'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import {
  sessionsApi,
  type ResumableConversation,
} from '@/lib/api'

export interface ResumePickerProps {
  /** Session name — the resume target. */
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-fetched conversations (the actions cluster already loaded them to
   *  decide whether to show Resume at all — passing them in avoids a second
   *  round-trip on open). */
  conversations: ResumableConversation[]
  /** Fired after a resume request is accepted — the host closes the sheet; the
   *  SSE status delta swaps the surface for the live terminal. */
  onResumed?: () => void
}

/** Relative time-ago for an RFC3339 timestamp — same rhythm as the tile row's
 *  `relativeTime` (just now / Nm / Nh / Nd ago). */
function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** Absolute timestamp for the row's `title` (hover) — locale date + time. */
function absoluteTime(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  return new Date(ms).toLocaleString()
}

export function ResumePicker({
  name,
  open,
  onOpenChange,
  conversations,
  onResumed,
}: ResumePickerProps) {
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState(false)

  // Reset transient state on the open/close transition (handled in the change
  // callback rather than an effect to avoid a setState-in-effect cascade).
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) {
        setBusyId(null)
        setFailed(false)
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const onPick = React.useCallback(
    (id: string) => {
      if (busyId) return
      setBusyId(id)
      setFailed(false)
      sessionsApi
        .resume(name, id)
        .then(() => {
          onResumed?.()
          handleOpenChange(false)
        })
        .catch(() => {
          setBusyId(null)
          setFailed(true)
        })
    },
    [busyId, name, handleOpenChange, onResumed],
  )

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={handleOpenChange}
      title="Resume a conversation"
      description="Pick a past Claude conversation for this directory."
    >
      <div className="px-5 py-3">
        {conversations.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No past conversations for this directory yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {conversations.map((c) => {
              const isBusy = busyId === c.id
              const disabled = busyId !== null
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onPick(c.id)}
                    disabled={disabled}
                    className={cn(
                      'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left',
                      'transition-colors hover:bg-muted focus-visible:outline-none',
                      'focus-visible:ring-2 focus-visible:ring-ring',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {c.summary}
                      </p>
                      <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span title={absoluteTime(c.updated_at)}>
                          {relativeTime(c.updated_at)}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="inline-flex items-center gap-1">
                          <MessageSquare className="size-3" aria-hidden />
                          {c.message_count}
                        </span>
                      </p>
                    </div>
                    {isBusy && (
                      <Loader2
                        className="size-4 shrink-0 animate-spin text-muted-foreground"
                        aria-hidden
                      />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {failed && (
          <p role="alert" className="mt-2 text-center text-xs text-status-error">
            Couldn’t resume that conversation. Try again.
          </p>
        )}
      </div>
    </ResponsiveSheet>
  )
}

export default ResumePicker

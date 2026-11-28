/**
 * One `<task-notification>` block as a compact card (`task-notification.ts`
 * parses it; `transcript-item.tsx` draws it).
 *
 * Three layers, in the order a reader needs them: WHAT finished and how it
 * ended (icon, name, Claude Code's own status words), WHAT IT SAID (the result
 * as Markdown or the monitor event in monospace, a few lines until expanded),
 * and the plumbing (ids, output path, usage, worktree) behind a native
 * disclosure. Only utilities the app already uses, and an inline style for the
 * preview clamp: the CSS budget has no room for one card's worth of new rules.
 */
import * as React from 'react'

import type { TaskNotification, TaskStatus } from './task-notification'

const ICON: Record<TaskStatus, [glyph: string, ink: string]> = {
  done: ['✓', 'text-status-ready-ink'],
  failed: ['✕', 'text-status-error-ink'],
  waiting: ['◔', 'text-status-active-ink'],
  event: ['●', 'text-ink-2'],
}

/** A body longer than this is shown as a preview with an expand control. */
const PREVIEW_LINES = 4
const PREVIEW_CHARS = 320

export interface TaskNotificationCardProps {
  note: TaskNotification
  /** The result, typeset — `transcript-item.tsx` passes its own lazy `Prose`
   *  over `note.result`, so the markdown stack stays behind its one lazy edge. */
  markdown?: React.ReactNode
}

export default function TaskNotificationCard({ note, markdown }: TaskNotificationCardProps) {
  const [open, setOpen] = React.useState(false)
  const [glyph, ink] = ICON[note.status]
  const body = note.event ?? note.result
  const long = !!body && (body.split('\n').length > PREVIEW_LINES || body.length > PREVIEW_CHARS)
  return (
    <div className="my-2 flex justify-center px-2">
      <div
        role="note"
        data-testid="chat-task-notification"
        data-status={note.status}
        className="w-full max-w-[560px] rounded-[12px] border-[0.5px] border-hairline-soft bg-fill-soft px-3 py-2"
      >
        <p className="flex items-start gap-1.5 text-[13.5px] text-ink">
          <span aria-hidden className={`flex-none ${ink}`}>
            {glyph}
          </span>
          <span className="min-w-0 break-words font-medium">{note.title}</span>
        </p>
        {note.line && <p className="mt-0.5 text-[12px] text-ink-3">{note.line}</p>}
        {body && (
          <div
            className="mt-1 overflow-hidden text-[13px] leading-[1.45] text-ink-2"
            // PREVIEW_LINES at this line height.
            style={long && !open ? { maxHeight: '5.8em' } : undefined}
          >
            {note.event ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">{note.event}</pre>
            ) : (
              markdown
            )}
          </div>
        )}
        {long && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="mt-1 text-[12px] font-medium text-ink-2 hover:text-ink"
          >
            {open ? 'Show less' : 'Show more'}
          </button>
        )}
        {note.details.length > 0 && (
          <details className="mt-1 text-[12px] text-ink-3">
            <summary className="cursor-pointer select-none">Details</summary>
            <dl className="mt-1">
              {note.details.map(([k, v]) => (
                <div key={k} className="flex gap-1.5">
                  <dt className="flex-none">{k}</dt>
                  <dd className="min-w-0 break-all font-mono text-ink-2">{v}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
    </div>
  )
}

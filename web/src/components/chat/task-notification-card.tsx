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

import { formatElapsed } from './entries'
import type { TaskNotification, TaskStatus } from './task-notification'
import { tokenCount } from './wire-entries'

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

/** `421k tokens · 140 tool uses · 35m 37s`; a missing (NaN) number is left out. */
function usageWords([tokens, uses, ms]: number[]): string {
  return [
    tokens >= 0 && `${tokenCount(tokens)} tokens`,
    uses >= 0 && `${uses} tool use${uses === 1 ? '' : 's'}`,
    ms >= 0 && formatElapsed(ms),
  ]
    .filter(Boolean)
    .join(' · ')
}

export default function TaskNotificationCard({ note, markdown }: TaskNotificationCardProps) {
  const [open, setOpen] = React.useState(false)
  const [glyph, ink] = ICON[note.status]
  const body = note.event || note.result
  const usage = usageWords(note.usage)
  const details = usage ? [...note.details, ['Usage', usage]] : note.details
  const long = !!body && (body.split('\n').length > PREVIEW_LINES || body.length > PREVIEW_CHARS)
  return (
    <div className="my-2 flex justify-center px-2">
      <div
        role="note"
        data-testid="chat-task-notification"
        className="w-full max-w-[560px] rounded-[12px] border-[0.5px] border-hairline-soft bg-fill-soft px-3 py-2"
      >
        <p className="break-words text-[13.5px] font-medium text-ink">
          <span aria-hidden className={ink}>
            {glyph}{' '}
          </span>
          {note.title}
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
        {long && !open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-1 text-[12px] font-medium text-ink-2 hover:text-ink"
          >
            Show more
          </button>
        )}
        {details.length > 0 && (
          <details className="mt-1 text-[12px] text-ink-3">
            <summary className="cursor-pointer select-none">Details</summary>
            <p className="mt-1 whitespace-pre-wrap break-all font-mono text-ink-2">
              {details.map(([k, v]) => `${k}: ${v}`).join('\n')}
            </p>
          </details>
        )}
      </div>
    </div>
  )
}

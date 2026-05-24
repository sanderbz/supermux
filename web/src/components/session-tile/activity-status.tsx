// activity-status.tsx — the live "what is this agent doing right now" line and
// the dead/blocked error badge (hooks-10x, Track 3). Two tiny presentational
// pieces shared by the overview tile (tile.tsx) and the focus headers
// (focus-header.tsx) so the copy + truncation + token styling stay identical in
// both places. Pure: primitive props, no data fetching, no motion of their own.
//
// • <ActivityLine> — a calm one-line indicator (e.g. "✎ tile.tsx", "⚡ npm test")
//   derived from the backend's `session.activity` (latest PreToolUse hook). The
//   emoji prefix already carries the kind; we just truncate and render it muted.
//   Renders null when there's nothing to show — the caller can mount it
//   unconditionally without guarding.
//
// • <ErrorBadge> — a small amber badge surfacing an unrecovered agent error
//   (`session.error`, set from a StopFailure hook). Maps common `error.type`
//   values to short, friendly, sentence-case labels; the full message rides the
//   `title` tooltip. Uses the calm `--status-error` orange token (never an
//   alarmist red), matching the rest of the app's error treatment.

import { cn } from '@/lib/utils'

/** Map a machine `error.type` to a short, friendly, sentence-case label. Unknown
 *  types fall back to a generic "Error" so a never-before-seen failure still
 *  shows the badge (with the raw message in the tooltip) instead of vanishing.
 *  Kept module-private so this file exports ONLY components (clean fast-refresh). */
function errorLabel(type: string): string {
  switch (type) {
    case 'rate_limit':
      return 'Rate-limited'
    case 'billing_error':
      return 'Billing'
    case 'authentication_failed':
      return 'Auth error'
    case 'server_error':
      return 'Server error'
    default:
      return 'Error'
  }
}

export interface ActivityLineProps {
  /** The live activity label from the backend (already emoji-prefixed). */
  activity?: string
  /** Extra classes for the wrapping span (sizing / layout from the caller). */
  className?: string
}

/** A calm, single-line, truncating activity indicator. Renders null when there
 *  is no activity, so callers can drop it in without their own guard. */
export function ActivityLine({ activity, className }: ActivityLineProps) {
  const label = activity?.trim()
  if (!label) return null
  return (
    <span
      // `min-w-0` + `truncate` so the line never pushes its row wider or wraps —
      // it shrinks first. Muted so it reads as ambient status, not a headline.
      className={cn('block min-w-0 truncate text-muted-foreground', className)}
      title={label}
    >
      {label}
    </span>
  )
}

export interface ErrorBadgeProps {
  /** The unrecovered agent error, or undefined when the agent is healthy. */
  error?: { type: string; message: string }
  /** Extra classes for the badge (e.g. text size tweaks per call site). */
  className?: string
}

/** A small amber "this agent is blocked" badge. Renders null when there's no
 *  error, and clears automatically when `error` clears (the backend nulls it on
 *  resume). `title` = the full error message for a hover/long-press tooltip. */
export function ErrorBadge({ error, className }: ErrorBadgeProps) {
  if (!error?.type) return null
  return (
    <span
      role="status"
      title={error.message || errorLabel(error.type)}
      className={cn(
        // Calm orange (--status-error) tint — visible enough to make a dead agent
        // obvious, never an alarmist red. Mirrors the needs-input pill geometry.
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-status-error/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-error',
        className,
      )}
    >
      <span aria-hidden>⚠</span>
      {errorLabel(error.type)}
    </span>
  )
}

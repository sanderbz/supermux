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

import { motion, useReducedMotion } from 'framer-motion'

import { motionOff, springs } from '@/lib/springs'
import { cn } from '@/lib/utils'
import { InlineRecovery } from '@/components/recovery/recovery-ladder'

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
    // The session's terminal died under it (a crashed pty holder), not the
    // agent failing a turn — the session is stopped and needs a restart, so the
    // badge says so plainly and the tooltip carries the crash reason.
    case 'holder_died':
      return 'Terminal died'
    default:
      return 'Error'
  }
}

/** Below this many outstanding subagents the parallelism clause stays hidden — a
 *  lone Task is not noteworthy; two or more is the "many hands" signal we surface. */
const SUBAGENT_CLAUSE_MIN = 2

export interface ActivityLineProps {
  /** The live activity label from the backend (already emoji-prefixed). */
  activity?: string
  /** Live count of outstanding Task sub-agents for the current turn. When ≥ 2 a
   *  calm `· N subagents` clause is appended — the display-only parallelism
   *  signal so a 5-subagent turn reads visibly different from a single tool. */
  subagents?: number
  /** Extra classes for the wrapping span (sizing / layout from the caller). */
  className?: string
}

/** A calm, single-line, truncating activity indicator with an optional muted
 *  `· N subagents` parallelism clause. Renders null when there is nothing to
 *  show, so callers can drop it in without their own guard.
 *
 *  Layout is a single `truncate` line (not flex) so every call site keeps its
 *  existing alignment (incl. the centered mobile focus line and the desktop
 *  focus header's content-sized `basis-auto`). The clause sits LAST, so on a
 *  tight line the `truncate` ellipsis clips it before the activity label — the
 *  name always wins the squeeze. (No container query / `container-type`: that
 *  would impose size containment and collapse the header's content-sized line.) */
export function ActivityLine({ activity, subagents, className }: ActivityLineProps) {
  // Hook must run unconditionally (rules-of-hooks) — before any early return.
  const reduce = useReducedMotion()
  const label = activity?.trim()
  const n = subagents ?? 0
  const showCount = n >= SUBAGENT_CLAUSE_MIN
  if (!label && !showCount) return null
  return (
    <span
      className={cn('block min-w-0 truncate text-muted-foreground', className)}
      title={label}
    >
      {label}
      {showCount && (
        <motion.span
          // Tick on change (2→3) — a 2px fade, not a pop. Reduced motion: instant.
          key={n}
          initial={reduce ? false : { opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduce ? motionOff : springs.statusMorph}
          // Muted /70 + tabular so the count is calm and non-jittering.
          className="ml-1 inline-block align-baseline whitespace-nowrap tabular-nums text-muted-foreground/70"
        >
          {label ? '· ' : ''}
          {n} subagents
        </motion.span>
      )}
    </span>
  )
}

export interface ErrorBadgeProps {
  /** The unrecovered agent error, or undefined when the agent is healthy. */
  error?: { type: string; message: string }
  /** Extra classes for the badge (e.g. text size tweaks per call site). */
  className?: string
  /** B5/T8.3 — the session this badge is about. Supplying it turns a
   *  `holder_died` badge from a STATEMENT into an AFFORDANCE: a dead terminal
   *  is the one error a user can act on from here, and until B5 the badge said
   *  so and then offered nothing. Omit it and the badge renders exactly as
   *  before, so every existing call site is unchanged. */
  session?: RecoveryTarget
}

/** What `<InlineRecovery>` needs to pick the lowest useful rung. */
export interface RecoveryTarget {
  name: string
  runtime?: string
  host_id?: number | null
}

/** A small amber "this agent is blocked" badge. Renders null when there's no
 *  error, and clears automatically when `error` clears (the backend nulls it on
 *  resume). `title` = the full error message for a hover/long-press tooltip. */
export function ErrorBadge({ error, className, session }: ErrorBadgeProps) {
  if (!error?.type) return null
  // A dead TERMINAL is recoverable; a rate limit or a billing error is not
  // something a restart fixes. Offering the ladder on those would be noise
  // dressed as help, so the affordance is scoped to the one error it answers.
  const recoverable = error.type === 'holder_died' && Boolean(session)
  if (recoverable && session) {
    return (
      <span className={cn('inline-flex items-center gap-1.5', className)}>
        <ErrorPill error={error} />
        <InlineRecovery name={session.name} session={session} />
      </span>
    )
  }
  return <ErrorPill error={error} className={className} />
}

/** The badge itself, without the affordance — the shape every non-recoverable
 *  error still renders, unchanged from before B5. */
function ErrorPill({
  error,
  className,
}: {
  error: { type: string; message: string }
  className?: string
}) {
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

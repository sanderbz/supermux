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

import { classifyAgentError, errorBadgeLabel, resetNote } from '@/components/chat/agent-error'
import {
  usageTitle,
  worstWindow,
  type RateLimits,
} from '@/lib/rate-limits'
import { motionOff, springs } from '@/lib/springs'
import { cn } from '@/lib/utils'
import { InlineRecovery } from '@/components/recovery/recovery-ladder'

/** Map an `error` to a short, friendly, sentence-case label. Unknown types fall
 *  back to a generic "Error" so a never-before-seen failure still shows the
 *  badge (with the raw message in the tooltip) instead of vanishing.
 *
 *  **This taxonomy was unreachable until the states audit.** `activity.rs` read
 *  the class off `error_type`, a key Claude Code does not send — CC's
 *  `StopFailure` puts it in `error` — so every arm below `default` was dead
 *  code and every dead session, whatever killed it, badged `⚠ Error`.
 *
 *  The MESSAGE is now part of the decision, not just the tooltip: CC's six
 *  quota buckets all arrive as class `rate_limit`, and only the banner says
 *  which — a distinction worth drawing, because waiting is the right answer to
 *  two of them and the wrong answer to four. A server-side throttle arrives as
 *  `rate_limit` as well and is explicitly NOT a quota hit. `errorBadgeLabel`
 *  is that reading, shared with the chat plane and pinned to the Rust
 *  classifier by `server/tests/fixtures/chat/claude-states.jsonl`.
 *
 *  Kept module-private so this file exports ONLY components (clean fast-refresh). */
function errorLabel(type: string, message?: string): string {
  return errorBadgeLabel(type, message) ?? 'Error'
}

/** Below this many outstanding subagents the parallelism clause stays hidden — a
 *  lone Task is not noteworthy; two or more is the "many hands" signal we surface. */
const SUBAGENT_CLAUSE_MIN = 2

/** The BMP Private Use Area — where Nerd Font packs its icon glyphs.
 *
 *  `session.activity` is built from hook payloads, and a hook that echoes a
 *  Nerd-Font-decorated tool label smuggles a private-use codepoint into a label
 *  that is rendered in the UI SANS stack, which has no glyph for it: the focus
 *  header printed a tofu box (`▯`) where the emoji prefix should be (chat-core,
 *  23-hdr-zoom.png). Stripping is right rather than switching the stack to mono
 *  — the codepoint means nothing outside the font that defined it, and the rest
 *  of the label is ordinary text that belongs in the UI face.
 *
 *  Module-private, so this file still exports only components (fast refresh) —
 *  the assertion goes through `<ActivityLine>` itself. */
const PUA_RE = /[\ue000-\uf8ff]/g

/** Unconditional `replace`, never a `test` guard: `PUA_RE` is global, and
 *  `RegExp.test` on a global pattern advances `lastIndex` \u2014 the guard would
 *  answer differently on every other call. */
function stripPua(s: string): string {
  return s.replace(PUA_RE, '').replace(/\s{2,}/g, ' ').trim()
}

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
  const label = activity?.trim() ? stripPua(activity.trim()) : undefined
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

/**
 * The session cannot do the next turn — a usage limit, or a startup gate.
 *
 * A SEPARATE badge from `<ErrorBadge>` because it is a separate fact, arriving
 * on a separate field, and the audit's worst finding is what happens when
 * neither is present: a limit-hit session's turn ends with an ordinary `Stop`,
 * so `status` is `idle`, no `StopFailure` fires for the banner itself, the dot
 * goes green and the composer stays enabled — for an account that is cut off for
 * five hours (verify matrix finding 1, `06-overview-limits.png`).
 *
 * The label says WHICH condition and the tooltip carries Claude Code's own
 * sentence, which already contains the reset time. Nothing is invented: if the
 * terminal did not print a time, this badge does not imply one.
 */
export function BlockedBadge({
  blocked,
  className,
}: {
  blocked?: { kind: string; text: string; detail?: string; wedge?: string }
  className?: string
}) {
  if (!blocked?.kind) return null
  const label = blocked.kind === 'limit' ? 'Limit reached' : wedgeLabel(blocked.wedge)
  return (
    <span
      role="status"
      title={[blocked.text, blocked.detail].filter(Boolean).join(' — ')}
      className={cn(
        // The same calm orange as `<ErrorPill>`: this is the same rung of bad
        // news (the agent cannot work) reached by a different road, and giving
        // it its own colour would imply a severity ladder that does not exist.
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-status-error/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-error',
        className,
      )}
    >
      <span aria-hidden>⚠</span>
      {label}
    </span>
  )
}

/** Which startup gate a wedged session is parked on, in words. Unknown wedges
 *  degrade to the honest generic rather than to silence — a session stuck before
 *  its first turn must never render as nothing. */
function wedgeLabel(wedge?: string): string {
  switch (wedge) {
    case 'trust':
      return 'Needs folder trust'
    case 'apikey':
      return 'Needs API key OK'
    case 'onboarding':
      return 'Needs first-run setup'
    case 'hooks-review':
      return 'Needs hook review'
    default:
      return 'Blocked at startup'
  }
}

/**
 * Usage headroom, from the opt-in statusline tap (`session.rate_limits`).
 *
 * DELIBERATELY QUIET, and only present at all when it has something to say:
 * below [`USAGE_FLOOR_PCT`] it renders nothing, because a roster of forty rows
 * each carrying `5h 3%` is forty pieces of furniture and zero information. Above
 * it, the number is the one signal that arrives BEFORE the block rather than
 * after it — the banner `<BlockedBadge>` reads is the post-mortem.
 *
 * The worse of the two buckets wins the chip: which window is about to run out
 * is what the user needs, and printing both turns a hint into a table.
 */
export function UsageChip({
  rateLimits,
  className,
}: {
  rateLimits?: RateLimits
  className?: string
}) {
  const worst = worstWindow(rateLimits)
  if (!worst) return null
  return (
    <span
      role="status"
      title={usageTitle(rateLimits)}
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums',
        worst.hot ? 'bg-status-error/15 text-status-error' : 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {worst.label} {Math.round(worst.pct)}%
    </span>
  )
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
  // "when can I work again", where the banner carried it. The reset clause is
  // the whole answer and it lives nowhere else on this plane — it rode in on
  // `last_assistant_message` and was discarded until the states fix.
  const reset = resetNote(classifyAgentError(error.message ?? '', error.type))
  return (
    <span
      role="status"
      title={[error.message, reset].filter(Boolean).join(' · ') || errorLabel(error.type)}
      className={cn(
        // Calm orange (--status-error) tint — visible enough to make a dead agent
        // obvious, never an alarmist red. Mirrors the needs-input pill geometry.
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-status-error/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-error-ink',
        className,
      )}
    >
      <span aria-hidden>⚠</span>
      {errorLabel(error.type, error.message)}
    </span>
  )
}

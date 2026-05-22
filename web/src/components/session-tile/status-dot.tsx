import { cn } from '@/lib/utils'
import type { SessionStatus } from '@/lib/api'

/** Status → semantic status color (M28 brand tokens in globals.css).
 *
 *  Five distinct colours, one per `Status` enum variant
 *  (`server/src/sessions/status.rs`): the dot must DIFFERENTIATE running /
 *  needs-input / idle-but-alive / stopped at a glance. Previously `idle` and
 *  `stopped` both mapped to the muted grey, so a session that just finished a
 *  turn looked identical to a powered-down one — the canonical "always grey"
 *  bug. `idle` now reads as the calm green "ready" tint (turn ended, agent
 *  alive, awaiting your next prompt); `stopped` keeps the muted grey reserved
 *  for "agent is off". */
const STATUS_COLOR: Record<SessionStatus, string> = {
  starting: 'bg-status-active',
  active: 'bg-status-active',
  waiting: 'bg-status-waiting',
  idle: 'bg-status-ready',
  stopped: 'bg-status-idle',
  error: 'bg-status-error',
}

/** Status → human label (sentence case, never UPPERCASE — BRAND voice). */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'Starting',
  active: 'Running',
  waiting: 'Needs input',
  idle: 'Idle',
  stopped: 'Stopped',
  error: 'Error',
}

/** 8×8 status dot (§4.3). A calm, readable anchor — the *pulse* lives on the
 *  tile border (see `<StatusBorder>`), not here, so the dot itself never moves. */
export function StatusDot({
  status,
  className,
}: {
  status: SessionStatus
  className?: string
}) {
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[status]}
      className={cn(
        'size-2 shrink-0 rounded-full',
        STATUS_COLOR[status],
        className,
      )}
    />
  )
}

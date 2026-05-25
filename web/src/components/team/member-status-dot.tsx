// MemberStatusDot — the leading status indicator for a teammate (AT-F-FRONT).
//
// The teammate analogue of <StatusDot> (session-tile/status-dot.tsx), mapping the
// AT-B derived MemberStatus → the SAME visual language the rest of the app uses,
// so a teammate reads at a glance next to the lead's session tile:
//   working  → amber spinner (reuses the `sm-status-spinner` keyframe — "busy,
//              hang on", the only dot that moves; spins even under Reduce Motion
//              because it's functional feedback, like StatusDot's loading state).
//   needs_you→ STATIC blue disc (calm; the LOUD blue signal is the `needs you`
//              pill on the chip trailing edge, never the dot — attention-first
//              keeps exactly one loud token).
//   idle     → STATIC green "ready" disc (turn ended, alive).
//   offline  → dim neutral disc (no live pane / shut down).
//
// Decorative + non-interactive (no 44pt rule). Footprint ≤ 14px.

import { cn } from '@/lib/utils'
import type { MemberStatus } from '@/lib/api/teams'

const LABEL: Record<MemberStatus, string> = {
  working: 'Working',
  needs_you: 'Needs you',
  idle: 'Idle',
  offline: 'Offline',
}

/** Static-disc colour token per non-working status (working renders the spinner). */
const DISC_COLOR: Record<Exclude<MemberStatus, 'working'>, string> = {
  needs_you: 'bg-status-waiting',
  idle: 'bg-status-ready',
  offline: 'bg-status-idle/60',
}

export function MemberStatusDot({
  status,
  className,
}: {
  status: MemberStatus
  className?: string
}) {
  if (status === 'working') {
    // Amber spinner — identical treatment to StatusDot's loading state so a
    // working teammate looks exactly like a running session. Pure CSS animation
    // (always rotates, incl. Reduce Motion: it's functional feedback).
    return (
      <span
        role="img"
        aria-label={LABEL.working}
        className={cn(
          'sm-status-spinner inline-block size-3 shrink-0 rounded-full border-2 border-transparent border-t-status-active',
          className,
        )}
      />
    )
  }
  return (
    <span
      role="img"
      aria-label={LABEL[status]}
      className={cn('size-2 shrink-0 rounded-full', DISC_COLOR[status], className)}
    />
  )
}

export { LABEL as MEMBER_STATUS_LABEL }

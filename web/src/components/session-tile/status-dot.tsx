import { motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import type { SessionStatus } from '@/lib/api'

/** Status → semantic status color (M28 brand tokens in globals.css).
 *
 *  Five distinct colours + one neutral booting tint, one per `Status` enum
 *  variant (`server/src/sessions/status.rs`): the dot must DIFFERENTIATE
 *  running / needs-input / idle-but-alive / stopped at a glance. `starting` is
 *  the short-lived boot window — neutral grey so it doesn't masquerade as
 *  active or needs-input. `idle` reads as the calm green "ready" tint (turn
 *  ended, agent alive, awaiting your next prompt); `stopped` keeps the muted
 *  grey reserved for "agent is off". */
const STATUS_COLOR: Record<SessionStatus, string> = {
  starting: 'bg-status-idle',
  active: 'bg-status-active',
  waiting: 'bg-status-waiting',
  idle: 'bg-status-ready',
  stopped: 'bg-status-idle',
  error: 'bg-status-error',
}

/** Status → human label (sentence case, never UPPERCASE — BRAND voice). */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'Booting',
  active: 'Running',
  waiting: 'Needs input',
  idle: 'Idle',
  stopped: 'Stopped',
  error: 'Error',
}

/** Decorative status indicator (§4.3). The "attention" pulse lives on the CARD
 *  (`<StatusBorder>`), NOT here — the dot is a static colour indicator. The one
 *  exception is `active`, where a tiny spinner replaces the disc because that IS
 *  the loading/working affordance (the "top-right loader icon"):
 *
 *  • `active` — Claude is thinking / the session is loading. A small circular
 *    spinner (slightly bigger than the resting dot) rotates at a calm cadence so
 *    the dot reads as "doing work" / "loading". This is the only dot that moves.
 *    The card stays calm (no glow) during this phase by design.
 *  • `waiting` — input is required. STATIC blue disc. The blue attention signal
 *    is the card glow (`<StatusBorder>` waiting pulse), not the dot — the dot
 *    just colours the state. (Earlier this pulsed; reverted to keep the pulse on
 *    the card so loading/done/needs-input read consistently at the card level.)
 *  • `idle` — the turn ended (done → green). STATIC green disc. The "ready"
 *    signal is the subtle green card glow (`<StatusBorder>` idle pulse); the dot
 *    just colours the state. (Earlier this pulsed green; reverted.)
 *  • `starting` — boot window. Static neutral-grey disc; the detector flips this
 *    to active/idle as soon as a real signal arrives.
 *  • everything else (`stopped`, `error`) — static disc, no motion.
 *
 *  Footprint stays ≤ 14px (8px dot + a 2px spinner ring) so it never
 *  dominates the tile. Reduced-motion users get the static disc + a thin
 *  outline so the active affordance still differentiates. The dot is
 *  decorative + non-interactive, so the 44pt tap-target rule does not apply. */
export function StatusDot({
  status,
  className,
}: {
  status: SessionStatus
  className?: string
}) {
  const reduce = useReducedMotion()

  // ── Thinking spinner (active). A 12px conic-gradient disc that rotates ────
  //
  // Slightly bigger than the resting dot, with the brand amber as the visible
  // sweep and transparent as the tail — the "loading" semantic without
  // wrestling SVG. Reduced-motion: a static ringed dot (foreground stays
  // amber, the ring tells the user "doing work" without the rotation).
  if (status === 'active') {
    if (reduce) {
      return (
        <span
          role="img"
          aria-label={STATUS_LABEL.active}
          className={cn(
            'inline-block size-3 shrink-0 rounded-full bg-status-active ring-2 ring-status-active/30',
            className,
          )}
        />
      )
    }
    // Border-trick spinner: a 12px ring whose top arc is amber and the rest is
    // transparent. Rotating the whole element makes the amber arc sweep —
    // canonical "tiny spinner" without an SVG dep, ≤ 14px footprint.
    return (
      <motion.span
        role="img"
        aria-label={STATUS_LABEL.active}
        className={cn(
          // Top border carries the active color; left + right + bottom stay
          // transparent so we read an arc, not a full ring. Brand status token
          // drives the visible sweep.
          'inline-block size-3 shrink-0 rounded-full border-2 border-transparent border-t-status-active',
          className,
        )}
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}
      />
    )
  }

  // ── Static colour discs (waiting, idle, starting, stopped, error) ─────────
  //
  // The pulse/halo now lives on the CARD (`<StatusBorder>`), so the dot is a
  // plain static colour indicator for every non-active state:
  //   • waiting → blue disc  (card carries the blue "needs input" pulse)
  //   • idle    → green disc  (card carries the subtle green "ready" glow)
  //   • starting → neutral-grey disc (boot window)
  //   • stopped/error → muted / orange disc
  // Earlier (4f2bc52) the waiting + idle dots pulsed a halo; reverted here so a
  // single, consistent attention model lives at the card level. STATUS_COLOR
  // maps each status to its `bg-status-*` token.
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

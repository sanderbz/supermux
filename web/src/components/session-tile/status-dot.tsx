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

/** Decorative status indicator (§4.3). Three motion modes, scoped to the dot
 *  itself (not the tile border):
 *
 *  • `active` — Claude is thinking. A small circular spinner (slightly bigger
 *    than the resting dot) rotates at a calm cadence so the dot reads as
 *    "doing work" without competing for attention with the agent's own
 *    streaming text. The amber border pulse on `<StatusBorder>` keeps the
 *    full-card glance.
 *  • `waiting` — input is required. The dot pulses a calm BLUE halo (2.2s) to
 *    draw the user's eye to the tile that needs them. Distinct from the green
 *    "done" pulse below by colour, so the user can tell "needs input" from
 *    "finished" at a glance.
 *  • `idle` — the turn ended: the agent has finished and is awaiting your next
 *    prompt. The green "ready" dot pulses a calm GREEN halo (2.4s) so a freshly
 *    finished session announces itself ("something is ready"). Because `idle`
 *    only follows the boot/active window, the pulse appears AFTER loading
 *    completes — never while grey/booting. Reduced motion: static green dot.
 *  • `starting` — boot window. NO dot pulse: the loading icon/sweep elsewhere
 *    on the tile already signals "booting", so an extra dot pulse here is too
 *    much. Just a static neutral-grey disc; the detector flips this to
 *    active/idle as soon as a real signal arrives.
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

  // ── Needs-input pulse (waiting). Spring-driven opacity + halo ─────────────
  //
  // The dot itself pulses at the calm `waiting` cadence (2.2s) — same family
  // as the prior border pulse, just relocated to the dot so the motion lives
  // at the user-action affordance. Reduced motion: static blue dot with a soft
  // halo ring so the "needs you" weight still reads.
  if (status === 'waiting') {
    if (reduce) {
      return (
        <span
          role="img"
          aria-label={STATUS_LABEL.waiting}
          className={cn(
            'size-2 shrink-0 rounded-full bg-status-waiting ring-2 ring-status-waiting/40',
            className,
          )}
        />
      )
    }
    return (
      <motion.span
        role="img"
        aria-label={STATUS_LABEL.waiting}
        className={cn(
          'size-2 shrink-0 rounded-full bg-status-waiting',
          className,
        )}
        animate={{
          // Halo grows + fades to draw the eye; the inner disc stays solid.
          boxShadow: [
            '0 0 0 0 hsl(var(--status-waiting) / 0.55)',
            '0 0 0 6px hsl(var(--status-waiting) / 0)',
          ],
        }}
        transition={{
          repeat: Infinity,
          duration: 2.2,
          ease: 'easeOut',
        }}
      />
    )
  }

  // ── Done / ready pulse (idle). Spring-driven GREEN halo ───────────────────
  //
  // `idle` is the "turn ended" state: the agent has finished and is awaiting
  // your next prompt. A calm green halo pulse (2.4s) makes a freshly finished
  // session announce itself — the "something is ready" signal. Because `idle`
  // only follows the boot/active window, this pulse appears AFTER loading
  // completes (never while grey/booting). Same halo family as the blue waiting
  // pulse but with the green `--status-ready` token + a slightly slower cadence,
  // so "done" stays visually distinct from "needs input". Reduced motion:
  // static green dot (no pulse).
  if (status === 'idle') {
    if (reduce) {
      return (
        <span
          role="img"
          aria-label={STATUS_LABEL.idle}
          className={cn(
            'size-2 shrink-0 rounded-full bg-status-ready',
            className,
          )}
        />
      )
    }
    return (
      <motion.span
        role="img"
        aria-label={STATUS_LABEL.idle}
        className={cn(
          'size-2 shrink-0 rounded-full bg-status-ready',
          className,
        )}
        animate={{
          // Green halo grows + fades; the inner disc stays solid.
          boxShadow: [
            '0 0 0 0 hsl(var(--status-ready) / 0.55)',
            '0 0 0 6px hsl(var(--status-ready) / 0)',
          ],
        }}
        transition={{
          repeat: Infinity,
          duration: 2.4,
          ease: 'easeOut',
        }}
      />
    )
  }

  // ── Resting states (starting, stopped, error) — static disc, no motion ────
  //
  // `starting` no longer pulses: the loading icon/sweep elsewhere on the tile
  // already signals "booting", so an extra dot pulse here is too much. It just
  // shows the neutral-grey disc until the detector flips it to active/idle.
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

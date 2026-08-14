/**
 * The three-dot wave — "something is happening, and it is not finished".
 * ─────────────────────────────────────────────────────────────────────────────
 * 5px dots, 4px apart, `currentColor`, each fading .28 → 1 on a 1.25s loop with
 * 0.16s / 0.32s stagger (the approved mockup's `blip`). It reads as one travelling
 * highlight rather than three blinking lights.
 *
 * DEVIATION: master plan §4.2 P7 specified a 1.3s wave with base opacities
 * .25/.45/.7. The approved render supersedes it, and one dot grammar across the
 * working row and the delegation pill beats two that differ by 50ms.
 *
 * The animation is CSS, not framer-motion, for the same reason the mark's
 * breathe is: it is ambient and uninterruptible, there is no state to spring
 * between, and a rAF-driven opacity loop on a scrolling transcript is pure cost.
 * `prefers-reduced-motion` stills it (see `.sm-dots` in globals.css).
 */
import { cn } from '../../../lib/utils'

export function Dots({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('sm-dots flex gap-1 pl-0.5', className)}>
      <i />
      <i />
      <i />
    </span>
  )
}

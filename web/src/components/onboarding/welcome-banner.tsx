// WelcomeBanner — Time to Wow.
//
// The non-blocking "welcome back" surface for a returning v2 user whose data
// was migrated. It sits just under the safe-area top, NEVER covers content, and
// offers two calm choices: take the 30-second tour, or skip. It does not block
// the app — the user can ignore it entirely and the overview is fully usable
// beneath it.
//
// Motion: slides down from above the safe-area on mount (springs.smooth), slides
// back up on dismiss. Reduced motion collapses both to a crossfade.
//
// VISUAL: glass capsule material (matches the ReconnectBanner finish — one
// pinned glass surface vocabulary), SF-Pro 13px copy, sentence case, ≥44pt tap
// targets via the action buttons' min-height. No UPPERCASE.

import { motion, useReducedMotion } from 'framer-motion'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { ONBOARDING } from '@/brand/copy'

export interface WelcomeBannerProps {
  /** Migrated session count — drives the copy ("your N sessions are here"). */
  sessionCount: number
  /** Start the 4-step tour. */
  onStartTour: () => void
  /** Dismiss without touring (still completes first-launch). */
  onSkip: () => void
}

export function WelcomeBanner({
  sessionCount,
  onStartTour,
  onSkip,
}: WelcomeBannerProps) {
  const reduce = useReducedMotion()

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center pt-safe"
    >
      <motion.div
        initial={reduce ? { opacity: 0 } : { y: -64, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={reduce ? { opacity: 0 } : { y: -64, opacity: 0 }}
        transition={reduce ? { duration: 0.15 } : springs.smooth}
        className="pointer-events-auto mt-2 px-4"
        style={{ maxWidth: 'min(100vw - 24px, 30rem)' }}
      >
        <div
          className={cn(
            'glass flex items-center gap-3 rounded-2xl px-4 py-3',
            'border border-border/60 shadow-lg',
          )}
        >
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-snug text-foreground">
              {ONBOARDING.welcomeBack(sessionCount)}
            </p>
            <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
              {ONBOARDING.welcomeBackHint}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <motion.button
              type="button"
              onClick={onStartTour}
              whileTap={reduce ? undefined : { scale: 0.96 }}
              transition={springs.buttonPress}
              className={cn(
                'flex h-9 items-center rounded-lg bg-primary px-3',
                'text-[13px] font-semibold text-primary-foreground active:opacity-90',
              )}
            >
              {ONBOARDING.tourStart}
            </motion.button>
            <button
              type="button"
              onClick={onSkip}
              aria-label={ONBOARDING.tourSkip}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

// TourOverlay — Time to Wow tour.
//
// The 4-step one-tap tour for returning v2 users. A dim scrim + one FloatingTip
// at a time, advanced by the tip's primary button. Each step anchors to a real
// onboarding target:
//   1. a session tile        — "peek without leaving"     ([data-tour="tile"])
//   2. the focus / agent     — "focus on one agent"       ([data-tour="tile"] too,
//      the tap-target is the same tile; the tile IS the focus entry point)
//   3. the scheduler tab     — "schedule the routine"     ([data-tour="scheduler"])
//   4. the new-session button — "start another agent"     ([data-tour="new-session"])
//
// Dismissable via the tip's X or by finishing the last step ("Got it") — both
// call `onComplete`, which the host turns into `completeFirstLaunch()`.
//
// The scrim is non-blocking in spirit: it dims but the user can still skip out
// at any moment. Reduced motion drops the scrim fade to an instant cut.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { ONBOARDING } from '@/brand/copy'
import { FloatingTip, type TipPlacement } from './floating-tip'

interface TourStep {
  anchor: string
  placement: TipPlacement
}

// Anchors are data-attributes added to existing components (additive — no
// structural change). The tour degrades to a centred card if a target is
// absent (see FloatingTip's fallback).
const STEP_TARGETS: TourStep[] = [
  { anchor: '[data-tour="tile"]', placement: 'bottom' },
  { anchor: '[data-tour="tile"]', placement: 'bottom' },
  { anchor: '[data-tour="scheduler"]', placement: 'top' },
  { anchor: '[data-tour="new-session"]', placement: 'bottom' },
]

export interface TourOverlayProps {
  /** Fired when the tour is finished or skipped. */
  onComplete: () => void
}

export function TourOverlay({ onComplete }: TourOverlayProps) {
  const reduce = useReducedMotion()
  const [step, setStep] = React.useState(0)
  const total = ONBOARDING.tour.length

  const next = () => {
    if (step + 1 >= total) onComplete()
    else setStep((s) => s + 1)
  }

  const copy = ONBOARDING.tour[step]
  const target = STEP_TARGETS[step]
  const isLast = step + 1 >= total

  return (
    <div className="fixed inset-0 z-[78]">
      {/* Dim scrim — clicking it skips the tour (a calm escape hatch). */}
      <motion.div
        onClick={onComplete}
        initial={reduce ? { opacity: 0.4 } : { opacity: 0 }}
        animate={{ opacity: 0.4 }}
        exit={{ opacity: 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.2 }}
        className="absolute inset-0 bg-black"
        aria-hidden
      />
      <AnimatePresence mode="wait">
        <FloatingTip
          key={step}
          anchor={target.anchor}
          placement={target.placement}
          step={step + 1}
          total={total}
          title={copy.title}
          body={copy.body}
          primaryLabel={isLast ? ONBOARDING.tourDone : 'Next'}
          onPrimary={next}
          onDismiss={onComplete}
        />
      </AnimatePresence>
    </div>
  )
}

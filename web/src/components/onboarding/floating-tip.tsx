// FloatingTip — Time to Wow tour.
//
// A single coach-mark card in the 4-step unboxing tour. Each tip is anchored to
// a real onboarding target by a CSS selector — at mount it measures that
// element's bounding box and parks the card beside it, with a small pointer
// triangle aimed at the anchor. If the anchor isn't on screen (e.g. the focus
// button only exists once a session is open) the tip falls back to a centred
// position so the tour never strands the user on a blank pointer.
//
// Motion: springs.cardExpand in / out via the parent's <AnimatePresence>; the
// pointer + card are one surface so the morph stays coherent. Reduced motion
// collapses the entrance to an opacity crossfade.
//
// VISUAL: opaque card material (not glass — coach-marks must stay legible over
// any background), sentence-case copy, ≥44pt buttons (comfortable hit targets),
// brand-tinted step pips. No UPPERCASE, no `transition: all`.

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'

/** Where the card sits relative to its anchor. */
export type TipPlacement = 'top' | 'bottom' | 'left' | 'right'

export interface FloatingTipProps {
  /** CSS selector for the anchored element. First match wins. */
  anchor: string
  placement: TipPlacement
  /** 1-based index + total, for the "1 of 3" progress affordance. */
  step: number
  total: number
  title: string
  body: string
  /** Primary button label — "Next" mid-tour, "Got it" on the last step. */
  primaryLabel: string
  onPrimary: () => void
  /** Dismiss the whole tour. */
  onDismiss: () => void
}

interface AnchorRect {
  top: number
  left: number
  width: number
  height: number
}

const CARD_W = 280
const GAP = 12 // px between anchor and card
/** Minimum breathing room between the card and the viewport edge, ON TOP of the
 *  device's safe-area inset. */
const EDGE = 12
/** Only used for the no-anchor fallback's vertical centring. */
const CARD_H_ESTIMATE = 220
/** A side has "room" once it can show the card without scrolling its body. */
const MIN_FIT = 200

/** The device's safe-area insets in px. Evaluated by the engine rather than
 *  guessed: a throwaway fixed element is given `env()` paddings and its computed
 *  style read back. 0 on every desktop browser, ~47–59px top on a notched iPhone
 *  in standalone. Measured per call — the tour mounts once, and rotation changes
 *  the answer. */
function safeInsets(): { top: number; bottom: number } {
  if (typeof document === 'undefined') return { top: 0, bottom: 0 }
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)'
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const insets = {
    top: Number.parseFloat(cs.paddingTop) || 0,
    bottom: Number.parseFloat(cs.paddingBottom) || 0,
  }
  probe.remove()
  return insets
}

/** Measure the anchor element; re-measures on resize + scroll so the card
 *  tracks it. Returns `null` until measured (or if the anchor is absent).
 *
 *  Picks the first VISIBLE match — `data-tour` anchors live on both the desktop
 *  side-nav and the mobile bottom-nav for the same nav slot (e.g. "scheduler"),
 *  and `display:none` from the wrong-breakpoint copy still satisfies
 *  `querySelector`, returning an all-zero rect that parks the card off-screen.
 *  Skipping zero-size matches falls through to the visible one (or to the
 *  centred-card fallback when none is on screen). */
function useAnchorRect(selector: string): AnchorRect | null {
  const [rect, setRect] = React.useState<AnchorRect | null>(null)

  React.useEffect(() => {
    let raf = 0
    const measure = () => {
      const els = document.querySelectorAll(selector)
      for (const el of els) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
          return
        }
      }
      setRect(null)
    }
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    schedule()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    // A short retry: the tour may mount a frame before the target paints.
    const retry = window.setTimeout(schedule, 120)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(retry)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [selector])

  return rect
}

/** Clamp `n` into `[lo, hi]`. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

/**
 * Compute the card's fixed-position style from the anchor rect. Falls back to
 * screen-centre when no anchor was found.
 *
 * VIEWPORT COLLISION IS THE POINT, and it is solved WITHOUT measuring the card.
 * The earlier version parked a `top`-placed card by its BOTTOM edge
 * (`bottom: vh - top`) and clamped only the anchor-derived coordinate, so a card
 * taller than the space above its anchor grew straight off the screen. Measured:
 * tour step 3 (Settings, placement 'top') landed at top −24.3 at 1440×900 and
 * −13.0 at 1280×700 — the dismiss ✕ clipped away, the tip covering the page
 * title.
 *
 * The rule now: pick the side of the anchor with room (the requested one when it
 * has at least `MIN_FIT`, otherwise the roomier one), then hand the card a
 * `maxHeight` equal to the space actually available on that side. The card is
 * on-screen BY CONSTRUCTION rather than by a height guess that goes stale the
 * moment the copy changes — and long copy scrolls inside the card instead of
 * escaping the viewport. Bounds include the device safe-area insets, so a
 * notched iPhone never puts the ✕ under the Dynamic Island.
 */
function position(
  rect: AnchorRect | null,
  placement: TipPlacement,
): { style: React.CSSProperties; centred: boolean } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const insets = safeInsets()
  const top0 = EDGE + insets.top // highest the card may reach
  const bottom0 = vh - EDGE - insets.bottom // lowest the card may reach
  const minLeft = EDGE
  const maxLeft = Math.max(minLeft, vw - EDGE - CARD_W)

  if (!rect) {
    return {
      style: {
        left: clamp(vw / 2 - CARD_W / 2, minLeft, maxLeft),
        top: clamp(vh / 2 - CARD_H_ESTIMATE / 2, top0, Math.max(top0, bottom0)),
        maxHeight: Math.max(0, bottom0 - top0),
      },
      centred: true,
    }
  }

  const spaceAbove = rect.top - GAP - top0
  const spaceBelow = bottom0 - (rect.top + rect.height + GAP)
  const wants = placement === 'top' || placement === 'left' ? 'above' : 'below'
  const side =
    wants === 'above'
      ? spaceAbove >= MIN_FIT || spaceAbove >= spaceBelow
        ? 'above'
        : 'below'
      : spaceBelow >= MIN_FIT || spaceBelow >= spaceAbove
        ? 'below'
        : 'above'

  let left = rect.left + rect.width / 2 - CARD_W / 2
  if (placement === 'left') left = rect.left - CARD_W - GAP
  if (placement === 'right') left = rect.left + rect.width + GAP

  const style: React.CSSProperties =
    side === 'above'
      ? {
          left: clamp(left, minLeft, maxLeft),
          // Anchored by its BOTTOM edge, but bounded: `maxHeight` is exactly the
          // room between the safe top and the anchor, so the top edge cannot
          // cross `top0`.
          bottom: vh - (rect.top - GAP),
          maxHeight: Math.max(0, spaceAbove),
        }
      : {
          left: clamp(left, minLeft, maxLeft),
          top: rect.top + rect.height + GAP,
          maxHeight: Math.max(0, spaceBelow),
        }
  return { style, centred: false }
}

export function FloatingTip({
  anchor,
  placement,
  step,
  total,
  title,
  body,
  primaryLabel,
  onPrimary,
  onDismiss,
}: FloatingTipProps) {
  const reduce = useReducedMotion()
  const rect = useAnchorRect(anchor)
  const { style } = React.useMemo(
    () => position(rect, placement),
    [rect, placement],
  )

  return (
    <motion.div
      role="dialog"
      aria-label={`Tour step ${step} of ${total}: ${title}`}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 4 }}
      transition={reduce ? { duration: 0.14 } : springs.cardExpand}
      style={{ position: 'fixed', width: CARD_W, ...style }}
      className={cn(
        'z-[80] overflow-y-auto overscroll-contain rounded-2xl border border-hairline',
        'bg-card p-4 shadow-xl',
        'pointer-events-auto',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-1.5" aria-hidden>
          {Array.from({ length: total }).map((_, i) => (
            <span
              key={i}
              className={cn(
                'h-1.5 rounded-full transition-[width,background-color] duration-200',
                i + 1 === step
                  ? 'w-4 bg-primary'
                  : 'w-1.5 bg-muted-foreground/30',
              )}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Skip the tour"
          className="-m-2 flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <h3 className="mt-2.5 text-[15px] font-semibold tracking-tight">
        {title}
      </h3>
      <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
        {body}
      </p>

      <div className="mt-3.5 flex items-center justify-between gap-3">
        <span className="text-[12px] text-muted-foreground">
          {step} of {total}
        </span>
        <motion.button
          type="button"
          onClick={onPrimary}
          whileTap={reduce ? undefined : { scale: 0.96 }}
          transition={springs.buttonPress}
          className={cn(
            'flex h-11 min-w-[5rem] items-center justify-center rounded-xl px-4',
            'bg-primary text-[14px] font-semibold text-primary-foreground',
            'active:opacity-90',
          )}
        >
          {primaryLabel}
        </motion.button>
      </div>
    </motion.div>
  )
}

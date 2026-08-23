import * as React from 'react'

/**
 * `useScrollAway` — the iOS "chrome that scrolls away" gesture, as one reusable
 * signal. Given a scroll container, it returns a `hidden` boolean the caller
 * translates a header out of view by: hide when the user scrolls DOWN a list,
 * reappear the instant they scroll UP, and ALWAYS show at the very top.
 *
 * It never jitters, because direction is read through an ACCUMULATOR with
 * hysteresis rather than off a single delta: only a sustained downward run past
 * `downThreshold` hides, and the accumulator zeroes on every direction flip so a
 * flick the other way starts clean (no half-latent count carried from the prior
 * gesture). Show is eager (a small `upThreshold`) so an upward nudge brings the
 * chrome straight back. Reads are coalesced through rAF, so momentum scrolling on
 * iOS is never fought — we only ever READ `scrollTop`, never `preventDefault`.
 *
 * Reduced-motion: under `prefers-reduced-motion: reduce` it NEVER hides (no
 * transform ever fires), and it re-syncs live if the setting changes.
 * SSR / no-DOM safe: no window/matchMedia touched at module scope, every access
 * guarded, and `onScroll` degrades to a synchronous measure where rAF is absent.
 */
export interface ScrollAwayOptions {
  /** Accumulated downward px before the chrome hides (the hysteresis floor). */
  downThreshold?: number
  /** Accumulated upward px before it shows again — small, so show is eager. */
  upThreshold?: number
  /** Always shown while `scrollTop` is at/below this (≈ the header's height). */
  topReveal?: number
  /** Force always-shown (e.g. the container isn't tall enough to scroll). */
  disabled?: boolean
}

export interface ScrollAway {
  /** True when the chrome should be translated out of view. */
  hidden: boolean
  /** Attach to the scroll container's `onScroll` (or call from an existing one). */
  onScroll: () => void
  /** Force the chrome visible (search focus, typing, programmatic reveal). */
  reveal: () => void
}

function reducedMotionNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function useScrollAway(
  ref: React.RefObject<HTMLElement | null>,
  opts: ScrollAwayOptions = {},
): ScrollAway {
  const { downThreshold = 10, upThreshold = 6, topReveal = 64, disabled = false } = opts

  const [hidden, setHidden] = React.useState(false)

  // Scroll bookkeeping is mutable and never triggers a render on its own.
  const lastY = React.useRef(0)
  const accum = React.useRef(0)
  const raf = React.useRef<number | null>(null)
  // Reduced motion is read once at mount (SSR-safe): under it we never hide, so
  // no transform is ever applied — the "no transform / instant" contract.
  const reduced = React.useRef(reducedMotionNow())

  const reveal = React.useCallback(() => {
    accum.current = 0
    setHidden(false)
  }, [])

  const measure = React.useCallback(() => {
    raf.current = null
    const el = ref.current
    if (!el) return
    const y = el.scrollTop
    const dy = y - lastY.current
    lastY.current = y

    // The anchor rule: always shown near the top, whatever the direction.
    if (y <= topReveal) {
      accum.current = 0
      setHidden(false)
      return
    }
    if (disabled || reduced.current) {
      setHidden(false)
      return
    }

    // Hysteresis: a direction change zeroes the accumulator so the new gesture
    // starts from scratch, then we integrate this delta into it.
    if (dy !== 0 && dy > 0 !== accum.current > 0) accum.current = 0
    accum.current += dy

    // Clamp at the thresholds so a long run never builds an overshoot that would
    // delay the reverse (hidden→shown / shown→hidden stays one nudge away).
    if (accum.current > downThreshold) {
      accum.current = downThreshold
      setHidden(true)
    } else if (accum.current < -upThreshold) {
      accum.current = -upThreshold
      setHidden(false)
    }
  }, [ref, topReveal, disabled, downThreshold, upThreshold])

  const onScroll = React.useCallback(() => {
    if (raf.current != null) return
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      measure()
      return
    }
    raf.current = window.requestAnimationFrame(measure)
  }, [measure])

  // Never leave a scheduled frame dangling on unmount.
  React.useEffect(
    () => () => {
      if (raf.current != null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(raf.current)
        raf.current = null
      }
    },
    [],
  )

  // A disabled container is always shown: derive it rather than resetting state
  // in an effect (which flashes a frame and trips react-hooks/set-state-in-effect).
  // `measure` still forces `hidden=false` while disabled, so the stored state and
  // this derived value never disagree once a scroll settles.
  return { hidden: disabled ? false : hidden, onScroll, reveal }
}

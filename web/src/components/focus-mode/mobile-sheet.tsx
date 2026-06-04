// MobileSheet — mobile HERO interaction (see
// research/termius-ios-native-spec.md §"Apple Maps — Detail card pull-up",
// §"v3 finish acceptance criteria" #8/#9/#10/#11).
//
// The marquee iOS-native gesture: a bottom-sheet over the LiveTerminal with
// two detents — peek (40%) and full (100%) — that you DRAG through with spring
// physics. The snap matches Apple's sheet feel `.spring(response:0.45,
// dampingFraction:0.82)` (= our `springs.sheetDetent`, stiffness 280 / damping
// 30); the over-drag above full rubber-bands via Apple's bungee formula
// `(x·d·c)/(d+c·x)` with `c=0.55`; a downward fling > 1200 px/s dismisses; and a
// drag-down past peek dismisses to the overview (v1 only went to peek).
//
// Layered drag-down semantics:
//   • at FULL, drag down  → snap to PEEK (sequential).
//   • at PEEK, drag down past it → DISMISS → navigate('/') (overview).
//   • fling > 1200 px/s downward from any detent → DISMISS.
//
// Built on framer-motion (already the app's spring source). The sheet is the
// whole focus surface — nothing meaningful sits behind it — so it does NOT use
// Vaul: no portal, no modal/scrim, no third party fighting us for the same
// pixels. Dropping Vaul also drops two compounding issues: (1) Vaul's
// `windowDimensions = { innerHeight }` snapshot, which goes stale on Android
// Chrome under `interactive-widget=resizes-content` and locks the drawer at the
// keyboard-open shrunken size; and (2) Vaul's unconditional
// `setPointerCapture()` in onPress that ate one-finger touch-scroll inside the
// terminal until we patched around it with `e.stopPropagation()` in the route.
//
// Drag-init is gated on `[data-sheet-no-drag]` (the terminal body) via a
// `target.closest()` check. Inside no-drag regions we never call
// `setPointerCapture`, so native pan-y survives and xterm's own touch
// scrollback works on one finger. Outside, we use tap-vs-drag disambiguation
// (capture only after the pointer travels > 4 px) so taps on header buttons
// still produce clicks.
//
// Visual: glass material (regularMaterial analogue), 10px continuous top corners
// (Apple Maps spec), 36×5 drag indicator (Termius #11), Reduce-Transparency /
// Reduce-Motion fallbacks inherited from the `.glass` utility + the spring tokens.

import * as React from 'react'
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { PEEK, VELOCITY_DISMISS, rubberBand } from './detents'

/** Drag past the PEEK detent by this fraction of the peek travel → DISMISS
 *  commit (Termius #10 "drag-down past peek = overview"). */
const CLOSE_THRESHOLD = 0.22

/** Pointer travel threshold before a touch is reclassified from "tap" to
 *  "drag" — below it, we don't `setPointerCapture` so button clicks inside the
 *  sheet still register. Matches typical iOS pan-vs-tap slop. */
const DRAG_SLOP_PX = 4

export interface MobileSheetProps {
  /** Dismiss → return to overview. */
  onDismiss: () => void
  /** Explicit content height in px, driven by `useKeyboardViewport` so the sheet
   *  shrinks to sit DIRECTLY above the soft keyboard (the visualViewport height)
   *  rather than fighting the browser's "scroll the whole page" fallback. When
   *  null/undefined the CSS `100dvh` height governs (keyboard closed). We set
   *  height as a plain CSS property and animate via a CSS `transition` so it
   *  never collides with the drag `transform` framer-motion is writing. */
  contentHeight?: number | null
  /** Pixels the soft keyboard overlaps the bottom of the layout viewport. Lifts
   *  the `bottom-0` sheet UP by this much so its bottom edge sits at the keyboard
   *  TOP (not behind it). 0 when the keyboard is closed. */
  keyboardInset?: number
  children: React.ReactNode
}

export function MobileSheet({
  onDismiss,
  contentHeight,
  keyboardInset = 0,
  children,
}: MobileSheetProps) {
  const reduceMotion = useReducedMotion()

  // The sheet's vertical drag offset, in px:
  //   y = 0           → FULL detent (sheet covers the whole viewport)
  //   y = peekOffset  → PEEK detent (sheet pushed down, bottom 40% visible)
  //   y < 0           → over-drag above FULL (rubber-banded via Apple's bungee)
  // We translate via this motion value rather than animating `height` or
  // `bottom` — the keyboard-driven CSS transition needs the latter two free.
  const y = useMotionValue(0)

  // Detent math keys off the layout viewport. We refresh on `resize` so
  // browser-chrome show/hide and orientation changes re-anchor the detents.
  // (Keyboard-driven changes do NOT shrink the layout viewport on iOS — they
  // are handled separately via `contentHeight` — and on Android they are the
  // bug we're fixing elsewhere, not something this component should track.)
  const [vh, setVh] = React.useState<number>(() =>
    typeof window === 'undefined' ? 800 : window.innerHeight,
  )
  React.useEffect(() => {
    const onResize = () => setVh(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const peekOffset = vh * (1 - PEEK)
  const dismissOffset = peekOffset + peekOffset * CLOSE_THRESHOLD

  // Pointer-drag state. We use plain pointer events (not framer's `drag`) so
  // we own the rubber-band math, the velocity sampling, and the tap-vs-drag
  // disambiguation — and so we don't trigger framer's own auto-snap-to-
  // constraints fight with our `animate()` calls on release.
  const drag = React.useRef<{
    pointerId: number
    startClientY: number
    startY: number
    captured: boolean
    samples: Array<{ y: number; t: number }>
  } | null>(null)

  const snap = React.useCallback(
    (target: number) =>
      animate(y, target, reduceMotion ? { duration: 0 } : springs.sheetDetent),
    [y, reduceMotion],
  )

  const releaseDrag = React.useCallback(
    (target: HTMLElement, pointerId: number) => {
      try {
        target.releasePointerCapture(pointerId)
      } catch {
        /* the browser already released — harmless */
      }
    },
    [],
  )

  const resolveRelease = React.useCallback(
    (
      offset: number,
      samples: ReadonlyArray<{ y: number; t: number }>,
    ): { kind: 'dismiss' } | { kind: 'snap'; to: number } => {
      // Velocity from the most recent ≤100ms of samples — matches the iOS
      // gesture recognizer window so a brief deceleration before lift doesn't
      // hide an earlier fling.
      let velocity = 0
      if (samples.length >= 2) {
        const last = samples[samples.length - 1]
        const earliest =
          [...samples].reverse().find((s) => last.t - s.t > 100) ?? samples[0]
        const dt = Math.max(1, last.t - earliest.t)
        velocity = ((last.y - earliest.y) / dt) * 1000 // px/s, + = downward
      }
      if (velocity > VELOCITY_DISMISS) return { kind: 'dismiss' }
      if (offset > dismissOffset) return { kind: 'dismiss' }
      // snapToSequentialPoint: from FULL the nearest detent down is PEEK; from
      // PEEK the nearest up is FULL. Halfway between picks the closer one and
      // never skips straight to dismiss (velocity is the only express lane).
      return { kind: 'snap', to: offset > peekOffset / 2 ? peekOffset : 0 }
    },
    [dismissOffset, peekOffset],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Gating: a touch that starts inside the terminal (or any other no-drag
    // region) MUST fall through to native handling — both so xterm's own scroll
    // works on one finger and so dock buttons receive their click. We use
    // `closest()` rather than relying on `data-sheet-no-drag` being on the
    // direct target so any descendant of a no-drag region is also exempt.
    const target = e.target as Element | null
    if (target?.closest('[data-sheet-no-drag]')) return
    // Right-click / middle-click never starts a drag.
    if (e.pointerType === 'mouse' && e.button !== 0) return

    drag.current = {
      pointerId: e.pointerId,
      startClientY: e.clientY,
      startY: y.get(),
      captured: false,
      samples: [{ y: e.clientY, t: e.timeStamp }],
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return

    const delta = e.clientY - d.startClientY

    // Upgrade tap → drag once the pointer leaves the slop circle. Capture is
    // deferred until this moment so a tap that never moves still produces a
    // click on the underlying button (header back, title, Claude tools).
    if (!d.captured && Math.abs(delta) >= DRAG_SLOP_PX) {
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* element no longer in DOM — drag will end naturally on next event */
      }
      d.captured = true
    }

    if (d.captured) {
      let next = d.startY + delta
      // Apple's bungee resistance only above FULL (over-drag up).
      if (next < 0) next = -rubberBand(-next, vh, 0.55)
      y.set(next)
    }

    d.samples.push({ y: e.clientY, t: e.timeStamp })
    if (d.samples.length > 6) d.samples.shift()
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    drag.current = null

    // Pure tap (never crossed the slop) — leave the underlying element to
    // handle the click. The sheet stays put.
    if (!d.captured) return

    releaseDrag(e.currentTarget as HTMLElement, e.pointerId)

    const verdict = resolveRelease(y.get(), d.samples)
    if (verdict.kind === 'dismiss') {
      onDismiss()
      return
    }
    snap(verdict.to)
  }

  // Cancel (browser stole the pointer for a native gesture, element detached,
  // multi-touch interrupt) — never dismisses, just snaps back to the nearest
  // detent so the sheet doesn't end up wedged mid-drag.
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    drag.current = null
    if (!d.captured) return
    releaseDrag(e.currentTarget as HTMLElement, e.pointerId)
    const offset = y.get()
    snap(offset > peekOffset / 2 ? peekOffset : 0)
  }

  return (
    <motion.div
      data-testid="focus-sheet"
      role="dialog"
      aria-labelledby="focus-sheet-title"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        y,
        // Keyboard-driven height + lift. We set these as CSS properties (NOT
        // via framer's animate target) so the 0.28s cubic-bezier transition
        // animates `height` and `bottom` only — never `transform`, which `y`
        // owns. When `contentHeight` is null (keyboard closed) the CSS
        // `h-dvh` className below governs height and `bottom-0` pins the foot.
        ...(contentHeight != null
          ? {
              height: contentHeight,
              bottom: keyboardInset,
              transition:
                'height 0.28s cubic-bezier(0.32, 0.72, 0, 1), bottom 0.28s cubic-bezier(0.32, 0.72, 0, 1)',
            }
          : undefined),
      }}
      className={cn(
        'fixed inset-x-0 bottom-0 z-50 flex h-dvh flex-col',
        // 10px continuous top corners (Apple Maps), glass regularMaterial.
        'rounded-t-[10px] border-t border-border/60 outline-none',
        // No `pt-safe` here: the FocusHeader (first real child of the
        // sheet) carries its OWN pt-safe so the safe-area inset resolves
        // against the header itself rather than the sheet. This survives the
        // swipe-peek motion.div's transform (which creates a containing block
        // above this sheet) and the View Transition morph (the UA pseudo-
        // element inherits the header layout). Single source of safe-area,
        // matching the desktop Layout/MobileTopBar pattern.
        'glass',
      )}
    >
      <h2 id="focus-sheet-title" className="sr-only">
        Focus session
      </h2>
      {/* Drag indicator — 36×5, 2.5px radius, tertiary tint, 6px from top
          (Termius #11 / Apple Maps). `touch-none` so the handle itself never
          loses our pointerdown to a native pan attempt. */}
      <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 touch-none rounded-[2.5px] bg-muted-foreground/30" />
      {children}
    </motion.div>
  )
}

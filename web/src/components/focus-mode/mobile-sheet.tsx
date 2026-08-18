// MobileSheet — mobile focus-mode layout wrapper.
//
// Used to be a Vaul drag-detent drawer with Apple Maps-style chrome (PEEK/FULL
// detents, drag handle, glass material, rounded top corners, fling-dismiss,
// rubber-band over-drag). All of it was theatre: focus mode IS the whole
// surface — nothing meaningful lives behind it, so peek/dismiss-by-drag never
// revealed anything useful, the chrome was visual debt, and we paid for the
// gesture stack with a string of workarounds (custom velocity tracker because
// Vaul's onRelease didn't expose it; `data-vaul-no-drag` + `e.stopPropagation`
// to escape Vaul's unconditional setPointerCapture). The Vaul drawer was also
// the leading suspect for the Android keyboard-collapse persistence bug — its
// `windowDimensions = { innerHeight }` snapshot goes stale under
// `interactive-widget=resizes-content` and locks the rendered box at the
// keyboard-open shrunken size.
//
// So we dropped Vaul AND the visual sheet treatment in the same pass. iOS and
// Android share one full-screen layout (no platform branching). FocusHeader's
// back-chevron and the existing left-edge swipe-back gesture (useEdgeGestures
// → onSwipeRight) are the dismiss paths.
//
// What this component still owns: the keyboard-aware sizing. On iOS the soft
// keyboard does NOT shrink the layout viewport, so a full-height sheet alone
// would leave the composer hidden behind the keyboard; `useKeyboardViewport`
// publishes a px `contentHeight` (= visualViewport.height) + `keyboardInset`
// (= layoutHeight − visualViewport.height − visualViewport.offsetTop, i.e. the
// keyboard overlap WITH the iOS focus-scroll `offsetTop` already folded in) and
// we drive a 0.28s cubic-bezier transition on `height` + `transform` so the
// sheet sits flush above the keyboard.
//
// The lift is a `transform: translateY(-keyboardInset)`, NOT `bottom` — per the
// sourced 2025/26 recipe, iOS 26 regressed `position: fixed` offset properties
// during keyboard interaction, and a GPU-composited transform is the stable
// lever. Geometry is identical to the old `bottom: keyboardInset` (fixed is
// layout-viewport-relative on iOS, so a `bottom-0` box lifted by `keyboardInset`
// lands its bottom edge exactly at the keyboard top and its top at the visual-
// viewport top — offsetTop folded in via the inset), so this is a stability
// change, not a geometry change.
//
// When the keyboard is closed — `contentHeight == null`, the moment the field
// blurs (`useKeyboardViewport` gates on editable focus) — no inline style is set
// and the `h-svh` + `bottom-0` classes govern. `svh` (SMALL viewport) not `dvh`:
// a late/again-null frame with `dvh` (the LARGE, URL-bar-hidden height) could
// still overshoot the visible area and hide the bar; `svh` never does.

import * as React from 'react'

import { cn } from '@/lib/utils'

export interface MobileSheetProps {
  /** Explicit content height in px — driven by `useKeyboardViewport` so the
   *  sheet sits flush above the soft keyboard (= visualViewport.height). When
   *  null/undefined the CSS `h-svh` className governs. */
  contentHeight?: number | null
  /** Pixels the soft keyboard overlaps the bottom of the layout viewport
   *  (offsetTop already folded in). Lifts the `bottom-0` sheet UP by this much
   *  via `transform: translateY(-inset)` so its bottom edge sits at the keyboard
   *  TOP (not behind it). 0 when the keyboard is closed. */
  keyboardInset?: number
  children: React.ReactNode
}

export function MobileSheet({
  contentHeight,
  keyboardInset = 0,
  children,
}: MobileSheetProps) {
  return (
    <div
      data-testid="focus-sheet"
      style={
        contentHeight != null
          ? {
              height: contentHeight,
              // Lift via transform, not `bottom` (iOS 26 fixed-offset regression;
              // see header). `-keyboardInset` folds in visualViewport.offsetTop.
              transform: `translateY(-${keyboardInset}px)`,
              transition:
                'height 0.28s cubic-bezier(0.32, 0.72, 0, 1), transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)',
            }
          : undefined
      }
      className={cn(
        'fixed inset-x-0 bottom-0 z-50 flex h-svh flex-col bg-background',
      )}
    >
      {children}
    </div>
  )
}

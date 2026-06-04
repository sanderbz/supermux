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
// keyboard does NOT shrink the layout viewport, so `h-dvh` alone would leave
// the dock hidden behind the keyboard; `useKeyboardViewport` publishes a px
// `contentHeight` (= visualViewport.height) + `keyboardInset` (= overlap
// pixels) and we drive a 0.28s cubic-bezier CSS transition on `height` +
// `bottom` so the sheet sits flush above the keyboard. When the keyboard is
// closed (and on Android, where the hook is currently disabled by an unrelated
// `innerHeight` inset-math bug in use-keyboard-viewport.ts) `h-dvh` +
// `bottom-0` govern and the CSS layout viewport drives everything.

import * as React from 'react'

import { cn } from '@/lib/utils'

export interface MobileSheetProps {
  /** Explicit content height in px — driven by `useKeyboardViewport` so the
   *  sheet sits flush above the soft keyboard (= visualViewport.height). When
   *  null/undefined the CSS `h-dvh` className governs. */
  contentHeight?: number | null
  /** Pixels the soft keyboard overlaps the bottom of the layout viewport.
   *  Lifts the `bottom-0` sheet UP by this much so its bottom edge sits at
   *  the keyboard TOP (not behind it). 0 when the keyboard is closed. */
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
              bottom: keyboardInset,
              transition:
                'height 0.28s cubic-bezier(0.32, 0.72, 0, 1), bottom 0.28s cubic-bezier(0.32, 0.72, 0, 1)',
            }
          : undefined
      }
      className={cn(
        'fixed inset-x-0 bottom-0 z-50 flex h-dvh flex-col bg-background',
      )}
    >
      {children}
    </div>
  )
}

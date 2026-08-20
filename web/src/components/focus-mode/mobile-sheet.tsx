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
// publishes a px `contentHeight` (= visualViewport.height) + `keyboardOffsetTop`
// (= visualViewport.offsetTop, how far iOS scrolled the visual viewport DOWN to
// keep the focused field above the keyboard) and we drive a 0.28s cubic-bezier
// transition on `height` + `transform` so the sheet sits flush above the
// keyboard.
//
// BOTH keyboard states are now TOP-anchored (`top: 0`), and BOTH position their
// dynamic geometry with a `transform`, NEVER a `bottom`/`top` offset VALUE — per
// the sourced 2025/26 recipe, iOS 26 resolves `position: fixed` offset
// properties unreliably while the keyboard animates. The open state fills the
// visual viewport exactly: `top: 0` (static, never animates) + `height =
// visualViewport.height` + `transform: translateY(offsetTop)` slides the box
// DOWN to the visual-viewport top, so its bottom lands flush at the keyboard top
// (`offsetTop + height == visualViewport bottom`). The earlier `bottom: 0` +
// `translateY(-keyboardInset)` OVER-RESERVED on device — the composer floated a
// ~150px black band above the keyboard — because it leaned on `bottom` resolving
// against a reference iOS shifts mid-keyboard; anchoring by the stable `top: 0`
// removes that dependency entirely (rig-neutral: the emulable path stays flush).
//
// When the keyboard is closed — `contentHeight == null`, the moment the field
// blurs (`useKeyboardViewport` gates on editable focus) — the sheet stays
// top-anchored (`top: 0`, height `100dvh`, no transform).
//
// WHY TOP-ANCHOR THE CLOSED STATE (the "top bar dead / mis-placed when the
// keyboard is closed" regression). The earlier closed state was `bottom: 0` +
// `h-svh` on a `position: fixed` box. On iOS a `position: fixed` element is laid
// out against the LAYOUT viewport (the URL-bar-hidden / large height) and does
// NOT track the VISUAL viewport, while `svh` is the SMALL (URL-bar-shown) height:
// so `bottom-0 + h-svh` pinned the sheet's BOTTOM at the layout-viewport bottom
// (behind the bottom URL bar) and left its TOP — the back button + title — pushed
// DOWN by `layoutHeight − svh`, landing in dead space where a tap on the visible
// top hit nothing. The same mis-placement carried the bottom dock (and its Edit
// pill) off the hit-testable area, so the Edit button "did nothing" too. Residual
// `visualViewport.offsetTop` that iOS leaves after a keyboard dismiss made it
// worse. The keyboard-OPEN path never showed it because it pins the sheet to the
// visual viewport explicitly (`height` + `translateY(-inset)`).
//
// `top: 0` is the fix: on iOS the layout-viewport TOP coincides with the visible
// top (the notch sits ABOVE it, reserved by the header's own `pt-safe`; the URL
// bar sits at the BOTTOM), so a top-anchored sheet puts the header exactly where
// the user sees it and taps land. `height: 100dvh` (a CSS length the browser
// resolves to the CURRENT visible height — never the JS-measured
// `visualViewport.height` that briefly reads screen-minus-home-indicator on a PWA
// cold launch and painted the black bar) fills the visible area top-down, so the
// dock rides just above the URL bar with no bottom gap. No keyboard is up in this
// state, so there is nothing to sit above — only the top bar's placement matters.

import * as React from 'react'

import { cn } from '@/lib/utils'

export interface MobileSheetProps {
  /** Explicit content height in px — driven by `useKeyboardViewport` so the
   *  sheet sits flush above the soft keyboard (= visualViewport.height). When
   *  null/undefined the sheet is top-anchored at `100dvh` (keyboard closed). */
  contentHeight?: number | null
  /** Pixels the soft keyboard overlaps the bottom of the layout viewport
   *  (offsetTop already folded in). Retained for callers that still read it. */
  keyboardInset?: number
  /** `visualViewport.offsetTop` — how far iOS scrolled the visual viewport down
   *  within the layout viewport. The keyboard-OPEN sheet is TOP-anchored
   *  (`top: 0`) and translated DOWN by this, so it fills the visual viewport
   *  exactly with its bottom flush at the keyboard top. 0 when closed. */
  keyboardOffsetTop?: number
  children: React.ReactNode
}

export function MobileSheet({
  contentHeight,
  keyboardInset = 0,
  keyboardOffsetTop = 0,
  children,
}: MobileSheetProps) {
  // `keyboardInset` is no longer used to POSITION the sheet (see the open-state
  // block); kept in the signature so existing callers keep compiling.
  void keyboardInset
  return (
    <div
      data-testid="focus-sheet"
      style={
        contentHeight != null
          ? {
              // KEYBOARD OPEN — fill the visual viewport EXACTLY. Anchor by the
              // TOP, not the bottom: iOS 26 resolves the `bottom`/`top` OFFSET
              // *values* unreliably while the keyboard animates, and the earlier
              // `bottom: 0` + `translateY(-inset)` over-reserved on device (the
              // composer floated a large black band above the keyboard). `top: 0`
              // is STATIC — identical to the working keyboard-CLOSED state, it
              // never animates — and the dynamic positioning rides one
              // GPU-composited transform: translate DOWN by `offsetTop` (how far
              // iOS scrolled the visual viewport) so the sheet's top sits at the
              // visual-viewport top and its bottom lands flush at the keyboard
              // top (`offsetTop + height == visualViewport bottom`). No `bottom`
              // property is touched, so there is nothing for the regression to
              // mis-resolve.
              top: 0,
              bottom: 'auto',
              height: contentHeight,
              transform: `translateY(${keyboardOffsetTop}px)`,
              transition:
                'height 0.28s cubic-bezier(0.32, 0.72, 0, 1), transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)',
            }
          : {
              // KEYBOARD CLOSED — top-anchored fill so the top bar sits at the
              // visible top and stays hit-testable (see header block). `100dvh` is
              // the CSS viewport length, NOT the JS-measured visualViewport.height
              // (PWA-black-bar-safe).
              top: 0,
              bottom: 'auto',
              height: '100dvh',
            }
      }
      className={cn(
        'fixed inset-x-0 z-50 flex flex-col bg-background',
      )}
    >
      {children}
    </div>
  )
}

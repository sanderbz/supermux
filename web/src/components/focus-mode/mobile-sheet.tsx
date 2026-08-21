// MobileSheet — mobile focus-mode layout wrapper.
//
// Used to be a Vaul drag-detent drawer with Apple Maps-style chrome (PEEK/FULL
// detents, drag handle, glass material, rounded top corners, fling-dismiss,
// rubber-band over-drag). All of it was theatre: focus mode IS the whole
// surface — nothing meaningful lives behind it, so peek/dismiss-by-drag never
// revealed anything useful, the chrome was visual debt, and we paid for the
// gesture stack with a string of workarounds. We dropped Vaul AND the visual
// sheet treatment in one pass; iOS and Android share one full-screen layout (no
// platform branching). FocusHeader's back-chevron and the existing left-edge
// swipe-back gesture (useEdgeGestures → onSwipeRight) are the dismiss paths.
//
// KEYBOARD MODEL — NATIVE COLUMN (`interactive-widget=resizes-content`).
// This is now a PLAIN `100dvh` flex column in normal flow — NO `position:
// fixed`, NO `transform`, NO `transition`, NO visualViewport height/offset
// math. `web/index.html` carries `interactive-widget=resizes-content`, so when
// the soft keyboard opens the BROWSER shrinks the layout viewport; `100dvh`
// resolves against the current (post-shrink) viewport, the column reflows, its
// `flex-1 min-h-0` body shrinks, and the composer/dock (the last flex child)
// rides just above the keyboard — one mechanism, owned by the browser, so
// nothing can disagree with it.
//
// This replaces the old visualViewport-driven fixed sheet (height =
// visualViewport.height + translateY(offsetTop)). On a real iOS standalone PWA
// `visualViewport.height` UNDER-reported the above-keyboard space, so the fixed
// sheet came out shorter than the real gap and its composer floated ~75px above
// the keyboard — the reported iOS black band. Removing the JS sheet-sizing path
// removes the band. Removing `transform` also means this root is NEVER a
// containing block for the `fixed` KeyBar/Joystick (guarded by
// shell-containing-block.spec.ts) — strictly safer than the transformed sheet.
//
// `100dvh` (not `100svh`): with `resizes-content` the browser resolves `dvh`
// against the CURRENT viewport, so it fills the visible area whether the URL bar
// is shown or hidden and whether or not the keyboard is up. `svh` (URL-bar-shown
// small height) would leave dead space when the URL bar retracts.

import * as React from 'react'

export interface MobileSheetProps {
  children: React.ReactNode
}

export function MobileSheet({ children }: MobileSheetProps) {
  return (
    <div
      data-testid="focus-sheet"
      className="flex h-[100dvh] flex-col bg-background"
    >
      {children}
    </div>
  )
}

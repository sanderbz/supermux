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
// KEYBOARD MODEL — VISUAL-VIEWPORT PIN, DRIVEN OFF CSS VARS.
// This sheet is `position: fixed` and PINNED to the visual viewport using the
// two custom properties the shell coordinator already publishes to <html>
// (useViewportShellVars → use-keyboard-viewport.ts):
//
//   height:    var(--vvh, 100dvh)
//   transform: translateY(var(--vv-offset-top, 0px))
//
// While an editable field is focused and the soft keyboard overlaps the
// viewport, `useViewportShellVars` sets `--vvh = visualViewport.height` and
// `--vv-offset-top = visualViewport.offsetTop`; otherwise they rest at their
// `:root` fallbacks (`100dvh` / `0px`, globals.css). So:
//
//   · KEYBOARD OPEN  — height resolves to `visualViewport.height` (the ONLY
//     value that follows the keyboard on iOS) and the box is translated DOWN by
//     `visualViewport.offsetTop` (how far iOS scrolled the visual viewport to
//     keep the field above the keyboard). Its TOP lands at the visual-viewport
//     top and its BOTTOM lands exactly at `visualViewport.height` — band 0.
//   · KEYBOARD CLOSED — height is `100dvh`, translateY(0): a plain top-anchored
//     full-height column.
//
// WHY THIS, NOT A BARE `100dvh` COLUMN. iOS Safari/WKWebView do NOT honor
// `interactive-widget=resizes-content`: the soft keyboard OVERLAYS the layout
// viewport and `100dvh` / `clientHeight` stay at their full (812px) value when
// the keyboard opens. A bare `h-[100dvh]` sheet therefore stays ~62px too tall
// on a real iOS standalone PWA — its bottom floats above the real viewport
// bottom and the composer sits over a black band (measured: visualViewport
// .height=498, 100dvh=812, offsetTop=314). Only `visualViewport.height` shrinks
// on keyboard-open, so the sheet has to be sized off it. Anchoring by `top: 0` +
// `translateY(offsetTop)` (never a `bottom`/`top` OFFSET value) avoids the iOS 26
// unreliable-offset-resolution trap while keeping the bottom flush at the
// keyboard top.
//
// The composer/dock stays the LAST flex child (`flex flex-col`), so it rides at
// the sheet's bottom — i.e. flush at the keyboard top — and keeps its own
// `pb-[max(var(--kb-safe-bottom),…)]` home-indicator pad (owned by the composer,
// not this wrapper).
//
// CONTAINING-BLOCK NOTE: the `transform` makes THIS element a containing block
// for its own `fixed` descendants (only the joystick's finger-ring, which is
// used with the keyboard CLOSED → translateY(0) → no offset, so it is
// positionally identical to the viewport). The floating KeyBar and joystick
// overlay live OUTSIDE this sheet (siblings of it / `absolute` within the
// terminal body), so shell-containing-block.spec's fixed-chrome invariant is
// unaffected — the walk it runs starts ABOVE the sheet.

import * as React from 'react'

export interface MobileSheetProps {
  children: React.ReactNode
}

export function MobileSheet({ children }: MobileSheetProps) {
  return (
    <div
      data-testid="focus-sheet"
      className="fixed inset-x-0 top-0 z-50 flex flex-col bg-background"
      style={{
        // Size + pin to the VISUAL viewport off the vars the shell publishes.
        // `--vvh`/`--vv-offset-top` follow the keyboard on iOS (the only values
        // that do); they rest at `100dvh`/`0px` with the keyboard closed.
        //
        // FIX C — defense-in-depth overshoot. While the keyboard drives layout,
        // `--vv-overshoot` is 34px (0px at rest), so the sheet's bottom lands
        // ~34px BELOW the visual-viewport bottom, tucked behind the opaque
        // keyboard. An UNDERSHOOT is the visible black band; an overshoot is
        // invisible — robust against the WebKit stale-vv-frame (#265578) and any
        // `vv.height` under-report. Same top:0 + translateY(offsetTop) anchoring.
        height: 'calc(var(--vvh, 100dvh) + var(--vv-overshoot, 0px))',
        transform: 'translateY(var(--vv-offset-top, 0px))',
      }}
    >
      {children}
    </div>
  )
}

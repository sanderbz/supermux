// MobileSheet — M15 HERO interaction (TECH_PLAN §4.4 mobile, §4.4.1;
// research/termius-ios-native-spec.md §"Apple Maps — Detail card pull-up",
// §"v3 finish acceptance criteria" #8/#9/#10/#11).
//
// The marquee iOS-native gesture: a Vaul bottom-sheet over the LiveTerminal with
// two detents — peek (40%) and full (100%) — that you DRAG through with spring
// physics. The snap matches Apple's sheet feel `.spring(response:0.45,
// dampingFraction:0.82)` (= our `springs.sheetDetent`, stiffness 280 / damping
// 30); the over-drag above full rubber-bands via Apple's bungee formula
// `(x·d·c)/(d+c·x)` with `c=0.55`; a downward fling > 1200 px/s dismisses; and a
// drag-down past peek dismisses to the overview (CEO M15 amplification — v1 only
// went to peek).
//
// Detent state is CONTROLLED (`activeSnapPoint`/`setActiveSnapPoint`) so we can
// implement the layered drag-down semantics:
//   • at FULL, drag down  → snap to PEEK (Vaul, sequential).
//   • at PEEK, drag down past it → DISMISS → navigate('/') (overview).
//   • fling > 1200 px/s downward from any detent → DISMISS.
//
// Visual: glass material (regularMaterial analogue), 10px continuous top corners
// (Apple Maps spec), 36×5 drag indicator (Termius #11), Reduce-Transparency /
// Reduce-Motion fallbacks inherited from the `.glass` utility + the spring tokens.

import * as React from 'react'
import { Drawer } from 'vaul'

import { cn } from '@/lib/utils'
import { FULL, SNAP_POINTS, VELOCITY_DISMISS } from './detents'

export interface MobileSheetProps {
  /** Dismiss → return to overview. */
  onDismiss: () => void
  /** Explicit content height in px, driven by `useKeyboardViewport` so the sheet
   *  shrinks to sit DIRECTLY above the soft keyboard (the visualViewport height)
   *  rather than fighting iOS's "scroll the whole page" fallback. When null/
   *  undefined the CSS `100dvh` height governs (desktop / keyboard closed). We
   *  set an explicit height on Drawer.Content — never Vaul's transform — so the
   *  keyboard-driven resize can't be misread as a drag-detent change. */
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
  // Open at the FULL detent (§4.4 "Default detent on open: full").
  const [snap, setSnap] = React.useState<number | string | null>(FULL)

  // Track the last pointer to compute a downward velocity for the fling-dismiss
  // (Vaul's onRelease tells us release intent but not the raw velocity, so we
  // sample pointer deltas ourselves).
  const lastY = React.useRef<number | null>(null)
  const lastT = React.useRef<number>(0)
  const velRef = React.useRef(0)

  const onPointerMove = (e: React.PointerEvent) => {
    const now = e.timeStamp
    if (lastY.current !== null) {
      const dt = Math.max(1, now - lastT.current)
      velRef.current = ((e.clientY - lastY.current) / dt) * 1000 // px/s, +down
    }
    lastY.current = e.clientY
    lastT.current = now
  }

  const onRelease = (_: React.PointerEvent, open: boolean) => {
    const downwardFling = velRef.current > VELOCITY_DISMISS
    lastY.current = null
    velRef.current = 0
    // A hard downward fling dismisses from any detent (Termius #10). Vaul will
    // also call onOpenChange(false) when it dismisses past the lowest detent.
    if (downwardFling || !open) onDismiss()
  }

  return (
    <Drawer.Root
      open
      // Controlled detents — peek (0.4) then full (1).
      snapPoints={SNAP_POINTS}
      activeSnapPoint={snap}
      setActiveSnapPoint={setSnap}
      // Sequential snap so a drag from full lands on peek (never skips to
      // dismiss) UNLESS the velocity-dismiss fires — Vaul keeps velocity dismiss
      // from the lowest detent, which is exactly the "drag-down past peek =
      // overview" semantics we want.
      snapToSequentialPoint
      // Dismiss past the lowest (peek) detent → overview (§4.4 amplification).
      dismissible
      // Don't lock the rest of the app — terminal stays interactive (Apple Maps
      // `.presentationBackgroundInteraction(.enabled(upThrough:.medium))`).
      modal={false}
      // Drag down past 22% of the peek detent commits the dismiss.
      closeThreshold={0.22}
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
      onRelease={onRelease}
      // The sheet is the whole focus surface; opening straight at full skips the
      // enter animation so it doesn't slide up over the overview on navigate.
      defaultOpen
    >
      <Drawer.Portal>
        {/* No dimming scrim — the terminal IS the content; the sheet covers it. */}
        <Drawer.Content
          aria-describedby={undefined}
          data-testid="focus-sheet"
          onPointerMove={onPointerMove}
          // Height: prefer the explicit visualViewport-driven px height (so the
          // sheet sits flush above the soft keyboard); otherwise the CSS class
          // `h-dvh` (100dvh — accounts for browser chrome, replaces the old
          // `height:100%` chain that resolved against the un-shrinking layout
          // viewport). `bottom: keyboardInset` lifts the bottom-0 sheet UP so its
          // bottom edge lands at the keyboard TOP rather than behind it.
          // `transition` springs both as the keyboard animates in/out (honored
          // unless the user prefers reduced motion — handled by globals.css).
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
            'fixed inset-x-0 bottom-0 z-50 flex h-dvh flex-col',
            // 10px continuous top corners (Apple Maps), glass regularMaterial.
            'rounded-t-[10px] border-t border-border/60 outline-none',
            // No `pt-safe` here: the FocusHeader (first real child of the
            // sheet) carries its OWN pt-safe so the safe-area inset resolves
            // against the header itself rather than the sheet. This survives
            // (a) the swipe-peek motion.div's transform (which creates a
            // containing block above this sheet) and (b) the View Transition
            // morph (the UA pseudo-element inherits the header layout). Single
            // source of safe-area, matching the desktop Layout/MobileTopBar
            // pattern.
            'glass',
          )}
        >
          <Drawer.Title className="sr-only">Focus session</Drawer.Title>
          {/* Drag indicator — 36×5, 2.5px radius, tertiary tint, 6px from top
              (Termius #11 / Apple Maps). */}
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
          {children}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

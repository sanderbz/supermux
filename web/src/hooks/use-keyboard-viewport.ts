// useKeyboardViewport — M-mobile-livetype (TECH_PLAN §4.4 mobile, the
// "page slides weirdly" root-cause fix; mobile-terminal-input.plan.md Step 2).
//
// Observes `window.visualViewport` so the focus layout can lay itself out AROUND
// the soft keyboard instead of letting the browser scroll the whole page up.
//
// The mechanism (per the plan): without `interactive-widget=resizes-content`
// (which iOS Safari/WKWebView only partially honor), the LAYOUT viewport keeps
// its full height when the keyboard opens, so a `fixed bottom-0 h-full` sheet
// stays full-height with its bottom edge BEHIND the keyboard — the browser's
// only recourse is to scroll the page. By driving the focus container's height
// off `visualViewport.height` and pinning the accessory dock up by the keyboard
// inset, the terminal shrinks to sit DIRECTLY above the keyboard and the page
// never slides.
//
// Reads are coalesced into a rAF so a rapid resize+scroll burst (the keyboard
// animation fires many of each) does one layout write per frame. All listeners
// are cleaned up on unmount. No-ops gracefully when `visualViewport` is absent
// (desktop / older engines) — callers fall back to the CSS `100dvh` layout.

import * as React from 'react'

export interface KeyboardViewport {
  /** Current visual-viewport height in px (the area NOT covered by the keyboard
   *  / browser chrome). `null` until measured / when visualViewport is absent —
   *  callers then fall back to a CSS height (100dvh). */
  height: number | null
  /** Pixels the soft keyboard (and any bottom OS chrome) overlaps the layout
   *  viewport: `layoutHeight - visualViewport.height - visualViewport.offsetTop`.
   *  0 when the keyboard is closed. Drive the accessory dock's bottom offset off
   *  this so it rides the keyboard top. */
  keyboardInset: number
  /** True once the inset crosses a small threshold — i.e. the keyboard is open.
   *  Lets callers gate keyboard-only chrome (the accessory key bar). */
  keyboardOpen: boolean
}

// Below this many px of inset we treat the keyboard as closed: iOS reports a
// few px of jitter (URL bar collapse, rubber-band) that must not flip the bar.
const KEYBOARD_OPEN_THRESHOLD = 80

export function useKeyboardViewport(): KeyboardViewport {
  const [vp, setVp] = React.useState<KeyboardViewport>(() => ({
    height: null,
    keyboardInset: 0,
    keyboardOpen: false,
  }))

  React.useEffect(() => {
    const visual =
      typeof window !== 'undefined' ? window.visualViewport : undefined
    // Desktop / no API: leave the initial null-height state so the caller's CSS
    // (100dvh) governs. Nothing to observe.
    if (!visual) return

    let raf = 0
    const measure = () => {
      raf = 0
      const measuredHeight = visual.height
      // The keyboard overlaps the bottom of the LAYOUT viewport. innerHeight is
      // the layout-viewport height (unchanged by the keyboard on iOS); the
      // visual viewport shrinks + may offset. Clamp to ≥0 (over-scroll can make
      // the arithmetic momentarily negative).
      const layoutHeight = window.innerHeight
      const inset = Math.max(0, layoutHeight - measuredHeight - visual.offsetTop)
      const keyboardOpen = inset > KEYBOARD_OPEN_THRESHOLD
      // KEY INVARIANT (PWA-black-bar fix): only publish a concrete `height` when
      // the keyboard is actually OPEN. When the keyboard is closed, `null` lets
      // callers fall back to the CSS `100dvh` layout — which on iOS PWA cold
      // launch already over-paints into the home-indicator region via the
      // `min-height: 100vh` belt-and-suspenders in globals.css. Without this
      // gate, every consumer (MobileSheet, focus route…) would pin `style.height
      // = visualViewport.height` immediately on mount, and on iOS PWA cold
      // launch `visualViewport.height` evaluates to physical-screen-minus-home-
      // indicator → a black bar appears below the app. Once the keyboard
      // actually opens we DO want to drive layout off visualViewport (that's
      // the whole reason the hook exists), so the gate flips off then.
      const publishedHeight = keyboardOpen ? measuredHeight : null
      setVp((prev) => {
        // Skip a state write if nothing meaningfully changed (rAF can still fire
        // on a no-op scroll) — sub-pixel churn shouldn't re-render the tree.
        const heightChanged =
          (prev.height === null) !== (publishedHeight === null) ||
          (publishedHeight !== null &&
            prev.height !== null &&
            Math.abs(prev.height - publishedHeight) >= 1)
        if (
          !heightChanged &&
          Math.abs(prev.keyboardInset - inset) < 1 &&
          prev.keyboardOpen === keyboardOpen
        ) {
          return prev
        }
        return { height: publishedHeight, keyboardInset: inset, keyboardOpen }
      })
    }

    const schedule = () => {
      if (raf) return
      raf = window.requestAnimationFrame(measure)
    }

    // Measure once synchronously so the first paint already accounts for any
    // keyboard that is already up (e.g. fast route change with focus retained).
    measure()
    visual.addEventListener('resize', schedule)
    visual.addEventListener('scroll', schedule)
    return () => {
      if (raf) window.cancelAnimationFrame(raf)
      visual.removeEventListener('resize', schedule)
      visual.removeEventListener('scroll', schedule)
    }
  }, [])

  return vp
}
